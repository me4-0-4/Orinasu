import type { Pcm } from "./pcm.ts";

/**
 * はみ出した余韻（loopFrames より後ろ）を、頭に重ねて loopFrames の長さにする。
 * くり返して鳴らしたとき、つなぎ目で余韻が途切れない。余韻が1周より長ければ、何周ぶんでも重ねる。
 */
export function foldTail(l: Float32Array, r: Float32Array, loopFrames: number): Pcm {
  const out: Pcm = { l: new Float32Array(loopFrames), r: new Float32Array(loopFrames) };
  for (let i = 0; i < l.length; i++) {
    const j = i % loopFrames;
    out.l[j] += l[i];
    out.r[j] += r[i];
  }
  return out;
}

/** 波形を n 回くり返した波形（WAVの保存用）。 */
export function repeatPcm(pcm: Pcm, times: number): Pcm {
  const n = Math.max(1, Math.floor(times));
  const len = pcm.l.length;
  const out: Pcm = { l: new Float32Array(len * n), r: new Float32Array(len * n) };
  for (let k = 0; k < n; k++) {
    out.l.set(pcm.l, k * len);
    out.r.set(pcm.r, k * len);
  }
  return out;
}
