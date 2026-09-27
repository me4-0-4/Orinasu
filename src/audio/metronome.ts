export class Metronome {
  enabled = true;
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = out;
  }

  click(time: number, accent: boolean): void {
    if (!this.enabled) return;
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = accent ? 1500 : 1000;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(accent ? 0.35 : 0.22, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

    osc.connect(gain);
    gain.connect(this.out);
    osc.start(time);
    osc.stop(time + 0.06);
  }
}
