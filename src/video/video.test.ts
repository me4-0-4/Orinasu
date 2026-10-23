import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, drumKind, type TimelineInput } from "./timeline.ts";
import { analyze, bandEdges, BANDS, fft, FRAMES_PER_STEP, specAt } from "./analysis.ts";
import { featAt } from "./features.ts";

const base = (over: Partial<TimelineInput> = {}): TimelineInput => ({
  totalSteps: 32,
  stepsPerBar: 16,
  bpm: 120,
  stepSamples: 100,
  lanes: [
    {
      name: "A",
      // 断片0＝元の0〜4ステップ、断片1＝元の8〜12ステップ
      slices: [{ start: 0, end: 400 }, { start: 800, end: 1200 }],
      events: [{ step: 2, len: 4, slice: 1, pitch: 0 }, { step: 10, len: 2, slice: 0, pitch: 12, vel: 0.5 }],
      keyShift: 0,
      loopSteps: 16,
      notes: [{ pitch: 60, start: 0, len: 2, vel: 1 }, { pitch: 67, start: 9, len: 4, vel: 0.8 }],
    },
  ],
  bed: null,
  pad: false,
  ...over,
});

test("断片の範囲と重なる元の音符が、打った位置に出てくる（移調・音程の動きも足す）", () => {
  const tl = buildTimeline(base());
  // 2ステップ目：元の8〜12 → 67（9から）。打った位置からの差 1
  const first = tl.tonal.find((e) => e.s >= 2 && e.s < 6)!;
  assert.equal(first.p, 67);
  assert.equal(first.s, 3);
  assert.equal(first.len, 3);
  // 10ステップ目：元の0〜2 → 60＋12（長さは打つ長さ2まで）
  const second = tl.tonal.find((e) => e.s >= 10)!;
  assert.equal(second.p, 72);
  assert.equal(second.len, 2);
  assert.equal(second.vel, 0.5);
  assert.deepEqual(tl.chops.map((c) => c.p), [67, 72]);
});

test("ドラムループは曲の長さぶんくり返し、種類に分ける。無ければ拍の頭を弱いキックにする", () => {
  const withBed = buildTimeline(base({ bed: { loopSteps: 16, notes: [{ pitch: 36, start: 0, len: 1, vel: 1 }, { pitch: 42, start: 2, len: 1, vel: 0.6 }] } }));
  assert.deepEqual(withBed.kicks.map((k) => k.s), [0, 16]);
  assert.deepEqual(withBed.hats.map((k) => k.s), [2, 18]);
  const none = buildTimeline(base());
  assert.equal(none.kicks.length, 8);
  assert.equal(drumKind(38), "snare");
});

test("4小節目の後ろ半分の断片はフィル", () => {
  const tl = buildTimeline(base({ totalSteps: 64, lanes: [{ ...base().lanes[0], events: [{ step: 56, len: 1, slice: 0, pitch: 0 }, { step: 40, len: 1, slice: 0, pitch: 0 }] }] }));
  assert.deepEqual(tl.chops.map((c) => [c.s, !!c.fill]), [[40, false], [56, true]]);
});

test("FFT：1kHz のサイン波は、1kHz を含む帯域がいちばん強い", () => {
  const sr = 48000, n = sr;
  const l = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr));
  const an = analyze({ l, r: l.slice() }, sr, 1200, 40);
  assert.equal(an.frames, 40 * FRAMES_PER_STEP);
  const spec = specAt(an, 10);
  const top = spec.indexOf(Math.max(...spec));
  const edges = bandEdges();
  assert.ok(edges[top] <= 1000 && 1000 < edges[top + 1], `帯域 ${top}`);
  assert.ok(an.loud[0] > 0.5);
  assert.ok(an.width[0] < 0.01); // 左右が同じなら広がりは0
});

test("無音は音量も帯域も0。FFT は定数を 0Hz に集める", () => {
  const z = new Float32Array(4800);
  const an = analyze({ l: z, r: z }, 48000, 120, 8);
  assert.ok(an.loud.every((v) => v === 0));
  assert.ok(an.spec.every((v) => v === 0));
  const re = new Float64Array(8).fill(1), im = new Float64Array(8);
  fft(re, im);
  assert.equal(re[0], 8);
  assert.ok(Math.abs(re[3]) < 1e-9);
  assert.equal(BANDS, 40);
});

test("featAt：位置、最後に鳴った断片、フィルの進み具合", () => {
  const tl = buildTimeline(base({ totalSteps: 64 }));
  const z = new Float32Array(64 * 100);
  const an = analyze({ l: z, r: z }, 48000, 100, 64);
  const f = featAt(tl, an, 11.5);
  assert.equal(f.bar, 0);
  assert.equal(f.step, 11);
  assert.equal(f.lastChop.s, 10);
  assert.equal(f.active.length, 1);
  const fill = featAt(tl, an, 60);
  assert.ok(fill.isFill);
  assert.equal(fill.fillAmt, 0.5);
  assert.equal(featAt(tl, an, 64 + 11.5).step, 11); // 曲の長さでくり返す
});
