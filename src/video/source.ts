import { totalBeats, type Phrase } from "../phrase/types.ts";
import type { StemSet } from "../mix/collageSong.ts";
import { pickDrum } from "../mix/collageSong.ts";
import { STEPS_PER_BEAT } from "../mix/sequencer.ts";
import type { Song } from "../mix/types.ts";
import type { SrcNote, TimelineInput } from "./timeline.ts";

/** フレーズの音符をステップ単位に。drums＝true ならドラムの層だけ、false ならドラム以外。 */
export function phraseNotes(phrase: Phrase, drums: boolean): SrcNote[] {
  const out: SrcNote[] = [];
  for (const l of phrase.layers) {
    if (l.muted || (l.role === "drums") !== drums) continue;
    for (const n of l.notes) out.push({ pitch: n.pitch, start: n.startBeats * STEPS_PER_BEAT, len: Math.max(0.25, n.durationBeats * STEPS_PER_BEAT), vel: n.velocity });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 刻むタブで作った曲（ステム）から、映像の出来事を作る材料をそろえる。 */
export function timelineInput(set: StemSet, song: Song, phrases: Phrase[]): TimelineInput {
  const byId = new Map(phrases.map((p) => [p.id, p]));
  const loopOf = (p: Phrase | undefined): number => (p ? Math.max(1, Math.round(totalBeats(p) * STEPS_PER_BEAT)) : 16);
  const drumId = pickDrum(song, phrases);
  const drum = drumId ? byId.get(drumId) : undefined;
  return {
    totalSteps: set.totalSteps,
    stepsPerBar: song.beatsPerBar * STEPS_PER_BEAT,
    bpm: set.bpm,
    stepSamples: set.stepSamples,
    lanes: set.lanes
      .filter((l) => !l.muted)
      .map((l) => {
        const p = byId.get(l.phraseId);
        return { name: l.name, events: l.events, slices: l.slices, keyShift: l.keyShift, loopSteps: loopOf(p), notes: p ? phraseNotes(p, false) : [] };
      }),
    bed: drum && !song.bedMuted ? { notes: phraseNotes(drum, true), loopSteps: loopOf(drum) } : null,
    pad: (song.params.pad ?? 0) > 0,
  };
}
