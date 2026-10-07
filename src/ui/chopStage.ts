import { chopBarLabels, isSilent, type ChopKind, type ChopSegment } from "../mix/chop";

/** ステージに描く内容：刻んだ曲の波形と、刻み方の計画。 */
export interface StageView {
  plan: ChopSegment[];
  /** メインにした曲のid（それ以外から取った小節には「←曲名」が付く）。 */
  baseId: string;
  /** 曲のid→名前。 */
  names: Record<string, string>;
  bars: number;
  beatsPerBar: number;
  /** 波形の見た目用の山（0〜1）。 */
  peaks: Float32Array;
}

export interface ChopStage {
  el: HTMLElement;
  /** 刻んだ曲（無ければ null）と、固定している小節（0から数える）。 */
  setView: (view: StageView | null, locked?: ReadonlySet<number>) => void;
  /** 再生位置（0〜1）。鳴っていないときは null。 */
  setProgress: (t: number | null) => void;
}

const LABEL_H = 16;
const BAND_H = 8;
const WAVE_H = 76;
const PAD = 6;
const HEIGHT = LABEL_H + BAND_H + WAVE_H + PAD;

const kindColors: Record<ChopKind, string> = {
  play: "rgba(255,255,255,0.10)",
  jump: "#5eb4ff",
  stutter: "#ff6f4d",
  reverse: "#ffd166",
  fill: "#ff9f4d",
  break: "#9a6bff",
  double: "#3ee6b0",
  half: "#c58bff",
  scatter: "#ff5fa2",
  roll: "#ffa94d",
};

/** onBarClick：小節（0から数える）をタップしたとき。固定の切り替えに使う。 */
export function buildChopStage(onBarClick: (bar: number) => void): ChopStage {
  const root = document.createElement("div");
  root.className = "chop-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "chop-canvas";
  canvas.style.height = `${HEIGHT}px`;
  canvas.style.cursor = "pointer";
  root.appendChild(canvas);
  const g = canvas.getContext("2d")!;

  let view: StageView | null = null;
  let locked: ReadonlySet<number> = new Set();
  let progress: number | null = null;
  let width = 400;

  const css = (name: string, fallback: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(HEIGHT * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, HEIGHT);
    const dim = css("--text-dim", "#9a9ba6");
    const border = css("--border", "#2a2c36");
    g.font = "11px sans-serif";
    g.textBaseline = "middle";

    if (!view) {
      g.fillStyle = dim;
      g.fillText("「刻む」を押すと、ここに刻んだ曲の波形が出る", 8, HEIGHT / 2);
      return;
    }

    const { plan, bars, beatsPerBar: bpb } = view;
    const totalBeats = bars * bpb;
    const sx = width / totalBeats;
    const waveTop = LABEL_H + BAND_H;
    const mid = waveTop + WAVE_H / 2;

    // 固定した小節の色
    for (const b of locked) {
      if (b < 0 || b >= bars) continue;
      g.fillStyle = "rgba(94,180,255,0.16)";
      g.fillRect(b * bpb * sx, 0, bpb * sx, HEIGHT);
    }

    // 刻み方の帯
    for (const seg of plan) {
      g.fillStyle = seg.mute ? "rgba(255,255,255,0.06)" : kindColors[seg.kind];
      g.fillRect(seg.dst * sx, LABEL_H, Math.max(1, seg.len * sx - 1), BAND_H);
    }

    // 波形（無音の区間は暗く）
    const accent = css("--accent-green", "#3ee6b0");
    const silent = plan.filter((s) => isSilent(s));
    const n = view.peaks.length;
    for (let x = 0; x < width; x++) {
      const p = view.peaks[Math.min(n - 1, Math.floor((x / width) * n))] ?? 0;
      const beat = x / sx;
      const isSilent = silent.some((s) => beat >= s.dst && beat < s.dst + s.len);
      g.fillStyle = isSilent ? "rgba(255,255,255,0.12)" : accent;
      const h = Math.max(1, p * (WAVE_H - 4));
      g.fillRect(x, mid - h / 2, 1, h);
    }

    // 小節の線とラベル
    const labels = chopBarLabels(plan, bpb, { baseId: view.baseId, byId: view.names });
    for (let b = 0; b < bars; b++) {
      const x = b * bpb * sx;
      g.strokeStyle = border;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, HEIGHT);
      g.stroke();
      if (labels[b]) {
        g.fillStyle = labels[b] === "そのまま" ? dim : css("--text", "#e8e8ee");
        g.fillText(`${locked.has(b) ? "● " : ""}${labels[b]}`, x + 3, LABEL_H / 2, bpb * sx - 4);
      }
    }

    if (progress !== null) {
      g.strokeStyle = "#ffffff";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(progress * width, 0);
      g.lineTo(progress * width, HEIGHT);
      g.stroke();
    }
  }

  canvas.addEventListener("click", (e) => {
    if (!view) return;
    const r = canvas.getBoundingClientRect();
    const bar = Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * view.bars);
    if (bar >= 0 && bar < view.bars) onBarClick(bar);
  });

  new ResizeObserver((entries) => {
    const w = entries[0].contentRect.width;
    if (w > 0 && Math.abs(w - width) > 0.5) {
      width = w;
      draw();
    }
  }).observe(canvas);
  draw();

  return {
    el: root,
    setView(next, nextLocked = new Set()) {
      view = next;
      locked = nextLocked;
      draw();
    },
    setProgress(t) {
      if (t === progress) return;
      progress = t;
      draw();
    },
  };
}
