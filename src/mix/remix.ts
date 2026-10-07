import { detectKeys, sameKey, snapToScale, type Key } from "../theory/key.ts";
import { makeId, roleLabels, totalBeats, type Layer, type LayerRole, type Note, type Phrase } from "../phrase/types.ts";
import { DEFAULT_CHOP, applyPlan, planChops, type ChopParams, type ChopSegment } from "./chop.ts";
import { quantizeBeat } from "../phrase/quantize.ts";
import { clone } from "../audio/synthParams.ts";
import { createSection, type MixLayer, type Section } from "./types.ts";

type Rng = () => number;

/** new＝メインの曲も刻み方も新しく / replan＝同じメインの曲で、刻み方だけ新しく。 */
export type RemixMode = "new" | "replan";

export const remixLabels: Record<RemixMode, string> = {
  new: "振る",
  replan: "刻み直す",
};

function pick<T>(arr: T[], rng: Rng): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** 層の音符を、クオンタイズ適用後の開始位置で返す（非破壊の「合わせる」を材料にも反映する）。 */
function effectiveNotes(layer: Layer): Note[] {
  return layer.notes.map((n) => ({
    ...n,
    startBeats: layer.quantizeGrid ? quantizeBeat(n.startBeats, layer.quantizeGrid) : n.startBeats,
  }));
}

/** フレーズの調：手動指定があればそれ、なければドラム以外の音から判定。分からなければnull。 */
export function phraseKey(phrase: Phrase): Key | null {
  if (phrase.keyOverride) return phrase.keyOverride;
  const notes = phrase.layers.filter((l) => l.role !== "drums").flatMap((l) => l.notes);
  return detectKeys(notes, 1)[0] ?? null;
}

/** from の調で書かれた音を、to の調に寄せるための半音数（-5〜+6で一番近い向き）。 */
export function transposeSemitones(from: Key, to: Key): number {
  const d = (((to.tonic - from.tonic) % 12) + 12) % 12;
  return d > 6 ? d - 12 : d;
}

/** 調を合わせた音高。移調して、長短が違うときはスケール内に寄せる。 */
export function adaptPitch(pitch: number, from: Key | null, to: Key | null): number {
  if (!from || !to) return pitch;
  const shifted = pitch + transposeSemitones(from, to);
  return sameKey(from, to) || from.mode === to.mode ? shifted : snapToScale(shifted, to);
}

/** 刻む曲：音符のある層を持つフレーズ（フレーズ1つ＝曲1つ。層には分けず、丸ごと刻む）。 */
export function collectMaterials(phrases: Phrase[]): Phrase[] {
  return phrases.filter((p) => p.layers.some((l) => l.notes.length > 0));
}

const ROLES: LayerRole[] = ["melody", "bass", "drums", "chords", "other"];

function makeLayer(phrase: Phrase, layer: Layer, notes: Note[]): MixLayer {
  return {
    id: makeId("layer"),
    role: layer.role,
    notes,
    muted: false,
    solo: false,
    locked: false,
    volume: layer.volume,
    mix: layer.mix ? { ...layer.mix } : undefined,
    synth: layer.synth ? clone(layer.synth) : undefined,
    sourceLabel: `${phrase.name}・${roleLabels[layer.role]}`,
    srcPhraseId: phrase.id,
    srcLayerId: layer.id,
  };
}

export interface RemixOptions {
  /** セクションの長さ（小節）。 */
  lengthBars: number;
  /** 刻みのスライダー。無ければ初期値。 */
  chop?: ChopParams;
  /** 固定する小節（0から数える）。前の計画（prev.plan）のまま残す。 */
  keepBars?: number[];
  /** メインの曲のid。無ければ偶然で選ぶ。 */
  baseId?: string;
}

/**
 * 曲を刻んで、セクションを作る。
 * 計画（どの曲のどこを、どの順で）を先に作り、各曲の全部の層に当てる。
 * 層は「曲×役割」ごとに持つので、曲ごとの音色もそのまま残り、同じ区間では1曲分の層が一緒に鳴る。
 */
export function remixNew(sources: Phrase[], opts: RemixOptions, rng: Rng, prev?: Section): Section | null {
  if (sources.length === 0) return null;
  const base =
    (opts.baseId ? sources.find((p) => p.id === opts.baseId) : undefined) ?? pick(sources, rng);
  const bpb = base.beatsPerBar;
  const dstBeats = opts.lengthBars * bpb;
  // 調の基準はメインの曲。ほかの曲は、その調に寄せる。刻み直すときは前の調のまま
  const target = (opts.baseId ? prev?.key : undefined) ?? phraseKey(base);

  const plan = planChops(
    {
      dstBeats,
      beatsPerBar: bpb,
      sources: sources.map((p) => ({ id: p.id, bars: Math.max(1, Math.round(totalBeats(p) / p.beatsPerBar)) })),
      baseId: base.id,
      params: opts.chop ?? DEFAULT_CHOP,
      keep: opts.keepBars && opts.keepBars.length > 0 && prev?.plan ? { bars: opts.keepBars, plan: prev.plan } : undefined,
    },
    rng,
  );

  const layers: MixLayer[] = [];
  for (const phrase of sources) {
    const from = phraseKey(phrase);
    const srcBeats = totalBeats(phrase);
    for (const layer of phrase.layers) {
      if (layer.notes.length === 0) continue;
      let notes = applyPlan(effectiveNotes(layer), srcBeats, layer.role, plan, dstBeats, phrase.id);
      if (layer.role !== "drums") notes = notes.map((n) => ({ ...n, pitch: adaptPitch(n.pitch, from, target) }));
      if (notes.length === 0) continue; // 使われなかった曲の層は出さない
      layers.push(makeLayer(phrase, layer, notes));
    }
  }
  if (layers.length === 0) return null;
  const order = new Map(sources.map((p, i) => [p.id, i]));
  layers.sort(
    (a, b) =>
      (order.get(a.srcPhraseId ?? "") ?? 0) - (order.get(b.srcPhraseId ?? "") ?? 0) ||
      ROLES.indexOf(a.role) - ROLES.indexOf(b.role),
  );
  const section = createSection(prev?.name ?? "セクション", base, opts.lengthBars, layers, target ?? undefined);
  return { ...section, plan, baseId: base.id };
}

/**
 * 振り直す。固定した小節（keepBars）は、前の計画のまま残す。
 * new：メインの曲も刻み方も新しく。replan：同じメインの曲で、刻み方だけ新しく。
 */
export function remix(
  section: Section,
  mode: RemixMode,
  sources: Phrase[],
  rng: Rng,
  chop?: ChopParams,
  keepBars?: number[],
): Section {
  const baseId = mode === "replan" && section.baseId && sources.some((p) => p.id === section.baseId) ? section.baseId : undefined;
  const next = remixNew(sources, { lengthBars: section.lengthBars, chop, keepBars, baseId }, rng, section);
  if (!next) return section;
  return { ...next, id: section.id, name: section.name, createdAt: section.createdAt, updatedAt: Date.now() };
}

export type { ChopSegment };
