import { createRng } from "../theory/rng";
import { foldTail } from "../mix/loopFold";
import type { Pcm } from "../mix/pcm";

/** リバーブの響き（雑音が消えていく形）。明るさで高い所を削る。毎回同じ響きになるよう、種は固定。 */
function reverbImpulse(ctx: BaseAudioContext, seconds: number, toneHz: number): AudioBuffer {
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
 * リバーブの響きだけ（元の音を含まない）を作る。
 * 余韻は曲の頭に重ねるので、くり返して鳴らしてもつなぎ目で途切れない。
 */
export async function reverbWet(pcm: Pcm, sampleRate: number, seconds: number, toneHz: number): Promise<Pcm> {
  const n = pcm.l.length;
  if (n === 0) return pcm;
  const total = n + Math.ceil((seconds + 0.05) * sampleRate);
  const ctx = new OfflineAudioContext(2, total, sampleRate);
  const buffer = ctx.createBuffer(2, n, sampleRate);
  buffer.copyToChannel(pcm.l as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(pcm.r as Float32Array<ArrayBuffer>, 1);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const convolver = ctx.createConvolver();
  convolver.buffer = reverbImpulse(ctx, seconds, toneHz);
  src.connect(convolver);
  convolver.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return foldTail(rendered.getChannelData(0), rendered.getChannelData(1), n);
}
