import type { LaneEvent } from "../mix/sequencer";

/** 1本の線に描く層。 */
export interface LaneRow {
  name: string;
  locked: boolean;
  events: LaneEvent[];
}

export interface LaneViewData {
  lanes: LaneRow[];
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
 * 左の名前をタップすると、その層を固定できる。
 */
export function buildLaneView(onLaneClick: (index: number) => void): LaneView {
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
  const heightNow = (): number => (data && data.lanes.length > 0 ? HEAD_H + data.lanes.length * ROW_H + 6 : EMPTY_H);

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
      g.strokeStyle = isBar ? border : "rgba(255,255,255,0.04)";
      g.beginPath();
      g.moveTo(x, isBar ? 0 : HEAD_H);
      g.lineTo(x, height);
      g.stroke();
    }
    g.fillStyle = dim;
    for (let b = 0; b < bars; b++) g.fillText(String(b + 1), GUTTER + b * data.stepsPerBar * sx + 3, HEAD_H / 2);

    data.lanes.forEach((lane, i) => {
      const top = HEAD_H + i * ROW_H;
      const mid = top + ROW_H / 2;
      if (lane.locked) {
        g.fillStyle = "rgba(94,180,255,0.12)";
        g.fillRect(0, top, width, ROW_H);
      }
      g.fillStyle = lane.locked ? blue : text;
      g.fillText(`${lane.locked ? "● " : ""}${lane.name}`, 6, mid, GUTTER - 10);
      // 線
      g.strokeStyle = "rgba(255,255,255,0.18)";
      g.beginPath();
      g.moveTo(GUTTER, mid);
      g.lineTo(width, mid);
      g.stroke();
      // 打った断片
      for (const ev of lane.events) {
        const hue = (ev.slice * 47) % 360;
        g.fillStyle = `hsl(${hue} 75% 62%)`;
        const y = mid - 3 - (ev.pitch / 12) * 8;
        g.fillRect(GUTTER + ev.step * sx, y, Math.max(2, ev.len * sx - 1), 6);
      }
    });

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
    if (e.clientX - r.left > GUTTER) return;
    const i = Math.floor((e.clientY - r.top - HEAD_H) / ROW_H);
    if (i >= 0 && i < data.lanes.length) onLaneClick(i);
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
