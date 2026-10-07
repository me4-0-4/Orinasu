type Rng = () => number;

/**
 * 刻み方の種類（DJ・音MADが原曲をいじる動き）。
 * break は無音、double は倍速、half は半速、scatter は短い断片を16分・8分の格子に打つパターン、
 * roll は だんだん細かくなる連打。
 */
export type ChopKind = "play" | "jump" | "stutter" | "reverse" | "fill" | "break" | "double" | "half" | "scatter" | "roll";

/**
 * 刻み方の計画の1区間。曲全体を隙間なく覆う。
 * 区間の中身は「どの曲（フレーズ）の、どこ」を丸ごと取るか。曲は1本の音として扱い、中身（層）には触らない。
 * 曲のテンポ（BPM）はフレーズのBPMとは無関係。フレーズは曲のテンポに合わせて鳴り、rate で倍速・半速にもなる。
 */
export interface ChopSegment {
  kind: ChopKind;
  /** 取ってくる曲（フレーズ）のid。 */
  from: string;
  /** 区間の頭（セクションの頭からの拍）。 */
  dst: number;
  len: number;
  /** その曲のどこから取るか（そのフレーズの頭からの拍）。曲より長いときは、曲の頭に戻って続く。 */
  src: number;
  /** 再生の速さ。無ければ1（等速）、2なら倍速、0.5なら半速。区間は len 拍ぶんの時間で、フレーズは len×rate 拍ぶん進む。 */
  rate?: number;
  reverse?: boolean;
  /**
   * 断片の音程を半音いくつ上げ下げするか（無ければ0）。サンプラーのように、再生の速さごと変える
   * （高くすると、その分だけ短く・速くなる）。断片を高低に並べて、メロディのように鳴らす。
   */
  pitch?: number;
  /** 無音の区間（パターンの打たない所）。 */
  mute?: boolean;
}

/** 区間が無音か。 */
export function isSilent(seg: Pick<ChopSegment, "kind" | "mute">): boolean {
  return seg.kind === "break" || seg.mute === true;
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
  /** 抜き：いじりのうち、無音にする割合。 */
  breaks: number;
  /** 細かさ：リピートやジャンプの断片の短さ（0＝2拍、1＝1/4拍まで）。 */
  size: number;
  /** 音程：断片を高く・低くして、メロディのように鳴らす割合。0なら音程は変えない。 */
  pitch: number;
}

export const DEFAULT_CHOP: ChopParams = { busy: 0.7, breaks: 0.2, size: 0.6, pitch: 0.4 };

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

/** 断片の音程の候補（半音）。ドレミで言う、よく合う高さ。 */
const PITCH_STEPS = [-12, -7, -5, -3, 2, 3, 4, 5, 7, 9, 12];

/** 音程の変化（0〜1）に応じて、断片の音程を選ぶ。変化が小さければ、たいてい0（そのまま）。 */
function pickPitch(amount: number, rng: Rng): number {
  if (rng() >= amount) return 0;
  return PITCH_STEPS[randInt(PITCH_STEPS.length, rng)];
}

interface Ctx {
  bpb: number;
  size: number;
  pitch: number;
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
      const segs = repeat("stutter", from, dst, bpb, len, src);
      // 音程が効いていれば、1つおきに高さを変えて、メロディのように連打する
      const alt = pickPitch(ctx.pitch, rng);
      if (alt !== 0) segs.forEach((seg, i) => i % 2 === 1 && (seg.pitch = alt));
      return segs;
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
      // 無音（落とす）。小節まるごと、または後ろ半分
      if (rng() < 0.5) return [{ kind: "break", from: baseId, dst, len: bpb, src: dst }];
      return [
        { kind: "play", from: baseId, dst, len: half, src: dst },
        { kind: "break", from: baseId, dst: dst + half, len: half, src: dst + half },
      ];
    }
    case "scatter": {
      // 音MADの打ち方：曲の短い断片を2〜3個だけ拾い、16分・8分の格子に、リズムを作って打つ。
      // 打たない所は無音。断片ごとに音程を変えると、メロディになる
      const step = size > 0.5 ? 0.25 : 0.5;
      const slots = Math.max(1, Math.round(bpb / step));
      const from = pickFrom(ctx, rng);
      const bars = barsOf(ctx, from);
      const palette = Array.from({ length: 2 + randInt(2, rng) }, () => randInt(bars, rng) * bpb + randInt(Math.max(1, Math.floor(bpb)), rng));
      const hits: number[] = [];
      for (let i = 0; i < slots; i++) if (i === 0 || rng() < 0.55) hits.push(i);
      const out: ChopSegment[] = [];
      hits.forEach((i, h) => {
        const gap = ((hits[h + 1] ?? slots) - i) * step;
        const len = Math.min(gap, step * (1 + randInt(2, rng)));
        const seg: ChopSegment = { kind: "scatter", from, dst: dst + i * step, len, src: palette[randInt(palette.length, rng)] };
        const semis = pickPitch(ctx.pitch, rng);
        if (semis !== 0) seg.pitch = semis;
        out.push(seg);
        if (gap - len > EPS) out.push({ kind: "scatter", from, dst: dst + i * step + len, len: gap - len, src: seg.src, mute: true });
      });
      return out;
    }
    case "roll": {
      // 小節の終わり2拍を、だんだん短くなる連打でつなぐ（高めの音程だと、音も上がっていく）
      const tail = Math.min(bpb, 2);
      const start = dst + bpb - tail;
      const lens = [0.5, 0.5, 0.25, 0.25, 0.125, 0.125, 0.125, 0.125].map((l) => (l * tail) / 2);
      const rising = rng() < ctx.pitch;
      const out: ChopSegment[] = [];
      if (bpb - tail > EPS) out.push({ kind: "play", from: baseId, dst, len: bpb - tail, src: dst });
      let t = start;
      lens.forEach((len, i) => {
        const seg: ChopSegment = { kind: "roll", from: baseId, dst: t, len, src: start };
        if (rising && i > 1) seg.pitch = i - 1;
        out.push(seg);
        t += len;
      });
      return out;
    }
    case "double": {
      // 倍速：2倍の速さで進む（小節まるごと、または後ろ半分）。音程は変わらない
      if (rng() < 0.6) return [{ kind: "double", from: baseId, dst, len: bpb, src: dst, rate: 2 }];
      return [
        { kind: "play", from: baseId, dst, len: half, src: dst },
        { kind: "double", from: baseId, dst: dst + half, len: half, src: dst + half, rate: 2 },
      ];
    }
    case "half": {
      // 半速：半分の速さで進む。小節の前半か後半だけを引き伸ばす
      const src = dst + (rng() < 0.5 ? 0 : half);
      return [{ kind: "half", from: baseId, dst, len: bpb, src, rate: 0.5 }];
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
  const ctx: Ctx = { bpb, size: clamp01(params.size), pitch: clamp01(params.pitch ?? 0), sources, baseId };
  const breaks = clamp01(params.breaks);
  const bars = Math.max(1, Math.round(dstBeats / bpb));
  const ids = new Set(sources.map((s) => s.id));
  const canJump = sources.some((s) => s.id !== baseId) || barsOf(ctx, baseId) > 1;
  const out: ChopSegment[] = [];
  /** 直前の小節がパターン打ちなら、そのパターン。次の小節で繰り返すことがある（音MADのノリ）。 */
  let motif: ChopSegment[] | null = null;
  for (let b = 0; b < bars; b++) {
    const dst = b * bpb;
    // 判断のたびに乱数を使う数をそろえるため、先に引いておく
    const roll = rng();
    const again = rng();
    const kept = input.keep?.bars.includes(b)
      ? input.keep.plan.filter((s) => s.dst >= dst - EPS && s.dst < dst + bpb - EPS)
      : [];
    if (kept.length > 0 && kept.every((s) => ids.has(s.from))) {
      out.push(...kept.map((s) => ({ ...s })));
      continue;
    }
    if (motif && again < 0.6) {
      // 同じパターンをもう一度（ところどころ崩すのは、そのあとの小節）
      out.push(...motif.map((s) => ({ ...s, dst: s.dst + bpb })));
      motif = motif.map((s) => ({ ...s, dst: s.dst + bpb }));
      continue;
    }
    motif = null;
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
        ["scatter", 4],
        ["roll", 2],
        ["double", 1.5],
        ["half", 1.5],
        ["break", breaks * 6],
      ],
      rng,
    );
    const made = gesture(kind, dst, ctx, rng);
    out.push(...made);
    if (kind === "scatter") motif = made;
  }
  return out;
}

const kindLabels: Record<ChopKind, string> = {
  play: "そのまま",
  jump: "ジャンプ",
  stutter: "リピート",
  reverse: "逆回し",
  fill: "フィル",
  break: "無音",
  double: "倍速",
  half: "半速",
  scatter: "パターン",
  roll: "ロール",
};

/** 計画に出てくる (曲, 速さ) の組。曲をこの速さで書き出しておく必要がある。 */
export function neededSources(plan: ChopSegment[]): { from: string; rate: number }[] {
  const seen = new Map<string, { from: string; rate: number }>();
  for (const s of plan) {
    if (isSilent(s)) continue;
    const rate = s.rate ?? 1;
    seen.set(`${s.from}@${rate}`, { from: s.from, rate });
  }
  return [...seen.values()];
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
  const rank: ChopKind[] = ["break", "scatter", "roll", "reverse", "stutter", "fill", "double", "half", "jump", "play"];
  return Array.from({ length: bars }, (_, b) => {
    const segs = plan.filter((s) => s.dst >= b * beatsPerBar - EPS && s.dst < (b + 1) * beatsPerBar - EPS);
    const top = rank.find((k) => segs.some((s) => s.kind === k)) ?? "play";
    let label = kindLabels[top];
    if (names) {
      const other = segs.find((s) => s.from !== names.baseId);
      if (other) label += `←${(names.byId[other.from] ?? "").slice(0, 4)}`;
    }
    return label;
  });
}
