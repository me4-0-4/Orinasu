export type OscType = "sine" | "triangle" | "sawtooth" | "square";
export type FilterType = "lowpass" | "highpass" | "bandpass" | "notch";
export type LfoTarget = "off" | "pitch" | "filter" | "amp";
export type LfoShape = "sine" | "triangle" | "square";

export interface EnvelopeParams {
  attack: number; // 秒
  decay: number; // 秒
  sustain: number; // 0-1
  release: number; // 秒
}

export interface SynthParams {
  osc: {
    type: OscType;
    octave: number; // -2..2
    detuneCents: number; // -50..50
    unisonCount: number; // 1..7
    unisonSpreadCents: number; // 0..50
  };
  filter: {
    type: FilterType;
    cutoff: number; // Hz
    resonance: number; // Q
    envAmount: number; // -1..1 (カットオフへのエンベロープ量、オクターブ換算)
  };
  ampEnv: EnvelopeParams;
  filterEnv: EnvelopeParams;
  lfo: {
    rate: number; // Hz
    depth: number; // 0..1
    target: LfoTarget;
    shape: LfoShape;
  };
  portamentoSeconds: number;
  effects: {
    reverbSend: number; // 0..1
    delaySend: number; // 0..1
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export const defaultSynthParams: SynthParams = {
  osc: { type: "sawtooth", octave: 0, detuneCents: 0, unisonCount: 1, unisonSpreadCents: 12 },
  filter: { type: "lowpass", cutoff: 2400, resonance: 0.7, envAmount: 0 },
  ampEnv: { attack: 0.01, decay: 0.15, sustain: 0.7, release: 0.25 },
  filterEnv: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.3 },
  lfo: { rate: 4, depth: 0, target: "off", shape: "sine" },
  portamentoSeconds: 0,
  effects: { reverbSend: 0.08, delaySend: 0 },
};

export interface SynthPreset {
  id: string;
  name: string;
  params: SynthParams;
}

export const synthPresets: SynthPreset[] = [
  {
    id: "lead",
    name: "リード",
    params: {
      osc: { type: "sawtooth", octave: 0, detuneCents: 0, unisonCount: 3, unisonSpreadCents: 14 },
      filter: { type: "lowpass", cutoff: 3200, resonance: 1.2, envAmount: 0.2 },
      ampEnv: { attack: 0.005, decay: 0.12, sustain: 0.8, release: 0.18 },
      filterEnv: { attack: 0.01, decay: 0.25, sustain: 0.4, release: 0.2 },
      lfo: { rate: 5, depth: 0.08, target: "pitch", shape: "sine" },
      portamentoSeconds: 0,
      effects: { reverbSend: 0.1, delaySend: 0.12 },
    },
  },
  {
    id: "bass",
    name: "ベース",
    params: {
      osc: { type: "square", octave: -1, detuneCents: 0, unisonCount: 1, unisonSpreadCents: 0 },
      filter: { type: "lowpass", cutoff: 900, resonance: 0.9, envAmount: 0.5 },
      ampEnv: { attack: 0.002, decay: 0.1, sustain: 0.75, release: 0.08 },
      filterEnv: { attack: 0.002, decay: 0.15, sustain: 0.2, release: 0.1 },
      lfo: { rate: 3, depth: 0, target: "off", shape: "sine" },
      portamentoSeconds: 0.03,
      effects: { reverbSend: 0.02, delaySend: 0 },
    },
  },
  {
    id: "pad",
    name: "パッド",
    params: {
      osc: { type: "triangle", octave: 0, detuneCents: 4, unisonCount: 5, unisonSpreadCents: 18 },
      filter: { type: "lowpass", cutoff: 1800, resonance: 0.4, envAmount: 0.15 },
      ampEnv: { attack: 0.6, decay: 0.4, sustain: 0.8, release: 1.4 },
      filterEnv: { attack: 0.8, decay: 0.6, sustain: 0.6, release: 1.2 },
      lfo: { rate: 0.6, depth: 0.15, target: "filter", shape: "sine" },
      portamentoSeconds: 0.08,
      effects: { reverbSend: 0.35, delaySend: 0.1 },
    },
  },
  {
    id: "pluck",
    name: "プラック",
    params: {
      osc: { type: "triangle", octave: 0, detuneCents: 0, unisonCount: 2, unisonSpreadCents: 8 },
      filter: { type: "lowpass", cutoff: 2600, resonance: 1.6, envAmount: 0.35 },
      ampEnv: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.15 },
      filterEnv: { attack: 0.002, decay: 0.3, sustain: 0, release: 0.15 },
      lfo: { rate: 4, depth: 0, target: "off", shape: "sine" },
      portamentoSeconds: 0,
      effects: { reverbSend: 0.15, delaySend: 0.18 },
    },
  },
];
