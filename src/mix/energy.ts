import type { LayerRole } from "../phrase/types.ts";

/** 盛り上がりの線の1点。t=曲の頭が0・終わりが1、v=盛り上がり度（0〜1）。 */
export interface EnergyPoint {
  t: number;
  v: number;
}

export type EnergyCurve = EnergyPoint[];

export type CurveShape = "jpop" | "edm" | "gentle";

export const curveShapeLabels: Record<CurveShape, string> = {
  jpop: "J-POP型",
  edm: "EDM型",
  gentle: "ゆるやか型",
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 型の線。どれも曲全体を0〜1に正規化した形で、あとから描き直せる。 */
export function shapeCurve(shape: CurveShape): EnergyCurve {
  switch (shape) {
    case "jpop": // A低 → B上昇 → サビ最高
      return [
        { t: 0, v: 0.2 },
        { t: 0.34, v: 0.3 },
        { t: 0.6, v: 0.72 },
        { t: 0.64, v: 0.95 },
        { t: 1, v: 1 },
      ];
    case "edm": // ビルドアップ → ドロップ → 落ち着く → もう一度
      return [
        { t: 0, v: 0.15 },
        { t: 0.3, v: 0.85 },
        { t: 0.34, v: 0.1 },
        { t: 0.36, v: 1 },
        { t: 0.66, v: 1 },
        { t: 0.7, v: 0.35 },
        { t: 1, v: 0.9 },
      ];
    case "gentle":
      return [
        { t: 0, v: 0.2 },
        { t: 0.5, v: 0.55 },
        { t: 1, v: 0.8 },
      ];
  }
}

export function defaultCurve(): EnergyCurve {
  return shapeCurve("jpop");
}

/** 点を t 順に並べ、範囲外を丸める。 */
export function normalizeCurve(points: EnergyCurve): EnergyCurve {
  return points
    .map((p) => ({ t: clamp01(p.t), v: clamp01(p.v) }))
    .sort((a, b) => a.t - b.t);
}

/** 線の高さ（折れ線の補間）。点がなければ0.5。 */
export function energyAt(curve: EnergyCurve, t: number): number {
  if (curve.length === 0) return 0.5;
  if (t <= curve[0].t) return curve[0].v;
  const last = curve[curve.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      return span <= 1e-9 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / span;
    }
  }
  return last.v;
}

/**
 * ペンでなぞった範囲（x0〜x1）の点を、なぞった点に置き換える。
 * 範囲の外の点はそのまま残す。
 */
export function paintCurve(curve: EnergyCurve, stroke: EnergyPoint[]): EnergyCurve {
  if (stroke.length === 0) return curve;
  const lo = Math.min(...stroke.map((p) => p.t));
  const hi = Math.max(...stroke.map((p) => p.t));
  const rest = curve.filter((p) => p.t < lo - 1e-9 || p.t > hi + 1e-9);
  return normalizeCurve([...rest, ...stroke]);
}

// --- マクロ：盛り上がり度が動かすもの ---------------------------------------

export type MacroId = "layers" | "density" | "filter" | "fill";

/** 段階的＝小節の頭で切り替える。連続＝線に沿って滑らかに動かす。 */
export type MacroMode = "stepped" | "smooth";

export interface Macro {
  id: MacroId;
  enabled: boolean;
  /** 盛り上がり度0のときの値と、1のときの値（0〜1）。意味はマクロごと（下の macroInfo）。 */
  from: number;
  to: number;
}

export interface MacroInfo {
  label: string;
  mode: MacroMode;
  /** 0〜1の値が何を表すか。 */
  fromLabel: string;
  toLabel: string;
  hint: string;
}

export const macroInfo: Record<MacroId, MacroInfo> = {
  layers: {
    label: "鳴らす層の数",
    mode: "stepped",
    fromLabel: "少ない",
    toLabel: "全部",
    hint: "盛り上がるほど層が増える。ドラム→ベース→コード→その他→メロディの順に入る",
  },
  density: {
    label: "音の密度",
    mode: "stepped",
    fromLabel: "まばら",
    toLabel: "そのまま",
    hint: "盛り上がりが低いと、音符を間引く",
  },
  filter: {
    label: "フィルターの開き",
    mode: "smooth",
    fromLabel: "閉じる",
    toLabel: "開く",
    hint: "シンセ（ドラム以外）のカットオフを動かす",
  },
  fill: {
    label: "ドラムのフィルイン",
    mode: "stepped",
    fromLabel: "なし",
    toLabel: "毎小節",
    hint: "盛り上がるほど、小節の終わりにフィルインが入りやすい",
  },
};

export const macroOrder: MacroId[] = ["layers", "density", "filter", "fill"];

/** 山をオンにしたとき、層も音もほとんど消えない初期値（低いところでも層は過半数、音は8割残る）。 */
export function defaultMacros(): Macro[] {
  return [
    { id: "layers", enabled: true, from: 0.6, to: 1 },
    { id: "density", enabled: true, from: 0.8, to: 1 },
    { id: "filter", enabled: true, from: 0.6, to: 1 },
    { id: "fill", enabled: true, from: 0, to: 0.6 },
  ];
}

/** 盛り上がり度 e（0〜1）を、マクロの値（from〜to）に写す。 */
export function macroValue(macro: Macro, e: number): number {
  return macro.from + (macro.to - macro.from) * clamp01(e);
}

export function getMacro(macros: Macro[], id: MacroId): Macro | undefined {
  const m = macros.find((x) => x.id === id);
  return m && m.enabled ? m : undefined;
}

/** 層が入ってくる順（先に入るほど前）。 */
const ROLE_PRIORITY: LayerRole[] = ["drums", "bass", "chords", "other", "melody"];

/** 盛り上がり度のとき、この層は鳴るか。層の数は value（0〜1）×層数、最低1つ。 */
export function layerAudible(role: LayerRole, rolesInSection: LayerRole[], value: number): boolean {
  const ordered = ROLE_PRIORITY.filter((r) => rolesInSection.includes(r));
  const count = Math.max(1, Math.round(clamp01(value) * ordered.length));
  return ordered.slice(0, count).includes(role);
}

/** 音符idから決まる0〜1の値（同じ音符には常に同じ値。再生のたびに結果が変わらない）。 */
export function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** 密度 value（0〜1）で、この音符を残すか。小節の頭の音は少なくとも半分の密度まで残す。 */
export function noteKept(noteId: string, onDownbeat: boolean, value: number): boolean {
  if (value >= 0.999) return true;
  const threshold = onDownbeat ? Math.max(value, 0.5) : value;
  return hash01(noteId) < threshold;
}

/** フィルターの開き value（0〜1）を、セントのずらし量に写す（0＝-3600セント＝3オクターブ閉じる、1＝0）。 */
export function filterOffsetCents(value: number): number {
  return -3600 * (1 - clamp01(value));
}
