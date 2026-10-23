/**
 * マスターの仕上げ（コンプ＋リミッター）を、ブロックごとに流せる形にしたもの。
 * 書き出し（曲全体をまとめて処理）も、再生中のリアルタイム処理（AudioWorklet）も、同じこの計算を使う。
 * このファイルは何も import しない（AudioWorklet の中でそのまま動くように）。
 */

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

const DB_PER_NEPER = 20 / Math.LN10;
const toDb = (x: number): number => DB_PER_NEPER * Math.log(Math.max(x, 1e-9));
const fromDb = (db: number): number => Math.exp(db / DB_PER_NEPER);

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

/** 足し算の誤差がたまらないよう、これだけのサンプルごとに、平均の合計を数え直す。 */
const RESYNC = 4096;

/**
 * 左右をそろえて動かすコンプ（大きい所を少し抑えて、全体を持ち上げる）→ 先読みリミッター
 * （上限を超えないように、先回りして滑らかに下げる）。
 * process() に、好きな長さずつ流せる（どこで区切っても、結果は同じ）。出力は入力より latency サンプルだけ遅れる（先読みのぶん）。
 * 最初の latency サンプルは無音が出る。
 */
export class MasterBusStream {
  /** 出力が入力より遅れるサンプル数。 */
  readonly latency: number;

  private readonly o: MasterBusOptions;
  private readonly atk: number;
  private readonly rel: number;
  private readonly makeup: number;
  private readonly look: number;
  private readonly relK: number;
  private readonly quiet: number;

  // コンプ
  private reduction = 0;

  // リミッター：先読みの最小値（単調キュー）、その平均、音声の遅らせ用
  private readonly qIndex: Float64Array;
  private readonly qValue: Float32Array;
  private qHead = 0;
  private qTail = 0;
  private readonly ring: Float64Array;
  private ringPos = 0;
  private sum = 0;
  private started = false;
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private prevGain = 1;
  /** 受け取ったサンプルの数（0から）。 */
  private count = 0;

  constructor(sampleRate: number, opts: Partial<MasterBusOptions> = {}) {
    const o = { ...MASTER_BUS_DEFAULTS, ...opts };
    this.o = o;
    this.atk = Math.exp(-1 / ((o.attackMs / 1000) * sampleRate));
    this.rel = Math.exp(-1 / ((o.releaseMs / 1000) * sampleRate));
    // これより小さい音は、コンプが掛からない（対数を取らずに済ませる）
    this.quiet = fromDb(o.thresholdDb - o.kneeDb / 2);
    this.makeup = fromDb(o.makeupDb);
    this.look = Math.max(1, Math.round((o.lookaheadMs / 1000) * sampleRate));
    this.relK = 1 - Math.exp(-1 / ((o.limiterReleaseMs / 1000) * sampleRate));
    this.latency = this.look - 1;
    this.qIndex = new Float64Array(this.look + 1);
    this.qValue = new Float32Array(this.look + 1);
    this.ring = new Float64Array(this.look);
    this.delayL = new Float32Array(this.look);
    this.delayR = new Float32Array(this.look);
  }

  /** inL/inR を処理して、outL/outR に書く。in と out は同じ配列でもよい。 */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const n = inL.length;
    const o = this.o;
    for (let i = 0; i < n; i++) {
      const xl = inL[i];
      const xr = inR[i];
      // 1. コンプ：左右の大きい方を見て、同じだけ下げる（定位がずれないように）。小さい音は対数を取らない
      const peak = Math.max(Math.abs(xl), Math.abs(xr));
      const target = peak > this.quiet ? compressorReductionDb(toDb(peak), o) : 0;
      // 下げる方向は attack、戻る方向は release
      const k = target < this.reduction ? this.atk : this.rel;
      this.reduction = k * this.reduction + (1 - k) * target;
      const gain = this.reduction > -1e-9 ? this.makeup : fromDb(this.reduction) * this.makeup;
      // 2. リミッター（Float32 に丸めた値で。書き出しの形と同じ）
      this.limit(Math.fround(xl * gain), Math.fround(xr * gain), outL, outR, i);
    }
  }

  /** リミッターに1サンプル通す（コンプのあとの値）。先読みのぶん遅れた音を、outL/outR の at 番目に書く。 */
  private limit(l: number, r: number, outL: Float32Array, outR: Float32Array, at: number): void {
    const look = this.look;
    const j = this.count++;
    const pos = j % look;
    this.delayL[pos] = l;
    this.delayR[pos] = r;
    // 必要な下げ幅 need[j]。上限を超える所だけ
    const peak = Math.max(Math.abs(l), Math.abs(r));
    const need = peak > this.o.ceiling ? this.o.ceiling / peak : 1;
    // 直近 look 個の最小値 M[j-look+1]（単調キュー）
    const cap = this.look + 1;
    while (this.qTail > this.qHead && this.qValue[(this.qTail - 1) % cap] >= need) this.qTail--;
    this.qIndex[this.qTail % cap] = j;
    this.qValue[this.qTail % cap] = need;
    this.qTail++;
    while (this.qIndex[this.qHead % cap] < j - look + 1) this.qHead++;
    if (j < look - 1) {
      // 最初の look-1 サンプルは、まだ先読みがそろっていない（遅れのぶん無音）
      outL[at] = 0;
      outR[at] = 0;
      return;
    }
    const m = this.qValue[this.qHead % cap];
    if (!this.started) {
      // 先頭より前は、最初の窓の値で埋める（先頭でも上限を守る）
      this.ring.fill(m);
      this.sum = m * look;
      this.started = true;
    }
    // G = M の直近 look 個の平均。どの出力でも G <= need（上限を超えない）
    this.sum += m - this.ring[this.ringPos];
    this.ring[this.ringPos] = m;
    this.ringPos = (this.ringPos + 1) % look;
    if (j % RESYNC === 0) {
      let t = 0;
      for (let k = 0; k < look; k++) t += this.ring[k];
      this.sum = t;
    }
    const avg = this.sum / look;
    // 戻りはゆっくり（低音が歪まないように）。下がる所は平均のなだらかさに任せる
    const g = Math.min(avg, this.prevGain + (1 - this.prevGain) * this.relK);
    this.prevGain = g;
    // 出力するのは、look-1 サンプル前の音
    const outPos = (j + 1) % look;
    outL[at] = this.delayL[outPos] * g;
    outR[at] = this.delayR[outPos] * g;
  }
}
