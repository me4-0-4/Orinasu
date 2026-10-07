import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmptySong, formatDuration, migrateSong, songSeconds } from "./types.ts";

test("曲の長さ：小節数・拍子・曲のBPMから決まる（フレーズのBPMは関係ない）", () => {
  const s = createEmptySong(); // 4小節・4拍・120BPM
  assert.equal(songSeconds(s), 8);
  assert.equal(songSeconds({ ...s, bpm: 60 }), 16);
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(8), "0:08");
});

test("古い形の曲からは、名前・選んだ曲・BPM・長さだけ引き継ぐ", () => {
  const old = {
    name: "むかしの曲",
    materialIds: ["a", "b"],
    sections: [{ id: "s1", layers: [] }],
    plan: [{ kind: "play", from: "a", dst: 0, len: 4, src: 0 }],
    baseId: "a",
    bpm: 100,
    lengthBars: 16,
    energy: [{ t: 0, v: 0.2 }],
    updatedAt: 5,
  };
  const s = migrateSong(old);
  assert.equal(s.name, "むかしの曲");
  assert.deepEqual(s.materialIds, ["a", "b"]);
  assert.equal(s.bpm, 100);
  assert.equal(s.lengthBars, 16);
  assert.equal(s.lanes, undefined);
  assert.equal("sections" in s || "plan" in s, false);
  assert.equal(s.params.busy, 0.5);
});

test("いまの形はそのまま読める。壊れた値は初期値に戻す", () => {
  const lanes = [{ phraseId: "a", cutSeed: 1, rhythmSeed: 2, orderSeed: 3, locked: true }, { phraseId: 5 }];
  const s = migrateSong({ ...createEmptySong(), lanes, params: { busy: 2, breaks: 0.3, mode: "divide", size: "x" } });
  assert.deepEqual(s.lanes, [lanes[0]]);
  assert.equal(s.params.busy, 1);
  assert.equal(s.params.breaks, 0.3);
  assert.equal(s.params.mode, "divide");
  assert.equal(s.params.size, 0.5);
  assert.equal(migrateSong(null).bpm, 120);
  assert.equal(migrateSong({ bpm: 9999, lengthBars: 7 }).lengthBars, 4);
});
