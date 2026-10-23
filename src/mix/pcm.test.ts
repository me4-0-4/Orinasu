import { test } from "node:test";
import assert from "node:assert/strict";
import { compressPcm, gainPcm, limitPeak, type Pcm } from "./pcm.ts";

const sr = 8000;
/** 前半は小さい音、後半は大きい音のサイン波。 */
function twoLevel(): Pcm {
  const n = sr; // 1秒
  const l = new Float32Array(n).map((_, i) => (i < n / 2 ? 0.05 : 0.8) * Math.sin((2 * Math.PI * 200 * i) / sr));
  return { l, r: l.slice() };
}
const peak = (a: Float32Array, from: number, to: number): number => {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
};

test("コンプ0なら、波形はそのまま", () => {
  const pcm = twoLevel();
  const before = pcm.l.slice();
  compressPcm(pcm, 0, sr);
  assert.deepEqual(pcm.l, before);
});

test("コンプを掛けると、大きい音が小さい音に近づく（音量の差が縮まる）", () => {
  const pcm = twoLevel();
  const ratioBefore = peak(pcm.l, 3000, 4000) > 0 ? peak(pcm.l, 6000, 8000) / peak(pcm.l, 1000, 3000) : 0;
  compressPcm(pcm, 1, sr);
  const ratioAfter = peak(pcm.l, 6000, 8000) / peak(pcm.l, 1000, 3000);
  assert.ok(ratioAfter < ratioBefore * 0.7, `${ratioAfter} < ${ratioBefore}`);
  assert.ok(pcm.l.every(Number.isFinite));
});

test("左右は同じだけ抑える（ステレオ連動）", () => {
  const pcm = twoLevel();
  compressPcm(pcm, 0.8, sr);
  assert.deepEqual(pcm.l, pcm.r);
});

test("音量を掛けて、割れそうなときだけリミッターが下げる", () => {
  const pcm = gainPcm(twoLevel(), 1.5);
  assert.ok(peak(pcm.l, 0, sr) > 1);
  limitPeak(pcm);
  assert.ok(peak(pcm.l, 0, sr) <= 0.98 + 1e-6);
});
