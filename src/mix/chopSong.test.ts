import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { createEmptyLayer, createEmptyPhrase, type Phrase } from "../phrase/types.ts";
import { buildSongPcm, collectSources, planBars, planForSong } from "./chopSong.ts";
import { createEmptySong, type Song } from "./types.ts";
import type { Pcm } from "./audioChop.ts";

function song(id: string, bpm: number, bars: 1 | 2 | 4 = 4, withNotes = true): Phrase {
  const p = createEmptyPhrase(bars, bpm, 4);
  p.id = id;
  p.name = `曲${id}`;
  const l = createEmptyLayer("melody");
  if (withNotes) l.notes = [{ id: `${id}n`, pitch: 60, velocity: 0.8, startBeats: 0, durationBeats: 1 }];
  p.layers.push(l);
  return p;
}

const withSources = (ids: string[]): Song => ({ ...createEmptySong(), materialIds: ids });

test("刻む曲：選んだ順で、音符のある曲だけ", () => {
  const phrases = [song("a", 100), song("b", 90, 4, false), song("c", 150)];
  assert.deepEqual(collectSources(withSources(["c", "b", "a", "zzz"]), phrases).map((p) => p.id), ["c", "a"]);
});

test("計画：曲の長さに合う。メインの曲は、選び直さなければそのまま", () => {
  const phrases = [song("a", 100), song("b", 90)];
  const s = withSources(["a", "b"]);
  s.lengthBars = 16;
  const first = planForSong(s, collectSources(s, phrases), createRng(1), { newBase: true, keepBars: [] })!;
  assert.equal(planBars(first.plan, 4), 16);
  s.plan = first.plan;
  s.baseId = first.baseId;
  for (let seed = 2; seed < 20; seed++) {
    const again = planForSong(s, collectSources(s, phrases), createRng(seed), { newBase: false, keepBars: [] })!;
    assert.equal(again.baseId, first.baseId);
  }
  assert.equal(planForSong(s, [], createEmptyRng(), { newBase: true, keepBars: [] }), null);
});

function createEmptyRng(): () => number {
  return createRng(1);
}

test("長さを変えたあとは、前の計画の固定は使わない", () => {
  const phrases = [song("a", 100)];
  const s = withSources(["a"]);
  s.chop = { busy: 1, breaks: 0.3, size: 0.5, pitch: 0.4 };
  const first = planForSong(s, collectSources(s, phrases), createRng(3), { newBase: true, keepBars: [] })!;
  s.plan = first.plan;
  s.baseId = first.baseId;
  s.lengthBars = 16; // 8 → 16
  const next = planForSong(s, collectSources(s, phrases), createRng(4), { newBase: false, keepBars: [1, 2] })!;
  assert.equal(planBars(next.plan, 4), 16);
});

test("波形：曲のBPM×速さで書き出す。フレーズ自身のBPMは使わない", async () => {
  const phrases = [song("a", 77)]; // フレーズのBPMは77
  const s = withSources(["a"]);
  s.bpm = 128;
  s.lengthBars = 4;
  s.plan = [
    { kind: "play", from: "a", dst: 0, len: 8, src: 0 },
    { kind: "double", from: "a", dst: 8, len: 4, src: 8, rate: 2 },
    { kind: "half", from: "a", dst: 12, len: 4, src: 0, rate: 0.5 },
  ];
  s.baseId = "a";
  const asked: number[] = [];
  const sr = 1000;
  const render = async (_p: Phrase, bpm: number): Promise<Pcm> => {
    asked.push(bpm);
    const n = Math.round((16 * 60 * sr) / bpm); // 4小節＝16拍
    const l = new Float32Array(n).fill(0.1);
    return { l, r: l.slice() };
  };
  const pcm = (await buildSongPcm(s, collectSources(s, phrases), render, sr))!;
  assert.deepEqual([...new Set(asked)].sort((x, y) => x - y), [64, 128, 256]);
  assert.equal(pcm.l.length, Math.round((16 * 60 * sr) / 128));
  assert.equal(await buildSongPcm({ ...s, plan: undefined }, collectSources(s, phrases), render, sr), null);
});
