import { loudAt, specAt, type Analysis } from "./analysis.ts";
import type { Feat } from "./features.ts";
import type { Timeline, VEvent } from "./timeline.ts";

// 映像のパネル。試作（Artifact）で作った描画を、そのまま移したもの。
// 描画は Canvas 2D。座標は書き出しの大きさ（1080×1920 など）の画素で、u は短い辺の 1/100。

export interface Rect { x: number; y: number; w: number; h: number }
export interface Colors { bg: string; panel: string; ink: string; line: string; a1: string; a2: string }
export interface Palette extends Colors { dim: string }
export interface PanelDef {
  ja: string;
  en: string;
  /** 選ぶときの分け方（音・拍・響き・文字・その他）。 */
  g?: string;
  /** はじめから LED にするパネル。 */
  led?: boolean;
  draw(ctx: CanvasRenderingContext2D, c: Rect, f: Feat, P: Palette, u: number, lf: { id: number }): void;
}
type Img = HTMLCanvasElement | HTMLImageElement;

/** パネルの描画が読む、その時々の値。描く前に映像の側で入れる。 */
export const rt = {
  lang: "ja" as "ja" | "en",
  /** 前のコマからの秒数（粒の動きに使う）。止まっていれば0。 */
  frameDt: 0,
  playing: false,
  /** 粒など、パネルごとに持ち越す状態（パネルの id で引く）。 */
  parts: {} as Record<number, any>,
  sy: {} as Record<number, number>,
  /** 素材パネルの画像（パネルの id で引く）。 */
  imgs: new Map<number, Img>(),
  song: { name: "", key: "", keyJa: "", bars: 16 },
};

export const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const nn = (p: number): string => NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
/** 決まった値を返す疑似乱数（同じ入力なら同じ値）。 */
export const noise = (i: number, k: number): number => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
export function mulberry(a: number): () => number { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

let events: VEvent[] = [], tonal: VEvent[] = [], chops: VEvent[] = [], kicks: VEvent[] = [];
let PITCHES: number[] = [60], STEPS = 64, BPM = 120, SONG_SEC = 32;
let TRACKS = [{ ja: "刻む1", en: "CH 1" }, { ja: "刻む2", en: "CH 2" }, { ja: "ドラム", en: "DRUM" }, { ja: "パッド", en: "PAD" }];
let an: Analysis | null = null;
/** 描く曲を入れ替える。 */
export function bindTimeline(tl: Timeline, analysis: Analysis): void {
  events = tl.events; tonal = tl.tonal; chops = tl.chops; kicks = tl.kicks;
  PITCHES = tl.pitches.length ? tl.pitches : [60];
  STEPS = tl.totalSteps; BPM = tl.bpm; SONG_SEC = tl.seconds; an = analysis;
  TOT = [0, 1, 2, 3].map((t) => Math.max(1e-6, events.filter((e) => e.tr === t).reduce((a, e) => a + e.len * e.vel, 0)));
  // トラックの名前（刻む曲の名前）。表の欄に収まるよう、長いものは切る
  const short = (s: string): string => ([...s].length > 5 ? [...s].slice(0, 4).join("") + "…" : s);
  const nm = (i: number, ja: string, en: string) => ({ ja: tl.laneNames[i] ? short(tl.laneNames[i]) : ja, en: tl.laneNames[i] ? short(tl.laneNames[i]) : en });
  TRACKS = [nm(0, "刻む1", "CH 1"), nm(1, "刻む2", "CH 2"), { ja: "ドラム", en: "DRUM" }, { ja: "パッド", en: "PAD" }];
}
const loudAtS = (S: number): number => (an ? loudAt(an, S) : 0);
/**
 * 前のコマ（prev）から今（S）までに、位置 s を通り過ぎたか。
 * 曲の終わりから頭に戻った（くり返し）ときは通ったとみなす。巻き戻し（■・位置のバー）や大きな飛ばしは、通っていないことにする。
 */
export function passed(prev: number, S: number, s: number): boolean {
  if (S >= prev) return S - prev < 8 && s > prev && s <= S;
  // 頭に戻ったのは、終わりの近くから頭の近くへ来たときだけ（それ以外の後戻りは巻き戻し）
  return prev > STEPS - 8 && S < 8 && (s > prev || s <= S);
}
/** 短い線をたくさん引く：色と濃さ（4段）ごとにまとめて、1回で描く。 */
function strokeBatched(ctx: CanvasRenderingContext2D, segs: { x1: number; y1: number; x2: number; y2: number; col: string; a: number }[]): void {
  const groups = new Map<string, number[]>();
  for (const s of segs) {
    const key = `${s.col}|${Math.max(1, Math.min(4, Math.ceil(s.a * 4)))}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(s.x1, s.y1, s.x2, s.y2);
  }
  for (const [key, g] of groups) {
    const [col, lv] = key.split("|");
    ctx.strokeStyle = col;
    ctx.globalAlpha = Number(lv) / 4;
    ctx.beginPath();
    for (let i = 0; i < g.length; i += 4) {
      ctx.moveTo(g[i], g[i + 1]);
      ctx.lineTo(g[i + 2], g[i + 3]);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
const specAtS = (S: number): number[] => (an ? specAt(an, S) : new Array(40).fill(0));

export const PRESETS = {
  shuden: { name: "終電", bg: "#07080a", panel: "#0f1115", ink: "#ede6d6", line: "#1f232a", a1: "#ffb000", a2: "#ff6b7a" },
  sumi: { name: "墨", bg: "#0d0d0f", panel: "#151517", ink: "#f3f1ec", line: "#2a2a2d", a1: "#e23b2e", a2: "#ff6b7a" },
  gofun: { name: "胡粉", bg: "#f3f1ec", panel: "#fbfaf7", ink: "#0d0d0f", line: "#d6d2c8", a1: "#e23b2e", a2: "#2740a8" },
  warabanshi: { name: "藁半紙", bg: "#efebdd", panel: "#f6f3e8", ink: "#16151a", line: "#d3cdb8", a1: "#2740a8", a2: "#ff6b7a" },
};
export const COLOR_KEYS = [["bg", "地"], ["panel", "パネル"], ["ink", "文字"], ["line", "細い線"], ["a1", "差し色1"], ["a2", "差し色2"]];
export function hex2rgb(h: string): number[] { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
export function mix(a: string, b: string, t: number): string { const A = hex2rgb(a), B = hex2rgb(b); return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join(""); }
export const isDark = (hex: string): boolean => { const [r, g, b] = hex2rgb(hex); return r * .3 + g * .59 + b * .11 < 128; };
export function palette(c: Colors): Palette { return Object.assign({}, c, { dim: mix(c.ink, c.bg, .5) }); }
export const trackColor = (P: Palette, tr: number): string => tr === 0 ? P.a1 : tr === 1 ? P.a2 : tr === 2 ? P.ink : P.dim;
export const MONO = '"IBM Plex Mono", monospace', SANS = '"IBM Plex Sans JP", sans-serif', DOT = '"DotGothic16", monospace', MIN = '"Zen Old Mincho", serif';
export const fmtT = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const WA = ["ハ", "嬰ハ", "ニ", "嬰ニ", "ホ", "ヘ", "嬰ヘ", "ト", "嬰ト", "イ", "嬰イ", "ロ"];
export const pname = (p: number): string => rt.lang === "ja" ? WA[p % 12] : NAMES[p % 12];
export const pfull = (p: number): string => pname(p) + (Math.floor(p / 12) - 1);
export function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
export function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void { ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2); }
function shuttle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, col: string): void { ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.quadraticCurveTo(x, y - h, x + w / 2, y); ctx.quadraticCurveTo(x, y + h, x - w / 2, y); ctx.fillStyle = col; ctx.fill(); }
let TOT = [1, 1, 1, 1];
export const wrapS = (s: number, S: number): number => s - S > STEPS / 2 ? s - STEPS : S - s > STEPS / 2 ? s + STEPS : s;
let phCache: { key: string; cv: HTMLCanvasElement | null } = { key: "", cv: null };
export function placeholder(P: Palette): HTMLCanvasElement {
  const key = P.a1 + P.a2 + P.ink + P.bg;
  if (phCache.key === key && phCache.cv) return phCache.cv;
  const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
  const g = cv.getContext("2d")!; g.fillStyle = P.bg; g.fillRect(0, 0, 640, 480);
  for (let i = 0; i < 16; i++) { g.globalAlpha = .45; g.fillStyle = i % 3 ? P.a1 : P.a2; g.fillRect(i * 40, 0, 20, 480); g.fillRect(0, i * 30, 640, 15); }
  g.globalAlpha = 1; g.fillStyle = P.ink; g.font = `900 64px ${MIN}`; g.textAlign = "center"; g.fillText("素材", 320, 262);
  phCache = { key, cv }; return cv;
}
// 7セグ
const SEG: Record<string, number> = { "0": 0x3F, "1": 0x06, "2": 0x5B, "3": 0x4F, "4": 0x66, "5": 0x6D, "6": 0x7D, "7": 0x07, "8": 0x7F, "9": 0x6F, "-": 0x40, " ": 0 };
export function seg7(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, h: number, on: string, off: string): number {
  const w = h * .52, t = h * .11; let cx = x;
  for (const ch of str) {
    if (ch === "." || ch === ":") { ctx.fillStyle = on; if (ch === ":") { ctx.fillRect(cx, y + h * .28, t, t); ctx.fillRect(cx, y + h * .66, t, t); } else ctx.fillRect(cx, y + h - t, t, t); cx += t * 2.6; continue; }
    const m = SEG[ch] ?? 0, hh = (h - t * 3) / 2;
    const segs = [[t, 0, w - 2 * t, t], [w - t, t, t, hh], [w - t, t * 2 + hh, t, hh], [t, h - t, w - 2 * t, t], [0, t * 2 + hh, t, hh], [0, t, t, hh], [t, t + hh, w - 2 * t, t]];
    segs.forEach((s, i) => { ctx.fillStyle = m >> i & 1 ? on : off; ctx.fillRect(cx + s[0] + t * .1, y + s[1] + t * .1, s[2] - t * .2, s[3] - t * .2); });
    cx += w + t * 1.6;
  }
  return cx - x;
}
export function brush(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, width: number, prog: number, seed: number, col: string): void { // 筆の一画
  const N = 48, top: [number, number][] = [], bot: [number, number][] = [];
  for (let i = 0; i <= N * prog; i++) {
    const t = i / N, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * width * .6;
    const wv = width * Math.pow(Math.sin(Math.min(1, t * 1.15 + .06) * Math.PI), .55) * (.75 + .5 * noise(i, seed));
    top.push([x, y - wv / 2 + (noise(i, seed + 1) - .5) * width * .12]); bot.push([x, y + wv / 2 + (noise(i, seed + 2) - .5) * width * .12]);
  }
  if (top.length < 2) return;
  ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(...top[0]); top.forEach(p => ctx.lineTo(...p)); bot.reverse().forEach(p => ctx.lineTo(...p)); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = width * .03; // かすれ
  for (let k = 0; k < 6; k++) { const off = (noise(k, seed + 3) - .5) * width * 1.1; ctx.globalAlpha *= .9; ctx.beginPath(); top.forEach((p, i) => { if (noise(i, seed + k * 7) > .35) ctx.lineTo(p[0], p[1] + width / 2 + off); else ctx.moveTo(p[0], p[1] + width / 2 + off); }); ctx.stroke(); }
}

// ---------- パネル（音・拍・響き・文字） ----------
export const PANELS: Record<string, PanelDef> = {
  score: { ja: "譜", en: "SCORE", g: "音", draw(ctx, c, f, P, u) {
      const lo = 36, hi = 84, rowH = c.h / (hi - lo), W = 32, S = f.S, sw = c.w / W, X = (s: number) => c.x + c.w / 2 + (s - S) * sw;
      ctx.font = `${u * .9}px ${DOT}`;
      for (let p = lo; p < hi; p++) if (p % 12 === 0) { const y = c.y + (hi - p) * rowH; ctx.fillStyle = P.line; ctx.fillRect(c.x, y, c.w, u * .08); ctx.fillStyle = P.dim; ctx.fillText(pfull(p), c.x, y - u * .3); }
      for (const e of tonal) {
        const s0 = wrapS(e.s, S); if (s0 + e.len < S - W / 2 || s0 > S + W / 2) continue;
        const y = c.y + (hi - e.p - 1) * rowH, hh = Math.max(rowH * .8, u * .35);
        for (let k = 0; k < e.len; k++) {
          const s = s0 + k, past = s + 1 <= S, on = s <= S && S < s + 1;
          ctx.fillStyle = trackColor(P, e.tr); ctx.globalAlpha = on ? 1 : past ? .7 : .22;
          ctx.fillRect(X(s) + sw * .08, y, sw * .84, hh);
        }
      }
      ctx.globalAlpha = .14; ctx.fillStyle = P.a1; ctx.fillRect(c.x + c.w / 2 - sw / 2, c.y, sw, c.h); ctx.globalAlpha = 1;
      ctx.fillStyle = P.a1; ctx.fillRect(c.x + c.w / 2 - u * .06, c.y, u * .12, c.h);
      ctx.fillStyle = P.ink; for (const e of kicks) { const s = wrapS(e.s, S); if (Math.abs(s - S) < W / 2) { ctx.globalAlpha = s <= S ? .9 : .3; ctx.fillRect(X(s), c.y + c.h - u * .5, sw * .7, u * .5); } }
      ctx.globalAlpha = 1;
    } },

  field: { ja: "定位", en: "FIELD", g: "響き", draw(ctx, c, f, P, u) {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2, R = Math.min(c.w, c.h) * .44;
      ctx.strokeStyle = P.line; ctx.lineWidth = u * .08;
      ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx + R, cy); ctx.lineTo(cx, cy + R); ctx.lineTo(cx - R, cy); ctx.closePath(); ctx.stroke();
      line(ctx, cx - R, cy, cx + R, cy); line(ctx, cx, cy - R, cx, cy + R);
      for (let k = 1; k < 4; k++) { const r = R * k / 4; ctx.strokeRect(cx - r * .02, cy - r, r * .04, r * 2); }
      ctx.fillStyle = P.dim; ctx.font = `${u * 1}px ${DOT}`; ctx.fillText(rt.lang === "ja" ? "左" : "L", cx - R * .62, cy - R * .5); ctx.fillText(rt.lang === "ja" ? "右" : "R", cx + R * .5, cy - R * .5);
      const src = f.active.length ? f.active : [{ p: 57, vel: .1, s: 0, tr: 3 }];
      for (let n = 0; n < 380; n++) {
        const t = n / 380 * Math.PI * 6 + f.S * .7; let L = 0, Rr = 0;
        src.forEach((a, i) => { const pan = Math.sin(a.s * 1.7 + i) * .8, v = Math.sin(t * (1 + (a.p % 12) / 6) + i * 1.3) * a.vel; L += v * (1 - pan) / 2; Rr += v * (1 + pan) / 2; });
        L += (noise(n, Math.floor(f.S * 4)) - .5) * f.hat * .6; Rr += (noise(n + 99, Math.floor(f.S * 4)) - .5) * f.hat * .6;
        const k = R * .9 * (.4 + f.loud), x = (L - Rr) * .71 * k, y = -(L + Rr) * .71 * k;
        ctx.fillStyle = n % 7 ? P.a1 : P.a2; ctx.globalAlpha = .7; ctx.fillRect(cx + x, cy + y, u * .25, u * .25);
      }
      ctx.globalAlpha = 1;
    } },

  dial: { ja: "時計", en: "DIAL", g: "拍", draw(ctx, c, f, P, u) {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2, R = Math.min(c.w, c.h) * .44, b0 = f.bar * 16, gapA = .045;
      for (let i = 0; i < 16; i++) {
        const a0 = -Math.PI / 2 + i / 16 * Math.PI * 2 + gapA, a1 = a0 + Math.PI * 2 / 16 - gapA * 2;
        const ev = chops.find(e => e.s === b0 + i), passed = b0 + i <= f.S, cur = i === f.step;
        ctx.strokeStyle = ev && passed ? trackColor(P, ev.tr) : cur ? P.ink : P.line; ctx.lineWidth = R * .16;
        ctx.globalAlpha = ev && !passed ? .45 : 1; ctx.beginPath(); ctx.arc(cx, cy, R * .9, a0, a1); ctx.stroke();
      }
      for (let b = 0; b < 4; b++) { const a0 = -Math.PI / 2 + b / 4 * Math.PI * 2 + gapA, a1 = a0 + Math.PI / 2 - gapA * 2; ctx.strokeStyle = b <= f.beat ? P.a1 : P.line; ctx.globalAlpha = 1; ctx.lineWidth = R * .06; ctx.beginPath(); ctx.arc(cx, cy, R * .7, a0, a1); ctx.stroke(); }
      ctx.fillStyle = P.ink; ctx.font = `${R * .5}px ${DOT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(f.bar + 1).padStart(2, "0"), cx, cy - R * .04);
      ctx.fillStyle = P.dim; ctx.font = `${Math.max(u * .9, R * .12)}px ${SANS}`; ctx.fillText(rt.lang === "ja" ? "小節" : "BAR", cx, cy + R * .34); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    } },

  sky: { ja: "星座", en: "SKY", g: "音", draw(ctx, c, f, P, u) {
      const pos = (p: number): [number, number] => [c.x + c.w * (.08 + .84 * (p % 12) / 11), c.y + c.h * (.88 - .76 * (Math.floor(p / 12) - 2) / 4) + (noise(p, 4) - .5) * c.h * .1];
      const w: Record<number, number> = {}; let mx = 1e-6;
      for (const e of tonal) { if (e.s > f.S) break; w[e.p] = (w[e.p] || 0) + Math.min(e.len, f.S - e.s); mx = Math.max(mx, w[e.p]); }
      const hist = chops.filter(e => e.s <= f.S).slice(-10);
      ctx.lineWidth = u * .15; ctx.lineJoin = "miter";
      for (let i = 1; i < hist.length; i++) { // 基板の配線のように直角に曲げる
        const [x1, y1] = pos(hist[i - 1].p), [x2, y2] = pos(hist[i].p);
        ctx.strokeStyle = trackColor(P, hist[i].tr); ctx.globalAlpha = i / hist.length;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1, (y1 + y2) / 2); ctx.lineTo(x2, (y1 + y2) / 2); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const p of PITCHES) { const [x, y] = pos(p), s = u * (.5 + 1.8 * Math.sqrt((w[p] || 0) / mx)); ctx.fillStyle = P.dim; ctx.globalAlpha = .6; ctx.fillRect(x - s / 2, y - s / 2, s, s); }
      ctx.globalAlpha = 1; ctx.font = `${u * 1.1}px ${DOT}`;
      for (const a of f.active) { const [x, y] = pos(a.p), s = u * 1.6; ctx.fillStyle = trackColor(P, a.tr); ctx.fillRect(x - s / 2, y - s / 2, s, s); ctx.fillText(pname(a.p), x + s, y - s * .4); }
    } },

  gauge: { ja: "計器", en: "GAUGE", g: "響き", draw(ctx, c, f, P, u) {
      const segs = 24, colW = Math.min(c.w * .1, u * 3), gap = u * .3, sh = (c.h - gap * (segs - 1)) / segs;
      [f.loud, Math.min(1, f.loud * (.92 + .16 * noise(Math.floor(f.S * 2), 3)))].forEach((v, k) => {
        const x = c.x + k * (colW + u * .6), lit = Math.round(v * segs);
        for (let i = 0; i < segs; i++) { const y = c.y + c.h - (i + 1) * sh - i * gap; ctx.fillStyle = i < lit ? (i >= segs - 3 ? P.a2 : i >= segs - 8 ? P.a1 : P.ink) : P.line; ctx.fillRect(x, y, colW, sh); }
      });
      const x0 = c.x + colW * 2 + u * 2.4, bw = (c.x + c.w - x0) / f.spec.length, rows = 14, rh = c.h / rows;
      f.spec.forEach((v, i) => { const lit = Math.round(v * rows); for (let r = 0; r < rows; r++) { ctx.fillStyle = r < lit ? (i < 8 ? P.ink : P.a1) : P.line; ctx.globalAlpha = r < lit ? 1 : .6; ctx.fillRect(x0 + i * bw + bw * .12, c.y + c.h - (r + 1) * rh + rh * .12, bw * .76, rh * .76); } });
      ctx.globalAlpha = 1;
    } },

  lattice: { ja: "格子", en: "LATTICE", g: "拍", draw(ctx, c, f, P, u) {
      const lab = u * 4.5, cs = Math.min((c.w - lab) / 16, c.h / 4.4), b0 = f.bar * 16, ox = c.x + lab, oy = c.y + (c.h - cs * 4) / 2;
      ctx.fillStyle = P.ink; ctx.fillRect(ox + f.step * cs, oy - u * .4, cs, cs * 4 + u * .8);
      for (let tr = 0; tr < 4; tr++) {
        ctx.fillStyle = P.dim; ctx.font = `${u * .95}px ${DOT}`; ctx.fillText(TRACKS[tr][rt.lang], c.x, oy + cs * tr + cs * .65);
        for (let s = 0; s < 16; s++) { ctx.fillStyle = s === f.step ? mix(P.ink, P.bg, .3) : P.line; ctx.fillRect(ox + s * cs + cs * .1, oy + tr * cs + cs * .1, cs * .8, cs * .8); }
      }
      for (const e of events) {
        if (e.s < b0 || e.s >= b0 + 16) continue;
        const s = e.s - b0, past = e.s <= f.S, x = ox + s * cs, y = oy + e.tr * cs;
        ctx.fillStyle = trackColor(P, e.tr); ctx.globalAlpha = past ? 1 : .3;
        if (e.fill) { ctx.strokeStyle = trackColor(P, e.tr); ctx.lineWidth = cs * .12; line(ctx, x + cs * .2, y + cs * .2, x + cs * .8, y + cs * .8); line(ctx, x + cs * .8, y + cs * .2, x + cs * .2, y + cs * .8); }
        else ctx.fillRect(x + cs * .1, y + cs * .1, cs * .8, cs * .8);
      }
      ctx.globalAlpha = 1;
    } },

  sample: { ja: "標本", en: "SAMPLE", g: "音", draw(ctx, c, f, P, u) {
      const e = f.lastChop, prog = Math.min(1, (f.S - e.s) / e.len), N = 220, cyc = 5 + (e.p - 40) / 2.5, ww = c.w * .78, cy = c.y + c.h * .45, amp = c.h * .34 * e.vel;
      ctx.save(); ctx.beginPath(); ctx.rect(c.x, c.y, ww * prog, c.h); ctx.clip(); ctx.strokeStyle = P.line; ctx.lineWidth = u * .1;
      for (let k = -c.h; k < ww; k += u * .9) line(ctx, c.x + k, c.y + c.h, c.x + k + c.h, c.y); ctx.restore();
      ctx.beginPath();
      for (let i = 0; i <= N; i++) { const t = i / N, env = Math.min(1, t * 12) * Math.exp(-t * 2.2), v = Math.sin(t * cyc * Math.PI * 2) * .8 + (noise(i, e.s) - .5) * .5; const x = c.x + t * ww, y = cy - v * env * amp; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = trackColor(P, e.tr); ctx.lineWidth = u * .18; ctx.stroke();
      const ry = c.y + c.h - u * 1.2; ctx.strokeStyle = P.dim; ctx.lineWidth = u * .08; line(ctx, c.x, ry, c.x + ww, ry);
      for (let k = 0; k <= 40; k++) { const x = c.x + ww * k / 40; line(ctx, x, ry, x, ry - u * (k % 10 === 0 ? 1 : k % 5 === 0 ? .6 : .3)); }
      const fs = Math.min(c.w * .18, c.h / (pname(e.p).length + .4)); ctx.fillStyle = P.ink; ctx.font = `900 ${fs}px ${MIN}`; ctx.textAlign = "center";
      [...pname(e.p)].forEach((ch, i) => ctx.fillText(ch, c.x + c.w - fs * .55, c.y + fs * (i + .95))); ctx.textAlign = "left";
    } },

  ember: { ja: "火の粉", en: "EMBER", g: "響き", draw(ctx, c, f, P, u, lf) {
      const st = rt.parts[lf.id] || (rt.parts[lf.id] = { list: [], prevS: f.S }), dt = rt.frameDt;
      if (rt.playing && dt > 0) {
        let burst = 0; for (const k of kicks) if (passed(st.prevS, f.S, k.s)) burst += 90;
        burst += Math.round(f.loud * 5);
        for (let i = 0; i < burst && st.list.length < 1600; i++) st.list.push({ x: .5 + (Math.random() - .5) * .5, y: 1, vx: (Math.random() - .5) * .35, vy: -(.6 + Math.random() * .9) * (.6 + f.kick * .7), life: 1, split: Math.random() < .04 });
        const add = [];
        for (const p of st.list) {
          p.vy += .8 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * .6;
          if (p.split && p.vy > -.05) { p.split = false; for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2; add.push({ x: p.x, y: p.y, vx: Math.cos(a) * .18, vy: Math.sin(a) * .18, life: .5, split: false }); } }
        }
        st.list = st.list.concat(add).filter((p: { life: number; y: number }) => p.life > 0 && p.y < 1.05);
      }
      st.prevS = f.S; ctx.lineWidth = u * .18;
      strokeBatched(ctx, st.list.map((p: { x: number; y: number; vx: number; vy: number; life: number }) => {
        const x = c.x + p.x * c.w, y = c.y + p.y * c.h;
        return { x1: x, y1: y, x2: x - p.vx * c.w * .03, y2: y - p.vy * c.h * .03, col: p.life > .6 ? P.a1 : P.a2, a: Math.min(1, p.life * 1.4) };
      })); ctx.fillStyle = P.a1; ctx.fillRect(c.x + c.w * .22, c.y + c.h - u * .3, c.w * .56, u * .3);
    } },

  spectrum: { ja: "帯域", en: "SPECTRUM", g: "響き", draw(ctx, c, f, P, u, lf) {
      const st = rt.parts[lf.id] || (rt.parts[lf.id] = { peak: new Array(40).fill(0) }), n = f.spec.length, h = c.h - u * 1.8, bw = c.w / n;
      ctx.strokeStyle = P.line; ctx.lineWidth = u * .06; for (let i = 1; i < 4; i++) line(ctx, c.x, c.y + h * i / 4, c.x + c.w, c.y + h * i / 4);
      f.spec.forEach((v, i) => {
        st.peak[i] = Math.max(v, st.peak[i] - rt.frameDt * .35); // ピークは少し残して、ゆっくり落とす
        const x = c.x + i * bw, bh = v * h;
        ctx.fillStyle = i < 8 ? P.a2 : P.a1; ctx.fillRect(x + bw * .15, c.y + h - bh, bw * .7, bh);
        ctx.fillStyle = P.ink; ctx.fillRect(x + bw * .15, c.y + h - st.peak[i] * h - u * .3, bw * .7, u * .3);
      });
      ctx.fillStyle = P.dim; ctx.font = `${u * .9}px ${DOT}`;
      ([["50", 0], ["200", .25], ["1k", .5], ["5k", .75], ["16k", .93]] as [string, number][]).forEach(([t, p]) => ctx.fillText(t, c.x + c.w * p, c.y + c.h - u * .2));
    } },

  ridge: { ja: "山並み", en: "RIDGE", g: "響き", draw(ctx, c, f, P, u) {
      const L = 18, gap = c.h / (L + 4), skew = c.w * .012;
      for (let k = L - 1; k >= 0; k--) { // 奥（古い）から手前（新しい）へ
        const sp = specAtS(f.S - k), base = c.y + c.h - gap * .5 - k * gap, x0 = c.x + k * skew, w = c.w - L * skew;
        ctx.beginPath(); ctx.moveTo(x0, base);
        sp.forEach((v, i) => ctx.lineTo(x0 + w * i / (sp.length - 1), base - v * gap * 3.2));
        ctx.lineTo(x0 + w, base); ctx.closePath();
        ctx.fillStyle = P.panel; ctx.globalAlpha = 1; ctx.fill();
        ctx.strokeStyle = k === 0 ? P.a1 : P.ink; ctx.globalAlpha = k === 0 ? 1 : .85 - k / L * .65; ctx.lineWidth = u * (k === 0 ? .22 : .12); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } },

  waterfall: { ja: "滝", en: "WATERFALL", g: "響き", draw(ctx, c, f, P, u) {
      const C = 64, cw = c.w / C, rh = c.h / 40;
      for (let j = 0; j < C; j++) {
        const sp = specAtS(f.S - (C - 1 - j) * .5);
        for (let i = 0; i < 40; i++) { const v = sp[i]; if (v < .18) continue; ctx.fillStyle = v > .78 ? P.ink : v > .48 ? P.a1 : P.a2; ctx.globalAlpha = .15 + .85 * (v - .18) / .82; ctx.fillRect(c.x + j * cw, c.y + c.h - (i + 1) * rh, cw + .5, rh + .5); }
      }
      ctx.globalAlpha = 1; ctx.fillStyle = P.ink; ctx.fillRect(c.x + c.w - u * .15, c.y, u * .15, c.h);
    } },

  radial: { ja: "放射", en: "RADIAL", g: "響き", draw(ctx, c, f, P, u) {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2, R = Math.min(c.w, c.h) * .2 * (1 + f.kick * .12), M = Math.min(c.w, c.h) * .27, n = f.spec.length;
      ctx.lineWidth = Math.max(u * .2, Math.PI * R / n * .7);
      for (const side of [-1, 1]) f.spec.forEach((v, i) => {
        const a = -Math.PI / 2 + side * (i + .5) / n * Math.PI, r2 = R + u * .5 + v * M;
        ctx.strokeStyle = i < 8 ? P.a2 : P.a1; ctx.globalAlpha = .4 + .6 * v;
        line(ctx, cx + Math.cos(a) * R, cy + Math.sin(a) * R, cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      });
      ctx.globalAlpha = 1; ctx.strokeStyle = P.ink; ctx.lineWidth = u * .15; circle(ctx, cx, cy, R * .9); ctx.stroke();
      ctx.fillStyle = P.ink; ctx.font = `${R * .7}px ${DOT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(f.beat + 1), cx, cy);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    } },

  hanabi: { ja: "花火", en: "FIREWORK", g: "響き", draw(ctx, c, f, P, u, lf) {
      const st = rt.parts[lf.id] || (rt.parts[lf.id] = { bursts: [], sparks: [], prevS: f.S, n: 0 }), dt = rt.frameDt;
      const cols = [P.a1, P.a2, P.ink, mix(P.a1, P.a2, .5), "#8fe3cf"];
      if (rt.playing && dt > 0) {
        let opened = 0;
        for (const e of events) {
          if (opened >= 3) break; // 1コマで開くのは3つまで
          if (!passed(st.prevS, f.S, e.s) || !(e.kind === "kick" || (e.tr < 2 && noise(e.s, 93) < .25))) continue;
          opened++;
          const id = st.n++, bx = .15 + .7 * noise(id, 94), by = .15 + .5 * noise(id, 95), col = cols[id % cols.length], big = e.kind === "kick";
          st.bursts.push({ id, x: bx, y: by, t: 0, col });
          const n = big ? 50 : 20;
          for (let k = 0; k < n; k++) { const a = Math.random() * Math.PI * 2, sp = (big ? .32 : .2) * (.4 + Math.random() * .6); st.sparks.push({ b: id, x: bx, y: by, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1 + Math.random() * .8, col: Math.random() < .2 ? P.ink : col }); }
        }
        for (const p of st.sparks) { p.vx *= .985; p.vy = p.vy * .985 + .12 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * .55; }
        st.sparks = st.sparks.filter((p: { life: number }) => p.life > 0).slice(-900);
        st.bursts.forEach((b: { t: number }) => (b.t += dt)); st.bursts = st.bursts.filter((b: { t: number }) => b.t < 2.4);
      }
      st.prevS = f.S;
      // 開いた所の光（大きな半透明の丸を重ねると重いので、小さな芯だけ）
      for (const b of st.bursts) { if (b.t > .5) continue; ctx.fillStyle = b.col; ctx.globalAlpha = .9 * (1 - b.t / .5); circle(ctx, c.x + b.x * c.w, c.y + b.y * c.h, u * (.6 + b.t * 2)); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.lineWidth = u * .16;
      strokeBatched(ctx, st.sparks.map((p: { x: number; y: number; vx: number; vy: number; life: number; col: string }) => {
        const x = c.x + p.x * c.w, y = c.y + p.y * c.h;
        return { x1: x, y1: y, x2: x - p.vx * c.w * .08, y2: y - p.vy * c.h * .08, col: p.col, a: Math.min(1, p.life) };
      }));
    } },

  ticker: { ja: "電光", en: "TICKER", g: "文字", led: true, draw(ctx, c, f, P, u) {
      const notes = f.active.filter(a => a.tr < 2).map(a => pname(a.p)).join(" ") || "・";
      const txt = rt.lang === "ja" ? `${rt.song.name}　第${f.bar + 1}小節　${notes}　${BPM}BPM　${rt.song.keyJa}　　` : `${rt.song.name}  BAR ${f.bar + 1}  ${notes}  ${BPM}BPM  ${rt.song.key}    `;
      const fs = Math.min(c.h * .62, u * 9); ctx.font = `${fs}px ${DOT}`; const tw = ctx.measureText(txt).width;
      let x = c.x - ((f.S * u * 1.6) % tw); ctx.fillStyle = P.a1; ctx.textBaseline = "middle";
      while (x < c.x + c.w) { ctx.fillText(txt, x, c.y + c.h / 2); x += tw; }
      ctx.textBaseline = "alphabetic";
    } },

  board: { ja: "発車標", en: "BOARD", g: "文字", draw(ctx, c, f, P, u) {
      const ja = rt.lang === "ja", rows = 5, rh = c.h / rows, fs = Math.min(rh * .55, u * 2.4), cols = [0, .3, .62, .82];
      const head = ja ? ["種別", "行先", "あと", "状態"] : ["LINE", "NEXT", "IN", "NOW"];
      ctx.font = `${fs * .8}px ${DOT}`; ctx.fillStyle = P.dim; head.forEach((h, i) => ctx.fillText(h, c.x + c.w * cols[i], c.y + rh * .65));
      for (let t = 0; t < 4; t++) {
        const y = c.y + rh * (t + 1), next = events.find(e => e.tr === t && e.s > f.S) || events.find(e => e.tr === t);
        if (!next) continue;
        const wait = Math.round(((next.s - f.S) + STEPS) % STEPS);
        const now = events.some(e => e.tr === t && e.s <= f.S && f.S < e.s + Math.max(1, e.len) && f.S - e.s < 16);
        ctx.fillStyle = P.line; ctx.fillRect(c.x, y, c.w, u * .08);
        ctx.font = `${fs}px ${DOT}`; ctx.fillStyle = trackColor(P, t); ctx.fillText(TRACKS[t][rt.lang], c.x + c.w * cols[0], y + rh * .68);
        ctx.fillStyle = P.ink; ctx.fillText(next.kind ? (ja ? { kick: "鼓", snare: "締", hat: "鈴" }[next.kind] : next.kind.toUpperCase()) : pfull(next.p), c.x + c.w * cols[1], y + rh * .68);
        ctx.fillStyle = P.a1; ctx.fillText(String(wait).padStart(2, "0"), c.x + c.w * cols[2], y + rh * .68);
        ctx.fillStyle = now ? P.a2 : P.line; ctx.fillText(now ? (ja ? "発車" : "ON") : (ja ? "待機" : "--"), c.x + c.w * cols[3], y + rh * .68);
      }
    } },

  seven: { ja: "七セグ", en: "7SEG", g: "文字", draw(ctx, c, f, P, u) {
      const t = f.S / STEPS * SONG_SEC, lines = [String(BPM), `${String(f.bar + 1).padStart(2, "0")}.${f.beat + 1}`, `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`];
      const labs = rt.lang === "ja" ? ["速さ", "小節", "時間"] : ["BPM", "BAR", "TIME"];
      const tall = c.h > c.w * .7, n = tall ? 3 : 3, off = mix(P.line, P.bg, .2);
      if (tall) { const h = Math.min(c.h / 3 - u * 2.4, c.w / 3.6); lines.forEach((s, i) => { const y = c.y + i * (c.h / 3); ctx.fillStyle = P.dim; ctx.font = `${u * 1}px ${SANS}`; ctx.fillText(labs[i], c.x, y + u * 1.1); seg7(ctx, s.padStart(4, " "), c.x, y + u * 1.8, h, i === 1 ? P.a1 : P.ink, off); }); }
      else { const cw = c.w / n, h = Math.min(c.h - u * 2.4, cw / 3.4); lines.forEach((s, i) => { const x = c.x + i * cw; ctx.fillStyle = P.dim; ctx.font = `${u * 1}px ${SANS}`; ctx.fillText(labs[i], x, c.y + u * 1.1); seg7(ctx, s.padStart(4, " "), x, c.y + u * 1.8, h, i === 1 ? P.a1 : P.ink, off); }); }
    } },

  phosphor: { ja: "残光", en: "PHOSPHOR", g: "響き", draw(ctx, c, f, P, u) {
      ctx.strokeStyle = P.line; ctx.lineWidth = u * .07; ctx.setLineDash([u * .2, u * .5]);
      for (let i = 1; i < 10; i++) line(ctx, c.x + c.w * i / 10, c.y, c.x + c.w * i / 10, c.y + c.h);
      for (let i = 1; i < 6; i++) line(ctx, c.x, c.y + c.h * i / 6, c.x + c.w, c.y + c.h * i / 6);
      ctx.setLineDash([]);
      const src = f.active.length ? f.active : [{ p: 45, vel: .05, s: 0 }];
      for (let k = 6; k >= 0; k--) {
        const S = f.S - k * .12, A = loudAtS(S);
        ctx.strokeStyle = k ? P.a1 : P.ink; ctx.globalAlpha = k ? .5 * (1 - k / 7) : 1; ctx.lineWidth = u * (k ? .14 : .2); ctx.beginPath();
        for (let i = 0; i <= 120; i++) { const t = i / 120; let v = 0; src.forEach((a, j) => v += Math.sin(t * Math.PI * 2 * (2 + (a.p % 12) / 3) + S * 3 + j) * a.vel); const x = c.x + t * c.w, y = c.y + c.h / 2 - v / Math.max(1, src.length) * c.h * .42 * (.4 + A); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
      }
      ctx.globalAlpha = .12; ctx.fillStyle = P.bg; for (let y = c.y; y < c.y + c.h; y += u * .5) ctx.fillRect(c.x, y, c.w, u * .18); ctx.globalAlpha = 1;
    } },

  stamp: { ja: "判子", en: "STAMP", g: "拍", draw(ctx, c, f, P) {
      const KAN = ["打", "刻", "鳴", "響", "織", "返", "破", "急", "爆", "音"], blk = Math.floor(f.S / 128) * 128;
      const list = chops.filter(e => e.s >= blk && e.s <= f.S).slice(-40), sz0 = Math.min(c.w, c.h) * .2;
      list.forEach((e, i) => {
        const idx = chops.indexOf(e), x = c.x + c.w * (.12 + .76 * noise(idx, 21)), y = c.y + c.h * (.14 + .72 * noise(idx, 22)), age = f.S - e.s;
        const sz = sz0 * (.6 + .6 * e.vel) * (age < 1 ? 1.3 - .3 * age : 1), rot = (noise(idx, 23) - .5) * .6;
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = Math.max(.25, 1 - (list.length - 1 - i) / list.length * .8);
        ctx.strokeStyle = e.tr ? P.a2 : P.a1; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = sz * .09; ctx.setLineDash([sz * (.5 + noise(idx, 24)), sz * .05]);
        ctx.strokeRect(-sz / 2, -sz / 2, sz, sz); ctx.setLineDash([]);
        ctx.font = `900 ${sz * .62}px ${MIN}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(KAN[e.p % KAN.length], 0, sz * .04);
        ctx.restore();
      });
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.globalAlpha = 1;
    } },

  ink: { ja: "墨", en: "INK", g: "響き", draw(ctx, c, f, P) {
      const b0 = f.bar * 16, R = Math.min(c.w, c.h);
      for (const e of events) {
        if (e.s < b0 || e.s > f.S || (e.kind !== "kick" && e.kind !== "snare")) continue;
        const age = f.S - e.s, cx = c.x + c.w * (.15 + .7 * noise(e.s, 31)), cy = c.y + c.h * (.15 + .7 * noise(e.s, 32));
        const r = R * (e.kind === "kick" ? .16 : .08) * (1 - Math.exp(-age * 2.5)) * (1 + age * .03);
        ctx.fillStyle = e.kind === "kick" ? P.ink : P.a1; ctx.globalAlpha = .9; ctx.beginPath();
        for (let k = 0; k <= 28; k++) { const a = k / 28 * Math.PI * 2, rr = r * (.75 + .5 * noise(k, e.s)); k ? ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) : ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
        ctx.fill();
        for (let k = 0; k < 8; k++) { const a = noise(k, e.s + 5) * Math.PI * 2, d = r * (1.2 + noise(k, e.s + 6)); circle(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * .06 * noise(k, e.s + 7)); ctx.fill(); }
      }
      if (f.bar % 4 === 3 && f.step >= 8) { ctx.globalAlpha = .95; brush(ctx, c.x + c.w * .05, c.y + c.h * .55, c.x + c.w * .95, c.y + c.h * .4, R * .14, Math.min(1, (f.S % 16 - 8) / 3), f.bar, P.ink); }
      ctx.globalAlpha = 1;
    } },
};
Object.assign(PANELS, {
  threads: { ja: "糸譜", en: "THREADS", draw(ctx, c, f, P, u, lf) {
      const lo = 36, hi = 84, rowH = c.h / (hi - lo), W = 32, S = f.S, X = (s: number) => c.x + c.w / 2 + (s - S) / W * c.w;
      ctx.strokeStyle = P.line; ctx.lineWidth = u * .08;
      for (let b = Math.ceil((S - W / 2) / 4) * 4; b < S + W / 2; b += 4) { ctx.globalAlpha = b % 16 === 0 ? .9 : .35; line(ctx, X(b), c.y, X(b), c.y + c.h); }
      ctx.globalAlpha = 1; ctx.lineCap = "round"; let topY = null;
      for (const e of tonal) {
        let s = e.s; if (s - S > STEPS / 2) s -= STEPS; if (S - s > STEPS / 2) s += STEPS;
        if (s + e.len < S - W / 2 || s > S + W / 2) continue;
        const on = s <= S && S < s + e.len, y = c.y + (hi - e.p - .5) * rowH;
        ctx.strokeStyle = trackColor(P, e.tr); ctx.lineWidth = Math.max(u * .2, rowH * .55 * (.5 + e.vel * .5));
        ctx.globalAlpha = on ? 1 : s < S ? .6 : .45; ctx.setLineDash(s > S ? [u * .7, u * .6] : []); // まだ鳴っていない音は仮縫い
        line(ctx, X(s) + u * .3, y, X(s + e.len) - u * .3, y);
        if (on && e.tr < 2 && (topY === null || y < topY)) topY = y;
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineCap = "butt";
      const px = c.x + c.w / 2; ctx.strokeStyle = P.ink; ctx.lineWidth = u * .1; line(ctx, px, c.y, px, c.y + c.h);
      const prev = rt.sy[lf.id] == null ? c.y + c.h / 2 : rt.sy[lf.id]; rt.sy[lf.id] = topY === null ? prev : prev + (topY - prev) * .3;
      shuttle(ctx, px, rt.sy[lf.id], u * 3.4, u * 1.1, P.ink);
    } },

  weave: { ja: "織り", en: "WEAVE", draw(ctx, c, f, P, u) {
      const N = Math.max(8, Math.round(c.w / (u * 2.2))), cw = c.w / N, rh = u * 1.3, K = Math.floor(c.h / rh);
      const done = []; for (let i = 0; i < chops.length; i++) { if (chops[i].s <= f.S) done.push(i); else break; }
      const rows = done.slice(-K);
      ctx.strokeStyle = P.dim; ctx.lineWidth = cw * .28; ctx.globalAlpha = .5;
      for (let j = 0; j < N; j++) line(ctx, c.x + (j + .5) * cw, c.y, c.x + (j + .5) * cw, c.y + c.h);
      ctx.globalAlpha = 1;
      const last = rows.length ? chops[rows[rows.length - 1]] : null, beat = last ? Math.max(0, 1 - (f.S - last.s) / 1.2) : 0;
      rows.forEach((idx, k) => {
        const e = chops[idx], isNew = k === rows.length - 1, y = c.y + c.h - (rows.length - k) * rh - (isNew ? beat * rh * 1.2 : 0), kk = 3 + (e.p % 3);
        for (let j = 0; j < N; j++) {
          if ((j + idx) % kk !== 0) { ctx.fillStyle = trackColor(P, e.tr); ctx.globalAlpha = .55 + .45 * e.vel; ctx.fillRect(c.x + j * cw - .5, y + rh * .15, cw + 1, rh * .7); }
          else { ctx.fillStyle = P.ink; ctx.globalAlpha = .85; ctx.fillRect(c.x + (j + .36) * cw, y, cw * .28, rh); }
        }
      });
      ctx.globalAlpha = 1; ctx.strokeStyle = P.ink; ctx.lineWidth = u * .25;
      const reed = c.y + c.h - rows.length * rh - u * .5 - beat * rh * 1.2; // 筬（おさ）
      line(ctx, c.x, reed, c.x + c.w, reed);
    } },

  punch: { ja: "紋紙", en: "CARD", draw(ctx, c, f, P, u) {
      const cols = 8, cw = Math.min(c.w / (cols + 2), u * 3.2), cardW = cw * (cols + 2), x0 = c.x + (c.w - cardW) / 2, rh = cw * .8, readY = c.y + c.h * .62;
      const Y = (s: number) => readY + (s - f.S) * rh, sMin = f.S - (readY - c.y) / rh - 2, sMax = f.S + (c.y + c.h - readY) / rh + 2;
      ctx.fillStyle = P.line; ctx.globalAlpha = .45; ctx.fillRect(x0, c.y, cardW, c.h); ctx.globalAlpha = 1;
      ctx.fillStyle = P.dim;
      for (let s = Math.ceil(sMin); s < sMax; s++) {
        const y = Y(s);
        if (s % 2 === 0) { ctx.fillStyle = P.bg; circle(ctx, x0 + cw * .5, y, cw * .13); ctx.fill(); circle(ctx, x0 + cardW - cw * .5, y, cw * .13); ctx.fill(); }
        ctx.fillStyle = P.dim; ctx.globalAlpha = .45;
        for (let k = 0; k < cols; k++) { circle(ctx, x0 + cw * (k + 1.5), y, cw * .06); ctx.fill(); }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = P.bg; ctx.lineWidth = u * .35;
      for (let b = Math.ceil(sMin / 16) * 16; b < sMax; b += 16) line(ctx, x0, Y(b) - rh / 2, x0 + cardW, Y(b) - rh / 2);
      const colOf = (e: VEvent) => e.tr === 0 ? e.p % 3 : e.tr === 1 ? 3 + e.p % 3 : e.kind === "kick" ? 6 : 7;
      for (const e of events) {
        if (e.tr === 3) continue;
        for (const s of [e.s - STEPS, e.s, e.s + STEPS]) {
          if (s < sMin || s > sMax) continue;
          const x = x0 + cw * (colOf(e) + 1.5), y = Y(s), lit = s <= f.S && f.S - s < 1.5, r = cw * (e.kind === "hat" ? .18 : .27);
          ctx.fillStyle = lit ? trackColor(P, e.tr) : P.bg; circle(ctx, x, y, r); ctx.fill();
        }
      }
      ctx.strokeStyle = P.a1; ctx.lineWidth = u * .18; line(ctx, x0 - u, readY, x0 + cardW + u, readY);
    } },

  spools: { ja: "糸巻き", en: "SPOOLS", draw(ctx, c, f, P, u) {
      const tall = c.h > c.w * 1.1, cols = tall ? 2 : 4, rows = tall ? 2 : 1, cw = c.w / cols, ch = (c.h - u * 3) / rows;
      const R = Math.min(cw, ch) * .36, eyeX = c.x + c.w / 2, eyeY = c.y + u * .8;
      for (let t = 0; t < 4; t++) {
        let wound = 0, act = 0;
        for (const e of events) { if (e.s > f.S) break; if (e.tr !== t) continue; wound += Math.min(e.len, f.S - e.s) * e.vel; act = Math.max(act, e.vel * Math.exp(-(f.S - e.s) / 1.5)); }
        const cx = c.x + (t % cols + .5) * cw, cy = c.y + u * 3 + (Math.floor(t / cols) + .5) * ch, core = R * .3, rw = core + (R * .92 - core) * Math.min(1, wound / TOT[t]);
        ctx.strokeStyle = P.dim; ctx.lineWidth = u * .12; circle(ctx, cx, cy, R); ctx.stroke();
        ctx.strokeStyle = trackColor(P, t); ctx.lineWidth = u * .14;
        for (let r = core; r < rw; r += u * .42) { ctx.globalAlpha = .35 + .5 * ((r / u * 7) % 1); circle(ctx, cx, cy, r); ctx.stroke(); }
        ctx.globalAlpha = 1; const rot = wound * .35; ctx.strokeStyle = P.ink; ctx.lineWidth = u * .15;
        for (let k = 0; k < 3; k++) { const a = rot + k * 2 * Math.PI / 3; line(ctx, cx, cy, cx + Math.cos(a) * core * .9, cy + Math.sin(a) * core * .9); }
        const wob = act * u * 2 * Math.sin(f.S * 9 + t), ty = cy - rw;
        ctx.strokeStyle = trackColor(P, t); ctx.lineWidth = u * .12; ctx.beginPath(); ctx.moveTo(cx, ty); ctx.quadraticCurveTo((cx + eyeX) / 2 + wob, (ty + eyeY) / 2, eyeX, eyeY); ctx.stroke();
        ctx.fillStyle = P.dim; ctx.font = `${u * 1}px ${SANS}`; ctx.textAlign = "center"; ctx.fillText(TRACKS[t][rt.lang], cx, cy + R + u * 1.5); ctx.textAlign = "left";
      }
      ctx.strokeStyle = P.ink; ctx.lineWidth = u * .15; circle(ctx, eyeX, eyeY, u * .5); ctx.stroke();
    } },

  stitch: { ja: "一目刺し", en: "STITCH", draw(ctx, c, f, P, u) {
      const cols = 16, cell = c.w / cols, rows = Math.max(2, Math.floor(c.h / cell)), oy = c.y + (c.h - rows * cell) / 2;
      const b0 = f.bar * 16, blk = Math.floor(f.S / 128) * 128;
      const colBit = []; for (let j = 0; j <= cols; j++) colBit.push(chops.some(e => e.s === b0 + j) ? 1 : 0);
      const hits = chops.filter(e => e.s >= blk && e.s <= f.S), shown = Math.min(rows + 1, hits.length);
      ctx.fillStyle = P.dim; ctx.globalAlpha = .35;
      for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) { circle(ctx, c.x + j * cell, oy + i * cell, u * .08); ctx.fill(); }
      ctx.lineCap = "round"; ctx.lineWidth = u * .22; ctx.strokeStyle = P.a1;
      for (let i = 0; i < shown; i++) {
        const bit = hits[i].p % 2, y = oy + i * cell; ctx.globalAlpha = i === shown - 1 ? 1 : .8;
        for (let j = 0; j < cols; j++) if ((j + bit) % 2 === 0) line(ctx, c.x + j * cell + cell * .14, y, c.x + (j + 1) * cell - cell * .14, y);
      }
      ctx.strokeStyle = P.a2;
      for (let j = 0; j <= Math.min(cols, f.step); j++) {
        const x = c.x + j * cell; ctx.globalAlpha = j === f.step ? 1 : .8;
        for (let i = 0; i < rows; i++) if ((i + colBit[j]) % 2 === 0) line(ctx, x, oy + i * cell + cell * .14, x, oy + (i + 1) * cell - cell * .14);
      }
      ctx.globalAlpha = 1; ctx.lineCap = "butt";
    } },

  ripple: { ja: "波紋", en: "RIPPLE", draw(ctx, c, f, P, u) {
      const R = Math.hypot(c.w, c.h) / 2;
      ctx.lineWidth = u * .18; ctx.setLineDash([u * .7, u * .5]);
      for (const e of events) {
        const d = f.S - e.s; if (d < 0 || d > 10 || e.kind === "hat" || e.tr === 3) continue;
        let cx, cy, col, max;
        if (e.kind === "kick") { cx = c.x + c.w / 2; cy = c.y + c.h / 2; col = P.ink; max = R * .9; }
        else if (e.kind === "snare") { cx = c.x + c.w * (.25 + .5 * noise(e.s, 1)); cy = c.y + c.h * (.25 + .5 * noise(e.s, 2)); col = P.a2; max = R * .5; }
        else { cx = c.x + c.w * ((e.p - 36) / 48); cy = c.y + c.h * (.2 + .6 * noise(e.s, 5)); col = trackColor(P, e.tr); max = R * .3 * e.vel; }
        const k = d / 10; ctx.strokeStyle = col; ctx.globalAlpha = (1 - k) * .9;
        for (let ring = 0; ring < 3; ring++) { const r = max * (k * 1.4 - ring * .12); if (r > 0) { circle(ctx, cx, cy, r); ctx.stroke(); } }
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    } },

  ayatori: { ja: "あやとり", en: "CRADLE", draw(ctx, c, f, P, u) {
      const pegY = (k: number) => c.y + c.h * (.06 + .88 * k / 11), Lx = c.x + u * 1.6, Rx = c.x + c.w - u * 1.6;
      const hist = chops.filter(e => e.s <= f.S).slice(-12);
      for (let i = 1; i < hist.length; i++) {
        const a = hist[i - 1], b = hist[i], fromL = i % 2 === 1, y1 = pegY(a.p % 12), y2 = pegY(b.p % 12), age = hist.length - 1 - i;
        const fresh = Math.max(0, 1 - (f.S - b.s) / 2), sag = c.w * .12 * (1 + fresh * Math.sin(f.S * 14) * .8) * (i % 3 === 0 ? -1 : 1);
        ctx.strokeStyle = trackColor(P, b.tr); ctx.globalAlpha = Math.max(.15, 1 - age / 11); ctx.lineWidth = u * (.12 + fresh * .2);
        ctx.beginPath(); ctx.moveTo(fromL ? Lx : Rx, y1); ctx.quadraticCurveTo(c.x + c.w / 2, (y1 + y2) / 2 + sag, fromL ? Rx : Lx, y2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const on = new Set(f.active.filter(a => a.tr < 2).map(a => a.p % 12));
      for (let k = 0; k < 12; k++) for (const x of [Lx, Rx]) { circle(ctx, x, pegY(k), u * (on.has(k) ? .6 : .3)); ctx.fillStyle = on.has(k) ? P.a1 : P.dim; ctx.fill(); }
      if (c.h / 12 > u * 1.3) { ctx.fillStyle = P.dim; ctx.font = `${u * .8}px ${MONO}`; for (let k = 0; k < 12; k++) ctx.fillText(NAMES[k], Lx + u * 1, pegY(k) + u * .3); }
    } },

  strings: { ja: "弦", en: "STRINGS", draw(ctx, c, f, P, u) {
      const gap = c.w / 12;
      for (let k = 0; k < 12; k++) {
        const x = c.x + (k + .5) * gap; let amp = 0, col = P.line, mode = 1;
        for (const e of tonal) { if (e.p % 12 !== k) continue; const d = f.S - e.s; if (d < 0 || d > e.len + 4) continue; const a = e.vel * Math.exp(-d / (e.len + 1)); if (a > amp) { amp = a; col = trackColor(P, e.tr); mode = 1 + Math.max(0, Math.floor((e.p - 36) / 12)); } }
        ctx.strokeStyle = amp > .03 ? col : P.line; ctx.lineWidth = u * (.12 + amp * .25); ctx.beginPath();
        for (let i = 0; i <= 40; i++) { const t = i / 40, y = c.y + t * (c.h - u * 1.6), dx = Math.sin(t * Math.PI * mode) * Math.sin(f.S * 6 + k) * amp * gap * .42; i ? ctx.lineTo(x + dx, y) : ctx.moveTo(x + dx, y); }
        ctx.stroke();
        ctx.fillStyle = amp > .03 ? col : P.dim; ctx.font = `${u * .8}px ${MONO}`; ctx.textAlign = "center"; ctx.fillText(NAMES[k], x, c.y + c.h); ctx.textAlign = "left";
      }
    } },

  wheel: { ja: "糸車", en: "WHEEL", draw(ctx, c, f, P, u) {
      const R = Math.min(c.w * .38, c.h * .42), cx = c.x + Math.min(c.w * .4, c.w / 2), cy = c.y + c.h / 2, b0 = f.bar * 16;
      const rot = -(f.S - b0) / 16 * Math.PI * 2, A = (s: number) => -Math.PI / 2 + (s - b0) / 16 * Math.PI * 2 + rot;
      ctx.strokeStyle = P.ink; ctx.lineWidth = u * .25; circle(ctx, cx, cy, R); ctx.stroke(); ctx.lineWidth = u * .1; circle(ctx, cx, cy, R * .9); ctx.stroke();
      ctx.strokeStyle = P.dim;
      for (let i = 0; i < 16; i++) { const a = A(b0 + i); ctx.lineWidth = u * (i % 4 === 0 ? .18 : .07); line(ctx, cx + Math.cos(a) * R * .12, cy + Math.sin(a) * R * .12, cx + Math.cos(a) * R * .9, cy + Math.sin(a) * R * .9); }
      circle(ctx, cx, cy, R * .12); ctx.fillStyle = P.ink; ctx.fill();
      for (const e of events) {
        if (e.tr === 3 || e.s < b0 || e.s >= b0 + 16 || e.kind === "hat") continue;
        const a = A(e.s), r = e.tr === 2 ? R * .78 : R * .95;
        ctx.globalAlpha = e.s <= f.S ? 1 : .3; ctx.fillStyle = trackColor(P, e.tr); circle(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, u * (e.tr === 2 ? .4 : .6)); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.fillStyle = P.a1; ctx.beginPath(); ctx.moveTo(cx - u * .8, cy - R - u * 1.6); ctx.lineTo(cx + u * .8, cy - R - u * 1.6); ctx.lineTo(cx, cy - R - u * .4); ctx.fill();
      const sx = c.x + c.w - u * 3, sy = cy;
      if (sx - cx > R + u * 4) {
        ctx.strokeStyle = P.dim; ctx.lineWidth = u * .1; line(ctx, cx, cy - R, sx, sy - u * .8); line(ctx, cx, cy + R, sx, sy + u * .8);
        ctx.strokeStyle = P.ink; ctx.lineWidth = u * .2; line(ctx, sx, sy - R * .7, sx, sy + R * .7);
        const ra = rot * 6; ctx.strokeStyle = P.a1; ctx.lineWidth = u * .15; ctx.beginPath(); ctx.ellipse(sx, sy, u * 1.4, u * .5, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = P.a1; circle(ctx, sx + Math.cos(ra) * u * 1.4, sy + Math.sin(ra) * u * .5, u * .3); ctx.fill();
      }
    } },

  fibers: { ja: "綿", en: "FIBER", draw(ctx, c, f, P, u, lf) {
      const st = rt.parts[lf.id] || (rt.parts[lf.id] = { list: Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), a: Math.random() * Math.PI - Math.PI / 2, l: .5 + Math.random(), vx: 0, vy: 0 })) });
      const pull = f.kick, dt = rt.frameDt;
      if (dt > 0) for (const p of st.list) {
        p.vx = p.vx * .96 + (Math.random() - .5) * .02 + .2 * pull * dt; p.vy = p.vy * .96 + (Math.random() - .5) * .02 + (.5 - p.y) * pull * dt * 5;
        p.x += p.vx * dt; p.y += p.vy * dt; if (p.x > 1) p.x -= 1; if (p.x < 0) p.x += 1; if (p.y < 0 || p.y > 1) { p.vy *= -1; p.y = Math.min(1, Math.max(0, p.y)); }
        p.a = ((p.a + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2; p.a += -p.a * pull * dt * 8 + (Math.random() - .5) * .06;
      }
      ctx.strokeStyle = P.a1; ctx.globalAlpha = .15 + pull * .85; ctx.lineWidth = u * (.1 + pull * .3); line(ctx, c.x, c.y + c.h / 2, c.x + c.w, c.y + c.h / 2);
      ctx.lineWidth = u * .1; ctx.lineCap = "round";
      st.list.forEach((p: { x: number; y: number; a: number; l: number }, i: number) => { const len = u * (1.2 + p.l * 1.6), x = c.x + p.x * c.w, y = c.y + p.y * c.h; ctx.strokeStyle = i % 5 === 0 ? P.a1 : P.ink; ctx.globalAlpha = .6; line(ctx, x - Math.cos(p.a) * len / 2, y - Math.sin(p.a) * len / 2, x + Math.cos(p.a) * len / 2, y + Math.sin(p.a) * len / 2); });
      ctx.globalAlpha = 1; ctx.lineCap = "butt";
    } },

  stripes: { ja: "縞帳", en: "STRIPES", draw(ctx, c, f, P, u) {
      const h1 = c.h * .66, tot = f.spec.reduce((a, v) => a + .25 + v, 0), cols = [P.a1, P.ink, P.a2, P.dim]; let x = c.x;
      f.spec.forEach((v, i) => { const w = (.25 + v) / tot * c.w; ctx.fillStyle = cols[i % 4]; ctx.globalAlpha = .2 + .8 * v; ctx.fillRect(x, c.y, w + .5, h1); x += w; });
      const y2 = c.y + h1 + u, h2 = c.h - h1 - u, n = f.hist.length, bw = c.w / n;
      f.hist.forEach((v, i) => { ctx.fillStyle = i % 2 ? P.a1 : P.a2; ctx.globalAlpha = .1 + .9 * v; ctx.fillRect(c.x + i * bw, y2, bw + .5, h2); });
      ctx.globalAlpha = 1; ctx.strokeStyle = P.ink; ctx.setLineDash([u * .6, u * .5]); ctx.lineWidth = u * .1;
      line(ctx, c.x, y2 + u * .6, c.x + c.w, y2 + u * .6); line(ctx, c.x, y2 + h2 - u * .6, c.x + c.w, y2 + h2 - u * .6); ctx.setLineDash([]);
    } },

  swatch: { ja: "断片", en: "SWATCH", draw(ctx, c, f, P, u) {
      const e = f.lastChop, prog = Math.min(1, (f.S - e.s) / e.len), col = trackColor(P, e.tr);
      const x = c.x + u, y = c.y + u * 3, w = c.w - u * 2, h = c.h - u * 4, z = u * .7;
      ctx.beginPath(); let k = 0; // ピンキングばさみで切った縁
      for (let xx = x; xx <= x + w; xx += z) ctx.lineTo(xx, y + (k++ % 2 ? z * .6 : 0));
      for (let yy = y; yy <= y + h; yy += z) ctx.lineTo(x + w - (k++ % 2 ? z * .6 : 0), yy);
      for (let xx = x + w; xx >= x; xx -= z) ctx.lineTo(xx, y + h - (k++ % 2 ? z * .6 : 0));
      for (let yy = y + h; yy >= y; yy -= z) ctx.lineTo(x + (k++ % 2 ? z * .6 : 0), yy);
      ctx.closePath(); ctx.fillStyle = col; ctx.globalAlpha = .14; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = u * .1; ctx.stroke();
      const N = 200, cyc = 5 + (e.p - 40) / 2.5, my = y + h / 2, amp = h * .34 * e.vel; ctx.beginPath();
      for (let i = 0; i <= N; i++) { const t = i / N, env = Math.min(1, t * 12) * Math.exp(-t * 2.2), v = Math.sin(t * cyc * Math.PI * 2) * .8 + (noise(i, e.s) - .5) * .5; const px = x + u + t * (w - u * 2), py = my - v * env * amp; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      ctx.strokeStyle = col; ctx.lineWidth = u * .16; ctx.stroke();
      ctx.setLineDash([u * .6, u * .45]); ctx.strokeStyle = P.ink; ctx.lineWidth = u * .18; line(ctx, x + u, y + u * 1.4, x + u + (w - u * 2) * prog, y + u * 1.4); ctx.setLineDash([]);
      const label = `${pfull(e.p)} · ${TRACKS[e.tr][rt.lang]}`; ctx.font = `${u * 1.05}px ${MONO}`; const tw = ctx.measureText(label).width;
      ctx.strokeStyle = P.dim; ctx.lineWidth = u * .08; line(ctx, c.x + u * 2, c.y + u * 1.8, x + u * 2, y + u * .4);
      ctx.fillStyle = P.ink; ctx.fillRect(c.x, c.y, tw + u * 1.2, u * 1.9); ctx.fillStyle = P.bg; ctx.fillText(label, c.x + u * .6, c.y + u * 1.35);
    } },

  title: { ja: "文字", en: "TITLE", draw(ctx, c, f, P, u) {
      const name = rt.song.name || "無題", vertical = c.h > c.w * 1.15, t = f.S / STEPS * SONG_SEC, info = `${rt.song.key}  ${BPM} BPM  ${rt.song.bars} bars`;
      ctx.fillStyle = P.ink;
      if (vertical) {
        const fs = Math.min(c.w * .42, c.h * .72 / name.length); ctx.font = `900 ${fs}px ${MIN}`; ctx.textAlign = "center";
        [...name].forEach((ch, i) => ctx.fillText(ch, c.x + c.w * .6, c.y + fs * (i + 1))); ctx.textAlign = "left";
        ctx.save(); ctx.translate(c.x + u * .4, c.y); ctx.rotate(Math.PI / 2); ctx.fillStyle = P.dim; ctx.font = `${u * 1}px ${MONO}`; ctx.fillText(info, 0, 0); ctx.restore();
      } else {
        const fs = Math.min(c.h * .4, c.w / (name.length * 1.05)); ctx.font = `900 ${fs}px ${MIN}`; ctx.fillText(name, c.x, c.y + fs);
        ctx.fillStyle = P.dim; ctx.font = `${u * 1.1}px ${MONO}`; ctx.fillText(info, c.x, c.y + fs + u * 2);
      }
      const sz = u * 3, sx = c.x + c.w - sz, sy = c.y + c.h - sz - u * 3; // 落款
      ctx.fillStyle = P.a2; ctx.fillRect(sx, sy, sz, sz); ctx.fillStyle = P.bg; ctx.font = `700 ${sz * .62}px ${SANS}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("織", sx + sz / 2, sy + sz / 2 + sz * .04);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      const by = c.y + c.h - u * .8, px = c.x + c.w * f.S / STEPS;
      ctx.strokeStyle = P.line; ctx.lineWidth = u * .2; line(ctx, c.x, by, c.x + c.w, by); ctx.strokeStyle = P.a1; line(ctx, c.x, by, px, by);
      for (let b = 0; b <= 16; b += 4) { ctx.fillStyle = P.dim; circle(ctx, c.x + c.w * b / 16, by, u * .35); ctx.fill(); }
      ctx.fillStyle = P.ink; ctx.beginPath(); ctx.ellipse(px, by, u * .3, u * 1.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.font = `500 ${u * 1.3}px ${MONO}`; ctx.fillText(`${fmtT(t)} / ${fmtT(SONG_SEC)}`, c.x, by - u * 1.4);
    } },

  sozai: { ja: "素材", en: "IMAGE", draw(ctx, c, f, P, _u, lf) {
      const src = rt.imgs.get(lf.id) || placeholder(P), idx = chops.indexOf(f.lastChop);
      const n = 1 + Math.floor(noise(idx, 11) * 3), tw = c.w / n, th = c.h / n, zoom = 1 + noise(idx, 12) * 1.5;
      let cw = src.width / zoom, ch = cw * th / tw; if (ch > src.height) { ch = src.height; cw = ch * tw / th; }
      const sx = (src.width - cw) * noise(idx, 13), sy = (src.height - ch) * noise(idx, 14), mirror = noise(idx, 15) > .5;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        ctx.save(); const x = c.x + i * tw, y = c.y + j * th;
        if (mirror && (i + j) % 2) { ctx.translate(x + tw, y); ctx.scale(-1, 1); ctx.drawImage(src, sx, sy, cw, ch, 0, 0, tw, th); }
        else ctx.drawImage(src, sx, sy, cw, ch, x, y, tw, th);
        ctx.restore();
      }
      const fl = Math.max(0, 1 - (f.S - f.lastChop.s)); ctx.fillStyle = P.a1; ctx.globalAlpha = fl * .25; ctx.fillRect(c.x, c.y, c.w, c.h); ctx.globalAlpha = 1;
    } },
} satisfies Record<string, PanelDef>);
const WG: Record<string, string> = { threads: "音", weave: "響き", punch: "拍", spools: "響き", stitch: "拍", ripple: "拍", ayatori: "音", strings: "音", wheel: "拍", fibers: "響き", stripes: "響き", swatch: "音", title: "文字", sozai: "その他" };
for (const k in WG) PANELS[k].g = WG[k];
export const PANEL_KEYS = Object.keys(PANELS);

