import { isSilent, type ChopSegment } from "./chop.ts";

/** ステレオの波形。 */
export interface Pcm {
  l: Float32Array;
  r: Float32Array;
}

export interface ChopInput {
  plan: ChopSegment[];
  /** 曲の長さ（拍）。 */
  dstBeats: number;
  /** 曲のBPM（フレーズのBPMとは無関係）。 */
  bpm: number;
  sampleRate: number;
  /**
   * 曲（フレーズ）を、曲のBPM×rate のテンポで書き出した1周ぶんの波形。無ければ無音。
   * 倍速・半速の区間は、その速さで書き出した波形から取る（音程は変わらない）。
   */
  getSource: (from: string, rate: number) => Pcm | undefined;
  /** 曲（フレーズ）の長さ（拍）。 */
  beatsOf: (from: string) => number;
}

const EPS = 1e-6;
/** 断片の継ぎ目のプチ音を消す、短いフェード（秒）。 */
const FADE_SECONDS = 0.004;

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** 区間 a のあとに b が、途切れず続いて聞こえるか（同じ曲の同じ速さで、位置がつながる）。 */
function continues(a: ChopSegment, b: ChopSegment, beatsOf: (from: string) => number): boolean {
  if (isSilent(a) || isSilent(b)) return false;
  if (a.from !== b.from || a.reverse || b.reverse || a.pitch || b.pitch) return false;
  const ra = a.rate ?? 1;
  if (ra !== (b.rate ?? 1)) return false;
  const beats = beatsOf(a.from);
  if (beats <= 0) return false;
  const gap = mod(a.src + a.len * ra - b.src, beats);
  return gap < EPS || beats - gap < EPS;
}

/**
 * 計画どおりに、曲の波形を切り貼りして1本の波形にする。
 * 継ぎ目が途切れず続く所はそのまま、切れる所だけ短いフェードを掛ける。
 */
export function chopPcm(input: ChopInput): Pcm {
  const { plan, dstBeats, bpm, sampleRate, getSource, beatsOf } = input;
  const samplesPerBeat = (sampleRate * 60) / bpm;
  const total = Math.max(1, Math.round(dstBeats * samplesPerBeat));
  const out: Pcm = { l: new Float32Array(total), r: new Float32Array(total) };
  const segs = plan.slice().sort((a, b) => a.dst - b.dst);

  segs.forEach((seg, i) => {
    if (isSilent(seg)) return;
    const rate = seg.rate ?? 1;
    const src = getSource(seg.from, rate);
    const beats = beatsOf(seg.from);
    if (!src || beats <= 0 || src.l.length === 0) return;
    const srcLen = src.l.length;
    const start = Math.round(seg.dst * samplesPerBeat);
    const end = Math.min(total, Math.round((seg.dst + seg.len) * samplesPerBeat));
    const len = end - start;
    if (len <= 0) return;
    // 曲のどこから読むか：曲の頭からの拍を、書き出した波形のサンプル位置に直す
    const pos = Math.round((mod(seg.src, beats) * srcLen) / beats);

    const prev = segs[(i - 1 + segs.length) % segs.length];
    const next = segs[(i + 1) % segs.length];
    const fadeIn = !continues(prev, seg, beatsOf);
    const fadeOut = !continues(seg, next, beatsOf);
    const fade = Math.min(Math.floor(FADE_SECONDS * sampleRate), Math.floor(len / 2));

    // 音程：再生の速さごと変える（サンプラーと同じ）。ratio が2なら1オクターブ上で、読む量も2倍
    const ratio = seg.pitch ? Math.pow(2, seg.pitch / 12) : 1;
    for (let k = 0; k < len; k++) {
      const t = seg.reverse ? len - 1 - k : k;
      let g = 1;
      if (fade > 0) {
        if (fadeIn && k < fade) g = k / fade;
        if (fadeOut && len - 1 - k < fade) g = Math.min(g, (len - 1 - k) / fade);
      }
      if (ratio === 1) {
        const idx = (pos + t) % srcLen;
        out.l[start + k] += src.l[idx] * g;
        out.r[start + k] += src.r[idx] * g;
      } else {
        const x = pos + t * ratio;
        const i0 = Math.floor(x);
        const f = x - i0;
        const a = i0 % srcLen;
        const b = (i0 + 1) % srcLen;
        out.l[start + k] += (src.l[a] * (1 - f) + src.l[b] * f) * g;
        out.r[start + k] += (src.r[a] * (1 - f) + src.r[b] * f) * g;
      }
    }
  });
  return out;
}

/** 音が割れないよう、ピークが ceiling を超えるときだけ、全体の音量を下げる。 */
export function limitPeak(pcm: Pcm, ceiling = 0.98): Pcm {
  let peak = 0;
  for (let i = 0; i < pcm.l.length; i++) peak = Math.max(peak, Math.abs(pcm.l[i]), Math.abs(pcm.r[i]));
  if (peak <= ceiling) return pcm;
  const k = ceiling / peak;
  for (let i = 0; i < pcm.l.length; i++) {
    pcm.l[i] *= k;
    pcm.r[i] *= k;
  }
  return pcm;
}

/** 波形の見た目用：幅 columns に縮めた、各位置の最大の大きさ（0〜1）。 */
export function peaksOf(pcm: Pcm, columns: number): Float32Array {
  const out = new Float32Array(columns);
  const n = pcm.l.length;
  if (n === 0 || columns <= 0) return out;
  for (let c = 0; c < columns; c++) {
    const a = Math.floor((c * n) / columns);
    const b = Math.max(a + 1, Math.floor(((c + 1) * n) / columns));
    let m = 0;
    for (let i = a; i < b && i < n; i++) m = Math.max(m, Math.abs(pcm.l[i]), Math.abs(pcm.r[i]));
    out[c] = Math.min(1, m);
  }
  return out;
}
