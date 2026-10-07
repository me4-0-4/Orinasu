import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { createEmptyLayer, createEmptyPhrase, type Phrase, type Note } from "../phrase/types.ts";
import { collectMaterials, remix, remixNew, transposeSemitones, adaptPitch } from "./remix.ts";
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
  for (const mode of ["new", "replan", "source"] as const) {
    s = remix(s, mode, mats, createRng(10 + mode.length));
    assert.equal(JSON.stringify(s.layers.find((l) => l.locked)!.notes), lockedNotes, mode);
  }
});

test("固定した層があるあいだ、まるごと振っても刻み方は残る（層同士がずれない）", () => {
  const mats = collectMaterials([phraseA, phraseB]);
  const s0 = remixNew(mats, { lengthBars: 4, chop: { busy: 1, breaks: 0.3, size: 0.5 } }, createRng(21))!;
  s0.layers[0].locked = true;
  const s1 = remix(s0, "new", mats, createRng(22));
  assert.deepEqual(s1.plan, s0.plan);
  const s2 = remix(s1, "replan", mats, createRng(23), { busy: 1, breaks: 0.3, size: 0.5 });
  assert.notDeepEqual(s2.plan, s0.plan);
});

test("刻み直す：同じ素材のまま、刻み方だけ変わる", () => {
  const mats = collectMaterials([phraseA, phraseB]);
  const s0 = remixNew(mats, { lengthBars: 4, chop: { busy: 1, breaks: 0, size: 0.5 } }, createRng(5))!;
  const labels = (s: typeof s0) => s.layers.map((l) => `${l.srcPhraseId}/${l.srcLayerId}`);
  const s1 = remix(s0, "replan", mats, createRng(6), { busy: 1, breaks: 0, size: 0.5 });
  assert.deepEqual(labels(s1), labels(s0));
  assert.notDeepEqual(s1.plan, s0.plan);
});

test("素材だけ替える：刻み方は同じ", () => {
  const phraseC = phraseWith("C", 1, { melody: [note(62, 0), note(65, 1), note(69, 2)] });
  const mats = collectMaterials([phraseA, phraseB, phraseC]);
  const s0 = remixNew(mats, { lengthBars: 2, chop: { busy: 1, breaks: 0, size: 0.5 } }, createRng(8))!;
  const s1 = remix(s0, "source", mats, createRng(9));
  assert.deepEqual(s1.plan, s0.plan);
  const melody = (s: typeof s0) => s.layers.find((l) => l.role === "melody")!.srcPhraseId;
  assert.notEqual(melody(s1), melody(s0)); // メロディの材料が2つあるので、別のほうに替わる
});

test("刻まない設定（刻み0）なら、材料がそのまま通る", () => {
  const mats = collectMaterials([phraseA]);
  const s = remixNew(mats, { lengthBars: 1, chop: { busy: 0, breaks: 0, size: 0.5 } }, createRng(2))!;
  const mel = s.layers.find((l) => l.role === "melody")!;
  assert.deepEqual(mel.notes.map((n) => n.startBeats), [0, 1, 2, 3]);
});

test("複製：層と音符のidが新しくなる", () => {
  const mats = collectMaterials([phraseA]);
  const s = remixNew(mats, { lengthBars: 1 }, createRng(4))!;
  const d = duplicateSection(s);
  assert.notEqual(d.id, s.id);
  assert.notEqual(d.layers[0].id, s.layers[0].id);
  assert.equal(d.layers[0].notes.length, s.layers[0].notes.length);
});

test("曲の長さ：セクションの合計。曲のBPMがあればそれで数える", async () => {
  const { songSeconds, formatDuration, effectiveSections, createSection } = await import("./types.ts");
  const mats = collectMaterials([phraseA]);
  const s1 = remixNew(mats, { lengthBars: 4 }, createRng(1))!; // 4小節・4拍・120BPM = 8秒
  const s2 = createSection("b", { bpm: 60, beatsPerBar: 4 }, 2, s1.layers); // 2小節・60BPM = 8秒
  assert.equal(songSeconds({ sections: [s1, s2] }), 16);
  assert.equal(songSeconds({ sections: [s1, s2], bpm: 120 }), 8 + 4);
  assert.equal(effectiveSections({ sections: [s1], bpm: 90 })[0].bpm, 90);
  assert.equal(s1.bpm, 120); // 元のセクションは書き換えない
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(8), "0:08");
});
