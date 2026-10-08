import type { Slice } from "./slicer.ts";
import { STEPS_PER_BEAT, restMask, type EventFx, type FxKind, type LaneEvent, type ShapeParams } from "./sequencer.ts";

type Rng = () => number;

/**
 * 音楽モードの刻み方。拍とコードを守って刻む：
 * - 拍の格子で切る（断片の頭が、元の曲の16分・8分・1拍の位置にそろう）
 * - 並べ方は「切ったまま」と「繰り返す」だけ。小節ごとに「なめらか」（隙間なし）か「キレ」（短い隙間、左右に振る）
 * - フィルは「連打」か「ちりばめ」（ごく短い断片を散らす飾り）。階段状の音程や、エフェクトを掛けることがある
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

/** キレの小節で鳴らす割合（短い隙間でメリハリ）。なめらかの小節は1（隙間なし）。 */
const CRISP_GATE = 0.65;
/** ちりばめ（ごく短い断片を散らす飾り）で鳴らす割合。 */
const SPRINKLE_GATE = 0.3;
const FX_KINDS: FxKind[] = ["lowpass", "highpass", "tapestop", "crush", "reverse"];

/** 1小節ぶんのパターンの1打：小節の頭から何ステップ目に、小節の中のどの断片を、どう打つか。 */
interface Hit {
  at: number;
  k: number;
  pitch: number;
  pan: number;
  gate?: number;
  fx?: EventFx;
}

/**
 * 1小節のパターン。並べ方は「切ったまま（元の順）」と「繰り返す（前と同じ断片）」の2つだけ。
 * 繰り返した所は、左右に交互に振る（パン）。音程の動きがあれば、繰り返しを1オクターブ上げることがある。
 */
function barPattern(slots: number, slotSteps: number, params: ShapeParams, rhythm: Rng, order: Rng): Hit[] {
  const p = 0.2 + 0.75 * clamp01(params.busy);
  const o = clamp01(params.onBeat);
  const hits: Hit[] = [];
  let prevK = -1;
  let side = 1;
  for (let i = 0; i < slots; i++) {
    const r = rhythm();
    const a = order();
    const c = order();
    const onBeat = (i * slotSteps) % STEPS_PER_BEAT === 0;
    const prob = i === 0 ? 1 : onBeat ? p + (1 - p) * o : p * (1 - 0.6 * o);
    if (r >= prob) continue;
    const repeat = i > 0 && prevK >= 0 && a < 0.3;
    const k = i === 0 ? 0 : repeat ? prevK : i;
    let pan = 0;
    if (repeat) {
      side = -side;
      pan = side * clamp01(params.pan);
    }
    hits.push({ at: i * slotSteps, k, pitch: repeat && c < clamp01(params.motion) ? 12 : 0, pan });
    prevK = k;
  }
  return hits;
}

/**
 * フィル：小節の後ろ半分を、同じ断片で埋める。
 * 「連打」（断片の長さごと）か「ちりばめ」（16分ごとに、ごく短く）。左右に交互に振る。
 * 音程の動きがあれば、終わりを階段状（-4, -3, -2, -1 → 次の小節の頭で元の高さ）にするか、1オクターブ上げる。
 * エフェクトの割合に応じて、フィルター・テープストップ・音質下げ・逆再生のどれかを掛ける。
 */
function fillOf(base: Hit[], slots: number, slotSteps: number, stepsPerBar: number, params: ShapeParams, rng: Rng): Hit[] {
  const halfSlot = Math.floor(slots / 2);
  const start = halfSlot * slotSteps;
  const span = stepsPerBar - start;
  const k = halfSlot + randInt(Math.max(1, slots - halfSlot), rng);
  const sprinkle = rng() < 0.5;
  const every = sprinkle ? 1 : slotSteps;
  const pitchStyle = rng() < clamp01(params.motion) ? (rng() < 0.6 ? "stairs" : "octave") : "none";
  const fxKind = rng() < clamp01(params.fx) ? FX_KINDS[randInt(FX_KINDS.length, rng)] : null;
  const tail: Hit[] = [];
  let side = 1;
  for (let at = start; at < stepsPerBar; at += every) {
    side = -side;
    const hit: Hit = { at, k, pitch: 0, pan: side * clamp01(params.pan), gate: sprinkle ? SPRINKLE_GATE : 0.9 };
    if (fxKind) hit.fx = { kind: fxKind, a: (at - start) / span, b: Math.min(1, (at - start + every) / span) };
    tail.push(hit);
  }
  if (pitchStyle === "stairs") {
    const n = Math.min(4, tail.length);
    for (let j = 0; j < n; j++) tail[tail.length - n + j].pitch = -(n - j);
  } else if (pitchStyle === "octave") {
    for (const h of tail.slice(-2)) h.pitch = 12;
  }
  return [...base.filter((h) => h.at < start), ...tail];
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
    const fills = motif.map((m) => fillOf(m, slots, slotSteps, stepsPerBar, params, input.cutRng));
    blocks.push({ motif, fills });
  }

  const starts: { step: number; slice: number; pitch: number; pan: number; gate: number; fx?: EventFx }[] = [];
  for (let b = 0; b < bars; b++) {
    // 小節の質感：キレ（短い隙間でメリハリ、左右に振る）か、なめらか（隙間なくつなぐ）
    const crisp = input.cutRng() < clamp01(params.crisp);
    const unit = Math.floor(b / UNIT_BARS);
    if (input.laneCount > 1 && unit % input.laneCount !== input.laneIndex) continue;
    const { motif, fills } = blocks[Math.floor(b / BLOCK_BARS)];
    const m = b % motif.length;
    const isFill = (b % UNIT_BARS === UNIT_BARS - 1 || b === bars - 1) && bars > 1;
    const pattern = isFill ? fills[m] : motif[m];
    const sb = b % srcBars;
    // 左右は、1小節の中で1つの数え方で交互に振る（片側に偏らないように）
    let side = 1;
    for (const h of pattern) {
      const step = b * stepsPerBar + h.at;
      if (step >= totalSteps || rest[step]) continue;
      const chopped = crisp && h.gate === undefined;
      const gate = chopped ? CRISP_GATE : (h.gate ?? 1);
      let pan = 0;
      if ((h.pan !== 0 || chopped || h.gate !== undefined) && params.pan > 0) {
        side = -side;
        pan = side * clamp01(params.pan);
      }
      starts.push({ step, slice: sb * slots + h.k, pitch: h.pitch, pan, gate, fx: h.fx });
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
    const ev: LaneEvent = {
      step: s.step,
      len: Math.max(1, Math.min(end, barEnd) - s.step),
      slice: s.slice,
      pitch: s.pitch,
      gate: s.gate,
    };
    if (s.pan !== 0) ev.pan = s.pan;
    if (s.fx) ev.fx = s.fx;
    return ev;
  });
}
