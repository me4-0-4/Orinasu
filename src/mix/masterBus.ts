import type { Pcm } from "./pcm.ts";
import { MASTER_BUS_DEFAULTS, MasterBusStream, type MasterBusOptions } from "./masterBusStream.ts";

export { MASTER_BUS_DEFAULTS, compressorReductionDb, type MasterBusOptions } from "./masterBusStream.ts";

/**
 * 曲全体の仕上げ（書き出し用）。ストリーム版（再生中に使うものと同じ計算）に、曲全体を流して、先読みの遅れを詰める。
 * 左右をそろえて動かすコンプ → 先読みリミッター。元の波形は書き換えず、新しい波形を返す。無音のところは無音のまま。
 */
export function masterBus(pcm: Pcm, sampleRate: number, opts: Partial<MasterBusOptions> = {}): Pcm {
  const n = pcm.l.length;
  if (n === 0) return { l: new Float32Array(0), r: new Float32Array(0) };
  const stream = new MasterBusStream(sampleRate, { ...MASTER_BUS_DEFAULTS, ...opts });
  // 先読みの遅れのぶん、後ろに無音をつけて流し、頭の遅れを捨てる
  const padded = n + stream.latency;
  const inL = new Float32Array(padded);
  const inR = new Float32Array(padded);
  inL.set(pcm.l);
  inR.set(pcm.r);
  stream.process(inL, inR, inL, inR);
  return { l: inL.slice(stream.latency, stream.latency + n), r: inR.slice(stream.latency, stream.latency + n) };
}

/** 助走の長さ（秒）。コンプ・リミッターの状態が落ち着くのに十分な長さ。 */
const PREROLL_SECONDS = 2;

/**
 * くり返して鳴らす曲の仕上げ。曲の頭を、冷えた状態からではなく、直前（曲の終わり）からの続きとして処理する。
 * 再生中のリアルタイム処理（ずっと続くループ）と、頭から同じ音になる。長さは変わらない。
 */
export function masterBusLoop(pcm: Pcm, sampleRate: number, opts: Partial<MasterBusOptions> = {}): Pcm {
  const n = pcm.l.length;
  const pre = Math.min(n, Math.round(PREROLL_SECONDS * sampleRate));
  if (pre === 0) return masterBus(pcm, sampleRate, opts);
  const l = new Float32Array(pre + n);
  const r = new Float32Array(pre + n);
  l.set(pcm.l.subarray(n - pre), 0);
  r.set(pcm.r.subarray(n - pre), 0);
  l.set(pcm.l, pre);
  r.set(pcm.r, pre);
  const out = masterBus({ l, r }, sampleRate, opts);
  return { l: out.l.slice(pre), r: out.r.slice(pre) };
}
