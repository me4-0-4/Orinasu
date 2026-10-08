import { createRng } from "../theory/rng";
import { foldTail } from "../mix/loopFold";
import type { Pcm } from "../mix/pcm";
import {
  applyDrive,
  delayFeedbackGain,
  delaySeconds,
  fxIsOff,
  highCutHz,
  lowCutHz,
  reverbSeconds,
  reverbToneHz,
  type FxSettings,
} from "../mix/fx";

const OFF = 0.01;

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
 * 波形に、エフェクトを掛ける：歪み・音質下げ → 低音を削る・高音を削る → そのまま＋ディレイ＋リバーブ。
 * 余韻（リバーブ・ディレイ）は曲の頭に重ねるので、くり返して鳴らしてもつなぎ目で途切れない。
 */
export async function applyFx(pcm: Pcm, sampleRate: number, fx: FxSettings, bpm: number): Promise<Pcm> {
  if (fxIsOff(fx) || pcm.l.length === 0) return pcm;
  const driven = applyDrive(pcm, fx.drive, fx.crush);
  const needsGraph = fx.reverb >= OFF || fx.delay >= OFF || fx.lowCut >= OFF || fx.highCut >= OFF;
  if (!needsGraph) return driven;

  const n = driven.l.length;
  const delayTime = delaySeconds(fx.delayTime, bpm);
  const feedback = delayFeedbackGain(fx.delayFeedback);
  // 余韻の長さ：リバーブの長さと、ディレイが 1/1000 まで小さくなる時間（最大8秒）
  const delayTail = fx.delay >= OFF ? Math.min(8, delayTime * (1 + Math.log(0.001) / Math.log(Math.max(0.01, feedback)))) : 0;
  const reverbTail = fx.reverb >= OFF ? reverbSeconds(fx.reverbSize) : 0;
  const total = n + Math.ceil((Math.max(delayTail, reverbTail) + 0.05) * sampleRate);
  const ctx = new OfflineAudioContext(2, total, sampleRate);
  const buffer = ctx.createBuffer(2, n, sampleRate);
  buffer.copyToChannel(driven.l as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(driven.r as Float32Array<ArrayBuffer>, 1);
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  let head: AudioNode = src;
  if (fx.lowCut >= OFF) {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = lowCutHz(fx.lowCut);
    head.connect(hp);
    head = hp;
  }
  if (fx.highCut >= OFF) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = highCutHz(fx.highCut);
    head.connect(lp);
    head = lp;
  }
  head.connect(ctx.destination);

  if (fx.delay >= OFF) {
    const delay = ctx.createDelay(2);
    delay.delayTime.value = Math.min(2, delayTime);
    const fb = ctx.createGain();
    fb.gain.value = feedback;
    const wet = ctx.createGain();
    wet.gain.value = 0.6 * fx.delay;
    head.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(ctx.destination);
  }
  if (fx.reverb >= OFF) {
    const convolver = ctx.createConvolver();
    convolver.buffer = reverbImpulse(ctx, reverbSeconds(fx.reverbSize), reverbToneHz(fx.reverbTone));
    const wet = ctx.createGain();
    wet.gain.value = 0.5 * fx.reverb;
    head.connect(convolver);
    convolver.connect(wet);
    wet.connect(ctx.destination);
  }
  src.start(0);
  const rendered = await ctx.startRendering();
  return foldTail(rendered.getChannelData(0), rendered.getChannelData(1), n);
}
