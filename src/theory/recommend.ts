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
    return "次のおすすめ：メロディ。「録音」を押して、鍵盤で弾いてください。";
  }
  if (!input.hasChords) {
    return "次のおすすめ：コード。右の「コード案を出す」で、構成音が鍵盤に光ります。";
  }
  if (!has("bass")) {
    return "次のおすすめ：ベース。レイヤーをベースにして、紫に光るルートの音を重ねてください。";
  }
  if (!has("drums")) {
    return "次のおすすめ：ドラム。「ドラム候補を置く」か、パッドを叩いて録音してください。";
  }
  if (!has("other") && !has("chords")) {
    return "次のおすすめ：飾り。アルペジエーターや別のレイヤーで、すき間に音を足してください。";
  }
  return "ひととおりそろいました。層のミュートや振り直しで整えられます。";
}
