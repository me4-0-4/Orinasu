import type { Layer, Phrase } from "../phrase/types.ts";
import { makeId } from "../phrase/types.ts";

/** セクション内の層。組み替えで作った音符データを持つ（元のフレーズは触らない）。 */
export interface MixLayer extends Layer {
  /** 固定：振り直しても変えない。 */
  locked: boolean;
  /** 材料にした層（表示用）。 */
  sourceLabel?: string;
}

export interface Section {
  id: string;
  name: string;
  lengthBars: number;
  beatsPerBar: number;
  bpm: number;
  layers: MixLayer[];
  /** 調の自動合わせの基準にした調（なければ合わせない）。 */
  key?: { tonic: number; mode: "major" | "minor" };
  createdAt: number;
  updatedAt: number;
}

/** 曲：材料にするフレーズと、並べたセクション。1つだけ持つ（端末内）。 */
export interface Song {
  id: string;
  name: string;
  /** 材料に入れたフレーズのid。 */
  materialIds: string[];
  /** 並べた順。 */
  sections: Section[];
  updatedAt: number;
}

export const SONG_ID = "song";

export function createEmptySong(): Song {
  return { id: SONG_ID, name: "無題の曲", materialIds: [], sections: [], updatedAt: Date.now() };
}

export function sectionBeats(section: Pick<Section, "lengthBars" | "beatsPerBar">): number {
  return section.lengthBars * section.beatsPerBar;
}

export function createSection(
  name: string,
  base: Pick<Phrase, "bpm" | "beatsPerBar">,
  lengthBars: number,
  layers: MixLayer[],
  key?: Section["key"],
): Section {
  const now = Date.now();
  return {
    id: makeId("section"),
    name,
    lengthBars,
    beatsPerBar: base.beatsPerBar,
    bpm: base.bpm,
    layers,
    key,
    createdAt: now,
    updatedAt: now,
  };
}

/** セクションを複製する（層・音符のidも振り直す）。 */
export function duplicateSection(section: Section): Section {
  const now = Date.now();
  return {
    ...structuredClone(section),
    id: makeId("section"),
    name: `${section.name}のコピー`,
    layers: section.layers.map((l) => ({
      ...structuredClone(l),
      id: makeId("layer"),
      notes: l.notes.map((n) => ({ ...n, id: makeId("note") })),
    })),
    createdAt: now,
    updatedAt: now,
  };
}
