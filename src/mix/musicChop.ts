import type { Slice } from "./slicer.ts";
import { STEPS_PER_BEAT, restMask, type LaneEvent, type ShapeParams } from "./sequencer.ts";

type Rng = () => number;

/**
 * 音楽モードの刻み方。拍とコードを守って刻む：
 * - 拍の格子で切る（断片の頭が、元の曲の16分・8分・1拍の位置にそろう）
 * - 出力の b 小節目には、元の曲の (b % 元の小節数) 小節目からだけ断片を取る（コードの流れが残る）
 * - 小節の頭（1拍目）は、元の1拍目のまま
 * - 1〜2小節のパターンを、4小節のまとまりでくり返し、4小節目だけフィルで崩す。8小節ごとに新しいパターン
 * - 曲（層）が複数なら、同時には鳴らさず、4小節ごとに交代で鳴らす
 */

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const randInt = (n: number, rng: Rng): number => Math.min(n - 1, Math.floor(rng() * n));

const UNIT_BARS = 4;
const BLOCK_BARS = 8;

/** 断片の長さ（0〜1）から、1つの断片が何ステップか（16分＝1、8分＝2、1拍＝4）。 */
export function musicSlotSteps(size: number): 1 | 2 | 4 {
  const s = clamp01(size);
  return s < 0.34 ? 1 : s < 0.67 ? 2 : 4;
}

/**
 * 元の曲を、拍の格子で切る。番号は「元の小節 × 小節の中の位置」。
 * 断片は、その位置から小節の終わりまで（音の長さで、どこまで鳴らすかが決まる）。
 */
export function musicSlices(opts: {
  srcBars: number;
  stepsPerBar: number;
  slotSteps: number;
  stepSamples: number;
  length: number;
}): Slice[] {
  const slots = Math.max(1, Math.floor(opts.stepsPerBar / opts.slotSteps));
  const out: Slice[] = [];
  for (let sb = 0; sb < opts.srcBars; sb++) {
    const barEnd = Math.min(opts.length, Math.round((sb + 1) * opts.stepsPerBar * opts.stepSamples));
    for (let k = 0; k < slots; k++) {
      const start = Math.min(opts.length, Math.round((sb * opts.stepsPerBar + k * opts.slotSteps) * opts.stepSamples));
      out.push({ start, end: Math.max(start, barEnd) });
    }
  }
  return out;
}

/** 1小節ぶんのパターン：何番目の枠で、小節の中のどの断片を、何半音で打つか。 */
interface Hit {
  slot: number;
  k: number;
  pitch: number;
}

function barPattern(slots: number, slotSteps: number, params: ShapeParams, rhythm: Rng, order: Rng): Hit[] {
  const p = 0.2 + 0.75 * clamp01(params.busy);
  const o = clamp01(params.onBeat);
  const hits: Hit[] = [];
  let prevK = -1;
  for (let i = 0; i < slots; i++) {
    const r = rhythm();
    const a = order();
    const b = order();
    const c = order();
    const onBeat = (i * slotSteps) % STEPS_PER_BEAT === 0;
    const prob = i === 0 ? 1 : onBeat ? p + (1 - p) * o : p * (1 - 0.6 * o);
    if (r >= prob) continue;
    // 頭は元の1拍目。ほかは「元の位置のまま」「前と同じ断片（連打）」「小節の中のどれか」
    const k = i === 0 ? 0 : a < 0.45 ? i : a < 0.75 && prevK >= 0 ? prevK : randInt(slots, () => b);
    // 音程の動き：連打のときだけ、ときどき1オクターブ上げる（コードは崩さない）
    const pitch = k === prevK && c < clamp01(params.motion) ? 12 : 0;
    hits.push({ slot: i, k, pitch });
    prevK = k;
  }
  return hits;
}

/** フィル：小節の後ろ半分を、同じ断片の連打にする（音程の動きがあれば、最後で1オクターブ上がる）。 */
function fillOf(base: Hit[], slots: number, params: ShapeParams, rng: Rng): Hit[] {
  const half = Math.floor(slots / 2);
  const k = half + randInt(Math.max(1, slots - half), rng);
  const rising = rng() < clamp01(params.motion);
  const tail: Hit[] = [];
  for (let i = half; i < slots; i++) tail.push({ slot: i, k, pitch: rising && i >= slots - 2 ? 12 : 0 });
  return [...base.filter((h) => h.slot < half), ...tail];
}

export interface MusicLaneInput {
  totalSteps: number;
  stepsPerBar: number;
  /** 元の曲の小節数。 */
  srcBars: number;
  slotSteps: number;
  /** 何番目の層か、層が全部で何本か（交代で鳴らすため）。 */
  laneIndex: number;
  laneCount: number;
  params: ShapeParams;
  cutRng: Rng;
  rhythmRng: Rng;
  orderRng: Rng;
}

/** 音楽モードで、1つの層の打つ予定を作る。slice の番号は musicSlices と同じ並び。 */
export function planMusicLane(input: MusicLaneInput): LaneEvent[] {
  const { totalSteps, stepsPerBar, slotSteps, params } = input;
  const slots = Math.max(1, Math.floor(stepsPerBar / slotSteps));
  const bars = Math.max(1, Math.round(totalSteps / stepsPerBar));
  const srcBars = Math.max(1, input.srcBars);
  const rest = restMask(totalSteps, stepsPerBar, params.breaks, input.rhythmRng);

  // 8小節ごとに、新しいパターン（1小節か2小節）とフィル
  const blocks: { motif: Hit[][]; fills: Hit[][] }[] = [];
  for (let blk = 0; blk * BLOCK_BARS < bars; blk++) {
    const motifLen = bars >= 8 && input.cutRng() < 0.5 ? 2 : 1;
    const motif = Array.from({ length: motifLen }, () => barPattern(slots, slotSteps, params, input.rhythmRng, input.orderRng));
    const fills = motif.map((m) => fillOf(m, slots, params, input.cutRng));
    blocks.push({ motif, fills });
  }

  const starts: { step: number; slice: number; pitch: number }[] = [];
  for (let b = 0; b < bars; b++) {
    const unit = Math.floor(b / UNIT_BARS);
    if (input.laneCount > 1 && unit % input.laneCount !== input.laneIndex) continue;
    const { motif, fills } = blocks[Math.floor(b / BLOCK_BARS)];
    const m = b % motif.length;
    const isFill = b % UNIT_BARS === UNIT_BARS - 1 || b === bars - 1;
    const pattern = isFill && bars > 1 ? fills[m] : motif[m];
    const sb = b % srcBars;
    for (const h of pattern) {
      const step = b * stepsPerBar + h.slot * slotSteps;
      if (step >= totalSteps || rest[step]) continue;
      starts.push({ step, slice: sb * slots + h.k, pitch: h.pitch });
    }
  }

  return starts.map((s, i) => {
    let end = starts[i + 1]?.step ?? totalSteps;
    for (let t = s.step + 1; t < end; t++) {
      if (rest[t]) {
        end = t;
        break;
      }
    }
    const barEnd = (Math.floor(s.step / stepsPerBar) + 1) * stepsPerBar; // 小節をまたいで伸ばさない（コードが混ざらない）
    return { step: s.step, len: Math.max(1, Math.min(end, barEnd) - s.step), slice: s.slice, pitch: s.pitch };
  });
}
