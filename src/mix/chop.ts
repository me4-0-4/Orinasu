import { makeId, type LayerRole, type Note } from "../phrase/types.ts";

type Rng = () => number;

/** 刻み方の種類（DJが原曲をいじる動き）。 */
export type ChopKind = "play" | "jump" | "stutter" | "reverse" | "fill" | "break";

/**
 * 刻み方の計画の1区間。セクション全体を隙間なく覆う。
 * 区間の中身は「どの曲（フレーズ）の、どこ」を丸ごと取るか。その曲の全部の層が同じ位置で一緒に鳴る
 * （曲を1つの塊として刻む。役割ごとにバラバラに拾わない）。
 */
export interface ChopSegment {
  kind: ChopKind;
  /** 取ってくる曲（フレーズ）のid。 */
  from: string;
  /** 区間の頭（セクションの頭からの拍）。 */
  dst: number;
  len: number;
  /** その曲のどこから取るか（拍）。曲より長いときは、曲の頭に戻って続く。 */
  src: number;
  reverse?: boolean;
  /** 鳴らす役割。無ければ全部。空なら無音。 */
  mask?: LayerRole[];
}

/** 刻みの材料にする曲。bars は曲の長さ（小節）。 */
export interface ChopSource {
  id: string;
  bars: number;
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

/** いじらずに通す計画（1小節ごとに、曲の同じ位置をそのまま）。 */
export function planStraight(dstBeats: number, beatsPerBar: number, from: string): ChopSegment[] {
  const bars = Math.max(1, Math.round(dstBeats / beatsPerBar));
  return Array.from({ length: bars }, (_, b) => ({
    kind: "play" as const,
    from,
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
function repeat(kind: ChopKind, from: string, dst: number, total: number, len: number, src: number): ChopSegment[] {
  const out: ChopSegment[] = [];
  for (let t = 0; t < total - EPS; t += len) {
    out.push({ kind, from, dst: dst + t, len: Math.min(len, total - t), src });
  }
  return out;
}

const NO_DRUMS: LayerRole[] = ["melody", "bass", "chords", "other"];

interface Ctx {
  bpb: number;
  size: number;
  sources: ChopSource[];
  baseId: string;
}

function barsOf(ctx: Ctx, id: string): number {
  return Math.max(1, Math.round(ctx.sources.find((s) => s.id === id)?.bars ?? 1));
}

/** 取ってくる曲：基本はメインの曲。曲が複数あるときは、ときどき別の曲から。 */
function pickFrom(ctx: Ctx, rng: Rng): string {
  const others = ctx.sources.filter((s) => s.id !== ctx.baseId);
  if (others.length === 0 || rng() < 0.65) return ctx.baseId;
  return others[randInt(others.length, rng)].id;
}

/** 1小節ぶんのいじり方。dst はその小節の頭。 */
function gesture(kind: Exclude<ChopKind, "play">, dst: number, ctx: Ctx, rng: Rng): ChopSegment[] {
  const { bpb, size, baseId } = ctx;
  const half = bpb / 2;
  const barIndex = Math.round(dst / bpb);
  switch (kind) {
    case "jump": {
      // 曲の別の小節へ飛ぶ。細かさが高いと、半小節ずつ別々の場所へ。曲が複数なら別の曲へも
      const pieceLen = size > 0.6 ? half : bpb;
      const out: ChopSegment[] = [];
      for (let t = 0; t < bpb - EPS; t += pieceLen) {
        let from = pickFrom(ctx, rng);
        if (from === baseId && barsOf(ctx, baseId) <= 1) {
          const others = ctx.sources.filter((s) => s.id !== baseId);
          if (others.length > 0) from = others[randInt(others.length, rng)].id;
        }
        const bars = barsOf(ctx, from);
        let bar = randInt(bars, rng);
        if (from === baseId && bars > 1 && bar === barIndex % bars) bar = (bar + 1 + randInt(bars - 1, rng)) % bars;
        const src = bar * bpb + (pieceLen < bpb ? randInt(2, rng) * pieceLen : 0);
        out.push({ kind: "jump", from, dst: dst + t, len: pieceLen, src });
      }
      return out;
    }
    case "stutter": {
      // 曲のどこかの短い断片を、小節いっぱい連打する（多くはその小節の中から、ときどき別の小節・別の曲から）
      const len = sliceLen(size, bpb, rng);
      const slots = Math.max(1, Math.floor(bpb / len + EPS));
      const from = pickFrom(ctx, rng);
      const bars = barsOf(ctx, from);
      const bar = from === baseId && rng() >= 0.35 ? barIndex : randInt(bars, rng);
      const src = bar * bpb + randInt(slots, rng) * len;
      return repeat("stutter", from, dst, bpb, len, src);
    }
    case "reverse": {
      if (rng() < 0.6) return [{ kind: "reverse", from: baseId, dst, len: bpb, src: dst, reverse: true }];
      return [
        { kind: "play", from: baseId, dst, len: half, src: dst },
        { kind: "reverse", from: baseId, dst: dst + half, len: half, src: dst + half, reverse: true },
      ];
    }
    case "fill": {
      // 小節の終わりだけ、短い断片を繰り返してつなぐ
      const tail = size < 0.5 ? half : Math.min(1, half);
      const len = Math.min(sliceLen(size, bpb, rng), tail);
      const start = dst + bpb - tail;
      const src = start + randInt(Math.max(1, Math.floor(tail / len + EPS)), rng) * len;
      return [
        { kind: "play", from: baseId, dst, len: bpb - tail, src: dst },
        ...repeat("fill", baseId, start, tail, len, src),
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
      if (rng() < 0.5) return [{ kind: "break", from: baseId, dst, len: bpb, src: dst, mask }];
      return [
        { kind: "play", from: baseId, dst, len: half, src: dst },
        { kind: "break", from: baseId, dst: dst + half, len: half, src: dst + half, mask },
      ];
    }
  }
}

export interface PlanInput {
  dstBeats: number;
  beatsPerBar: number;
  /** 刻む曲。1つ以上。 */
  sources: ChopSource[];
  /** メインの曲のid（そのまま通すときはこの曲）。 */
  baseId: string;
  params: ChopParams;
  /** 固定する小節（0から数える）と、そこに使う前の計画。 */
  keep?: { bars: number[]; plan: ChopSegment[] };
}

/**
 * 刻み方の計画を偶然で作る。頭の小節はそのまま通りやすく、終わりの小節ほどいじりが入りやすい。
 * busy=0 なら、メインの曲をそのまま通すだけ。固定した小節は前の計画のまま残す。
 */
export function planChops(input: PlanInput, rng: Rng): ChopSegment[] {
  const { dstBeats, beatsPerBar: bpb, params, sources, baseId } = input;
  const busy = clamp01(params.busy);
  const ctx: Ctx = { bpb, size: clamp01(params.size), sources, baseId };
  const breaks = clamp01(params.breaks);
  const bars = Math.max(1, Math.round(dstBeats / bpb));
  const ids = new Set(sources.map((s) => s.id));
  const canJump = sources.some((s) => s.id !== baseId) || barsOf(ctx, baseId) > 1;
  const out: ChopSegment[] = [];
  for (let b = 0; b < bars; b++) {
    const dst = b * bpb;
    // 判断のたびに乱数を使う数をそろえるため、先に引いておく
    const roll = rng();
    const kept = input.keep?.bars.includes(b)
      ? input.keep.plan.filter((s) => s.dst >= dst - EPS && s.dst < dst + bpb - EPS)
      : [];
    if (kept.length > 0 && kept.every((s) => ids.has(s.from))) {
      out.push(...kept.map((s) => ({ ...s })));
      continue;
    }
    const weight = b === bars - 1 && bars > 1 ? 1.3 : b === 0 ? 0.25 : 0.8;
    if (roll >= clamp01(busy * weight)) {
      out.push({ kind: "play", from: baseId, dst, len: bpb, src: dst });
      continue;
    }
    const kind = pickWeighted<Exclude<ChopKind, "play">>(
      [
        ["jump", canJump ? 3 : 0],
        ["stutter", 3],
        ["reverse", 1.5],
        ["fill", 2.5],
        ["break", breaks * 6],
      ],
      rng,
    );
    out.push(...gesture(kind, dst, ctx, rng));
  }
  return out;
}

/**
 * 計画を1つの層の音符に当てる。曲の音符（srcBeats 拍のループ）から、区間ごとに切り出して並べる。
 * fromId を渡すと、その曲から取る区間だけを使う（層は曲ごとに持つため）。
 * 区間の外にはみ出す音は切る（DJが断片を切るのと同じ）。mask に含まれない役割の層は、その区間は無音。
 */
export function applyPlan(
  notes: Note[],
  srcBeats: number,
  role: LayerRole,
  plan: ChopSegment[],
  dstBeats: number,
  fromId?: string,
): Note[] {
  if (srcBeats <= 0) return [];
  const out: Note[] = [];
  for (const seg of plan) {
    if (fromId !== undefined && seg.from !== fromId) continue;
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

/**
 * 小節ごとの説明（画面に出す用）。その小節でいちばん目立つ動きを1つ選ぶ。
 * names（曲のid→名前）を渡すと、メインの曲(baseId)以外から取った小節に「←曲名」を足す。
 */
export function chopBarLabels(
  plan: ChopSegment[],
  beatsPerBar: number,
  names?: { baseId: string; byId: Record<string, string> },
): string[] {
  const bars = plan.length === 0 ? 0 : Math.round(Math.max(...plan.map((s) => s.dst + s.len)) / beatsPerBar);
  const rank: ChopKind[] = ["break", "reverse", "stutter", "fill", "jump", "play"];
  return Array.from({ length: bars }, (_, b) => {
    const segs = plan.filter((s) => s.dst >= b * beatsPerBar - EPS && s.dst < (b + 1) * beatsPerBar - EPS);
    const top = rank.find((k) => segs.some((s) => s.kind === k)) ?? "play";
    const seg = segs.find((s) => s.kind === top);
    let label = top === "break" ? breakLabel(seg?.mask) : kindLabels[top];
    if (names) {
      const other = segs.find((s) => s.from !== names.baseId);
      if (other) label += `←${(names.byId[other.from] ?? "").slice(0, 4)}`;
    }
    return label;
  });
}
