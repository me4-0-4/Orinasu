import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTail, repeatPcm } from "./loopFold.ts";

test("はみ出した余韻を頭に重ねる（1周より長ければ何周ぶんでも）", () => {
  const l = Float32Array.from([1, 2, 3, 10, 20, 30, 100]);
  const out = foldTail(l, l.slice(), 3);
  assert.deepEqual([...out.l], [111, 22, 33]);
});

test("くり返し：n回つなげる", () => {
  const p = { l: Float32Array.from([1, 2]), r: Float32Array.from([3, 4]) };
  assert.deepEqual([...repeatPcm(p, 3).l], [1, 2, 1, 2, 1, 2]);
  assert.deepEqual([...repeatPcm(p, 0).r], [3, 4]);
});
