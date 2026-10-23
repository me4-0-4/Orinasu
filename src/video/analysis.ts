import type { Pcm } from "../mix/pcm.ts";

/** 高速フーリエ変換（その場で書き換える）。n は2のべき乗。 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export const BANDS = 40;
/** 1ステップ（16分）を何コマに分けて解析するか。 */
export const FRAMES_PER_STEP = 4;
const FFT_SIZE = 2048;
const LO_HZ = 40, HI_HZ = 16000;

/** 帯域の境目（Hz）。40Hz〜16kHz を対数で等分。 */
export function bandEdges(): number[] {
  const out: number[] = [];
  for (let i = 0; i <= BANDS; i++) out.push(LO_HZ * Math.pow(HI_HZ / LO_HZ, i / BANDS));
  return out;
}

export interface Analysis {
  frames: number;
  /** コマごとの音量（0〜1。-48dB〜0dB を並べ直したもの）。 */
  loud: Float32Array;
  /** コマごとの帯域（BANDS 個ずつ、0〜1。-66dB〜-6dB）。 */
  spec: Float32Array;
  /** 左右の広がり（0＝真ん中だけ、1＝左右ばらばら）。 */
  width: Float32Array;
}

const toUnit = (db: number, lo: number, hi: number): number => Math.min(1, Math.max(0, (db - lo) / (hi - lo)));

/** 曲の波形を、ステップの格子にそろえて解析する（書き出しと同じ結果になるよう、先に全部計算しておく）。 */
export function analyze(pcm: Pcm, sampleRate: number, stepSamples: number, totalSteps: number): Analysis {
  const frames = totalSteps * FRAMES_PER_STEP;
  const hop = stepSamples / FRAMES_PER_STEP;
  const loud = new Float32Array(frames), spec = new Float32Array(frames * BANDS), width = new Float32Array(frames);
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
  const win = new Float64Array(FFT_SIZE).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  const edges = bandEdges().map((hz) => (hz * FFT_SIZE) / sampleRate);
  const n = pcm.l.length;
  for (let f = 0; f < frames; f++) {
    const center = Math.round(f * hop);
    let sum = 0, side = 0, mid = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      // 曲はくり返すので、端は反対側から取る
      const k = (((center - FFT_SIZE / 2 + i) % n) + n) % n;
      const l = pcm.l[k], r = pcm.r[k], m = (l + r) / 2;
      re[i] = m * win[i];
      im[i] = 0;
      sum += m * m;
      mid += m * m;
      side += ((l - r) / 2) ** 2;
    }
    loud[f] = toUnit(10 * Math.log10(sum / FFT_SIZE + 1e-12) + 3, -48, 0);
    width[f] = Math.min(1, Math.sqrt(side / (mid + 1e-12)));
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      const a = Math.max(1, Math.floor(edges[b])), z = Math.max(a + 1, Math.ceil(edges[b + 1]));
      let e = 0;
      for (let k = a; k < z && k < FFT_SIZE / 2; k++) e = Math.max(e, re[k] * re[k] + im[k] * im[k]);
      // 窓の分（およそ半分）を戻して、サイン波の振幅1が 0dB くらいになるようにする
      spec[f * BANDS + b] = toUnit(10 * Math.log10((4 * e) / (FFT_SIZE * FFT_SIZE) + 1e-12), -66, -6);
    }
  }
  return { frames, loud, spec, width };
}

/** ステップ位置 S（小数あり）のコマ。曲の長さでくり返す。 */
export function frameAt(an: Analysis, S: number): number {
  const f = Math.floor(S * FRAMES_PER_STEP);
  return ((f % an.frames) + an.frames) % an.frames;
}
export const loudAt = (an: Analysis, S: number): number => an.loud[frameAt(an, S)];
export function specAt(an: Analysis, S: number): number[] {
  const f = frameAt(an, S);
  return Array.from(an.spec.subarray(f * BANDS, f * BANDS + BANDS));
}
