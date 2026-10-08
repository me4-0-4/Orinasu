import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { musicSlices, musicSlotSteps, planMusicLane, type MusicLaneInput } from "./musicChop.ts";

const SPB = 16; // 1小節＝16分×16
const shape = { busy: 0.6, breaks: 0, onBeat: 0, size: 0.5, motion: 0, hold: 1, crisp: 0, pan: 0, fx: 0 };
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
      const bar = Math.floor(e.step / SPB);
      if (bar % 4 !== 3 && bar !== 7) assert.equal(e.step % 2, 0); // フィルの「ちりばめ」は16分ごと

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

test("音程：動き0なら変えない。上げても、オクターブか、フィルの終わりの階段（-4〜-1）だけ", () => {
  assert.ok(planMusicLane(input()).every((e) => e.pitch === 0));
  const pitches = new Set<number>();
  let stairs = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const ev = planMusicLane(input({ params: { ...shape, motion: 1, busy: 1 } }, seed));
    for (const e of ev) pitches.add(e.pitch);
    // 階段：-n, ..., -1 と1つずつ上がって小節の終わりへ
    for (let i = 1; i < ev.length; i++) if (ev[i - 1].pitch === -2 && ev[i].pitch === -1) stairs++;
  }
  for (const p of pitches) assert.ok([-4, -3, -2, -1, 0, 12].includes(p), String(p));
  assert.ok(stairs > 0);
});

test("並べ方は「切ったまま」か「繰り返す」だけ（フィル以外）", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const ev = planMusicLane(input({ totalSteps: 4 * SPB, params: { ...shape, busy: 1 } }, seed));
    const body = ev.filter((e) => Math.floor(e.step / SPB) < 3);
    body.forEach((e, i) => {
      const asCut = e.slice % slots(2) === (e.step % SPB) / 2;
      const repeat = i > 0 && body[i - 1].slice === e.slice;
      assert.ok(asCut || repeat, `seed ${seed} step ${e.step}`);
    });
  }
});

test("なめらか／キレ：キレ0なら本体の小節は隙間なし（鳴らす割合1）。キレ1なら隙間を入れて左右に振る", () => {
  const smooth = planMusicLane(input({ totalSteps: 4 * SPB }, 3)).filter((e) => e.step < 3 * SPB);
  assert.ok(smooth.every((e) => e.gate === 1 && !e.pan));
  const crisp = planMusicLane(input({ totalSteps: 4 * SPB, params: { ...shape, crisp: 1, pan: 1 } }, 3)).filter((e) => e.step < 3 * SPB);
  assert.ok(crisp.every((e) => (e.gate ?? 1) < 1));
  assert.ok(crisp.some((e) => (e.pan ?? 0) > 0) && crisp.some((e) => (e.pan ?? 0) < 0));
});

test("パン：左右はなるべく均等（1小節の中で、片側に偏らない）", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const ev = planMusicLane(input({ params: { ...shape, crisp: 1, pan: 0.8, busy: 1 } }, seed));
    for (let b = 0; b < 8; b++) {
      const sum = ev.filter((e) => Math.floor(e.step / SPB) === b).reduce((a, e) => a + (e.pan ?? 0), 0);
      assert.ok(Math.abs(sum) <= 0.8 * 2 + 1e-9, `seed ${seed} bar ${b} sum ${sum}`);
    }
  }
});

test("フィル：後ろ半分を同じ断片で埋める（連打かちりばめ）。エフェクト1なら、フィルにエフェクトが掛かる。0なら無い", () => {
  const kinds = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const ev = planMusicLane(input({ totalSteps: 4 * SPB, params: { ...shape, fx: 1 } }, seed));
    const tail = ev.filter((e) => e.step >= 3 * SPB + SPB / 2);
    assert.ok(tail.length > 0);
    assert.equal(new Set(tail.map((e) => e.slice)).size, 1, "同じ断片");
    for (const e of tail) {
      assert.ok(e.fx, "エフェクトが付く");
      kinds.add(e.fx!.kind);
      assert.ok(e.fx!.a >= 0 && e.fx!.b <= 1 && e.fx!.a < e.fx!.b);
    }
    assert.ok(ev.filter((e) => e.step < 3 * SPB).every((e) => !e.fx), "フィル以外には掛けない");
  }
  assert.ok(kinds.size >= 4, [...kinds].join(","));
  for (let seed = 1; seed <= 20; seed++) assert.ok(planMusicLane(input({}, seed)).every((e) => !e.fx));
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

test("強さ：小節の頭がいちばん強く、裏ほど弱い。フィルの終わりに向けて強くなる", () => {
  const ev = planMusicLane(input({ totalSteps: 8 * SPB, slotSteps: 1 }, 3));
  for (const e of ev.filter((e) => e.step % SPB === 0)) assert.equal(e.vel ?? 1, 1);
  for (const e of ev.filter((e) => e.gate === undefined || e.gate === 1)) {
    if (e.step % 2 === 1) assert.ok((e.vel ?? 1) < 0.9);
  }
});

test("盛り上げ：8小節の後ろ4小節は前の4小節より打つ数が多く、8小節目のフィルは長い（前から始まる）", () => {
  let denser = 0;
  let longer = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const ev = planMusicLane(input({ slotSteps: 1 }, seed));
    const count = (from: number, to: number) => ev.filter((e) => e.step >= from * SPB && e.step < to * SPB).length;
    if (count(4, 7) > count(0, 3)) denser++;
    // フィルの所（gate 0.9 か ちりばめ）の始まり
    const fillStart = (bar: number) => {
      const f = ev.filter((e) => Math.floor(e.step / SPB) === bar && e.gate !== undefined && e.gate !== 1 && e.gate !== 0.65);
      return f.length ? Math.min(...f.map((e) => e.step % SPB)) : SPB;
    };
    if (fillStart(7) < fillStart(3)) longer++;
  }
  assert.ok(denser >= 15, `詰めた: ${denser}/20`);
  assert.ok(longer >= 15, `長いフィル: ${longer}/20`);
});

test("掛け合い：2本の層は同じ所で鳴らない。前半2拍と後半2拍を分け合い、前半の音は後半に食い込まない", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const a = planMusicLane(input({ laneIndex: 0, laneCount: 2, turns: "call" }, seed));
    const b = planMusicLane(input({ laneIndex: 1, laneCount: 2, turns: "call" }, seed + 50));
    const owner = new Map<number, string>();
    for (const [name, ev] of [["a", a], ["b", b]] as const) {
      for (const e of ev) {
        const half = Math.floor(e.step / (SPB / 2));
        assert.ok(!owner.has(half) || owner.get(half) === name, `半小節 ${half} を両方が鳴らした`);
        owner.set(half, name);
        assert.ok(Math.floor((e.step + e.len - 1) / (SPB / 2)) === half, "前半から後半へ伸びた");
      }
    }
    // 1小節目：前半はa、後半はb
    assert.ok(a.some((e) => e.step < SPB / 2));
    assert.ok(b.some((e) => e.step >= SPB / 2 && e.step < SPB));
  }
});
