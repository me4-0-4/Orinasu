import { detectKeys, type Key } from "../theory/key.ts";
import type { Phrase } from "../phrase/types.ts";

/** フレーズの調：手動指定があればそれ、なければドラム以外の音から判定。分からなければnull。 */
export function phraseKey(phrase: Phrase): Key | null {
  if (phrase.keyOverride) return phrase.keyOverride;
  const notes = phrase.layers.filter((l) => l.role !== "drums").flatMap((l) => l.notes);
  return detectKeys(notes, 1)[0] ?? null;
}

/** from の調の音を、to の調に寄せるための半音数（-5〜+6で一番近い向き）。 */
export function transposeSemitones(from: Key, to: Key): number {
  const d = (((to.tonic - from.tonic) % 12) + 12) % 12;
  return d > 6 ? d - 12 : d;
}
