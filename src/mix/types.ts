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
  /** 全体の形からの「ずらし」（-1〜1）。無い項目は0（全体と同じ）。全体を動かすと、差を保ったまま一緒に動く。 */
  shift?: Partial<Record<ShapeKey, number>>;
  /** この層だけの切り方。無ければ全体と同じ。 */
  mode?: CutMode;
  /** 音量（0〜1.5）。無ければ1。 */
  volume?: number;
  muted?: boolean;
}

/** 層ごとにずらせる形のつまみ。 */
export type ShapeKey = "busy" | "breaks" | "onBeat" | "size" | "motion" | "hold";
export const SHAPE_KEYS: ShapeKey[] = ["busy", "breaks", "onBeat", "size", "motion", "hold"];
export const MAX_LANE_VOLUME = 1.5;

/**
 * 刻み方のモード。
 * music：音楽モード（拍の格子で切り、コードの流れと1拍目を守り、パターンをくり返す）。
 * material：素材モード（phrz風。アタックや等分で自由に切って、偶然で打つ）。
 */
export type ChopStyle = "music" | "material";

/** 形と切り方の設定。 */
export interface SongParams extends ShapeParams {
  style: ChopStyle;
  /** 切り方：アタックで切るか、等分に切るか。 */
  mode: CutMode;
  /** 余韻なし：刻む前の書き出しで、リバーブ・ディレイを外す（断片同士がにじまない）。 */
  dry: boolean;
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
  style: "music",
  mode: "transient",
  busy: 0.5,
  breaks: 0,
  onBeat: 0,
  size: 0.5,
  motion: 0,
  hold: 0.6,
  dry: true,
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 層に実際に効く形（全体＋ずらし、0〜1に収める）と切り方。 */
export function effectiveParams(global: SongParams, lane: Pick<Lane, "shift" | "mode">): SongParams {
  const out: SongParams = { ...global, mode: lane.mode ?? global.mode };
  for (const key of SHAPE_KEYS) out[key] = clamp01(global[key] + (lane.shift?.[key] ?? 0));
  return out;
}

/** 層が全体と違う設定を持っているか（ずらし・切り方・音量・ミュート）。 */
export function laneIsCustom(lane: Lane): boolean {
  const shifted = SHAPE_KEYS.some((k) => Math.abs(lane.shift?.[k] ?? 0) > 1e-9);
  return shifted || lane.mode !== undefined || (lane.volume !== undefined && lane.volume !== 1) || !!lane.muted;
}

/**
 * 層のつまみを、実際に効かせたい値 value にする：全体との差を「ずらし」として持つ。
 * 全体と同じ値なら、ずらしは消す。
 */
export function setLaneShape(lane: Lane, global: SongParams, key: ShapeKey, value: number): Lane {
  const shift = { ...lane.shift };
  const d = Math.round((clamp01(value) - global[key]) * 100) / 100;
  if (Math.abs(d) < 1e-9) delete shift[key];
  else shift[key] = d;
  const { shift: _old, ...rest } = lane;
  return Object.keys(shift).length === 0 ? rest : { ...rest, shift };
}

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
    if (lanes.length > 0) song.lanes = lanes.map(sanitizeLane);
  }
  if (typeof r.params === "object" && r.params !== null) {
    const p = r.params as Record<string, unknown>;
    for (const key of SHAPE_KEYS) {
      if (isNum(p[key])) song.params[key] = Math.min(1, Math.max(0, p[key]));
    }
    if (p.mode === "transient" || p.mode === "divide") song.params.mode = p.mode;
    if (typeof p.dry === "boolean") song.params.dry = p.dry;
    if (p.style === "music" || p.style === "material") song.params.style = p.style;
  }
  return song;
}

function sanitizeLane(raw: Lane): Lane {
  const lane: Lane = { phraseId: raw.phraseId, cutSeed: raw.cutSeed, rhythmSeed: raw.rhythmSeed, orderSeed: raw.orderSeed };
  if (raw.locked) lane.locked = true;
  if (raw.muted) lane.muted = true;
  if (raw.mode === "transient" || raw.mode === "divide") lane.mode = raw.mode;
  if (isNum(raw.volume)) lane.volume = Math.min(MAX_LANE_VOLUME, Math.max(0, raw.volume));
  if (typeof raw.shift === "object" && raw.shift !== null) {
    const shift: Partial<Record<ShapeKey, number>> = {};
    for (const key of SHAPE_KEYS) {
      const v = (raw.shift as Record<string, unknown>)[key];
      if (isNum(v) && v !== 0) shift[key] = Math.min(1, Math.max(-1, v));
    }
    if (Object.keys(shift).length > 0) lane.shift = shift;
  }
  return lane;
}
