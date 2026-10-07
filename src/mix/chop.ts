import { makeId, type LayerRole, type Note } from "../phrase/types.ts";

type Rng = () => number;

/** 刻み方の種類（DJが原曲をいじる動き）。 */
export type ChopKind = "play" | "jump" | "stutter" | "reverse" | "fill" | "break";

/**
 * 刻み方の計画の1区間。セクション全体を隙間なく覆う。
 * 計画は全部の層に同じものを当てる（DJはミックス全体を同時に切るので、層同士がずれない）。
 */
export interface ChopSegment {
  kind: ChopKind;
  /** 区間の頭（セクションの頭からの拍）。 */
  dst: number;
  len: number;
  /** 材料のどこから取るか（拍）。材料より長いときは、材料の頭に戻って続く。 */
  src: number;
  reverse?: boolean;
  /** 鳴らす役割。無ければ全部。空なら無音。 */
  mask?: LayerRole[];
}

/** 刻みのスライダー（どれも0〜1）。 */
export interface ChopParams {
  /** 刻み：いじりが入る小節の割合。0ならそのまま通す。 */
  busy: number;
  /** 抜き：いじりのうち、ドラムだけ・ドラム抜き・無音にする割合。 */
  breaks: number;
  /** 細かさ：リピートやジャンプの断片の短さ（0＝2拍、1＝1/4拍まで）。 */
  size: number;
}

export const DEFAULT_CHOP: ChopParams = { busy: 0.5, breaks: 0.25, size: 0.5 };

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const EPS = 1e-6;

function randInt(n: number, rng: Rng): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

function pickWeighted<T>(options: [T, number][], rng: Rng): T {
  const total = options.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [v, w] of options) {
    r -= w;
    if (r < 0) return v;
  }
  return options[options.length - 1][0];
}

/** いじらずに通す計画（1小節ごとに、材料の同じ位置をそのまま）。 */
export function planStraight(dstBeats: number, beatsPerBar: number): ChopSegment[] {
  const bars = Math.max(1, Math.round(dstBeats / beatsPerBar));
  return Array.from({ length: bars }, (_, b) => ({
    kind: "play" as const,
    dst: b * beatsPerBar,
    len: beatsPerBar,
    src: b * beatsPerBar,
  }));
}

/** 断片の長さ（拍）。細かさが高いほど短くなりやすい。 */
function sliceLen(size: number, beatsPerBar: number, rng: Rng): number {
  const cands = [beatsPerBar / 2, 1, 0.5, 0.25];
  const pos = clamp01(size) * (cands.length - 1) + (rng() - 0.5) * 1.5;
  return cands[Math.min(cands.length - 1, Math.max(0, Math.round(pos)))];
}

/** 同じ断片 src から長さ len ずつを total 拍ぶん繰り返す。 */
function repeat(kind: ChopKind, dst: number, total: number, len: number, src: number): ChopSegment[] {
  const out: ChopSegment[] = [];
  for (let t = 0; t < total - EPS; t += len) {
    out.push({ kind, dst: dst + t, len: Math.min(len, total - t), src });
  }
  return out;
}

const NO_DRUMS: LayerRole[] = ["melody", "bass", "chords", "other"];

/** 1小節ぶんのいじり方。dst はその小節の頭。 */
function gesture(
  kind: Exclude<ChopKind, "play">,
  dst: number,
  beatsPerBar: number,
  loopBars: number,
  size: number,
  rng: Rng,
): ChopSegment[] {
  const bpb = beatsPerBar;
  const half = bpb / 2;
  switch (kind) {
    case "jump": {
      // 材料の別の小節へ飛ぶ。細かさが高いと、半小節ずつ別々の場所へ
      const current = Math.round(dst / bpb) % loopBars;
      const pieceLen = size > 0.6 ? half : bpb;
      const out: ChopSegment[] = [];
      for (let t = 0; t < bpb - EPS; t += pieceLen) {
        let bar = randInt(loopBars, rng);
        if (loopBars > 1 && bar === current) bar = (bar + 1 + randInt(loopBars - 1, rng)) % loopBars;
        const src = bar * bpb + (pieceLen < bpb ? randInt(2, rng) * pieceLen : 0);
        out.push({ kind: "jump", dst: dst + t, len: pieceLen, src });
      }
      return out;
    }
    case "stutter": {
      const len = sliceLen(size, bpb, rng);
      const slots = Math.max(1, Math.floor(bpb / len + EPS));
      const src = dst + randInt(slots, rng) * len;
      return repeat("stutter", dst, bpb, len, src);
    }
    case "reverse": {
      if (rng() < 0.6) return [{ kind: "reverse", dst, len: bpb, src: dst, reverse: true }];
      return [
        { kind: "play", dst, len: half, src: dst },
        { kind: "reverse", dst: dst + half, len: half, src: dst + half, reverse: true },
      ];
    }
    case "fill": {
      // 小節の終わりだけ、短い断片を繰り返してつなぐ
      const tail = size < 0.5 ? half : Math.min(1, half);
      const len = Math.min(sliceLen(size, bpb, rng), tail);
      const start = dst + bpb - tail;
      const src = start + randInt(Math.max(1, Math.floor(tail / len + EPS)), rng) * len;
      return [
        { kind: "play", dst, len: bpb - tail, src: dst },
        ...repeat("fill", start, tail, len, src),
      ];
    }
    case "break": {
      const mask = pickWeighted<LayerRole[]>(
        [
          [["drums"], 3],
          [NO_DRUMS, 2],
          [[], 1],
        ],
        rng,
      );
      if (rng() < 0.5) return [{ kind: "break", dst, len: bpb, src: dst, mask }];
      return [
        { kind: "play", dst, len: half, src: dst },
        { kind: "break", dst: dst + half, len: half, src: dst + half, mask },
      ];
    }
  }
}

export interface PlanInput {
  dstBeats: number;
  beatsPerBar: number;
  /** 材料のいちばん長いものの小節数（ジャンプで飛べる範囲）。 */
  loopBars: number;
  params: ChopParams;
}

/**
 * 刻み方の計画を偶然で作る。頭の小節はそのまま通りやすく、終わりの小節ほどいじりが入りやすい。
 * busy=0 なら、計画はそのまま通すだけ。
 */
export function planChops(input: PlanInput, rng: Rng): ChopSegment[] {
  const { dstBeats, beatsPerBar: bpb, params } = input;
  const loopBars = Math.max(1, Math.round(input.loopBars));
  const busy = clamp01(params.busy);
  const breaks = clamp01(params.breaks);
  const size = clamp01(params.size);
  const bars = Math.max(1, Math.round(dstBeats / bpb));
  const out: ChopSegment[] = [];
  for (let b = 0; b < bars; b++) {
    const dst = b * bpb;
    const weight = b === bars - 1 && bars > 1 ? 1.3 : b === 0 ? 0.25 : 0.8;
    if (rng() >= clamp01(busy * weight)) {
      out.push({ kind: "play", dst, len: bpb, src: dst });
      continue;
    }
    const kind = pickWeighted<Exclude<ChopKind, "play">>(
      [
        ["jump", loopBars > 1 ? 3 : 0],
        ["stutter", 3],
        ["reverse", 1.5],
        ["fill", 2.5],
        ["break", breaks * 6],
      ],
      rng,
    );
    out.push(...gesture(kind, dst, bpb, loopBars, size, rng));
  }
  return out;
}

/**
 * 計画を1つの層の音符に当てる。材料の音符（srcBeats 拍のループ）から、区間ごとに切り出して並べる。
 * 区間の外にはみ出す音は切る（DJが断片を切るのと同じ）。mask に含まれない役割の層は、その区間は無音。
 */
export function applyPlan(
  notes: Note[],
  srcBeats: number,
  role: LayerRole,
  plan: ChopSegment[],
  dstBeats: number,
): Note[] {
  if (srcBeats <= 0) return [];
  const out: Note[] = [];
  for (const seg of plan) {
    if (seg.mask && !seg.mask.includes(role)) continue;
    const from = Math.floor(seg.src / srcBeats);
    const to = Math.ceil((seg.src + seg.len) / srcBeats);
    for (let k = from; k <= to; k++) {
      for (const n of notes) {
        const pos = n.startBeats + k * srcBeats;
        if (pos < seg.src - EPS || pos >= seg.src + seg.len - EPS) continue;
        const rel = pos - seg.src;
        const dur = Math.max(0.05, Math.min(n.durationBeats, seg.len - rel));
        const start = seg.reverse ? seg.len - rel - dur : rel;
        const at = seg.dst + Math.max(0, start);
        if (at >= dstBeats - EPS) continue;
        out.push({ ...n, id: makeId("note"), startBeats: at, durationBeats: Math.min(dur, dstBeats - at) });
      }
    }
  }
  return dedupe(out);
}

function dedupe(notes: Note[]): Note[] {
  const seen = new Set<string>();
  const out: Note[] = [];
  for (const n of notes.sort((a, b) => a.startBeats - b.startBeats)) {
    const key = `${n.pitch}@${n.startBeats.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

const kindLabels: Record<ChopKind, string> = {
  play: "そのまま",
  jump: "ジャンプ",
  stutter: "リピート",
  reverse: "逆回し",
  fill: "フィル",
  break: "抜き",
};

function breakLabel(mask: LayerRole[] | undefined): string {
  if (!mask || mask.length === 0) return "無音";
  return mask.includes("drums") ? "ドラムだけ" : "ドラム抜き";
}

/** 小節ごとの説明（画面に出す用）。その小節でいちばん目立つ動きを1つ選ぶ。 */
export function chopBarLabels(plan: ChopSegment[], beatsPerBar: number): string[] {
  const bars = plan.length === 0 ? 0 : Math.round(Math.max(...plan.map((s) => s.dst + s.len)) / beatsPerBar);
  const rank: ChopKind[] = ["break", "reverse", "stutter", "fill", "jump", "play"];
  return Array.from({ length: bars }, (_, b) => {
    const segs = plan.filter((s) => s.dst >= b * beatsPerBar - EPS && s.dst < (b + 1) * beatsPerBar - EPS);
    const top = rank.find((k) => segs.some((s) => s.kind === k)) ?? "play";
    const seg = segs.find((s) => s.kind === top);
    return top === "break" ? breakLabel(seg?.mask) : kindLabels[top];
  });
}
