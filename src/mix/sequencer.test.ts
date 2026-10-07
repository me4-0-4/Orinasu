import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { PITCH_LADDER, planOrder, planRhythm, restMask } from "./sequencer.ts";

const STEPS = 64; // 4小節×16分
const shape = (busy: number, breaks = 0, onBeat = 0) => ({ busy, breaks, onBeat });

test("密度を上げるほど、たくさん打つ。同じ種なら同じ", () => {
  const count = (busy: number) => {
    let n = 0;
    for (let seed = 1; seed <= 30; seed++) n += planRhythm(STEPS, 4, shape(busy), createRng(seed)).length;
    return n;
  };
  assert.ok(count(1) > count(0.5) && count(0.5) > count(0));
  assert.deepEqual(planRhythm(STEPS, 4, shape(0.5), createRng(4)), planRhythm(STEPS, 4, shape(0.5), createRng(4)));
});

test("音の長さは、次に打つ所まで。重ならず、曲からはみ出さない", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const hits = planRhythm(STEPS, 4, shape(0.6, 0.4, 0.3), createRng(seed));
    hits.forEach((h, i) => {
      assert.ok(h.len >= 1 && h.step + h.len <= STEPS);
      if (hits[i + 1]) assert.ok(h.step + h.len <= hits[i + 1].step);
    });
  }
});

test("休み：0なら無い。上げると、まとまった休みができ（最大で半分）、そこでは打たない", () => {
  assert.ok(restMask(STEPS, 16, 0, createRng(1)).every((x) => !x));
  for (let seed = 1; seed <= 20; seed++) {
    const mask = restMask(STEPS, 16, 1, createRng(seed));
    assert.equal(mask.filter(Boolean).length, STEPS / 2);
    const hits = planRhythm(STEPS, 4, shape(1, 1), createRng(seed));
    const rest = restMask(STEPS, 16, 1, createRng(seed));
    for (const h of hits) {
      assert.ok(!rest[h.step]);
      for (let s = h.step; s < h.step + h.len; s++) assert.ok(!rest[s], "休みの中まで鳴らさない");
    }
  }
});

test("拍に寄せる：上げるほど、1・2・3・4拍目に打つ割合が増える", () => {
  const ratio = (onBeat: number) => {
    let on = 0;
    let all = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const h of planRhythm(STEPS, 4, shape(0.5, 0, onBeat), createRng(seed))) {
        all++;
        if (h.step % 4 === 0) on++;
      }
    }
    return on / all;
  };
  assert.ok(ratio(1) > ratio(0) + 0.3, `${ratio(1)} vs ${ratio(0)}`);
});

test("順番：断片の番号は範囲内。連打（同じ断片）が起こる。音程の動き0なら高さは変わらない", () => {
  const hits = planRhythm(STEPS, 4, shape(0.8), createRng(2));
  const events = planOrder(hits, 7, 0, createRng(3));
  assert.equal(events.length, hits.length);
  assert.ok(events.every((e) => e.slice >= 0 && e.slice < 7 && e.pitch === 0));
  assert.ok(events.some((e, i) => i > 0 && events[i - 1].slice === e.slice));
});

test("音程の動き：上げると高さが変わる。1回に動くのは、はしごの2段まで（近い高さへつなぐ）", () => {
  const hits = planRhythm(STEPS, 4, shape(1), createRng(5));
  const events = planOrder(hits, 5, 1, createRng(6));
  assert.ok(events.some((e) => e.pitch !== 0));
  for (let i = 1; i < events.length; i++) {
    const a = PITCH_LADDER.indexOf(events[i - 1].pitch);
    const b = PITCH_LADDER.indexOf(events[i].pitch);
    assert.ok(Math.abs(a - b) <= 2);
  }
});

test("音の長さのつまみ：0で15%、1で100%", async () => {
  const { holdFraction } = await import("./sequencer.ts");
  assert.equal(holdFraction(1), 1);
  assert.ok(Math.abs(holdFraction(0) - 0.15) < 1e-9);
  assert.ok(holdFraction(0.6) > holdFraction(0.3));
  // 音楽モードは切りすぎない
  assert.equal(holdFraction(0, "music"), 0.5);
  assert.ok(Math.abs(holdFraction(0.6, "music") - 0.8) < 1e-9);
});

test("連打：同じ断片を続けて打つことが、それなりに多い（4割前後）", () => {
  let same = 0;
  let all = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const events = planOrder(planRhythm(STEPS, 4, shape(0.8), createRng(seed)), 12, 0, createRng(seed + 100));
    for (let i = 1; i < events.length; i++) {
      all++;
      if (events[i].slice === events[i - 1].slice) same++;
    }
  }
  assert.ok(same / all > 0.35 && same / all < 0.6, String(same / all));
});
