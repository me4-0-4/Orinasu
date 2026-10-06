import { detectKeys, sameKey, snapToScale, type Key } from "../theory/key.ts";
import { makeId, totalBeats, type Layer, type LayerRole, type Note, type Phrase } from "../phrase/types.ts";
import { quantizeBeat } from "../phrase/quantize.ts";
import { clone } from "../audio/synthParams.ts";
import { createSection, sectionBeats, type MixLayer, type Section } from "./types.ts";

type Rng = () => number;

export type RemixMode = "new" | "recut" | "rhythm" | "order";

export const remixLabels: Record<RemixMode, string> = {
  new: "新しい組み合わせ",
  recut: "切り直し",
  rhythm: "リズムだけ",
  order: "順番だけ",
};

function pick<T>(arr: T[], rng: Rng): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function shuffled<T>(arr: T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

/** 材料の音符を、区間の長さ（拍）に収まるよう並べ直す。短ければ繰り返し、長ければ offsetBeats から切り出す。 */
export function fit(notes: Note[], srcBeats: number, dstBeats: number, offsetBeats: number): Note[] {
  const out: Note[] = [];
  const copies = Math.ceil(dstBeats / srcBeats);
  for (let c = 0; c < copies; c++) {
    for (const n of notes) {
      let t = n.startBeats - offsetBeats;
      if (t < 0) t += srcBeats; // 切り出し位置より前の音は、1周先に回す
      const pos = t + c * srcBeats;
      if (pos >= dstBeats - 1e-6) continue;
      out.push({
        ...n,
        id: makeId("note"),
        startBeats: pos,
        durationBeats: Math.min(n.durationBeats, dstBeats - pos),
      });
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

function fromMaterial(mat: Material, dstBeats: number, rng: Rng, target: Key | null): Note[] {
  const srcBeats = totalBeats(mat.phrase);
  const bar = mat.phrase.beatsPerBar;
  // 材料のほうが長いときは、どの小節から切り出すかも偶然で決める
  const bars = Math.max(1, Math.round(srcBeats / bar));
  const offset = srcBeats > dstBeats ? Math.floor(rng() * bars) * bar : 0;
  const from = phraseKey(mat.phrase);
  const isDrums = mat.layer.role === "drums";
  const notes = fit(effectiveNotes(mat.layer), srcBeats, dstBeats, offset);
  return isDrums ? notes : notes.map((n) => ({ ...n, pitch: adaptPitch(n.pitch, from, target) }));
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
  };
}

const ROLES: LayerRole[] = ["melody", "bass", "drums", "chords", "other"];

export interface RemixOptions {
  /** セクションの長さ（小節）。 */
  lengthBars: number;
  /** 固定する層（前のセクションの固定済み層をそのまま残す）。 */
  keep?: MixLayer[];
}

/**
 * 新しい組み合わせ：材料から、役割ごとに別の層を選んで重ねる。
 * 固定した層（keep）はそのまま残し、それ以外だけ振り直す。
 */
export function remixNew(materials: Material[], opts: RemixOptions, rng: Rng, prev?: Section): Section | null {
  if (materials.length === 0) return null;
  const base = materials[0].phrase;
  const dstBeats = opts.lengthBars * base.beatsPerBar;
  // 調の基準：固定が無ければ、最初に選んだメロディ材料の調
  const anchor = pick(materials.filter((m) => m.layer.role !== "drums"), rng) ?? materials[0];
  const target = prev?.key ?? phraseKey(anchor.phrase);

  const kept = (opts.keep ?? []).filter((l) => l.locked);
  const keptRoles = new Set(kept.map((l) => l.role));
  const layers: MixLayer[] = kept.map((l) => structuredClone(l));

  for (const role of ROLES) {
    if (keptRoles.has(role)) continue;
    const pool = materials.filter((m) => m.layer.role === role);
    if (pool.length === 0) continue;
    // 1つの役割に複数の材料があれば偶然で選ぶ。2層以上あっても重ねすぎないよう1つだけ
    const mat = pick(pool, rng);
    layers.push(makeLayer(role, mat, fromMaterial(mat, dstBeats, rng, target)));
  }
  if (layers.length === 0) return null;
  layers.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
  return createSection(prev?.name ?? "セクション", base, opts.lengthBars, layers, target ?? undefined);
}

/** 1層だけ振り直す（固定していない層に対して使う）。 */
function rerollLayer(
  layer: MixLayer,
  mode: Exclude<RemixMode, "new">,
  materials: Material[],
  section: Section,
  rng: Rng,
): MixLayer {
  const dstBeats = sectionBeats(section);
  const pool = materials.filter((m) => m.layer.role === layer.role);
  if (pool.length === 0) return layer;
  const target = section.key ?? null;
  let notes = layer.notes;

  if (mode === "order") {
    notes = reorderSlices(layer.notes, dstBeats, section.beatsPerBar, rng);
  } else if (mode === "recut") {
    // リズム（開始位置・長さ・強さ）は残し、音の高さだけ別の断片から取り直す
    const src = fromMaterial(pick(pool, rng), dstBeats, rng, target).sort((a, b) => a.startBeats - b.startBeats);
    if (layer.role === "drums") {
      notes = layer.notes.map((n, i) => ({ ...n, id: makeId("note"), pitch: src.length ? src[i % src.length].pitch : n.pitch }));
    } else if (src.length > 0) {
      notes = layer.notes.map((n, i) => ({ ...n, id: makeId("note"), pitch: src[i % src.length].pitch }));
    }
  } else {
    // リズムだけ変える：音の高さの並びは残し、開始位置・長さを別の層のリズムに替える
    const rhythm = fromMaterial(pick(pool, rng), dstBeats, rng, target).sort((a, b) => a.startBeats - b.startBeats);
    const pitches = layer.notes.slice().sort((a, b) => a.startBeats - b.startBeats).map((n) => n.pitch);
    if (rhythm.length > 0 && pitches.length > 0) {
      notes = rhythm.map((r, i) => ({ ...r, id: makeId("note"), pitch: pitches[i % pitches.length] }));
    }
  }
  return { ...layer, notes };
}

/** 断片（小節単位。1小節だけなら2拍単位）の順番を入れ替える。 */
export function reorderSlices(notes: Note[], totalBeatsLen: number, beatsPerBar: number, rng: Rng): Note[] {
  const sliceBeats = totalBeatsLen > beatsPerBar ? beatsPerBar : beatsPerBar / 2;
  const count = Math.max(1, Math.round(totalBeatsLen / sliceBeats));
  if (count < 2) return notes;
  const order = shuffled([...Array(count).keys()], rng);
  const out: Note[] = [];
  for (let slot = 0; slot < count; slot++) {
    const from = order[slot];
    for (const n of notes) {
      if (n.startBeats >= from * sliceBeats && n.startBeats < (from + 1) * sliceBeats) {
        out.push({ ...n, id: makeId("note"), startBeats: n.startBeats - from * sliceBeats + slot * sliceBeats });
      }
    }
  }
  return out.sort((a, b) => a.startBeats - b.startBeats);
}

/** 固定していない層だけを、指定の方法で振り直す。 */
export function remix(section: Section, mode: RemixMode, materials: Material[], rng: Rng): Section {
  if (mode === "new") {
    const next = remixNew(materials, { lengthBars: section.lengthBars, keep: section.layers.filter((l) => l.locked) }, rng, section);
    if (!next) return section;
    return { ...next, id: section.id, name: section.name, createdAt: section.createdAt, updatedAt: Date.now() };
  }
  const layers = section.layers.map((l) => (l.locked ? l : rerollLayer(l, mode, materials, section, rng)));
  return { ...section, layers, updatedAt: Date.now() };
}
