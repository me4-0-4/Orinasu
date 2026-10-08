import type { LaneEvent } from "../mix/sequencer";

/** 1本の線に描く層。 */
export interface LaneRow {
  name: string;
  locked: boolean;
  muted: boolean;
  /** 全体と違う形（ずらし・切り方・音量）を持っているか。 */
  custom: boolean;
  /** いま選んでいる層か。 */
  selected: boolean;
  events: LaneEvent[];
}

export interface LaneViewData {
  lanes: LaneRow[];
  /** 下地（鳴らしっぱなしのドラム）。いちばん下に灰色で描く。 */
  bed?: { name: string; events: LaneEvent[] } | null;
  /** エフェクトの「いつ掛けるか」の印：掛ける小節（0から）と、選んだ断片（laneIndex の層の steps）。 */
  highlight?: { laneIndex?: number; steps?: number[]; bars?: number[]; picking: boolean } | null;
  totalSteps: number;
  stepsPerBar: number;
}

export interface LaneView {
  el: HTMLElement;
  setData: (data: LaneViewData | null) => void;
  /** 再生位置（0〜1）。鳴っていないときは null。 */
  setProgress: (t: number | null) => void;
}

const GUTTER = 96;
const HEAD_H = 16;
const ROW_H = 30;
const EMPTY_H = 72;

/**
 * phrz の円環を、横に並べた直線にしたもの。層（＝刻む曲）1つが1本の線で、左が頭、右が終わり。
 * 線の上の小さな棒が「打った断片」。色は断片の番号（同じ色＝同じ断片の連打）、上下の位置は音程。
 * 左の名前をタップすると、その層を選べる（選んだ層は、その層だけの形を変えられる）。
 */
export function buildLaneView(
  onLaneClick: (index: number) => void,
  /** 線の上（断片のある所）をタップした：何番目の層の、どの断片（打つ位置のステップ）か。 */
  onHitClick?: (index: number, step: number) => void,
): LaneView {
  const root = document.createElement("div");
  root.className = "lane-view";
  const canvas = document.createElement("canvas");
  canvas.className = "lane-canvas";
  root.appendChild(canvas);
  const g = canvas.getContext("2d")!;

  let data: LaneViewData | null = null;
  let progress: number | null = null;
  let width = 400;

  const css = (name: string, fallback: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const rowCount = (): number => (data ? data.lanes.length + (data.bed ? 1 : 0) : 0);
  const heightNow = (): number => (data && data.lanes.length > 0 ? HEAD_H + rowCount() * ROW_H + 6 : EMPTY_H);

  function draw(): void {
    const height = heightNow();
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = `${height}px`;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const dim = css("--text-dim", "#9a9ba6");
    const text = css("--text", "#e8e8ee");
    const border = css("--border", "#2a2c36");
    const blue = css("--accent-blue", "#5eb4ff");
    g.font = "11px sans-serif";
    g.textBaseline = "middle";

    if (!data || data.lanes.length === 0) {
      g.fillStyle = dim;
      g.fillText("「刻む」を押すと、ここに層（選んだ曲）ごとの線が出る", 8, height / 2);
      return;
    }

    const plotW = Math.max(1, width - GUTTER);
    const sx = plotW / data.totalSteps;
    const bars = Math.round(data.totalSteps / data.stepsPerBar);

    // 小節と拍の目盛り
    for (let s = 0; s <= data.totalSteps; s += data.stepsPerBar / 4) {
      const x = GUTTER + s * sx;
      const isBar = s % data.stepsPerBar === 0;
      const isUnit = s % (data.stepsPerBar * 4) === 0; // 4小節のまとまり（音楽モードのくり返しの単位）
      g.strokeStyle = isUnit ? "rgba(255,255,255,0.32)" : isBar ? border : "rgba(255,255,255,0.04)";
      g.beginPath();
      g.moveTo(x, isBar ? 0 : HEAD_H);
      g.lineTo(x, height);
      g.stroke();
    }
    // エフェクトを掛ける小節の印
    const hl = data.highlight;
    canvas.style.cursor = hl?.picking ? "pointer" : "";
    if (hl?.bars) {
      g.fillStyle = "rgba(255,196,80,0.13)";
      for (const b of hl.bars) g.fillRect(GUTTER + b * data.stepsPerBar * sx, 0, data.stepsPerBar * sx, height);
    }
    g.fillStyle = dim;
    for (let b = 0; b < bars; b++) g.fillText(String(b + 1), GUTTER + b * data.stepsPerBar * sx + 3, HEAD_H / 2);

    data.lanes.forEach((lane, i) => {
      const top = HEAD_H + i * ROW_H;
      const mid = top + ROW_H / 2;
      if (lane.selected) {
        g.fillStyle = "rgba(255,255,255,0.07)";
        g.fillRect(0, top, width, ROW_H);
        g.fillStyle = css("--accent-green", "#3ee6b0");
        g.fillRect(0, top + 2, 3, ROW_H - 4);
      } else if (lane.locked) {
        g.fillStyle = "rgba(94,180,255,0.10)";
        g.fillRect(0, top, width, ROW_H);
      }
      g.fillStyle = lane.muted ? dim : lane.locked ? blue : text;
      g.fillText(`${lane.locked ? "● " : ""}${lane.name}${lane.custom ? " ＊" : ""}`, 8, mid, GUTTER - 12);
      // 線
      g.strokeStyle = "rgba(255,255,255,0.18)";
      g.beginPath();
      g.moveTo(GUTTER, mid);
      g.lineTo(width, mid);
      g.stroke();
      // 打った断片
      g.globalAlpha = lane.muted ? 0.25 : 1;
      for (const ev of lane.events) {
        const hue = (ev.slice * 47) % 360;
        g.fillStyle = `hsl(${hue} 75% 62%)`;
        const y = mid - 3 - (ev.pitch / 12) * 8;
        g.fillRect(GUTTER + ev.step * sx, y, Math.max(2, ev.len * sx - 1), 6);
      }
      g.globalAlpha = 1;
      // 選んでいる最中の層は枠で囲み、選んだ断片は明るい枠で示す
      if (hl?.laneIndex === i) {
        if (hl.picking) {
          g.strokeStyle = "rgba(255,196,80,0.7)";
          g.strokeRect(GUTTER + 0.5, top + 1.5, width - GUTTER - 1, ROW_H - 3);
        }
        const chosen = new Set(hl.steps ?? []);
        g.strokeStyle = "#ffc450";
        g.lineWidth = 2;
        for (const ev of lane.events) {
          if (!chosen.has(ev.step)) continue;
          const y = mid - 3 - (ev.pitch / 12) * 8;
          g.strokeRect(GUTTER + ev.step * sx - 1, y - 2, Math.max(2, ev.len * sx - 1) + 2, 10);
        }
        g.lineWidth = 1;
      }
    });

    if (data.bed) {
      // 下地：刻まずに鳴らしっぱなしのドラム（打つ所を灰色の細い棒で）
      const top = HEAD_H + data.lanes.length * ROW_H;
      const mid = top + ROW_H / 2;
      g.fillStyle = "rgba(255,255,255,0.04)";
      g.fillRect(0, top, width, ROW_H);
      g.fillStyle = dim;
      g.fillText(`下地 ${data.bed.name}`, 8, mid, GUTTER - 12);
      g.fillStyle = "rgba(200,200,210,0.55)";
      for (const ev of data.bed.events) g.fillRect(GUTTER + ev.step * sx, mid - 5, Math.max(1.5, sx * 0.6), 10);
    }

    if (progress !== null) {
      const x = GUTTER + progress * plotW;
      g.strokeStyle = "#ffffff";
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
    }
  }

  canvas.addEventListener("click", (e) => {
    if (!data) return;
    const r = canvas.getBoundingClientRect();
    const i = Math.floor((e.clientY - r.top - HEAD_H) / ROW_H);
    if (i < 0 || i >= data.lanes.length) return;
    const x = e.clientX - r.left;
    if (x <= GUTTER) {
      onLaneClick(i);
      return;
    }
    // 線の上：タップした所にある断片（無ければ、いちばん近い断片）
    const step = ((x - GUTTER) / Math.max(1, width - GUTTER)) * data.totalSteps;
    const events = data.lanes[i].events;
    let best: LaneEvent | undefined;
    let bestD = Infinity;
    for (const ev of events) {
      const d = step < ev.step ? ev.step - step : step > ev.step + ev.len ? step - ev.step - ev.len : 0;
      if (d < bestD) {
        bestD = d;
        best = ev;
      }
    }
    if (best && bestD <= 1.5) onHitClick?.(i, best.step);
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
    setData(next) {
      data = next;
      draw();
    },
    setProgress(t) {
      if (t === progress) return;
      progress = t;
      draw();
    },
  };
}
