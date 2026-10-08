import { test } from "node:test";
import assert from "node:assert/strict";
import { layBed, renderCollage, stepPosition } from "./collage.ts";
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

test("音の長さ：次に打つ所までの一部だけ鳴らして、残りは無音（ブツ切れ）", () => {
  const pcm = ramp(4000);
  const lane = (holdFraction?: number) =>
    renderCollage(
      [{ pcm, slices: [{ start: 0, end: 4000 }], events: [{ step: 0, len: 4, slice: 0, pitch: 0 }], keyShift: 0, gain: 1, holdFraction }],
      opts,
    );
  const full = lane(undefined);
  const half = lane(0.5);
  assert.ok(full.l[300] !== 0); // 伸ばすと4ステップぶん鳴る
  assert.ok(half.l.slice(200).every((x) => x === 0)); // 半分なら2ステップで切れる
  assert.ok(half.l[100] !== 0);
});

const one = (ev: Partial<import("./sequencer.ts").LaneEvent>, pcm = ramp(4000)) =>
  renderCollage([{ pcm, slices: [{ start: 0, end: 4000 }], events: [{ step: 0, len: 4, slice: 0, pitch: 0, ...ev }], keyShift: 0, gain: 1 }], opts);

test("パン：右いっぱいなら左は無音。真ん中は左右同じ", () => {
  const right = one({ pan: 1 });
  assert.ok(right.l.every((x) => x === 0));
  assert.ok(right.r[100] !== 0);
  const center = one({});
  assert.equal(center.l[100], center.r[100]);
});

test("打つ1回ごとの鳴らす割合（gate）は、層の音の長さより優先", () => {
  const pcm = ramp(4000);
  const out = renderCollage(
    [{ pcm, slices: [{ start: 0, end: 4000 }], events: [{ step: 0, len: 4, slice: 0, pitch: 0, gate: 0.25 }], keyShift: 0, gain: 1, holdFraction: 1 }],
    opts,
  );
  assert.ok(out.l.slice(100).every((x) => x === 0));
});

test("エフェクト：逆再生は逆向き、音質下げは値が段々になる、テープストップは読む速さが落ちる", () => {
  const pcm = ramp(4000);
  const rev = one({ fx: { kind: "reverse", a: 0, b: 1 } }, pcm);
  assert.ok(Math.abs(rev.l[100] - pcm.l[399 - 100]) < 1e-6);
  const crush = one({ fx: { kind: "crush", a: 0, b: 1 } }, pcm);
  assert.equal(crush.l[50], crush.l[51]); // 6サンプルごとに止まる
  const tape = one({ fx: { kind: "tapestop", a: 0, b: 1 } }, pcm);
  // 等速なら300番目は pcm[300]。遅くなるので、もっと手前の値（小さい値）
  assert.ok(tape.l[300] < pcm.l[300] * 0.9);
});

test("エフェクト：ローパスは高い音（細かい揺れ）を削る", () => {
  const n = 4000;
  const l = new Float32Array(n).map((_, i) => (i % 2 === 0 ? 0.5 : -0.5)); // いちばん高い音
  const pcm = { l, r: l.slice() };
  const dry = one({}, pcm);
  const lp = one({ fx: { kind: "lowpass", a: 0.9, b: 1 } }, pcm);
  const energy = (x: Float32Array) => x.slice(50, 350).reduce((a, v) => a + v * v, 0);
  assert.ok(energy(lp.l) < energy(dry.l) * 0.2);
});

test("スウィング：16分の裏だけ後ろにずれる（1で16分の1/3）", () => {
  assert.equal(stepPosition(2, 300, 1), 600);
  assert.equal(stepPosition(3, 300, 1), 1000);
  assert.equal(stepPosition(3, 300, 0), 900);
});

test("強さ（vel）で音量が変わり、下地はくり返して最後まで重なる", () => {
  const pcm = { l: new Float32Array(400).fill(0.5), r: new Float32Array(400).fill(0.5) };
  const lane = (vel?: number) => ({ pcm, slices: [{ start: 0, end: 400 }], events: [{ step: 0, len: 1, slice: 0, pitch: 0, vel }], keyShift: 0, gain: 1 });
  const loud = renderCollage([lane()], { totalSteps: 1, stepSamples: 200, sampleRate: 44100 });
  const soft = renderCollage([lane(0.5)], { totalSteps: 1, stepSamples: 200, sampleRate: 44100 });
  assert.ok(Math.abs(soft.l[100] - loud.l[100] / 2) < 1e-6);
  const out = { l: new Float32Array(10), r: new Float32Array(10) };
  layBed(out, { l: Float32Array.from([1, 2, 3]), r: Float32Array.from([1, 2, 3]) }, 0.5);
  assert.deepEqual([...out.l], [0.5, 1, 1.5, 0.5, 1, 1.5, 0.5, 1, 1.5, 0.5]);
});
