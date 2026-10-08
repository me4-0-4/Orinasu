import { createRng } from "../theory/rng.ts";
import { keyShortName } from "../theory/key.ts";
import { totalBeats, type Phrase } from "../phrase/types.ts";
import { layBed, renderCollage, type CollageLane } from "./collage.ts";
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
export async function buildCollage(
  song: Song,
  phrases: Phrase[],
  render: (phrase: Phrase, bpm: number, opts: RenderOpts) => Promise<Pcm>,
  sampleRate: number,
): Promise<CollageResult | null> {
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
      const collage: CollageLane = { pcm, slices, events, keyShift, gain, holdFraction: holdFraction(params.hold, song.params.style) };
      const view: LaneView = {
        phraseId: phrase.id,
        name: phrase.name,
        locked: !!lane.locked,
        muted: !!lane.muted,
        events,
        sliceCount: slices.length,
      };
      return { collage, view };
    }),
  );
  const swing = song.params.swing;
  const mixed = renderCollage(built.map((b) => b.collage), { totalSteps, stepSamples, sampleRate, swing });
  // 下地：選んだ曲のドラムだけを、刻まずに鳴らしっぱなし（ノリの軸になる）
  const drumId = pickDrum(song, phrases);
  const drumPhrase = drumId ? phrases.find((p) => p.id === drumId && hasDrums(p)) : undefined;
  let bed: CollageResult["bed"] = null;
  if (drumPhrase) {
    const bedPcm = await render(drumPhrase, song.bpm, { dry: song.params.dry, drumsOnly: true, swing });
    layBed(mixed, bedPcm, BED_GAIN * song.params.bedVolume);
    bed = { phraseId: drumPhrase.id, name: `${drumPhrase.name}のドラム`, events: bedEvents(drumPhrase, totalSteps) };
  }
  const pcm = limitPeak(mixed);
  return { pcm, lanes: built.map((b) => b.view), bed, totalSteps, keyName: baseKey ? keyShortName(baseKey) : null };
}
