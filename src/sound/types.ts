/** 読み込んだ音（サンプラー・刻む・曲に置く、の材料）。 */
export interface SoundMeta {
  id: string;
  name: string;
  /** 元のファイルの種類（audio/wav など）。 */
  mime: string;
  /** 元のファイルの大きさ（バイト）。クラウドの使用量の計算に使う。 */
  bytes: number;
  durationSec: number;
  channels: number;
  sampleRate: number;
  /** 波形の形（0〜1、PEAK_COUNT 個）。音を取り寄せる前でも絵が出せるように、情報と一緒に持つ。 */
  peaks: number[];
  /** テンポ。分からないときは未設定。 */
  bpm?: number;
  /** 1拍目（小節の頭）の位置（秒）。未設定は 0。 */
  downbeatSec?: number;
  /** 1小節の拍数。未設定は 4。 */
  beatsPerBar?: number;
  createdAt: number;
  updatedAt: number;
}

/** 端末の中の音。blob が無いのは、クラウドにはあるがまだ取り寄せていない音。 */
export interface StoredSound extends SoundMeta {
  blob?: Blob;
}

export const PEAK_COUNT = 400;
/** 1ファイルの上限（Supabase の無料プランの1ファイルの上限に合わせる）。 */
export const MAX_SOUND_BYTES = 50 * 1024 * 1024;
/** クラウドの置き場の大きさ（無料プラン）。 */
export const CLOUD_QUOTA_BYTES = 1024 * 1024 * 1024;
export const MIN_SOUND_BPM = 40;
export const MAX_SOUND_BPM = 300;

/** 波形の山（各区間の絶対値の最大、全チャンネル）。全体の最大で 0〜1 にそろえる。小数2桁。 */
export function computePeaks(channels: Float32Array[], count = PEAK_COUNT): number[] {
  const len = channels[0]?.length ?? 0;
  const out = new Array<number>(count).fill(0);
  if (len === 0) return out;
  for (let i = 0; i < count; i++) {
    const a = Math.floor((i * len) / count);
    const b = Math.max(a + 1, Math.floor(((i + 1) * len) / count));
    let m = 0;
    for (const ch of channels) {
      for (let j = a; j < b && j < len; j++) {
        const v = Math.abs(ch[j]);
        if (v > m) m = v;
      }
    }
    out[i] = m;
  }
  const max = Math.max(...out);
  return out.map((v) => (max > 0 ? Math.round((v / max) * 100) / 100 : 0));
}

/** 最初の音が鳴り始める位置（秒）。全体の最大の threshold 倍を超えた最初の所。無音なら 0。 */
export function firstSoundSec(channels: Float32Array[], sampleRate: number, threshold = 0.1): number {
  const len = channels[0]?.length ?? 0;
  let max = 0;
  for (const ch of channels) for (let i = 0; i < len; i++) max = Math.max(max, Math.abs(ch[i]));
  if (max === 0) return 0;
  const limit = max * threshold;
  for (let i = 0; i < len; i++) {
    for (const ch of channels) if (Math.abs(ch[i]) >= limit) return Math.round((i / sampleRate) * 1000) / 1000;
  }
  return 0;
}

/** 1拍目から終わりまでがちょうど bars 小節だとしたときのテンポ。 */
export function bpmFromBars(durationSec: number, downbeatSec: number, bars: number, beatsPerBar: number): number | null {
  const span = durationSec - downbeatSec;
  if (span <= 0 || bars <= 0 || beatsPerBar <= 0) return null;
  return clampBpm((bars * beatsPerBar * 60) / span);
}

/** 手で叩いた時刻（ms）から、テンポ。2回未満なら null。間が空きすぎた所（2秒以上）からやり直す。 */
export function bpmFromTaps(tapsMs: number[]): number | null {
  let from = 0;
  for (let i = 1; i < tapsMs.length; i++) {
    if (tapsMs[i] - tapsMs[i - 1] > 2000) from = i;
  }
  const taps = tapsMs.slice(from);
  if (taps.length < 2) return null;
  const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  if (avg <= 0) return null;
  return clampBpm(60000 / avg);
}

export function clampBpm(bpm: number): number {
  return Math.round(Math.min(MAX_SOUND_BPM, Math.max(MIN_SOUND_BPM, bpm)) * 100) / 100;
}

/** 拍の位置（秒）。1拍目より前にも、拍があれば並べる。bar＝小節の頭か。 */
export function beatGrid(meta: Pick<SoundMeta, "durationSec" | "bpm" | "downbeatSec" | "beatsPerBar">): { sec: number; bar: boolean }[] {
  if (!meta.bpm || meta.bpm <= 0) return [];
  const step = 60 / meta.bpm;
  const per = meta.beatsPerBar ?? 4;
  const start = meta.downbeatSec ?? 0;
  const first = -Math.floor(start / step);
  const out: { sec: number; bar: boolean }[] = [];
  for (let i = first; ; i++) {
    const sec = start + i * step;
    if (sec > meta.durationSec + 1e-9) break;
    if (sec < -1e-9) continue;
    out.push({ sec, bar: ((i % per) + per) % per === 0 });
    if (out.length > 4000) break;
  }
  return out;
}

/** 1拍目から終わりまでの小節数（テンポが分かるときだけ）。 */
export function barsOf(meta: Pick<SoundMeta, "durationSec" | "bpm" | "downbeatSec" | "beatsPerBar">): number | null {
  if (!meta.bpm) return null;
  return ((meta.durationSec - (meta.downbeatSec ?? 0)) * meta.bpm) / 60 / (meta.beatsPerBar ?? 4);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}分${String(s).padStart(2, "0")}秒`;
}

/** ファイル名から拡張子を取った名前。 */
export function soundNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, "").trim();
  return base || "無題の音";
}

/** クラウドから来たデータを、足りない所を補って使える形にする。壊れていたら null。 */
export function migrateSoundMeta(raw: unknown): SoundMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SoundMeta>;
  if (typeof r.id !== "string" || typeof r.durationSec !== "number") return null;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "無題の音",
    mime: typeof r.mime === "string" ? r.mime : "",
    bytes: typeof r.bytes === "number" ? r.bytes : 0,
    durationSec: r.durationSec,
    channels: typeof r.channels === "number" ? r.channels : 2,
    sampleRate: typeof r.sampleRate === "number" ? r.sampleRate : 44100,
    peaks: Array.isArray(r.peaks) ? r.peaks.filter((v): v is number => typeof v === "number") : [],
    bpm: typeof r.bpm === "number" ? r.bpm : undefined,
    downbeatSec: typeof r.downbeatSec === "number" ? r.downbeatSec : undefined,
    beatsPerBar: typeof r.beatsPerBar === "number" ? r.beatsPerBar : undefined,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

/** 端末の音から、クラウドの行に入れる情報（音の中身は除く）。 */
export function soundMetaOf(s: StoredSound): SoundMeta {
  const { blob: _blob, ...meta } = s;
  return meta;
}
