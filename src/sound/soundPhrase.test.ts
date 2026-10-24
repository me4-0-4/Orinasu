import { test } from "node:test";
import assert from "node:assert/strict";
import { isSoundPhraseId, soundBars, soundPhrase } from "./soundPhrase.ts";
import { noteRegion } from "./sampler.ts";
import type { StoredSound } from "./types.ts";

const base: StoredSound = {
  id: "s1",
  name: "ループ",
  mime: "audio/wav",
  bytes: 1,
  durationSec: 4.5,
  channels: 2,
  sampleRate: 44100,
  peaks: [],
  createdAt: 1,
  updatedAt: 10,
};

test("テンポの無い音は材料にしない", () => {
  assert.equal(soundPhrase(base), null);
  assert.equal(soundBars(base), null);
});

test("1拍目から N 小節を1音で鳴らすフレーズになる", () => {
  // 120BPM、1拍目 0.5秒 → 残り 4秒 ＝ 2小節
  const p = soundPhrase({ ...base, bpm: 120, downbeatSec: 0.5, blob: new Blob(["x"]) })!;
  assert.ok(p);
  assert.equal(isSoundPhraseId(p.id), true);
  assert.equal(p.lengthBars, 2);
  assert.equal(p.updatedAt, 11);
  const layer = p.layers[0];
  assert.equal(layer.notes.length, 1);
  assert.equal(layer.notes[0].durationBeats, 8);
  const r = noteRegion(layer.sampler!, layer.notes[0].pitch, 120);
  assert.ok(Math.abs(r.start * 4.5 - 0.5) < 1e-3);
  assert.equal(r.end, 1);
  assert.equal(r.rate, 1);
  // 曲のテンポが速いと、そのぶん速く鳴らす
  assert.equal(noteRegion(layer.sampler!, layer.notes[0].pitch, 180).rate, 1.5);
});

test("小節の後ろに余りがあれば、そこで切る", () => {
  // 1拍目 0、120BPM で 4.5秒＝2.25小節 → 2小節（4秒）で切る
  const p = soundPhrase({ ...base, bpm: 120, downbeatSec: 0 })!;
  assert.equal(p.lengthBars, 2);
  const s = p.layers[0].sampler!;
  const r = noteRegion(s, p.layers[0].notes[0].pitch, 120);
  assert.equal(r.start, 0);
  assert.ok(Math.abs(r.end * 4.5 - 4) < 1e-3);
});
