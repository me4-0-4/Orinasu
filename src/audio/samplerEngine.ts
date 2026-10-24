import { MixStage } from "./mixStage";
import type { LayerMix } from "../phrase/types";
import { playRegion, playbackRate, type SamplerParams } from "../sound/sampler";

interface Voice {
  source: AudioBufferSourceNode;
  amp: GainNode;
  /** 鳴り終わる時刻（ctx の時刻）。 */
  endsAt: number;
  releasing: boolean;
}

/**
 * 読み込んだ音を鍵盤で鳴らす音源。SynthEngine と同じ口（noteOn・noteOff・音量・ミキサー）を持つので、
 * 層の楽器をシンセからサンプラーに替えても、録音・再生・書き出しの所はそのまま使える。
 */
export class SamplerEngine {
  params: SamplerParams;
  private readonly ctx: BaseAudioContext;
  private readonly getBuffer: (soundId: string) => AudioBuffer | null;
  private readonly output: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly stage: MixStage;
  private readonly reverbSend: GainNode;
  private readonly delaySend: GainNode;
  private readonly voices = new Map<string, Voice>();

  constructor(
    ctx: BaseAudioContext,
    dryOut: AudioNode,
    reverbSend: AudioNode,
    delaySend: AudioNode,
    params: SamplerParams,
    getBuffer: (soundId: string) => AudioBuffer | null,
  ) {
    this.ctx = ctx;
    this.params = params;
    this.getBuffer = getBuffer;

    // 盛り上がりマクロ（フィルターを全体にずらす）用の、ふだんは開ききったローパス
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 20000;
    this.filter.Q.value = 0.5;
    this.output = ctx.createGain();
    this.output.gain.value = 0.9;
    this.filter.connect(this.output);
    this.stage = new MixStage(ctx);
    this.output.connect(this.stage.input);
    this.stage.output.connect(dryOut);

    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0;
    this.output.connect(this.reverbSend);
    this.reverbSend.connect(reverbSend);
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0;
    this.output.connect(this.delaySend);
    this.delaySend.connect(delaySend);
  }

  updateParams(params: SamplerParams): void {
    this.params = params;
  }

  noteOn(voiceId: string, note: number, velocity = 1, time?: number): void {
    const buffer = this.getBuffer(this.params.soundId);
    if (!buffer) return;
    const at = Math.max(time ?? this.ctx.currentTime, this.ctx.currentTime);
    // 同じ voiceId がまだ鳴っていたら、すぐ止めてから鳴らし直す
    if (this.voices.has(voiceId)) this.noteOff(voiceId, true, at);

    const p = this.params;
    const rate = playbackRate(note, p);
    const region = playRegion(p, buffer.duration);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const amp = this.ctx.createGain();
    const peak = Math.max(0.0001, Math.min(1, velocity));
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(peak, at + Math.max(0.002, p.attack));
    source.connect(amp);
    amp.connect(this.filter);
    const playSeconds = region.length / rate;
    // 範囲の終わりで切れるとプツッと鳴るので、最後だけ少しだけ絞る
    const fade = Math.min(0.01, playSeconds / 4);
    amp.gain.setValueAtTime(peak, Math.max(at + p.attack, at + playSeconds - fade));
    amp.gain.linearRampToValueAtTime(0, at + playSeconds);
    source.start(at, region.offset, region.length);
    const voice: Voice = { source, amp, endsAt: at + playSeconds, releasing: false };
    this.voices.set(voiceId, voice);
    source.onended = () => {
      if (this.voices.get(voiceId) === voice) this.voices.delete(voiceId);
      amp.disconnect();
    };
  }

  /** immediate：すぐ止める。そうでなければ、押している間だけの音は消え方（release）で消し、最後まで鳴る音はそのまま。 */
  noteOff(voiceId: string, immediate = false, time?: number): void {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    // 最後まで鳴らす音は、離しても止めない（鳴り終われば onended で片付く）
    if (!immediate && this.params.hold === "oneshot") return;
    const at = Math.max(time ?? this.ctx.currentTime, this.ctx.currentTime);
    if (at >= voice.endsAt) return;
    this.voices.delete(voiceId);
    voice.releasing = true;
    const release = immediate ? 0.005 : Math.max(0.005, this.params.release);
    const g = voice.amp.gain;
    g.cancelScheduledValues(at);
    // 立ち上がりの途中でも、いまの大きさから消す
    g.setTargetAtTime(0, at, release / 4);
    try {
      voice.source.stop(at + release + 0.02);
    } catch {
      // もう止まっている
    }
  }

  /** この層の音量（0〜1.5）。 */
  setVolume(volume: number): void {
    this.output.gain.setTargetAtTime(0.9 * volume, this.ctx.currentTime, 0.015);
  }

  /** 盛り上がりマクロ：フィルターを閉じる（負のセント）。 */
  setFilterOffset(cents: number, time?: number): void {
    const hz = Math.min(20000, 20000 * Math.pow(2, Math.min(0, cents) / 1200));
    this.filter.frequency.setTargetAtTime(hz, time ?? this.ctx.currentTime, 0.05);
  }

  setMix(mix: LayerMix | undefined): void {
    const now = this.ctx.currentTime;
    this.stage.setMix(mix);
    this.reverbSend.gain.setTargetAtTime(mix?.reverb ?? 0, now, 0.02);
    this.delaySend.gain.setTargetAtTime(mix?.delay ?? 0, now, 0.02);
  }

  allNotesOff(): void {
    for (const id of Array.from(this.voices.keys())) this.noteOff(id, true);
  }

  dispose(): void {
    this.allNotesOff();
    this.output.disconnect();
    this.stage.dispose();
  }
}
