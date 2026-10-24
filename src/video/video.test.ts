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

test("通り過ぎた判定：ふつうに進んだときと、くり返しで頭に戻ったときだけ。巻き戻し・大きな飛ばしは通っていない", async () => {
  const { bindTimeline, passed } = await import("./panels.ts");
  const tl = buildTimeline(base({ totalSteps: 64 }));
  const z = new Float32Array(64 * 100);
  bindTimeline(tl, analyze({ l: z, r: z }, 48000, 100, 64));
  assert.equal(passed(10, 11, 10.5), true);
  assert.equal(passed(10, 11, 12), false);
  assert.equal(passed(63, 1, 0), true); // 頭に戻った
  assert.equal(passed(40, 0, 50), false); // ■で先頭へ（巻き戻し）
  assert.equal(passed(0, 30, 10), false); // 位置のバーで大きく飛ばした
});

test("電光掲示板：曲の位置を巻き戻しても、頭に戻っても、文字は左へ進み続ける", async () => {
  const { PANELS, rt } = await import("./panels.ts");
  const calls: { t: string; x: number }[] = [];
  const ctx = {
    font: "", fillStyle: "", textBaseline: "",
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillText: (t: string, x: number) => calls.push({ t, x }),
  } as unknown as CanvasRenderingContext2D;
  const P = { bg: "#000", panel: "#000", ink: "#fff", line: "#333", a1: "#fa0", a2: "#f67", dim: "#888" };
  const c = { x: 0, y: 0, w: 300, h: 40 };
  rt.frameDt = 1 / 30;
  rt.parts = {};
  const scroll: number[] = [];
  // 位置：進む → 先頭へ戻る（■） → 進む → 曲の頭に戻る
  for (const S of [10, 11, 12, 0, 1, 2, 63, 0.2, 1]) {
    calls.length = 0;
    const f = { S, bar: Math.floor(S / 16), active: [] } as unknown as Parameters<typeof PANELS.ticker.draw>[2];
    PANELS.ticker.draw(ctx, c, f, P, 10, { id: 1 });
    scroll.push((rt.parts[1] as { x: number }).x);
    // 描いた文字は、すき間なくつながっている
    for (let i = 1; i < calls.length; i++) assert.ok(Math.abs(calls[i].x - (calls[i - 1].x + calls[i - 1].t.length * 10)) < 1e-6);
  }
  // 流れる量は、曲の位置に関係なく、いつも増える（巻き戻らない）
  for (let i = 1; i < scroll.length; i++) assert.ok(scroll[i] > scroll[i - 1], `コマ${i}`);
});

test("電光掲示板：LED のときは、文字を粒の幅ずつ動かす", async () => {
  const { PANELS, rt } = await import("./panels.ts");
  const xs: number[] = [];
  const ctx = {
    font: "", fillStyle: "", textBaseline: "",
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillText: (_t: string, x: number) => xs.push(x),
  } as unknown as CanvasRenderingContext2D;
  const P = { bg: "#000", panel: "#000", ink: "#fff", line: "#333", a1: "#fa0", a2: "#f67", dim: "#888" };
  rt.parts = {};
  rt.frameDt = 1 / 60;
  rt.ledCell = 7;
  const firsts: number[] = [];
  for (let k = 0; k < 20; k++) {
    xs.length = 0;
    PANELS.ticker.draw(ctx, { x: 0, y: 0, w: 300, h: 40 }, { S: k, bar: 0, active: [] } as unknown as Parameters<typeof PANELS.ticker.draw>[2], P, 10, { id: 2 });
    firsts.push(xs[0]);
  }
  // 最初の文字の位置は、はじめの位置から粒（7）の倍数だけずれる
  for (const x of firsts) assert.ok(Math.abs(((firsts[0] - x) / 7) - Math.round((firsts[0] - x) / 7)) < 1e-9);
  rt.ledCell = 0;
});

test("3拍子（1小節＝12ステップ）：位置・拍・フィルが拍子どおり。全部のパネルが描ける", async () => {
  const { PANELS, bindTimeline, rt } = await import("./panels.ts");
  const tl = buildTimeline(base({ totalSteps: 48, stepsPerBar: 12 }));
  const z = new Float32Array(48 * 100);
  const an = analyze({ l: z, r: z }, 48000, 100, 48);
  bindTimeline(tl, an);
  const f = featAt(tl, an, 14.5); // 2小節目の2拍目（12ステップ目から数えて 2.5）
  assert.equal(f.bar, 1);
  assert.equal(f.beat, 0);
  assert.equal(f.step, 2);
  assert.ok(featAt(tl, an, 36 + 7).isFill); // 4小節目の後ろ半分
  assert.ok(!featAt(tl, an, 36 + 5).isFill);
  // 描く命令は何もしない、文字の幅だけ返す Canvas の代わり
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === "measureText" ? (s: string) => ({ width: s.length * 10 }) : () => undefined),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  const P = { bg: "#000000", panel: "#000000", ink: "#ffffff", line: "#333333", a1: "#ffaa00", a2: "#ff6677", dim: "#888888" };
  rt.parts = {};
  rt.frameDt = 1 / 30;
  rt.playing = true;
  Object.entries(PANELS).forEach(([key, def], i) => {
    if (key === "sozai") return; // 画像を作るので、画面のある所でだけ
    // パネルごとに別の番号（同じ番号だと、ほかのパネルの状態を読んでしまう。映像の側では中身を替えると状態を捨てる）
    for (const S of [0, 5.5, 13, 47.9]) def.draw(ctx, { x: 0, y: 0, w: 400, h: 300 }, featAt(tl, an, S), P, 10, { id: 100 + i });
  });
});
