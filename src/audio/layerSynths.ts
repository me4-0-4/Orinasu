/** LayerSynths が使うバス。ライブ（AudioEngine）にも、書き出し（AudioBuses＋オフライン）にも使える。 */
export interface SynthBusSet {
  ctx: BaseAudioContext;
  synthDry: AudioNode;
  synthReverbSend: AudioNode;
  synthDelaySend: AudioNode;
  drumOut: AudioNode;
}
import { SynthEngine } from "./synth";
import { clone, defaultSynthParams, synthPresets, type SynthParams } from "./synthParams";
import { usesSampler, type Layer, type LayerRole } from "../phrase/types";
import { SamplerEngine } from "./samplerEngine";
import { DrumStrip } from "./mixStage";

export const DEFAULT_VOLUME = 1;
export const MAX_VOLUME = 1.5;

/** 役割ごとの初期音色（プリセットのid）。 */
const roleDefaultPreset: Partial<Record<LayerRole, string>> = {
  melody: "lead",
  bass: "bass",
  chords: "pad",
  other: "pluck",
};

export function defaultSynthFor(role: LayerRole): SynthParams {
  const id = roleDefaultPreset[role];
  const preset = synthPresets.find((p) => p.id === id);
  return clone(preset ? preset.params : defaultSynthParams);
}

/**
 * 層ごとにシンセを1台ずつ持つ。音色（layer.synth）と音量（layer.volume）は層のデータに
 * 入っているので、フレーズと一緒に保存される。
 */
/** 層を鳴らす楽器（シンセかサンプラー）。録音・再生・書き出しはこの口だけを使う。 */
export interface LayerInstrument {
  noteOn(voiceId: string, note: number, velocity?: number, time?: number): void;
  noteOff(voiceId: string, immediate?: boolean, time?: number): void;
}

export class LayerSynths {
  private readonly engines = new Map<string, SynthEngine>();
  private readonly samplers = new Map<string, SamplerEngine>();
  private readonly audio: SynthBusSet;
  private filterOffset = 0;
  private readonly drumStrips = new Map<string, DrumStrip>();
  private readonly getSample: (soundId: string) => AudioBuffer | null;

  /** getSample：サンプラーが鳴らす音の中身（まだ用意できていなければ null で、その音は鳴らない）。 */
  constructor(audio: SynthBusSet, getSample: (soundId: string) => AudioBuffer | null = () => null) {
    this.audio = audio;
    this.getSample = getSample;
  }

  /** 層の楽器を返す。サンプラーの層ならサンプラー、そうでなければシンセ。 */
  instrumentFor(layer: Layer): LayerInstrument {
    return usesSampler(layer) ? this.samplerFor(layer) : this.forLayer(layer);
  }

  /** 曲のテンポ（テンポの分かる音を鳴らすサンプラーが、速さを合わせる）。 */
  setTempo(bpm: number): void {
    this.tempo = bpm;
    for (const engine of this.samplers.values()) engine.setTempo(bpm);
  }
  private tempo: number | undefined;

  /** 層のサンプラーを返す（なければ作る）。 */
  samplerFor(layer: Layer): SamplerEngine {
    const params = layer.sampler!;
    let engine = this.samplers.get(layer.id);
    if (!engine) {
      engine = new SamplerEngine(
        this.audio.ctx,
        this.audio.synthDry,
        this.audio.synthReverbSend,
        this.audio.synthDelaySend,
        params,
        this.getSample,
      );
      engine.setFilterOffset(this.filterOffset);
      engine.setTempo(this.tempo);
      this.samplers.set(layer.id, engine);
    } else if (engine.params !== params) {
      engine.updateParams(params);
    }
    engine.setVolume(layer.volume ?? DEFAULT_VOLUME);
    engine.setMix(layer.mix);
    return engine;
  }

  /** 層のシンセを返す（なければ作る）。音色が未設定なら役割ごとの初期音色を入れる。 */
  forLayer(layer: Layer): SynthEngine {
    if (!layer.synth) layer.synth = defaultSynthFor(layer.role);
    let engine = this.engines.get(layer.id);
    if (!engine) {
      engine = new SynthEngine(
        this.audio.ctx,
        this.audio.synthDry,
        this.audio.synthReverbSend,
        this.audio.synthDelaySend,
        layer.synth,
      );
      engine.setFilterOffset(this.filterOffset);
      this.engines.set(layer.id, engine);
    } else if (engine.params !== layer.synth) {
      // フレーズの読み込みなどで層のデータが差し替わったときに追従する
      engine.updateParams(layer.synth);
    }
    engine.setVolume(layer.volume ?? DEFAULT_VOLUME);
    engine.setMix(layer.mix);
    return engine;
  }

  /** ドラム層の出口（パン・コンプ・送り付き）。ドラムを鳴らすときの送り先にする。 */
  drumOut(layer: Layer): AudioNode {
    let strip = this.drumStrips.get(layer.id);
    if (!strip) {
      strip = new DrumStrip(this.audio.ctx, this.audio.drumOut, this.audio.synthReverbSend, this.audio.synthDelaySend);
      this.drumStrips.set(layer.id, strip);
    }
    strip.setMix(layer.mix);
    return strip.input;
  }

  /** ミキサーを動かしたとき：層の音量と設定を、鳴っている音にもすぐ反映する。 */
  refresh(layer: Layer): void {
    if (layer.role === "drums") this.drumOut(layer);
    else this.instrumentFor(layer);
  }

  setParams(layer: Layer, params: SynthParams): void {
    layer.synth = params;
    this.forLayer(layer).updateParams(params);
  }

  setVolume(layer: Layer, volume: number): void {
    layer.volume = volume;
    this.engines.get(layer.id)?.setVolume(volume);
    this.samplers.get(layer.id)?.setVolume(volume);
  }

  /** 盛り上がりマクロ：全部の層のフィルターを同じ量だけずらす。 */
  setFilterOffsetAll(cents: number): void {
    if (cents !== 0 && Math.abs(cents - this.filterOffset) < 15) return; // 細かい変化は無視して負荷を抑える
    this.filterOffset = cents;
    for (const engine of this.engines.values()) engine.setFilterOffset(cents);
    for (const engine of this.samplers.values()) engine.setFilterOffset(cents);
  }

  allNotesOff(): void {
    for (const engine of this.engines.values()) engine.allNotesOff();
    for (const engine of this.samplers.values()) engine.allNotesOff();
  }

  /** いま存在する層以外のシンセを片付ける。 */
  prune(keepIds: Set<string>): void {
    for (const [id, engine] of this.engines) {
      if (keepIds.has(id)) continue;
      engine.dispose();
      this.engines.delete(id);
    }
    for (const [id, engine] of this.samplers) {
      if (keepIds.has(id)) continue;
      engine.dispose();
      this.samplers.delete(id);
    }
    for (const [id, strip] of this.drumStrips) {
      if (keepIds.has(id)) continue;
      strip.dispose();
      this.drumStrips.delete(id);
    }
  }
}
