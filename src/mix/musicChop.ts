import type { Slice } from "./slicer.ts";
import { STEPS_PER_BEAT, accentOf, restMask, type EventFx, type FxKind, type LaneEvent, type ShapeParams } from "./sequencer.ts";
import type { TurnStyle } from "./types.ts";

type Rng = () => number;

/**
 * 音楽モードの刻み方。拍とコードを守って刻む：
 * - 拍の格子で切る（断片の頭が、元の曲の16分・8分・1拍の位置にそろう）
 * - 並べ方は「切ったまま」と「繰り返す」だけ。小節ごとに「なめらか」（隙間なし）か「キレ」（短い隙間、左右に振る）
 * - フィルは「連打」か「ちりばめ」（ごく短い断片を散らす飾り）。階段状の音程や、エフェクトを掛けることがある
 * - 出力の b 小節目には、元の曲の (b % 元の小節数) 小節目からだけ断片を取る（コードの流れが残る）
 * - 小節の頭（1拍目）は、元の1拍目のまま
 * - 1〜2小節のパターンを、4小節のまとまりでくり返し、4小節目だけフィルで崩す。8小節ごとに新しいパターン
 * - 8小節の後ろの4小節と、前半の各4小節の3つ目は、パターンを少し詰めて（隙間を繰り返しで埋めて）、8小節目は長いフィルにする（盛り上げる）
 * - 強さ：小節の頭がいちばん強く、裏ほど弱い。フィルはだんだん強く
 * - 曲（層）が複数なら、同時には鳴らさない。混ぜる（1つのリズムの打つ1回ごとに、どの曲から取るかを偶然で決める）、
 *   掛け合い（前半2拍と後半2拍を別の層が受け持つ）、4小節ごとの交代、のどれか
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
  /** 強さ。無ければ位置で決まる強さ（accentOf）。 */
  vel?: number;
  /** 混ぜるとき：どの層（曲）の断片を使うか。 */
  src?: number;
}

/**
 * 1小節のパターン。並べ方は「切ったまま（元の順）」と「繰り返す（前と同じ断片）」の2つだけ。
 * 繰り返した所は、左右に交互に振る（パン）。音程の動きがあれば、繰り返しを1オクターブ上げることがある。
 */
function barPattern(slots: number, slotSteps: number, params: ShapeParams, rhythm: Rng, order: Rng): Hit[] {
  const p = 0.2 + 0.8 * clamp01(params.busy);
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
 * フィル：小節の後ろ（startSlot から終わりまで。ふつうは後ろ半分）を、同じ断片で埋める。だんだん強くする。
 * 「連打」（断片の長さごと）か「ちりばめ」（16分ごとに、ごく短く）。左右に交互に振る。
 * 音程の動きがあれば、終わりを階段状（-4, -3, -2, -1 → 次の小節の頭で元の高さ）にするか、1オクターブ上げる。
 * エフェクトの割合に応じて、フィルター・テープストップ・音質下げ・逆再生のどれかを掛ける。
 */
function fillOf(
  base: Hit[],
  slots: number,
  slotSteps: number,
  stepsPerBar: number,
  params: ShapeParams,
  rng: Rng,
  startSlot = Math.floor(slots / 2),
  srcRng?: Rng,
  laneCount = 1,
): Hit[] {
  const start = startSlot * slotSteps;
  const span = stepsPerBar - start;
  const k = startSlot + randInt(Math.max(1, slots - startSlot), rng);
  const sprinkle = rng() < 0.5;
  const every = sprinkle ? 1 : slotSteps;
  const pitchStyle = rng() < clamp01(params.motion) ? (rng() < 0.6 ? "stairs" : "octave") : "none";
  const fxKind = rng() < clamp01(params.fx) ? FX_KINDS[randInt(FX_KINDS.length, rng)] : null;
  const src = srcRng ? randInt(laneCount, srcRng) : undefined;
  const tail: Hit[] = [];
  let side = 1;
  for (let at = start; at < stepsPerBar; at += every) {
    side = -side;
    const hit: Hit = {
      at,
      k,
      pitch: 0,
      pan: side * clamp01(params.pan),
      gate: sprinkle ? SPRINKLE_GATE : 0.9,
      vel: 0.6 + (0.4 * (at - start + every)) / span,
      src,
    };
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

/** 詰めたパターン：打っていない所を、半分くらい、前の断片の繰り返しで埋める（左右に振る）。 */
function denser(base: Hit[], slots: number, slotSteps: number, params: ShapeParams, rng: Rng): Hit[] {
  const byAt = new Map(base.map((h) => [h.at, h]));
  const out: Hit[] = [];
  let prev: Hit | undefined;
  let side = 1;
  for (let i = 0; i < slots; i++) {
    const at = i * slotSteps;
    const own = byAt.get(at);
    const fill = rng() < 0.5;
    if (own) {
      out.push(own);
      prev = own;
    } else if (prev && fill) {
      side = -side;
      out.push({ at, k: prev.k, pitch: 0, pan: side * clamp01(params.pan), src: prev.src });
    }
  }
  return out;
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
  /** 層が複数のときの組み方。無ければ交代（swap）。 */
  turns?: TurnStyle;
  /**
   * 混ぜるとき：どの層の断片を使うかを決める乱数。全部の層に同じ種を渡す（リズムの乱数も、全部の層で同じ種にする）。
   * 無ければ、混ぜずに交代する。
   */
  srcRng?: Rng;
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

  // 8小節ごとに、新しいパターン（1小節か2小節）とフィル。後ろの4小節は詰めたパターンと、長いフィル
  const bigStart = Math.max(0, Math.floor(slots / 4));
  const mix = input.turns === "mix" && input.laneCount > 1 && !!input.srcRng;
  const blocks: { motif: Hit[][]; fills: Hit[][]; dense: Hit[][]; bigFills: Hit[][] }[] = [];
  for (let blk = 0; blk * BLOCK_BARS < bars; blk++) {
    const motifLen = bars >= 8 && input.cutRng() < 0.5 ? 2 : 1;
    const motif = Array.from({ length: motifLen }, () => barPattern(slots, slotSteps, params, input.rhythmRng, input.orderRng));
    // 混ぜる：打つ1回ごとに、どの層（曲）の断片を使うかを偶然で決める（パターンと一緒にくり返す）
    if (mix) {
      const all = motif.flat();
      for (const h of all) h.src = randInt(input.laneCount, input.srcRng!);
      // 偶然で全部が同じ曲になったら、1つだけ別の曲にする（混ぜたのに1曲だけ、にならないように）
      if (all.length > 1 && all.every((h) => h.src === all[0].src)) {
        const h = all[1 + randInt(all.length - 1, input.srcRng!)];
        h.src = (all[0].src! + 1 + randInt(input.laneCount - 1, input.srcRng!)) % input.laneCount;
      }
    }
    const fills = motif.map((m) => fillOf(m, slots, slotSteps, stepsPerBar, params, input.cutRng, undefined, input.srcRng, input.laneCount));
    const dense = motif.map((m) => denser(m, slots, slotSteps, params, input.rhythmRng));
    const bigFills = dense.map((m) => fillOf(m, slots, slotSteps, stepsPerBar, params, input.cutRng, bigStart, input.srcRng, input.laneCount));
    blocks.push({ motif, fills, dense, bigFills });
  }

  const call = input.turns === "call" && input.laneCount > 1;
  const half = Math.floor(stepsPerBar / 2);
  const starts: { step: number; until: number; slice: number; pitch: number; pan: number; gate: number; vel: number; fx?: EventFx }[] = [];
  for (let b = 0; b < bars; b++) {
    // 小節の質感：キレ（短い隙間でメリハリ、左右に振る）か、なめらか（隙間なくつなぐ）
    const crisp = input.cutRng() < clamp01(params.crisp);
    const unit = Math.floor(b / UNIT_BARS);
    // 掛け合い：前半2拍は「呼ぶ層」、後半2拍は「応える層」。4小節ごとに呼ぶ層が替わる
    const caller = unit % Math.max(1, input.laneCount);
    const responder = (unit + 1) % Math.max(1, input.laneCount);
    // 交代：ふつうは4小節ごと。曲が短くて全部のトラックに番が回らないときは、交代を短くする
    const swapBars = Math.floor(bars / UNIT_BARS) < input.laneCount ? Math.max(1, Math.floor(bars / input.laneCount)) : UNIT_BARS;
    if (!mix && !call && input.laneCount > 1 && Math.floor(b / swapBars) % input.laneCount !== input.laneIndex) continue;
    if (call && caller !== input.laneIndex && responder !== input.laneIndex) continue;
    const { motif, fills, dense, bigFills } = blocks[Math.floor(b / BLOCK_BARS)];
    const m = b % motif.length;
    // 詰める小節：8小節の後ろ半分と、前半でも各4小節の3つ目（フィルの1つ前）
    const late = b % BLOCK_BARS >= UNIT_BARS || b % UNIT_BARS === UNIT_BARS - 2;
    const isFill = (b % UNIT_BARS === UNIT_BARS - 1 || b === bars - 1) && bars > 1;
    const isBig = isFill && (b % BLOCK_BARS === BLOCK_BARS - 1 || b === bars - 1) && bars >= BLOCK_BARS;
    const pattern = isBig ? bigFills[m] : isFill ? fills[m] : late ? dense[m] : motif[m];
    const sb = b % srcBars;
    const barStart = b * stepsPerBar;
    // 左右は、1小節の中で1つの数え方で交互に振る（片側に偏らないように）
    let side = 1;
    for (let j = 0; j < pattern.length; j++) {
      const h = pattern[j];
      const step = barStart + h.at;
      if (step >= totalSteps || rest[step]) continue;
      if (mix) {
        // 混ぜる：左右は全部の層で同じ数え方にして、自分の番の打つ所だけ鳴らす。次に打つ所（ほかの層でも）で切る
        const chopped = crisp && h.gate === undefined;
        let pan = 0;
        if ((h.pan !== 0 || chopped || h.gate !== undefined) && params.pan > 0) {
          side = -side;
          pan = side * clamp01(params.pan);
        }
        if (h.src !== input.laneIndex) continue;
        const next = pattern.slice(j + 1).find((x) => x.at > h.at);
        starts.push({
          step,
          until: barStart + (next ? next.at : stepsPerBar),
          slice: sb * slots + h.k,
          pitch: h.pitch,
          pan,
          gate: chopped ? CRISP_GATE : (h.gate ?? 1),
          vel: h.vel ?? accentOf(h.at, stepsPerBar),
          fx: h.fx,
        });
        continue;
      }
      if (call) {
        const owner = h.at < half ? caller : responder;
        if (owner !== input.laneIndex) continue;
      }
      const chopped = crisp && h.gate === undefined;
      const gate = chopped ? CRISP_GATE : (h.gate ?? 1);
      let pan = 0;
      if ((h.pan !== 0 || chopped || h.gate !== undefined) && params.pan > 0) {
        side = -side;
        pan = side * clamp01(params.pan);
      }
      const until = call && h.at < half ? barStart + half : barStart + stepsPerBar;
      const vel = h.vel ?? accentOf(h.at, stepsPerBar);
      starts.push({ step, until, slice: sb * slots + h.k, pitch: h.pitch, pan, gate, vel, fx: h.fx });
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
    // 小節をまたいで伸ばさない（コードが混ざらない）。掛け合いの前半は、後半に食い込ませない
    const ev: LaneEvent = {
      step: s.step,
      len: Math.max(1, Math.min(end, s.until) - s.step),
      slice: s.slice,
      pitch: s.pitch,
      gate: s.gate,
    };
    if (s.pan !== 0) ev.pan = s.pan;
    if (s.fx) ev.fx = s.fx;
    if (s.vel < 1) ev.vel = Math.round(s.vel * 100) / 100;
    return ev;
  });
}
