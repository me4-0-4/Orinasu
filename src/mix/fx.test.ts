import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyChain,
  applyDrive,
  chainIsOff,
  delaySeconds,
  delayWet,
  fillBars,
  highCutHz,
  lowCutHz,
  newSlot,
  reverbSeconds,
  sanitizeChain,
  whenMask,
  type ChainEnv,
} from "./fx.ts";
import type { Pcm } from "./pcm.ts";

const SR = 1000;
const env = (over: Partial<ChainEnv> = {}): ChainEnv => ({
  totalSteps: 8 * 16,
  stepsPerBar: 16,
  stepSamples: 10, // 1小節＝160サンプル
  sampleRate: SR,
  bpm: 120,
  reverb: async (pcm) => pcm, // 響き＝そのまま（試験用）
  ...over,
});
const flat = (n: number, v = 0.5): Pcm => ({ l: new Float32Array(n).fill(v), r: new Float32Array(n).fill(v) });

test("エフェクトの数字：長さ・間隔・削る周波数", () => {
  assert.ok(Math.abs(reverbSeconds(0) - 0.3) < 1e-9);
  assert.ok(Math.abs(reverbSeconds(1) - 6) < 1e-9);
  assert.equal(delaySeconds("1/8d", 120), 0.375);
  assert.equal(lowCutHz(0), 20);
  assert.ok(Math.abs(highCutHz(1) - 300) < 1e-6);
  assert.deepEqual(fillBars(8), [3, 7]);
  assert.deepEqual(fillBars(6), [3, 5]);
});

test("いつ掛けるか：小節・フィル・選んだ断片の所だけ1になる（端はなめらか）", () => {
  const n = 8 * 160;
  const bars = whenMask(newSlot("drive", { when: "bars", from: 2, to: 3 }), n, env())!;
  assert.equal(bars[100], 0);
  assert.equal(bars[200], 1);
  assert.equal(bars[470], 1);
  assert.equal(bars[600], 0);
  const fills = whenMask(newSlot("drive", { when: "fills" }), n, env())!;
  assert.equal(fills[3 * 160 + 50], 1);
  assert.equal(fills[2 * 160 + 50], 0);
  const events = [
    { step: 4, len: 2, slice: 0, pitch: 0 },
    { step: 8, len: 4, slice: 1, pitch: 0 },
  ];
  const hits = whenMask(newSlot("drive", { when: "hits", steps: [8] }), n, env({ events }))!;
  assert.equal(hits[50], 0);
  assert.equal(hits[100], 1);
  assert.equal(hits[130], 0);
  assert.equal(whenMask(newSlot("drive"), n, env()), null);
});

test("並べた順に掛かる。差し込み（歪みなど）は、いつ掛けるか の所だけ入れ替わる", async () => {
  const n = 8 * 160;
  const crushed = await applyChain(flat(n, 0.3), [newSlot("crush", { amount: 1, when: "bars", from: 1, to: 1 })], env());
  assert.notEqual(crushed.l[50], 0.3); // 1小節目は音質が下がる
  assert.ok(Math.abs(crushed.l[500] - 0.3) < 1e-6); // ほかはそのまま
  // 順番が違えば結果も違う（歪み→低音を削る と 低音を削る→歪み）
  const sine = (): Pcm => {
    const l = Float32Array.from({ length: n }, (_, i) => 0.6 * Math.sin((2 * Math.PI * 30 * i) / SR));
    return { l, r: l.slice() };
  };
  const a = await applyChain(sine(), [newSlot("drive", { amount: 1 }), newSlot("lowCut", { amount: 0.6 })], env());
  const b = await applyChain(sine(), [newSlot("lowCut", { amount: 0.6 }), newSlot("drive", { amount: 1 })], env());
  assert.ok(Math.abs(a.l[400] - b.l[400]) > 1e-3);
});

test("送り（リバーブ・ディレイ）は、いつ掛けるか の所の音だけを響かせる", async () => {
  const n = 8 * 160;
  const seen: number[] = [];
  const out = await applyChain(flat(n, 0.5), [newSlot("reverb", { amount: 1, when: "bars", from: 2, to: 2 })], env({
    reverb: async (pcm) => {
      seen.push(pcm.l[50], pcm.l[250]);
      return pcm;
    },
  }));
  assert.deepEqual(seen, [0, 0.5]);
  assert.ok(out.l[250] > out.l[50]);
});

test("ディレイ：間隔ごとに、だんだん小さくくり返す。曲の終わりを越えたら頭に回す", () => {
  const n = 100;
  const pcm: Pcm = { l: new Float32Array(n), r: new Float32Array(n) };
  pcm.l[90] = 1;
  const wet = delayWet(pcm, 20, 0.5);
  assert.ok(wet.l[10] > 0.2); // 90+20 → 頭の10
  assert.ok(wet.l[30] > 0.05 && wet.l[30] < wet.l[10]);
});

test("何も掛けない並びは、何もしない。前の1組の形からも読める", () => {
  assert.ok(chainIsOff([]));
  assert.ok(chainIsOff([newSlot("delay", { amount: 0 })]));
  assert.ok(chainIsOff([newSlot("delay", { when: "hits", steps: [] })]));
  assert.ok(!chainIsOff([newSlot("delay")]));
  const pcm = { l: Float32Array.from([0.1]), r: Float32Array.from([0.1]) };
  assert.equal(applyDrive(pcm, 0, 0), pcm);
  const old = sanitizeChain({ reverb: 0.2, delay: 0.5, delayTime: "1/4", drive: 0.3 });
  assert.deepEqual(old.map((s) => s.kind), ["drive", "delay", "reverb"]);
  assert.equal(old[1].time, "1/4");
  assert.deepEqual(sanitizeChain([{ kind: "???" }, { kind: "crush", amount: 2, when: "hits", steps: [3, 3, 1] }]).map((s) => [s.kind, s.amount, s.steps]), [["crush", 1, [1, 3]]]);
});
