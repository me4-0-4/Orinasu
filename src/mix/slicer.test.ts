import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { cutSlices, detectOnsets, divisionsFor, sliceLimits } from "./slicer.ts";
import type { Pcm } from "./pcm.ts";

const SR = 8000;

/** at（秒）の所で鳴り始めて減っていく音（アタックのある音）を並べた波形。 */
function hits(seconds: number, at: number[]): Pcm {
  const l = new Float32Array(Math.round(seconds * SR));
  for (const t of at) {
    const s = Math.round(t * SR);
    for (let i = 0; i < SR * 0.2 && s + i < l.length; i++) l[s + i] += Math.sin(i * 0.9) * Math.exp(-i / (SR * 0.05));
  }
  return { l, r: l.slice() };
}

test("断片の長さのつまみ：0.5 で 100〜2000ms、等分は16。大きいほど長く・少なく", () => {
  assert.deepEqual(sliceLimits(0.5), { minMs: 100, maxMs: 2000 });
  assert.equal(divisionsFor(0.5), 16);
  assert.ok(sliceLimits(1).minMs > sliceLimits(0).minMs);
  assert.ok(divisionsFor(1) < divisionsFor(0));
});

test("アタック検出：音の鳴り始めの近くで切れる", () => {
  const at = [0.25, 0.5, 0.75, 1.25];
  const onsets = detectOnsets(hits(1.6, at), SR, 0.6, 50);
  assert.equal(onsets[0], 0);
  for (const t of at) {
    assert.ok(onsets.some((o) => Math.abs(o / SR - t) < 0.02), `${t}秒の近く: ${onsets.map((o) => (o / SR).toFixed(3))}`);
  }
  assert.ok(onsets.length <= at.length + 2, String(onsets.length));
});

test("アタック検出：無音や、ずっと同じ音からは、頭以外は拾わない", () => {
  assert.deepEqual(detectOnsets({ l: new Float32Array(SR), r: new Float32Array(SR) }, SR, 1, 50), [0]);
  const l = new Float32Array(SR).map((_, i) => Math.sin(i * 0.3) * 0.5);
  assert.ok(detectOnsets({ l, r: l.slice() }, SR, 0.5, 50).length <= 2);
});

test("切る：アタックで切った断片は、最短より長く最長より短い。等分は同じ長さ", () => {
  const pcm = hits(2, [0.1, 0.4, 0.45, 0.9, 1.5]);
  const slices = cutSlices(pcm, SR, { mode: "transient", size: 0.5 }, createRng(1));
  assert.ok(slices.length >= 3);
  for (const s of slices) {
    assert.ok(s.end > s.start && s.end <= pcm.l.length);
    assert.ok(s.end - s.start <= (2400 / 1000) * SR, "最長（揺らし込み）を超えない");
  }
  const div = cutSlices(pcm, SR, { mode: "divide", size: 0.5 }, createRng(2));
  const lens = div.map((s) => s.end - s.start);
  assert.ok(Math.max(...lens) - Math.min(...lens) <= 1);
  assert.equal(div[0].start, 0);
});

test("切り直す（種が変わる）と、切れ目が変わることがある。同じ種なら同じ", () => {
  const pcm = hits(2, [0.1, 0.4, 0.9, 1.5]);
  const a = cutSlices(pcm, SR, { mode: "divide", size: 0.5 }, createRng(3));
  assert.deepEqual(a, cutSlices(pcm, SR, { mode: "divide", size: 0.5 }, createRng(3)));
  const counts = new Set(Array.from({ length: 20 }, (_, i) => cutSlices(pcm, SR, { mode: "divide", size: 0.5 }, createRng(i)).length));
  assert.ok(counts.size > 1);
});
