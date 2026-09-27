import type { FilterType } from "./synthParams";

/**
 * 指定したフィルター設定の周波数特性（20Hz〜20kHz、対数間隔）を計算する。
 * 実際の再生グラフには接続しない、計算専用の一時ノードを使う。
 */
export function computeFilterCurve(
  ctx: BaseAudioContext,
  type: FilterType,
  cutoff: number,
  resonance: number,
  pointCount = 128,
): { freqs: Float32Array; magDb: Float32Array } {
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = cutoff;
  filter.Q.value = resonance;

  const freqs = new Float32Array(pointCount);
  const minLog = Math.log10(20);
  const maxLog = Math.log10(20000);
  for (let i = 0; i < pointCount; i++) {
    const t = i / (pointCount - 1);
    freqs[i] = Math.pow(10, minLog + t * (maxLog - minLog));
  }

  const mag = new Float32Array(pointCount);
  const phase = new Float32Array(pointCount);
  filter.getFrequencyResponse(freqs, mag, phase);

  const magDb = new Float32Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    magDb[i] = 20 * Math.log10(Math.max(mag[i], 1e-6));
  }

  return { freqs, magDb };
}
