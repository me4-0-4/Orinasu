import { test } from "node:test";
import assert from "node:assert/strict";
import { compSettings } from "./mixStage.ts";

test("コンプ：0なら素通し、1で強く掛かり、音量の補正も増える", () => {
  const off = compSettings(0);
  assert.equal(off.ratio, 1);
  assert.equal(off.makeup, 1);
  const on = compSettings(1);
  assert.ok(on.threshold < off.threshold);
  assert.ok(on.ratio > 5 && on.ratio <= 20);
  assert.ok(on.makeup > 1);
  assert.deepEqual(compSettings(5), compSettings(1)); // 範囲外は丸める
});
