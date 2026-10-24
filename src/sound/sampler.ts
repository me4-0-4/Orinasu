/** サンプラー（読み込んだ音を鍵盤で鳴らす）の設定と、鳴らし方の計算。音を出す部分は audio/samplerEngine.ts。 */

/** 鍵盤型＝1つの音を音程を変えて弾く。パッド型＝切った断片を鍵盤に1つずつ並べて叩く。 */
export type SamplerMode = "keys" | "pads";
/** gate＝押している間だけ鳴る。oneshot＝押したら最後まで鳴る。 */
export type SamplerHold = "gate" | "oneshot";

export interface SamplerParams {
  soundId: string;
  mode: SamplerMode;
  /** 鍵盤型：この鍵盤で、元の高さで鳴る（MIDIノート番号）。 */
  rootPitch: number;
  /** 細かい音程（セント、-100〜100）。 */
  tune: number;
  /** 使う範囲（音全体を 0〜1 とした位置）。 */
  start: number;
  end: number;
  /** 立ち上がり・消え方（秒）。 */
  attack: number;
  release: number;
  hold: SamplerHold;
}

export const SAMPLER_ROOT_DEFAULT = 60;
export const MAX_ATTACK = 2;
export const MAX_RELEASE = 4;

export function defaultSamplerParams(soundId: string): SamplerParams {
  return {
    soundId,
    mode: "keys",
    rootPitch: SAMPLER_ROOT_DEFAULT,
    tune: 0,
    start: 0,
    end: 1,
    attack: 0.003,
    release: 0.08,
    hold: "gate",
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 保存されていた設定の足りない所を補う。 */
export function migrateSamplerParams(raw: Partial<SamplerParams> & { soundId: string }): SamplerParams {
  const d = defaultSamplerParams(raw.soundId);
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const start = clamp(num(raw.start, d.start), 0, 1);
  return {
    soundId: raw.soundId,
    mode: raw.mode === "pads" ? "pads" : "keys",
    rootPitch: Math.round(clamp(num(raw.rootPitch, d.rootPitch), 0, 127)),
    tune: clamp(num(raw.tune, d.tune), -100, 100),
    start,
    end: clamp(num(raw.end, d.end), start, 1),
    attack: clamp(num(raw.attack, d.attack), 0, MAX_ATTACK),
    release: clamp(num(raw.release, d.release), 0, MAX_RELEASE),
    hold: raw.hold === "oneshot" ? "oneshot" : "gate",
  };
}

/** 鍵盤型：この鍵盤を押したときの再生の速さ（2 で1オクターブ上）。 */
export function playbackRate(pitch: number, p: Pick<SamplerParams, "rootPitch" | "tune">): number {
  return Math.pow(2, (pitch - p.rootPitch) / 12 + p.tune / 1200);
}

/** 鳴らす範囲（秒）。短すぎる範囲にはしない。 */
export function playRegion(p: Pick<SamplerParams, "start" | "end">, durationSec: number): { offset: number; length: number } {
  const min = Math.min(0.005, durationSec);
  const start = Math.min(clamp(p.start, 0, 1) * durationSec, durationSec - min);
  const end = clamp(p.end, 0, 1) * durationSec;
  return { offset: start, length: Math.max(min, end - start) };
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** 音の名前（60＝C4）。 */
export function pitchName(pitch: number): string {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}
