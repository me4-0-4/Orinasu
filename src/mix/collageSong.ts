import { createRng } from "../theory/rng.ts";
import { keyShortName } from "../theory/key.ts";
import type { Phrase } from "../phrase/types.ts";
import { renderCollage, type CollageLane } from "./collage.ts";
import { phraseKey, transposeSemitones } from "./keySync.ts";
import { limitPeak, type Pcm } from "./pcm.ts";
import { STEPS_PER_BEAT, planOrder, planRhythm, type LaneEvent } from "./sequencer.ts";
import { cutSlices } from "./slicer.ts";
import type { Lane, Song } from "./types.ts";

/** 刻む曲：音符のある曲だけ。選んだ順。 */
export function collectSources(song: Pick<Song, "materialIds">, phrases: Phrase[]): Phrase[] {
  const byId = new Map(phrases.map((p) => [p.id, p]));
  return song.materialIds
    .map((id) => byId.get(id))
    .filter((p): p is Phrase => !!p && p.layers.some((l) => l.notes.length > 0));
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

export interface LaneView {
  phraseId: string;
  name: string;
  locked: boolean;
  events: LaneEvent[];
  sliceCount: number;
}

export interface CollageResult {
  pcm: Pcm;
  lanes: LaneView[];
  totalSteps: number;
  /** 曲の調（いちばん上の層の曲の調）。分からなければ null。 */
  keyName: string | null;
}

/**
 * 曲を作る：層ごとに、曲を曲のBPMで1本の波形に書き出し、断片に切り、格子に打って、全部の層を重ねる。
 * フレーズ自身のBPMは関係ない。ほかの層の調は、いちばん上の層の調に寄せる。
 */
export async function buildCollage(
  song: Song,
  phrases: Phrase[],
  render: (phrase: Phrase, bpm: number) => Promise<Pcm>,
  sampleRate: number,
): Promise<CollageResult | null> {
  const sources = collectSources(song, phrases);
  const byId = new Map(sources.map((p) => [p.id, p]));
  const lanes = (song.lanes ?? []).filter((l) => byId.has(l.phraseId));
  if (lanes.length === 0) return null;
  const totalSteps = song.lengthBars * song.beatsPerBar * STEPS_PER_BEAT;
  const stepSamples = (sampleRate * 60) / song.bpm / STEPS_PER_BEAT;
  const baseKey = phraseKey(byId.get(lanes[0].phraseId)!);

  const built = await Promise.all(
    lanes.map(async (lane) => {
      const phrase = byId.get(lane.phraseId)!;
      const pcm = await render(phrase, song.bpm);
      const slices = cutSlices(pcm, sampleRate, { mode: song.params.mode, size: song.params.size }, createRng(lane.cutSeed));
      const hits = planRhythm(totalSteps, song.beatsPerBar, song.params, createRng(lane.rhythmSeed));
      const events = planOrder(hits, slices.length, song.params.motion, createRng(lane.orderSeed));
      const key = phraseKey(phrase);
      const keyShift = key && baseKey ? transposeSemitones(key, baseKey) : 0;
      const collage: CollageLane = { pcm, slices, events, keyShift };
      const view: LaneView = { phraseId: phrase.id, name: phrase.name, locked: !!lane.locked, events, sliceCount: slices.length };
      return { collage, view };
    }),
  );
  const pcm = limitPeak(renderCollage(built.map((b) => b.collage), { totalSteps, stepSamples, sampleRate }));
  return { pcm, lanes: built.map((b) => b.view), totalSteps, keyName: baseKey ? keyShortName(baseKey) : null };
}
