import type { LayerRole } from "../phrase/types.ts";

export interface RecommendInput {
  layers: { role: LayerRole; noteCount: number }[];
  hasChords: boolean;
}

/**
 * 「次に何を重ねるか」のゆるい案内。順番は メロディ→コード→ベース→ドラム→飾り。
 * まだ無いものの先頭を勧めるだけで、何も強制しない。
 */
export function nextRecommendation(input: RecommendInput): string {
  const has = (role: LayerRole) => input.layers.some((l) => l.role === role && l.noteCount > 0);

  if (!has("melody")) {
    return "次のおすすめ：まずメロディ。録音ボタンを押して、鍵盤で好きに弾いてみよう。";
  }
  if (!input.hasChords) {
    return "次のおすすめ：コード。「手助け」タブでコード案を出すと、光る鍵盤で構成音が分かる。";
  }
  if (!has("bass")) {
    return "次のおすすめ：ベース。レイヤーをベースにして、青く光るルートの音を弾いて重ねよう。";
  }
  if (!has("drums")) {
    return "次のおすすめ：ドラム。「ドラム候補」を置くか、パッドを叩いて録音しよう。";
  }
  if (!has("other") && !has("chords")) {
    return "次のおすすめ：飾り。アルペジエーターや別のレイヤーで、隙間に一音足してみよう。";
  }
  return "ひととおり揃った。気になる層をミュートしたり、振り直したりして遊んでみよう。";
}
