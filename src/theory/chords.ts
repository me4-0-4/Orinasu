import type { Note } from "../phrase/types.ts";
import { noteNamesFor, type Key } from "./key.ts";
import { createRng } from "./rng.ts";

export type ChordQuality = "maj" | "min" | "dim";

export interface Chord {
  root: number; // ピッチクラス 0-11
  quality: ChordQuality;
}

/** タイムライン上の1区間。locked なら振り直しでも変えない。 */
export interface ChordSlot extends Chord {
  startBeats: number;
  lengthBeats: number;
  locked: boolean;
}

const QUALITY_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
};

export function chordPitchClasses(chord: Chord): number[] {
  return QUALITY_INTERVALS[chord.quality].map((i) => (chord.root + i) % 12);
}

export function chordName(chord: Chord, key: Key): string {
  const name = noteNamesFor(key)[chord.root];
  return chord.quality === "maj" ? name : chord.quality === "min" ? `${name}m` : `${name}dim`;
}

export function fifthPitchClass(chord: Chord): number {
  return (chord.root + QUALITY_INTERVALS[chord.quality][2]) % 12;
}

interface DegreeChord extends Chord {
  degree: number; // 0-6（音階上の度数）
}

/** その調のダイアトニックコード（マイナーはVを長三和音にする）。 */
export function diatonicChords(key: Key): DegreeChord[] {
  const qualities: ChordQuality[] =
    key.mode === "major"
      ? ["maj", "min", "min", "maj", "maj", "min", "dim"]
      : ["min", "dim", "maj", "min", "maj", "maj", "maj"];
  const steps = key.mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return steps.map((s, degree) => ({
    root: (key.tonic + s) % 12,
    quality: qualities[degree],
    degree,
  }));
}

// 度数A→度数Bの「つながりの良さ」。よくある進行ほど高い。
const TRANSITION: number[][] = (() => {
  const t = Array.from({ length: 7 }, () => new Array<number>(7).fill(0));
  const set = (from: number, tos: [number, number][]) => {
    for (const [to, v] of tos) t[from][to] = v;
  };
  set(0, [[3, 1], [4, 1], [5, 1], [1, 0.6], [2, 0.4], [6, 0.2]]);
  set(1, [[4, 1.2], [6, 0.4], [3, 0.3]]);
  set(2, [[5, 1], [3, 0.8], [1, 0.4]]);
  set(3, [[4, 1], [0, 0.8], [1, 0.6], [5, 0.4]]);
  set(4, [[0, 1.2], [5, 0.9], [3, 0.4]]);
  set(5, [[3, 1], [1, 0.9], [4, 0.7], [2, 0.3]]);
  set(6, [[0, 1], [5, 0.3]]);
  return t;
})();

const SELF_PENALTY = -0.3;

export interface Segment {
  startBeats: number;
  lengthBeats: number;
}

/** フレーズの長さを、1小節ごと（perBar=1）または半小節ごと（perBar=2）の区間に切る。 */
export function makeSegments(
  lengthBars: number,
  beatsPerBar: number,
  perBar: 1 | 2,
): Segment[] {
  const segs: Segment[] = [];
  const len = beatsPerBar / perBar;
  for (let i = 0; i < lengthBars * perBar; i++) {
    segs.push({ startBeats: i * len, lengthBeats: len });
  }
  return segs;
}

/** 区間内のメロディが、そのコードにどれだけ合うか。 */
function emissionScore(
  chord: DegreeChord,
  seg: Segment,
  notes: Pick<Note, "pitch" | "startBeats" | "durationBeats">[],
  totalBeats: number,
): number {
  const tones = chordPitchClasses(chord);
  let score = 0;
  for (const n of notes) {
    const start = ((n.startBeats % totalBeats) + totalBeats) % totalBeats;
    const end = start + n.durationBeats;
    const overlap = Math.min(end, seg.startBeats + seg.lengthBeats) - Math.max(start, seg.startBeats);
    if (overlap <= 0) continue;
    const pc = ((n.pitch % 12) + 12) % 12;
    let w = 0;
    if (pc === tones[0]) w = 1.2;
    else if (tones.includes(pc)) w = 1;
    else w = -0.35;
    score += w * overlap;
  }
  // 区間の長さで正規化（拍数が違っても比較しやすくする）
  return (score / seg.lengthBeats) * 2.5;
}

function structureBonus(chord: DegreeChord, index: number, count: number): number {
  let b = 0;
  if (index === 0 && chord.degree === 0) b += 0.6;
  if (index === count - 1) {
    if (chord.degree === 0) b += 0.5;
    else if (chord.degree === 4) b += 0.3;
  }
  return b;
}

export interface SuggestOptions {
  key: Key;
  segments: Segment[];
  melody: Pick<Note, "pitch" | "startBeats" | "durationBeats">[];
  totalBeats: number;
  /** 固定するスロット（同じインデックスの区間は変えない）。 */
  locked?: (ChordSlot | null)[];
  /** 指定すると、上位候補からランダムに選ぶ（振り直し）。未指定は最良の進行を返す。 */
  seed?: number;
}

function toSlot(chord: DegreeChord, seg: Segment): ChordSlot {
  return {
    root: chord.root,
    quality: chord.quality,
    startBeats: seg.startBeats,
    lengthBeats: seg.lengthBeats,
    locked: false,
  };
}

/**
 * コード進行を提案する。seed なし → Viterbi法で最良の進行。seed あり → 各区間で
 * 点数に応じた重み付きランダムに選ぶ（毎回違う候補になる）。
 */
export function suggestProgression(opts: SuggestOptions): ChordSlot[] {
  const { key, segments, melody, totalBeats, locked = [], seed } = opts;
  const chords = diatonicChords(key);
  const n = segments.length;
  if (n === 0) return [];

  const emit = segments.map((seg, i) => {
    const fixed = locked[i];
    return chords.map((c) => {
      if (fixed) {
        // 固定区間は、その和音以外を選べないようにする
        const same = c.root === fixed.root && c.quality === fixed.quality;
        return same ? 0 : -1e6;
      }
      return emissionScore(c, seg, melody, totalBeats) + structureBonus(c, i, n);
    });
  });

  const trans = (a: number, b: number) => (a === b ? SELF_PENALTY : TRANSITION[a][b]);

  const result: ChordSlot[] = [];
  const pick = (i: number, idx: number) => {
    const fixed = locked[i];
    if (fixed) result[i] = { ...fixed, startBeats: segments[i].startBeats, lengthBeats: segments[i].lengthBeats };
    else result[i] = toSlot(chords[idx], segments[i]);
  };

  // 固定区間に含まれない和音（ダイアトニック外）は、emit 上は選択肢に無いので、後で上書きする
  if (seed === undefined) {
    const dp = Array.from({ length: n }, () => new Array<number>(7).fill(-Infinity));
    const back = Array.from({ length: n }, () => new Array<number>(7).fill(0));
    for (let c = 0; c < 7; c++) dp[0][c] = emit[0][c];
    for (let i = 1; i < n; i++) {
      for (let c = 0; c < 7; c++) {
        for (let p = 0; p < 7; p++) {
          const v = dp[i - 1][p] + trans(p, c) + emit[i][c];
          if (v > dp[i][c]) {
            dp[i][c] = v;
            back[i][c] = p;
          }
        }
      }
    }
    let best = 0;
    for (let c = 1; c < 7; c++) if (dp[n - 1][c] > dp[n - 1][best]) best = c;
    const path = new Array<number>(n);
    path[n - 1] = best;
    for (let i = n - 1; i > 0; i--) path[i - 1] = back[i][path[i]];
    for (let i = 0; i < n; i++) pick(i, path[i]);
  } else {
    const rng = createRng(seed);
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const fixed = locked[i];
      if (fixed) {
        pick(i, 0);
        prev = chords.findIndex((c) => c.root === fixed.root && c.quality === fixed.quality);
        continue;
      }
      const scores = chords.map((_, c) => emit[i][c] + (prev >= 0 ? trans(prev, c) : 0));
      const temperature = 0.9;
      const max = Math.max(...scores);
      const weights = scores.map((s) => Math.exp((s - max) / temperature));
      const sum = weights.reduce((a, b) => a + b, 0);
      let r = rng() * sum;
      let idx = 0;
      for (; idx < 6; idx++) {
        r -= weights[idx];
        if (r <= 0) break;
      }
      pick(i, idx);
      prev = idx;
    }
  }
  return result;
}

/** 1区間について、点数の高い順にコード候補を返す（「別の候補」ボタン用）。 */
export function rankChordsForSegment(
  key: Key,
  seg: Segment,
  melody: Pick<Note, "pitch" | "startBeats" | "durationBeats">[],
  totalBeats: number,
): Chord[] {
  return diatonicChords(key)
    .map((c) => ({ c, s: emissionScore(c, seg, melody, totalBeats) }))
    .sort((a, b) => b.s - a.s)
    .map(({ c }) => ({ root: c.root, quality: c.quality }));
}

/** 拍位置に対応するコード区間（なければ null）。 */
export function chordAt(slots: ChordSlot[], beats: number): { slot: ChordSlot; index: number } | null {
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (beats >= s.startBeats && beats < s.startBeats + s.lengthBeats) return { slot: s, index: i };
  }
  return null;
}
