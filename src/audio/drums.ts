export type DrumId = "kick" | "snare" | "hat" | "clap" | "tom";

export const drumList: { id: DrumId; label: string }[] = [
  { id: "kick", label: "キック" },
  { id: "snare", label: "スネア" },
  { id: "hat", label: "ハット" },
  { id: "clap", label: "クラップ" },
  { id: "tom", label: "タム" },
];

/** GM準拠に寄せたドラムノート番号。フレーズのノートデータにドラムを乗せるための対応表。 */
export const drumNoteNumbers: Record<DrumId, number> = {
  kick: 36,
  snare: 38,
  hat: 42,
  clap: 39,
  tom: 45,
};

export const noteNumberToDrum: Record<number, DrumId> = Object.fromEntries(
  Object.entries(drumNoteNumbers).map(([id, n]) => [n, id as DrumId]),
) as Record<number, DrumId>;

export class DrumMachine {
  private readonly ctx: AudioContext;
  private readonly noiseBuffer: AudioBuffer;
  private readonly out: AudioNode;
  /** いま鳴らしている音の送り先（trigger の間だけ、層ごとの出口に差し替わる）。 */
  private dest: AudioNode;

  constructor(ctx: AudioContext, noiseBuffer: AudioBuffer, out: AudioNode) {
    this.ctx = ctx;
    this.noiseBuffer = noiseBuffer;
    this.out = out;
    this.dest = out;
  }

  trigger(id: DrumId, velocity = 1, time?: number, out?: AudioNode): void {
    const now = time ?? this.ctx.currentTime;
    this.dest = out ?? this.out;
    switch (id) {
      case "kick":
        this.playKick(velocity, now);
        break;
      case "snare":
        this.playSnare(velocity, now);
        break;
      case "hat":
        this.playHat(velocity, now);
        break;
      case "clap":
        this.playClap(velocity, now);
        break;
      case "tom":
        this.playTom(velocity, now);
        break;
    }
  }

  private playKick(velocity: number, now: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.25);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(velocity, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(this.dest);
    osc.start(now);
    osc.stop(now + 0.4);
  }

  private playSnare(velocity: number, now: number): void {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = "highpass";
    noiseFilter.frequency.value = 1200;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(velocity * 0.9, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.dest);
    noise.start(now);
    noise.stop(now + 0.2);

    const tone = this.ctx.createOscillator();
    tone.type = "triangle";
    tone.frequency.value = 190;
    const toneGain = this.ctx.createGain();
    toneGain.gain.setValueAtTime(velocity * 0.5, now);
    toneGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    tone.connect(toneGain);
    toneGain.connect(this.dest);
    tone.start(now);
    tone.stop(now + 0.15);
  }

  private playHat(velocity: number, now: number): void {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 7000;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(velocity * 0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.dest);
    noise.start(now);
    noise.stop(now + 0.08);
  }

  private playClap(velocity: number, now: number): void {
    const offsets = [0, 0.01, 0.02, 0.03];
    for (const offset of offsets) {
      const t = now + offset;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 1500;
      filter.Q.value = 1.2;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(velocity * 0.55, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.dest);
      noise.start(t);
      noise.stop(t + 0.12);
    }
  }

  private playTom(velocity: number, now: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.3);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(velocity * 0.8, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    osc.connect(gain);
    gain.connect(this.dest);
    osc.start(now);
    osc.stop(now + 0.45);
  }
}
