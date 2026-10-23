import { compSettings } from "../audio/mixStage.ts";

/** ステレオの波形。 */
export interface Pcm {
  l: Float32Array;
  r: Float32Array;
}

/** 全体の音量を gain 倍にする。 */
export function gainPcm(pcm: Pcm, gain: number): Pcm {
  if (gain === 1) return pcm;
  for (let i = 0; i < pcm.l.length; i++) {
    pcm.l[i] *= gain;
    pcm.r[i] *= gain;
  }
  return pcm;
}

/**
 * コンプ（ステレオ連動）。amount（0〜1）は、層のミキサーのコンプと同じ対応（`compSettings`）。0なら素通し。
 * 音の大きさを追いかけて（立ち上がり5ms・戻り150ms）、閾値を超えた分を比率で抑え、最後に音量を補正する。
 */
export function compressPcm(pcm: Pcm, amount: number, sampleRate: number): Pcm {
  if (!(amount > 0)) return pcm;
  const c = compSettings(amount);
  const knee = 10; // dB
  const attack = Math.exp(-1 / (0.005 * sampleRate));
  const release = Math.exp(-1 / (0.15 * sampleRate));
  let env = 0;
  for (let i = 0; i < pcm.l.length; i++) {
    const level = Math.max(Math.abs(pcm.l[i]), Math.abs(pcm.r[i]));
    env = level > env ? attack * env + (1 - attack) * level : release * env + (1 - release) * level;
    const db = 20 * Math.log10(Math.max(env, 1e-6));
    const over = db - c.threshold;
    let reduction = 0; // dB（負の方向に下げる量）
    if (over > knee / 2) reduction = over * (1 - 1 / c.ratio);
    else if (over > -knee / 2) reduction = ((1 - 1 / c.ratio) * (over + knee / 2) ** 2) / (2 * knee);
    const g = Math.pow(10, -reduction / 20) * c.makeup;
    pcm.l[i] *= g;
    pcm.r[i] *= g;
  }
  return pcm;
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
