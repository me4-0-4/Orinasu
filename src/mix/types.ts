import type { CutMode } from "./slicer.ts";
import type { ShapeParams } from "./sequencer.ts";
import {
  defaultSongFx,
  newPlugin,
  sanitizeTakes,
  sanitizeTrack,
  trackHasFx,
  type LegacyContext,
  type SongFx,
  type TakeFx,
  type TrackFx,
} from "./fx.ts";
import { sanitizeGroups, type HitGroup } from "./groups.ts";

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
  /** 定位（-1で左、0で真ん中、1で右）。無ければ真ん中。ミキサーのパン（断片ごとのパンとは別）。 */
  balance?: number;
  muted?: boolean;
  /** この層（トラック）のエフェクト：FXチェーンとエンベロープ。無ければ掛けない（マスターのエフェクトは別に掛かる）。 */
  fx?: TrackFx;
  /** 断片ごとのエフェクト（テイクFX）。この層のトラックFXより先に掛かる。 */
  takes?: TakeFx[];
}

/** 層ごとにずらせる形のつまみ。 */
export type ShapeKey = "busy" | "breaks" | "onBeat" | "size" | "motion" | "hold" | "crisp" | "pan" | "fx";
export const SHAPE_KEYS: ShapeKey[] = ["busy", "breaks", "onBeat", "size", "motion", "hold", "crisp", "pan", "fx"];
export const MAX_LANE_VOLUME = 1.5;

/**
 * 刻み方のモード。
 * music：音楽モード（拍の格子で切り、コードの流れと1拍目を守り、パターンをくり返す）。
 * material：素材モード（phrz風。アタックや等分で自由に切って、偶然で打つ）。
 */
export type ChopStyle = "music" | "material";

/**
 * 層が複数のときの組み方（音楽モード）。
 * mix：混ぜる（1つのリズムを全部の層で作る。打つ1回ごとに、どの曲の断片を使うかを偶然で決める。決めた割り当てもパターンと一緒にくり返す）。
 * call：掛け合い（小節の前半2拍と後半2拍を、別の層が受け持つ。4小節ごとに呼ぶ側が替わる）。
 * swap：交代（4小節ごとに、鳴らす層が替わる）。
 */
export type TurnStyle = "mix" | "call" | "swap";

/** 形と切り方の設定。 */
export interface SongParams extends ShapeParams {
  style: ChopStyle;
  /** 切り方：アタックで切るか、等分に切るか。 */
  mode: CutMode;
  /** 余韻なし：刻む前の書き出しで、リバーブ・ディレイを外す（断片同士がにじまない）。 */
  dry: boolean;
  /** 断片の長さ（0〜1）。 */
  size: number;
  /** スウィング（0〜1）：16分の裏を後ろにずらす。1で3連符のはね。下地のドラムにも掛かる。 */
  swing: number;
  /** 層が複数のときの組み方（音楽モード）。 */
  turns: TurnStyle;
  /** 下地（鳴らしっぱなしのドラム）の音量（0〜1）。 */
  bedVolume: number;
  /** SFX（0〜1）：区切りに、ライザー・インパクトとクラッシュ・リバースシンバルを入れる量。 */
  sfx: number;
  /** 伸ばし（0〜1）：元の曲の和音を引き伸ばして、うしろでうっすら鳴らす量。 */
  pad: number;
  /** ポンピング（0〜1）：下地のキックに合わせて、刻んだ音を沈ませる深さ。 */
  pump: number;
  /** マスターの音量（0〜1）。コンプ・リミッターのあとに掛ける。 */
  master: number;
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
  /**
   * 下地：どのフレーズのドラムを、刻まずに鳴らしっぱなしにするか（そのフレーズのドラムだけを書き出して、くり返す）。
   * null は下地なし。無い（undefined）ときは、刻むときに、ドラムのある最初の材料を選ぶ。
   */
  drumId?: string | null;
  /** 下地（ドラムループ）のミュート。音量はそのまま残る。 */
  bedMuted?: boolean;
  /** エフェクト：全体・下地・伸ばし（層ごとのものは層が持つ）。 */
  fx: SongFx;
  /** 層。まだ刻んでいなければ無い。 */
  lanes?: Lane[];
  /** グループ：選んだ断片のまとまり（まとめて刻み方・ミュート・FXを変える）。 */
  groups?: HitGroup[];
  params: SongParams;
  /** 「保存した曲」から開いた曲なら、そのid（「保存」で上書きする先）。作業中の曲にだけ付く。 */
  savedId?: string;
  updatedAt: number;
}

/** 作業中の曲（自動で保存される）のid。 */
export const SONG_ID = "song";
/** 「保存した曲」のidの頭。作業中の曲と同じ保存場所に、別のidで入れる。 */
export const SAVED_SONG_PREFIX = "saved_";

/** 保存した曲か（作業中の曲ではなく、名前を付けて残した曲）。 */
export const isSavedSongId = (id: string): boolean => id.startsWith(SAVED_SONG_PREFIX);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** 2つの曲の中身が同じか（id・更新時刻・どの保存した曲から開いたか、は見ない）。 */
export function sameSongContent(a: Song, b: Song): boolean {
  const strip = ({ id: _id, updatedAt: _u, savedId: _s, ...rest }: Song) => rest;
  return JSON.stringify(canonical(strip(a))) === JSON.stringify(canonical(strip(b)));
}

/** 作業中の曲を、名前を付けて残すための写し（idは保存先のid）。 */
export function snapshotSong(song: Song, id: string, now = Date.now()): Song {
  const { savedId: _s, ...rest } = structuredClone(song);
  return { ...rest, id, updatedAt: now };
}

/** 保存した曲を、作業中の曲として開くための写し。 */
export function openedSong(saved: Song): Song {
  return { ...structuredClone(saved), id: SONG_ID, savedId: saved.id };
}

export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const LENGTH_OPTIONS = [8, 16, 32, 64];
export const DEFAULT_BPM = 120;

export const DEFAULT_PARAMS: SongParams = {
  style: "music",
  mode: "transient",
  busy: 0.5,
  breaks: 0,
  onBeat: 0,
  size: 0.5,
  motion: 0.3,
  hold: 0.6,
  crisp: 0.5,
  pan: 0.5,
  fx: 0.7,
  dry: true,
  swing: 0,
  turns: "mix",
  bedVolume: 0.8,
  sfx: 0.6,
  pad: 0.5,
  pump: 0.5,
  master: 1,
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
  return shifted || lane.mode !== undefined || (lane.volume !== undefined && lane.volume !== 1) || lane.balance !== undefined || !!lane.muted || trackHasFx(lane.fx) || (lane.takes?.length ?? 0) > 0;
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
    lengthBars: 16,
    params: { ...DEFAULT_PARAMS },
    fx: defaultSongFx(),
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
  if (typeof r.drumId === "string" || r.drumId === null) song.drumId = r.drumId;
  if (r.bedMuted === true) song.bedMuted = true;
  if (typeof r.savedId === "string" && isSavedSongId(r.savedId)) song.savedId = r.savedId;
  if (Array.isArray(r.lanes)) {
    const lanes = r.lanes.filter(
      (l): l is Lane =>
        typeof l === "object" && l !== null && typeof (l as Lane).phraseId === "string" &&
        isNum((l as Lane).cutSeed) && isNum((l as Lane).rhythmSeed) && isNum((l as Lane).orderSeed),
    );
    const legacy: LegacyContext = { stepsPerBar: song.beatsPerBar * 4, bars: song.lengthBars };
    if (lanes.length > 0) song.lanes = lanes.map((l) => sanitizeLane(l, legacy));
  }
  if (typeof r.params === "object" && r.params !== null) {
    const p = r.params as Record<string, unknown>;
    for (const key of SHAPE_KEYS) {
      if (isNum(p[key])) song.params[key] = Math.min(1, Math.max(0, p[key]));
    }
    if (p.mode === "transient" || p.mode === "divide") song.params.mode = p.mode;
    if (typeof p.dry === "boolean") song.params.dry = p.dry;
    // 前の「仕上げの響き」は、全体のリバーブの量にする
    if (isNum(p.reverb)) song.fx.master = { chain: p.reverb > 0 ? [newPlugin("reverb", { amount: Math.min(1, p.reverb) })] : [], envelopes: [] };
    if (p.style === "music" || p.style === "material") song.params.style = p.style;
    if (isNum(p.swing)) song.params.swing = Math.min(1, Math.max(0, p.swing));
    for (const key of ["bedVolume", "sfx", "pad", "pump", "master"] as const) {
      if (isNum(p[key])) song.params[key] = Math.min(1, Math.max(0, p[key]));
    }
    if (p.turns === "mix" || p.turns === "call" || p.turns === "swap") song.params.turns = p.turns;
  }
  const groups = sanitizeGroups(r.groups);
  if (groups.length > 0) song.groups = groups;
  if (typeof r.fx === "object" && r.fx !== null) {
    const fx = r.fx as Record<string, unknown>;
    const legacy: LegacyContext = { stepsPerBar: song.beatsPerBar * 4, bars: song.lengthBars };
    song.fx = {
      master: fx.master === undefined ? song.fx.master : sanitizeTrack(fx.master, legacy),
      bed: sanitizeTrack(fx.bed, legacy),
      pad: sanitizeTrack(fx.pad, legacy),
    };
  }
  return song;
}

function sanitizeLane(raw: Lane, legacy: LegacyContext): Lane {
  const lane: Lane = { phraseId: raw.phraseId, cutSeed: raw.cutSeed, rhythmSeed: raw.rhythmSeed, orderSeed: raw.orderSeed };
  if (raw.locked) lane.locked = true;
  if (raw.muted) lane.muted = true;
  if (raw.mode === "transient" || raw.mode === "divide") lane.mode = raw.mode;
  if (isNum(raw.volume)) lane.volume = Math.min(MAX_LANE_VOLUME, Math.max(0, raw.volume));
  if (isNum(raw.balance) && Math.abs(raw.balance) > 1e-9) lane.balance = Math.min(1, Math.max(-1, raw.balance));
  // 前の形の「選んだ断片だけ」のエフェクトは、断片ごとのテイクFXになる
  const takes = sanitizeTakes(raw.takes);
  if (typeof raw.fx === "object" && raw.fx !== null) {
    const fx = sanitizeTrack(raw.fx, legacy, takes);
    if (fx.chain.length > 0) lane.fx = fx;
  }
  if (takes.length > 0) lane.takes = takes.sort((a, b) => a.step - b.step);
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
