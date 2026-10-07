import { test } from "node:test";
import assert from "node:assert/strict";
import { chopPcm, limitPeak, peaksOf, type Pcm } from "./audioChop.ts";
import type { ChopSegment } from "./chop.ts";

// 1拍＝1000サンプル（sampleRate 1000、BPM 60）。曲Aは2拍。波形は「何番目のサンプルか」が分かる値にする
const SR = 1000;
const BPM = 60;
const BEATS = 2;
const ramp = (n: number): Pcm => {
  const l = new Float32Array(n).map((_, i) => (i + 1) / 10000);
  return { l, r: l.slice() };
};
const srcAt = (rate: number): Pcm => ramp((BEATS * SR * 60) / (BPM * rate));

function chop(plan: ChopSegment[], dstBeats: number, asked: number[] = []): Pcm {
  return chopPcm({
    plan,
    dstBeats,
    bpm: BPM,
    sampleRate: SR,
    getSource: (from, rate) => {
      asked.push(rate);
      return from === "A" ? srcAt(rate) : undefined;
    },
    beatsOf: () => BEATS,
  });
}

test("そのまま通すと、曲が繰り返されるだけ（継ぎ目にフェードは入らない）", () => {
  const out = chop([{ kind: "play", from: "A", dst: 0, len: 4, src: 0 }], 4);
  assert.equal(out.l.length, 4000);
  const src = srcAt(1);
  for (let i = 0; i < 4000; i++) assert.equal(out.l[i], src.l[i % 2000], `i=${i}`);
});

test("曲のBPMが違えば、長さが変わる（曲のテンポはフレーズと無関係）", () => {
  const out = chopPcm({
    plan: [{ kind: "play", from: "A", dst: 0, len: 4, src: 0 }],
    dstBeats: 4,
    bpm: 120,
    sampleRate: SR,
    getSource: () => srcAt(2),
    beatsOf: () => BEATS,
  });
  assert.equal(out.l.length, 2000); // 120BPMなら4拍＝2秒
});

test("リピート：断片の頭と終わりだけ短いフェード、真ん中は原音のまま", () => {
  const plan: ChopSegment[] = [0, 1, 2, 3].map((i) => ({ kind: "stutter", from: "A", dst: i, len: 1, src: 0 }));
  const out = chop(plan, 4);
  const src = srcAt(1);
  for (let b = 0; b < 4; b++) {
    assert.equal(out.l[b * 1000], 0); // フェードイン
    assert.equal(out.l[b * 1000 + 500], src.l[500]);
    assert.ok(out.l[b * 1000 + 999] < src.l[999]); // フェードアウト
  }
});

test("逆回し：波形が逆向きに並ぶ", () => {
  const out = chop([{ kind: "reverse", from: "A", dst: 0, len: 1, src: 0, reverse: true }], 1);
  const src = srcAt(1);
  assert.equal(out.l[500], src.l[999 - 500]);
  assert.equal(out.l[100], src.l[999 - 100]);
});

test("無音：その区間はゼロ", () => {
  const out = chop(
    [
      { kind: "play", from: "A", dst: 0, len: 1, src: 0 },
      { kind: "break", from: "A", dst: 1, len: 1, src: 1 },
    ],
    2,
  );
  assert.ok(out.l.slice(1000).every((x) => x === 0));
  assert.ok(out.l.slice(10, 900).some((x) => x !== 0));
});

test("倍速：2倍のテンポで書き出した波形から取り、1拍の間に曲が2拍ぶん進む", () => {
  const asked: number[] = [];
  const out = chop([{ kind: "double", from: "A", dst: 0, len: 1, src: 0, rate: 2 }], 1, asked);
  assert.deepEqual([...new Set(asked)], [2]);
  const src2 = srcAt(2); // 長さ1000（曲2拍が、1拍＝1000サンプルの間に収まる）
  assert.equal(src2.l.length, 1000);
  assert.equal(out.l[500], src2.l[500]);
});

test("半速：半分のテンポで書き出した波形から取り、1拍の間に曲が半拍ぶんだけ進む", () => {
  const out = chop([{ kind: "half", from: "A", dst: 0, len: 1, src: 1, rate: 0.5 }], 1);
  const src = srcAt(0.5); // 長さ4000
  // 曲の1拍目（src=1）は、書き出した波形の 1/2 の位置
  assert.equal(out.l[500], src.l[2000 + 500]);
});

test("材料に無い曲の区間は無音。曲の位置は、曲の長さで折り返す", () => {
  const out = chop(
    [
      { kind: "jump", from: "Z", dst: 0, len: 1, src: 0 },
      { kind: "jump", from: "A", dst: 1, len: 1, src: 5 }, // 5拍目＝曲(2拍)の1拍目
    ],
    2,
  );
  assert.ok(out.l.slice(0, 1000).every((x) => x === 0));
  // 5拍目＝曲(2拍)の1拍目なので、書き出した波形の1000番目から。その500サンプル先
  assert.equal(out.l[1500], srcAt(1).l[1500]);
});

test("ピークが大きいときだけ音量を下げる。波形の見た目用の縮小", () => {
  const loud: Pcm = { l: Float32Array.from([0, 2, -1]), r: Float32Array.from([0, 0, 0]) };
  const limited = limitPeak(loud);
  assert.ok(Math.abs(limited.l[1]) <= 0.98 + 1e-6);
  const quiet: Pcm = { l: Float32Array.from([0.1, -0.2]), r: Float32Array.from([0, 0]) };
  assert.ok(Math.abs(limitPeak(quiet).l[1] - -0.2) < 1e-6); // 小さい音はそのまま
  const peaks = peaksOf({ l: Float32Array.from([0, 0.5, 0, -1]), r: new Float32Array(4) }, 2);
  assert.deepEqual([...peaks], [0.5, 1]);
});
