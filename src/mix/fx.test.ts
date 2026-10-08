import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_FX, applyDrive, delaySeconds, fxIsOff, highCutHz, lowCutHz, reverbSeconds } from "./fx.ts";

test("エフェクトの数字：長さ・間隔・削る周波数", () => {
  assert.ok(Math.abs(reverbSeconds(0) - 0.3) < 1e-9);
  assert.ok(Math.abs(reverbSeconds(1) - 6) < 1e-9);
  assert.equal(delaySeconds("1/8d", 120), 0.375);
  assert.equal(delaySeconds("1/4", 60), 1);
  assert.equal(lowCutHz(0), 20);
  assert.ok(Math.abs(lowCutHz(1) - 2000) < 1e-6);
  assert.equal(highCutHz(0), 20000);
  assert.ok(Math.abs(highCutHz(1) - 300) < 1e-6);
});

test("何も掛けない設定は、何もしない", () => {
  assert.ok(fxIsOff(NO_FX));
  assert.ok(fxIsOff(undefined));
  assert.ok(!fxIsOff({ ...NO_FX, delay: 0.2 }));
  const pcm = { l: Float32Array.from([0.1, 0.2]), r: Float32Array.from([0.1, 0.2]) };
  assert.equal(applyDrive(pcm, 0, 0), pcm);
});

test("歪みは大きい音を丸め、音質下げは値を止めて段々にする", () => {
  const ramp = Float32Array.from({ length: 64 }, (_, i) => i / 64);
  const driven = applyDrive({ l: ramp, r: ramp }, 1, 0);
  assert.ok(driven.l[63] < 0.3); // 丸めて、音量をそろえる
  assert.ok(driven.l[8] / driven.l[1] < 8); // 小さい音ほど持ち上がる
  const crushed = applyDrive({ l: ramp, r: ramp }, 0, 1);
  assert.equal(crushed.l[1], crushed.l[0]); // 値を止める
  assert.ok(new Set(crushed.l).size < 10);
});
