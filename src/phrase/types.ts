import type { Key } from "../theory/key";
import type { ChordSlot } from "../theory/chords";

export type LayerRole = "melody" | "bass" | "drums" | "chords" | "other";

export interface Note {
  id: string;
  pitch: number; // MIDIノート番号。ドラム層ではGM準拠のドラムノート番号を流用する。
  velocity: number; // 0-1
  startBeats: number; // フレーズ先頭からの拍数（弾いたままの生タイミング、常に保持）
  durationBeats: number;
}

export interface Layer {
  id: string;
  role: LayerRole;
  notes: Note[];
  muted: boolean;
  solo: boolean;
  /** 「合わせる」の適用先グリッド（拍単位）。undefinedなら未適用（生のまま）。非破壊。 */
  quantizeGrid?: number;
  /** アプリが自動で置いた候補（ドラム候補）の層。振り直しの対象はこの層だけで、自分で録音した層は触らない。 */
  generated?: boolean;
}

export interface Phrase {
  id: string;
  name: string;
  lengthBars: 1 | 2 | 4;
  bpm: number;
  beatsPerBar: number;
  layers: Layer[];
  /** 手動で選んだ調。未設定なら、メロディから自動判定した調を使う。 */
  keyOverride?: Key;
  /** スケールロック（選んだ調の音しか鳴らさない）。 */
  scaleLock?: boolean;
  /** 提示されたコード進行（音は置かない。名前と、鍵盤の光り方の元になるだけ）。 */
  chords?: ChordSlot[];
  createdAt: number;
  updatedAt: number;
}

export function totalBeats(phrase: Pick<Phrase, "lengthBars" | "beatsPerBar">): number {
  return phrase.lengthBars * phrase.beatsPerBar;
}

let idCounter = 0;
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function createEmptyLayer(role: LayerRole): Layer {
  return { id: makeId("layer"), role, notes: [], muted: false, solo: false };
}

export function createEmptyPhrase(lengthBars: 1 | 2 | 4, bpm: number, beatsPerBar = 4): Phrase {
  const now = Date.now();
  return {
    id: makeId("phrase"),
    name: "無題のフレーズ",
    lengthBars,
    bpm,
    beatsPerBar,
    layers: [],
    createdAt: now,
    updatedAt: now,
  };
}

export const roleLabels: Record<LayerRole, string> = {
  melody: "メロディ",
  bass: "ベース",
  drums: "ドラム",
  chords: "コード",
  other: "その他",
};
