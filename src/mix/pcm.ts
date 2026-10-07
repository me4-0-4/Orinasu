/** ステレオの波形。 */
export interface Pcm {
  l: Float32Array;
  r: Float32Array;
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
