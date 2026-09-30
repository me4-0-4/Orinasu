import { drumNoteNumbers } from "../audio/drums.ts";
import { makeId, type Note } from "../phrase/types.ts";
import { createRng } from "./rng.ts";

export type DrumGenre = "rock" | "pop" | "house" | "hiphop";
export type DrumPart = "kick" | "snare" | "hat" | "extra";

export const drumGenres: { id: DrumGenre; label: string }[] = [
  { id: "rock", label: "ロック（8ビート）" },
  { id: "pop", label: "ポップ（軽い16）" },
  { id: "house", label: "ハウス（4つ打ち）" },
  { id: "hiphop", label: "ヒップホップ" },
];

export const drumParts: { id: DrumPart; label: string }[] = [
  { id: "kick", label: "キック" },
  { id: "snare", label: "スネア" },
  { id: "hat", label: "ハット" },
  { id: "extra", label: "クラップ/タム" },
];

/** 部品ごとのドラムノート番号。 */
export const partPitches: Record<DrumPart, number[]> = {
  kick: [drumNoteNumbers.kick],
  snare: [drumNoteNumbers.snare],
  hat: [drumNoteNumbers.hat],
  extra: [drumNoteNumbers.clap, drumNoteNumbers.tom],
};

export function partOfPitch(pitch: number): DrumPart | null {
  for (const p of drumParts) if (partPitches[p.id].includes(pitch)) return p.id;
  return null;
}

// 4/4の1小節=16ステップ。"x"=必ず鳴らす、"o"=ときどき鳴らす（確率で）、"."=休み。
const BASE: Record<DrumGenre, Record<DrumPart, string>> = {
  rock: {
    kick: "x.......x.o.....",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    extra: "................",
  },
  pop: {
    kick: "x.....o.x.o.....",
    snare: "....x.......x..o",
    hat: "x.xox.xox.xox.xo",
    extra: "....o.......o...",
  },
  house: {
    kick: "x...x...x...x...",
    snare: "................",
    hat: "..x...x...x...x.",
    extra: "....x.......x...",
  },
  hiphop: {
    kick: "x.....o...x..o..",
    snare: "....x.......x...",
    hat: "x.x.x.xox.x.x.xo",
    extra: "................",
  },
};

// 4/4以外の拍子ではジャンルによらない素直な形にする。
function genericPattern(part: DrumPart, steps: number): string {
  const chars = new Array<string>(steps).fill(".");
  const beats = steps / 4;
  for (let b = 0; b < beats; b++) {
    const s = b * 4;
    if (part === "kick" && b === 0) chars[s] = "x";
    if (part === "snare" && b > 0 && b % 2 === 1) chars[s] = "x";
    if (part === "hat") {
      chars[s] = "x";
      chars[s + 2] = "x";
    }
  }
  return chars.join("");
}

export interface DrumGenOptions {
  genre: DrumGenre;
  lengthBars: number;
  beatsPerBar: number;
  seed: number;
}

/** 指定した部品1つ分のノートを作る。 */
export function generateDrumPart(part: DrumPart, opts: DrumGenOptions): Note[] {
  const { genre, lengthBars, beatsPerBar, seed } = opts;
  // 部品ごとに種を変えて、部品単位で振り直しても他の部品に影響しないようにする
  const rng = createRng(seed + partSalt[part]);
  const stepsPerBar = beatsPerBar * 4;
  const notes: Note[] = [];
  // フィルにするかは全部品で共通（部品ごとにバラバラだと片方だけ抜けてしまう）
  const doFill = createRng(seed ^ 0x9e3779b9)() < 0.5;

  for (let bar = 0; bar < lengthBars; bar++) {
    const pattern =
      beatsPerBar === 4 ? BASE[genre][part] : genericPattern(part, stepsPerBar);
    const isLastBar = bar === lengthBars - 1;

    for (let step = 0; step < stepsPerBar; step++) {
      const c = pattern[step];
      if (c === ".") continue;
      if (c === "o" && rng() > 0.45) continue;
      notes.push(makeDrumNote(part, c, step, bar, beatsPerBar, rng, genre));
    }

    // 最終小節の最後の1拍は、スネア/タムでフィルにすることがある（ハウスは無し）
    if (isLastBar && genre !== "house" && lengthBars >= 2 && doFill) {
      addFill(part, notes, bar, beatsPerBar, rng);
    }
  }
  return notes;
}

const partSalt: Record<DrumPart, number> = { kick: 11, snare: 23, hat: 37, extra: 53 };

function makeDrumNote(
  part: DrumPart,
  c: string,
  step: number,
  bar: number,
  beatsPerBar: number,
  rng: () => number,
  genre: DrumGenre,
): Note {
  const onBeat = step % 4 === 0;
  let velocity = onBeat ? 0.95 : 0.65;
  if (part === "hat") velocity = onBeat ? 0.8 : 0.5;
  if (c === "o") velocity *= 0.85;
  velocity = Math.min(1, Math.max(0.2, velocity + (rng() - 0.5) * 0.12));
  let pitch = partPitches[part][0];
  if (part === "extra") {
    // ハウス/ポップはクラップ、それ以外はタム
    pitch = genre === "house" || genre === "pop" ? drumNoteNumbers.clap : drumNoteNumbers.tom;
  }
  return {
    id: makeId("note"),
    pitch,
    velocity,
    startBeats: bar * beatsPerBar + step * 0.25,
    durationBeats: 0.1,
  };
}

function addFill(part: DrumPart, notes: Note[], bar: number, beatsPerBar: number, rng: () => number): void {
  // フィル区間（最後の1拍）は、いったん全部の部品を空にしてからスネア/タムで埋める
  const from = bar * beatsPerBar + beatsPerBar - 1;
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i].startBeats >= from) notes.splice(i, 1);
  }
  if (part === "kick" || part === "hat") return;
  const pitch = part === "snare" ? drumNoteNumbers.snare : drumNoteNumbers.tom;
  for (let i = 0; i < 4; i++) {
    if (part === "snare" && i % 2 === 1 && rng() < 0.5) continue;
    if (part === "extra" && i % 2 === 0) continue;
    notes.push({
      id: makeId("note"),
      pitch,
      velocity: 0.6 + i * 0.1,
      startBeats: from + i * 0.25,
      durationBeats: 0.1,
    });
  }
}
