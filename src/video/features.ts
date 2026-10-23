import { loudAt, specAt, type Analysis } from "./analysis.ts";
import type { Timeline, VEvent } from "./timeline.ts";

/** ある瞬間に、パネルが読む値をまとめたもの。 */
export interface Feat {
  /** 位置（ステップ、小数あり）。 */
  S: number;
  bar: number;
  beat: number;
  step: number;
  /** 刻んだ断片が鳴った直後ほど1。 */
  hit: number;
  kick: number;
  hat: number;
  loud: number;
  low: number;
  high: number;
  width: number;
  spec: number[];
  /** 少し前から今までの音量（96個、古い順）。 */
  hist: number[];
  /** 今鳴っている音符。 */
  active: VEvent[];
  /** 最後に鳴った断片。 */
  lastChop: VEvent;
  isFill: boolean;
  /** フィルの進み具合（0〜1）。フィルでなければ0。 */
  fillAmt: number;
}

/** list の中で、S より前に鳴った出来事の、減っていく強さのいちばん大きいもの。 */
export function decayOf(list: VEvent[], S: number, tau: number, total: number): number {
  let m = 0;
  for (const e of list) {
    let d = S - e.s;
    if (d < 0) d += total;
    if (d < tau * 5) m = Math.max(m, e.vel * Math.exp(-d / tau));
  }
  return m;
}

const FALLBACK: VEvent = { s: 0, len: 1, tr: 0, lane: 0, p: 60, vel: 0.5 };

export function featAt(tl: Timeline, an: Analysis, S: number): Feat {
  const total = tl.totalSteps, spb = tl.stepsPerBar;
  S = ((S % total) + total) % total;
  const bar = Math.floor(S / spb), inBar = S - bar * spb;
  let lastChop = tl.chops[tl.chops.length - 1] ?? FALLBACK;
  for (const e of tl.chops) {
    if (e.s <= S) lastChop = e;
    else break;
  }
  const spec = specAt(an, S);
  const hist: number[] = [];
  for (let j = 95; j >= 0; j--) hist.push(loudAt(an, S - j * 0.5));
  const isFill = bar % 4 === 3 && inBar >= spb / 2;
  return {
    S,
    bar,
    beat: Math.floor(inBar / 4),
    step: Math.floor(inBar),
    hit: decayOf(tl.chops, S, 1.2, total),
    kick: decayOf(tl.kicks, S, 1.2, total),
    hat: decayOf(tl.hats, S, 0.8, total),
    loud: loudAt(an, S),
    low: (spec[0] + spec[1] + spec[2] + spec[3]) / 4,
    high: (spec[34] + spec[36] + spec[38]) / 3,
    width: an.width[Math.floor(S * 4) % an.frames] ?? 0,
    spec,
    hist,
    active: tl.tonal.filter((e) => e.s <= S && S < e.s + e.len),
    lastChop,
    isFill,
    fillAmt: isFill ? (inBar - spb / 2) / (spb / 2) : 0,
  };
}
