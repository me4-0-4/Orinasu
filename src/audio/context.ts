export function noteToFrequency(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

export function createNoiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const length = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/** リバーブの響き（減っていくノイズ）。rand を渡すと、毎回同じ響きになる。 */
export function createReverbImpulse(ctx: BaseAudioContext, seconds = 2.2, decay = 3.2, rand: () => number = Math.random): AudioBuffer {
  const length = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (rand() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

/** シンセ・ドラム用のバス（ドライ／リバーブ送り／ディレイ送り）。ライブの音と、書き出し（オフライン）の両方で使う。 */
export class AudioBuses {
  readonly synthDry: GainNode;
  readonly synthReverbSend: GainNode;
  readonly synthDelaySend: GainNode;
  readonly drumOut: GainNode;

  private readonly delayNode: DelayNode;
  private readonly delayFeedback: GainNode;
  private readonly delayWet: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly reverbWet: GainNode;

  readonly ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.synthDry = ctx.createGain();
    this.synthDry.connect(out);

    this.synthReverbSend = ctx.createGain();
    this.synthReverbSend.gain.value = 0;
    this.synthDelaySend = ctx.createGain();
    this.synthDelaySend.gain.value = 0;

    this.delayNode = ctx.createDelay(2);
    this.delayNode.delayTime.value = 0.3;
    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = 0.35;
    this.delayWet = ctx.createGain();
    this.delayWet.gain.value = 1;

    this.synthDelaySend.connect(this.delayNode);
    this.delayNode.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayNode.connect(this.delayWet);
    this.delayWet.connect(out);

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = createReverbImpulse(ctx);
    this.reverbWet = ctx.createGain();
    this.reverbWet.gain.value = 1;

    this.synthReverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbWet);
    this.reverbWet.connect(out);

    // ドラム用バス
    this.drumOut = ctx.createGain();
    this.drumOut.connect(out);
  }

  setDelayTime(seconds: number): void {
    this.delayNode.delayTime.setTargetAtTime(seconds, this.ctx.currentTime, 0.02);
  }

  setDelayFeedback(amount: number): void {
    this.delayFeedback.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.02);
  }
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly masterGain: GainNode;
  readonly analyser: AnalyserNode;
  readonly noiseBuffer: AudioBuffer;

  readonly synthDry: GainNode;
  readonly synthReverbSend: GainNode;
  readonly synthDelaySend: GainNode;
  readonly drumOut: GainNode;

  private readonly buses: AudioBuses;
  private startedAt = 0;

  constructor() {
    this.ctx = new AudioContext();
    this.startedAt = this.ctx.currentTime;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.noiseBuffer = createNoiseBuffer(this.ctx);

    this.buses = new AudioBuses(this.ctx, this.masterGain);
    this.synthDry = this.buses.synthDry;
    this.synthReverbSend = this.buses.synthReverbSend;
    this.synthDelaySend = this.buses.synthDelaySend;
    this.drumOut = this.buses.drumOut;
  }

  /** ブラウザの自動再生制限を解除する（最初のユーザー操作で呼ぶ） */
  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  setDelayTime(seconds: number): void {
    this.buses.setDelayTime(seconds);
  }

  setDelayFeedback(amount: number): void {
    this.buses.setDelayFeedback(amount);
  }

  /** 出力遅延の目安（秒）。実際の入力〜発音の遅れの参考値。 */
  get estimatedLatency(): number {
    return (this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0);
  }

  get uptimeSeconds(): number {
    return this.ctx.currentTime - this.startedAt;
  }
}
