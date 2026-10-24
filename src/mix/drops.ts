import { createRng } from "../theory/rng.ts";
import { STEPS_PER_BEAT } from "./sequencer.ts";
import type { Pcm } from "./pcm.ts";

/**
 * 置く音：読み込んだ音を、刻まずにまるごと、曲の上に置く。置く場所は偶然で決める（振り直し・固定できる）。
 * 曲の区切り（8小節・4小節の頭）ほど置かれやすく、置いた音が鳴っている間は次を置かない。
 */
export interface DropSettings {
  /** 置く音（読み込んだ音の id）。 */
  soundIds: string[];
  /** 置く多さ（0〜1）。 */
  amount: number;
  /** 置き場所の種。振り直すと変わる。 */
  seed: number;
  /** 固定：曲をまるごと振り直しても、置き場所を変えない。 */
  locked?: boolean;
  muted?: boolean;
  /** 音量（0〜1.5。無ければ1）。 */
  volume?: number;
}

/** 置いた音1つ。 */
export interface Drop {
  step: number;
  soundId: string;
  /** 鳴っている長さ（16分の数。曲の長さで切る）。 */
  len: number;
}

export const MAX_DROP_VOLUME = 1.5;

export function defaultDrops(seed: number): DropSettings {
  return { soundIds: [], amount: 0.5, seed };
}

/** 保存されていた設定の足りない所を補う。壊れていたら undefined。 */
export function migrateDrops(raw: unknown): DropSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<DropSettings>;
  if (!Array.isArray(r.soundIds) || typeof r.seed !== "number") return undefined;
  const amount = typeof r.amount === "number" && Number.isFinite(r.amount) ? Math.min(1, Math.max(0, r.amount)) : 0.5;
  const out: DropSettings = { soundIds: r.soundIds.filter((id): id is string => typeof id === "string"), amount, seed: r.seed };
  if (r.locked) out.locked = true;
  if (r.muted) out.muted = true;
  if (typeof r.volume === "number" && Number.isFinite(r.volume)) out.volume = Math.min(MAX_DROP_VOLUME, Math.max(0, r.volume));
  return out;
}

/** 小節の頭の置かれやすさ：8小節の頭 > 4小節の頭 > 2小節の頭 > そのほか。 */
function barWeight(bar: number): number {
  if (bar % 8 === 0) return 1;
  if (bar % 4 === 0) return 0.6;
  if (bar % 2 === 0) return 0.25;
  return 0.1;
}

/**
 * 置き場所を決める。sounds は置ける音と、その長さ（16分の数）。同じ種と設定なら、いつも同じ結果。
 * 候補：小節の頭と、4小節の区切りの直前の拍（くり出し）。
 */
export function planDrops(opts: {
  totalSteps: number;
  stepsPerBar: number;
  seed: number;
  amount: number;
  sounds: { id: string; steps: number }[];
}): Drop[] {
  const { totalSteps, stepsPerBar, sounds } = opts;
  if (sounds.length === 0 || opts.amount <= 0 || totalSteps <= 0) return [];
  const rng = createRng(opts.seed);
  const bars = Math.floor(totalSteps / stepsPerBar);
  const candidates: { step: number; weight: number }[] = [];
  for (let b = 0; b < bars; b++) {
    candidates.push({ step: b * stepsPerBar, weight: barWeight(b) });
    // 4小節の区切りの直前（最後の拍）：次の区切りへのくり出し
    if (b % 4 === 3) candidates.push({ step: (b + 1) * stepsPerBar - STEPS_PER_BEAT, weight: 0.3 });
  }
  candidates.sort((a, b) => a.step - b.step);
  const out: Drop[] = [];
  let busyUntil = 0;
  let last = -1;
  for (const c of candidates) {
    // 引く数をそろえる（多さを変えても、置かれる場所の傾向が大きく崩れない）
    const r = rng();
    const pick = rng();
    if (c.step < busyUntil) continue;
    if (r >= Math.min(1, c.weight * opts.amount * 1.6)) continue;
    let i = Math.floor(pick * sounds.length);
    // 同じ音が続かないように（2つ以上あるとき）
    if (sounds.length > 1 && i === last) i = (i + 1) % sounds.length;
    const s = sounds[i];
    const len = Math.max(1, Math.min(s.steps, totalSteps - c.step));
    out.push({ step: c.step, soundId: s.id, len });
    busyUntil = c.step + Math.max(1, s.steps);
    last = i;
  }
  return out;
}

/** 置いた音を、曲の長さの波形に並べる。音は曲のサンプリングレートにそろえたもの。曲の終わりで切る。 */
export function renderDrops(drops: Drop[], sounds: Map<string, Pcm>, totalSamples: number, stepSamples: number): Pcm {
  const out: Pcm = { l: new Float32Array(totalSamples), r: new Float32Array(totalSamples) };
  for (const d of drops) {
    const pcm = sounds.get(d.soundId);
    if (!pcm) continue;
    const at = Math.round(d.step * stepSamples);
    const n = Math.min(pcm.l.length, totalSamples - at);
    for (let i = 0; i < n; i++) {
      out.l[at + i] += pcm.l[i];
      out.r[at + i] += pcm.r[i];
    }
  }
  return out;
}
