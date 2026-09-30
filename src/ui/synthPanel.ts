import { Knob } from "./knob";
import type { FilterType, LfoShape, LfoTarget, OscType, SynthParams } from "../audio/synthParams";
import { clone } from "../audio/synthParams";

function makeSelect<T extends string>(
  label: string,
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "select-field";
  const title = document.createElement("label");
  title.textContent = label;
  const select = document.createElement("select");
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    if (opt.value === value) el.selected = true;
    select.appendChild(el);
  }
  select.addEventListener("change", () => onChange(select.value as T));
  wrap.appendChild(title);
  wrap.appendChild(select);
  return wrap;
}

function group(title: string, children: HTMLElement[]): HTMLElement {
  const el = document.createElement("fieldset");
  el.className = "knob-group";
  const legend = document.createElement("legend");
  legend.textContent = title;
  el.appendChild(legend);
  const row = document.createElement("div");
  row.className = "knob-row";
  for (const c of children) row.appendChild(c);
  el.appendChild(row);
  return el;
}

export interface SynthPanel {
  el: HTMLElement;
  applyPreset: (params: SynthParams) => void;
  /** 表示だけを別の音色に切り替える（onChangeは呼ばない）。編集対象の層が変わったとき用。 */
  setParams: (params: SynthParams) => void;
}

export function buildSynthPanel(
  initialParams: SynthParams,
  onChange: (params: SynthParams) => void,
): SynthPanel {
  const params = clone(initialParams);
  const emit = () => onChange(params);

  const root = document.createElement("div");
  root.className = "synth-panel";

  // オシレーター
  const oscType = makeSelect<OscType>(
    "波形",
    [
      { value: "sine", label: "サイン" },
      { value: "triangle", label: "三角" },
      { value: "sawtooth", label: "ノコギリ" },
      { value: "square", label: "矩形" },
    ],
    params.osc.type,
    (v) => {
      params.osc.type = v;
      emit();
    },
  );
  const oscOctave = new Knob({
    label: "オクターブ",
    min: -2,
    max: 2,
    value: params.osc.octave,
    step: 1,
    decimals: 0,
    onChange: (v) => {
      params.osc.octave = v;
      emit();
    },
  });
  const detune = new Knob({
    label: "デチューン",
    min: -50,
    max: 50,
    value: params.osc.detuneCents,
    unit: "¢",
    decimals: 0,
    onChange: (v) => {
      params.osc.detuneCents = v;
      emit();
    },
  });
  const unisonCount = new Knob({
    label: "ユニゾン数",
    min: 1,
    max: 7,
    value: params.osc.unisonCount,
    step: 1,
    decimals: 0,
    onChange: (v) => {
      params.osc.unisonCount = Math.round(v);
      emit();
    },
  });
  const unisonSpread = new Knob({
    label: "ユニゾン幅",
    min: 0,
    max: 50,
    value: params.osc.unisonSpreadCents,
    unit: "¢",
    decimals: 0,
    onChange: (v) => {
      params.osc.unisonSpreadCents = v;
      emit();
    },
  });
  const oscGroupEl = group("オシレーター", [
    oscType,
    oscOctave.el,
    detune.el,
    unisonCount.el,
    unisonSpread.el,
  ]);

  // フィルター
  const filterType = makeSelect<FilterType>(
    "種類",
    [
      { value: "lowpass", label: "ローパス" },
      { value: "highpass", label: "ハイパス" },
      { value: "bandpass", label: "バンドパス" },
      { value: "notch", label: "ノッチ" },
    ],
    params.filter.type,
    (v) => {
      params.filter.type = v;
      emit();
    },
  );
  const cutoff = new Knob({
    label: "カットオフ",
    min: 20,
    max: 20000,
    value: params.filter.cutoff,
    curve: "log",
    unit: "Hz",
    decimals: 0,
    onChange: (v) => {
      params.filter.cutoff = v;
      emit();
    },
  });
  const resonance = new Knob({
    label: "レゾナンス",
    min: 0.1,
    max: 20,
    value: params.filter.resonance,
    decimals: 1,
    onChange: (v) => {
      params.filter.resonance = v;
      emit();
    },
  });
  const envAmount = new Knob({
    label: "Envゲイン",
    min: -1,
    max: 1,
    value: params.filter.envAmount,
    decimals: 2,
    onChange: (v) => {
      params.filter.envAmount = v;
      emit();
    },
  });
  const filterGroupEl = group("フィルター", [filterType, cutoff.el, resonance.el, envAmount.el]);

  // アンプエンベロープ
  const ampA = new Knob({
    label: "Attack",
    min: 0,
    max: 3,
    value: params.ampEnv.attack,
    unit: "s",
    decimals: 2,
    onChange: (v) => {
      params.ampEnv.attack = v;
      emit();
    },
  });
  const ampD = new Knob({
    label: "Decay",
    min: 0,
    max: 3,
    value: params.ampEnv.decay,
    unit: "s",
    decimals: 2,
    onChange: (v) => {
      params.ampEnv.decay = v;
      emit();
    },
  });
  const ampS = new Knob({
    label: "Sustain",
    min: 0,
    max: 1,
    value: params.ampEnv.sustain,
    decimals: 2,
    onChange: (v) => {
      params.ampEnv.sustain = v;
      emit();
    },
  });
  const ampR = new Knob({
    label: "Release",
    min: 0,
    max: 4,
    value: params.ampEnv.release,
    unit: "s",
    decimals: 2,
    onChange: (v) => {
      params.ampEnv.release = v;
      emit();
    },
  });
  const ampEnvGroupEl = group("アンプ Envelope", [ampA.el, ampD.el, ampS.el, ampR.el]);

  // フィルターエンベロープ
  const fEnvA = new Knob({
    label: "Attack",
    min: 0,
    max: 3,
    value: params.filterEnv.attack,
    unit: "s",
    decimals: 2,
    onChange: (v) => {
      params.filterEnv.attack = v;
      emit();
    },
  });
  const fEnvD = new Knob({
    label: "Decay",
    min: 0,
    max: 3,
    value: params.filterEnv.decay,
    unit: "s",
    decimals: 2,
    onChange: (v) => {
      params.filterEnv.decay = v;
      emit();
    },
  });
  const fEnvS = new Knob({
    label: "Sustain",
    min: 0,
    max: 1,
    value: params.filterEnv.sustain,
    decimals: 2,
    onChange: (v) => {
      params.filterEnv.sustain = v;
      emit();
    },
  });
  const fEnvR = new Knob({
    label: "Release",
    min: 0,
    max: 4,
    value: params.filterEnv.release,
    unit: "s",
    decimals: 2,
    onChange: (v) => {
      params.filterEnv.release = v;
      emit();
    },
  });
  const filterEnvGroupEl = group("フィルター Envelope", [
    fEnvA.el,
    fEnvD.el,
    fEnvS.el,
    fEnvR.el,
  ]);

  // LFO
  const lfoTarget = makeSelect<LfoTarget>(
    "対象",
    [
      { value: "off", label: "オフ" },
      { value: "pitch", label: "ピッチ" },
      { value: "filter", label: "フィルター" },
      { value: "amp", label: "音量" },
    ],
    params.lfo.target,
    (v) => {
      params.lfo.target = v;
      emit();
    },
  );
  const lfoShape = makeSelect<LfoShape>(
    "波形",
    [
      { value: "sine", label: "サイン" },
      { value: "triangle", label: "三角" },
      { value: "square", label: "矩形" },
    ],
    params.lfo.shape,
    (v) => {
      params.lfo.shape = v;
      emit();
    },
  );
  const lfoRate = new Knob({
    label: "速さ",
    min: 0.05,
    max: 20,
    value: params.lfo.rate,
    curve: "log",
    unit: "Hz",
    decimals: 2,
    onChange: (v) => {
      params.lfo.rate = v;
      emit();
    },
  });
  const lfoDepth = new Knob({
    label: "深さ",
    min: 0,
    max: 1,
    value: params.lfo.depth,
    decimals: 2,
    onChange: (v) => {
      params.lfo.depth = v;
      emit();
    },
  });
  const lfoGroupEl = group("LFO", [lfoTarget, lfoShape, lfoRate.el, lfoDepth.el]);

  // ポルタメント & エフェクト送り
  const portamento = new Knob({
    label: "ポルタメント",
    min: 0,
    max: 1,
    value: params.portamentoSeconds,
    unit: "s",
    decimals: 2,
    onChange: (v) => {
      params.portamentoSeconds = v;
      emit();
    },
  });
  const reverbSend = new Knob({
    label: "リバーブ",
    min: 0,
    max: 1,
    value: params.effects.reverbSend,
    decimals: 2,
    onChange: (v) => {
      params.effects.reverbSend = v;
      emit();
    },
  });
  const delaySend = new Knob({
    label: "ディレイ",
    min: 0,
    max: 1,
    value: params.effects.delaySend,
    decimals: 2,
    onChange: (v) => {
      params.effects.delaySend = v;
      emit();
    },
  });
  const miscGroupEl = group("その他", [portamento.el, reverbSend.el, delaySend.el]);

  root.append(oscGroupEl, filterGroupEl, ampEnvGroupEl, filterEnvGroupEl, lfoGroupEl, miscGroupEl);

  const allKnobs: { knob: Knob; get: (p: SynthParams) => number }[] = [
    { knob: oscOctave, get: (p) => p.osc.octave },
    { knob: detune, get: (p) => p.osc.detuneCents },
    { knob: unisonCount, get: (p) => p.osc.unisonCount },
    { knob: unisonSpread, get: (p) => p.osc.unisonSpreadCents },
    { knob: cutoff, get: (p) => p.filter.cutoff },
    { knob: resonance, get: (p) => p.filter.resonance },
    { knob: envAmount, get: (p) => p.filter.envAmount },
    { knob: ampA, get: (p) => p.ampEnv.attack },
    { knob: ampD, get: (p) => p.ampEnv.decay },
    { knob: ampS, get: (p) => p.ampEnv.sustain },
    { knob: ampR, get: (p) => p.ampEnv.release },
    { knob: fEnvA, get: (p) => p.filterEnv.attack },
    { knob: fEnvD, get: (p) => p.filterEnv.decay },
    { knob: fEnvS, get: (p) => p.filterEnv.sustain },
    { knob: fEnvR, get: (p) => p.filterEnv.release },
    { knob: lfoRate, get: (p) => p.lfo.rate },
    { knob: lfoDepth, get: (p) => p.lfo.depth },
    { knob: portamento, get: (p) => p.portamentoSeconds },
    { knob: reverbSend, get: (p) => p.effects.reverbSend },
    { knob: delaySend, get: (p) => p.effects.delaySend },
  ];

  const selects: { el: HTMLSelectElement; get: (p: SynthParams) => string }[] = [
    { el: oscType.querySelector("select")!, get: (p) => p.osc.type },
    { el: filterType.querySelector("select")!, get: (p) => p.filter.type },
    { el: lfoTarget.querySelector("select")!, get: (p) => p.lfo.target },
    { el: lfoShape.querySelector("select")!, get: (p) => p.lfo.shape },
  ];

  const setParams = (next: SynthParams): void => {
    Object.assign(params, clone(next));
    for (const { knob, get } of allKnobs) knob.setValue(get(params));
    for (const { el, get } of selects) el.value = get(params);
  };
  const applyPreset = (preset: SynthParams): void => {
    setParams(preset);
    emit();
  };

  return { el: root, applyPreset, setParams };
}
