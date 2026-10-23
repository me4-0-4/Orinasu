import type { Feat } from "./features.ts";
import type { Timeline, VEvent } from "./timeline.ts";
import { brush, circle, DOT, fmtT, hex2rgb, isDark, line, MONO, noise, palette, PANELS, rt, SANS, type PanelDef, type Palette, type Rect } from "./panels.ts";
import { Layout, type FrameStyle, type Geom, type Treatment, type VideoSettings } from "./settings.ts";
import { matReady, srcSize, type Material } from "./materials.ts";

// 1コマを描く：地 → 素材の層 → パネルの層 → 上の層 → 効果（墨・版ズレ・グリッチ）→ 下の帯。
// 座標は書き出しの大きさの画素。描く先の Canvas には devScale（画面の画素÷書き出しの画素）の拡大を掛けておく。

let cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D, devScale = 1;
let V: VideoSettings, L: Layout, TL: Timeline, MATS: Material[] = [];
let small: HTMLCanvasElement, sctx: CanvasRenderingContext2D, snap: HTMLCanvasElement, snctx: CanvasRenderingContext2D, prev: HTMLCanvasElement, prevX: CanvasRenderingContext2D;
const lumC = document.createElement("canvas"), lumX = lumC.getContext("2d", { willReadFrequently: true })!;

/** 描く先1つ分（プレビューと書き出しで別々に持つ）。前のコマ（モッシュ用）も持つ。 */
export class FrameTarget {
  readonly cv: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  devScale = 1;
  readonly small = document.createElement("canvas");
  readonly snap = document.createElement("canvas");
  readonly prev = document.createElement("canvas");
  constructor(canvas: HTMLCanvasElement) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d")!;
  }
  /** 書き出しの大きさ（VW×VH）を、画面の画素で w×h に描くように合わせる。 */
  resize(w: number, h: number, VW: number): void {
    this.cv.width = w;
    this.cv.height = h;
    for (const c of [this.snap, this.prev]) { c.width = w; c.height = h; }
    this.devScale = w / VW;
  }
}

export function renderFrame(target: FrameTarget, v: VideoSettings, layout: Layout, tl: Timeline, mats: Material[], f: Feat): void {
  cv = target.cv; ctx = target.ctx; devScale = target.devScale;
  small = target.small; sctx = small.getContext("2d")!; snap = target.snap; snctx = snap.getContext("2d")!; prev = target.prev; prevX = prev.getContext("2d")!;
  V = v; L = layout; TL = tl; MATS = mats;
  ctx.setTransform(devScale, 0, 0, devScale, 0, 0);
  drawFrame(f);
}

const patCache: Record<string, CanvasPattern> = {};
function dotPattern(key: string, cell: number, r: number, col: string, hole: boolean): CanvasPattern { // hole=true：穴だけ抜いた網（LED）／false：点（網点）
  const k = key + cell + r + col + hole; if (patCache[k]) return patCache[k];
  const t = document.createElement("canvas"); t.width = t.height = cell; const g = t.getContext("2d")!;
  g.fillStyle = col;
  if (hole) { g.fillRect(0, 0, cell, cell); g.globalCompositeOperation = "destination-out"; }
  g.beginPath(); g.arc(cell / 2, cell / 2, r, 0, Math.PI * 2); g.fill();
  return (patCache[k] = ctx.createPattern(t, "repeat")!);
}
/** LED の1粒の大きさ（画面の画素）。 */
const ledCell = (u: number): number => Math.max(3, Math.round(u * .62 * devScale));
function ledify(x: number, y: number, w: number, h: number, P: Palette, u: number): void {
  const cell = ledCell(u), dx = Math.round(x * devScale), dy = Math.round(y * devScale);
  const cols = Math.floor(w * devScale / cell), rows = Math.floor(h * devScale / cell);
  if (cols < 2 || rows < 2) return;
  small.width = cols; small.height = rows; sctx.drawImage(cv, dx, dy, cols * cell, rows * cell, 0, 0, cols, rows);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, cols, rows, dx, dy, cols * cell, rows * cell);
  ctx.translate(dx, dy); ctx.fillStyle = dotPattern("led", cell, cell * .38, P.bg, true); ctx.fillRect(0, 0, cols * cell, rows * cell);
  ctx.restore();
}
function chrome(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, P: Palette, u: number, style: FrameStyle | undefined): void {
  if (style === "card") { ctx.fillStyle = P.panel; ctx.globalAlpha = V.layers.panels.alpha; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; }
  else if (style === "line") { ctx.setLineDash([u * .9, u * .6]); ctx.strokeStyle = P.dim; ctx.lineWidth = u * .16; ctx.strokeRect(x + u * .3, y + u * .3, w - u * .6, h - u * .6); ctx.setLineDash([]); }
  else if (style === "kakko") { // 「 」
    const L = Math.min(w, h) * .14; ctx.strokeStyle = P.ink; ctx.lineWidth = u * .3; ctx.lineCap = "square";
    ctx.beginPath(); ctx.moveTo(x + L, y + u * .3); ctx.lineTo(x + u * .3, y + u * .3); ctx.lineTo(x + u * .3, y + L); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - L, y + h - u * .3); ctx.lineTo(x + w - u * .3, y + h - u * .3); ctx.lineTo(x + w - u * .3, y + h - L); ctx.stroke(); ctx.lineCap = "butt";
  }
}
function label(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, P: Palette, u: number, def: PanelDef, f: Feat): Rect { // 札・耳。中身の枠を返す
  const name = V.lang === "ja" ? def.ja : def.en;
  if (V.label === "fuda" && w > u * 8) {
    ctx.font = `${u * 1.6}px ${DOT}`; const tw = ctx.measureText(name).width;
    ctx.fillStyle = P.ink; ctx.fillRect(x + u * .9, y + u * .9, tw + u * 1.4, u * 2.4); ctx.fillStyle = P.bg; ctx.fillText(name, x + u * 1.6, y + u * 2.75);
    ctx.fillStyle = f.hit > .05 ? P.a1 : P.line; ctx.globalAlpha = f.hit > .05 ? .3 + .7 * f.hit : 1; ctx.fillRect(x + tw + u * 3, y + u * 1.6, u * 1, u * 1); ctx.globalAlpha = 1;
    return { x: x + u * 1.2, y: y + u * 4.2, w: w - u * 2.4, h: h - u * 5.4 };
  }
  if (V.label === "mimi" && w > u * 10) {
    const e = u * 2.8; ctx.setLineDash([u * .5, u * .4]); ctx.strokeStyle = P.dim; ctx.globalAlpha = .7; ctx.lineWidth = u * .12;
    line(ctx, x + e, y + u * .8, x + e, y + h - u * .8); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = P.ink; let end: number;
    if (V.lang === "ja") { ctx.font = `${u * 1.3}px ${DOT}`; ctx.textAlign = "center"; [...name].forEach((ch, i) => ctx.fillText(ch, x + e / 2, y + u * 2.2 + i * u * 1.5)); ctx.textAlign = "left"; end = u * 2.2 + name.length * u * 1.5; }
    else { ctx.save(); ctx.translate(x + e / 2 - u * .45, y + u * 1.2); ctx.rotate(Math.PI / 2); ctx.font = `${u * 1.1}px ${DOT}`; ctx.fillText(name, 0, 0); end = u * 1.6 + ctx.measureText(name).width; ctx.restore(); }
    if (h > end + u * 13) for (let k = 0; k < 16; k++) { const ty = y + h - u * 1.2 - (15 - k) * u * .7, cur = k === f.step; ctx.fillStyle = cur ? P.a1 : P.dim; ctx.fillRect(x + e * (cur ? .2 : .35), ty, e * (cur ? .6 : .3), u * (cur ? .25 : .1)); }
    return { x: x + e + u * 1.2, y: y + u * 1.2, w: w - e - u * 2.4, h: h - u * 2.4 };
  }
  return { x: x + u * 1.2, y: y + u * 1.2, w: w - u * 2.4, h: h - u * 2.4 };
}

function drawMat(m: Material, dx: number, dy: number, dw: number, dh: number, zoom: number, hx: number, hy: number, mirror: boolean): void {
  const [iw, ih] = srcSize(m), a = dw / dh; let sw: number, sh: number;
  if (iw / ih > a) { sh = ih / zoom; sw = sh * a; } else { sw = iw / zoom; sh = sw / a; }
  const sx = (iw - sw) * hx, sy = (ih - sh) * hy;
  ctx.save();
  if (mirror) { ctx.translate(dx + dw, dy); ctx.scale(-1, 1); ctx.drawImage(m.el, sx, sy, sw, sh, 0, 0, dw, dh); }
  else ctx.drawImage(m.el, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.restore();
}
function lumGrid(x: number, y: number, w: number, h: number, cell: number) {
  const cols = Math.max(2, Math.floor(w / cell)), rows = Math.max(2, Math.floor(h / cell));
  lumC.width = cols; lumC.height = rows; lumX.drawImage(cv, x * devScale, y * devScale, w * devScale, h * devScale, 0, 0, cols, rows);
  const d = lumX.getImageData(0, 0, cols, rows).data, L = new Float32Array(cols * rows);
  for (let i = 0; i < L.length; i++) L[i] = (d[i * 4] * .3 + d[i * 4 + 1] * .59 + d[i * 4 + 2] * .11) / 255;
  return { cols, rows, L, cw: w / cols, ch: h / rows };
}
const pxC = document.createElement("canvas"), pxX = pxC.getContext("2d", { willReadFrequently: true })!;
function tones(P: Palette): [string, string] { return isDark(P.bg) ? [P.ink, P.bg] : [P.bg, P.ink]; } // [明るい色, 暗い色]
function pixelPass(x: number, y: number, w: number, h: number, fn: (d: Uint8ClampedArray, cols: number, rows: number) => void): void { // 範囲を縮小して画素ごとに処理し、戻す
  const dx = Math.round(x * devScale), dy = Math.round(y * devScale), dw = Math.max(2, Math.round(w * devScale)), dh = Math.max(2, Math.round(h * devScale));
  const k = Math.max(2, Math.sqrt(dw * dh / 45000)), cols = Math.max(2, Math.round(dw / k)), rows = Math.max(2, Math.round(dh / k));
  pxC.width = cols; pxC.height = rows; pxX.drawImage(cv, dx, dy, dw, dh, 0, 0, cols, rows);
  const img = pxX.getImageData(0, 0, cols, rows); fn(img.data, cols, rows); pxX.putImageData(img, 0, 0);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(pxC, 0, 0, cols, rows, dx, dy, dw, dh); ctx.restore();
}
function lumOf(d: Uint8ClampedArray, cols: number, rows: number): Float32Array { const L = new Float32Array(cols * rows); for (let i = 0; i < L.length; i++) L[i] = (d[i * 4] * .3 + d[i * 4 + 1] * .59 + d[i * 4 + 2] * .11) / 255; return L; }
function put(d: Uint8ClampedArray, i: number, rgb: number[]): void { d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; }
const HEAVY = new Set(["crt", "halftone", "mosh", "contour", "edge"]);
function treat(kind: string, x: number, y: number, w: number, h: number, P: Palette, u: number, f: Feat, idx: number, m: Material): void {
  const [lt, dk] = tones(P), LT = hex2rgb(lt), DK = hex2rgb(dk);
  if (kind === "crt" || kind === "halftone") {
    const G = lumGrid(x, y, w, h, Math.max(u * (kind === "crt" ? .7 : 1.1), Math.min(w, h) / 90));
    ctx.fillStyle = P.bg; ctx.fillRect(x, y, w, h); ctx.fillStyle = kind === "crt" ? P.a1 : P.ink;
    for (let r = 0; r < G.rows; r++) for (let c = 0; c < G.cols; c++) {
      const v = G.L[r * G.cols + c]; if (v < .06) continue;
      if (kind === "crt") { const t = G.ch * .85 * v; ctx.fillRect(x + c * G.cw, y + r * G.ch + (G.ch - t) / 2, G.cw + .3, t); }
      else { ctx.beginPath(); ctx.arc(x + (c + .5) * G.cw, y + (r + .5) * G.ch, G.cw * .55 * Math.sqrt(v), 0, 7); ctx.fill(); }
    }
  } else if (kind === "mosh") {
    const B = u * 2.4 * devScale, p = .2 + .6 * f.fillAmt + .3 * f.kick;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let by = y * devScale; by < (y + h) * devScale; by += B) for (let bx = x * devScale; bx < (x + w) * devScale; bx += B) {
      const ci = Math.floor(bx / B), ri = Math.floor(by / B);
      if (noise(ci + idx * 7, ri + Math.floor(f.S * 2)) > p) continue;
      ctx.drawImage(prev, bx + (noise(ci, idx) - .5) * B * 1.5, by + (noise(ri, idx + 3) - .5) * B * .6, B, B, bx, by, B, B);
    }
    ctx.restore();
  } else if (kind === "track") {
    const G = lumGrid(x, y, w, h, Math.max(u * 1.6, Math.min(w, h) / 40)), picks: [number, number, number][] = [];
    const order = [...G.L.keys()].sort((a, b) => G.L[b] - G.L[a]);
    for (const i of order) { if (picks.length >= 6) break; const c = i % G.cols, r = Math.floor(i / G.cols); if (picks.every(p => Math.abs(p[0] - c) + Math.abs(p[1] - r) > 3)) picks.push([c, r, G.L[i]]); }
    ctx.strokeStyle = P.ink; ctx.fillStyle = P.ink; ctx.lineWidth = u * .12; ctx.font = `${u * .85}px ${MONO}`;
    const pts = picks.map(([c, r, v], k) => { const s = (1.5 + v * 3 + noise(k, idx) * 2) * G.cw, cx = x + (c + .5) * G.cw, cy = y + (r + .5) * G.ch; ctx.strokeRect(cx - s / 2, cy - s / 2, s, s); ctx.fillText(`${(cx / 10).toFixed(4)}`, cx - s / 2, cy - s / 2 - u * .35); return [cx, cy]; });
    ctx.globalAlpha = .7; for (let k = 1; k < pts.length; k++) line(ctx, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]); ctx.globalAlpha = 1;
    ctx.fillText(m.name, x + u * .6, y + h - u * .6);
  } else if (kind === "stretch") { // 1列（1行）の画素を引き伸ばす
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const X = x * devScale, Y = y * devScale, W = w * devScale, H = h * devScale, amt = .25 + .5 * noise(idx, 72) + .4 * f.fillAmt;
    if (noise(idx, 70) > .45) { const sx = X + W * noise(idx, 71) * .7; ctx.drawImage(cv, sx, Y, 1, H, sx, Y, W * amt, H); }
    else { const sy = Y + H * noise(idx, 71) * .7; ctx.drawImage(cv, X, sy, W, 1, X, sy, W, H * amt); }
    ctx.restore();
  } else if (kind === "key") { // 鮮やかな色だけ残して、ほかは飛ばす
    pixelPass(x, y, w, h, (d, cols, rows) => { for (let i = 0; i < cols * rows; i++) { const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx < 60 || (mx - mn) / mx < .42) put(d, i, LT); } });
  } else if (kind === "thresh") {
    pixelPass(x, y, w, h, (d, cols, rows) => { const L = lumOf(d, cols, rows); for (let i = 0; i < L.length; i++) put(d, i, L[i] > .42 + (noise(i, idx) - .5) * .08 ? LT : DK); });
  } else if (kind === "contour") { // 明るさの段の境目を等高線に
    pixelPass(x, y, w, h, (d, cols, rows) => { const L = lumOf(d, cols, rows), lv = (i: number) => Math.floor(L[i] * 7); for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const i = r * cols + c, e = (c < cols - 1 && lv(i) !== lv(i + 1)) || (r < rows - 1 && lv(i) !== lv(i + cols)); put(d, i, e ? DK : LT); } });
  } else if (kind === "edge") { // 輪郭線（Sobel）
    pixelPass(x, y, w, h, (d, cols, rows) => { const L = lumOf(d, cols, rows), at = (c: number, r: number) => L[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const gx = at(c + 1, r - 1) + 2 * at(c + 1, r) + at(c + 1, r + 1) - at(c - 1, r - 1) - 2 * at(c - 1, r) - at(c - 1, r + 1), gy = at(c - 1, r + 1) + 2 * at(c, r + 1) + at(c + 1, r + 1) - at(c - 1, r - 1) - 2 * at(c, r - 1) - at(c + 1, r - 1); put(d, r * cols + c, Math.hypot(gx, gy) > .35 ? DK : LT); } });
  } else if (kind === "led") ledify(x, y, w, h, P, u);
}
/** パネルごとの、いま描いている中身（替わったら状態を捨てる）と、描けなかった中身（エラーは1回だけ出す）。 */
const kindOf = new Map<number, string>();
const failed = new Set<string>();
/** 毎コマ変わる処理（前のコマを使う・フィルで伸びる）。これは覚えずに、毎回掛ける。 */
const LIVE = new Set(["mosh", "stretch"]);
const tileCache = new Map<string, HTMLCanvasElement>();
let cacheSig = "";
/** 一度描いた素材の四角（処理まで済んだ絵）を覚えておき、次からはそれを置くだけにする。動画は毎コマ変わるので覚えない。 */
function cached(key: string, m: Material, x: number, y: number, w: number, h: number, make: () => void): void {
  if (m.el instanceof HTMLVideoElement) {
    make();
    return;
  }
  const sig = `${devScale}|${JSON.stringify(V.colors)}`;
  if (sig !== cacheSig) {
    tileCache.clear();
    cacheSig = sig;
  }
  const dx = Math.round(x * devScale), dy = Math.round(y * devScale), dw = Math.round(w * devScale), dh = Math.round(h * devScale);
  const hit = tileCache.get(key);
  if (hit && hit.width === dw && hit.height === dh) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(hit, dx, dy);
    ctx.restore();
    return;
  }
  make();
  if (dw < 1 || dh < 1) return;
  const c = document.createElement("canvas");
  c.width = dw;
  c.height = dh;
  c.getContext("2d")!.drawImage(cv, dx, dy, dw, dh, 0, 0, dw, dh);
  tileCache.set(key, c);
  if (tileCache.size > 160) tileCache.delete(tileCache.keys().next().value!);
}
function drawBase(f: Feat, P: Palette, g: Geom, u: number): void {
  const B = V.layers.base, mats = MATS.filter(matReady);
  if (B.mode === "none" || !mats.length) return;
  const T = (Object.keys(B.treat) as Treatment[]).filter(k => B.treat[k]) as string[], Tl = T.filter(k => !HEAVY.has(k));
  const pickMat = (e: VEvent, idx: number): Material => { const pool = mats.filter(m => m.tr == null || (m.tr === "drum") === (e.tr === 2)), L = pool.length ? pool : mats; return L[Math.floor(noise(idx, 51) * L.length)]; };
  const pickT = (idx: number, light: boolean): string => { const L = light ? Tl : T; return L.length ? L[Math.floor(noise(idx, 52) * L.length)] : "plain"; };
  if (B.mode === "cut") {
    const e = f.lastChop; let idx = TL.chops.indexOf(e); if (f.isFill) idx = idx * 31 + Math.floor(f.S);
    const m = pickMat(e, idx);
    if (m.el instanceof HTMLVideoElement && m.seek !== idx) { m.seek = idx; try { m.el.currentTime = noise(idx, 54) * (m.el.duration || 0); } catch { /* 読み込み中は飛ばさない */ } }
    const t = pickT(idx, false), t2raw = pickT(idx + 7, true), t2 = noise(idx, 59) < .5 && t2raw !== t ? t2raw : "plain";
    // 同じ断片なら同じ絵なので、処理まで済んだ絵を覚えておいて使い回す（毎コマ動く処理だけ、あとから掛ける）
    cached(`cut|${idx}|${m.id}|${t}|${t2}|${B.zoom}`, m, 0, 0, g.VW, g.VH, () => {
      drawMat(m, 0, 0, g.VW, g.VH, 1 + B.zoom * 3 * noise(idx, 53), noise(idx, 55), noise(idx, 56), noise(idx, 57) > .6);
      if (t !== "plain" && !LIVE.has(t)) treat(t, 0, 0, g.VW, g.VH, P, u, f, idx, m);
      if (t2 !== "plain" && !LIVE.has(t2)) treat(t2, 0, 0, g.VW, g.VH, P, u, f, idx, m);
    });
    if (LIVE.has(t)) treat(t, 0, 0, g.VW, g.VH, P, u, f, idx, m);
    if (LIVE.has(t2)) treat(t2, 0, 0, g.VW, g.VH, P, u, f, idx, m);
    ctx.fillStyle = P.ink; ctx.globalAlpha = Math.max(0, 1 - (f.S - e.s) * 2) * .15; ctx.fillRect(0, 0, g.VW, g.VH); ctx.globalAlpha = 1;
  } else { // コラージュ：大きい四角と、群がる小さい四角
    const life = B.life * 4, s = Math.min(g.VW, g.VH), tiles: { i: number; e: VEvent; d: number; x: number; y: number; w: number; h: number; big: boolean }[] = [];
    for (let i = 0; i < TL.events.length; i++) {
      const e = TL.events[i]; if (e.tr === 3 || e.kind === "hat") continue;
      let d = f.S - e.s; if (d < 0) d += TL.totalSteps; if (d > life || noise(i, 58) > B.density) continue;
      const big = e.tr < 2, cx = g.VW * (-.1 + 1.2 * noise(i, 63)), cy = g.VH * (-.05 + 1.1 * noise(i, 64));
      if (big) { const w = s * (.22 + .55 * noise(i, 61)) * (g.VW > g.VH ? 1.25 : 1); tiles.push({ i, e, d, x: cx - w / 2, y: cy - w * .45, w, h: w * (.55 + .8 * noise(i, 62)), big: true }); }
      const n = big ? Math.floor(noise(i, 69) * 5 * B.density) : 2 + Math.floor(noise(i, 69) * 5);
      for (let k = 0; k < n; k++) { const j = i * 13 + k, w = s * (.04 + .14 * noise(j, 61)); tiles.push({ i: j, e, d, x: cx + (noise(j, 63) - .5) * s * .35 - w / 2, y: cy + (noise(j, 64) - .5) * s * .35 - w / 2, w, h: w * (.6 + .9 * noise(j, 62)), big: false }); }
    }
    tiles.sort((a, b) => (Number(b.big) - Number(a.big)) || b.d - a.d); // 大きい四角を先に、小さい四角は上に群がらせる
    for (const t of tiles) {
      const m = pickMat(t.e, t.i), x = t.x + (t.d < .5 ? (1 - t.d / .5) * u * 4 : 0);
      const k = pickT(t.i, !t.big);
      // すべり込んでいる間と、画面の外にはみ出す四角は覚えない（位置で見える所が変わるので）
      const still = t.d >= .5 && x >= 0 && t.y >= 0 && x + t.w <= g.VW && t.y + t.h <= g.VH;
      const make = (): void => {
        drawMat(m, x, t.y, t.w, t.h, 1 + noise(t.i, 65) * (t.big ? 1.5 : 4), noise(t.i, 66), noise(t.i, 67), noise(t.i, 68) > .7);
        if (k !== "plain" && !LIVE.has(k)) treat(k, x, t.y, t.w, t.h, P, u, f, t.i, m);
      };
      if (still) cached(`tile|${t.i}|${m.id}|${k}|${t.w.toFixed(1)}|${t.h.toFixed(1)}`, m, x, t.y, t.w, t.h, make);
      else make();
      if (LIVE.has(k)) treat(k, x, t.y, t.w, t.h, P, u, f, t.i, m);
      if (!t.big && noise(t.i, 74) > .6) { ctx.strokeStyle = P.ink; ctx.lineWidth = u * .06; ctx.strokeRect(x, t.y, t.w, t.h); }
    }
  }
  if (B.dim > 0) { ctx.fillStyle = P.bg; ctx.globalAlpha = B.dim; ctx.fillRect(0, 0, g.VW, g.VH); ctx.globalAlpha = 1; }
}
function drawTop(f: Feat, P: Palette, g: Geom, u: number): void {
  const T = V.layers.top, s = Math.min(g.VW, g.VH);
  if (T.lines) { // 細い直線：拍ごとに引き直す
    const k = f.bar * 4 + f.beat; ctx.strokeStyle = P.ink; ctx.lineWidth = u * .1;
    for (let i = 0; i < 6; i++) { ctx.globalAlpha = .35 + .4 * noise(i, k + 81); const a = noise(i, k + 82) * Math.PI, cx = g.VW * noise(i, k + 83), cy = g.VH * noise(i, k + 84), L = g.VW + g.VH; line(ctx, cx - Math.cos(a) * L, cy - Math.sin(a) * L, cx + Math.cos(a) * L, cy + Math.sin(a) * L); }
    for (let i = 0; i < 3; i++) { ctx.globalAlpha = .4; circle(ctx, g.VW * noise(i, k + 85), g.VH * noise(i, k + 86), s * (.1 + .35 * noise(i, k + 87))); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  if (T.ring) { // 光る輪：キックでふくらむ
    const cx = g.VW * (.3 + .4 * noise(f.bar, 91)), cy = g.VH * (.3 + .4 * noise(f.bar, 92)), r = s * .2 * (1 + f.kick * .25), a0 = f.S * .2;
    ctx.save(); ctx.strokeStyle = P.a2; ctx.shadowColor = P.a2; ctx.shadowBlur = u * 4; ctx.lineWidth = s * .035; ctx.globalAlpha = .85;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + Math.PI * 1.6); ctx.stroke(); ctx.restore();
  }
  if (!T.show || !T.text) return;
  let fs = s * (.06 + T.size * .22); ctx.font = `700 ${fs}px ${SANS}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${-fs * .04}px`;
  let tw = ctx.measureText(T.text).width; const maxW = g.VW - u * 8;
  if (tw > maxW) { fs *= maxW / tw; ctx.font = `700 ${fs}px ${SANS}`; tw = maxW; }
  const x = T.pos === "c" ? (g.VW - tw) / 2 : u * 4, y = T.pos === "lt" ? u * 4 + fs : T.pos === "c" ? g.VH / 2 + fs * .35 : g.VH * .72;
  if (V.fx.zure && f.kick > .05) { ctx.fillStyle = P.a2; ctx.globalAlpha = .8 * f.kick; ctx.fillText(T.text, x + u * .6 * f.kick, y + u * .3 * f.kick); ctx.globalAlpha = 1; }
  ctx.fillStyle = P.ink; ctx.fillText(T.text, x, y);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
}

function drawFrame(f: Feat): void {
  const P0 = palette(V.colors), { g, out } = L.place(), u = g.u, fx = V.fx, S = f.S;
  ctx.fillStyle = P0.bg; ctx.fillRect(0, 0, g.VW, g.VH);
  if (fx.weave) { ctx.strokeStyle = P0.line; ctx.globalAlpha = .28; ctx.lineWidth = u * .05; for (let x = 0; x < g.VW; x += u * .9) line(ctx, x, 0, x, g.VH); for (let y = 0; y < g.VH; y += u * .9) line(ctx, 0, y, g.VW, y); ctx.globalAlpha = 1; }
  if (fx.halftone) { const lv = Math.round(f.loud * 5); ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); const cell = Math.max(4, Math.round(u * 1.1 * devScale)); ctx.fillStyle = dotPattern("ht", cell, cell * (.12 + lv * .07), P0.line, false); ctx.fillRect(0, 0, cv.width, cv.height); ctx.restore(); }
  drawBase(f, P0, g, u);
  if (V.layers.panels.show) out.forEach(o => {
    const pk = L.eff(o.leaf, "panel") ?? o.leaf.panel; if (pk === "blank" || !PANELS[pk]) return;
    const r = o.rect, x = r.x + g.gap / 2, y = r.y + g.gap / 2, w = r.w - g.gap, h = r.h - g.gap;
    if (w < u * 3 || h < u * 3) return;
    const pc = L.eff(o.leaf, "color"), P = pc ? Object.assign({}, P0, { a1: pc }) : P0, def = PANELS[pk];
    // 中身を別のパネルに替えたら、前のパネルの粒などの状態は捨てる（形の違う状態を読んで壊れないように）
    if (kindOf.get(o.leaf.id) !== pk) {
      delete rt.parts[o.leaf.id];
      delete rt.sy[o.leaf.id];
      kindOf.set(o.leaf.id, pk);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    try {
      chrome(ctx, x, y, w, h, P, u, L.eff(o.leaf, "style"));
      const cr = label(ctx, x, y, w, h, P, u, def, f);
      // LED にするパネルには、1粒の大きさ（書き出しの画素）を教える（動く文字を粒の幅ずつ動かして、チラつかせない）
      const ledV = L.eff(o.leaf, "led"), ledOn = ledV == null ? (fx.led || !!def.led) : ledV;
      rt.ledCell = ledOn ? ledCell(u) / devScale : 0;
      if (cr.w > u && cr.h > u) def.draw(ctx, cr, f, P, u, o.leaf);
    } catch (err) {
      // 1枚のパネルが壊れても、ほかは描き続ける（状態を捨てて、次のコマでやり直す）
      delete rt.parts[o.leaf.id];
      if (!failed.has(pk)) {
        failed.add(pk);
        console.error(`パネル「${def.ja}」を描けませんでした`, err);
      }
    } finally {
      ctx.restore();
    }
    const led = L.eff(o.leaf, "led"); if (led == null ? (fx.led || def.led) : led) ledify(x, y, w, h, P, u);
  });
  drawTop(f, P0, g, u);
  if (fx.sumi && f.isFill) { ctx.globalAlpha = .92; brush(ctx, g.VW * .02, g.VH * (.3 + .4 * noise(f.bar, 41)), g.VW * .98, g.VH * (.3 + .4 * noise(f.bar, 42)), Math.min(g.VW, g.VH) * .09, Math.min(1, f.fillAmt * 3), f.bar * 13, isDark(P0.bg) ? P0.ink : P0.ink); ctx.globalAlpha = 1; }
  // 版ズレはキックの直後だけ（画面を丸ごと描き直すので、ずっと掛けると重い）
  const zure = fx.zure && f.kick > .35 ? f.kick * u * .7 : 0, gl = fx.glitch ? f.fillAmt : 0;
  if (zure > u * .05 || gl > 0) {
    snctx.setTransform(1, 0, 0, 1, 0, 0); snctx.clearRect(0, 0, snap.width, snap.height); snctx.drawImage(cv, 0, 0);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (zure > u * .05) { const d = zure * devScale; ctx.globalCompositeOperation = isDark(P0.bg) ? "lighter" : "multiply"; ctx.globalAlpha = .28; ctx.drawImage(snap, d, d * .6); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; }
    if (gl > 0) {
      const k = Math.floor(S * 6), W = cv.width, H = cv.height, n = 4 + Math.round(gl * 10);
      for (let i = 0; i < n; i++) { const y = noise(i, k) * H, hh = H * (.01 + .06 * noise(i, k + 1)), sh = (noise(i, k + 2) - .5) * W * .12 * gl; ctx.drawImage(snap, 0, y, W, hh, sh, y, W, hh); }
      ctx.globalAlpha = .7 * gl; ctx.fillStyle = P0.a2; for (let i = 0; i < 3; i++) ctx.fillRect(0, noise(i, k + 9) * H, W, Math.max(1, H * .004));
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  // 下の帯：区切りのある進み具合
  const by = g.VH - u * 1.9, n = 64, bw = (g.VW - u * 6) / n, done = S / TL.totalSteps * n, t = S / TL.totalSteps * TL.seconds;
  for (let i = 0; i < n; i++) { ctx.fillStyle = i < done ? (i % 16 === 15 ? P0.a2 : P0.a1) : P0.line; ctx.fillRect(u * 3 + i * bw + bw * .12, by, bw * .76, u * .55); }
  ctx.fillStyle = P0.dim; ctx.font = `${u * 1.1}px ${DOT}`; ctx.fillText(`${fmtT(t)} / ${fmtT(TL.seconds)}`, u * 3, by - u * .7);
  // 前のコマはモッシュでだけ使う。使わないときは写さない（画面を丸ごと写すので重い）
  if (V.layers.base.mode !== "none" && V.layers.base.treat.mosh) prevX.drawImage(cv, 0, 0);
}

