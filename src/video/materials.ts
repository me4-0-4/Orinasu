import { mulberry } from "./panels.ts";

/** 素材（写真・動画）。重いので曲とは別に、端末の中に置く。 */
export interface Material {
  id: string;
  name: string;
  kind: "image" | "video";
  el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;
  /** どの音で出すか（刻んだ音／ドラム）。null＝どれでも。 */
  tr: "chop" | "drum" | null;
  /** アプリが描いた見本（保存しない）。 */
  sample?: boolean;
  /** 切り替えで最後に飛ばした断片（同じ断片で何度も飛ばさない）。 */
  seek?: number;
}

export function srcSize(m: Material): [number, number] {
  if (m.el instanceof HTMLVideoElement) return [m.el.videoWidth || 16, m.el.videoHeight || 9];
  return [m.el.width, m.el.height];
}
export const matReady = (m: Material): boolean => !(m.el instanceof HTMLVideoElement) || m.el.readyState >= 2;

/** 写真がまだ無いときに使う見本の画像（アプリの中で描く）。 */
export function makeSamples(): Material[] {
  const R = mulberry(99), list: Material[] = [];
  const mk = (w: number, h: number, name: string, fn: (g: CanvasRenderingContext2D, w: number, h: number) => void) => { const c = document.createElement("canvas"); c.width = w; c.height = h; fn(c.getContext("2d")!, w, h); list.push({ id: `sample${list.length}`, name, kind: "image", el: c, tr: null, sample: true }); };
  const lin = (g: CanvasRenderingContext2D, h: number, stops: [number, string][]) => { const gr = g.createLinearGradient(0, 0, 0, h); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; };
  mk(800, 600, "夕焼け.jpg", (g, w, h) => {
    g.fillStyle = lin(g, h, [[0, "#1b2a52"], [.6, "#e2785a"], [1, "#f3c27a"]]); g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff4d6"; g.beginPath(); g.arc(w * .68, h * .55, 70, 0, 7); g.fill();
    g.fillStyle = "#141a2c"; g.beginPath(); g.moveTo(0, h); for (let x = 0; x <= w; x += 20) g.lineTo(x, h * .68 - Math.sin(x * .012) * 60 - R() * 30); g.lineTo(w, h); g.fill();
  });
  mk(600, 800, "人物.jpg", (g, w, h) => {
    g.fillStyle = lin(g, h, [[0, "#6f8fb3"], [1, "#2b3c55"]]); g.fillRect(0, 0, w, h);
    g.fillStyle = "#1b1d22"; g.beginPath(); g.ellipse(w / 2, h * 1.02, w * .48, h * .3, 0, 0, 7); g.fill();
    g.fillStyle = "#c98f73"; g.fillRect(w * .43, h * .55, w * .14, h * .2);
    const sk = g.createRadialGradient(w * .45, h * .4, 20, w / 2, h * .45, 200); sk.addColorStop(0, "#f0c3a4"); sk.addColorStop(1, "#a86b50");
    g.fillStyle = sk; g.beginPath(); g.ellipse(w / 2, h * .43, w * .2, h * .17, 0, 0, 7); g.fill();
    g.fillStyle = "#17110e"; g.beginPath(); g.ellipse(w / 2, h * .3, w * .22, h * .09, 0, Math.PI, 0); g.fill();
    for (const s of [-1, 1]) { g.fillStyle = "#fff"; g.beginPath(); g.ellipse(w / 2 + s * w * .08, h * .42, 18, 9, 0, 0, 7); g.fill(); g.fillStyle = "#1a1412"; g.beginPath(); g.arc(w / 2 + s * w * .08, h * .42, 7, 0, 7); g.fill(); }
    g.strokeStyle = "#7a3f35"; g.lineWidth = 6; g.beginPath(); g.moveTo(w * .45, h * .52); g.quadraticCurveTo(w / 2, h * .54, w * .55, h * .52); g.stroke();
  });
  mk(700, 700, "花.jpg", (g, w, h) => {
    g.fillStyle = "#0d0f12"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#3f7a3a"; g.lineWidth = 10; g.beginPath(); g.moveTo(w * .5, h * .5); g.quadraticCurveTo(w * .4, h * .8, w * .48, h); g.stroke();
    for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2; g.save(); g.translate(w * .5, h * .45); g.rotate(a); const pg = g.createLinearGradient(0, 0, 0, -170); pg.addColorStop(0, "#5d78d8"); pg.addColorStop(1, "#eef2ff"); g.fillStyle = pg; g.beginPath(); g.ellipse(0, -95, 55, 100, 0, 0, 7); g.fill(); g.restore(); }
    g.fillStyle = "#ffe27a"; g.beginPath(); g.arc(w * .5, h * .45, 28, 0, 7); g.fill();
  });
  mk(800, 600, "夜の街.jpg", (g, w, h) => {
    g.fillStyle = "#05060a"; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 60 + R() * 40) { const bh = h * (.3 + R() * .5), bw = 50 + R() * 50; g.fillStyle = "#12141c"; g.fillRect(x, h - bh, bw, bh);
      for (let y = h - bh + 10; y < h - 10; y += 16) for (let xx = x + 6; xx < x + bw - 8; xx += 12) if (R() < .35) { g.fillStyle = R() < .8 ? "#f5d27a" : "#ffffff"; g.fillRect(xx, y, 6, 8); } }
    g.fillStyle = "#ff4f8b"; g.fillRect(w * .2, h * .35, 90, 22); g.fillStyle = "#4fe3ff"; g.fillRect(w * .62, h * .28, 22, 110);
  });
  mk(800, 500, "海.jpg", (g, w, h) => {
    g.fillStyle = lin(g, h, [[0, "#d8e6ee"], [.45, "#9fbccc"], [.46, "#2f5c78"], [1, "#16384e"]]); g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(255,255,255,.7)"; g.lineWidth = 2; for (let k = 0; k < 90; k++) { const y = h * .47 + R() * h * .53, x = R() * w; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 20 + R() * 60, y); g.stroke(); }
    g.strokeStyle = "#1d1d1d"; g.lineWidth = 4; for (let k = 0; k < 6; k++) { const x = w * (.2 + R() * .6), y = h * (.1 + R() * .25); g.beginPath(); g.moveTo(x - 16, y - 6); g.lineTo(x, y); g.lineTo(x + 16, y - 6); g.stroke(); }
  });
  mk(600, 800, "火.jpg", (g, w, h) => {
    g.fillStyle = "#0a0503"; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 4) { const top = h * (.25 + .5 * R()) - Math.sin(x * .02) * 80; const gr = g.createLinearGradient(0, top, 0, h); gr.addColorStop(0, "#fff3b0"); gr.addColorStop(.3, "#ff9a1f"); gr.addColorStop(.8, "#b0220c"); gr.addColorStop(1, "#2a0602"); g.fillStyle = gr; g.fillRect(x, top, 4, h - top); }
  });
  return list;
}
