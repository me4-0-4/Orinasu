import type { Pcm } from "./pcm.ts";

/** マスターの仕上げ（コンプ＋リミッター）の設定。 */
export interface MasterBusOptions {
  /** コンプが効き始める大きさ（dB）。 */
  thresholdDb: number;
  /** 圧縮の比（3なら、しきい値を3dB超えた分は1dBになる）。 */
  ratio: number;
  /** しきい値まわりをなめらかにつなぐ幅（dB）。 */
  kneeDb: number;
  attackMs: number;
  releaseMs: number;
  /** コンプで下がった分を戻す音量（dB）。 */
  makeupDb: number;
  /** リミッターの上限（0〜1）。これを超えないようにする。 */
  ceiling: number;
  /** リミッターの先読み（ミリ秒）。 */
  lookaheadMs: number;
  limiterReleaseMs: number;
}

export const MASTER_BUS_DEFAULTS: MasterBusOptions = {
  thresholdDb: -18,
  ratio: 3,
  kneeDb: 8,
  attackMs: 12,
  releaseMs: 160,
  makeupDb: 5,
  ceiling: 0.95,
  lookaheadMs: 2,
  limiterReleaseMs: 90,
};

const toDb = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));
const fromDb = (db: number): number => Math.pow(10, db / 20);

/** 入力の大きさ（dB）に対する、コンプで下げる量（dB、0以下）。ニー（なめらかな折れ）つき。 */
export function compressorReductionDb(levelDb: number, o: Pick<MasterBusOptions, "thresholdDb" | "ratio" | "kneeDb">): number {
  const over = levelDb - o.thresholdDb;
  const slope = 1 / o.ratio - 1; // 0以下
  const half = o.kneeDb / 2;
  if (over <= -half) return 0;
  if (over >= half) return slope * over;
  const t = over + half;
  return (slope * t * t) / (2 * o.kneeDb);
}

/**
 * 曲全体の仕上げ。左右をそろえて動かすコンプ（大きい所を少し抑えて、全体を持ち上げる）→ 先読みリミッター
 * （上限を超えないように、先回りして滑らかに下げる）。元の波形は書き換えず、新しい波形を返す。
 * 無音のところは無音のまま。
 */
export function masterBus(pcm: Pcm, sampleRate: number, opts: Partial<MasterBusOptions> = {}): Pcm {
  const o = { ...MASTER_BUS_DEFAULTS, ...opts };
  const n = pcm.l.length;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  if (n === 0) return { l, r };

  // 1. コンプ：左右の大きい方を見て、同じだけ下げる（定位がずれないように）
  const atk = Math.exp(-1 / ((o.attackMs / 1000) * sampleRate));
  const rel = Math.exp(-1 / ((o.releaseMs / 1000) * sampleRate));
  const makeup = fromDb(o.makeupDb);
  let reduction = 0; // いま下げている量（dB、0以下）
  for (let i = 0; i < n; i++) {
    const target = compressorReductionDb(toDb(Math.max(Math.abs(pcm.l[i]), Math.abs(pcm.r[i]))), o);
    // 下げる方向は attack、戻る方向は release
    const k = target < reduction ? atk : rel;
    reduction = k * reduction + (1 - k) * target;
    const g = fromDb(reduction) * makeup;
    l[i] = pcm.l[i] * g;
    r[i] = pcm.r[i] * g;
  }

  // 2. リミッター：上限を超える所の必要な下げ幅を先読みし、前後になだらかに下げる
  const look = Math.max(1, Math.round((o.lookaheadMs / 1000) * sampleRate));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    need[i] = peak > o.ceiling ? o.ceiling / peak : 1;
  }
  // 先読みの最小値 M[i] = min(need[i .. i+look-1])（単調キューで一度に求める）
  const min = new Float32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[queue[tail - 1]] >= need[i]) tail--;
    queue[tail++] = i;
    while (queue[head] > i + look - 1) head++;
    min[i] = need[queue[head]];
  }
  // G[i] = M[i-look+1 .. i] の平均。どの i でも G[i] <= need[i]（上限を超えない）
  const relK = 1 - Math.exp(-1 / ((o.limiterReleaseMs / 1000) * sampleRate));
  let sum = 0;
  let prev = 1;
  for (let i = 0; i < n; i++) {
    sum += min[i];
    if (i >= look) sum -= min[i - look];
    const count = Math.min(i + 1, look);
    const avg = (sum + (look - count) * min[0]) / look; // 先頭より前は、最初の窓の値で埋める（先頭でも上限を守る）
    // 戻りはゆっくり（低音が歪まないように）。下がる所は平均のなだらかさに任せる
    const g = Math.min(avg, prev + (1 - prev) * relK);
    prev = g;
    l[i] *= g;
    r[i] *= g;
  }
  return { l, r };
}
