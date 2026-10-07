import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmptySong, formatDuration, migrateSong, songSeconds } from "./types.ts";

test("曲の長さ：小節数・拍子・曲のBPMから決まる（フレーズのBPMは関係ない）", () => {
  const s = createEmptySong(); // 8小節・4拍・120BPM
  assert.equal(songSeconds(s), 16);
  assert.equal(songSeconds({ ...s, bpm: 60 }), 32);
  assert.equal(songSeconds({ ...s, lengthBars: 4, bpm: 90 }), 10.666666666666666);
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(8), "0:08");
});

test("古い形（セクションを並べた曲）からは、名前・選んだ曲・BPMだけ引き継ぐ", () => {
  const old = {
    id: "song",
    name: "むかしの曲",
    materialIds: ["a", "b"],
    sections: [{ id: "s1", layers: [] }],
    bpm: 100,
    energy: [{ t: 0, v: 0.2 }],
    macros: [],
    updatedAt: 5,
  };
  const s = migrateSong(old);
  assert.equal(s.name, "むかしの曲");
  assert.deepEqual(s.materialIds, ["a", "b"]);
  assert.equal(s.bpm, 100);
  assert.equal(s.lengthBars, 8);
  assert.equal(s.plan, undefined);
  assert.equal("sections" in s, false);
});

test("壊れたデータや範囲外の値は、初期値に戻す。新しい形はそのまま読める", () => {
  assert.equal(migrateSong(null).bpm, 120);
  assert.equal(migrateSong({ bpm: 9999, lengthBars: 7 }).bpm, 120);
  assert.equal(migrateSong({ bpm: 9999, lengthBars: 7 }).lengthBars, 8);
  const plan = [{ kind: "play", from: "a", dst: 0, len: 4, src: 0 }];
  const s = migrateSong({ ...createEmptySong(), plan, baseId: "a", lengthBars: 16, bpm: 140 });
  assert.equal(s.lengthBars, 16);
  assert.equal(s.bpm, 140);
  assert.deepEqual(s.plan, plan);
  assert.equal(s.baseId, "a");
});
