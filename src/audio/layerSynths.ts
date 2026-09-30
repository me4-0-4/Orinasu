import type { AudioEngine } from "./context";
import { SynthEngine } from "./synth";
import { clone, defaultSynthParams, synthPresets, type SynthParams } from "./synthParams";
import type { Layer, LayerRole } from "../phrase/types";

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
export class LayerSynths {
  private readonly engines = new Map<string, SynthEngine>();
  private readonly audio: AudioEngine;

  constructor(audio: AudioEngine) {
    this.audio = audio;
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
      this.engines.set(layer.id, engine);
    } else if (engine.params !== layer.synth) {
      // フレーズの読み込みなどで層のデータが差し替わったときに追従する
      engine.updateParams(layer.synth);
    }
    engine.setVolume(layer.volume ?? DEFAULT_VOLUME);
    return engine;
  }

  setParams(layer: Layer, params: SynthParams): void {
    layer.synth = params;
    this.forLayer(layer).updateParams(params);
  }

  setVolume(layer: Layer, volume: number): void {
    layer.volume = volume;
    this.engines.get(layer.id)?.setVolume(volume);
  }

  allNotesOff(): void {
    for (const engine of this.engines.values()) engine.allNotesOff();
  }

  /** いま存在する層以外のシンセを片付ける。 */
  prune(keepIds: Set<string>): void {
    for (const [id, engine] of this.engines) {
      if (keepIds.has(id)) continue;
      engine.dispose();
      this.engines.delete(id);
    }
  }
}
