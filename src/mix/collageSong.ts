import { createRng } from "../theory/rng.ts";
import { keyShortName } from "../theory/key.ts";
import { totalBeats, type Phrase } from "../phrase/types.ts";
import { layBed, renderCollage, type CollageLane } from "./collage.ts";
import { applyTrack, trackIsOff, type FxEnv, type FxPlugin, type TrackFx } from "./fx.ts";
import { applyGroups, groupOf } from "./groups.ts";
import { addSfx, fourOnFloor, kickSteps, pump, renderPad, type Grid, type PadSource } from "./glue.ts";
import { phraseKey, transposeSemitones } from "./keySync.ts";
import { limitPeak, type Pcm } from "./pcm.ts";
import { STEPS_PER_BEAT, holdFraction, planOrder, planRhythm, type LaneEvent } from "./sequencer.ts";
import { cutSlices, type Slice } from "./slicer.ts";
import { musicSlices, musicSlotSteps, planMusicLane } from "./musicChop.ts";
import { effectiveParams, type Lane, type Song } from "./types.ts";

/** 刻む曲：音符のある曲だけ。選んだ順。 */
export function collectSources(song: Pick<Song, "materialIds">, phrases: Phrase[]): Phrase[] {
  const byId = new Map(phrases.map((p) => [p.id, p]));
  return song.materialIds
    .map((id) => byId.get(id))
    .filter((p): p is Phrase => !!p && p.layers.some((l) => l.notes.length > 0));
}

/** ドラムの音符がある曲か（下地に使える）。 */
export function hasDrums(phrase: Phrase): boolean {
  return phrase.layers.some((l) => l.role === "drums" && !l.muted && l.notes.length > 0);
}

/**
 * 下地に使う曲のid。決めていなければ（undefined）、ドラムのある最初の材料。無ければ null（下地なし）。
 */
export function pickDrum(song: Pick<Song, "drumId" | "materialIds">, phrases: Phrase[]): string | null {
  if (song.drumId !== undefined) return song.drumId;
  const byId = new Map(phrases.map((p) => [p.id, p]));
  return song.materialIds.find((id) => { const p = byId.get(id); return !!p && hasDrums(p); }) ?? null;
}

/** 下地を線に描くための、ドラムの打つ所（曲の長さぶん、くり返す）。 */
export function bedEvents(phrase: Phrase, totalSteps: number): LaneEvent[] {
  const loop = Math.max(1, Math.round(totalBeats(phrase) * STEPS_PER_BEAT));
  const steps = new Set<number>();
  for (const l of phrase.layers) {
    if (l.role !== "drums" || l.muted) continue;
    for (const n of l.notes) steps.add(((Math.round(n.startBeats * STEPS_PER_BEAT) % loop) + loop) % loop);
  }
  const out: LaneEvent[] = [];
  for (let base = 0; base < totalSteps; base += loop) {
    for (const s of [...steps].sort((a, b) => a - b)) if (base + s < totalSteps) out.push({ step: base + s, len: 1, slice: 0, pitch: 0 });
  }
  return out;
}

/** 新しい層（種は seed から）。 */
export function newLane(phraseId: string, seed: () => number): Lane {
  return { phraseId, cutSeed: seed(), rhythmSeed: seed(), orderSeed: seed() };
}

/** 選んだ曲に合わせて層をそろえる：増えた曲には新しい層、外した曲の層は消す。選んだ順に並べる。 */
export function syncLanes(song: Pick<Song, "materialIds" | "lanes">, seed: () => number): Lane[] {
  const byId = new Map((song.lanes ?? []).map((l) => [l.phraseId, l]));
  return song.materialIds.map((id) => byId.get(id) ?? newLane(id, seed));
}

export type RerollPart = "all" | "cut" | "rhythm" | "order";

/** 固定していない層の種を、新しくする（all＝全部、cut／rhythm／order＝その部分だけ）。 */
export function rerollLanes(lanes: Lane[], part: RerollPart, seed: () => number): Lane[] {
  return lanes.map((l) => {
    if (l.locked) return l;
    return {
      ...l,
      cutSeed: part === "all" || part === "cut" ? seed() : l.cutSeed,
      rhythmSeed: part === "all" || part === "rhythm" ? seed() : l.rhythmSeed,
      orderSeed: part === "all" || part === "order" ? seed() : l.orderSeed,
    };
  });
}

/** 種だけの控え（「ひとつ戻す」用）。形のずらしや固定は戻さない。 */
export type SeedSnapshot = Pick<Lane, "phraseId" | "cutSeed" | "rhythmSeed" | "orderSeed">[];

export function seedSnapshot(lanes: Lane[]): SeedSnapshot {
  return lanes.map(({ phraseId, cutSeed, rhythmSeed, orderSeed }) => ({ phraseId, cutSeed, rhythmSeed, orderSeed }));
}

/** 控えの種を、いまの層に戻す（同じ曲の層だけ。形のずらし・固定・音量はそのまま）。 */
export function applySeeds(lanes: Lane[], snap: SeedSnapshot): Lane[] {
  const byId = new Map(snap.map((s) => [s.phraseId, s]));
  return lanes.map((l) => {
    const s = byId.get(l.phraseId);
    return s ? { ...l, cutSeed: s.cutSeed, rhythmSeed: s.rhythmSeed, orderSeed: s.orderSeed } : l;
  });
}

export interface LaneView {
  phraseId: string;
  name: string;
  locked: boolean;
  muted: boolean;
  events: LaneEvent[];
  sliceCount: number;
}

export interface CollageResult {
  pcm: Pcm;
  lanes: LaneView[];
  /** 下地（鳴らしっぱなしのドラム）。無ければ null。 */
  bed: { phraseId: string; name: string; events: LaneEvent[] } | null;
  totalSteps: number;
  /** 曲の調（いちばん上の層の曲の調）。分からなければ null。 */
  keyName: string | null;
}

export interface RenderOpts {
  dry: boolean;
  drumsOnly?: boolean;
  swing?: number;
}

/** 下地の音量の基準（刻んだ層の 0.9 より少し控えめ）。 */
const BED_GAIN = 0.75;

/**
 * 曲を作る：層ごとに、曲を曲のBPMで1本の波形に書き出し（余韻なしなら、リバーブ・ディレイを外して）、断片に切り、格子に打って、全部の層を重ねる。
 * 下地があれば、その曲のドラムだけを書き出して、刻まずに頭から最後まで鳴らしっぱなしにする。
 * フレーズ自身のBPMは関係ない。ほかの層の調は、いちばん上の層の調に寄せる。
 */
/** リバーブの響きだけ（元の音を含まない）を作る。 */
export type ReverbFn = FxEnv["reverb"];

/** 波形を足す（out に add を重ねる）。 */
function mixInto(out: Pcm, add: Pcm): void {
  for (let i = 0; i < out.l.length && i < add.l.length; i++) {
    out.l[i] += add.l[i];
    out.r[i] += add.r[i];
  }
}

export async function buildCollage(
  song: Song,
  phrases: Phrase[],
  render: (phrase: Phrase, bpm: number, opts: RenderOpts) => Promise<Pcm>,
  sampleRate: number,
  /** リバーブの響きを作る（エフェクトのリバーブに使う）。無ければ、エフェクトは掛けない。 */
  reverb?: ReverbFn,
): Promise<CollageResult | null> {
  const fxOn = (fx: TrackFx | undefined): fx is TrackFx => !!reverb && !trackIsOff(fx);
  const sources = collectSources(song, phrases);
  const byId = new Map(sources.map((p) => [p.id, p]));
  const lanes = (song.lanes ?? []).filter((l) => byId.has(l.phraseId));
  if (lanes.length === 0) return null;
  const totalSteps = song.lengthBars * song.beatsPerBar * STEPS_PER_BEAT;
  const stepSamples = (sampleRate * 60) / song.bpm / STEPS_PER_BEAT;
  const baseKey = phraseKey(byId.get(lanes[0].phraseId)!);

  // 音楽モードの交代は、ミュートしていない層だけで回す（ミュートした層の番で、無音の4小節ができないように）
  const playing = lanes.filter((l) => !l.muted);
  // 混ぜる（音楽モード）：全部の層で1つのリズムを作る。リズムの種と形は、いちばん上の鳴っている層のもの（形は全体のつまみ）
  const mixing = song.params.style === "music" && song.params.turns === "mix" && playing.length > 1;
  const lead = playing[0];
  const built = await Promise.all(
    lanes.map(async (lane, i) => {
      const turn = lane.muted
        ? mixing
          ? { laneIndex: -1, laneCount: playing.length } // 混ぜるとき、ミュートした層には番を回さない
          : { laneIndex: i, laneCount: lanes.length }
        : { laneIndex: playing.indexOf(lane), laneCount: playing.length };
      const phrase = byId.get(lane.phraseId)!;
      const pcm = await render(phrase, song.bpm, { dry: song.params.dry });
      // 層に効く形＝全体＋その層のずらし（混ぜるときは、1つのリズムなので全体の形）
      const params = mixing ? effectiveParams(song.params, {}) : effectiveParams(song.params, lane);
      const seeds = mixing ? lead : lane;
      let slices: Slice[];
      let events: LaneEvent[];
      if (song.params.style === "music") {
        // 音楽モード：拍の格子で切り、元の同じ小節（コード）から取り、パターンをくり返す。層は交代で鳴らす
        const stepsPerBar = song.beatsPerBar * STEPS_PER_BEAT;
        const slotSteps = musicSlotSteps(params.size);
        const srcBars = Math.max(1, Math.floor((totalBeats(phrase) * STEPS_PER_BEAT) / stepsPerBar));
        slices = musicSlices({ srcBars, stepsPerBar, slotSteps, stepSamples, length: pcm.l.length });
        events = planMusicLane({
          totalSteps,
          stepsPerBar,
          srcBars,
          slotSteps,
          laneIndex: turn.laneIndex,
          laneCount: turn.laneCount,
          turns: song.params.turns,
          srcRng: mixing ? createRng(lead.orderSeed ^ 0x2545f491) : undefined,
          params,
          cutRng: createRng(seeds.cutSeed),
          rhythmRng: createRng(seeds.rhythmSeed),
          orderRng: createRng(seeds.orderSeed),
        });
      } else {
        slices = cutSlices(pcm, sampleRate, { mode: params.mode, size: params.size }, createRng(lane.cutSeed));
        const hits = planRhythm(totalSteps, song.beatsPerBar, params, createRng(lane.rhythmSeed));
        events = planOrder(hits, slices.length, params.motion, createRng(lane.orderSeed));
      }
      const key = phraseKey(phrase);
      const keyShift = key && baseKey ? transposeSemitones(key, baseKey) : 0;
      const gain = lane.muted ? 0 : 0.9 * (lane.volume ?? 1);
      // グループの編集（音程・パン・長さ・強さ・逆再生・ミュート）を当てはめる
      const grouped = applyGroups(lane.phraseId, events, song.groups);
      const collage: CollageLane = { pcm, slices, events: grouped.play, keyShift, gain, holdFraction: holdFraction(params.hold, song.params.style) };
      const stepsPerBarSrc = song.beatsPerBar * STEPS_PER_BEAT;
      const pad: PadSource | null = lane.muted
        ? null
        : { pcm, srcBars: Math.max(1, Math.floor((totalBeats(phrase) * STEPS_PER_BEAT) / stepsPerBarSrc)), keyShift };
      const view: LaneView = {
        phraseId: phrase.id,
        name: phrase.name,
        locked: !!lane.locked,
        muted: !!lane.muted,
        events: grouped.view,
        sliceCount: slices.length,
      };
      return { collage, view, pad, fx: lane.muted ? undefined : lane.fx, takes: lane.muted || !reverb ? [] : (lane.takes ?? []) };
    }),
  );
  const swing = song.params.swing;
  const grid: Grid = { totalSteps, stepsPerBar: song.beatsPerBar * STEPS_PER_BEAT, stepSamples, sampleRate, swing };
  const collageOpts = { totalSteps, stepSamples, sampleRate, swing };
  const fxEnv: FxEnv | null = reverb ? { stepSamples, sampleRate, bpm: song.bpm, reverb } : null;
  // エフェクトの無い層はまとめて作る。エフェクトのある層は1本ずつ：テイクFXの断片は1つずつ作ってそのFXを掛け、
  // 残りの断片と合わせてから、その層のトラックFXを掛ける（REAPER と同じ、テイクFX → トラックFX の順）
  // グループのFX：グループの断片を集めて（トラックごとに）、テイクFXのあと、トラックFXの前に掛ける
  const chainOn = (chain: FxPlugin[] | undefined): chain is FxPlugin[] => !!chain && fxOn({ chain, envelopes: [] });
  const groupFxOf = (phraseId: string, step: number): { id: string; chain: FxPlugin[] } | null => {
    const g = groupOf(song.groups, { phraseId, step });
    return g && chainOn(g.fx) ? { id: g.id, chain: g.fx } : null;
  };
  const plain = built.filter(
    (b) =>
      !fxOn(b.fx) &&
      !b.takes.some((t) => chainOn(t.chain)) &&
      !b.collage.events.some((e) => groupFxOf(b.view.phraseId, e.step)),
  );
  const mixed = renderCollage(plain.map((b) => b.collage), collageOpts);
  for (const b of built) {
    if (plain.includes(b)) continue;
    const takes = new Map(b.takes.filter((t) => chainOn(t.chain)).map((t) => [t.step, t.chain]));
    const special = (e: LaneEvent): boolean => takes.has(e.step) || !!groupFxOf(b.view.phraseId, e.step);
    const lanePcm = renderCollage([{ ...b.collage, events: b.collage.events.filter((e) => !special(e)) }], collageOpts);
    // テイクFX・グループFXのある断片：断片ごとにテイクFXを掛け、グループごとに集めてグループFXを掛ける
    const groupBus = new Map<string, { chain: FxPlugin[]; pcm: Pcm }>();
    for (const ev of b.collage.events) {
      if (!special(ev)) continue;
      let one = renderCollage([{ ...b.collage, events: [ev] }], collageOpts);
      const take = takes.get(ev.step);
      if (take) one = await applyTrack(one, { chain: take, envelopes: [] }, fxEnv!);
      const g = groupFxOf(b.view.phraseId, ev.step);
      if (!g) {
        mixInto(lanePcm, one);
        continue;
      }
      const bus = groupBus.get(g.id) ?? { chain: g.chain, pcm: { l: new Float32Array(lanePcm.l.length), r: new Float32Array(lanePcm.r.length) } };
      mixInto(bus.pcm, one);
      groupBus.set(g.id, bus);
    }
    for (const bus of groupBus.values()) mixInto(lanePcm, await applyTrack(bus.pcm, { chain: bus.chain, envelopes: [] }, fxEnv!));
    mixInto(mixed, fxOn(b.fx) ? await applyTrack(lanePcm, b.fx, fxEnv!) : lanePcm);
  }
  // 仕上げ（つなぎ）の偶然は、いちばん上の層の種から（刻み直すと変わり、形のつまみでは変わらない）
  const glueSeed = (lanes.find((l) => !l.muted) ?? lanes[0]).cutSeed;
  // 伸ばし：元の曲の和音を引き伸ばして、うしろでうっすら鳴らす（断片の間をつなぐ）
  const padSources = built.map((b) => b.pad).filter((p): p is PadSource => p !== null);
  let pad = renderPad(padSources, grid, song.params.pad, createRng(glueSeed ^ 0x51ed270b));
  if (song.params.pad > 0 && fxOn(song.fx.pad)) pad = await applyTrack(pad, song.fx.pad, fxEnv!);
  mixInto(mixed, pad);
  // 下地：選んだ曲のドラムだけを、刻まずに鳴らしっぱなし（ノリの軸になる）
  const drumId = pickDrum(song, phrases);
  const drumPhrase = drumId ? phrases.find((p) => p.id === drumId && hasDrums(p)) : undefined;
  let bed: CollageResult["bed"] = null;
  // ポンピング：下地のキックに合わせて、刻んだ音と伸ばしを沈ませる（キックが無ければ4つ打ち）。下地とSFXは沈ませない
  const kicks = drumPhrase ? kickSteps(drumPhrase, totalSteps) : [];
  pump(mixed, kicks.length > 0 ? kicks : fourOnFloor(totalSteps), grid, song.params.pump);
  if (drumPhrase) {
    let bedPcm = await render(drumPhrase, song.bpm, { dry: song.params.dry, drumsOnly: true, swing });
    if (fxOn(song.fx.bed)) {
      // 下地は1周ぶんの波形なので、曲の長さに並べてから掛ける（「いつ掛けるか」が曲の位置で決まるように）
      const full: Pcm = { l: new Float32Array(mixed.l.length), r: new Float32Array(mixed.r.length) };
      layBed(full, bedPcm, BED_GAIN * song.params.bedVolume);
      mixInto(mixed, await applyTrack(full, song.fx.bed, fxEnv!));
    } else {
      layBed(mixed, bedPcm, BED_GAIN * song.params.bedVolume);
    }
    bed = { phraseId: drumPhrase.id, name: `${drumPhrase.name}のドラム`, events: bedEvents(drumPhrase, totalSteps) };
  }
  // SFX：区切りを聞かせる（8小節ごとのライザー・インパクト、4小節ごとのリバースシンバル）
  addSfx(mixed, grid, song.params.sfx, createRng(glueSeed ^ 0x2f6b8a1d));
  // 全体のエフェクト：最後に、曲全体に掛ける
  const pcm = limitPeak(fxOn(song.fx.master) ? await applyTrack(mixed, song.fx.master, fxEnv!) : mixed);
  return { pcm, lanes: built.map((b) => b.view), bed, totalSteps, keyName: baseKey ? keyShortName(baseKey) : null };
}
