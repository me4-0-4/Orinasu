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

test("調の移調：C→Dなら+2、C→Gなら-5", () => {
  assert.equal(transposeSemitones({ tonic: 0, mode: "major" }, { tonic: 2, mode: "major" }), 2);
  assert.equal(transposeSemitones({ tonic: 0, mode: "major" }, { tonic: 7, mode: "major" }), -5);
  assert.equal(adaptPitch(60, { tonic: 0, mode: "major" }, { tonic: 2, mode: "major" }), 62);
  assert.equal(adaptPitch(60, null, { tonic: 2, mode: "major" }), 60);
});

// 1曲＝ドラム・ベース・コード・メロディ入りのフレーズ
const song = (name: string, tonic = 60): Phrase =>
  phraseWith(name, 4, {
    melody: [note(tonic, 0), note(tonic + 4, 4), note(tonic + 7, 8), note(tonic + 12, 12)],
    bass: [note(tonic - 24, 0, 2), note(tonic - 17, 8, 2)],
    drums: [note(36, 0), note(38, 4), note(36, 8), note(38, 12)],
  });
const songX = song("X");
const songY = song("Y", 62);
songX.id = "X";
songY.id = "Y";

const off = { busy: 0, breaks: 0, size: 0.5 };
const wild = { busy: 1, breaks: 0.3, size: 0.5 };
const strip = (s: { layers: { srcPhraseId?: string; role: string; notes: Note[] }[] }) =>
  s.layers.map((l) => [l.srcPhraseId, l.role, l.notes.map((n) => [n.pitch, n.startBeats])]);

test("刻まなければ、曲がそのまま通る。曲の層が全部そろう", () => {
  const s = remixNew(collectMaterials([songX]), { lengthBars: 4, chop: off }, createRng(1))!;
  assert.deepEqual(s.layers.map((l) => l.role).sort(), ["bass", "drums", "melody"]);
  const mel = s.layers.find((l) => l.role === "melody")!;
  assert.deepEqual(mel.notes.map((n) => [n.pitch, n.startBeats]), [[60, 0], [64, 4], [67, 8], [72, 12]]);
  assert.equal(s.baseId, "X");
});

test("曲を丸ごと刻む：どの区間でも、鳴るのは1つの曲の層だけ（役割ごとにバラバラに拾わない）", () => {
  const sources = collectMaterials([songX, songY]);
  for (let seed = 1; seed <= 30; seed++) {
    const s = remixNew(sources, { lengthBars: 4, chop: wild }, createRng(seed))!;
    for (const layer of s.layers) {
      for (const n of layer.notes) {
        const seg = s.plan!.find((x) => n.startBeats >= x.dst - 1e-6 && n.startBeats < x.dst + x.len - 1e-6)!;
        assert.equal(seg.from, layer.srcPhraseId, `seed ${seed}`);
      }
    }
    for (const l of s.layers) assert.ok(l.srcPhraseId === "X" || l.srcPhraseId === "Y");
  }
});

test("曲が複数あれば、曲をまたいで刻む", () => {
  const sources = collectMaterials([songX, songY]);
  let mixed = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = remixNew(sources, { lengthBars: 4, chop: wild }, createRng(seed))!;
    if (new Set(s.layers.map((l) => l.srcPhraseId)).size > 1) mixed++;
  }
  assert.ok(mixed > 5, String(mixed));
});

test("同じ種なら同じ結果、元のフレーズは変わらない", () => {
  const before = JSON.stringify(songX);
  const sources = collectMaterials([songX, songY]);
  const a = remixNew(sources, { lengthBars: 4, chop: wild }, createRng(7))!;
  const b = remixNew(sources, { lengthBars: 4, chop: wild }, createRng(7))!;
  assert.deepEqual(strip(a), strip(b));
  assert.equal(JSON.stringify(songX), before);
});

test("固定した小節は、振り直しても同じ。ほかの小節は変わる", () => {
  const sources = collectMaterials([songX, songY]);
  const s0 = remixNew(sources, { lengthBars: 4, chop: wild }, createRng(3))!;
  const inBar = (plan: NonNullable<typeof s0.plan>, b: number) => plan.filter((x) => x.dst >= b * 4 && x.dst < (b + 1) * 4);
  const s1 = remix(s0, "new", sources, createRng(11), wild, [1, 2]);
  assert.deepEqual(inBar(s1.plan!, 1), inBar(s0.plan!, 1));
  assert.deepEqual(inBar(s1.plan!, 2), inBar(s0.plan!, 2));
  assert.equal(s1.id, s0.id);
});

test("刻み直す：同じメインの曲のまま、刻み方だけ変わる", () => {
  const sources = collectMaterials([songX, songY]);
  const s0 = remixNew(sources, { lengthBars: 4, chop: wild }, createRng(5))!;
  const s1 = remix(s0, "replan", sources, createRng(6), wild);
  assert.equal(s1.baseId, s0.baseId);
  assert.equal(s1.key?.tonic, s0.key?.tonic);
  assert.notDeepEqual(s1.plan, s0.plan);
});

test("材料から消えた曲の層は出ない。材料が空なら作らない", () => {
  const s0 = remixNew(collectMaterials([songX, songY]), { lengthBars: 4, chop: wild }, createRng(5))!;
  const s1 = remix(s0, "new", collectMaterials([songX]), createRng(8), wild);
  assert.ok(s1.layers.every((l) => l.srcPhraseId === "X"));
  assert.equal(remixNew([], { lengthBars: 4 }, createRng(1)), null);
});

test("曲ごとの音色・音量が、層にそのまま残る", () => {
  const withVol = song("V");
  withVol.layers[0].volume = 0.4;
  const s = remixNew(collectMaterials([withVol]), { lengthBars: 4, chop: off }, createRng(1))!;
  assert.ok(s.layers.some((l) => l.volume === 0.4));
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
