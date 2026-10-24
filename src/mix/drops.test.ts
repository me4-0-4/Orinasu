import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateDrops, planDrops, renderDrops } from "./drops.ts";

const base = { totalSteps: 16 * 32, stepsPerBar: 16, seed: 7, amount: 0.5, sounds: [{ id: "a", steps: 6 }, { id: "b", steps: 20 }] };

test("同じ種なら同じ場所。種を変えると変わる", () => {
  assert.deepEqual(planDrops(base), planDrops(base));
  const others = [1, 2, 3, 4, 5].map((seed) => JSON.stringify(planDrops({ ...base, seed })));
  assert.ok(new Set(others).size > 1);
});

test("置いた音が鳴っている間は、次を置かない。曲の長さで切る", () => {
  for (let seed = 0; seed < 30; seed++) {
    const drops = planDrops({ ...base, seed, amount: 1 });
    for (let i = 1; i < drops.length; i++) {
      const prev = drops[i - 1];
      const prevSteps = prev.soundId === "a" ? 6 : 20;
      assert.ok(drops[i].step >= prev.step + prevSteps);
    }
    for (const d of drops) assert.ok(d.step + d.len <= base.totalSteps);
  }
});

test("多さ0や音が無いときは置かない。多いほど、たくさん置く", () => {
  assert.deepEqual(planDrops({ ...base, amount: 0 }), []);
  assert.deepEqual(planDrops({ ...base, sounds: [] }), []);
  let few = 0;
  let many = 0;
  for (let seed = 0; seed < 40; seed++) {
    few += planDrops({ ...base, seed, amount: 0.2 }).length;
    many += planDrops({ ...base, seed, amount: 1 }).length;
  }
  assert.ok(many > few);
});

test("区切り（8小節の頭）に置かれやすい", () => {
  const counts = new Map<number, number>();
  for (let seed = 0; seed < 200; seed++) {
    for (const d of planDrops({ ...base, seed, sounds: [{ id: "a", steps: 2 }] })) {
      const bar = d.step / 16;
      if (Number.isInteger(bar)) counts.set(bar % 8, (counts.get(bar % 8) ?? 0) + 1);
    }
  }
  assert.ok((counts.get(0) ?? 0) > (counts.get(1) ?? 0) * 2);
});

test("同じ音が続かない（2つ以上あるとき）", () => {
  for (let seed = 0; seed < 30; seed++) {
    const drops = planDrops({ ...base, seed, amount: 1, sounds: [{ id: "a", steps: 1 }, { id: "b", steps: 1 }] });
    for (let i = 1; i < drops.length; i++) assert.notEqual(drops[i].soundId, drops[i - 1].soundId);
  }
});

test("並べる：置いた所から足す。曲の終わりで切る", () => {
  const pcm = { l: new Float32Array([1, 1, 1]), r: new Float32Array([0.5, 0.5, 0.5]) };
  const out = renderDrops([{ step: 1, soundId: "a", len: 1 }, { step: 3, soundId: "a", len: 1 }, { step: 0, soundId: "x", len: 1 }], new Map([["a", pcm]]), 8, 2);
  assert.deepEqual([...out.l], [0, 0, 1, 1, 1, 0, 1, 1]);
  assert.deepEqual([...out.r], [0, 0, 0.5, 0.5, 0.5, 0, 0.5, 0.5]);
});

test("保存されていた設定を読む", () => {
  assert.equal(migrateDrops(null), undefined);
  assert.deepEqual(migrateDrops({ soundIds: ["a", 1], seed: 3, amount: 5, volume: 9 }), { soundIds: ["a"], amount: 1, seed: 3, volume: 1.5 });
});
