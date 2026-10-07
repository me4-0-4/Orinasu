import type { ChopParams, ChopSegment } from "./chop.ts";

/**
 * 曲：刻むために選んだ曲（フレーズ）と、刻み方の計画。1つだけ持つ（端末内）。
 * 刻んだ音そのものは保存せず、計画から作り直す。
 */
export interface Song {
  id: string;
  name: string;
  /** 刻む曲（フレーズ）のid。 */
  materialIds: string[];
  /** 刻んだあとの曲のBPM。フレーズ自身のBPMとは無関係（フレーズは、この曲のテンポに合わせて鳴る）。 */
  bpm: number;
  beatsPerBar: number;
  /** 曲の長さ（小節）。 */
  lengthBars: number;
  /** 刻み方の計画。まだ刻んでいなければ無い。 */
  plan?: ChopSegment[];
  /** 計画のメインにした曲（フレーズ）のid。 */
  baseId?: string;
  /** 刻み方のスライダー。 */
  chop?: ChopParams;
  updatedAt: number;
}

export const SONG_ID = "song";

export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const LENGTH_OPTIONS = [4, 8, 16, 32];
export const DEFAULT_BPM = 120;

export function createEmptySong(): Song {
  return {
    id: SONG_ID,
    name: "無題の曲",
    materialIds: [],
    bpm: DEFAULT_BPM,
    beatsPerBar: 4,
    lengthBars: 8,
    updatedAt: Date.now(),
  };
}

/** 曲の長さ（秒）。 */
export function songSeconds(song: Pick<Song, "lengthBars" | "beatsPerBar" | "bpm">): number {
  return (song.lengthBars * song.beatsPerBar * 60) / song.bpm;
}

/** 秒を「1:05」の形にする。 */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 保存されていたデータを、いまの曲の形にする。
 * 古い形（セクションを並べた曲）からは、名前・選んだ曲・BPMだけを引き継ぐ。
 */
export function migrateSong(raw: unknown): Song {
  const base = createEmptySong();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const song: Song = { ...base, updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : base.updatedAt };
  if (typeof r.name === "string" && r.name) song.name = r.name;
  if (Array.isArray(r.materialIds)) song.materialIds = r.materialIds.filter((x): x is string => typeof x === "string");
  if (typeof r.bpm === "number" && r.bpm >= MIN_BPM && r.bpm <= MAX_BPM) song.bpm = Math.round(r.bpm);
  if (typeof r.beatsPerBar === "number" && r.beatsPerBar >= 1 && r.beatsPerBar <= 12) song.beatsPerBar = Math.round(r.beatsPerBar);
  if (typeof r.lengthBars === "number" && LENGTH_OPTIONS.includes(r.lengthBars)) song.lengthBars = r.lengthBars;
  if (Array.isArray(r.plan) && r.plan.length > 0 && typeof r.baseId === "string") {
    song.plan = r.plan as ChopSegment[];
    song.baseId = r.baseId;
  }
  if (typeof r.chop === "object" && r.chop !== null) song.chop = r.chop as ChopParams;
  return song;
}
