import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { createEmptyLayer, createEmptyPhrase, type Phrase, type Note } from "../phrase/types.ts";
import { collectMaterials, remix, remixNew, transposeSemitones, adaptPitch, fit, reorderSlices } from "./remix.ts";
import { duplicateSection } from "./types.ts";

function note(pitch: number, start: number, dur = 0.5): Note {
  return { id: `n${pitch}_${start}`, pitch, velocity: 0.8, startBeats: start, durationBeats: dur };
}

function phraseWith(name: string, bars: 1 | 2 | 4, roles: Record<string, Note[]>): Phrase {
  const p = createEmptyPhrase(bars, 120, 4);
  p.name = name;
  for (const [role, notes] of Object.entries(roles)) {
    const l = createEmptyLayer(role as never);
    l.notes = notes;
    p.layers.push(l);
  }
  return p;
}

// C メジャーのメロディ + ベース、Aマイナー寄りの別フレーズ
const cMel = [note(60, 0), note(64, 1), note(67, 2), note(72, 3)];
const phraseA = phraseWith("A", 1, { melody: cMel, bass: [note(36, 0, 2), note(43, 2, 2)] });
const phraseB = phraseWith("B", 2, {
  melody: [note(69, 0), note(72, 1), note(76, 2), note(69, 4), note(72, 5)],
  drums: [note(36, 0), note(38, 2), note(36, 4), note(38, 6)],
});

test("調の移調：C→Dなら+2、C→Gなら-5", () => {
  assert.equal(transposeSemitones({ tonic: 0, mode: "major" }, { tonic: 2, mode: "major" }), 2);
  assert.equal(transposeSemitones({ tonic: 0, mode: "major" }, { tonic: 7, mode: "major" }), -5);
  assert.equal(adaptPitch(60, { tonic: 0, mode: "major" }, { tonic: 2, mode: "major" }), 62);
  assert.equal(adaptPitch(60, null, { tonic: 2, mode: "major" }), 60);
});

test("fit：短い材料は繰り返され、長い材料は切り出される", () => {
  const tiled = fit([note(60, 0)], 4, 8, 0);
  assert.deepEqual(tiled.map((n) => n.startBeats), [0, 4]);
  const cut = fit([note(60, 0), note(62, 4)], 8, 4, 4);
  assert.deepEqual(cut.map((n) => [n.pitch, n.startBeats]), [[62, 0]]);
});

test("新しい組み合わせ：長さに収まり、材料のある役割が入る", () => {
  const mats = collectMaterials([phraseA, phraseB]);
  const s = remixNew(mats, { lengthBars: 2 }, createRng(1))!;
  assert.ok(s);
  const roles = s.layers.map((l) => l.role).sort();
  assert.deepEqual(roles, ["bass", "drums", "melody"]);
  for (const l of s.layers) for (const n of l.notes) assert.ok(n.startBeats >= 0 && n.startBeats < 8);
});

test("同じ種なら同じ結果、元のフレーズは変わらない", () => {
  const before = JSON.stringify(phraseA);
  const mats = collectMaterials([phraseA, phraseB]);
  const a = remixNew(mats, { lengthBars: 2 }, createRng(7))!;
  const b = remixNew(mats, { lengthBars: 2 }, createRng(7))!;
  const strip = (s: typeof a) => s.layers.map((l) => [l.role, l.notes.map((n) => [n.pitch, n.startBeats])]);
  assert.deepEqual(strip(a), strip(b));
  assert.equal(JSON.stringify(phraseA), before);
});

test("固定した層は振り直しても変わらず、ほかは変わりうる", () => {
  const mats = collectMaterials([phraseA, phraseB]);
  let s = remixNew(mats, { lengthBars: 2 }, createRng(3))!;
  s.layers[0].locked = true;
  const lockedNotes = JSON.stringify(s.layers[0].notes);
  for (const mode of ["new", "recut", "rhythm", "order"] as const) {
    s = remix(s, mode, mats, createRng(10 + mode.length));
    assert.equal(JSON.stringify(s.layers.find((l) => l.locked)!.notes), lockedNotes, mode);
  }
});

test("順番だけ：音の集まりは同じで、位置だけ入れ替わる", () => {
  const notes = [note(60, 0), note(62, 4), note(64, 8), note(65, 12)];
  const out = reorderSlices(notes, 16, 4, createRng(5));
  assert.deepEqual(out.map((n) => n.pitch).sort(), [60, 62, 64, 65]);
  assert.deepEqual(out.map((n) => n.startBeats), [0, 4, 8, 12]);
});

test("リズムだけ：音の高さの並びは残る", () => {
  const mats = collectMaterials([phraseA, phraseB]);
  let s = remixNew(mats, { lengthBars: 1 }, createRng(2))!;
  const mel = s.layers.find((l) => l.role === "melody")!;
  const pitches = new Set(mel.notes.map((n) => n.pitch));
  s = remix(s, "rhythm", mats, createRng(9));
  for (const n of s.layers.find((l) => l.role === "melody")!.notes) assert.ok(pitches.has(n.pitch));
});

test("複製：層と音符のidが新しくなる", () => {
  const mats = collectMaterials([phraseA]);
  const s = remixNew(mats, { lengthBars: 1 }, createRng(4))!;
  const d = duplicateSection(s);
  assert.notEqual(d.id, s.id);
  assert.notEqual(d.layers[0].id, s.layers[0].id);
  assert.equal(d.layers[0].notes.length, s.layers[0].notes.length);
});
