import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { chopBarLabels, isSilent, neededSources, planChops, planStraight, type ChopSegment } from "./chop.ts";

const input = (busy: number, breaks = 0.3, size = 0.5, bars = 8, loopBars = 4, pitch = 0) => ({
  dstBeats: bars * 4,
  beatsPerBar: 4,
  sources: [{ id: "A", bars: loopBars }],
  baseId: "A",
  params: { busy, breaks, size, pitch },
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

test("刻み0：メインの曲をそのまま通すだけの計画になる", () => {
  const plan = planChops(input(0), createRng(1));
  assert.deepEqual(plan, planStraight(32, 4, "A"));
  assert.ok(plan.every((s) => s.kind === "play"));
});

test("どの設定・どの種でも、計画は曲全体を隙間なく覆う", () => {
  for (let seed = 1; seed <= 80; seed++) {
    const busy = (seed % 5) / 4;
    const size = ((seed * 7) % 5) / 4;
    const bars = [1, 2, 4, 8][seed % 4];
    const plan = planChops(input(busy, 0.5, size, bars, [1, 2, 4][seed % 3]), createRng(seed));
    assertCovers(plan, bars * 4);
  }
});

test("刻みを最大にすると、そのままではない動きが入る。同じ種なら同じ計画。頭の小節は控えめ", () => {
  const a = planChops(input(1), createRng(5));
  assert.deepEqual(a, planChops(input(1), createRng(5)));
  assert.ok(a.some((s) => s.kind !== "play"));
  let firstPlain = 0;
  for (let seed = 1; seed <= 100; seed++) {
    if (planChops(input(1), createRng(seed))[0].kind === "play") firstPlain++;
  }
  assert.ok(firstPlain > 55, String(firstPlain));
});

test("無音は抜き0なら出ず、抜きが多いほど増える", () => {
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

test("細かさが高いほど、リピートの断片が短くなる", () => {
  const meanStutter = (size: number): number => {
    const lens: number[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      for (const s of planChops(input(1, 0, size), createRng(seed))) if (s.kind === "stutter") lens.push(s.len);
    }
    return lens.reduce((a, b) => a + b, 0) / lens.length;
  };
  assert.ok(meanStutter(1) < meanStutter(0), `${meanStutter(1)} < ${meanStutter(0)}`);
});

test("倍速（rate 2）と半速（rate 0.5）が出る。ほかは等速", () => {
  const rates = new Set<number>();
  for (let seed = 1; seed <= 80; seed++) {
    for (const s of planChops(input(1), createRng(seed))) {
      rates.add(s.rate ?? 1);
      if (s.kind === "double") assert.equal(s.rate, 2);
      if (s.kind === "half") assert.equal(s.rate, 0.5);
      if (s.kind === "play" || s.kind === "stutter" || s.kind === "jump") assert.equal(s.rate ?? 1, 1);
    }
  }
  assert.deepEqual([...rates].sort(), [0.5, 1, 2]);
});

test("曲が1つで1小節だけなら、ジャンプは出ない", () => {
  for (let seed = 1; seed <= 60; seed++) {
    assert.ok(planChops(input(1, 0.3, 0.5, 8, 1), createRng(seed)).every((s) => s.kind !== "jump"));
  }
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

test("1小節だけの曲が複数なら、ジャンプで別の曲へ飛べる", () => {
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
  assert.notDeepEqual(next, first);
});

test("固定した小節の曲が材料から無くなっていたら、固定は無視して作り直す", () => {
  const both = { ...input(1), sources: [{ id: "A", bars: 4 }, { id: "B", bars: 4 }] };
  // Bから取る区間が出る種を探す（出方は乱数しだい）
  let first: ChopSegment[] = [];
  for (let seed = 1; seed <= 50 && !first.some((s) => s.from === "B"); seed++) first = planChops(both, createRng(seed));
  assert.ok(first.some((s) => s.from === "B"));
  const next = planChops({ ...input(1), keep: { bars: [0, 1, 2, 3, 4, 5, 6, 7], plan: first } }, createRng(10));
  assert.ok(next.every((s) => s.from === "A"));
  assertCovers(next, 32);
});

test("書き出しておく (曲, 速さ) の組：無音は要らない。重複しない", () => {
  const plan: ChopSegment[] = [
    { kind: "play", from: "A", dst: 0, len: 4, src: 0 },
    { kind: "double", from: "A", dst: 4, len: 4, src: 4, rate: 2 },
    { kind: "double", from: "A", dst: 8, len: 4, src: 8, rate: 2 },
    { kind: "jump", from: "B", dst: 12, len: 4, src: 0 },
    { kind: "break", from: "B", dst: 16, len: 4, src: 0 },
  ];
  assert.deepEqual(neededSources(plan), [
    { from: "A", rate: 1 },
    { from: "A", rate: 2 },
    { from: "B", rate: 1 },
  ]);
});

test("小節ごとの説明。別の曲から取った小節には、曲名が付く", () => {
  const plan: ChopSegment[] = [
    { kind: "play", from: "A", dst: 0, len: 4, src: 0 },
    { kind: "jump", from: "B", dst: 4, len: 4, src: 0 },
    { kind: "play", from: "A", dst: 8, len: 2, src: 8 },
    { kind: "break", from: "A", dst: 10, len: 2, src: 10 },
    { kind: "double", from: "A", dst: 12, len: 4, src: 12, rate: 2 },
  ];
  assert.deepEqual(chopBarLabels(plan, 4, { baseId: "A", byId: { A: "曲A", B: "ひこうき雲" } }), [
    "そのまま",
    "ジャンプ←ひこうき",
    "無音",
    "倍速",
  ]);
});

test("音MAD風：パターン打ちは短い断片を格子に打ち、打たない所は無音。ロールはだんだん細かくなる", () => {
  let scatters = 0;
  let rolls = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const plan = planChops(input(1, 0.2, 0.8, 8, 4, 0.5), createRng(seed));
    assertCovers(plan, 32);
    for (const s of plan) {
      if (s.kind === "scatter" && !s.mute) {
        scatters++;
        assert.ok(s.len <= 0.5 + 1e-9, `断片は8分以下: ${s.len}`);
        assert.ok(Math.abs(s.dst * 4 - Math.round(s.dst * 4)) < 1e-6, "16分の格子に乗る");
      }
      if (s.kind === "roll") rolls++;
    }
    const roll = plan.filter((s) => s.kind === "roll");
    for (let i = 1; i < roll.length; i++) {
      if (Math.abs(roll[i].dst - (roll[i - 1].dst + roll[i - 1].len)) < 1e-6) assert.ok(roll[i].len <= roll[i - 1].len + 1e-9);
    }
  }
  assert.ok(scatters > 0 && rolls > 0, `${scatters} ${rolls}`);
});

test("同じパターンを、続く小節で繰り返すことがある", () => {
  let repeated = 0;
  const key = (plan: ChopSegment[], b: number) =>
    JSON.stringify(plan.filter((s) => s.dst >= b * 4 && s.dst < (b + 1) * 4).map((s) => ({ ...s, dst: s.dst - b * 4 })));
  for (let seed = 1; seed <= 100; seed++) {
    const plan = planChops(input(1, 0.2, 0.8, 8, 4, 0.5), createRng(seed));
    for (let b = 0; b < 7; b++) {
      if (plan.some((s) => s.kind === "scatter" && s.dst >= b * 4 && s.dst < (b + 1) * 4) && key(plan, b) === key(plan, b + 1)) repeated++;
    }
  }
  assert.ok(repeated > 5, String(repeated));
});

test("音程：0なら断片の音程は変わらない。上げると、半音が付く", () => {
  for (let seed = 1; seed <= 60; seed++) {
    assert.ok(planChops(input(1, 0.2, 0.8, 8, 4, 0), createRng(seed)).every((s) => !s.pitch));
  }
  let pitched = 0;
  for (let seed = 1; seed <= 60; seed++) {
    pitched += planChops(input(1, 0.2, 0.8, 8, 4, 1), createRng(seed)).filter((s) => s.pitch).length;
  }
  assert.ok(pitched > 10, String(pitched));
});

test("無音の扱い：break と mute は無音。書き出す必要もない", () => {
  assert.ok(isSilent({ kind: "break" }));
  assert.ok(isSilent({ kind: "scatter", mute: true }));
  assert.ok(!isSilent({ kind: "scatter" }));
  const plan: ChopSegment[] = [
    { kind: "scatter", from: "A", dst: 0, len: 0.5, src: 0 },
    { kind: "scatter", from: "B", dst: 0.5, len: 0.5, src: 0, mute: true },
  ];
  assert.deepEqual(neededSources(plan), [{ from: "A", rate: 1 }]);
});
