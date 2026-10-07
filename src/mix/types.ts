import type { CutMode } from "./slicer.ts";
import type { ShapeParams } from "./sequencer.ts";

/**
 * 層：刻む曲（フレーズ）1つが、1本の層。曲はまるごと1本の波形として扱い、中身（ドラム・ベースなど）には分けない。
 * 層ごとに、切り方・リズム・順番の乱数の種を持つ（種が同じなら、同じ刻み方になる）。
 */
export interface Lane {
  phraseId: string;
  cutSeed: number;
  rhythmSeed: number;
  orderSeed: number;
  /** 固定：刻み直しても、この層は変えない。 */
  locked?: boolean;
}

/** 形と切り方の設定。 */
export interface SongParams extends ShapeParams {
  /** 切り方：アタックで切るか、等分に切るか。 */
  mode: CutMode;
  /** 断片の長さ（0〜1）。 */
  size: number;
}

/**
 * 曲：刻む曲（フレーズ）と、層ごとの刻み方の種。1つだけ持つ（端末内）。
 * 刻んだ音そのものは保存せず、種と設定から作り直す。
 */
export interface Song {
  id: string;
  name: string;
  /** 刻む曲（フレーズ）のid。選んだ順に層になる。 */
  materialIds: string[];
  /** 刻んだあとの曲のBPM。フレーズ自身のBPMとは無関係（フレーズは、この曲のテンポに合わせて鳴る）。 */
  bpm: number;
  beatsPerBar: number;
  /** 曲の長さ（小節）。 */
  lengthBars: number;
  /** 層。まだ刻んでいなければ無い。 */
  lanes?: Lane[];
  params: SongParams;
  updatedAt: number;
}

export const SONG_ID = "song";

export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const LENGTH_OPTIONS = [4, 8, 16, 32];
export const DEFAULT_BPM = 120;

export const DEFAULT_PARAMS: SongParams = {
  mode: "transient",
  busy: 0.5,
  breaks: 0,
  onBeat: 0,
  size: 0.5,
  motion: 0,
};

export function createEmptySong(): Song {
  return {
    id: SONG_ID,
    name: "無題の曲",
    materialIds: [],
    bpm: DEFAULT_BPM,
    beatsPerBar: 4,
    lengthBars: 4,
    params: { ...DEFAULT_PARAMS },
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

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * 保存されていたデータを、いまの曲の形にする。
 * 古い形（セクションを並べた曲、小節ごとの刻み方の計画）からは、名前・選んだ曲・BPM・長さだけを引き継ぐ。
 */
export function migrateSong(raw: unknown): Song {
  const base = createEmptySong();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const song: Song = { ...base, updatedAt: isNum(r.updatedAt) ? r.updatedAt : base.updatedAt };
  if (typeof r.name === "string" && r.name) song.name = r.name;
  if (Array.isArray(r.materialIds)) song.materialIds = r.materialIds.filter((x): x is string => typeof x === "string");
  if (isNum(r.bpm) && r.bpm >= MIN_BPM && r.bpm <= MAX_BPM) song.bpm = Math.round(r.bpm);
  if (isNum(r.beatsPerBar) && r.beatsPerBar >= 1 && r.beatsPerBar <= 12) song.beatsPerBar = Math.round(r.beatsPerBar);
  if (isNum(r.lengthBars) && LENGTH_OPTIONS.includes(r.lengthBars)) song.lengthBars = r.lengthBars;
  if (Array.isArray(r.lanes)) {
    const lanes = r.lanes.filter(
      (l): l is Lane =>
        typeof l === "object" && l !== null && typeof (l as Lane).phraseId === "string" &&
        isNum((l as Lane).cutSeed) && isNum((l as Lane).rhythmSeed) && isNum((l as Lane).orderSeed),
    );
    if (lanes.length > 0) song.lanes = lanes;
  }
  if (typeof r.params === "object" && r.params !== null) {
    const p = r.params as Record<string, unknown>;
    for (const key of ["busy", "breaks", "onBeat", "size", "motion"] as const) {
      if (isNum(p[key])) song.params[key] = Math.min(1, Math.max(0, p[key]));
    }
    if (p.mode === "transient" || p.mode === "divide") song.params.mode = p.mode;
  }
  return song;
}
