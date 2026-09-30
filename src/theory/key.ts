import type { Note } from "../phrase/types";

export type Mode = "major" | "minor";

export interface Key {
  tonic: number; // 0-11（C=0）
  mode: Mode;
}

export interface KeyCandidate extends Key {
  /** ピアソン相関（-1〜1）。大きいほどその調らしい。 */
  score: number;
}

// Krumhansl-Kessler のキープロファイル
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]; // ナチュラルマイナー

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const FLAT_MAJOR_TONICS = new Set([5, 10, 3, 8, 1, 6]); // F, Bb, Eb, Ab, Db, Gb

export function scaleIntervals(mode: Mode): number[] {
  return mode === "major" ? MAJOR_SCALE : MINOR_SCALE;
}

export function scalePitchClasses(key: Key): Set<number> {
  return new Set(scaleIntervals(key.mode).map((i) => (key.tonic + i) % 12));
}

/** フラット系の調ならフラット表記、それ以外はシャープ表記の音名表を返す。 */
export function noteNamesFor(key: Key): string[] {
  const relativeMajor = key.mode === "major" ? key.tonic : (key.tonic + 3) % 12;
  return FLAT_MAJOR_TONICS.has(relativeMajor) ? FLAT_NAMES : SHARP_NAMES;
}

export function keyName(key: Key): string {
  const name = noteNamesFor(key)[key.tonic];
  return key.mode === "major" ? `${name} メジャー` : `${name} マイナー`;
}

export function keyShortName(key: Key): string {
  const name = noteNamesFor(key)[key.tonic];
  return key.mode === "major" ? name : `${name}m`;
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - meanA;
    const y = b[i] - meanB;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** 音の長さで重みを付けたピッチクラスのヒストグラム。 */
export function pitchClassHistogram(notes: Pick<Note, "pitch" | "durationBeats">[]): number[] {
  const hist = new Array<number>(12).fill(0);
  for (const n of notes) {
    hist[((n.pitch % 12) + 12) % 12] += Math.max(n.durationBeats, 0.05);
  }
  return hist;
}

/**
 * Krumhansl-Schmuckler法で調を推定し、上位 limit 件を返す。
 * 材料が少なすぎる（異なる音が2種類未満）ときは空配列。
 */
export function detectKeys(
  notes: Pick<Note, "pitch" | "durationBeats">[],
  limit = 3,
): KeyCandidate[] {
  const hist = pitchClassHistogram(notes);
  if (hist.filter((v) => v > 0).length < 2) return [];

  const candidates: KeyCandidate[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = hist.map((_, i) => profile[(i - tonic + 12) % 12]);
      candidates.push({ tonic, mode, score: correlation(hist, rotated) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

export function sameKey(a: Key | null | undefined, b: Key | null | undefined): boolean {
  return !!a && !!b && a.tonic === b.tonic && a.mode === b.mode;
}

/**
 * スケールロック用：音がスケール外なら最も近いスケール内の音に寄せる（同距離なら下）。
 * 「押したのに鳴らない」を避けるため、消さずに寄せる。
 */
export function snapToScale(pitch: number, key: Key): number {
  const pcs = scalePitchClasses(key);
  for (let d = 0; d <= 6; d++) {
    if (pcs.has((((pitch - d) % 12) + 12) % 12)) return pitch - d;
    if (pcs.has((((pitch + d) % 12) + 12) % 12)) return pitch + d;
  }
  return pitch;
}
