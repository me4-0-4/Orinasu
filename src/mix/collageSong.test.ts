import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../theory/rng.ts";
import { createEmptyLayer, createEmptyPhrase, type Phrase } from "../phrase/types.ts";
import { applySeeds, bedEvents, buildCollage, balanceFader, buildStems, collectSources, faderOf, mixdown, panGains, songFaders, sumStems, hasDrums, pickDrum, rerollLanes, seedSnapshot, syncLanes } from "./collageSong.ts";
import { createEmptySong, migrateSong, type Song } from "./types.ts";
import { newPlugin, type FxPlugin } from "./fx.ts";
import { newGroup } from "./groups.ts";
import { BuildCache } from "./buildCache.ts";
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

test("ミュートしても、ほかのトラックの打つ内容は変わらない（交代・掛け合い・混ぜるのどれでも）。ミュートした層の番は無音になる", async () => {
  const phrases = [phrase("a", 100), phrase("b", 100, 62), phrase("c", 100, 64)];
  for (const turns of ["swap", "call", "mix"] as const) {
    const song: Song = { ...createEmptySong(), materialIds: ["a", "b", "c"], lengthBars: 8 };
    song.params = { ...song.params, turns };
    song.lanes = syncLanes(song, seq);
    const before = (await buildCollage(song, phrases, steadyRender, 1000))!;
    song.lanes[1].muted = true;
    const after = (await buildCollage(song, phrases, steadyRender, 1000))!;
    for (const i of [0, 2]) assert.deepEqual(after.lanes[i].events, before.lanes[i].events, `${turns}：層${i}は変わらない`);
    assert.deepEqual(after.lanes[1].events, before.lanes[1].events, `${turns}：ミュートした層の打つ予定も同じ（線には出る）`);
    assert.ok(after.pcm.l.some((v) => v !== 0), `${turns}：ほかの層は鳴る`);
  }
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

test("混ぜる：全部の曲で1つのリズム。同じ所で2つは鳴らない。ミュートした層の打つ所は、無音のまま残る", async () => {
  const phrases = [phrase("a", 100), phrase("b", 100, 62), phrase("c", 100, 64)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b", "c"], lengthBars: 16 };
  song.lanes = syncLanes(song, seq);
  song.lanes[2].muted = true;
  const r = (await buildCollage(song, phrases, steadyRender, 1000))!;
  const steps = r.lanes.flatMap((l) => l.events.map((e) => e.step));
  assert.equal(new Set(steps).size, steps.length);
  assert.ok(r.lanes.every((l) => l.events.length > 0), "3つとも番がある（ミュートした層にも）");
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

test("グループ：ミュートしたグループの断片は鳴らない。グループのFXは、そのグループの断片にだけ掛かる", async () => {
  const phrases = [phrase("a", 100), phrase("b", 100, 62)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b"] };
  song.params = { ...song.params, pad: 0, sfx: 0 };
  song.fx = { master: { chain: [], envelopes: [] }, bed: { chain: [], envelopes: [] }, pad: { chain: [], envelopes: [] } };
  song.lanes = syncLanes(song, seq);
  const first = (await buildCollage(song, phrases, steadyRender, 1000))!;
  const a = first.lanes[0].events.slice(0, 2).map((e) => ({ phraseId: "a", step: e.step }));
  const b = first.lanes[1].events.slice(0, 1).map((e) => ({ phraseId: "b", step: e.step }));
  song.groups = [{ ...newGroup([...a, ...b], []), muted: true }];
  const muted = (await buildCollage(song, phrases, steadyRender, 1000))!;
  assert.deepEqual(muted.lanes[0].events.map((e) => e.step), first.lanes[0].events.map((e) => e.step)); // 表示には残る
  // グループFX：リバーブを呼ぶのは、グループの断片があるトラックごとに1回
  song.groups = [{ ...newGroup([...a, ...b], []), fx: [newPlugin("reverb", { amount: 1 })] }];
  let calls = 0;
  await buildCollage(song, phrases, steadyRender, 1000, async (pcm) => (calls++, pcm));
  assert.equal(calls, 2);
});

test("テイクFX：短く作っても、曲全体で作ったのと同じ位置・同じ音になる", async () => {
  const phrases = [phrase("a", 100)];
  const song: Song = { ...createEmptySong(), materialIds: ["a"], lengthBars: 8 };
  song.params = { ...song.params, pad: 0, sfx: 0, pump: 0 };
  song.fx = { master: { chain: [], envelopes: [] }, bed: { chain: [], envelopes: [] }, pad: { chain: [], envelopes: [] } };
  song.lanes = syncLanes(song, seq);
  const base = (await buildCollage(song, phrases, steadyRender, 1000))!;
  const ev = base.lanes[0].events[3];
  // ほとんど何もしないFX（ごく弱い音質下げ）なら、テイクFXを付けても音はほぼ変わらない（位置がずれていれば大きく違う）
  song.lanes[0].takes = [{ step: ev.step, chain: [newPlugin("crush", { amount: 0.02 })] }];
  const withTake = (await buildCollage(song, phrases, steadyRender, 1000, async (p) => p))!;
  let diff = 0;
  for (let i = 0; i < base.pcm.l.length; i++) diff = Math.max(diff, Math.abs(base.pcm.l[i] - withTake.pcm.l[i]));
  assert.ok(diff < 1e-3, `違い ${diff}`);
});

test("使い回し：同じ入力なら前と同じ波形。ミュートしても、変わっていないトラックは作り直さない", async () => {
  const phrases = [phrase("a", 100), phrase("b", 120, 62)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b"], bpm: 120, lengthBars: 4 };
  song.lanes = syncLanes(song, seq);
  song.lanes[1] = { ...song.lanes[1], fx: { chain: [newPlugin("drive", { amount: 0.5 })], envelopes: [] } };
  const sr = 2000;
  const pcms = new Map<string, Pcm>();
  const render = async (p: Phrase, bpm: number): Promise<Pcm> => {
    const key = `${p.id}|${bpm}`;
    if (!pcms.has(key)) {
      const len = Math.round((16 * 60 * sr) / bpm);
      const l = new Float32Array(len).map((_, i) => (i % 400 < 20 ? 0.5 : 0.01));
      pcms.set(key, { l, r: l.slice() });
    }
    return pcms.get(key)!;
  };
  const reverb = async (pcm: Pcm): Promise<Pcm> => pcm;
  const cache = new BuildCache();
  const plain = (await buildCollage(song, phrases, render, sr, reverb))!;
  const first = (await buildCollage(song, phrases, render, sr, reverb, cache))!;
  const again = (await buildCollage(song, phrases, render, sr, reverb, cache))!;
  assert.deepEqual(first.pcm.l, plain.pcm.l, "使い回しの有無で、結果は同じ");
  assert.deepEqual(again.pcm.l, first.pcm.l);
  const sizeBefore = cache.size;
  const muted = structuredClone(song);
  muted.lanes![0].muted = true;
  const viaCache = (await buildCollage(muted, phrases, render, sr, reverb, cache))!;
  const direct = (await buildCollage(muted, phrases, render, sr, reverb))!;
  assert.deepEqual(viaCache.pcm.l, direct.pcm.l, "ミュートしても、使い回しの有無で結果は同じ");
  // ほかのトラックの打つ内容は変わらないので、FXのあるトラックは使い回される（増えるのは、ミュートした層と、伸ばしだけ）
  assert.ok(cache.size - sizeBefore <= 2, `増えたのは ${cache.size - sizeBefore} 個`);
});

test("使い回しの入れ物：上限を超えたら古いものから捨てる。使ったものは残る", async () => {
  const cache = new BuildCache(2);
  let made = 0;
  const make = (v: number) => () => {
    made++;
    return v;
  };
  await cache.getOrCompute("a", make(1));
  await cache.getOrCompute("b", make(2));
  await cache.getOrCompute("a", make(1)); // a を使った（新しい側へ）
  await cache.getOrCompute("c", make(3)); // b が捨てられる
  assert.equal(made, 3);
  await cache.getOrCompute("a", make(1));
  assert.equal(made, 3);
  await cache.getOrCompute("b", make(2));
  assert.equal(made, 4);
});

test("ステム：トラックごと（伸ばしも曲ごと）。ミュート・音量はフェーダーで、作り直さなくても、最初から設定した曲と同じ音になる", async () => {
  const phrases = [drumPhrase("a"), phrase("b", 100, 62), phrase("c", 100, 64)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b", "c"], lengthBars: 4, bpm: 120 };
  song.lanes = syncLanes(song, seq);
  const sr = 2000;
  const set = (await buildStems(song, phrases, steadyRender, sr))!;
  assert.deepEqual(set.stems.filter((s) => s.kind === "track").map((s) => s.phraseId), ["a", "b", "c"]);
  assert.ok(set.stems.some((s) => s.kind === "bed") && set.stems.some((s) => s.kind === "sfx"));
  assert.ok(set.stems.filter((s) => s.kind === "pad").every((s) => s.phraseId !== undefined));
  assert.deepEqual(set.faders, songFaders(song));
  assert.deepEqual([set.faders.a, set.faders.b, set.faders.c], [1, 1, 1]);
  assert.deepEqual(Object.keys(set.faders).filter((k) => k.startsWith("@")).sort(), ["@bed", "@master", "@pad", "@sfx"]);
  assert.equal(new Set(set.stems.map((s) => s.pcm.l.length)).size, 1, "全部同じ長さ（くり返すとき、ずれない）");

  // 最初からミュート／音量を設定した曲と、ステムにフェーダーを掛けた結果は、同じ
  const muted = structuredClone(song);
  muted.lanes![1].muted = true;
  muted.lanes![2].volume = 0.4;
  const direct = (await buildCollage(muted, phrases, steadyRender, sr))!;
  const viaFaders = await mixdown(set, undefined, { ...set.faders, a: 1, b: 0, c: 0.4 });
  assert.equal(viaFaders.l.length, direct.pcm.l.length);
  let max = 0;
  for (let i = 0; i < viaFaders.l.length; i++) max = Math.max(max, Math.abs(viaFaders.l[i] - direct.pcm.l[i]));
  assert.ok(max < 1e-6, `差 ${max}`);

  // 全部ミュートしても、下地と効果音は残る。フェーダーが1のものだけで足している
  const bedAndSfx = sumStems(set, { ...set.faders, a: 0, b: 0, c: 0 });
  assert.ok(bedAndSfx.l.some((x) => x !== 0));
  assert.deepEqual([faderOf({}), faderOf({ muted: true, volume: 2 }), faderOf({ volume: 0.5 })], [1, 0, 0.5]);
});

test("チャンネルのフェーダー：ドラムループの音量・パッドの量・効果音の量は、作り直さなくても、最初から設定した曲と同じ音になる。0なら、そのぶんは鳴らない", async () => {
  const phrases = [drumPhrase("a"), phrase("b", 100, 62)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b"], lengthBars: 8, bpm: 120 };
  song.params = { ...song.params, pad: 0.5, sfx: 0.6, bedVolume: 1 };
  song.lanes = syncLanes(song, seq);
  const sr = 2000;
  const set = (await buildStems(song, phrases, steadyRender, sr))!;
  const tweaked = structuredClone(song);
  tweaked.params = { ...tweaked.params, pad: 0.2, sfx: 0.1, bedVolume: 0.3 };
  const direct = (await buildCollage(tweaked, phrases, steadyRender, sr))!;
  const via = await mixdown(set, undefined, songFaders(tweaked));
  let max = 0;
  for (let i = 0; i < via.l.length; i++) max = Math.max(max, Math.abs(via.l[i] - direct.pcm.l[i]));
  assert.ok(max < 1e-6, `差 ${max}`);
  // 0にすれば、ステムは足されない
  const off = sumStems(set, { ...set.faders, "@bed": 0, "@pad": 0, "@sfx": 0, a: 0, b: 0 });
  assert.ok(off.l.every((x) => x === 0));
  // パッド・効果音・ドラムループを 0 から上げても、作り直さずに鳴る（量0のときも、ステムは作ってある）
  const zero = structuredClone(song);
  zero.params = { ...zero.params, pad: 0, sfx: 0 };
  const zeroSet = (await buildStems(zero, phrases, steadyRender, sr))!;
  assert.ok(zeroSet.stems.some((s) => s.kind === "sfx") && zeroSet.stems.some((s) => s.kind === "bed"));
});

test("ソロ：ソロのものだけ鳴る（ミュート中でも）。ソロのとき、ほかの層・ドラムループ・効果音は止まる。ドラムループのミュートは音量を残す", () => {
  const song = {
    params: { ...createEmptySong().params, bedVolume: 0.8, sfx: 0.6, pad: 0.5 },
    lanes: [
      { phraseId: "a", cutSeed: 1, rhythmSeed: 1, orderSeed: 1, volume: 0.5 },
      { phraseId: "b", cutSeed: 2, rhythmSeed: 2, orderSeed: 2, muted: true },
      { phraseId: "c", cutSeed: 3, rhythmSeed: 3, orderSeed: 3 },
    ],
  };
  // 定位（~で始まる名前）はここでは見ない
  const levels = (f: Record<string, number>) => Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith("~")));
  // ソロなし：ミュートと音量のとおり
  assert.deepEqual(levels(songFaders(song)), { a: 0.5, b: 0, c: 1, "@bed": 0.8, "@pad": 0.5, "@sfx": 0.6, "@master": 1 });
  // aだけソロ：ほかは止まる。ドラムループと効果音も止まる。パッドの量はそのまま（パッドは層のフェーダーに従う）
  assert.deepEqual(levels(songFaders(song, { lanes: new Set(["a"]), bed: false })), { a: 0.5, b: 0, c: 0, "@bed": 0, "@pad": 0.5, "@sfx": 0, "@master": 1 });
  // ミュート中のbをソロにすると鳴る（音量1）
  assert.equal(songFaders(song, { lanes: new Set(["b"]), bed: false }).b, 1);
  // ドラムループもソロ：aと、ドラムループが鳴る
  assert.deepEqual(levels(songFaders(song, { lanes: new Set(["a"]), bed: true })), { a: 0.5, b: 0, c: 0, "@bed": 0.8, "@pad": 0.5, "@sfx": 0, "@master": 1 });
  // ドラムループだけソロ：層は全部止まる
  const bedOnly = songFaders(song, { lanes: new Set(), bed: true });
  assert.deepEqual([bedOnly.a, bedOnly.b, bedOnly.c, bedOnly["@bed"], bedOnly["@sfx"]], [0, 0, 0, 0.8, 0]);
  // ドラムループのミュート：音量は残る。ソロにすれば鳴る
  assert.equal(songFaders({ ...song, bedMuted: true })["@bed"], 0);
  assert.equal(songFaders({ ...song, bedMuted: true }, { lanes: new Set(), bed: true })["@bed"], 0.8);
  // ソロが空なら、ソロなしと同じ
  assert.deepEqual(songFaders(song, { lanes: new Set(), bed: false }), songFaders(song));
});

test("マスターのフェーダー：コンプ・リミッターのあとに掛かる（音量だけが変わり、音色は変わらない）", async () => {
  const phrases = [drumPhrase("a"), phrase("b", 100, 62)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b"], lengthBars: 4, bpm: 120 };
  song.lanes = syncLanes(song, seq);
  const set = (await buildStems(song, phrases, steadyRender, 2000))!;
  const full = await mixdown(set);
  const half = await mixdown(set, undefined, { ...set.faders, "@master": 0.5 });
  let max = 0;
  for (let i = 0; i < full.l.length; i++) max = Math.max(max, Math.abs(half.l[i] - full.l[i] * 0.5));
  assert.ok(max < 1e-7, `差 ${max}`);
  assert.ok((await mixdown(set, undefined, { ...set.faders, "@master": 0 })).l.every((x) => x === 0));
  assert.equal(songFaders({ ...song, params: { ...song.params, master: 0.3 } })["@master"], 0.3);
});

test("定位：Web Audio のパンと同じ式。真ん中は何も変えない。左いっぱいは右の音も左に寄る", () => {
  assert.ok(Math.abs(panGains(0).gainL) < 1e-12 && Math.abs(panGains(0).gainR - 1) < 1e-12);
  // 左いっぱい（-1）：左 = 左 + 右、右 = 0
  assert.ok(Math.abs(panGains(-1).gainL - 1) < 1e-12 && Math.abs(panGains(-1).gainR) < 1e-12);
  // 右いっぱい（1）：左 = 0、右 = 右 + 左
  assert.ok(Math.abs(panGains(1).gainL) < 1e-12 && Math.abs(panGains(1).gainR - 1) < 1e-12);
  // 途中は、二乗の和が1（音量が変わらない）
  for (const p of [-0.7, -0.2, 0.3, 0.9]) {
    const { gainL, gainR } = panGains(p);
    assert.ok(Math.abs(gainL ** 2 + gainR ** 2 - 1) < 1e-12);
  }
});

test("定位：ステムに定位を掛けた結果は、最初から定位を設定した曲と同じ。真ん中なら音は変わらない。保存・読み込みもできる", async () => {
  const phrases = [drumPhrase("a"), phrase("b", 100, 62)];
  const song: Song = { ...createEmptySong(), materialIds: ["a", "b"], lengthBars: 4, bpm: 120 };
  song.lanes = syncLanes(song, seq);
  const sr = 2000;
  const set = (await buildStems(song, phrases, steadyRender, sr))!;
  assert.equal(set.faders[balanceFader("a")], 0);
  const center = await mixdown(set);
  assert.deepEqual(await mixdown(set, undefined, { ...set.faders, [balanceFader("a")]: 0 }), center);
  const panned = structuredClone(song);
  panned.lanes![1].balance = -0.6;
  const direct = (await buildCollage(panned, phrases, steadyRender, sr))!;
  const via = await mixdown(set, undefined, songFaders(panned));
  let max = 0;
  let different = 0;
  for (let i = 0; i < via.l.length; i++) {
    max = Math.max(max, Math.abs(via.l[i] - direct.pcm.l[i]), Math.abs(via.r[i] - direct.pcm.r[i]));
    different = Math.max(different, Math.abs(via.l[i] - center.l[i]));
  }
  assert.ok(max < 1e-6, `差 ${max}`);
  assert.ok(different > 1e-3, "定位を動かすと、音が変わる");
  // 保存・読み込み：真ん中は保存しない。範囲外は収める
  const lane = (balance: number) => ({ phraseId: "a", cutSeed: 1, rhythmSeed: 2, orderSeed: 3, balance });
  assert.equal(migrateSong({ ...createEmptySong(), lanes: [lane(0.4)] }).lanes![0].balance, 0.4);
  assert.equal(migrateSong({ ...createEmptySong(), lanes: [lane(-9)] }).lanes![0].balance, -1);
  assert.equal(migrateSong({ ...createEmptySong(), lanes: [lane(0)] }).lanes![0].balance, undefined);
});

test("ソロ：存在しない層（外した素材）のソロは数えない。ソロが残っていても、全部が無音にならない", () => {
  const song = {
    params: createEmptySong().params,
    lanes: [
      { phraseId: "a", cutSeed: 1, rhythmSeed: 1, orderSeed: 1 },
      { phraseId: "b", cutSeed: 2, rhythmSeed: 2, orderSeed: 2 },
    ],
  };
  const levels = (f: Record<string, number>) => [f.a, f.b, f["@sfx"]];
  // 外した素材 "gone" だけがソロのまま残っている → ソロなしと同じ
  assert.deepEqual(levels(songFaders(song, { lanes: new Set(["gone"]), bed: false })), levels(songFaders(song)));
  // 存在する層のソロは効く
  assert.deepEqual(levels(songFaders(song, { lanes: new Set(["gone", "a"]), bed: false })), [1, 0, 0]);
});
