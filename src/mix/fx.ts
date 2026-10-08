import type { Pcm } from "./pcm.ts";

/**
 * エフェクト（REAPER 風）。
 * - トラック（層・下地・伸ばし・マスター）ごとに「FXチェーン」：プラグインを上から順に掛ける。1つずつバイパスできる
 * - プラグインのつまみ（量・ウェット）は「エンベロープ」（折れ線）で時間とともに動かせる
 * - 断片1つにも、その断片だけの FX チェーン（テイクFX）を持たせられる。テイクFX → トラックFX の順に掛かる
 */
export type FxKind = "reverb" | "delay" | "lowCut" | "highCut" | "drive" | "crush";
export const FX_KINDS: FxKind[] = ["reverb", "delay", "lowCut", "highCut", "drive", "crush"];
export const FX_LABELS: Record<FxKind, string> = {
  reverb: "リバーブ",
  delay: "ディレイ",
  lowCut: "ハイパス（低音を削る）",
  highCut: "ローパス（高音を削る）",
  drive: "ディストーション（歪み）",
  crush: "ビットクラッシャー（音質下げ）",
};
export const FX_SHORT: Record<FxKind, string> = {
  reverb: "Reverb",
  delay: "Delay",
  lowCut: "HPF",
  highCut: "LPF",
  drive: "Dist",
  crush: "Crush",
};

/** ディレイの間隔（音符の長さ）。1/8d は付点8分。 */
export type DelayTime = "1/16" | "1/8" | "1/8d" | "1/4";
export const DELAY_TIMES: DelayTime[] = ["1/16", "1/8", "1/8d", "1/4"];
const DELAY_BEATS: Record<DelayTime, number> = { "1/16": 0.25, "1/8": 0.5, "1/8d": 0.75, "1/4": 1 };

export interface FxPlugin {
  id: string;
  kind: FxKind;
  /** バイパス（一時的に切る）。 */
  bypass: boolean;
  /** 主なつまみ（0〜1）。リバーブ・ディレイは送る量、HPF・LPF は周波数、歪み・音質下げは掛かり方。 */
  amount: number;
  /** ウェット（0〜1）：掛けた音を、どれだけ混ぜるか。リバーブ・ディレイでは、送りの開き具合。 */
  mix: number;
  /** リバーブの長さ（0〜1。0で0.3秒、1で6秒）。 */
  size: number;
  /** リバーブの明るさ（0〜1）。 */
  tone: number;
  /** ディレイの間隔。 */
  time: DelayTime;
  /** ディレイのくり返し（0〜1）。 */
  feedback: number;
}

/** エンベロープで動かせるつまみ。 */
export type EnvParam = "amount" | "mix";
export const ENV_PARAM_LABELS: Record<EnvParam, string> = { amount: "量", mix: "ウェット" };

/** エンベロープの点：t は曲の頭からのステップ（16分＝1）、v は 0〜1。 */
export interface EnvPoint {
  t: number;
  v: number;
}

export interface Envelope {
  id: string;
  pluginId: string;
  param: EnvParam;
  points: EnvPoint[];
  /** 切っていれば、つまみの値のまま。 */
  active: boolean;
  /** トラックの下に表示するか。 */
  visible: boolean;
}

/** 新しいエンベロープ：曲の頭から終わりまで、いまの値で平ら。 */
export function newEnvelope(plugin: FxPlugin, param: EnvParam, totalSteps: number): Envelope {
  const v = plugin[param];
  return { id: fxId("env"), pluginId: plugin.id, param, points: [{ t: 0, v }, { t: totalSteps, v }], active: true, visible: true };
}

/** 1つのトラックのエフェクト：FXチェーンと、エンベロープ。 */
export interface TrackFx {
  chain: FxPlugin[];
  envelopes: Envelope[];
}

/** 断片1つだけのFXチェーン（テイクFX）。step はその断片を打つ位置。 */
export interface TakeFx {
  step: number;
  chain: FxPlugin[];
}

/** 曲が持つエフェクト：マスター・下地・伸ばし（層ごとのものは層が持つ）。 */
export interface SongFx {
  master: TrackFx;
  bed: TrackFx;
  pad: TrackFx;
}

let idCounter = 0;
export function fxId(prefix = "fx"): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function newPlugin(kind: FxKind, over: Partial<FxPlugin> = {}): FxPlugin {
  const amount = kind === "reverb" ? 0.3 : kind === "delay" ? 0.4 : 0.5;
  return { id: fxId(), kind, bypass: false, amount, mix: 1, size: 0.35, tone: 0.5, time: "1/8d", feedback: 0.35, ...over };
}

export const emptyTrack = (): TrackFx => ({ chain: [], envelopes: [] });

export function defaultSongFx(): SongFx {
  return { master: { chain: [newPlugin("reverb", { amount: 0.15 })], envelopes: [] }, bed: emptyTrack(), pad: emptyTrack() };
}

const OFF = 0.001;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 鳴らすプラグイン（バイパスしていないもの）。 */
const live = (chain: FxPlugin[]): FxPlugin[] => chain.filter((p) => !p.bypass);

/** 何も掛からないトラックか（処理を省ける）。 */
export function trackIsOff(track: TrackFx | undefined): boolean {
  return !track || live(track.chain).length === 0;
}

/** トラックに、鳴っているプラグインがあるか（FXボタンを光らせる）。 */
export const trackHasFx = (track: TrackFx | undefined): boolean => !trackIsOff(track);

/** ディレイ・リバーブの長さなどの数字。 */
export const reverbSeconds = (size: number): number => 0.3 * Math.pow(20, clamp01(size));
export const reverbToneHz = (tone: number): number => 1500 * Math.pow(8, clamp01(tone));
export const delaySeconds = (time: DelayTime, bpm: number): number => (DELAY_BEATS[time] * 60) / bpm;
export const delayFeedbackGain = (feedback: number): number => 0.85 * clamp01(feedback);
export const lowCutHz = (v: number): number => 20 * Math.pow(100, clamp01(v));
export const highCutHz = (v: number): number => 20000 * Math.pow(300 / 20000, clamp01(v));

/** FXチェーンの余韻の長さ（秒）：リバーブの長さと、ディレイが 1/1000 まで小さくなる時間の長いほう。 */
export function chainTailSeconds(chain: FxPlugin[], bpm: number): number {
  let tail = 0.05;
  for (const p of live(chain)) {
    if (p.kind === "reverb") tail = Math.max(tail, reverbSeconds(p.size) + 0.05);
    if (p.kind === "delay") {
      const fb = delayFeedbackGain(p.feedback);
      const repeats = fb <= 0 ? 1 : Math.ceil(Math.log(0.001) / Math.log(fb)) + 1;
      tail = Math.max(tail, delaySeconds(p.time, bpm) * repeats);
    }
  }
  return tail;
}

/** プラグインのつまみの値を、人が読める形にする。 */
export function describeAmount(p: Pick<FxPlugin, "kind">, v: number): string {
  if (p.kind === "lowCut") return `${Math.round(lowCutHz(v))} Hz`;
  if (p.kind === "highCut") return `${Math.round(highCutHz(v))} Hz`;
  return `${Math.round(v * 100)}%`;
}

// ---------------------------------------------------------------- 読み込み

/** 保存されていた1つのプラグインを読む（おかしければ null）。 */
export function sanitizePlugin(raw: unknown): FxPlugin | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!FX_KINDS.includes(r.kind as FxKind)) return null;
  const p = newPlugin(r.kind as FxKind);
  if (typeof r.id === "string" && r.id) p.id = r.id;
  if (typeof r.bypass === "boolean") p.bypass = r.bypass;
  for (const key of ["amount", "mix", "size", "tone", "feedback"] as const) if (isNum(r[key])) p[key] = clamp01(r[key]);
  if (DELAY_TIMES.includes(r.time as DelayTime)) p.time = r.time as DelayTime;
  return p;
}

function sanitizePoints(raw: unknown): EnvPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is { t: number; v: number } => typeof x === "object" && x !== null && isNum((x as EnvPoint).t) && isNum((x as EnvPoint).v))
    .map((x) => ({ t: Math.max(0, x.t), v: clamp01(x.v) }))
    .sort((a, b) => a.t - b.t);
}

/** 少し前の形（並べた「いつ掛けるか」つきのエフェクト、その前の1組の設定）を読むときに、必要な曲の情報。 */
export interface LegacyContext {
  stepsPerBar: number;
  bars: number;
}

/**
 * 保存されていたトラックのエフェクトを読む。
 * いまの形 {chain, envelopes} のほか、少し前の形も読む：
 * - 並べたエフェクト（[{kind, amount, when, from, to, steps}…]）：いつ掛けるか は、ウェットのエンベロープ（四角い形）にする。
 *   選んだ断片だけ（hits）のものは、takes に断片ごとのテイクFXとして返す。
 * - 1組の設定（{reverb, delay, lowCut…}）：0でないものを順に並べる。
 */
export function sanitizeTrack(raw: unknown, legacy: LegacyContext, takes?: TakeFx[]): TrackFx {
  const track = emptyTrack();
  if (typeof raw !== "object" || raw === null) return track;
  if (!Array.isArray(raw) && Array.isArray((raw as TrackFx).chain)) {
    const r = raw as { chain: unknown[]; envelopes?: unknown };
    track.chain = r.chain.map(sanitizePlugin).filter((p): p is FxPlugin => p !== null);
    const ids = new Set(track.chain.map((p) => p.id));
    if (Array.isArray(r.envelopes)) {
      for (const e of r.envelopes as Record<string, unknown>[]) {
        if (typeof e !== "object" || e === null || typeof e.pluginId !== "string" || !ids.has(e.pluginId)) continue;
        if (e.param !== "amount" && e.param !== "mix") continue;
        track.envelopes.push({
          id: typeof e.id === "string" ? e.id : fxId("env"),
          pluginId: e.pluginId,
          param: e.param,
          points: sanitizePoints(e.points),
          active: e.active !== false,
          visible: e.visible !== false,
        });
      }
    }
    return track;
  }
  if (Array.isArray(raw)) {
    for (const slot of raw as Record<string, unknown>[]) {
      const p = sanitizePlugin(slot);
      if (!p) continue;
      const when = slot.when;
      if (when === "hits") {
        const steps = Array.isArray(slot.steps) ? slot.steps.filter(isNum) : [];
        for (const step of steps) {
          const take = takes?.find((t) => t.step === step);
          if (take) take.chain.push({ ...p, id: fxId() });
          else takes?.push({ step, chain: [{ ...p, id: fxId() }] });
        }
        continue;
      }
      track.chain.push(p);
      const spb = legacy.stepsPerBar;
      let ranges: [number, number][] = [];
      if (when === "bars") {
        const from = Math.max(1, isNum(slot.from) ? slot.from : 1) - 1;
        const to = Math.max(from + 1, isNum(slot.to) ? slot.to : from + 1);
        ranges = [[from * spb, to * spb]];
      } else if (when === "fills") {
        ranges = fillBars(legacy.bars).map((b) => [b * spb, (b + 1) * spb]);
      }
      if (ranges.length > 0) {
        const points: EnvPoint[] = [{ t: 0, v: 0 }];
        for (const [a, b] of ranges) points.push({ t: a, v: 0 }, { t: a, v: 1 }, { t: b, v: 1 }, { t: b, v: 0 });
        track.envelopes.push({ id: fxId("env"), pluginId: p.id, param: "mix", points, active: true, visible: true });
      }
    }
    return track;
  }
  const r = raw as Record<string, unknown>;
  const num = (k: string, d: number): number => (isNum(r[k]) ? clamp01(r[k] as number) : d);
  const time = DELAY_TIMES.includes(r.delayTime as DelayTime) ? (r.delayTime as DelayTime) : "1/8d";
  if (num("drive", 0) > 0.01) track.chain.push(newPlugin("drive", { amount: num("drive", 0) }));
  if (num("crush", 0) > 0.01) track.chain.push(newPlugin("crush", { amount: num("crush", 0) }));
  if (num("lowCut", 0) > 0.01) track.chain.push(newPlugin("lowCut", { amount: num("lowCut", 0) }));
  if (num("highCut", 0) > 0.01) track.chain.push(newPlugin("highCut", { amount: num("highCut", 0) }));
  if (num("delay", 0) > 0.01) track.chain.push(newPlugin("delay", { amount: num("delay", 0), time, feedback: num("delayFeedback", 0.35) }));
  if (num("reverb", 0) > 0.01) track.chain.push(newPlugin("reverb", { amount: num("reverb", 0), size: num("reverbSize", 0.35), tone: num("reverbTone", 0.5) }));
  return track;
}

/** 保存されていたテイクFXを読む。 */
export function sanitizeTakes(raw: unknown): TakeFx[] {
  if (!Array.isArray(raw)) return [];
  const out: TakeFx[] = [];
  for (const t of raw as Record<string, unknown>[]) {
    if (typeof t !== "object" || t === null || !isNum(t.step) || !Array.isArray(t.chain)) continue;
    const chain = t.chain.map(sanitizePlugin).filter((p): p is FxPlugin => p !== null);
    const step = Math.max(0, Math.round(t.step));
    if (chain.length > 0 && !out.some((o) => o.step === step)) out.push({ step, chain });
  }
  return out.sort((a, b) => a.step - b.step);
}

/** フィルの小節（0から数える）：4小節ごとの4小節目と、最後の小節。 */
export function fillBars(bars: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < bars; b++) if ((b % 4 === 3 || b === bars - 1) && bars > 1) out.push(b);
  return out;
}

// ---------------------------------------------------------------- エンベロープ

/** 折れ線の、位置 t（ステップ）での値。最初の点より前は最初の値、最後の点より後は最後の値。 */
export function envValueAt(points: EnvPoint[], t: number): number {
  if (points.length === 0) return 0;
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t < b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    if (t === b.t) {
      // 同じ位置に点が2つあるとき（四角い形）は、あとの点の値
      let j = i;
      while (j + 1 < points.length && points[j + 1].t === t) j++;
      return points[j].v;
    }
  }
  return points[points.length - 1].v;
}

/** 折れ線を、サンプルごとの値にする。 */
export function envCurve(points: EnvPoint[], n: number, stepSamples: number): Float32Array {
  const out = new Float32Array(n);
  if (points.length === 0) return out;
  // 点を前から順にたどる（サンプルごとに全部の点を見直さない）
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / stepSamples;
    while (k < points.length && points[k].t <= t) k++;
    if (k === 0) out[i] = points[0].v;
    else if (k === points.length) out[i] = points[points.length - 1].v;
    else {
      const a = points[k - 1];
      const b = points[k];
      out[i] = b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 音の処理

export interface FxEnv {
  stepSamples: number;
  sampleRate: number;
  bpm: number;
  /** リバーブの響きだけ（元の音を含まない）を作る。余韻は頭に重ねて、同じ長さで返す。 */
  reverb: (pcm: Pcm, seconds: number, toneHz: number) => Promise<Pcm>;
}

/** つまみの値：エンベロープがあればサンプルごとの値、無ければ一定の値。 */
type Curve = Float32Array | number;
const at = (c: Curve, i: number): number => (typeof c === "number" ? c : c[i]);

/**
 * トラックのFXチェーンを、上から順に掛ける（バイパスしたものは飛ばす）。
 * リバーブ・ディレイは「送り」：量×ウェットだけ送って響かせる（量・ウェットを下げても、それまでの響きは自然に残る）。
 * HPF・LPF・歪み・音質下げは「差し込み」：掛けた音と元の音を、ウェットの割合で混ぜる。
 */
export async function applyTrack(pcm: Pcm, track: TrackFx, env: FxEnv): Promise<Pcm> {
  const n = pcm.l.length;
  let x: Pcm = { l: pcm.l.slice(), r: pcm.r.slice() };
  for (const p of live(track.chain)) {
    const curve = (param: EnvParam): Curve => {
      const e = track.envelopes.find((v) => v.pluginId === p.id && v.param === param && v.active && v.points.length > 0);
      return e ? envCurve(e.points, n, env.stepSamples) : p[param];
    };
    const amount = curve("amount");
    const mix = curve("mix");
    if (typeof amount === "number" && amount < OFF && (p.kind === "reverb" || p.kind === "delay" || p.kind === "drive" || p.kind === "crush")) continue;
    if (typeof mix === "number" && mix < OFF) continue;
    if (p.kind === "reverb" || p.kind === "delay") {
      const gain = p.kind === "reverb" ? 0.5 : 0.6;
      const send: Pcm = { l: new Float32Array(n), r: new Float32Array(n) };
      for (let i = 0; i < n; i++) {
        const g = gain * at(amount, i) * at(mix, i);
        send.l[i] = x.l[i] * g;
        send.r[i] = x.r[i] * g;
      }
      const wet =
        p.kind === "reverb"
          ? await env.reverb(send, reverbSeconds(p.size), reverbToneHz(p.tone))
          : delayWet(send, delaySeconds(p.time, env.bpm) * env.sampleRate, delayFeedbackGain(p.feedback));
      for (let i = 0; i < n; i++) {
        x.l[i] += wet.l[i];
        x.r[i] += wet.r[i];
      }
    } else {
      const y = insertFx(x, p.kind, amount, env.sampleRate);
      if (typeof mix === "number" && mix >= 1 - OFF) {
        x = y;
      } else {
        for (let i = 0; i < n; i++) {
          const m = at(mix, i);
          x.l[i] += (y.l[i] - x.l[i]) * m;
          x.r[i] += (y.r[i] - x.r[i]) * m;
        }
      }
    }
  }
  return x;
}

/**
 * ディレイのやまびこだけ（元の音を含まない）。曲の終わりを越えたやまびこは頭に回す（くり返してもつながる）。
 * やまびこは、くり返すたびに少しこもらせる。
 */
export function delayWet(pcm: Pcm, delaySamples: number, feedback: number): Pcm {
  const n = pcm.l.length;
  const d = Math.max(1, Math.round(delaySamples));
  const out: Pcm = { l: new Float32Array(n), r: new Float32Array(n) };
  if (n === 0) return out;
  const repeats = feedback <= 0 ? 1 : Math.min(Math.ceil(Math.log(0.001) / Math.log(feedback)) + 1, Math.ceil((4 * n) / d));
  let cur: Pcm = pcm;
  let gain = 1;
  for (let k = 1; k <= repeats; k++) {
    cur = darken(cur, 0.6);
    const shift = (k * d) % n;
    for (let i = 0; i < n; i++) {
      const j = (i + shift) % n;
      out.l[j] += cur.l[i] * gain;
      out.r[j] += cur.r[i] * gain;
    }
    gain *= feedback;
    if (gain < 0.001) break;
  }
  return out;
}

/** ごく弱いローパス（やまびこを少しずつこもらせる）。 */
function darken(pcm: Pcm, a: number): Pcm {
  const out: Pcm = { l: new Float32Array(pcm.l.length), r: new Float32Array(pcm.r.length) };
  let yl = 0;
  let yr = 0;
  for (let i = 0; i < pcm.l.length; i++) {
    yl += a * (pcm.l[i] - yl);
    yr += a * (pcm.r[i] - yr);
    out.l[i] = yl;
    out.r[i] = yr;
  }
  return out;
}

/** 差し込みのエフェクトを、全体に掛けた音（量はサンプルごとに変えられる）。 */
function insertFx(pcm: Pcm, kind: FxKind, amount: Curve, sampleRate: number): Pcm {
  if (kind === "lowCut") return biquad(pcm, "highpass", (i) => lowCutHz(at(amount, i)), sampleRate);
  if (kind === "highCut") return biquad(pcm, "lowpass", (i) => highCutHz(at(amount, i)), sampleRate);
  return drive(pcm, kind === "drive" ? amount : 0, kind === "crush" ? amount : 0);
}

/** 係数を計算し直す間隔（サンプル）。周波数を動かしても、なめらかに聞こえる細かさ。 */
const COEF_BLOCK = 32;

/** 2次のフィルター（12dB/oct）。周波数は freq(i) で、時間とともに変えられる。 */
export function biquad(pcm: Pcm, type: "lowpass" | "highpass", freq: (i: number) => number, sampleRate: number): Pcm {
  const coef = (f: number): number[] => {
    const w = (2 * Math.PI * Math.min(f, sampleRate * 0.45)) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const b0 = type === "lowpass" ? (1 - cos) / 2 : (1 + cos) / 2;
    const b1 = type === "lowpass" ? 1 - cos : -(1 + cos);
    const a0 = 1 + alpha;
    return [b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  };
  const out: Pcm = { l: new Float32Array(pcm.l.length), r: new Float32Array(pcm.r.length) };
  for (const [src, dst] of [
    [pcm.l, out.l],
    [pcm.r, out.r],
  ] as const) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let c = coef(freq(0));
    // くり返しのつなぎ目でプチッとしないよう、曲の終わりの少しを先に通して、フィルターを温めておく
    const pre = Math.min(src.length, Math.round(sampleRate * 0.2));
    const cEnd = coef(freq(Math.max(0, src.length - 1)));
    for (let i = src.length - pre; i < src.length; i++) {
      const x0 = src[i];
      const y0 = cEnd[0] * x0 + cEnd[1] * x1 + cEnd[2] * x2 - cEnd[3] * y1 - cEnd[4] * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    for (let i = 0; i < src.length; i++) {
      if (i % COEF_BLOCK === 0 && i > 0) c = coef(freq(i));
      const x0 = src[i];
      const y0 = c[0] * x0 + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      dst[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
  }
  return out;
}

/**
 * 歪みと音質下げ（波形を直接いじる。掛かり方はサンプルごとに変えられる）。
 * 歪み：tanh で丸める（大きいほど強く）。持ち上げたぶん √k で割って、音量をだいたいそろえる。
 * 音質下げ：サンプルを何個かずつ止め（細かさを下げる）、ビット数を下げる（16→4ビット）。
 */
function drive(pcm: Pcm, driveC: Curve, crushC: Curve): Pcm {
  const out: Pcm = { l: new Float32Array(pcm.l.length), r: new Float32Array(pcm.r.length) };
  for (const [src, dst] of [
    [pcm.l, out.l],
    [pcm.r, out.r],
  ] as const) {
    let held = 0;
    let count = 0;
    for (let i = 0; i < src.length; i++) {
      const d = clamp01(at(driveC, i));
      const c = clamp01(at(crushC, i));
      const hold = c < 0.01 ? 1 : 1 + Math.round(15 * c);
      if (count <= 0) {
        let x = src[i];
        if (d >= 0.01) {
          const k = 1 + 14 * d;
          x = Math.tanh(x * k) / Math.sqrt(k);
        }
        if (c >= 0.01) {
          const levels = Math.pow(2, 16 - 12 * c) / 2;
          x = Math.round(x * levels) / levels;
        }
        held = x;
        count = hold;
      }
      count--;
      dst[i] = held;
    }
  }
  return out;
}

/** 歪み・音質下げだけを、一定の量で掛ける（試験・ほかの所から使う）。 */
export function applyDrive(pcm: Pcm, d: number, c: number): Pcm {
  if (d < 0.01 && c < 0.01) return pcm;
  return drive(pcm, d, c);
}
