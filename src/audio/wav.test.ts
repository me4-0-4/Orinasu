import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav } from "./wav.ts";

test("WAV：ヘッダと、16bitステレオの並び", () => {
  const wav = encodeWav({ l: Float32Array.from([0, 1, -1, 0.5]), r: Float32Array.from([0, -1, 1, 0]) }, 44100);
  const view = new DataView(wav.buffer);
  const tag = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(tag(12), "fmt ");
  assert.equal(view.getUint16(22, true), 2); // ステレオ
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(tag(36), "data");
  assert.equal(view.getUint32(40, true), 4 * 4); // 4フレーム×4バイト
  assert.equal(wav.length, 44 + 16);
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(view.getInt16(44 + 4, true), 32767); // 左の2番目＝1.0
  assert.equal(view.getInt16(44 + 6, true), -32767); // 右の2番目＝-1.0
  assert.equal(view.getInt16(44 + 8, true), -32767);
});
