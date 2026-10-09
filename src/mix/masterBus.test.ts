import { test } from "node:test";
import assert from "node:assert/strict";
import { MASTER_BUS_DEFAULTS, compressorReductionDb, masterBus } from "./masterBus.ts";
import type { Pcm } from "./pcm.ts";

const SR = 8000;

function sine(seconds: number, amp: number, from = 0, to = seconds): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = Math.round(from * SR); i < Math.min(out.length, Math.round(to * SR)); i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  return out;
}
const stereo = (x: Float32Array): Pcm => ({ l: x, r: Float32Array.from(x) });
const rms = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.round((b - a) * SR));
};
const peak = (p: Pcm): number => p.l.reduce((m, v, i) => Math.max(m, Math.abs(v), Math.abs(p.r[i])), 0);

test("コンプ：しきい値より下は下げず、上は比に従って下げる。つなぎ目はなめらか", () => {
  const o = MASTER_BUS_DEFAULTS;
  assert.equal(compressorReductionDb(o.thresholdDb - 20, o), 0);
  const above = compressorReductionDb(o.thresholdDb + 12, o);
  assert.ok(Math.abs(above - 12 * (1 / o.ratio - 1)) < 1e-9);
  let prev = 0;
  for (let db = o.thresholdDb - 10; db <= o.thresholdDb + 10; db += 0.5) {
    const r = compressorReductionDb(db, o);
    assert.ok(r <= prev + 1e-9, "大きくなるほど、下げ幅は増える");
    assert.ok(prev - r < 1, "とびがない");
    prev = r;
  }
});

test("リミッター：どれだけ大きい入力でも、上限を超えない", () => {
  const loud = stereo(sine(1, 4)); // 大きく割れている入力
  const out = masterBus(loud, SR);
  assert.ok(peak(out) <= MASTER_BUS_DEFAULTS.ceiling + 1e-4, String(peak(out)));
  // 急に大きくなる1点（クリック）も上限内
  const spike = new Float32Array(SR);
  spike[4000] = 3;
  assert.ok(peak(masterBus(stereo(spike), SR)) <= MASTER_BUS_DEFAULTS.ceiling + 1e-4);
});

test("大きい所と小さい所の差が縮む（大きい所は抑え、小さい所は持ち上げる）", () => {
  const x = sine(2, 0.9, 0, 1);
  const quiet = sine(2, 0.05, 1, 2);
  for (let i = 0; i < x.length; i++) x[i] += quiet[i];
  const before = rms(x, 0.2, 0.9) / rms(x, 1.2, 1.9);
  const out = masterBus(stereo(x), SR);
  const after = rms(out.l, 0.2, 0.9) / rms(out.l, 1.2, 1.9);
  assert.ok(after < before, `${before.toFixed(1)} → ${after.toFixed(1)}`);
});

test("無音は無音のまま。長さも左右も変わらず、元の波形は書き換えない", () => {
  const silent = stereo(new Float32Array(SR));
  const out = masterBus(silent, SR);
  assert.equal(out.l.length, SR);
  assert.equal(peak(out), 0);
  const src = stereo(sine(1, 0.5));
  const copy = Float32Array.from(src.l);
  masterBus(src, SR);
  assert.deepEqual(src.l, copy);
  assert.equal(masterBus({ l: new Float32Array(0), r: new Float32Array(0) }, SR).l.length, 0);
});

test("左右は同じだけ下げる（定位がずれない）", () => {
  const l = sine(1, 0.9);
  const r = sine(1, 0.45);
  const out = masterBus({ l, r }, SR);
  for (let i = 1000; i < 7000; i += 97) {
    if (Math.abs(l[i]) < 0.1) continue;
    assert.ok(Math.abs(out.r[i] / out.l[i] - r[i] / l[i]) < 1e-3);
  }
});
