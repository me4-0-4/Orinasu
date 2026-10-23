import type { LaneEvent } from "../mix/sequencer.ts";
import type { Slice } from "../mix/slicer.ts";

/** 映像が反応する1つの出来事。s・len は16分（ステップ）単位。 */
export type DrumKind = "kick" | "snare" | "hat";
export interface VEvent {
  s: number;
  len: number;
  /** 0・1＝刻むトラック（トラックの番号の偶奇）、2＝ドラム、3＝パッド。色分けに使う。 */
  tr: number;
  /** 刻むトラックの番号（ドラム・パッドは -1）。 */
  lane: number;
  /** 音の高さ（MIDI）。ドラムは -1。 */
  p: number;
  vel: number;
  kind?: DrumKind;
  /** フィル（4小節目の後ろ半分か、フィルの加工が掛かった断片）。 */
  fill?: boolean;
}

/** 元のフレーズの音符（ステップ単位、1周の中の位置）。 */
export interface SrcNote {
  pitch: number;
  start: number;
  len: number;
  vel: number;
}

export interface TimelineLane {
  name: string;
  events: LaneEvent[];
  slices: Slice[];
  /** 調をそろえるための移調（半音）。 */
  keyShift: number;
  /** 元のフレーズ1周のステップ数。 */
  loopSteps: number;
  /** 元のフレーズのドラム以外の音符。 */
  notes: SrcNote[];
}

export interface TimelineInput {
  totalSteps: number;
  stepsPerBar: number;
  bpm: number;
  /** 1ステップのサンプル数（断片の位置をステップに直すのに使う）。 */
  stepSamples: number;
  lanes: TimelineLane[];
  /** ドラムループ：元のフレーズのドラムの音符（pitch は GM のドラム番号）。無ければ null。 */
  bed: { notes: SrcNote[]; loopSteps: number } | null;
  /** パッド（伸ばし）を鳴らしているか。 */
  pad: boolean;
}

export interface Timeline {
  totalSteps: number;
  stepsPerBar: number;
  bpm: number;
  seconds: number;
  /** 刻んだ断片・ドラム・パッド（ステップ順）。 */
  events: VEvent[];
  /** 鳴っている音符（刻むトラック・パッド）。 */
  tonal: VEvent[];
  /** 刻んだ断片1つにつき1つ。p はその断片でいちばん強い音。 */
  chops: VEvent[];
  kicks: VEvent[];
  hats: VEvent[];
  /** 出てくる音の高さ（低い順）。 */
  pitches: number[];
  laneNames: string[];
}

/** GM のドラム番号 → 映像での種類。 */
export function drumKind(pitch: number): DrumKind {
  if (pitch === 36 || pitch === 35) return "kick";
  if (pitch === 42 || pitch === 44 || pitch === 46) return "hat";
  return "snare";
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** 刻んだ曲から、映像の出来事の並びを作る。 */
export function buildTimeline(input: TimelineInput): Timeline {
  const { totalSteps, stepsPerBar, stepSamples } = input;
  const tonal: VEvent[] = [];
  const chops: VEvent[] = [];
  const drums: VEvent[] = [];
  input.lanes.forEach((lane, li) => {
    const tr = li % 2;
    const loop = Math.max(1, lane.loopSteps);
    let lastP = 60;
    for (const e of lane.events) {
      const slice = lane.slices[e.slice];
      const srcStart = slice ? slice.start / stepSamples : 0;
      const srcLen = slice ? (slice.end - slice.start) / stepSamples : e.len;
      const len = Math.max(0.25, Math.min(e.len, srcLen));
      const vel = e.vel ?? 1;
      const inBar = mod(e.step, stepsPerBar);
      const fill = !!e.fx || (Math.floor(e.step / stepsPerBar) % 4 === 3 && inBar >= stepsPerBar / 2);
      let best: { p: number; v: number } | null = null;
      for (const n of lane.notes) {
        // 断片の範囲（元の曲の中）と重なる音符。1周の境目をまたぐ分も見る
        for (const shift of [0, -loop, loop]) {
          const ns = mod(n.start, loop) + shift;
          const a = Math.max(ns, srcStart), b = Math.min(ns + n.len, srcStart + len);
          if (b <= a) continue;
          const p = n.pitch + lane.keyShift + e.pitch;
          tonal.push({ s: e.step + (a - srcStart), len: b - a, tr, lane: li, p, vel: n.vel * vel });
          if (!best || n.vel > best.v) best = { p, v: n.vel };
        }
      }
      if (best) lastP = best.p;
      chops.push({ s: e.step, len: e.len, tr, lane: li, p: best ? best.p : lastP, vel, fill });
    }
  });
  if (input.bed) {
    const loop = Math.max(1, input.bed.loopSteps);
    for (let base = 0; base < totalSteps; base += loop) {
      for (const n of input.bed.notes) {
        const s = base + mod(Math.round(n.start), loop);
        if (s < totalSteps) drums.push({ s, len: 1, tr: 2, lane: -1, p: -1, vel: n.vel, kind: drumKind(n.pitch) });
      }
    }
  } else {
    // ドラムループが無いとき：拍の頭を弱いキックとして扱う（サイドチェインと同じ考え方）
    for (let s = 0; s < totalSteps; s += 4) drums.push({ s, len: 1, tr: 2, lane: -1, p: -1, vel: 0.5, kind: "kick" });
  }
  if (input.pad && input.lanes[0]) {
    // パッド：小節ごとに、元の曲の同じ小節の音を、うしろで伸ばす
    const lane = input.lanes[0];
    const srcBars = Math.max(1, Math.floor(lane.loopSteps / stepsPerBar));
    for (let bar = 0; bar * stepsPerBar < totalSteps; bar++) {
      const from = mod(bar, srcBars) * stepsPerBar;
      const ps = new Set(lane.notes.filter((n) => n.start >= from && n.start < from + stepsPerBar).map((n) => n.pitch + lane.keyShift));
      for (const p of ps) tonal.push({ s: bar * stepsPerBar, len: stepsPerBar, tr: 3, lane: -1, p, vel: 0.4 });
    }
  }
  const bySteps = (a: VEvent, b: VEvent): number => a.s - b.s;
  tonal.sort(bySteps);
  chops.sort(bySteps);
  drums.sort(bySteps);
  return {
    totalSteps,
    stepsPerBar,
    bpm: input.bpm,
    seconds: (totalSteps / 4) * (60 / input.bpm),
    events: [...chops, ...drums, ...tonal.filter((e) => e.tr === 3)].sort(bySteps),
    tonal,
    chops,
    kicks: drums.filter((d) => d.kind === "kick"),
    hats: drums.filter((d) => d.kind === "hat"),
    pitches: [...new Set(tonal.map((e) => e.p))].sort((a, b) => a - b),
    laneNames: input.lanes.map((l) => l.name),
  };
}
