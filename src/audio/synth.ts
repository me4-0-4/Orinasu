import { MixStage } from "./mixStage";
import type { LayerMix } from "../phrase/types";
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
  /** noteOn時に計算したサステインレベル（noteOffで.valueの代わりに使う。理由はnoteOff内のコメント参照） */
  sustainGain: number;
  sustainCutoff: number;
}

export class SynthEngine {
  params: SynthParams;
  private readonly ctx: AudioContext;
  private readonly output: GainNode;
  private readonly reverbSend: GainNode;
  private readonly delaySend: GainNode;

  // ライブ演奏と、録音フレーズの自動再生（さらに層ごと）が同時に同じ音程を
  // 鳴らすことがあるため、キーは音程ではなく呼び出し元が渡す一意なvoiceIdにする。
  // 音程だけをキーにすると、片方のnoteOffがもう片方のボイスを誤って奪ってしまい、
  // 「音が鳴らない」「消えないまま鳴り続ける」不具合の原因になっていた。
  private readonly voices = new Map<string, Voice>();
  private lastFrequency: number | null = null;
  /** 盛り上がりマクロ用：フィルターを全体にずらす量（セント）。0なら素の音色。 */
  private filterOffsetCents = 0;
  private readonly stage: MixStage;
  /** ミキサーで決めたリバーブ・ディレイ送り。未設定なら音色の設定を使う。 */
  private mix: LayerMix = {};

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
    this.stage = new MixStage(ctx);
    this.output.connect(this.stage.input);
    this.stage.output.connect(dryOut);

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
    this.reverbSend.gain.setTargetAtTime(this.mix.reverb ?? params.effects.reverbSend, now, 0.02);
    this.delaySend.gain.setTargetAtTime(this.mix.delay ?? params.effects.delaySend, now, 0.02);
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

  noteOn(voiceId: string, note: number, velocity = 1, time?: number): void {
    this.noteOff(voiceId, true, time);

    const { osc, filter, ampEnv, filterEnv, portamentoSeconds } = this.params;
    const now = time ?? this.ctx.currentTime;
    const targetFreq = noteToFrequency(note + osc.octave * 12);
    const startFreq =
      portamentoSeconds > 0 && this.lastFrequency !== null ? this.lastFrequency : targetFreq;
    this.lastFrequency = targetFreq;

    const voiceFilter = this.ctx.createBiquadFilter();
    voiceFilter.type = filter.type;
    voiceFilter.Q.value = filter.resonance;
    voiceFilter.detune.value = this.filterOffsetCents;

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
      sustainGain: velocity * ampEnv.sustain,
      sustainCutoff,
    };
    this.connectLfoTo(voice);
    this.voices.set(voiceId, voice);
  }

  noteOff(voiceId: string, immediate = false, time?: number): void {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    this.voices.delete(voiceId);

    const releaseSeconds = immediate ? 0.01 : this.params.ampEnv.release;
    const now = time ?? this.ctx.currentTime;
    voice.releasing = true;

    // 注意：voice.ampGain.gain.value / voice.filter.frequency.value は「今この瞬間の実効値」しか
    // 返さない。noteOnを未来の時刻でスケジュールした直後に（同じタイミングで）noteOffも未来の
    // 時刻でスケジュールすると、その時点ではまだAttack/Decayのカーブが実際には始まっていないため
    // .valueは実際のサステイン値ではなくノード生成直後の初期値を返してしまい、音量カーブが崩れて
    // ほぼ無音になっていた。noteOn時に計算しておいたサステインレベルを使うことで回避する。
    voice.ampGain.gain.cancelScheduledValues(now);
    voice.ampGain.gain.setValueAtTime(voice.sustainGain, now);
    voice.ampGain.gain.linearRampToValueAtTime(0, now + releaseSeconds);

    const filterRelease = immediate ? 0.01 : this.params.filterEnv.release;
    voice.filter.frequency.cancelScheduledValues(now);
    voice.filter.frequency.setValueAtTime(voice.sustainCutoff, now);
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

  /** この層の音量（0〜1.5）。ドライ・リバーブ送り・ディレイ送りすべてに効く。 */
  setVolume(volume: number): void {
    this.output.gain.setTargetAtTime(0.9 * volume, this.ctx.currentTime, 0.015);
  }

  /** フィルターの開き具合をセント単位でずらす（負で閉じる）。鳴っている音にも滑らかに効く。 */
  setFilterOffset(cents: number, time?: number): void {
    this.filterOffsetCents = cents;
    const now = time ?? this.ctx.currentTime;
    for (const voice of this.voices.values()) {
      voice.filter.detune.setTargetAtTime(cents, now, 0.05);
    }
  }

  /** ミキサー：パン・コンプ・リバーブ送り・ディレイ送り。 */
  setMix(mix: LayerMix | undefined): void {
    this.mix = mix ?? {};
    const now = this.ctx.currentTime;
    this.stage.setMix(mix);
    this.reverbSend.gain.setTargetAtTime(this.mix.reverb ?? this.params.effects.reverbSend, now, 0.02);
    this.delaySend.gain.setTargetAtTime(this.mix.delay ?? this.params.effects.delaySend, now, 0.02);
  }

  /** 層を消すとき：鳴っている音を止めて、内部のノードをつなぎ外す。 */
  dispose(): void {
    this.allNotesOff();
    try {
      this.lfoOsc?.stop();
    } catch {
      // すでに止まっている場合は無視
    }
    this.output.disconnect();
    this.stage.dispose();
  }

  allNotesOff(): void {
    for (const voiceId of Array.from(this.voices.keys())) {
      this.noteOff(voiceId, true);
    }
  }

  get activeNotes(): number[] {
    return Array.from(this.voices.values()).map((v) => v.note);
  }
}

function clampFrequency(hz: number): number {
  return Math.min(20000, Math.max(20, hz));
}
