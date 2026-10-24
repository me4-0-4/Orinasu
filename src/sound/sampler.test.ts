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
