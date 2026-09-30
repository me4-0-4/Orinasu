import { test } from "node:test";
import assert from "node:assert/strict";
import { detectKeys, snapToScale, keyName, scalePitchClasses } from "./key.ts";
import { chordName, chordPitchClasses, makeSegments, suggestProgression, chordAt } from "./chords.ts";
import { generateDrumPart } from "./drumPattern.ts";

const n = (pitch: number, start: number, dur = 1) => ({ pitch, startBeats: start, durationBeats: dur });

test("Cメジャーのメロディから C メジャーを推定する", () => {
  const notes = [n(60, 0, 2), n(64, 2), n(67, 3), n(65, 4), n(64, 5), n(62, 6), n(60, 7, 2), n(67, 9)];
  const keys = detectKeys(notes, 3);
  assert.equal(keys.length, 3);
  assert.deepEqual([keys[0].tonic, keys[0].mode], [0, "major"]);
});

test("Aマイナーのメロディから A マイナーを推定する", () => {
  const notes = [n(69, 0, 2), n(72, 2), n(71, 3), n(69, 4), n(68, 5), n(69, 6, 2), n(64, 8, 2), n(65, 10), n(64, 11)];
  const [top] = detectKeys(notes, 1);
  assert.deepEqual([top.tonic, top.mode], [9, "minor"]);
});

test("音が1種類だけなら判定しない", () => {
  assert.deepEqual(detectKeys([n(60, 0), n(72, 1)]), []);
});

test("スケールロック：スケール外の音は近いスケール音に寄る", () => {
  const cMajor = { tonic: 0, mode: "major" as const };
  assert.equal(snapToScale(61, cMajor), 60); // C# → C（同距離なら下）
  assert.equal(snapToScale(64, cMajor), 64); // E はそのまま
  assert.equal(snapToScale(70, cMajor), 69); // A# → A
});

test("調の名前とスケール", () => {
  assert.equal(keyName({ tonic: 10, mode: "major" }), "Bb メジャー");
  assert.equal(keyName({ tonic: 9, mode: "minor" }), "A マイナー");
  assert.deepEqual([...scalePitchClasses({ tonic: 0, mode: "major" })].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
});

test("メロディに合うコードが選ばれる（C-E-G のメロディ → C）", () => {
  const key = { tonic: 0, mode: "major" as const };
  const segments = makeSegments(1, 4, 1);
  const slots = suggestProgression({
    key,
    segments,
    melody: [n(60, 0), n(64, 1), n(67, 2), n(72, 3)],
    totalBeats: 4,
  });
  assert.equal(slots.length, 1);
  assert.equal(chordName(slots[0], key), "C");
  assert.deepEqual(chordPitchClasses(slots[0]), [0, 4, 7]);
});

test("固定したコードは振り直しでも変わらない", () => {
  const key = { tonic: 0, mode: "major" as const };
  const segments = makeSegments(4, 4, 1);
  const first = suggestProgression({ key, segments, melody: [], totalBeats: 16 });
  const locked = first.map((s, i) => (i === 1 ? s : null));
  for (let seed = 1; seed <= 20; seed++) {
    const re = suggestProgression({ key, segments, melody: [], totalBeats: 16, locked, seed });
    assert.equal(re[1].root, first[1].root);
    assert.equal(re[1].quality, first[1].quality);
  }
});

test("振り直しは種によって違う進行になる", () => {
  const key = { tonic: 0, mode: "major" as const };
  const segments = makeSegments(4, 4, 1);
  const seen = new Set<string>();
  for (let seed = 1; seed <= 20; seed++) {
    seen.add(suggestProgression({ key, segments, melody: [], totalBeats: 16, seed }).map((s) => s.root + s.quality).join());
  }
  assert.ok(seen.size > 3);
});

test("chordAt は拍位置から区間を引く", () => {
  const key = { tonic: 0, mode: "major" as const };
  const slots = suggestProgression({ key, segments: makeSegments(2, 4, 1), melody: [], totalBeats: 8 });
  assert.equal(chordAt(slots, 5)?.index, 1);
  assert.equal(chordAt(slots, 8), null);
});

test("ドラム候補：4つ打ちはキックが全拍に入る", () => {
  const notes = generateDrumPart("kick", { genre: "house", lengthBars: 2, beatsPerBar: 4, seed: 1 });
  assert.deepEqual(notes.map((x) => x.startBeats), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("ドラム候補：同じ種なら同じ結果、範囲外の音は出ない", () => {
  const opts = { genre: "pop" as const, lengthBars: 4, beatsPerBar: 4, seed: 42 };
  const a = generateDrumPart("hat", opts);
  const b = generateDrumPart("hat", opts);
  assert.deepEqual(a.map((x) => x.startBeats), b.map((x) => x.startBeats));
  for (const part of ["kick", "snare", "hat", "extra"] as const) {
    for (const note of generateDrumPart(part, opts)) {
      assert.ok(note.startBeats >= 0 && note.startBeats < 16);
    }
  }
});

import { nextRecommendation } from "./recommend.ts";

test("次のおすすめは メロディ→コード→ベース→ドラム の順に進む", () => {
  assert.match(nextRecommendation({ layers: [], hasChords: false }), /メロディ/);
  const melody = { role: "melody" as const, noteCount: 4 };
  assert.match(nextRecommendation({ layers: [melody], hasChords: false }), /コード/);
  assert.match(nextRecommendation({ layers: [melody], hasChords: true }), /ベース/);
  const bass = { role: "bass" as const, noteCount: 2 };
  assert.match(nextRecommendation({ layers: [melody, bass], hasChords: true }), /ドラム/);
  // 音のない層はまだ無いものとして扱う
  assert.match(nextRecommendation({ layers: [{ role: "melody", noteCount: 0 }], hasChords: true }), /メロディ/);
});
