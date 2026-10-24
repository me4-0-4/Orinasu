import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSamplerParams, migrateSamplerParams, pitchName, playRegion, playbackRate } from "./sampler.ts";

test("鍵盤型：元の高さで1倍、1オクターブ上で2倍", () => {
  const p = defaultSamplerParams("s");
  assert.equal(playbackRate(60, p), 1);
  assert.equal(playbackRate(72, p), 2);
  assert.equal(playbackRate(48, p), 0.5);
  assert.ok(Math.abs(playbackRate(60, { rootPitch: 60, tune: 100 }) - Math.pow(2, 1 / 12)) < 1e-12);
});

test("鳴らす範囲：位置を秒にする。短すぎる範囲にはしない", () => {
  assert.deepEqual(playRegion({ start: 0.25, end: 0.75 }, 4), { offset: 1, length: 2 });
  const r = playRegion({ start: 0.5, end: 0.5 }, 2);
  assert.equal(r.offset, 1);
  assert.ok(r.length >= 0.005);
});

test("保存されていた設定の足りない所・おかしな値を直す", () => {
  const p = migrateSamplerParams({ soundId: "s", start: 0.6, end: 0.2, attack: -1, hold: "x" as never });
  assert.equal(p.start, 0.6);
  assert.equal(p.end, 0.6);
  assert.equal(p.attack, 0);
  assert.equal(p.hold, "gate");
  assert.equal(p.mode, "keys");
  assert.equal(p.rootPitch, 60);
});

test("音の名前", () => {
  assert.equal(pitchName(60), "C4");
  assert.equal(pitchName(61), "C#4");
  assert.equal(pitchName(36), "C2");
});

import { beatSlices, divideSlices, noteRegion, normalizeSlices, onsetSlices, reversedRange, sliceIndexFor, sliceRange } from "./sampler.ts";

test("切れ目を整える：頭に0、並べ替え、近すぎる所はまとめる", () => {
  assert.deepEqual(normalizeSlices([0.5, 0.25, 0.25, 2, -1]), [0, 0.25, 0.5, 0.999]);
  assert.deepEqual(normalizeSlices([]), [0]);
});

test("等分・拍・音の頭で切る", () => {
  assert.deepEqual(divideSlices(4), [0, 0.25, 0.5, 0.75]);
  // 4秒、120BPM、1拍目 0.25秒、1拍ごと → 0.25, 0.75, ... 0.25秒より前の 0 も入る
  assert.deepEqual(beatSlices({ durationSec: 2, bpm: 120, downbeatSec: 0.25 }, 1), [0, 0.125, 0.375, 0.625, 0.875]);
  assert.equal(beatSlices({ durationSec: 2 }, 1), null);
  assert.deepEqual(onsetSlices([0, 500, 750], 1000), [0, 0.5, 0.75]);
});

test("パッド型：C4から断片を並べ、足りなければくり返す", () => {
  assert.equal(sliceIndexFor(60, 4), 0);
  assert.equal(sliceIndexFor(63, 4), 3);
  assert.equal(sliceIndexFor(64, 4), 0);
  assert.equal(sliceIndexFor(59, 4), 3);
  assert.deepEqual(sliceRange([0, 0.5], 1), { start: 0.5, end: 1 });
});

test("押した鍵盤で鳴らす範囲と速さ", () => {
  const keys = { ...defaultSamplerParams("s"), start: 0.1, end: 0.9 };
  assert.deepEqual(noteRegion(keys, 72), { start: 0.1, end: 0.9, rate: 2 });
  const pads = { ...keys, mode: "pads" as const, slices: [0, 0.5] };
  assert.deepEqual(noteRegion(pads, 61), { start: 0.5, end: 1, rate: 1 });
  assert.deepEqual(reversedRange({ start: 0.1, end: 0.3 }), { start: 0.7, end: 0.9 });
});
