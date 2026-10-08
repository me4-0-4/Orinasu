import { stepPosition } from "./collage.ts";
import type { Pcm } from "./pcm.ts";
import type { LaneEvent } from "./sequencer.ts";

/**
 * 自分で決めるエフェクト。掛ける所（全体・層ごと・下地・伸ばし）ごとに、エフェクトを好きな順番で好きなだけ並べる（上から順に掛かる）。
 * 1つ1つのエフェクトは「いつ掛けるか」を持つ：曲のぜんぶ／小節を選ぶ／フィルの小節だけ／選んだ断片だけ。
 */
export type FxKind = "reverb" | "delay" | "lowCut" | "highCut" | "drive" | "crush";
export const FX_KINDS: FxKind[] = ["reverb", "delay", "lowCut", "highCut", "drive", "crush"];
export const FX_LABELS: Record<FxKind, string> = {
  reverb: "リバーブ",
  delay: "ディレイ",
  lowCut: "低音を削る",
  highCut: "高音を削る",
  drive: "歪み",
  crush: "音質下げ",
};

/** いつ掛けるか。all：曲のぜんぶ。bars：from〜to 小節目（1から数える、両端を含む）。fills：フィルの小節だけ。hits：選んだ断片だけ（層のときだけ）。 */
export type FxWhen = "all" | "bars" | "fills" | "hits";

/** ディレイの間隔（音符の長さ）。1/8d は付点8分。 */
export type DelayTime = "1/16" | "1/8" | "1/8d" | "1/4";
export const DELAY_TIMES: DelayTime[] = ["1/16", "1/8", "1/8d", "1/4"];
const DELAY_BEATS: Record<DelayTime, number> = { "1/16": 0.25, "1/8": 0.5, "1/8d": 0.75, "1/4": 1 };

export interface FxSlot {
  kind: FxKind;
  /** 強さ（0〜1）。リバーブ・ディレイは量、削るものは削る周波数、歪み・音質下げは掛かり方。 */
  amount: number;
  /** リバーブの長さ（0〜1。0で0.3秒、1で6秒）。 */
  size: number;
  /** リバーブの明るさ（0〜1）。 */
  tone: number;
  /** ディレイの間隔。 */
  time: DelayTime;
  /** ディレイのくり返し（0〜1）。 */
  feedback: number;
  when: FxWhen;
  /** when が bars のとき：何小節目から何小節目まで（1から）。 */
  from: number;
  to: number;
  /** when が hits のとき：選んだ断片の、打つ位置（ステップ）。 */
  steps: number[];
}

/** 曲が持つエフェクト：全体・下地・伸ばし（層ごとのものは層が持つ）。 */
export interface SongFx {
  master: FxSlot[];
  bed: FxSlot[];
  pad: FxSlot[];
}

export function newSlot(kind: FxKind, over: Partial<FxSlot> = {}): FxSlot {
  const amount = kind === "reverb" ? 0.3 : kind === "delay" ? 0.4 : 0.5;
  return { kind, amount, size: 0.35, tone: 0.5, time: "1/8d", feedback: 0.35, when: "all", from: 1, to: 4, steps: [], ...over };
}

export function defaultSongFx(): SongFx {
  return { master: [newSlot("reverb", { amount: 0.15 })], bed: [], pad: [] };
}

const OFF = 0.01;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 何も掛からない並びか。 */
export function chainIsOff(slots: FxSlot[] | undefined): boolean {
  return !slots || slots.every((s) => s.amount < OFF || (s.when === "hits" && s.steps.length === 0));
}

/** 保存されていた1つのエフェクトを読む（おかしければ null）。 */
export function sanitizeSlot(raw: unknown): FxSlot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!FX_KINDS.includes(r.kind as FxKind)) return null;
  const slot = newSlot(r.kind as FxKind);
  for (const key of ["amount", "size", "tone", "feedback"] as const) if (isNum(r[key])) slot[key] = clamp01(r[key]);
  if (DELAY_TIMES.includes(r.time as DelayTime)) slot.time = r.time as DelayTime;
  if (r.when === "all" || r.when === "bars" || r.when === "fills" || r.when === "hits") slot.when = r.when;
  if (isNum(r.from)) slot.from = Math.max(1, Math.round(r.from));
  if (isNum(r.to)) slot.to = Math.max(slot.from, Math.round(r.to));
  if (Array.isArray(r.steps)) slot.steps = [...new Set(r.steps.filter(isNum).map((s) => Math.max(0, Math.round(s))))].sort((a, b) => a - b);
  return slot;
}

/**
 * 保存されていたエフェクトの並びを読む。
 * 少し前の形（1組の設定 {reverb, delay, lowCut…}）からは、0でないものを順に並べ直す。
 */
export function sanitizeChain(raw: unknown): FxSlot[] {
  if (Array.isArray(raw)) return raw.map(sanitizeSlot).filter((s): s is FxSlot => s !== null);
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const num = (k: string, d: number): number => (isNum(r[k]) ? clamp01(r[k] as number) : d);
  const out: FxSlot[] = [];
  const time = DELAY_TIMES.includes(r.delayTime as DelayTime) ? (r.delayTime as DelayTime) : "1/8d";
  if (num("drive", 0) >= OFF) out.push(newSlot("drive", { amount: num("drive", 0) }));
  if (num("crush", 0) >= OFF) out.push(newSlot("crush", { amount: num("crush", 0) }));
  if (num("lowCut", 0) >= OFF) out.push(newSlot("lowCut", { amount: num("lowCut", 0) }));
  if (num("highCut", 0) >= OFF) out.push(newSlot("highCut", { amount: num("highCut", 0) }));
  if (num("delay", 0) >= OFF) out.push(newSlot("delay", { amount: num("delay", 0), time, feedback: num("delayFeedback", 0.35) }));
  if (num("reverb", 0) >= OFF) out.push(newSlot("reverb", { amount: num("reverb", 0), size: num("reverbSize", 0.35), tone: num("reverbTone", 0.5) }));
  return out;
}

/** リバーブの長さ（秒）。 */
export const reverbSeconds = (size: number): number => 0.3 * Math.pow(20, clamp01(size));
/** リバーブの明るさ（響きの高い所を、何Hzから削るか）。 */
export const reverbToneHz = (tone: number): number => 1500 * Math.pow(8, clamp01(tone));
/** ディレイの間隔（秒）。 */
export const delaySeconds = (time: DelayTime, bpm: number): number => (DELAY_BEATS[time] * 60) / bpm;
/** ディレイのくり返しの強さ（1回ごとの残り）。 */
export const delayFeedbackGain = (feedback: number): number => 0.85 * clamp01(feedback);
/** 低音を削る周波数（Hz）。 */
export const lowCutHz = (v: number): number => 20 * Math.pow(100, clamp01(v));
/** 高音を削る周波数（Hz）。 */
export const highCutHz = (v: number): number => 20000 * Math.pow(300 / 20000, clamp01(v));

/** フィルの小節（0から数える）：4小節ごとの4小節目と、最後の小節。 */
export function fillBars(bars: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < bars; b++) if ((b % 4 === 3 || b === bars - 1) && bars > 1) out.push(b);
  return out;
}

export interface ChainEnv {
  totalSteps: number;
  stepsPerBar: number;
  stepSamples: number;
  sampleRate: number;
  swing?: number;
  bpm: number;
  /** 層のとき：その層の打つ予定（選んだ断片だけに掛けるため）。 */
  events?: LaneEvent[];
  /** リバーブの響きだけ（元の音を含まない）を作る。余韻は頭に重ねて、同じ長さで返す。 */
  reverb: (pcm: Pcm, seconds: number, toneHz: number) => Promise<Pcm>;
}

/** 掛け始め・掛け終わりのなめらかさ（秒）。 */
const RAMP_SECONDS = 0.005;

/**
 * いつ掛けるか を、サンプルごとの重み（0〜1）にする。曲のぜんぶなら null。
 * 端は5msでなめらかにつなぐ（プチ音を出さない）。
 */
export function whenMask(slot: FxSlot, n: number, env: ChainEnv): Float32Array | null {
  if (slot.when === "all") return null;
  const ranges: [number, number][] = [];
  const bars = Math.max(1, Math.round(env.totalSteps / env.stepsPerBar));
  const pos = (step: number): number => stepPosition(step, env.stepSamples, env.swing);
  if (slot.when === "bars") {
    const from = Math.max(1, slot.from) - 1;
    const to = Math.min(bars, Math.max(slot.from, slot.to));
    if (from < to) ranges.push([pos(from * env.stepsPerBar), pos(to * env.stepsPerBar)]);
  } else if (slot.when === "fills") {
    for (const b of fillBars(bars)) ranges.push([pos(b * env.stepsPerBar), pos((b + 1) * env.stepsPerBar)]);
  } else {
    const chosen = new Set(slot.steps);
    for (const ev of env.events ?? []) if (chosen.has(ev.step)) ranges.push([pos(ev.step), pos(ev.step + ev.len)]);
  }
  const mask = new Float32Array(n);
  const ramp = Math.max(1, Math.round(RAMP_SECONDS * env.sampleRate));
  for (const [a, b] of ranges) {
    for (let i = Math.max(0, a - ramp); i < Math.min(n, b + ramp); i++) {
      const w = i < a ? (i - (a - ramp)) / ramp : i >= b ? (b + ramp - i) / ramp : 1;
      mask[i] = Math.max(mask[i], Math.min(1, Math.max(0, w)));
    }
  }
  return mask;
}

/**
 * エフェクトの並びを、上から順に掛ける。
 * リバーブ・ディレイは「送り」：いつ掛けるか の所の音だけを響かせ、響き（余韻）はその後も自然に残る。
 * 削る・歪み・音質下げは「差し込み」：いつ掛けるか の所だけ、掛けた音に入れ替える。
 */
export async function applyChain(pcm: Pcm, slots: FxSlot[], env: ChainEnv): Promise<Pcm> {
  let x: Pcm = { l: pcm.l.slice(), r: pcm.r.slice() };
  const n = x.l.length;
  for (const slot of slots) {
    if (slot.amount < OFF) continue;
    const mask = whenMask(slot, n, env);
    if (mask && mask.every((v) => v === 0)) continue;
    if (slot.kind === "reverb" || slot.kind === "delay") {
      const send = mask ? multiply(x, mask) : x;
      const wet =
        slot.kind === "reverb"
          ? await env.reverb(send, reverbSeconds(slot.size), reverbToneHz(slot.tone))
          : delayWet(send, delaySeconds(slot.time, env.bpm) * env.sampleRate, delayFeedbackGain(slot.feedback));
      const g = slot.kind === "reverb" ? 0.5 * slot.amount : 0.6 * slot.amount;
      for (let i = 0; i < n; i++) {
        x.l[i] += wet.l[i] * g;
        x.r[i] += wet.r[i] * g;
      }
    } else {
      const y = insertFx(x, slot, env.sampleRate);
      if (!mask) {
        x = y;
      } else {
        for (let i = 0; i < n; i++) {
          x.l[i] += (y.l[i] - x.l[i]) * mask[i];
          x.r[i] += (y.r[i] - x.r[i]) * mask[i];
        }
      }
    }
  }
  return x;
}

function multiply(pcm: Pcm, mask: Float32Array): Pcm {
  const out: Pcm = { l: new Float32Array(pcm.l.length), r: new Float32Array(pcm.r.length) };
  for (let i = 0; i < pcm.l.length; i++) {
    out.l[i] = pcm.l[i] * mask[i];
    out.r[i] = pcm.r[i] * mask[i];
  }
  return out;
}

/**
 * ディレイのやまびこだけ（元の音を含まない）。曲の終わりを越えたやまびこは頭に回す（くり返してもつながる）。
 * やまびこは、くり返すたびに少しこもらせる。
 */
export function delayWet(pcm: Pcm, delaySamples: number, feedback: number): Pcm {
  const n = pcm.l.length;
  const d = Math.max(1, Math.round(delaySamples));
  const out: Pcm = { l: new Float32Array(n), r: new Float32Array(n) };
  // くり返しが 1/1000 まで小さくなるまで（最大で曲の4周ぶん）
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

/** 差し込みのエフェクト（削る・歪み・音質下げ）を、全体に掛けた音。 */
function insertFx(pcm: Pcm, slot: FxSlot, sampleRate: number): Pcm {
  if (slot.kind === "lowCut") return biquad(pcm, "highpass", lowCutHz(slot.amount), sampleRate);
  if (slot.kind === "highCut") return biquad(pcm, "lowpass", highCutHz(slot.amount), sampleRate);
  if (slot.kind === "drive") return applyDrive(pcm, slot.amount, 0);
  return applyDrive(pcm, 0, slot.amount);
}

/** 2次のフィルター（12dB/oct）。 */
export function biquad(pcm: Pcm, type: "lowpass" | "highpass", freq: number, sampleRate: number): Pcm {
  const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const b1 = type === "lowpass" ? 1 - cos : -(1 + cos);
  const b0 = type === "lowpass" ? (1 - cos) / 2 : (1 + cos) / 2;
  const a0 = 1 + alpha;
  const c = [b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  const out: Pcm = { l: new Float32Array(pcm.l.length), r: new Float32Array(pcm.r.length) };
  for (const [src, dst] of [
    [pcm.l, out.l],
    [pcm.r, out.r],
  ] as const) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < src.length; i++) {
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
 * 歪みと音質下げ（波形を直接いじる）。
 * 歪み：tanh で丸める（大きいほど強く）。持ち上げたぶん √k で割って、音量をだいたいそろえる。
 * 音質下げ：サンプルを何個かずつ止め（細かさを下げる）、ビット数を下げる（16→4ビット）。
 */
export function applyDrive(pcm: Pcm, drive: number, crush: number): Pcm {
  const d = clamp01(drive);
  const c = clamp01(crush);
  if (d < OFF && c < OFF) return pcm;
  const out: Pcm = { l: new Float32Array(pcm.l.length), r: new Float32Array(pcm.r.length) };
  const k = 1 + 14 * d;
  const norm = Math.sqrt(k);
  const hold = c < OFF ? 1 : 1 + Math.round(15 * c);
  const levels = c < OFF ? 0 : Math.pow(2, 16 - 12 * c) / 2;
  for (const [src, dst] of [
    [pcm.l, out.l],
    [pcm.r, out.r],
  ] as const) {
    let held = 0;
    for (let i = 0; i < src.length; i++) {
      if (i % hold === 0) {
        let x = src[i];
        if (d >= OFF) x = Math.tanh(x * k) / norm;
        if (levels > 0) x = Math.round(x * levels) / levels;
        held = x;
      }
      dst[i] = held;
    }
  }
  return out;
}
