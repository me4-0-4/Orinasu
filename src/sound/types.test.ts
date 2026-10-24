import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barsOf,
  beatGrid,
  bpmFromBars,
  bpmFromTaps,
  computePeaks,
  firstSoundSec,
  formatBytes,
  migrateSoundMeta,
  soundMetaOf,
  soundNameFromFile,
} from "./types.ts";

test("波形の山：区間ごとの最大を全体の最大でそろえる", () => {
  const ch = new Float32Array([0, 0.5, -1, 0.25, 0.1, -0.1, 0, 0]);
  assert.deepEqual(computePeaks([ch], 4), [0.5, 1, 0.1, 0]);
  assert.deepEqual(computePeaks([new Float32Array(0)], 3), [0, 0, 0]);
  // 全部無音なら 0
  assert.deepEqual(computePeaks([new Float32Array(10)], 2), [0, 0]);
});

test("波形の山：チャンネルをまたいで大きい方", () => {
  const l = new Float32Array([0.2, 0.2]);
  const r = new Float32Array([-0.4, 0.1]);
  assert.deepEqual(computePeaks([l, r], 2), [1, 0.5]);
});

test("小節数からテンポ", () => {
  // 2秒で1小節（4拍）＝120
  assert.equal(bpmFromBars(2, 0, 1, 4), 120);
  // 頭の0.5秒を除いて 4秒で2小節＝120
  assert.equal(bpmFromBars(4.5, 0.5, 2, 4), 120);
  assert.equal(bpmFromBars(1, 2, 1, 4), null);
});

test("タップからテンポ。2秒以上空いたらやり直す", () => {
  assert.equal(bpmFromTaps([0, 500, 1000, 1500]), 120);
  assert.equal(bpmFromTaps([0]), null);
  assert.equal(bpmFromTaps([0, 500, 5000, 5600]), 100);
});

test("拍の格子：1拍目より前の拍も並べ、小節の頭に印", () => {
  const g = beatGrid({ durationSec: 2.1, bpm: 120, downbeatSec: 0.75, beatsPerBar: 4 });
  assert.deepEqual(
    g.map((b) => [b.sec, b.bar]),
    [
      [0.25, false],
      [0.75, true],
      [1.25, false],
      [1.75, false],
    ],
  );
  assert.deepEqual(beatGrid({ durationSec: 2, bpm: undefined }), []);
});

test("小節数", () => {
  assert.equal(barsOf({ durationSec: 4, bpm: 120, downbeatSec: 0, beatsPerBar: 4 }), 2);
  assert.equal(barsOf({ durationSec: 4 }), null);
});

test("名前・大きさの表示", () => {
  assert.equal(soundNameFromFile("kick 01.wav"), "kick 01");
  assert.equal(soundNameFromFile(".wav"), "無題の音");
  assert.equal(formatBytes(2048), "2KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0MB");
});

test("クラウドのデータを読む：足りない所を補う・壊れていたら null", () => {
  assert.equal(migrateSoundMeta(null), null);
  assert.equal(migrateSoundMeta({ id: "a" }), null);
  const m = migrateSoundMeta({ id: "a", durationSec: 1, peaks: [0.5, "x"] });
  assert.ok(m);
  assert.equal(m.name, "無題の音");
  assert.deepEqual(m.peaks, [0.5]);
  assert.equal(m.bpm, undefined);
});

test("クラウドに送る情報には音の中身を入れない", () => {
  const meta = soundMetaOf({
    id: "a",
    name: "a",
    mime: "audio/wav",
    bytes: 1,
    durationSec: 1,
    channels: 1,
    sampleRate: 44100,
    peaks: [],
    createdAt: 0,
    updatedAt: 0,
    blob: new Blob(["x"]),
  });
  assert.equal("blob" in meta, false);
});

test("最初の音の位置：小さな雑音は無視する", () => {
  const ch = new Float32Array(1000);
  ch[100] = 0.01;
  ch[500] = 0.8;
  assert.equal(firstSoundSec([ch], 1000), 0.5);
  assert.equal(firstSoundSec([new Float32Array(10)], 1000), 0);
});
