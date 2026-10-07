import type { Layer, Phrase } from "../phrase/types.ts";
import { makeId } from "../phrase/types.ts";
import { defaultCurve, defaultMacros, type EnergyCurve, type Macro } from "./energy.ts";

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
  /** 曲全体のBPM。未設定なら、各セクションが持つBPM（最初に選んだ材料のもの）のまま。 */
  bpm?: number;
  /** 盛り上がりの山を曲に効かせるか。無い・false なら効かせない（初期はオフ）。 */
  energyOn?: boolean;
  /** 盛り上がりの山（曲全体を0〜1に正規化した線）。古いデータには無い。 */
  energy?: EnergyCurve;
  /** 山が動かすもの（マクロ）の設定。古いデータには無い。 */
  macros?: Macro[];
  updatedAt: number;
}

export const SONG_ID = "song";

export function createEmptySong(): Song {
  return {
    id: SONG_ID,
    name: "無題の曲",
    materialIds: [],
    sections: [],
    energyOn: false,
    energy: defaultCurve(),
    macros: defaultMacros(),
    updatedAt: Date.now(),
  };
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

export const MIN_BPM = 40;
export const MAX_BPM = 240;

/** 曲のBPMを反映したセクション（鳴らす・長さを数えるときに使う）。層や音符は同じものを指す。 */
export function effectiveSections(song: Pick<Song, "sections" | "bpm">): Section[] {
  const bpm = song.bpm;
  return bpm ? song.sections.map((s) => ({ ...s, bpm })) : song.sections;
}

export function sectionSeconds(section: Pick<Section, "lengthBars" | "beatsPerBar" | "bpm">): number {
  return (sectionBeats(section) * 60) / section.bpm;
}

/** 並べたセクション全体の長さ（秒）。 */
export function songSeconds(song: Pick<Song, "sections" | "bpm">): number {
  return effectiveSections(song).reduce((sum, s) => sum + sectionSeconds(s), 0);
}

/** 秒を「1:05」の形にする。 */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
