import { detectKeys, sameKey, snapToScale, type Key } from "../theory/key.ts";
import { makeId, totalBeats, type Layer, type LayerRole, type Note, type Phrase } from "../phrase/types.ts";
import { DEFAULT_CHOP, applyPlan, planChops, planStraight, type ChopParams, type ChopSegment } from "./chop.ts";
import { quantizeBeat } from "../phrase/quantize.ts";
import { clone } from "../audio/synthParams.ts";
import { createSection, sectionBeats, type MixLayer, type Section } from "./types.ts";

type Rng = () => number;

/** new＝素材も刻み方も新しく / replan＝同じ素材で刻み方だけ / source＝同じ刻み方で素材だけ。 */
export type RemixMode = "new" | "replan" | "source";

export const remixLabels: Record<RemixMode, string> = {
  new: "まるごと振る",
  replan: "刻み直す",
  source: "素材だけ替える",
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

/** 材料の1つの層：どのフレーズのどの層か。 */
export interface Material {
  phrase: Phrase;
  layer: Layer;
}

export function collectMaterials(phrases: Phrase[]): Material[] {
  return phrases.flatMap((phrase) =>
    phrase.layers.filter((l) => l.notes.length > 0).map((layer) => ({ phrase, layer })),
  );
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

/** 材料の層に計画を当てて、音符を作る。調は目標の調に合わせる（ドラムはそのまま）。 */
function chopped(mat: Material, plan: ChopSegment[], dstBeats: number, target: Key | null): Note[] {
  const srcBeats = totalBeats(mat.phrase);
  const notes = applyPlan(effectiveNotes(mat.layer), srcBeats, mat.layer.role, plan, dstBeats);
  if (mat.layer.role === "drums") return notes;
  const from = phraseKey(mat.phrase);
  return notes.map((n) => ({ ...n, pitch: adaptPitch(n.pitch, from, target) }));
}

/** 材料の長さ（小節）。ジャンプで飛べる範囲の目安。 */
function loopBarsOf(mats: Material[]): number {
  return Math.max(1, ...mats.map((m) => Math.round(totalBeats(m.phrase) / m.phrase.beatsPerBar)));
}

function makeLayer(role: LayerRole, mat: Material | null, notes: Note[]): MixLayer {
  return {
    id: makeId("layer"),
    role,
    notes,
    muted: false,
    solo: false,
    locked: false,
    volume: mat?.layer.volume,
    synth: mat?.layer.synth ? clone(mat.layer.synth) : undefined,
    sourceLabel: mat ? `${mat.phrase.name}・${mat.layer.role}` : undefined,
    srcPhraseId: mat?.phrase.id,
    srcLayerId: mat?.layer.id,
  };
}

const ROLES: LayerRole[] = ["melody", "bass", "drums", "chords", "other"];

export interface RemixOptions {
  /** セクションの長さ（小節）。 */
  lengthBars: number;
  /** 固定する層（前のセクションの固定済み層をそのまま残す）。 */
  keep?: MixLayer[];
  /** 刻みのスライダー。無ければ初期値。 */
  chop?: ChopParams;
  /** 刻み方の計画を使い回すとき（固定した層に合わせるとき）。 */
  plan?: ChopSegment[];
}

/**
 * 新しく振る：材料から、役割ごとに別の層を選び、全部の層に同じ刻み方の計画を当てる。
 * 固定した層（keep）はそのまま残し、それ以外だけ振り直す。
 */
export function remixNew(materials: Material[], opts: RemixOptions, rng: Rng, prev?: Section): Section | null {
  if (materials.length === 0) return null;
  const base = materials[0].phrase;
  const dstBeats = opts.lengthBars * base.beatsPerBar;
  // 調の基準：固定が無ければ、材料からひとつ選んだものの調
  const anchor = pick(materials.filter((m) => m.layer.role !== "drums"), rng) ?? materials[0];
  const target = prev?.key ?? phraseKey(anchor.phrase);

  const kept = (opts.keep ?? []).filter((l) => l.locked);
  const keptRoles = new Set(kept.map((l) => l.role));

  const chosen: { role: LayerRole; mat: Material }[] = [];
  for (const role of ROLES) {
    if (keptRoles.has(role)) continue;
    const pool = materials.filter((m) => m.layer.role === role);
    // 1つの役割に複数の材料があれば偶然で選ぶ。2層以上あっても重ねすぎないよう1つだけ
    if (pool.length > 0) chosen.push({ role, mat: pick(pool, rng) });
  }
  if (chosen.length + kept.length === 0) return null;

  const plan =
    opts.plan ??
    planChops(
      {
        dstBeats,
        beatsPerBar: base.beatsPerBar,
        loopBars: loopBarsOf(chosen.map((c) => c.mat)),
        params: opts.chop ?? DEFAULT_CHOP,
      },
      rng,
    );

  const layers: MixLayer[] = kept.map((l) => structuredClone(l));
  for (const { role, mat } of chosen) layers.push(makeLayer(role, mat, chopped(mat, plan, dstBeats, target)));
  layers.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
  const section = createSection(prev?.name ?? "セクション", base, opts.lengthBars, layers, target ?? undefined);
  return { ...section, plan };
}

/**
 * 固定していない層だけを振り直す。
 * new：素材も刻み方も新しく（固定した層があるあいだは、刻み方は残して層同士をそろえる）。
 * replan：同じ素材で、刻み方だけ新しく。
 * source：同じ刻み方で、素材だけ替える。
 */
export function remix(section: Section, mode: RemixMode, materials: Material[], rng: Rng, chop?: ChopParams): Section {
  const locked = section.layers.filter((l) => l.locked);
  if (mode === "new") {
    const next = remixNew(
      materials,
      { lengthBars: section.lengthBars, keep: locked, chop, plan: locked.length > 0 ? section.plan : undefined },
      rng,
      section,
    );
    if (!next) return section;
    return { ...next, id: section.id, name: section.name, createdAt: section.createdAt, updatedAt: Date.now() };
  }

  const dstBeats = sectionBeats(section);
  const target = section.key ?? null;
  // 層ごとに、使う素材を決める（replan は同じ素材、source は別の素材）
  const picks = new Map<string, Material>();
  for (const layer of section.layers) {
    if (layer.locked) continue;
    const pool = materials.filter((m) => m.layer.role === layer.role);
    if (pool.length === 0) continue;
    const current = pool.find((m) => m.phrase.id === layer.srcPhraseId && m.layer.id === layer.srcLayerId);
    if (mode === "replan") {
      picks.set(layer.id, current ?? pick(pool, rng));
    } else {
      const others = current ? pool.filter((m) => m !== current) : pool;
      picks.set(layer.id, pick(others.length > 0 ? others : pool, rng));
    }
  }
  const plan =
    mode === "replan"
      ? planChops(
          {
            dstBeats,
            beatsPerBar: section.beatsPerBar,
            loopBars: loopBarsOf([...picks.values()]),
            params: chop ?? DEFAULT_CHOP,
          },
          rng,
        )
      : (section.plan ?? planStraight(dstBeats, section.beatsPerBar));
  const layers = section.layers.map((l) => {
    const mat = picks.get(l.id);
    if (l.locked || !mat) return l;
    return {
      ...l,
      notes: chopped(mat, plan, dstBeats, target),
      sourceLabel: `${mat.phrase.name}・${mat.layer.role}`,
      srcPhraseId: mat.phrase.id,
      srcLayerId: mat.layer.id,
    };
  });
  return { ...section, plan, layers, updatedAt: Date.now() };
}
