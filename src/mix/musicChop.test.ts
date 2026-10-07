import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { musicSlices, musicSlotSteps, planMusicLane, type MusicLaneInput } from "./musicChop.ts";

const SPB = 16; // 1小節＝16分×16
const shape = { busy: 0.6, breaks: 0, onBeat: 0, size: 0.5, motion: 0, hold: 1 };
const input = (over: Partial<MusicLaneInput> = {}, seed = 1): MusicLaneInput => ({
  totalSteps: 8 * SPB,
  stepsPerBar: SPB,
  srcBars: 4,
  slotSteps: 2,
  laneIndex: 0,
  laneCount: 1,
  params: shape,
  cutRng: createRng(seed),
  rhythmRng: createRng(seed + 1),
  orderRng: createRng(seed + 2),
  ...over,
});
const slots = (slotSteps: number) => SPB / slotSteps;

test("断片の長さのつまみ：小さいと16分、真ん中で8分、大きいと1拍", () => {
  assert.equal(musicSlotSteps(0), 1);
  assert.equal(musicSlotSteps(0.5), 2);
  assert.equal(musicSlotSteps(1), 4);
});

test("切り方：拍の格子で切り、断片は小節の終わりまで。番号は 元の小節×小節の中の位置", () => {
  const s = musicSlices({ srcBars: 2, stepsPerBar: 16, slotSteps: 4, stepSamples: 100, length: 3200 });
  assert.equal(s.length, 8);
  assert.deepEqual(s[0], { start: 0, end: 1600 });
  assert.deepEqual(s[5], { start: 2000, end: 3200 }); // 2小節目の2拍目から
});

test("コードを守る：b小節目の断片は、元の (b % 元の小節数) 小節目からだけ取る。1拍目は元の1拍目", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const ev = planMusicLane(input({}, seed));
    for (let b = 0; b < 8; b++) {
      const inBar = ev.filter((e) => Math.floor(e.step / SPB) === b);
      assert.ok(inBar.length > 0);
      for (const e of inBar) assert.equal(Math.floor(e.slice / slots(2)), b % 4, `seed ${seed} bar ${b}`);
      const head = inBar.find((e) => e.step === b * SPB);
      assert.ok(head, "小節の頭は必ず打つ");
      assert.equal(head!.slice % slots(2), 0, "頭は元の1拍目");
    }
  }
});

test("型をくり返す：4小節のまとまりの1〜3小節目は同じパターン（1小節パターンのとき）、4小節目はフィル", () => {
  let checked = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const ev = planMusicLane(input({ totalSteps: 4 * SPB, srcBars: 1 }, seed));
    const pat = (b: number) => JSON.stringify(ev.filter((e) => Math.floor(e.step / SPB) === b).map((e) => [e.step - b * SPB, e.slice]));
    assert.equal(pat(0), pat(1));
    assert.equal(pat(1), pat(2));
    if (pat(3) !== pat(0)) checked++;
  }
  assert.ok(checked > 20, String(checked));
});

test("格子に乗る・重ならない・小節をまたいで伸ばさない", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const ev = planMusicLane(input({ params: { ...shape, breaks: 0.4 } }, seed));
    ev.forEach((e, i) => {
      assert.equal(e.step % 2, 0);
      assert.ok(e.len >= 1);
      if (ev[i + 1]) assert.ok(e.step + e.len <= ev[i + 1].step);
      assert.ok(Math.floor(e.step / SPB) === Math.floor((e.step + e.len - 1) / SPB));
    });
  }
});

test("層が複数なら、4小節ごとに交代で鳴らす", () => {
  const a = planMusicLane(input({ laneIndex: 0, laneCount: 2 }));
  const b = planMusicLane(input({ laneIndex: 1, laneCount: 2 }));
  assert.ok(a.every((e) => e.step < 4 * SPB));
  assert.ok(b.every((e) => e.step >= 4 * SPB));
  assert.ok(a.length > 0 && b.length > 0);
});

test("音程：動き0なら変えない。上げても、1オクターブだけ（コードを崩さない）", () => {
  assert.ok(planMusicLane(input()).every((e) => e.pitch === 0));
  const pitches = new Set<number>();
  for (let seed = 1; seed <= 30; seed++) {
    for (const e of planMusicLane(input({ params: { ...shape, motion: 1, busy: 1 } }, seed))) pitches.add(e.pitch);
  }
  assert.deepEqual([...pitches].sort((x, y) => x - y), [0, 12]);
});

test("密度を上げると打つ数が増える。同じ種なら同じ", () => {
  const count = (busy: number) => {
    let n = 0;
    for (let seed = 1; seed <= 20; seed++) n += planMusicLane(input({ params: { ...shape, busy } }, seed)).length;
    return n;
  };
  assert.ok(count(1) > count(0));
  assert.deepEqual(planMusicLane(input({}, 7)), planMusicLane(input({}, 7)));
});
