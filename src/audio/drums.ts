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

/** 軽く丸める曲線（tanh）。倍音が足されて、サイン波だけのときより太く聞こえる。 */
function saturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

/** ハットの金属っぽさを作る、ずれた周波数の重ね（808 系の比率）。 */
const HAT_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];
const HAT_BASE = 40;

export class DrumMachine {
  private readonly ctx: BaseAudioContext;
  private readonly noiseBuffer: AudioBuffer;
  private readonly out: AudioNode;
  private readonly kickCurve = saturationCurve(2.2);
  /** いま鳴らしている音の送り先（trigger の間だけ、層ごとの出口に差し替わる）。 */
  private dest: AudioNode;

  constructor(ctx: BaseAudioContext, noiseBuffer: AudioBuffer, out: AudioNode) {
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

  /** ノイズを、打つ時刻から決まる位置で鳴らし始める（毎回同じ所から始めると、打つたびに同じ音になるため。同じ時刻なら同じ結果）。 */
  private noiseAt(time: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const span = Math.max(0.01, this.noiseBuffer.duration - 0.6);
    src.start(time, (time * 997.13) % span);
    return src;
  }

  /** 音量が指数で下がる包み。 */
  private env(peak: number, time: number, decay: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, peak), time);
    g.gain.exponentialRampToValueAtTime(0.001, time + decay);
    return g;
  }

  private playKick(velocity: number, now: number): void {
    // 胴：高い所から一気に落とし、そのあとゆっくり低音へ（キックらしい「ドゥン」）
    const body = this.ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(190, now);
    body.frequency.exponentialRampToValueAtTime(70, now + 0.035);
    body.frequency.exponentialRampToValueAtTime(46, now + 0.3);
    const bodyGain = this.env(velocity, now, 0.42);
    body.connect(bodyGain);
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = this.kickCurve;
    shaper.oversample = "2x";
    bodyGain.connect(shaper);
    shaper.connect(this.dest);
    body.start(now);
    body.stop(now + 0.45);

    // 叩く音（アタック）：ごく短いノイズを、低めのフィルターで丸める
    const click = this.noiseAt(now);
    const clickFilter = this.ctx.createBiquadFilter();
    clickFilter.type = "lowpass";
    clickFilter.frequency.value = 3200;
    const clickGain = this.env(velocity * 0.35, now, 0.012);
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(this.dest);
    click.stop(now + 0.02);
  }

  private playSnare(velocity: number, now: number): void {
    // ノイズ（スナッピー）：高域を残して帯域を絞り、はじめ強く・あとは長めに残す
    const noise = this.noiseAt(now);
    const high = this.ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 1800;
    const band = this.ctx.createBiquadFilter();
    band.type = "peaking";
    band.frequency.value = 5200;
    band.gain.value = 5;
    band.Q.value = 0.8;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(velocity * 0.6, now);
    noiseGain.gain.exponentialRampToValueAtTime(velocity * 0.21, now + 0.04);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    noise.connect(high);
    high.connect(band);
    band.connect(noiseGain);
    noiseGain.connect(this.dest);
    noise.stop(now + 0.26);

    // 胴：2つの音程を少し落としながら鳴らす（皮の鳴り）
    for (const [from, to, level] of [[260, 185, 0.35], [420, 330, 0.15]] as const) {
      const tone = this.ctx.createOscillator();
      tone.type = "triangle";
      tone.frequency.setValueAtTime(from, now);
      tone.frequency.exponentialRampToValueAtTime(to, now + 0.05);
      const toneGain = this.env(velocity * level, now, 0.14);
      tone.connect(toneGain);
      toneGain.connect(this.dest);
      tone.start(now);
      tone.stop(now + 0.16);
    }
  }

  private playHat(velocity: number, now: number): void {
    // 金属っぽい音：ずれた周波数の矩形波を重ねて、高域だけ通す
    const high = this.ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 7500;
    const band = this.ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 10500;
    band.Q.value = 0.6;
    const gain = this.env(velocity * 0.27, now, 0.055);
    high.connect(band);
    band.connect(gain);
    gain.connect(this.dest);
    for (const ratio of HAT_RATIOS) {
      const osc = this.ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = HAT_BASE * ratio * 5;
      osc.connect(high);
      osc.start(now);
      osc.stop(now + 0.07);
    }
    // 空気感のノイズを少し足す
    const air = this.noiseAt(now);
    const airFilter = this.ctx.createBiquadFilter();
    airFilter.type = "highpass";
    airFilter.frequency.value = 9000;
    const airGain = this.env(velocity * 0.22, now, 0.05);
    air.connect(airFilter);
    airFilter.connect(airGain);
    airGain.connect(this.dest);
    air.stop(now + 0.07);
  }

  private playClap(velocity: number, now: number): void {
    // 手のばらつき：少しずつずらした短い打ちを重ね、最後に尾を引かせる
    const offsets = [0, 0.011, 0.023, 0.034];
    for (const [i, offset] of offsets.entries()) {
      const t = now + offset;
      const last = i === offsets.length - 1;
      const noise = this.noiseAt(t);
      const filter = this.ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 1300 + i * 120;
      filter.Q.value = 0.9;
      const gain = this.env(velocity * (last ? 0.6 : 0.42), t, last ? 0.22 : 0.035);
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.dest);
      noise.stop(t + (last ? 0.24 : 0.05));
    }
  }

  private playTom(velocity: number, now: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(230, now);
    osc.frequency.exponentialRampToValueAtTime(105, now + 0.12);
    osc.frequency.exponentialRampToValueAtTime(88, now + 0.38);
    const gain = this.env(velocity * 0.85, now, 0.42);
    osc.connect(gain);
    gain.connect(this.dest);
    osc.start(now);
    osc.stop(now + 0.45);

    // 叩く音
    const click = this.noiseAt(now);
    const clickFilter = this.ctx.createBiquadFilter();
    clickFilter.type = "bandpass";
    clickFilter.frequency.value = 2500;
    const clickGain = this.env(velocity * 0.2, now, 0.015);
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(this.dest);
    click.stop(now + 0.02);
  }
}
