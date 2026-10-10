import { createRng } from "../theory/rng";
import { foldTail } from "../mix/loopFold";
import type { Pcm } from "../mix/pcm";

/** リバーブの響き（雑音が消えていく形）。明るさで高い所を削る。毎回同じ響きになるよう、種は固定。 */
export function reverbImpulse(ctx: BaseAudioContext, seconds: number, toneHz: number): AudioBuffer {
  const length = Math.max(1, Math.ceil(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const rand = createRng(20260101);
  const a = 1 - Math.exp((-2 * Math.PI * toneHz) / ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      lp += a * (rand() * 2 - 1 - lp);
      data[i] = lp * Math.pow(1 - i / length, 3.2);
    }
  }
  return buffer;
}

/**
 * 何個に分けて、同時に処理するか。コアの多い端末ほど多く（最大4）、短い曲は分けない（1つ6秒以上）。
 * リバーブ（畳み込み）は足し算で分けられるので、分けて重ねても結果は同じ。
 */
function splitCount(frames: number, sampleRate: number): number {
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  const byLength = Math.floor(frames / (sampleRate * 6));
  return Math.max(1, Math.min(4, cores - 1, byLength));
}

/**
 * リバーブの響きだけ（元の音を含まない）を作る。
 * 余韻は曲の頭に重ねるので、くり返して鳴らしてもつなぎ目で途切れない。
 * 曲をいくつかに切って、別々のコンテキストで同時に処理し、重ねて足す（1つで処理するより速く、音は同じ）。
 */
export async function reverbWet(pcm: Pcm, sampleRate: number, seconds: number, toneHz: number): Promise<Pcm> {
  const n = pcm.l.length;
  if (n === 0) return pcm;
  const tail = Math.ceil((seconds + 0.05) * sampleRate);
  const parts = splitCount(n, sampleRate);
  const size = Math.ceil(n / parts);
  const l = new Float32Array(n + tail);
  const r = new Float32Array(n + tail);
  await Promise.all(
    Array.from({ length: parts }, async (_, k) => {
      const start = k * size;
      const end = Math.min(n, start + size);
      if (end <= start) return;
      const ctx = new OfflineAudioContext(2, end - start + tail, sampleRate);
      const buffer = ctx.createBuffer(2, end - start, sampleRate);
      buffer.copyToChannel(pcm.l.subarray(start, end) as Float32Array<ArrayBuffer>, 0);
      buffer.copyToChannel(pcm.r.subarray(start, end) as Float32Array<ArrayBuffer>, 1);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const convolver = ctx.createConvolver();
      convolver.buffer = reverbImpulse(ctx, seconds, toneHz);
      src.connect(convolver);
      convolver.connect(ctx.destination);
      src.start(0);
      const rendered = await ctx.startRendering();
      const outL = rendered.getChannelData(0);
      const outR = rendered.getChannelData(1);
      for (let i = 0; i < outL.length; i++) {
        l[start + i] += outL[i];
        r[start + i] += outR[i];
      }
    }),
  );
  return foldTail(l, r, n);
}
