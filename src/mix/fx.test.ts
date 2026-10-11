import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDrive,
  applyTrack,
  delaySeconds,
  delayWet,
  envCurve,
  envValueAt,
  fillBars,
  highCutHz,
  liveReverbChain,
  lowCutHz,
  newEnvelope,
  newPlugin,
  reverbSeconds,
  reverbToneHz,
  sanitizeTakes,
  sanitizeTrack,
  trackIsOff,
  type FxEnv,
  type TakeFx,
} from "./fx.ts";
import type { Pcm } from "./pcm.ts";

const SR = 1000;
const env = (over: Partial<FxEnv> = {}): FxEnv => ({
  stepSamples: 10, // 1小節（16ステップ）＝160サンプル
  sampleRate: SR,
  bpm: 120,
  reverb: async (pcm) => pcm, // 響き＝送った音そのまま（試験用）
  ...over,
});
const flat = (n: number, v = 0.5): Pcm => ({ l: new Float32Array(n).fill(v), r: new Float32Array(n).fill(v) });
const sine = (n: number, hz = 30): Pcm => {
  const l = Float32Array.from({ length: n }, (_, i) => 0.6 * Math.sin((2 * Math.PI * hz * i) / SR));
  return { l, r: l.slice() };
};

test("エフェクトの数字：長さ・間隔・周波数", () => {
  assert.ok(Math.abs(reverbSeconds(0) - 0.3) < 1e-9);
  assert.ok(Math.abs(reverbSeconds(1) - 6) < 1e-9);
  assert.equal(delaySeconds("1/8d", 120), 0.375);
  assert.equal(lowCutHz(0), 20);
  assert.ok(Math.abs(highCutHz(1) - 300) < 1e-6);
  assert.deepEqual(fillBars(8), [3, 7]);
});

test("エンベロープ：点の間はまっすぐ結ぶ。同じ位置の2点は段（四角）になる。前後ははみ出さない", () => {
  const pts = [
    { t: 0, v: 0 },
    { t: 10, v: 1 },
    { t: 20, v: 1 },
    { t: 20, v: 0 },
  ];
  assert.equal(envValueAt(pts, -5), 0);
  assert.equal(envValueAt(pts, 5), 0.5);
  assert.equal(envValueAt(pts, 15), 1);
  assert.equal(envValueAt(pts, 20), 0);
  assert.equal(envValueAt(pts, 99), 0);
  const c = envCurve(pts, 300, 10);
  assert.equal(c[50], 0.5);
  assert.equal(c[150], 1);
  assert.equal(c[250], 0);
});

test("FXチェーン：上から順に掛かる。バイパスしたものは掛からない", async () => {
  const n = 1000;
  const drive = newPlugin("drive", { amount: 1 });
  const hpf = newPlugin("lowCut", { amount: 0.6 });
  const a = await applyTrack(sine(n), { chain: [drive, hpf], envelopes: [] }, env());
  const b = await applyTrack(sine(n), { chain: [hpf, drive], envelopes: [] }, env());
  assert.ok(Math.abs(a.l[400] - b.l[400]) > 1e-3);
  const off = await applyTrack(sine(n), { chain: [{ ...drive, bypass: true }], envelopes: [] }, env());
  assert.ok(Math.abs(off.l[400] - sine(n).l[400]) < 1e-9);
  assert.ok(trackIsOff({ chain: [{ ...drive, bypass: true }], envelopes: [] }));
});

test("ウェット：差し込みは、元の音と掛けた音をウェットの割合で混ぜる", async () => {
  const n = 200;
  const full = await applyTrack(flat(n, 0.3), { chain: [newPlugin("crush", { amount: 1 })], envelopes: [] }, env());
  const half = await applyTrack(flat(n, 0.3), { chain: [newPlugin("crush", { amount: 1, mix: 0.5 })], envelopes: [] }, env());
  assert.ok(Math.abs(half.l[50] - (0.3 + full.l[50]) / 2) < 1e-6);
});

test("エンベロープで、ウェットを時間で動かせる（その所だけ掛かる）。送りは、送った所の音だけ響く", async () => {
  const n = 8 * 160;
  const crush = newPlugin("crush", { amount: 1 });
  const e = { ...newEnvelope(crush, "mix", 128), points: [{ t: 0, v: 0 }, { t: 16, v: 0 }, { t: 16, v: 1 }, { t: 32, v: 1 }, { t: 32, v: 0 }] };
  const out = await applyTrack(flat(n, 0.3), { chain: [crush], envelopes: [e] }, env());
  assert.ok(Math.abs(out.l[50] - 0.3) < 1e-6); // 1小節目：掛からない
  assert.notEqual(out.l[250], 0.3); // 2小節目：掛かる
  assert.ok(Math.abs(out.l[500] - 0.3) < 1e-6);
  // 切ったエンベロープは無視（つまみの値＝ウェット100%）
  const offEnv = await applyTrack(flat(n, 0.3), { chain: [crush], envelopes: [{ ...e, active: false }] }, env());
  assert.notEqual(offEnv.l[50], 0.3);
  // 送り：量のエンベロープの所だけ送る
  const seen: number[] = [];
  const rev = newPlugin("reverb", { amount: 1 });
  const re = { ...newEnvelope(rev, "amount", 128), points: [{ t: 0, v: 0 }, { t: 16, v: 0 }, { t: 16, v: 1 }] };
  await applyTrack(flat(n, 0.5), { chain: [rev], envelopes: [re] }, env({ reverb: async (pcm) => (seen.push(pcm.l[50], pcm.l[250]), pcm) }));
  assert.deepEqual(seen, [0, 0.25]);
});

test("ディレイ：間隔ごとに、だんだん小さくくり返す。曲の終わりを越えたら頭に回す", () => {
  const n = 100;
  const pcm: Pcm = { l: new Float32Array(n), r: new Float32Array(n) };
  pcm.l[90] = 1;
  const wet = delayWet(pcm, 20, 0.5);
  assert.ok(wet.l[10] > 0.2);
  assert.ok(wet.l[30] > 0.05 && wet.l[30] < wet.l[10]);
});

test("読み込み：いまの形、少し前の形（いつ掛けるか つき）、その前の1組の形", () => {
  const legacy = { stepsPerBar: 16, bars: 8 };
  const now = sanitizeTrack({ chain: [{ id: "p1", kind: "delay", amount: 0.5, time: "1/4", bypass: true }], envelopes: [{ id: "e1", pluginId: "p1", param: "mix", points: [{ t: 5, v: 2 }, { t: 1, v: 0.5 }] }, { pluginId: "zz", param: "mix", points: [] }] }, legacy);
  assert.equal(now.chain[0].time, "1/4");
  assert.equal(now.chain[0].bypass, true);
  assert.equal(now.envelopes.length, 1);
  assert.deepEqual(now.envelopes[0].points, [{ t: 1, v: 0.5 }, { t: 5, v: 1 }]);
  const takes: TakeFx[] = [];
  const old = sanitizeTrack(
    [
      { kind: "highCut", amount: 0.4, when: "bars", from: 2, to: 3 },
      { kind: "delay", amount: 0.5, when: "hits", steps: [4, 8] },
      { kind: "reverb", amount: 0.2, when: "all" },
    ],
    legacy,
    takes,
  );
  assert.deepEqual(old.chain.map((p) => p.kind), ["highCut", "reverb"]);
  assert.equal(old.envelopes.length, 1); // 小節を選ぶ → ウェットのエンベロープ（2〜3小節目だけ1）
  assert.equal(envValueAt(old.envelopes[0].points, 10), 0);
  assert.equal(envValueAt(old.envelopes[0].points, 20), 1);
  assert.equal(envValueAt(old.envelopes[0].points, 50), 0);
  assert.deepEqual(takes.map((t) => [t.step, t.chain[0].kind]), [[4, "delay"], [8, "delay"]]);
  const older = sanitizeTrack({ reverb: 0.2, delay: 0.5, delayTime: "1/4", drive: 0.3 }, legacy);
  assert.deepEqual(older.chain.map((p) => p.kind), ["drive", "delay", "reverb"]);
  assert.deepEqual(sanitizeTakes([{ step: 3, chain: [{ kind: "crush" }] }, { step: 3, chain: [{ kind: "drive" }] }, { step: 1, chain: [] }]).map((t) => t.step), [3]);
  const pcm = { l: Float32Array.from([0.1]), r: Float32Array.from([0.1]) };
  assert.equal(applyDrive(pcm, 0, 0), pcm);
});

test("フィルター：くり返しのつなぎ目で、音が途切れない（プチッとしない）", async () => {
  const n = 1000; // 100Hzがちょうど100周
  const l = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 100 * i) / SR));
  const out = await applyTrack({ l, r: l.slice() }, { chain: [newPlugin("highCut", { amount: 0.9 })], envelopes: [] }, env());
  let steady = 0;
  for (let i = 300; i < n; i++) steady = Math.max(steady, Math.abs(out.l[i] - out.l[i - 1]));
  assert.ok(Math.abs(out.l[0] - out.l[n - 1]) < steady * 2, `つなぎ目 ${Math.abs(out.l[0] - out.l[n - 1])} / ふだん ${steady}`);
});

test("エンベロープの曲線：点を順にたどっても、1点ずつ計算したのと同じ", () => {
  const pts = [{ t: 0, v: 0 }, { t: 3, v: 1 }, { t: 3, v: 0.2 }, { t: 7, v: 0.6 }];
  const c = envCurve(pts, 100, 10);
  for (let i = 0; i < 100; i += 7) assert.ok(Math.abs(c[i] - envValueAt(pts, i / 10)) < 1e-6, `i=${i}`);
});

test("リアルタイムで掛けられるマスター：リバーブだけでつまみが動かないときの並び。それ以外は null", () => {
  assert.deepEqual(liveReverbChain(undefined), []);
  assert.deepEqual(liveReverbChain({ chain: [], envelopes: [] }), []);
  const rv = newPlugin("reverb", { amount: 0.4, mix: 0.5, size: 0.35, tone: 0.5 });
  const got = liveReverbChain({ chain: [rv], envelopes: [] })!;
  assert.equal(got.length, 1);
  assert.ok(Math.abs(got[0].send - 0.5 * 0.4 * 0.5) < 1e-12);
  assert.ok(Math.abs(got[0].seconds - reverbSeconds(0.35)) < 1e-12);
  assert.ok(Math.abs(got[0].toneHz - reverbToneHz(0.5)) < 1e-9);
  // バイパス・量0は飛ばす
  assert.deepEqual(liveReverbChain({ chain: [{ ...rv, bypass: true }, newPlugin("reverb", { amount: 0 })], envelopes: [] }), []);
  // 別のプラグイン・エンベロープは、リアルタイムでは掛けない
  assert.equal(liveReverbChain({ chain: [rv, newPlugin("delay")], envelopes: [] }), null);
  assert.equal(liveReverbChain({ chain: [rv], envelopes: [newEnvelope(rv, "amount", 64)] }), null);
  // 切ったエンベロープは、つまみの値のまま
  assert.equal(liveReverbChain({ chain: [rv], envelopes: [{ ...newEnvelope(rv, "amount", 64), active: false }] })!.length, 1);
});
