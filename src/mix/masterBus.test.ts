import { test } from "node:test";
import assert from "node:assert/strict";
import { MASTER_BUS_DEFAULTS, compressorReductionDb, masterBus, masterBusLoop, type MasterBusOptions } from "./masterBus.ts";
import { MasterBusStream } from "./masterBusStream.ts";
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

// ---- ストリーム版：旧バッチ版（基準）と同じ結果になること

const toDb = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));
const fromDb = (db: number): number => Math.pow(10, db / 20);

function referenceMasterBus(pcm: Pcm, sampleRate: number, opts: Partial<MasterBusOptions> = {}): Pcm {
  const o = { ...MASTER_BUS_DEFAULTS, ...opts };
  const n = pcm.l.length;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  if (n === 0) return { l, r };

  // 1. コンプ：サンプルごと（別実装の基準）
  const atk = Math.exp(-1 / ((o.attackMs / 1000) * sampleRate));
  const rel = Math.exp(-1 / ((o.releaseMs / 1000) * sampleRate));
  const makeup = fromDb(o.makeupDb);
  let reduction = 0;
  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(pcm.l[i]), Math.abs(pcm.r[i]));
    const target = peak > 0 ? compressorReductionDb(toDb(peak), o) : 0;
    const k = target < reduction ? atk : rel;
    reduction = k * reduction + (1 - k) * target;
    const gain = fromDb(reduction) * makeup;
    l[i] = pcm.l[i] * gain;
    r[i] = pcm.r[i] * gain;
  }

  // 2. リミッター：上限を超える所の必要な下げ幅を先読みし、前後になだらかに下げる
  const look = Math.max(1, Math.round((o.lookaheadMs / 1000) * sampleRate));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    need[i] = peak > o.ceiling ? o.ceiling / peak : 1;
  }
  // 先読みの最小値 M[i] = min(need[i .. i+look-1])（単調キューで一度に求める）
  const min = new Float32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[queue[tail - 1]] >= need[i]) tail--;
    queue[tail++] = i;
    while (queue[head] > i + look - 1) head++;
    min[i] = need[queue[head]];
  }
  // G[i] = M[i-look+1 .. i] の平均。どの i でも G[i] <= need[i]（上限を超えない）
  const relK = 1 - Math.exp(-1 / ((o.limiterReleaseMs / 1000) * sampleRate));
  let sum = 0;
  let prev = 1;
  for (let i = 0; i < n; i++) {
    sum += min[i];
    if (i >= look) sum -= min[i - look];
    const count = Math.min(i + 1, look);
    const avg = (sum + (look - count) * min[0]) / look; // 先頭より前は、最初の窓の値で埋める（先頭でも上限を守る）
    // 戻りはゆっくり（低音が歪まないように）。下がる所は平均のなだらかさに任せる
    const g = Math.min(avg, prev + (1 - prev) * relK);
    prev = g;
    l[i] *= g;
    r[i] *= g;
  }
  return { l, r };
}

function noisy(frames: number, seed: number): Pcm {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    // 大きさが場所で変わる音（静か・大きい・急に大きいクリック）
    const env = i % 4000 < 300 ? 1.6 : i % 4000 < 1500 ? 0.4 : 0.03;
    l[i] = rand() * env + (i === 5000 ? 3 : 0);
    r[i] = rand() * env * 0.8;
  }
  return { l, r };
}

test("ストリーム版は、別実装のバッチ版（基準）と同じ結果", () => {
  for (const [frames, seed] of [[16 * 1000, 1], [16 * 777 + 5, 2]] as const) {
    const pcm = noisy(frames, seed);
    const want = referenceMasterBus(pcm, SR);
    const got = masterBus(pcm, SR);
    assert.equal(got.l.length, frames);
    let max = 0;
    for (let i = 0; i < frames; i++) max = Math.max(max, Math.abs(got.l[i] - want.l[i]), Math.abs(got.r[i] - want.r[i]));
    assert.ok(max < 2e-5, `${frames}フレーム：最大の差 ${max}`);
  }
});

test("ストリーム版：どんな長さで区切って流しても、まとめて流したときと同じ。遅れは latency サンプル", () => {
  const pcm = noisy(16 * 800, 3);
  const frames = pcm.l.length;
  const whole = new MasterBusStream(SR);
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  whole.process(pcm.l, pcm.r, outL, outR);
  const cl = new Float32Array(frames);
  const cr = new Float32Array(frames);
  for (const size of [128, 16, 64, 1, 7]) {
    const s = new MasterBusStream(SR);
    for (let at = 0; at < frames; at += size) {
      const end = Math.min(frames, at + size);
      s.process(pcm.l.subarray(at, end), pcm.r.subarray(at, end), cl.subarray(at, end), cr.subarray(at, end));
    }
    assert.deepEqual(cl, outL, `${size}サンプルずつ`);
  }
  assert.ok(whole.latency > 0);
  // 遅れの前は無音
  assert.ok(outL.subarray(0, whole.latency).every((x) => x === 0));
});

test("ストリーム版：入力と出力が同じ配列でも、結果は同じ。上限を超えない", () => {
  const pcm = noisy(16 * 500, 4);
  const separate = new MasterBusStream(SR);
  const a = new Float32Array(pcm.l.length);
  const b = new Float32Array(pcm.l.length);
  separate.process(pcm.l, pcm.r, a, b);
  const inPlace = new MasterBusStream(SR);
  const l = Float32Array.from(pcm.l);
  const r = Float32Array.from(pcm.r);
  inPlace.process(l, r, l, r);
  assert.deepEqual(l, a);
  assert.deepEqual(r, b);
  assert.ok(Math.max(...a.map(Math.abs), ...b.map(Math.abs)) <= MASTER_BUS_DEFAULTS.ceiling + 1e-4);
});

test("くり返す曲の仕上げ：長さは同じで、ずっと続くループの途中と同じ音（頭の冷えた状態を避ける）", () => {
  const pcm = noisy(SR * 3, 9); // 3秒（助走の2秒より少し長い）
  const frames = pcm.l.length;
  const three = { l: new Float32Array(frames * 3), r: new Float32Array(frames * 3) };
  for (let k = 0; k < 3; k++) {
    three.l.set(pcm.l, k * frames);
    three.r.set(pcm.r, k * frames);
  }
  const middle = masterBus(three, SR).l.subarray(frames * 2, frames * 3);
  const looped = masterBusLoop(pcm, SR);
  assert.equal(looped.l.length, frames);
  let max = 0;
  for (let i = 0; i < frames; i++) max = Math.max(max, Math.abs(looped.l[i] - middle[i]));
  assert.ok(max < 1e-3, `ずっと続くループとの差 ${max}`);
  // 冷えた状態から始めた場合は、頭が違う
  const cold = masterBus(pcm, SR).l;
  let coldDiff = 0;
  for (let i = 0; i < Math.round(SR * 0.3); i++) coldDiff = Math.max(coldDiff, Math.abs(cold[i] - middle[i]));
  assert.ok(coldDiff > max, "冷えた状態の頭は、ループの続きとは違う");
  assert.equal(masterBusLoop({ l: new Float32Array(0), r: new Float32Array(0) }, SR).l.length, 0);
});
