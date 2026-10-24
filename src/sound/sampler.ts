/** サンプラー（読み込んだ音を鍵盤で鳴らす）の設定と、鳴らし方の計算。音を出す部分は audio/samplerEngine.ts。 */

/** 鍵盤型＝1つの音を音程を変えて弾く。パッド型＝切った断片を鍵盤に1つずつ並べて叩く。 */
export type SamplerMode = "keys" | "pads";
/** gate＝押している間だけ鳴る。oneshot＝押したら最後まで鳴る。 */
export type SamplerHold = "gate" | "oneshot";
/** パッド型の切り方：等分／音の頭（アタック）／拍（テンポが分かる音だけ）。 */
export type SliceCut = "divide" | "transient" | "beats";

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
  /** 逆さまに鳴らす。 */
  reverse: boolean;
  /** 鍵盤型：押している間、範囲をくり返す（「押している間だけ」のときだけ）。 */
  loop: boolean;
  /** パッド型：切れ目（音全体を 0〜1 とした位置。昇順。最初は 0）。断片 i は slices[i]〜slices[i+1]（最後は終わりまで）。 */
  slices: number[];
  /** パッド型：最後に使った切り方と、その細かさ。 */
  cut: SliceCut;
  /** 等分の数。 */
  divisions: number;
  /** 音の頭の拾いやすさ（0〜1）。 */
  sensitivity: number;
  /** 拍で切るとき、何拍ごとか（0.5＝8分、1＝1拍、4＝1小節…）。 */
  beatsPerSlice: number;
  /** 音のテンポ。あるときは、鳴らす曲のテンポに合わせて速さを変える（音の高さも一緒に変わる。レコードと同じ）。 */
  sourceBpm?: number;
}

/** パッド型：この鍵盤から右へ、断片を1つずつ並べる（C4＝PCキーボードの A）。 */
export const PAD_BASE_PITCH = 60;
export const MAX_SLICES = 64;

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
    reverse: false,
    loop: false,
    slices: divideSlices(8),
    cut: "divide",
    divisions: 8,
    sensitivity: 0.5,
    beatsPerSlice: 1,
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
    reverse: raw.reverse === true,
    loop: raw.loop === true,
    slices: normalizeSlices(Array.isArray(raw.slices) ? raw.slices : d.slices),
    cut: raw.cut === "transient" || raw.cut === "beats" ? raw.cut : "divide",
    divisions: Math.round(clamp(num(raw.divisions, d.divisions), 2, MAX_SLICES)),
    sensitivity: clamp(num(raw.sensitivity, d.sensitivity), 0, 1),
    beatsPerSlice: clamp(num(raw.beatsPerSlice, d.beatsPerSlice), 0.25, 16),
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

/** 切れ目を整える：0〜1 に収め、並べ、近すぎる所（1ms 相当未満）をまとめ、頭に 0 を入れる。多すぎたら前から MAX_SLICES まで。 */
export function normalizeSlices(raw: number[]): number[] {
  const sorted = raw.filter((v) => typeof v === "number" && Number.isFinite(v)).map((v) => clamp(v, 0, 0.999)).sort((a, b) => a - b);
  const out = [0];
  for (const v of sorted) if (v - out[out.length - 1] > 1e-4) out.push(Math.round(v * 1e5) / 1e5);
  return out.slice(0, MAX_SLICES);
}

/** 等分の切れ目。 */
export function divideSlices(n: number): number[] {
  const k = Math.round(clamp(n, 1, MAX_SLICES));
  return Array.from({ length: k }, (_, i) => Math.round((i / k) * 1e5) / 1e5);
}

/** 拍で切る切れ目（1拍目から beatsPerSlice 拍ごと。1拍目より前も拍の位置で切る）。テンポが無ければ null。 */
export function beatSlices(
  meta: { durationSec: number; bpm?: number; downbeatSec?: number },
  beatsPerSlice: number,
): number[] | null {
  if (!meta.bpm || meta.durationSec <= 0) return null;
  const step = (60 / meta.bpm) * beatsPerSlice;
  const start = meta.downbeatSec ?? 0;
  const out: number[] = [];
  for (let t = start - Math.floor(start / step) * step; t < meta.durationSec - 1e-6; t += step) out.push(t / meta.durationSec);
  return normalizeSlices(out);
}

/** 音の頭（サンプル位置）から切れ目。 */
export function onsetSlices(onsets: number[], totalSamples: number): number[] {
  if (totalSamples <= 0) return [0];
  return normalizeSlices(onsets.map((o) => o / totalSamples));
}

/** パッド型：この鍵盤で鳴らす断片の番号（鍵盤が断片より多いときは、くり返し並べる）。 */
export function sliceIndexFor(pitch: number, sliceCount: number): number {
  const n = Math.max(1, sliceCount);
  return (((pitch - PAD_BASE_PITCH) % n) + n) % n;
}

/** パッド型：断片 i の範囲（音全体を 0〜1）。 */
export function sliceRange(slices: number[], i: number): { start: number; end: number } {
  return { start: slices[i] ?? 0, end: slices[i + 1] ?? 1 };
}

/** この鍵盤を押したときに鳴らす範囲（0〜1）と速さ。鍵盤型は start〜end を高さに応じた速さで、パッド型は断片をそのままの速さで。 */
export function noteRegion(p: SamplerParams, pitch: number, tempo?: number): { start: number; end: number; rate: number } {
  const sync = p.sourceBpm && tempo ? tempo / p.sourceBpm : 1;
  if (p.mode === "pads") {
    const r = sliceRange(p.slices, sliceIndexFor(pitch, p.slices.length));
    return { ...r, rate: Math.pow(2, p.tune / 1200) * sync };
  }
  return { start: p.start, end: p.end, rate: playbackRate(pitch, p) * sync };
}

/** 逆さまに鳴らすとき、元の範囲（0〜1）を、逆さまの音の中の範囲に置き換える。 */
export function reversedRange(r: { start: number; end: number }): { start: number; end: number } {
  return { start: 1 - r.end, end: 1 - r.start };
}
