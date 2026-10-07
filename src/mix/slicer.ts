import type { Pcm } from "./pcm.ts";

type Rng = () => number;

/** 切り方：transient＝音の立ち上がり（アタック）で切る、divide＝等分に切る。 */
export type CutMode = "transient" | "divide";

/** 断片（サンプル位置。end は含まない）。 */
export interface Slice {
  start: number;
  end: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 断片の長さ（size 0〜1）から、最短・最長（ms）。size 0.5 で 100〜2000ms。 */
export function sliceLimits(size: number): { minMs: number; maxMs: number } {
  const k = Math.pow(10, (clamp01(size) - 0.5) * 1.4);
  return { minMs: Math.round(100 * k), maxMs: Math.min(8000, Math.round(2000 * k)) };
}

/** 等分の数（size 0〜1）。size 0.5 で 16、大きいほど少なく（＝長く）なる。 */
export function divisionsFor(size: number): number {
  return Math.min(64, Math.max(2, Math.round(64 * Math.pow(2, -4 * clamp01(size)))));
}

/**
 * 音の立ち上がり（アタック）の位置（サンプル）。頭（0）は必ず入る。
 * 10msごとの「高い音の成分の大きさ」の増え方を見て、まわりより目立って増えた所を拾う。
 * sensitivity（0〜1）が高いほど、小さな立ち上がりも拾う。
 */
export function detectOnsets(pcm: Pcm, sampleRate: number, sensitivity: number, minSpacingMs: number): number[] {
  const n = pcm.l.length;
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const frames = Math.floor(n / hop);
  if (frames < 3) return [0];
  const energy = new Float64Array(frames);
  let prev = 0;
  let maxE = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const x = (pcm.l[i] + pcm.r[i]) / 2;
      const d = x - prev; // 1つ前との差＝高い音の成分（アタックで大きくなる）
      prev = x;
      e += d * d;
    }
    energy[f] = e;
    maxE = Math.max(maxE, e);
  }
  const floor = maxE * 1e-4;
  const odf = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    if (energy[f] < floor) continue;
    odf[f] = Math.max(0, Math.log10(energy[f] + 1e-12) - Math.log10(energy[f - 1] + 1e-12));
  }
  const delta = 0.05 + (1 - clamp01(sensitivity)) * 1.2;
  const minSpacing = Math.round((minSpacingMs / 1000) * sampleRate);
  const onsets = [0];
  for (let f = 1; f < frames - 1; f++) {
    if (odf[f] < odf[f - 1] || odf[f] <= odf[f + 1]) continue;
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, f - 8); j <= Math.min(frames - 1, f + 8); j++) {
      sum += odf[j];
      cnt++;
    }
    if (odf[f] <= (sum / cnt) * 1.5 + delta) continue;
    const pos = f * hop;
    if (pos - onsets[onsets.length - 1] < minSpacing) continue;
    onsets.push(pos);
  }
  return onsets;
}

/**
 * 1本の波形を、断片に切る。切るたびに、長さの設定を少しだけ揺らす（切り直すと、切れ目が変わる）。
 * 短すぎる断片は捨て、長すぎる断片は最長で打ち切る。
 */
export function cutSlices(pcm: Pcm, sampleRate: number, opts: { mode: CutMode; size: number }, rng: Rng): Slice[] {
  const n = pcm.l.length;
  if (n === 0) return [];
  const size = clamp01(opts.size + (rng() - 0.5) * 0.3);
  const { minMs, maxMs } = sliceLimits(size);
  const minS = Math.round((minMs / 1000) * sampleRate);
  const maxS = Math.round((maxMs / 1000) * sampleRate);
  let bounds: number[];
  if (opts.mode === "divide") {
    const d = divisionsFor(size);
    bounds = Array.from({ length: d }, (_, i) => Math.round((i * n) / d));
  } else {
    bounds = detectOnsets(pcm, sampleRate, 1 - size, minMs);
  }
  const slices: Slice[] = [];
  bounds.forEach((start, i) => {
    const next = bounds[i + 1] ?? n;
    const end = Math.min(next, start + maxS);
    if (opts.mode === "divide" || end - start >= minS) slices.push({ start, end });
  });
  if (slices.length === 0) slices.push({ start: 0, end: Math.min(n, maxS) });
  return slices;
}
