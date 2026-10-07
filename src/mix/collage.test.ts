import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCollage } from "./collage.ts";
import type { Pcm } from "./pcm.ts";

const ramp = (n: number): Pcm => {
  const l = new Float32Array(n).map((_, i) => (i + 1) / 10000);
  return { l, r: l.slice() };
};
const opts = { totalSteps: 8, stepSamples: 100, sampleRate: 10000 }; // 1ステップ＝100サンプル、フェード30サンプル

test("断片を、打つ所に置く。長さは次に打つ所まで（断片が短ければ断片の長さまで）", () => {
  const pcm = ramp(2000);
  const out = renderCollage(
    [{ pcm, slices: [{ start: 1000, end: 1500 }], events: [{ step: 2, len: 3, slice: 0, pitch: 0 }], keyShift: 0, gain: 1 }],
    opts,
  );
  assert.equal(out.l.length, 800);
  assert.ok(out.l.slice(0, 200).every((x) => x === 0));
  assert.ok(Math.abs(out.l[200 + 100] - pcm.l[1100]) < 1e-6); // 真ん中はそのまま
  assert.equal(out.l[200], 0); // 頭はフェードイン
  assert.ok(out.l.slice(500).every((x) => x === 0)); // 3ステップで切れる
});

test("音程：12半音上げると、2倍の速さで読む。層ごとの調ずらしも足される", () => {
  const pcm = ramp(4000);
  const lane = (pitch: number, keyShift: number) =>
    renderCollage([{ pcm, slices: [{ start: 0, end: 4000 }], events: [{ step: 0, len: 4, slice: 0, pitch }], keyShift, gain: 1 }], opts);
  assert.ok(Math.abs(lane(12, 0).l[100] - pcm.l[200]) < 1e-6);
  assert.ok(Math.abs(lane(7, 5).l[100] - pcm.l[200]) < 1e-6);
});

test("層は重ねて鳴る", () => {
  const pcm = ramp(1000);
  const ev = { step: 0, len: 2, slice: 0, pitch: 0 };
  const one = renderCollage([{ pcm, slices: [{ start: 0, end: 500 }], events: [ev], keyShift: 0, gain: 1 }], opts);
  const two = renderCollage(
    [
      { pcm, slices: [{ start: 0, end: 500 }], events: [ev], keyShift: 0, gain: 1 },
      { pcm, slices: [{ start: 0, end: 500 }], events: [ev], keyShift: 0, gain: 1 },
    ],
    opts,
  );
  assert.ok(Math.abs(two.l[100] - 2 * one.l[100]) < 1e-6);
});
