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

function createReverbImpulse(ctx: BaseAudioContext, seconds = 2.2, decay = 3.2): AudioBuffer {
  const length = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
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

  private readonly delayNode: DelayNode;
  private readonly delayFeedback: GainNode;
  private readonly delayWet: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly reverbWet: GainNode;

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

    // シンセ用バス（ドライ／リバーブ送り／ディレイ送り）
    this.synthDry = this.ctx.createGain();
    this.synthDry.connect(this.masterGain);

    this.synthReverbSend = this.ctx.createGain();
    this.synthReverbSend.gain.value = 0;
    this.synthDelaySend = this.ctx.createGain();
    this.synthDelaySend.gain.value = 0;

    this.delayNode = this.ctx.createDelay(2);
    this.delayNode.delayTime.value = 0.3;
    this.delayFeedback = this.ctx.createGain();
    this.delayFeedback.gain.value = 0.35;
    this.delayWet = this.ctx.createGain();
    this.delayWet.gain.value = 1;

    this.synthDelaySend.connect(this.delayNode);
    this.delayNode.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayNode.connect(this.delayWet);
    this.delayWet.connect(this.masterGain);

    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = createReverbImpulse(this.ctx);
    this.reverbWet = this.ctx.createGain();
    this.reverbWet.gain.value = 1;

    this.synthReverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbWet);
    this.reverbWet.connect(this.masterGain);

    // ドラム用バス
    this.drumOut = this.ctx.createGain();
    this.drumOut.connect(this.masterGain);
  }

  /** ブラウザの自動再生制限を解除する（最初のユーザー操作で呼ぶ） */
  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  setDelayTime(seconds: number): void {
    this.delayNode.delayTime.setTargetAtTime(seconds, this.ctx.currentTime, 0.02);
  }

  setDelayFeedback(amount: number): void {
    this.delayFeedback.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.02);
  }

  /** 出力遅延の目安（秒）。実際の入力〜発音の遅れの参考値。 */
  get estimatedLatency(): number {
    return (this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0);
  }

  get uptimeSeconds(): number {
    return this.ctx.currentTime - this.startedAt;
  }
}
