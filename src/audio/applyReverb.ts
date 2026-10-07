import { createReverbImpulse } from "./context";
import { createRng } from "../theory/rng";
import { foldTail } from "../mix/loopFold";
import type { Pcm } from "../mix/pcm";

const TAIL_SECONDS = 2.5;

/**
 * 刻んだ曲の全体に、仕上げのリバーブを掛ける（amount 0〜1）。
 * 余韻は曲の頭に重ねるので、くり返して鳴らしてもつなぎ目で途切れない。響きは毎回同じ。
 */
export async function applyReverb(pcm: Pcm, sampleRate: number, amount: number): Promise<Pcm> {
  if (amount <= 0 || pcm.l.length === 0) return pcm;
  const n = pcm.l.length;
  const total = n + Math.ceil(TAIL_SECONDS * sampleRate);
  const ctx = new OfflineAudioContext(2, total, sampleRate);
  const buffer = ctx.createBuffer(2, n, sampleRate);
  buffer.copyToChannel(pcm.l as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(pcm.r as Float32Array<ArrayBuffer>, 1);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const dry = ctx.createGain();
  dry.gain.value = 1;
  const convolver = ctx.createConvolver();
  convolver.buffer = createReverbImpulse(ctx, 2.2, 3.2, createRng(20260101));
  const wet = ctx.createGain();
  wet.gain.value = 0.5 * Math.min(1, Math.max(0, amount));
  src.connect(dry);
  dry.connect(ctx.destination);
  src.connect(convolver);
  convolver.connect(wet);
  wet.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return foldTail(rendered.getChannelData(0), rendered.getChannelData(1), n);
}
