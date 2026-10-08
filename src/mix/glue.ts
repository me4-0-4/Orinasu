import { drumNoteNumbers } from "../audio/drums.ts";
import { totalBeats, type Phrase } from "../phrase/types.ts";
import { stepPosition } from "./collage.ts";
import type { Pcm } from "./pcm.ts";
import { STEPS_PER_BEAT } from "./sequencer.ts";

/**
 * 刻んだ音を「曲」にまとめる仕上げ（つなぎ）。
 * - SFX：区切りを聞かせる（ライザー・インパクトとクラッシュ・リバースシンバル）
 * - 伸ばし：元の曲の和音を引き伸ばして、うしろでうっすら鳴らし続ける（断片の間をつなぐ）
 * - ポンピング：下地のキックに合わせて、刻んだ音を少し沈ませる（音どうしがくっついて聞こえる）
 */

type Rng = () => number;

const UNIT_BARS = 4;
const BLOCK_BARS = 8;

export interface Grid {
  totalSteps: number;
  stepsPerBar: number;
  stepSamples: number;
  sampleRate: number;
  swing?: number;
}

/** 0〜1 の白色雑音を -1〜1 にする。 */
const noise = (rng: Rng): number => rng() * 2 - 1;

/** 1次のローパス・ハイパスを、時間とともに変わる周波数で掛けるための係数。 */
const alphaOf = (fc: number, sr: number): number => 1 - Math.exp((-2 * Math.PI * Math.max(10, fc)) / sr);

/** 曲の位置 i（サンプル）に加える。曲の終わりを越えたら頭に回す（くり返してもつながる）。 */
function addAt(out: Pcm, i: number, l: number, r: number): void {
  const n = out.l.length;
  const j = ((i % n) + n) % n;
  out.l[j] += l;
  out.r[j] += r;
}

/**
 * SFX を、曲の区切りに重ねる。amount（0〜1）で音量。
 * - 8小節ごとの頭：インパクト（低い「ドン」）とクラッシュ（「シャーン」）。その前の1小節はライザー（雑音が上がっていく）
 * - 4小節ごとの頭（8小節の頭でない所）：その前の1拍にリバースシンバル（吸い込まれる）
 * 曲の頭のインパクトの前のライザーは、曲の終わりに置く（くり返したとき、終わりから頭へ盛り上がる）。
 */
export function addSfx(out: Pcm, grid: Grid, amount: number, rng: Rng): void {
  if (amount <= 0) return;
  const bars = Math.max(1, Math.round(grid.totalSteps / grid.stepsPerBar));
  const barSamples = grid.stepsPerBar * grid.stepSamples;
  const beatSamples = STEPS_PER_BEAT * grid.stepSamples;
  const sr = grid.sampleRate;
  const g = 0.5 * Math.min(1, amount);
  for (let b = 0; b < bars; b++) {
    const at = Math.round(b * barSamples);
    if (b % BLOCK_BARS === 0) {
      if (bars >= BLOCK_BARS) riser(out, at, Math.round(barSamples), g, sr, rng);
      impact(out, at, g, sr, rng);
    } else if (b % UNIT_BARS === 0) {
      reverseCymbal(out, at, Math.round(beatSamples), g, sr, rng);
    }
  }
}

/** ライザー：end の手前 len サンプルで、雑音のバンドが上がっていき、だんだん大きくなる。最後は左右に広がる。 */
function riser(out: Pcm, end: number, len: number, g: number, sr: number, rng: Rng): void {
  let lo = 0;
  let lo2 = 0;
  let phase = 0;
  for (let k = 0; k < len; k++) {
    const p = k / len;
    const fc = 300 * Math.pow(9000 / 300, p);
    const a = alphaOf(fc, sr);
    const x = noise(rng);
    lo += a * (x - lo);
    lo2 += a * 0.5 * (x - lo2);
    const band = lo - lo2; // ゆるいバンドパス
    phase += (2 * Math.PI * (200 * Math.pow(8, p))) / sr; // 上がっていく音程
    const v = (band * 0.8 + Math.sin(phase) * 0.15) * g * p * p;
    addAt(out, end - len + k, v, v);
  }
}

/** インパクト（低い音が下がりながら消える）とクラッシュ（明るい雑音が長く消える）。 */
function impact(out: Pcm, at: number, g: number, sr: number, rng: Rng): void {
  const boomLen = Math.round(0.9 * sr);
  let phase = 0;
  for (let k = 0; k < boomLen; k++) {
    const t = k / sr;
    phase += (2 * Math.PI * (35 + 45 * Math.exp(-t * 12))) / sr;
    const env = Math.min(1, k / (0.002 * sr)) * Math.exp(-t * 4.5);
    const v = Math.sin(phase) * env * g * 1.1;
    addAt(out, at + k, v, v);
  }
  const crashLen = Math.round(1.8 * sr);
  let lpL = 0;
  let lpR = 0;
  const a = alphaOf(4000, sr);
  for (let k = 0; k < crashLen; k++) {
    const t = k / sr;
    const env = Math.min(1, k / (0.001 * sr)) * Math.exp(-t * 2.2);
    const xl = noise(rng);
    const xr = noise(rng);
    lpL += a * (xl - lpL);
    lpR += a * (xr - lpR);
    addAt(out, at + k, (xl - lpL) * env * g * 0.45, (xr - lpR) * env * g * 0.45); // ハイパス：明るい所だけ
  }
}

/** リバースシンバル：end に向かって、明るい雑音がふくらんで、ぴたっと止まる。 */
function reverseCymbal(out: Pcm, end: number, len: number, g: number, sr: number, rng: Rng): void {
  let lpL = 0;
  let lpR = 0;
  const a = alphaOf(3500, sr);
  for (let k = 0; k < len; k++) {
    const p = k / len;
    const env = Math.pow(p, 2.5) * Math.min(1, (len - k) / (0.004 * sr));
    const xl = noise(rng);
    const xr = noise(rng);
    lpL += a * (xl - lpL);
    lpR += a * (xr - lpR);
    addAt(out, end - len + k, (xl - lpL) * env * g * 0.5, (xr - lpR) * env * g * 0.5);
  }
}

/** 伸ばしの素材：1つの曲の波形と、その元の小節数、調をそろえる半音。 */
export interface PadSource {
  pcm: Pcm;
  srcBars: number;
  keyShift: number;
}

/**
 * 伸ばしの層：b 小節目では、元の曲の (b % 元の小節数) 小節目の音を、短い粒（120ms）にして、
 * 小節の中の偶然の位置から取り出して重ね続ける（和音が引き伸ばされて、うっすら鳴り続ける）。
 * 太鼓の音がにじまないよう、低すぎる所と高すぎる所を削る。どの曲を使うかは、4小節ごとに偶然で決める。
 */
export function renderPad(sources: PadSource[], grid: Grid, amount: number, rng: Rng): Pcm {
  const total = Math.max(1, Math.round(grid.totalSteps * grid.stepSamples));
  const out: Pcm = { l: new Float32Array(total), r: new Float32Array(total) };
  if (amount <= 0 || sources.length === 0) return out;
  const sr = grid.sampleRate;
  const grain = Math.max(16, Math.round(0.12 * sr));
  const hop = Math.max(1, Math.round(grain / 4));
  const barSamples = grid.stepsPerBar * grid.stepSamples;
  const units = Math.ceil(total / (barSamples * UNIT_BARS));
  const pick = Array.from({ length: units }, () => Math.min(sources.length - 1, Math.floor(rng() * sources.length)));
  const window = Float32Array.from({ length: grain }, (_, k) => 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / grain));
  const gain = (0.7 * Math.min(1, amount)) / 2; // ハン窓4枚重ねで約2倍になるぶんを戻す
  for (let at = -grain; at < total; at += hop) {
    const center = Math.max(0, at + grain / 2);
    const bar = Math.floor(center / barSamples);
    const src = sources[pick[Math.min(units - 1, Math.floor(bar / UNIT_BARS))]];
    const ratio = Math.pow(2, src.keyShift / 12);
    const sb = bar % Math.max(1, src.srcBars);
    const from = Math.round(sb * barSamples);
    const to = Math.min(src.pcm.l.length, Math.round((sb + 1) * barSamples));
    const span = to - from - Math.ceil(grain * ratio) - 2;
    if (span <= 0) continue;
    const start = from + Math.floor(rng() * span);
    const pan = (rng() - 0.5) * 0.6; // 粒ごとに少し左右に散らす（広がり）
    for (let k = 0; k < grain; k++) {
      const i = at + k;
      if (i < 0 || i >= total) continue;
      const x = start + k * ratio;
      const i0 = Math.floor(x);
      const f = x - i0;
      const w = window[k] * gain;
      out.l[i] += (src.pcm.l[i0] * (1 - f) + src.pcm.l[i0 + 1] * f) * w * (1 - pan);
      out.r[i] += (src.pcm.r[i0] * (1 - f) + src.pcm.r[i0 + 1] * f) * w * (1 + pan);
    }
  }
  // 低い所（キックのにじみ）と高い所（ハットのにじみ）を削って、和音だけ残す
  bandLimit(out, 180, 1800, sr);
  return out;
}

/** 1次のハイパスとローパスを2回ずつ掛ける（ゆるいバンドパス）。 */
function bandLimit(pcm: Pcm, low: number, high: number, sr: number): void {
  const ah = alphaOf(low, sr);
  const al = alphaOf(high, sr);
  for (const ch of [pcm.l, pcm.r]) {
    for (let pass = 0; pass < 2; pass++) {
      let hp = 0;
      let lp = 0;
      for (let i = 0; i < ch.length; i++) {
        hp += ah * (ch[i] - hp);
        const x = ch[i] - hp;
        lp += al * (x - lp);
        ch[i] = lp;
      }
    }
  }
}

/** 下地の曲で、キックを打つ所（ステップ）。曲の長さぶん、くり返す。 */
export function kickSteps(phrase: Phrase, totalSteps: number): number[] {
  const loop = Math.max(1, Math.round(totalBeats(phrase) * STEPS_PER_BEAT));
  const steps = new Set<number>();
  for (const l of phrase.layers) {
    if (l.role !== "drums" || l.muted) continue;
    for (const n of l.notes) {
      if (n.pitch === drumNoteNumbers.kick) steps.add(((Math.round(n.startBeats * STEPS_PER_BEAT) % loop) + loop) % loop);
    }
  }
  const out: number[] = [];
  for (let base = 0; base < totalSteps; base += loop) {
    for (const s of [...steps].sort((a, b) => a - b)) if (base + s < totalSteps) out.push(base + s);
  }
  return out;
}

/** 4つ打ち（下地にキックが無いとき、ポンピングの拍子に使う）。 */
export function fourOnFloor(totalSteps: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < totalSteps; s += STEPS_PER_BEAT) out.push(s);
  return out;
}

/**
 * ポンピング：キックのたびに音量をすっと下げて、すぐ戻す（amount 0〜1。1で約6割まで沈む）。
 * 戻りは8分音符くらい。下げ始めはごく短くなめらかにして、プチ音を出さない。曲の終わりから頭へもつながる。
 */
export function pump(pcm: Pcm, kicks: number[], grid: Grid, amount: number): void {
  if (amount <= 0 || kicks.length === 0) return;
  const n = pcm.l.length;
  const depth = 0.6 * Math.min(1, amount);
  const release = 2 * grid.stepSamples; // 8分音符
  const attack = Math.max(1, Math.round(0.004 * grid.sampleRate));
  const env = new Float32Array(n).fill(1);
  const positions = kicks.map((s) => stepPosition(s, grid.stepSamples, grid.swing));
  for (let j = 0; j < positions.length; j++) {
    const at = positions[j];
    const next = j + 1 < positions.length ? positions[j + 1] : positions[0] + n;
    for (let k = -attack; k < next - at; k++) {
      const duck = k < 0 ? depth * ((k + attack) / attack) : depth * Math.exp(-k / (release / 3));
      const i = (((at + k) % n) + n) % n;
      env[i] = Math.min(env[i], 1 - duck);
    }
  }
  for (let i = 0; i < n; i++) {
    pcm.l[i] *= env[i];
    pcm.r[i] *= env[i];
  }
}
