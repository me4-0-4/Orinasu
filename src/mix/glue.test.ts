import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { createEmptyLayer, createEmptyPhrase } from "../phrase/types.ts";
import { addSfx, fourOnFloor, kickSteps, pump, renderPad, type Grid } from "./glue.ts";
import type { Pcm } from "./pcm.ts";

const SR = 8000;
const grid: Grid = { totalSteps: 16 * 16, stepsPerBar: 16, stepSamples: 250, sampleRate: SR }; // 1小節＝0.5秒
const silent = (): Pcm => {
  const n = grid.totalSteps * grid.stepSamples;
  return { l: new Float32Array(n), r: new Float32Array(n) };
};
const rms = (x: Float32Array, from: number, to: number): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const bar = 16 * 250;

test("SFX：8小節の頭（インパクト）とその前（ライザー）、4小節の頭の前（リバースシンバル）に鳴る。0なら鳴らない", () => {
  const out = silent();
  addSfx(out, grid, 1, createRng(1));
  assert.ok(rms(out.l, 8 * bar, 8 * bar + 2000) > 0.05, "インパクト");
  assert.ok(rms(out.l, 7 * bar + bar / 2, 8 * bar) > rms(out.l, 7 * bar, 7 * bar + bar / 4), "ライザーは上がっていく");
  assert.ok(rms(out.l, 4 * bar - 800, 4 * bar) > 10 * rms(out.l, 2 * bar + 1000, 3 * bar) + 1e-4, "リバースシンバル");
  assert.ok(rms(out.l, 2 * bar + 1000, 3 * bar) < 0.01, "区切りでない所は静か");
  const none = silent();
  addSfx(none, grid, 0, createRng(1));
  assert.ok(none.l.every((x) => x === 0));
});

test("伸ばし：元の曲の音を、切れ目なく鳴らし続ける（無音の所がない）", () => {
  const n = 4 * bar;
  const tone = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5);
  const pad = renderPad([{ pcm: { l: tone, r: tone.slice() }, srcBars: 4, keyShift: 0 }], grid, 1, createRng(3));
  for (let b = 0; b < 16; b++) assert.ok(rms(pad.l, b * bar + 200, (b + 1) * bar - 200) > 0.02, `${b + 1}小節目が鳴っていない`);
  assert.ok(Math.max(...pad.l.map(Math.abs)) < 0.6);
  assert.ok(renderPad([], grid, 1, createRng(3)).l.every((x) => x === 0));
});

test("ポンピング：キックの直後は沈み、次のキックの前には戻る", () => {
  const out = silent();
  out.l.fill(1);
  out.r.fill(1);
  pump(out, fourOnFloor(grid.totalSteps), grid, 1);
  assert.ok(out.l[4 * 250 + 10] < 0.5);
  assert.ok(out.l[4 * 250 + 900] > 0.9);
});

test("キックの所：下地の曲のキック（36番）だけ、曲の長さぶんくり返す", () => {
  const p = createEmptyPhrase(1, 120, 4);
  const d = createEmptyLayer("drums");
  d.notes = [
    { id: "k1", pitch: 36, velocity: 1, startBeats: 0, durationBeats: 0.25 },
    { id: "s1", pitch: 38, velocity: 1, startBeats: 1, durationBeats: 0.25 },
    { id: "k2", pitch: 36, velocity: 1, startBeats: 2.5, durationBeats: 0.25 },
  ];
  p.layers.push(d);
  assert.deepEqual(kickSteps(p, 32), [0, 10, 16, 26]);
});
