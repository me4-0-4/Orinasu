import { test } from "node:test";
import assert from "node:assert/strict";
import { quantizeBeat, quantizeGrids } from "./quantize.ts";

test("8分グリッドで最寄りのマス目に丸める", () => {
  assert.equal(quantizeBeat(0.1, 0.5), 0);
  assert.equal(quantizeBeat(0.3, 0.5), 0.5);
  assert.equal(quantizeBeat(0.26, 0.5), 0.5);
  assert.equal(quantizeBeat(1.74, 0.5), 1.5);
});

test("16分グリッド", () => {
  assert.equal(quantizeBeat(0.1, 0.25), 0);
  assert.equal(quantizeBeat(0.2, 0.25), 0.25);
});

test("3連符グリッド", () => {
  const third = quantizeGrids.find((g) => g.label === "3連符")!.beats;
  assert.equal(quantizeBeat(0.2, third), Math.round(0.2 / third) * third);
  assert.ok(Math.abs(quantizeBeat(1 / 3, third) - 1 / 3) < 1e-9);
});

test("グリッド0（オフ相当）は元の値をそのまま返す", () => {
  assert.equal(quantizeBeat(1.234, 0), 1.234);
});
