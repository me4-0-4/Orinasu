import type { LayerMix } from "../phrase/types.ts";

/** コンプの掛かり具合 amount（0〜1）→ コンプのつまみの値。0なら素通し。 */
export function compSettings(amount: number): { threshold: number; ratio: number; makeup: number } {
  const a = Math.min(1, Math.max(0, amount));
  return { threshold: -10 - 30 * a, ratio: 1 + 11 * a, makeup: 1 + 0.6 * a };
}

/**
 * 層ごとのミキサーの段：コンプ → 音量の補正 → パン。
 * input につなぐと output から出てくる。リバーブ・ディレイの送りは呼び出し側が持つ。
 */
export class MixStage {
  readonly input: DynamicsCompressorNode;
  readonly output: StereoPannerNode;
  private readonly makeup: GainNode;
  private readonly ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createDynamicsCompressor();
    this.input.knee.value = 10;
    this.input.attack.value = 0.005;
    this.input.release.value = 0.15;
    this.makeup = ctx.createGain();
    this.output = ctx.createStereoPanner();
    this.input.connect(this.makeup);
    this.makeup.connect(this.output);
    this.setMix({});
  }

  setMix(mix: LayerMix | undefined): void {
    const now = this.ctx.currentTime;
    const c = compSettings(mix?.comp ?? 0);
    this.input.threshold.setTargetAtTime(c.threshold, now, 0.02);
    this.input.ratio.setTargetAtTime(c.ratio, now, 0.02);
    this.makeup.gain.setTargetAtTime(c.makeup, now, 0.02);
    this.output.pan.setTargetAtTime(Math.min(1, Math.max(-1, mix?.pan ?? 0)), now, 0.02);
  }

  dispose(): void {
    this.input.disconnect();
    this.makeup.disconnect();
    this.output.disconnect();
  }
}

/** ドラム層用：入力 → ミキサーの段 → ドラムの出口。リバーブ・ディレイ送り付き。 */
export class DrumStrip {
  readonly input: GainNode;
  private readonly stage: MixStage;
  private readonly reverbSend: GainNode;
  private readonly delaySend: GainNode;
  private readonly ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, dryOut: AudioNode, reverbBus: AudioNode, delayBus: AudioNode) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.stage = new MixStage(ctx);
    this.input.connect(this.stage.input);
    this.stage.output.connect(dryOut);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0;
    this.input.connect(this.reverbSend);
    this.reverbSend.connect(reverbBus);
    this.input.connect(this.delaySend);
    this.delaySend.connect(delayBus);
  }

  setMix(mix: LayerMix | undefined): void {
    const now = this.ctx.currentTime;
    this.stage.setMix(mix);
    this.reverbSend.gain.setTargetAtTime(mix?.reverb ?? 0, now, 0.02);
    this.delaySend.gain.setTargetAtTime(mix?.delay ?? 0, now, 0.02);
  }

  dispose(): void {
    this.input.disconnect();
    this.reverbSend.disconnect();
    this.delaySend.disconnect();
    this.stage.dispose();
  }
}
