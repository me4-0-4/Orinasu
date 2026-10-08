import type { Pcm } from "./pcm.ts";

/**
 * 自分で決めるエフェクト。掛ける所（全体・層ごと・下地・伸ばし）ごとに1組ずつ持つ。
 * 全部 0 なら何もしない。
 */
export interface FxSettings {
  /** リバーブの量（0〜1）。 */
  reverb: number;
  /** リバーブの長さ（0〜1。0で部屋くらい0.3秒、1でホールくらい6秒）。 */
  reverbSize: number;
  /** リバーブの明るさ（0〜1。0でこもった響き、1で明るい響き）。 */
  reverbTone: number;
  /** ディレイ（やまびこ）の量（0〜1）。 */
  delay: number;
  delayTime: DelayTime;
  /** ディレイのくり返し（0〜1。大きいほど長く残る）。 */
  delayFeedback: number;
  /** 低音を削る（0〜1。0で削らない、1で2000Hzより下を削る）。 */
  lowCut: number;
  /** 高音を削る（0〜1。0で削らない、1で300Hzより上を削る＝こもる）。 */
  highCut: number;
  /** 歪み（0〜1）。 */
  drive: number;
  /** 音質下げ（0〜1。ビット数とサンプルの細かさを下げる）。 */
  crush: number;
}

/** ディレイの間隔（音符の長さ）。1/8d は付点8分。 */
export type DelayTime = "1/16" | "1/8" | "1/8d" | "1/4";
export const DELAY_TIMES: DelayTime[] = ["1/16", "1/8", "1/8d", "1/4"];
const DELAY_BEATS: Record<DelayTime, number> = { "1/16": 0.25, "1/8": 0.5, "1/8d": 0.75, "1/4": 1 };

export const NO_FX: FxSettings = {
  reverb: 0,
  reverbSize: 0.35,
  reverbTone: 0.5,
  delay: 0,
  delayTime: "1/8d",
  delayFeedback: 0.35,
  lowCut: 0,
  highCut: 0,
  drive: 0,
  crush: 0,
};

/** 全体の初期：前の「仕上げの響き」と同じく、薄いリバーブだけ。 */
export const DEFAULT_MASTER_FX: FxSettings = { ...NO_FX, reverb: 0.15 };

/** 曲が持つエフェクト：全体・下地・伸ばし（層ごとのものは層が持つ）。 */
export interface SongFx {
  master: FxSettings;
  bed: FxSettings;
  pad: FxSettings;
}

export function defaultSongFx(): SongFx {
  return { master: { ...DEFAULT_MASTER_FX }, bed: { ...NO_FX }, pad: { ...NO_FX } };
}

const OFF = 0.01;

/** 何も掛からない設定か（音の処理を省ける）。 */
export function fxIsOff(fx: FxSettings | undefined): boolean {
  return !fx || (fx.reverb < OFF && fx.delay < OFF && fx.lowCut < OFF && fx.highCut < OFF && fx.drive < OFF && fx.crush < OFF);
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 保存されていた値を、エフェクトの設定にする（無い・おかしい値は base のまま）。 */
export function sanitizeFx(raw: unknown, base: FxSettings = NO_FX): FxSettings {
  const fx: FxSettings = { ...base };
  if (typeof raw !== "object" || raw === null) return fx;
  const r = raw as Record<string, unknown>;
  for (const key of ["reverb", "reverbSize", "reverbTone", "delay", "delayFeedback", "lowCut", "highCut", "drive", "crush"] as const) {
    const v = r[key];
    if (isNum(v)) fx[key] = clamp01(v);
  }
  if (DELAY_TIMES.includes(r.delayTime as DelayTime)) fx.delayTime = r.delayTime as DelayTime;
  return fx;
}

/** リバーブの長さ（秒）。 */
export const reverbSeconds = (size: number): number => 0.3 * Math.pow(20, clamp01(size));
/** リバーブの明るさ（響きの高い所を、何Hzから削るか）。 */
export const reverbToneHz = (tone: number): number => 1500 * Math.pow(8, clamp01(tone));
/** ディレイの間隔（秒）。 */
export const delaySeconds = (time: DelayTime, bpm: number): number => (DELAY_BEATS[time] * 60) / bpm;
/** ディレイのくり返しの強さ（1回ごとの残り）。 */
export const delayFeedbackGain = (feedback: number): number => 0.85 * clamp01(feedback);
/** 低音を削る周波数（Hz）。 */
export const lowCutHz = (v: number): number => 20 * Math.pow(100, clamp01(v));
/** 高音を削る周波数（Hz）。 */
export const highCutHz = (v: number): number => 20000 * Math.pow(300 / 20000, clamp01(v));

/**
 * 歪みと音質下げ（波形を直接いじる）。
 * 歪み：tanh で丸める（大きいほど強く）。持ち上げたぶん √k で割って、音量をだいたいそろえる。
 * 音質下げ：サンプルを何個かずつ止め（細かさを下げる）、ビット数を下げる（16→4ビット）。
 */
export function applyDrive(pcm: Pcm, drive: number, crush: number): Pcm {
  const d = clamp01(drive);
  const c = clamp01(crush);
  if (d < OFF && c < OFF) return pcm;
  const out: Pcm = { l: new Float32Array(pcm.l.length), r: new Float32Array(pcm.r.length) };
  const k = 1 + 14 * d;
  const norm = Math.sqrt(k);
  const hold = c < OFF ? 1 : 1 + Math.round(15 * c);
  const levels = c < OFF ? 0 : Math.pow(2, 16 - 12 * c) / 2;
  for (const [src, dst] of [
    [pcm.l, out.l],
    [pcm.r, out.r],
  ] as const) {
    let held = 0;
    for (let i = 0; i < src.length; i++) {
      if (i % hold === 0) {
        let x = src[i];
        if (d >= OFF) x = Math.tanh(x * k) / norm;
        if (levels > 0) x = Math.round(x * levels) / levels;
        held = x;
      }
      dst[i] = held;
    }
  }
  return out;
}
