import { createRng } from "../theory/rng.ts";
import { keyShortName } from "../theory/key.ts";
import { totalBeats, type Phrase } from "../phrase/types.ts";
import { layBed, renderCollage, type CollageLane } from "./collage.ts";
import { applyTrack, chainTailSeconds, trackIsOff, type FxEnv, type FxPlugin, type TrackFx } from "./fx.ts";
import { applyGroups, groupOf } from "./groups.ts";
import { addSfx, fourOnFloor, kickSteps, pump, renderPadStems, type Grid, type PadSource } from "./glue.ts";
import { phraseKey, transposeSemitones } from "./keySync.ts";
import { BuildCache } from "./buildCache.ts";
import { masterBusLoop } from "./masterBus.ts";
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

/** ミキサーに並ぶ1本分の波形（ステム）。マスターに行く前の、そのトラックだけの音。 */
export interface Stem {
  id: string;
  kind: "track" | "pad" | "bed" | "sfx";
  /** track・pad：どの層のものか（層の曲の id）。この層のフェーダー（ミュート・音量）が掛かる。 */
  phraseId?: string;
  /** pad・bed・sfx：そのチャンネルのフェーダー（パッドの量・ドラムループの音量・効果音の量）も掛かる。 */
  channel?: "pad" | "bed" | "sfx";
  pcm: Pcm;
}

/** 曲を作った結果を、ミキサーに渡せる形にしたもの。フェーダーを動かすだけなら、作り直さずに足し直せる。 */
export interface StemSet {
  stems: Stem[];
  lanes: LaneView[];
  bed: CollageResult["bed"];
  totalSteps: number;
  keyName: string | null;
  sampleRate: number;
  bpm: number;
  stepSamples: number;
  /** 層ごとのフェーダー（ミュート＝0、ふだんは音量）。層の曲の id で引く。 */
  faders: Record<string, number>;
  /** 全体のエフェクト（マスター）。 */
  masterFx: TrackFx | undefined;
}

/** 層のフェーダー：ミュートなら0、そうでなければ音量（無ければ1）。 */
export const faderOf = (lane: Pick<Lane, "muted" | "volume">): number => (lane.muted ? 0 : (lane.volume ?? 1));

/** フェーダーの名前：層は曲の id、そのほかのチャンネルは @ をつけた名前。 */
export const CHANNEL_FADERS = { bed: "@bed", pad: "@pad", sfx: "@sfx" } as const;

/** 曲の設定から、全部のフェーダーの値（層ごとの音量・ミュートと、ドラムループ・パッド・効果音の量）。 */
export function songFaders(song: Pick<Song, "lanes" | "params">): Record<string, number> {
  return {
    ...Object.fromEntries((song.lanes ?? []).map((l) => [l.phraseId, faderOf(l)])),
    [CHANNEL_FADERS.bed]: song.params.bedVolume,
    [CHANNEL_FADERS.pad]: song.params.pad,
    [CHANNEL_FADERS.sfx]: song.params.sfx,
  };
}

/** 1つのステムに掛かるフェーダーの値：層のフェーダー × チャンネルのフェーダー。 */
export function stemFader(stem: Pick<Stem, "phraseId" | "channel">, faders: Record<string, number>): number {
  const lane = stem.phraseId !== undefined ? (faders[stem.phraseId] ?? 1) : 1;
  const channel = stem.channel ? (faders[CHANNEL_FADERS[stem.channel]] ?? 1) : 1;
  return lane * channel;
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

/** 波形を、out の offset の位置から重ねる（曲の終わりを越えたら頭に回す）。 */
function mixAt(out: Pcm, add: Pcm, offset: number): void {
  const n = out.l.length;
  for (let i = 0; i < add.l.length; i++) {
    const j = (offset + i) % n;
    out.l[j] += add.l[i];
    out.r[j] += add.r[i];
  }
}

/** 波形を足す（out に add を重ねる）。 */
function mixInto(out: Pcm, add: Pcm): void {
  for (let i = 0; i < out.l.length && i < add.l.length; i++) {
    out.l[i] += add.l[i];
    out.r[i] += add.r[i];
  }
}

/** 曲を作って、ミキサーに渡せるステムにする（ミュート・音量は、ここでは掛けない）。 */
export async function buildStems(
  song: Song,
  phrases: Phrase[],
  render: (phrase: Phrase, bpm: number, opts: RenderOpts) => Promise<Pcm>,
  sampleRate: number,
  /** リバーブの響きを作る（エフェクトのリバーブに使う）。無ければ、エフェクトは掛けない。 */
  reverb?: ReverbFn,
  /** 前と同じ入力のトラック（と伸ばし）の波形を使い回す入れ物。無ければ毎回ぜんぶ作る。 */
  cache?: BuildCache,
): Promise<StemSet | null> {
  const cached = <T>(key: string, make: () => Promise<T> | T): Promise<T> => (cache ? cache.getOrCompute(key, make) : Promise.resolve(make()));
  const fxOn = (fx: TrackFx | undefined): fx is TrackFx => !!reverb && !trackIsOff(fx);
  const sources = collectSources(song, phrases);
  const byId = new Map(sources.map((p) => [p.id, p]));
  const lanes = (song.lanes ?? []).filter((l) => byId.has(l.phraseId));
  if (lanes.length === 0) return null;
  const totalSteps = song.lengthBars * song.beatsPerBar * STEPS_PER_BEAT;
  const stepSamples = (sampleRate * 60) / song.bpm / STEPS_PER_BEAT;
  const baseKey = phraseKey(byId.get(lanes[0].phraseId)!);

  // ミュートは「このトラックを抜いたら、同じ曲がどう聞こえるか」を聞くためのもの。
  // ミュートしても、ほかのトラックの打つ内容（交代・掛け合い・混ぜるの番や、リズムの種）は変えない。ミュートした層は、打つ予定は同じまま、音だけ出さない
  const mixing = song.params.style === "music" && song.params.turns === "mix" && lanes.length > 1;
  // 混ぜる（音楽モード）：全部の層で1つのリズムを作る。リズムの種と形は、いちばん上の層のもの（形は全体のつまみ）
  const lead = lanes[0];
  const built = await Promise.all(
    lanes.map(async (lane, i) => {
      const turn = { laneIndex: i, laneCount: lanes.length };
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
      // 音量とミュートは、ミキサー（フェーダー）で掛ける。ここでは基準の 0.9 だけ
      const gain = 0.9;
      // グループの編集（音程・パン・長さ・強さ・逆再生・ミュート）を当てはめる
      const grouped = applyGroups(lane.phraseId, events, song.groups);
      const collage: CollageLane = { pcm, slices, events: grouped.play, keyShift, gain, holdFraction: holdFraction(params.hold, song.params.style) };
      const stepsPerBarSrc = song.beatsPerBar * STEPS_PER_BEAT;
      const pad: PadSource = { pcm, srcBars: Math.max(1, Math.floor((totalBeats(phrase) * STEPS_PER_BEAT) / stepsPerBarSrc)), keyShift };
      const view: LaneView = {
        phraseId: phrase.id,
        name: phrase.name,
        locked: !!lane.locked,
        muted: !!lane.muted,
        events: grouped.view,
        sliceCount: slices.length,
      };
      return { collage, view, pad, fx: lane.fx, takes: reverb ? (lane.takes ?? []) : [] };
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
  // ポンピング：下地のキックに合わせて、刻んだ音と伸ばしを沈ませる（キックが無ければ4つ打ち）。下地とSFXは沈ませない。
  // 沈ませるのは、ステム（トラック・伸ばし）ごと。足し算なので、全部を足してから沈ませるのと同じ
  const drumId = pickDrum(song, phrases);
  const drumPhrase = drumId ? phrases.find((p) => p.id === drumId && hasDrums(p)) : undefined;
  const kicks = drumPhrase ? kickSteps(drumPhrase, totalSteps) : [];
  const pumpKicks = kicks.length > 0 ? kicks : fourOnFloor(totalSteps);
  const pumpKey = JSON.stringify([song.params.pump, pumpKicks]);
  const pumped = (pcm: Pcm): Pcm => {
    pump(pcm, pumpKicks, grid, song.params.pump);
    return pcm;
  };
  // トラックの波形の使い回し：このトラックの結果が何で決まるか（波形・断片・打つ予定・音程・音量・書き出しの条件）を名前にする
  const laneSig = (b: (typeof built)[number]): string =>
    JSON.stringify([
      cache ? cache.idOf(b.collage.pcm) : 0,
      b.collage.slices.map((s) => [s.start, s.end]),
      b.collage.events,
      b.collage.keyShift,
      b.collage.gain,
      b.collage.holdFraction,
      collageOpts,
    ]);
  const stems: Stem[] = [];
  for (const b of built) {
    const plain =
      !fxOn(b.fx) &&
      !b.takes.some((t) => chainOn(t.chain)) &&
      !b.collage.events.some((e) => groupFxOf(b.view.phraseId, e.step));
    let pcm: Pcm;
    if (plain) {
      pcm = await cached(`plain|${laneSig(b)}|${pumpKey}`, () => pumped(renderCollage([b.collage], collageOpts)));
    } else {
      // エフェクトのあるトラック（テイクFX・グループFX・トラックFXまで含めて）は、同じ入力なら丸ごと使い回す
      const fxKey = `fx|${laneSig(b)}|${JSON.stringify([b.view.phraseId, b.fx, b.takes, song.groups, song.bpm, !!reverb])}|${pumpKey}`;
      pcm = await cached(fxKey, async () => {
        const takes = new Map(b.takes.filter((t) => chainOn(t.chain)).map((t) => [t.step, t.chain]));
        const groupIdOf = (e: LaneEvent): string | null => groupFxOf(b.view.phraseId, e.step)?.id ?? null;
        const plainEvents = b.collage.events.filter((e) => !takes.has(e.step) && !groupIdOf(e));
        const lanePcm = renderCollage([{ ...b.collage, events: plainEvents }], collageOpts);
        // グループFX：グループの断片をまとめて1回で作る（断片ごとに曲全体の長さを作ると、とても重くなる）
        const groupBus = new Map<string, Pcm>();
        const groupEvents = new Map<string, LaneEvent[]>();
        for (const ev of b.collage.events) {
          const gid = groupIdOf(ev);
          if (!gid || takes.has(ev.step)) continue;
          groupEvents.set(gid, [...(groupEvents.get(gid) ?? []), ev]);
        }
        for (const [gid, events] of groupEvents) groupBus.set(gid, renderCollage([{ ...b.collage, events }], collageOpts));
        // テイクFX：断片1つぶんと、FXの余韻が収まる短い長さだけ作って掛け、その位置に重ねる
        for (const ev of b.collage.events) {
          const take = takes.get(ev.step);
          if (!take) continue;
          const one = await renderTake(b.collage, ev, take);
          const gid = groupIdOf(ev);
          let target = lanePcm;
          if (gid) {
            if (!groupBus.has(gid)) groupBus.set(gid, { l: new Float32Array(lanePcm.l.length), r: new Float32Array(lanePcm.r.length) });
            target = groupBus.get(gid)!;
          }
          mixAt(target, one.pcm, one.offset);
        }
        for (const [gid, pcm] of groupBus) {
          const chain = song.groups?.find((g) => g.id === gid)?.fx ?? [];
          mixInto(lanePcm, await applyTrack(pcm, { chain, envelopes: [] }, fxEnv!));
        }
        return pumped(fxOn(b.fx) ? await applyTrack(lanePcm, b.fx, fxEnv!) : lanePcm);
      });
    }
    stems.push({ id: `track:${b.view.phraseId}`, kind: "track", phraseId: b.view.phraseId, pcm });
  }

  /** テイクFXの断片：断片の位置から、FXの余韻が収まるまでの短い波形を作って、FXを掛ける（曲より長くなるなら曲の長さで）。 */
  async function renderTake(lane: CollageLane, ev: LaneEvent, chain: FxPlugin[]): Promise<{ pcm: Pcm; offset: number }> {
    const tail = chainTailSeconds(chain, song.bpm);
    // スウィングの位置が変わらないよう、偶数ステップから始める
    const startStep = ev.step - (ev.step % 2);
    const steps = ev.step - startStep + ev.len + Math.ceil((tail * sampleRate) / stepSamples) + 1;
    if (steps >= totalSteps) {
      const full = renderCollage([{ ...lane, events: [ev] }], collageOpts);
      return { pcm: await applyTrack(full, { chain, envelopes: [] }, fxEnv!), offset: 0 };
    }
    const short = renderCollage([{ ...lane, events: [{ ...ev, step: ev.step - startStep }] }], { ...collageOpts, totalSteps: steps });
    return { pcm: await applyTrack(short, { chain, envelopes: [] }, fxEnv!), offset: Math.round(startStep * stepSamples) };
  }

  // 仕上げ（つなぎ）の偶然は、いちばん上の層の種から（刻み直すと変わり、形のつまみでは変わらない）
  const glueSeed = lanes[0].cutSeed;
  // 伸ばし：元の曲の和音を引き伸ばして、うしろでうっすら鳴らす（断片の間をつなぐ）。曲（トラック）ごとのステムにして、その層のフェーダーに従わせる
  // 量（パッドの量）は掛け算だけなので、いちばん大きい量で作って、ミキサーのフェーダー（@pad）で下げる
  {
    const padKey = JSON.stringify([built.map((b) => [cache ? cache.idOf(b.pad.pcm) : 0, b.pad.srcBars, b.pad.keyShift]), glueSeed, grid, fxOn(song.fx.pad) ? song.fx.pad : null, song.bpm, pumpKey]);
    const pads = await cached(`pad|${padKey}`, async () => {
      const raw = renderPadStems(built.map((b) => b.pad), grid, 1, createRng(glueSeed ^ 0x51ed270b));
      const out: Pcm[] = [];
      for (const r of raw) out.push(pumped(fxOn(song.fx.pad) ? await applyTrack(r, song.fx.pad, fxEnv!) : r));
      return out;
    });
    // 偶然で一度も選ばれなかった曲の伸ばしは、無音なので入れない（メモリの節約）
    built.forEach((b, i) => {
      if (pads[i].l.some((x) => x !== 0)) stems.push({ id: `pad:${b.view.phraseId}`, kind: "pad", phraseId: b.view.phraseId, channel: "pad", pcm: pads[i] });
    });
  }
  // 下地：選んだ曲のドラムだけを、刻まずに鳴らしっぱなし（ノリの軸になる）
  let bed: StemSet["bed"] = null;
  if (drumPhrase) {
    const bedPcm = await render(drumPhrase, song.bpm, { dry: song.params.dry, drumsOnly: true, swing });
    // 音量（ドラムループの音量）は、ミキサーのフェーダー（@bed）で掛ける
    {
      const bedKey = JSON.stringify([cache ? cache.idOf(bedPcm) : 0, fxOn(song.fx.bed) ? song.fx.bed : null, collageOpts, song.bpm]);
      const bedStem = await cached(`bed|${bedKey}`, async () => {
        // 下地は1周ぶんの波形なので、曲の長さに並べてから掛ける（「いつ掛けるか」が曲の位置で決まるように）
        const full = renderCollage([], collageOpts);
        layBed(full, bedPcm, BED_GAIN);
        return fxOn(song.fx.bed) ? await applyTrack(full, song.fx.bed, fxEnv!) : full;
      });
      stems.push({ id: "bed", kind: "bed", channel: "bed", pcm: bedStem });
    }
    bed = { phraseId: drumPhrase.id, name: `${drumPhrase.name}のドラム`, events: bedEvents(drumPhrase, totalSteps) };
  }
  // SFX：区切りを聞かせる（8小節ごとのライザー・インパクト、4小節ごとのリバースシンバル）
  // 量（効果音の量）は掛け算だけなので、いちばん大きい量で作って、フェーダー（@sfx）で下げる
  {
    const sfx = await cached(`sfx|${JSON.stringify([grid, glueSeed])}`, () => {
      const out = renderCollage([], collageOpts);
      addSfx(out, grid, 1, createRng(glueSeed ^ 0x2f6b8a1d));
      return out;
    });
    stems.push({ id: "sfx", kind: "sfx", channel: "sfx", pcm: sfx });
  }
  return {
    stems,
    lanes: built.map((b) => b.view),
    bed,
    totalSteps,
    keyName: baseKey ? keyShortName(baseKey) : null,
    sampleRate,
    bpm: song.bpm,
    stepSamples,
    faders: songFaders({ lanes, params: song.params }),
    masterFx: song.fx.master,
  };
}

/** フェーダー（層ごとの音量・ミュート）を掛けて、ステムを全部足す。マスターのエフェクトの前の音。 */
export function sumStems(set: StemSet, faders: Record<string, number> = set.faders): Pcm {
  const n = set.stems[0]?.pcm.l.length ?? 1;
  const out: Pcm = { l: new Float32Array(n), r: new Float32Array(n) };
  for (const s of set.stems) {
    const g = stemFader(s, faders);
    if (g <= 0) continue;
    for (let i = 0; i < n; i++) {
      out.l[i] += s.pcm.l[i] * g;
      out.r[i] += s.pcm.r[i] * g;
    }
  }
  return out;
}

/** ミックスダウン：ステムを足して、全体のエフェクト → 仕上げのコンプ＋リミッター（音圧をそろえて、割れないようにする）。書き出しの音になる。 */
export async function mixdown(set: StemSet, reverb?: ReverbFn, faders: Record<string, number> = set.faders): Promise<Pcm> {
  const mixed = sumStems(set, faders);
  const fxEnv: FxEnv | null = reverb ? { stepSamples: set.stepSamples, sampleRate: set.sampleRate, bpm: set.bpm, reverb } : null;
  const mastered = fxEnv && !trackIsOff(set.masterFx) ? await applyTrack(mixed, set.masterFx!, fxEnv) : mixed;
  // 曲はくり返して鳴らすので、仕上げは、曲の頭を終わりからの続きとして処理する（再生中のミキサーと同じ音になる）
  return limitPeak(masterBusLoop(mastered, set.sampleRate));
}

/** 曲を作って、そのままミックスダウンした1本の波形で返す（ミュート・音量は曲の設定のとおり）。 */
export async function buildCollage(
  song: Song,
  phrases: Phrase[],
  render: (phrase: Phrase, bpm: number, opts: RenderOpts) => Promise<Pcm>,
  sampleRate: number,
  reverb?: ReverbFn,
  cache?: BuildCache,
): Promise<CollageResult | null> {
  const set = await buildStems(song, phrases, render, sampleRate, reverb, cache);
  if (!set) return null;
  return { pcm: await mixdown(set, reverb), lanes: set.lanes, bed: set.bed, totalSteps: set.totalSteps, keyName: set.keyName };
}
