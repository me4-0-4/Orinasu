import type { Pcm } from "../mix/audioChop";

/** 刻んだ波形を、つなぎ目なしで繰り返し鳴らす。 */
export class LoopPlayer {
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private duration = 0;
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = out;
  }

  get playing(): boolean {
    return this.source !== null;
  }

  /** startFraction：曲のどこから鳴らすか（0〜1）。作り直したあとも、同じあたりから続けるために使う。 */
  play(pcm: Pcm, sampleRate: number, startFraction = 0): void {
    this.stop();
    if (pcm.l.length === 0) return;
    const buffer = this.ctx.createBuffer(2, pcm.l.length, sampleRate);
    buffer.copyToChannel(pcm.l as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(pcm.r as Float32Array<ArrayBuffer>, 1);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.out);
    this.duration = buffer.duration;
    const offset = Math.min(0.999, Math.max(0, startFraction)) * this.duration;
    this.startedAt = this.ctx.currentTime - offset;
    source.start(0, offset);
    this.source = source;
  }

  stop(): void {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      // すでに止まっている
    }
    this.source.disconnect();
    this.source = null;
  }

  /** いま曲のどこか（0〜1）。鳴っていなければ null。 */
  progress(): number | null {
    if (!this.source || this.duration <= 0) return null;
    return (((this.ctx.currentTime - this.startedAt) % this.duration) + this.duration) % this.duration / this.duration;
  }
}
