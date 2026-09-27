import { noteToFrequency } from "./context";
import type { SynthParams } from "./synthParams";

interface Voice {
  note: number;
  oscillators: OscillatorNode[];
  panners: StereoPannerNode[];
  filter: BiquadFilterNode;
  ampGain: GainNode;
  lfoConnections: AudioParam[];
  releasing: boolean;
}

export class SynthEngine {
  params: SynthParams;
  private readonly ctx: AudioContext;
  private readonly output: GainNode;
  private readonly reverbSend: GainNode;
  private readonly delaySend: GainNode;

  private readonly voices = new Map<number, Voice>();
  private lastFrequency: number | null = null;

  private lfoOsc: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;

  constructor(
    ctx: AudioContext,
    dryOut: AudioNode,
    reverbSend: AudioNode,
    delaySend: AudioNode,
    params: SynthParams,
  ) {
    this.ctx = ctx;
    this.params = params;

    this.output = ctx.createGain();
    this.output.gain.value = 0.9;
    this.output.connect(dryOut);

    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = params.effects.reverbSend;
    this.output.connect(this.reverbSend);
    this.reverbSend.connect(reverbSend);

    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = params.effects.delaySend;
    this.output.connect(this.delaySend);
    this.delaySend.connect(delaySend);

    this.startLfo();
  }

  updateParams(params: SynthParams): void {
    this.params = params;
    const now = this.ctx.currentTime;
    this.reverbSend.gain.setTargetAtTime(params.effects.reverbSend, now, 0.02);
    this.delaySend.gain.setTargetAtTime(params.effects.delaySend, now, 0.02);
    this.applyLfoSettings();

    for (const voice of this.voices.values()) {
      voice.filter.type = params.filter.type;
      if (!voice.releasing) {
        this.applyFilterEnvelopeTarget(voice);
      }
    }
  }

  private startLfo(): void {
    this.lfoOsc = this.ctx.createOscillator();
    this.lfoGain = this.ctx.createGain();
    this.lfoOsc.connect(this.lfoGain);
    this.applyLfoSettings();
    this.lfoOsc.start();
  }

  private applyLfoSettings(): void {
    if (!this.lfoOsc || !this.lfoGain) return;
    const { rate, depth, shape } = this.params.lfo;
    this.lfoOsc.type = shape;
    this.lfoOsc.frequency.setTargetAtTime(rate, this.ctx.currentTime, 0.01);
    this.lfoGain.gain.setTargetAtTime(depth, this.ctx.currentTime, 0.01);
  }

  private connectLfoTo(voice: Voice): void {
    if (!this.lfoGain) return;
    const { target } = this.params.lfo;
    if (target === "off") return;

    if (target === "pitch") {
      for (const osc of voice.oscillators) {
        this.lfoGain.connect(osc.detune);
        voice.lfoConnections.push(osc.detune);
      }
    } else if (target === "filter") {
      this.lfoGain.connect(voice.filter.detune);
      voice.lfoConnections.push(voice.filter.detune);
    } else if (target === "amp") {
      this.lfoGain.connect(voice.ampGain.gain);
      voice.lfoConnections.push(voice.ampGain.gain);
    }
  }

  private disconnectLfoFrom(voice: Voice): void {
    if (!this.lfoGain) return;
    for (const param of voice.lfoConnections) {
      try {
        this.lfoGain.disconnect(param);
      } catch {
        // 既に切断済みの場合は無視
      }
    }
    voice.lfoConnections = [];
  }

  private applyFilterEnvelopeTarget(voice: Voice): void {
    // フィルターエンベロープのサステイン段階での目標値を再適用する（ツマミ変更時の追従用）
    const { filter, filterEnv } = this.params;
    const now = this.ctx.currentTime;
    const sustainCutoff = filter.cutoff * Math.pow(2, filter.envAmount * filterEnv.sustain * 4);
    voice.filter.frequency.setTargetAtTime(sustainCutoff, now, 0.05);
    voice.filter.Q.setTargetAtTime(filter.resonance, now, 0.05);
  }

  noteOn(note: number, velocity = 1): void {
    this.noteOff(note, true);

    const { osc, filter, ampEnv, filterEnv, portamentoSeconds } = this.params;
    const now = this.ctx.currentTime;
    const targetFreq = noteToFrequency(note + osc.octave * 12);
    const startFreq =
      portamentoSeconds > 0 && this.lastFrequency !== null ? this.lastFrequency : targetFreq;
    this.lastFrequency = targetFreq;

    const voiceFilter = this.ctx.createBiquadFilter();
    voiceFilter.type = filter.type;
    voiceFilter.Q.value = filter.resonance;

    const baseCutoff = filter.cutoff;
    const peakCutoff = clampFrequency(baseCutoff * Math.pow(2, filter.envAmount * 4));
    const sustainCutoff = clampFrequency(
      baseCutoff * Math.pow(2, filter.envAmount * filterEnv.sustain * 4),
    );
    voiceFilter.frequency.setValueAtTime(clampFrequency(baseCutoff), now);
    voiceFilter.frequency.linearRampToValueAtTime(peakCutoff, now + filterEnv.attack);
    voiceFilter.frequency.linearRampToValueAtTime(
      sustainCutoff,
      now + filterEnv.attack + filterEnv.decay,
    );

    const ampGain = this.ctx.createGain();
    ampGain.gain.setValueAtTime(0, now);
    ampGain.gain.linearRampToValueAtTime(velocity, now + ampEnv.attack);
    ampGain.gain.linearRampToValueAtTime(
      velocity * ampEnv.sustain,
      now + ampEnv.attack + ampEnv.decay,
    );

    ampGain.connect(voiceFilter);
    voiceFilter.connect(this.output);

    const oscillators: OscillatorNode[] = [];
    const panners: StereoPannerNode[] = [];
    const count = Math.max(1, Math.min(7, osc.unisonCount));

    for (let i = 0; i < count; i++) {
      const o = this.ctx.createOscillator();
      o.type = osc.type;
      const spread = count === 1 ? 0 : (i / (count - 1)) * 2 - 1; // -1..1
      o.detune.value = osc.detuneCents + spread * osc.unisonSpreadCents;
      o.frequency.setValueAtTime(startFreq, now);
      if (portamentoSeconds > 0) {
        o.frequency.exponentialRampToValueAtTime(
          Math.max(targetFreq, 0.01),
          now + portamentoSeconds,
        );
      }

      const panner = this.ctx.createStereoPanner();
      panner.pan.value = count === 1 ? 0 : spread * 0.6;

      o.connect(panner);
      panner.connect(ampGain);
      o.start(now);

      oscillators.push(o);
      panners.push(panner);
    }

    const voice: Voice = {
      note,
      oscillators,
      panners,
      filter: voiceFilter,
      ampGain,
      lfoConnections: [],
      releasing: false,
    };
    this.connectLfoTo(voice);
    this.voices.set(note, voice);
  }

  noteOff(note: number, immediate = false): void {
    const voice = this.voices.get(note);
    if (!voice) return;
    this.voices.delete(note);

    const releaseSeconds = immediate ? 0.01 : this.params.ampEnv.release;
    const now = this.ctx.currentTime;
    voice.releasing = true;

    voice.ampGain.gain.cancelScheduledValues(now);
    voice.ampGain.gain.setValueAtTime(voice.ampGain.gain.value, now);
    voice.ampGain.gain.linearRampToValueAtTime(0, now + releaseSeconds);

    const filterRelease = immediate ? 0.01 : this.params.filterEnv.release;
    voice.filter.frequency.cancelScheduledValues(now);
    voice.filter.frequency.setValueAtTime(voice.filter.frequency.value, now);
    voice.filter.frequency.linearRampToValueAtTime(
      clampFrequency(this.params.filter.cutoff),
      now + filterRelease,
    );

    const stopAt = now + Math.max(releaseSeconds, filterRelease) + 0.05;
    for (const o of voice.oscillators) {
      o.stop(stopAt);
    }
    window.setTimeout(
      () => {
        this.disconnectLfoFrom(voice);
        for (const o of voice.oscillators) o.disconnect();
        for (const p of voice.panners) p.disconnect();
        voice.filter.disconnect();
        voice.ampGain.disconnect();
      },
      (stopAt - now) * 1000 + 50,
    );
  }

  allNotesOff(): void {
    for (const note of Array.from(this.voices.keys())) {
      this.noteOff(note, true);
    }
  }

  get activeNotes(): number[] {
    return Array.from(this.voices.keys());
  }
}

function clampFrequency(hz: number): number {
  return Math.min(20000, Math.max(20, hz));
}
