/**
 * 曲を作り直すとき、前と同じ入力でできたトラックの波形を使い回すための入れ物。
 * 入力から作った名前（key）が同じなら、同じ結果として返す。古いものから捨てる（上限つき）。
 * 入れた波形は、あとから書き換えないこと（読むだけ）。
 */
export class BuildCache {
  private readonly map = new Map<string, unknown>();
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;

  private readonly max: number;

  /** max：覚えておく数。波形は1つ10MB前後（30秒・ステレオ）なので、多くしすぎない。 */
  constructor(max = 10) {
    this.max = max;
  }

  /** 波形などの「同じもの」を見分ける番号（中身ではなく、同じ物かどうか）。 */
  idOf(obj: object): number {
    let id = this.ids.get(obj);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(obj, id);
    }
    return id;
  }

  async getOrCompute<T>(key: string, make: () => Promise<T> | T): Promise<T> {
    if (this.map.has(key)) {
      const hit = this.map.get(key) as T;
      // 使ったものを新しい側へ
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const value = await make();
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    return value;
  }

  get size(): number {
    return this.map.size;
  }
}
