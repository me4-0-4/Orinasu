import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { createEmptyLayer, createEmptyPhrase, type Phrase } from "../phrase/types.ts";
import { applySeeds, bedEvents, buildCollage, collectSources, hasDrums, pickDrum, rerollLanes, seedSnapshot, syncLanes } from "./collageSong.ts";
import { createEmptySong, type Song } from "./types.ts";
import { newPlugin, type FxPlugin } from "./fx.ts";
import { transposeSemitones } from "./keySync.ts";
import type { Pcm } from "./pcm.ts";

function phrase(id: string, bpm: number, tonic = 60, withNotes = true): Phrase {
  const p = createEmptyPhrase(4, bpm, 4);
  p.id = id;
  p.name = `曲${id}`;
  const l = createEmptyLayer("melody");
  if (withNotes) l.notes = [0, 4, 7, 12].map((d, i) => ({ id: `${id}${i}`, pitch: tonic + d, velocity: 0.8, startBeats: i * 4, durationBeats: 2 }));
  p.layers.push(l);
  return p;
}

let n = 0;
const seq = () => ++n;

test("刻む曲：選んだ順で、音符のある曲だけ", () => {
  const phrases = [phrase("a", 100), phrase("b", 90, 60, false), phrase("c", 150)];
  assert.deepEqual(collectSources({ materialIds: ["c", "b", "a", "z"] }, phrases).map((p) => p.id), ["c", "a"]);
});

test("層：選んだ曲1つにつき1本。増えたら足し、外したら消す。固定した層は振り直さない", () => {
  let lanes = syncLanes({ materialIds: ["a"], lanes: undefined }, seq);
  assert.equal(lanes.length, 1);
  lanes = syncLanes({ materialIds: ["b", "a"], lanes }, seq);
  assert.deepEqual(lanes.map((l) => l.phraseId), ["b", "a"]);
  lanes[0].locked = true;
  const before = structuredClone(lanes);
  const all = rerollLanes(lanes, "all", seq);
  assert.deepEqual(all[0], before[0]);
  assert.notEqual(all[1].cutSeed, before[1].cutSeed);
  const rhythm = rerollLanes(lanes, "rhythm", seq);
  assert.equal(rhythm[1].cutSeed, before[1].cutSeed);
  assert.notEqual(rhythm[1].rhythmSeed, before[1].rhythmSeed);
  assert.deepEqual(syncLanes({ materialIds: ["a"], lanes }, seq).map((l) => l.phraseId), ["a"]);
});

test("曲を作る：曲のBPMで書き出す（フレーズのBPMは使わない）。長さは曲の長さ、層は選んだ曲の数", async () => {
  const phrases = [phrase("a", 77), phrase("b", 140, 62)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b"], bpm: 128, lengthBars: 4 };
  song.lanes = syncLanes(song, seq);
  const sr = 2000;
  const asked: number[] = [];
  const render = async (_p: Phrase, bpm: number): Promise<Pcm> => {
    asked.push(bpm);
    const len = Math.round((16 * 60 * sr) / bpm);
    const l = new Float32Array(len).map((_, i) => (i % 400 < 20 ? 0.5 : 0.01));
    return { l, r: l.slice() };
  };
  const result = (await buildCollage(song, phrases, render, sr))!;
  assert.deepEqual([...new Set(asked)], [128]);
  assert.equal(result.pcm.l.length, Math.round(4 * 4 * (60 / 128) * sr));
  assert.equal(result.lanes.length, 2);
  assert.equal(result.totalSteps, 64);
  assert.equal(result.keyName, "C");
  assert.equal(await buildCollage({ ...song, lanes: undefined }, phrases, render, sr), null);
});

test("調ずらし：いちばん近い向きへ", () => {
  assert.equal(transposeSemitones({ tonic: 0, mode: "major" }, { tonic: 2, mode: "major" }), 2);
  assert.equal(transposeSemitones({ tonic: 0, mode: "major" }, { tonic: 7, mode: "major" }), -5);
});

test("同じ種なら同じ曲になる", async () => {
  const phrases = [phrase("a", 100)];
  const song: Song = { ...createEmptySong(), materialIds: ["a"] };
  song.lanes = syncLanes(song, () => Math.floor(createRng(9)() * 1e9));
  const render = async (): Promise<Pcm> => {
    const l = new Float32Array(4000).map((_, i) => Math.sin(i / 7) * (i % 500 < 50 ? 1 : 0.1));
    return { l, r: l.slice() };
  };
  const a = (await buildCollage(song, phrases, render, 1000))!;
  const b = (await buildCollage(song, phrases, render, 1000))!;
  assert.deepEqual(a.lanes[0].events, b.lanes[0].events);
});

const steadyRender = async (): Promise<Pcm> => {
  const l = new Float32Array(4000).map((_, i) => Math.sin(i / 7) * (i % 500 < 50 ? 1 : 0.1));
  return { l, r: l.slice() };
};

test("層ごとのずらし：密度を上げた層だけ、打つ数が増える。ほかの層はそのまま", async () => {
  const phrases = [phrase("a", 100), phrase("b", 100, 62)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b"] };
  song.params = { ...song.params, turns: "swap" }; // 混ぜるときは1つのリズムなので、層ごとのずらしは効かない
  song.lanes = syncLanes(song, seq);
  const before = (await buildCollage(song, phrases, steadyRender, 1000))!;
  song.lanes[0] = { ...song.lanes[0], shift: { busy: 0.4 } };
  const after = (await buildCollage(song, phrases, steadyRender, 1000))!;
  assert.ok(after.lanes[0].events.length > before.lanes[0].events.length);
  assert.deepEqual(after.lanes[1].events, before.lanes[1].events);
});

test("ミュートした層は鳴らない（線には出る）", async () => {
  const phrases = [phrase("a", 100)];
  const song: Song = { ...createEmptySong(), materialIds: ["a"] };
  song.params = { ...song.params, sfx: 0 }; // SFXは層と関係なく鳴るので、ここでは外す
  song.lanes = syncLanes(song, seq);
  song.lanes[0].muted = true;
  const out = (await buildCollage(song, phrases, steadyRender, 1000))!;
  assert.ok(out.pcm.l.every((x) => x === 0));
  assert.ok(out.lanes[0].muted && out.lanes[0].events.length > 0);
});

test("ひとつ戻すは、種だけを戻す（形のずらし・固定はそのまま）", () => {
  const lanes = syncLanes({ materialIds: ["a", "b"], lanes: undefined }, seq);
  const snap = seedSnapshot(lanes);
  const changed = rerollLanes(lanes, "all", seq).map((l, i) => (i === 0 ? { ...l, shift: { busy: 0.2 }, locked: true } : l));
  const back = applySeeds(changed, snap);
  assert.equal(back[0].cutSeed, lanes[0].cutSeed);
  assert.equal(back[1].orderSeed, lanes[1].orderSeed);
  assert.deepEqual(back[0].shift, { busy: 0.2 });
  assert.equal(back[0].locked, true);
});

test("音楽モード：ミュートした層があっても、交代はミュートしていない層だけで回す（無音の4小節ができない）", async () => {
  const phrases = [phrase("a", 100), phrase("b", 100, 62)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b"], lengthBars: 8 };
  song.lanes = syncLanes(song, seq);
  song.lanes[1].muted = true;
  const out = (await buildCollage(song, phrases, steadyRender, 1000))!;
  const a = out.lanes[0].events;
  assert.ok(a.some((e) => e.step < 64) && a.some((e) => e.step >= 64), "鳴っている層が、前半も後半も打つ");
});

function drumPhrase(id: string): Phrase {
  const p = phrase(id, 100);
  const d = createEmptyLayer("drums");
  d.notes = [0, 1, 2, 3].map((b, i) => ({ id: `${id}d${i}`, pitch: 36, velocity: 0.8, startBeats: b, durationBeats: 0.25 }));
  p.layers.push(d);
  return p;
}

test("下地：決めていなければ、ドラムのある最初の材料。null なら無し", () => {
  const phrases = [phrase("a", 100), drumPhrase("b"), drumPhrase("c")];
  assert.equal(pickDrum({ materialIds: ["a", "c", "b"] }, phrases), "c");
  assert.equal(pickDrum({ materialIds: ["a"] }, phrases), null);
  assert.equal(pickDrum({ materialIds: ["c"], drumId: "b" }, phrases), "b"); // 材料でない曲のドラムも選べる
  assert.equal(pickDrum({ materialIds: ["c"], drumId: null }, phrases), null);
  assert.ok(hasDrums(phrases[1]) && !hasDrums(phrases[0]));
});

test("下地：選んだ曲のドラムだけを書き出して、刻まずに最後まで重ねる。刻む材料と同じ曲でもいい", async () => {
  const phrases = [drumPhrase("a")];
  const song: Song = { ...createEmptySong(), materialIds: ["a"], bpm: 120, lengthBars: 8, drumId: "a" };
  song.lanes = syncLanes(song, seq);
  song.lanes[0].muted = true; // 刻んだ音を消して、下地だけを聞く
  const sr = 2000;
  const asked: { drumsOnly?: boolean }[] = [];
  const render = async (_p: Phrase, bpm: number, opts: { drumsOnly?: boolean }): Promise<Pcm> => {
    asked.push(opts);
    const len = Math.round((16 * 60 * sr) / bpm);
    const l = new Float32Array(len).fill(opts.drumsOnly ? 0.2 : 0.5);
    return { l, r: l.slice() };
  };
  const result = (await buildCollage(song, phrases, render, sr))!;
  assert.ok(asked.some((o) => o.drumsOnly) && asked.some((o) => !o.drumsOnly));
  const last = result.pcm.l[result.pcm.l.length - 1];
  assert.ok(last > 0.05, "最後まで下地が鳴る");
  assert.equal(result.bed?.phraseId, "a");
  assert.equal(result.bed?.events.length, 4 * 2); // 4小節のフレーズを2回
  assert.deepEqual(bedEvents(phrases[0], 16).map((e) => e.step), [0, 4, 8, 12]);
});

test("混ぜる：2つの曲で1つのリズム。同じ所で両方は鳴らず、ミュートした層には番を回さない", async () => {
  const phrases = [phrase("a", 100), phrase("b", 100, 62), phrase("c", 100, 64)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b", "c"], lengthBars: 16 };
  song.lanes = syncLanes(song, seq);
  song.lanes[2].muted = true;
  const r = (await buildCollage(song, phrases, steadyRender, 1000))!;
  const steps = r.lanes.slice(0, 2).flatMap((l) => l.events.map((e) => e.step));
  assert.equal(new Set(steps).size, steps.length);
  assert.ok(r.lanes[0].events.length > 0 && r.lanes[1].events.length > 0);
  assert.equal(r.lanes[2].events.length, 0);
});

test("エフェクト：FXのあるトラック（層・下地・マスター）とテイクFXの断片にだけ掛ける。無ければリバーブは呼ばない", async () => {
  const phrases = [drumPhrase("a"), phrase("b", 100, 62)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b"], drumId: "a" };
  song.params = { ...song.params, pad: 0, sfx: 0 };
  song.lanes = syncLanes(song, seq);
  const tagged = (size: number): FxPlugin => newPlugin("reverb", { amount: 1, size });
  const track = (size: number) => ({ chain: [tagged(size)], envelopes: [] });
  song.lanes[1].fx = track(0.1);
  song.fx = { master: track(0.3), bed: track(0.2), pad: { chain: [], envelopes: [] } };
  const called: number[] = [];
  const reverb = async (pcm: Pcm, seconds: number): Promise<Pcm> => {
    called.push(Math.round(seconds * 100) / 100);
    return pcm;
  };
  const first = (await buildCollage(song, phrases, steadyRender, 1000, reverb))!;
  // 0.3·20^size 秒：層0.1→0.40、下地0.2→0.55、マスター0.3→0.74
  assert.deepEqual(called.sort(), [0.4, 0.55, 0.74]);
  // テイクFX：層Aの最初の断片だけ
  called.length = 0;
  song.fx = { master: { chain: [], envelopes: [] }, bed: { chain: [], envelopes: [] }, pad: { chain: [], envelopes: [] } };
  delete song.lanes[1].fx;
  const step = first.lanes[0].events[0].step;
  song.lanes[0].takes = [{ step, chain: [tagged(0.4)] }];
  await buildCollage(song, phrases, steadyRender, 1000, reverb);
  assert.deepEqual(called, [0.99]); // 0.3·20^0.4 ≈ 0.99
  called.length = 0;
  delete song.lanes[0].takes;
  await buildCollage(song, phrases, steadyRender, 1000, reverb);
  assert.deepEqual(called, []);
});
