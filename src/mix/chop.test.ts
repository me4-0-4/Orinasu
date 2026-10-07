import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import type { Note } from "../phrase/types.ts";
import { applyPlan, chopBarLabels, planChops, planStraight, type ChopSegment } from "./chop.ts";

function note(pitch: number, start: number, dur = 0.5): Note {
  return { id: `n${pitch}_${start}`, pitch, velocity: 0.8, startBeats: start, durationBeats: dur };
}

const input = (busy: number, breaks = 0.3, size = 0.5, bars = 8, loopBars = 4) => ({
  dstBeats: bars * 4,
  beatsPerBar: 4,
  sources: [{ id: "A", bars: loopBars }],
  baseId: "A",
  params: { busy, breaks, size },
});

/** 計画が隙間も重なりもなく、頭から終わりまでを覆っているか。 */
function assertCovers(plan: ChopSegment[], dstBeats: number): void {
  const sorted = plan.slice().sort((a, b) => a.dst - b.dst);
  let t = 0;
  for (const s of sorted) {
    assert.ok(Math.abs(s.dst - t) < 1e-6, `隙間か重なり: ${s.dst} vs ${t}`);
    assert.ok(s.len > 0);
    t = s.dst + s.len;
  }
  assert.ok(Math.abs(t - dstBeats) < 1e-6, `終わり ${t} vs ${dstBeats}`);
}

test("刻み0：そのまま通すだけの計画になる", () => {
  const plan = planChops(input(0), createRng(1));
  assert.deepEqual(plan, planStraight(32, 4, "A"));
  assert.ok(plan.every((s) => s.kind === "play"));
});

test("どの設定・どの種でも、計画はセクション全体を隙間なく覆う", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const busy = (seed % 5) / 4;
    const size = ((seed * 7) % 5) / 4;
    const bars = [1, 2, 4, 8][seed % 4];
    const plan = planChops(input(busy, 0.5, size, bars, [1, 2, 4][seed % 3]), createRng(seed));
    assertCovers(plan, bars * 4);
  }
});

test("刻みを最大にすると、そのままではない動きが入る。同じ種なら同じ計画", () => {
  const a = planChops(input(1), createRng(5));
  const b = planChops(input(1), createRng(5));
  assert.deepEqual(a, b);
  assert.ok(a.some((s) => s.kind !== "play"));
  // 頭の小節は、ほかよりそのまま通りやすい（最大でも25%）。多くの種で、頭はそのまま
  let firstPlain = 0;
  for (let seed = 1; seed <= 100; seed++) {
    if (planChops(input(1), createRng(seed))[0].kind === "play") firstPlain++;
  }
  assert.ok(firstPlain > 55, String(firstPlain));
});

test("抜き0なら抜きは出ず、抜きが多いほど増える", () => {
  const count = (breaks: number): number => {
    let n = 0;
    for (let seed = 1; seed <= 80; seed++) {
      n += planChops(input(1, breaks), createRng(seed)).filter((s) => s.kind === "break").length;
    }
    return n;
  };
  assert.equal(count(0), 0);
  assert.ok(count(1) > count(0.3));
});

test("細かさが高いほど、断片が短くなる", () => {
  const meanStutter = (size: number): number => {
    const lens: number[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      for (const s of planChops(input(1, 0, size), createRng(seed))) if (s.kind === "stutter") lens.push(s.len);
    }
    return lens.reduce((a, b) => a + b, 0) / lens.length;
  };
  assert.ok(meanStutter(1) < meanStutter(0), `${meanStutter(1)} < ${meanStutter(0)}`);
});

test("材料が1小節だけなら、ジャンプは出ない", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const plan = planChops(input(1, 0.3, 0.5, 8, 1), createRng(seed));
    assert.ok(plan.every((s) => s.kind !== "jump"));
  }
});

test("そのまま通す計画は、材料のループを繰り返すだけ", () => {
  const notes = [note(60, 0), note(62, 1), note(64, 2), note(65, 3)];
  const out = applyPlan(notes, 4, "melody", planStraight(8, 4, "A"), 8);
  assert.deepEqual(out.map((n) => n.pitch), [60, 62, 64, 65, 60, 62, 64, 65]);
  assert.deepEqual(out.map((n) => n.startBeats), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("リピート：同じ断片を並べる。断片の外にはみ出す音は切る", () => {
  const notes = [note(60, 0, 3), note(62, 1)];
  const plan: ChopSegment[] = [
    { kind: "stutter", from: "A", dst: 0, len: 1, src: 0 },
    { kind: "stutter", from: "A", dst: 1, len: 1, src: 0 },
    { kind: "stutter", from: "A", dst: 2, len: 1, src: 0 },
    { kind: "stutter", from: "A", dst: 3, len: 1, src: 0 },
  ];
  const out = applyPlan(notes, 4, "melody", plan, 4);
  assert.deepEqual(out.map((n) => [n.pitch, n.startBeats, n.durationBeats]), [
    [60, 0, 1],
    [60, 1, 1],
    [60, 2, 1],
    [60, 3, 1],
  ]);
});

test("逆回し：音の順番が逆になる", () => {
  const notes = [note(60, 0), note(62, 1), note(64, 2), note(65, 3)];
  const plan: ChopSegment[] = [{ kind: "reverse", from: "A", dst: 0, len: 4, src: 0, reverse: true }];
  const out = applyPlan(notes, 4, "melody", plan, 4);
  assert.deepEqual(out.map((n) => n.pitch), [65, 64, 62, 60]);
  assert.deepEqual(out.map((n) => n.startBeats), [0.5, 1.5, 2.5, 3.5]);
});

test("抜き：ドラムだけの区間では、ドラム以外が無音になる。全層に同じ計画で効く", () => {
  const notes = [note(60, 0), note(62, 2)];
  const plan: ChopSegment[] = [
    { kind: "play", from: "A", dst: 0, len: 2, src: 0 },
    { kind: "break", from: "A", dst: 2, len: 2, src: 2, mask: ["drums"] },
  ];
  assert.deepEqual(applyPlan(notes, 4, "melody", plan, 4).map((n) => n.startBeats), [0]);
  assert.deepEqual(applyPlan(notes, 4, "drums", plan, 4).map((n) => n.startBeats), [0, 2]);
  const silent: ChopSegment[] = [{ kind: "break", from: "A", dst: 0, len: 4, src: 0, mask: [] }];
  assert.equal(applyPlan(notes, 4, "drums", silent, 4).length, 0);
});

test("ジャンプ：材料の別の小節から取る。材料より先の位置は頭に戻って続く", () => {
  const notes = [note(60, 0), note(61, 4), note(62, 8), note(63, 12)]; // 4小節の材料
  const plan: ChopSegment[] = [{ kind: "jump", from: "A", dst: 0, len: 4, src: 8 }];
  assert.deepEqual(applyPlan(notes, 16, "melody", plan, 4).map((n) => n.pitch), [62]);
  const wrapped: ChopSegment[] = [{ kind: "jump", from: "A", dst: 0, len: 4, src: 20 }]; // 16 を越えて、2周目の1小節目
  assert.deepEqual(applyPlan(notes, 16, "melody", wrapped, 4).map((n) => n.pitch), [61]);
});

test("小節ごとの説明", () => {
  const plan: ChopSegment[] = [
    { kind: "play", from: "A", dst: 0, len: 4, src: 0 },
    { kind: "play", from: "A", dst: 4, len: 2, src: 4 },
    { kind: "break", from: "A", dst: 6, len: 2, src: 6, mask: ["drums"] },
    { kind: "stutter", from: "A", dst: 8, len: 2, src: 8 },
    { kind: "stutter", from: "A", dst: 10, len: 2, src: 8 },
  ];
  assert.deepEqual(chopBarLabels(plan, 4), ["そのまま", "ドラムだけ", "リピート"]);
});

test("曲が複数なら、別の曲から取る区間が出る。曲が1つなら出ない", () => {
  const multi = { ...input(1, 0.2, 0.5, 8, 4), sources: [{ id: "A", bars: 4 }, { id: "B", bars: 2 }] };
  let other = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const plan = planChops(multi, createRng(seed));
    assertCovers(plan, 32);
    other += plan.filter((s) => s.from === "B").length;
  }
  assert.ok(other > 0);
  for (let seed = 1; seed <= 60; seed++) {
    assert.ok(planChops(input(1), createRng(seed)).every((s) => s.from === "A"));
  }
});

test("1小節だけの曲が1つなら、ジャンプは出ない。曲が複数ならジャンプで別の曲へ飛べる", () => {
  const multi = { ...input(1, 0, 0.5, 8, 1), sources: [{ id: "A", bars: 1 }, { id: "B", bars: 1 }] };
  let jumps = 0;
  for (let seed = 1; seed <= 80; seed++) {
    jumps += planChops(multi, createRng(seed)).filter((s) => s.kind === "jump").length;
  }
  assert.ok(jumps > 0);
});

test("固定した小節は、前の計画のまま残る（ほかは変わる）", () => {
  const first = planChops(input(1), createRng(3));
  const next = planChops({ ...input(1), keep: { bars: [1, 2], plan: first } }, createRng(4));
  const inBar = (plan: ChopSegment[], b: number) => plan.filter((s) => s.dst >= b * 4 && s.dst < (b + 1) * 4);
  assert.deepEqual(inBar(next, 1), inBar(first, 1));
  assert.deepEqual(inBar(next, 2), inBar(first, 2));
  assertCovers(next, 32);
  assert.notDeepEqual(next, first); // 固定していない小節は変わる
});

test("固定した小節の曲が材料から無くなっていたら、固定は無視して作り直す", () => {
  const first = planChops({ ...input(1), sources: [{ id: "A", bars: 4 }, { id: "B", bars: 4 }] }, createRng(9));
  assert.ok(first.some((s) => s.from === "B")); // 前の計画には B から取った区間がある
  const next = planChops({ ...input(1), keep: { bars: [0, 1, 2, 3, 4, 5, 6, 7], plan: first } }, createRng(10));
  assert.ok(next.every((s) => s.from === "A"));
  assertCovers(next, 32);
});

test("曲ごとに取り出せる：fromId を渡すと、その曲の区間だけを使う", () => {
  const notes = [note(60, 0), note(62, 1)];
  const plan: ChopSegment[] = [
    { kind: "play", from: "A", dst: 0, len: 2, src: 0 },
    { kind: "jump", from: "B", dst: 2, len: 2, src: 0 },
  ];
  assert.deepEqual(applyPlan(notes, 4, "melody", plan, 4, "A").map((n) => n.startBeats), [0, 1]);
  assert.deepEqual(applyPlan(notes, 4, "melody", plan, 4, "B").map((n) => n.startBeats), [2, 3]);
});

test("別の曲から取った小節には、ラベルに曲名が付く", () => {
  const plan: ChopSegment[] = [
    { kind: "play", from: "A", dst: 0, len: 4, src: 0 },
    { kind: "jump", from: "B", dst: 4, len: 4, src: 0 },
  ];
  assert.deepEqual(chopBarLabels(plan, 4, { baseId: "A", byId: { A: "曲A", B: "ひこうき雲" } }), [
    "そのまま",
    "ジャンプ←ひこうき",
  ]);
});
