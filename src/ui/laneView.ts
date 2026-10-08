import type { EnvPoint } from "../mix/fx";
import type { LaneEvent } from "../mix/sequencer";

/** トラックの行：層・下地・伸ばし・マスター。 */
export interface TrackRow {
  type: "track";
  /** トラックの鍵：lane:<曲のid>・bed・pad・master。 */
  key: string;
  kind: "lane" | "bed" | "pad" | "master";
  name: string;
  locked: boolean;
  muted: boolean;
  /** 全体と違う設定（ずらし・切り方・音量・エフェクト）を持っているか。 */
  custom: boolean;
  /** いま選んでいる層か。 */
  selected: boolean;
  events: LaneEvent[];
  /** 鳴っているFXがあるか（FXボタンを光らせる）。 */
  fx: boolean;
  /** テイクFXを持っている断片の位置。 */
  takeSteps?: number[];
}

/** エンベロープの行：トラックの下に出る折れ線。 */
export interface EnvRow {
  type: "env";
  /** エンベロープのid。 */
  key: string;
  label: string;
  points: EnvPoint[];
  active: boolean;
}

export type Row = TrackRow | EnvRow;

export interface LaneViewData {
  rows: Row[];
  totalSteps: number;
  stepsPerBar: number;
  /** 選んでいる断片（テイクFXを開く対象）。 */
  selectedHit?: { track: string; step: number } | null;
}

export interface LaneViewHandlers {
  /** トラックの線の上をタップ：断片の上なら step、空いた所なら null。 */
  onHit: (track: string, step: number | null) => void;
  /** エンベロープを描き変えた（点を足す・動かす・消す）。 */
  onEnvEdit: (id: string, points: EnvPoint[]) => void;
}

export interface LaneView {
  el: HTMLElement;
  setData: (data: LaneViewData | null) => void;
  /** 再生位置（0〜1）。鳴っていないときは null。 */
  setProgress: (t: number | null) => void;
}

/** トラック名などの見出しは、となりの DOM（トラックヘッダー）が描く。ここは線だけ。 */
const GUTTER = 0;
export const HEAD_H = 18;
export const ROW_H = 34;
export const ENV_H = 40;
const EMPTY_H = 72;
const POINT_R = 4;
const ENV_PAD = 5;

/**
 * トラックの表示（DAW 風のアレンジ画面の、線の部分）。1行が1トラック：刻む曲・ドラムループ・パッド・マスター。
 * 名前・ミュート・音量・FX は、となりのトラックヘッダー（DOM）に置く。行の高さは ROW_H／ENV_H でそろえる。
 * 線の上の小さな棒が「打った断片」（色は断片の番号、上下は音程）。断片をタップすると選べる（テイクFXを開ける）。
 * トラックの下には、エンベロープ（つまみを時間で動かす折れ線）が出る：
 * 空いた所をタップで点を足し、点をドラッグで動かし、点をダブルタップ（右クリック）で消す。
 */
export function buildLaneView(handlers: LaneViewHandlers): LaneView {
  const root = document.createElement("div");
  root.className = "lane-view";
  const canvas = document.createElement("canvas");
  canvas.className = "lane-canvas";
  root.appendChild(canvas);
  const g = canvas.getContext("2d")!;

  let data: LaneViewData | null = null;
  let progress: number | null = null;
  let width = 400;
  /** ドラッグ中のエンベロープ（描き終わるまで、ここで動かす）。 */
  let drag: { id: string; points: EnvPoint[]; index: number; moved: boolean; added: boolean } | null = null;

  const css = (name: string, fallback: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const rowHeight = (r: Row): number => (r.type === "env" ? ENV_H : ROW_H);
  const heightNow = (): number =>
    data && data.rows.length > 0 ? HEAD_H + data.rows.reduce((a, r) => a + rowHeight(r), 0) + 6 : EMPTY_H;
  const plotW = (): number => Math.max(1, width - GUTTER);
  const xOf = (step: number): number => GUTTER + (step / Math.max(1, data?.totalSteps ?? 1)) * plotW();
  const stepOf = (x: number): number => ((x - GUTTER) / plotW()) * (data?.totalSteps ?? 1);

  /** y から、行と、その行の上端。 */
  function rowAt(y: number): { row: Row; top: number } | null {
    if (!data) return null;
    let top = HEAD_H;
    for (const row of data.rows) {
      const h = rowHeight(row);
      if (y >= top && y < top + h) return { row, top };
      top += h;
    }
    return null;
  }

  const envY = (top: number, v: number): number => top + ENV_PAD + (1 - v) * (ENV_H - 2 * ENV_PAD);
  const envV = (top: number, y: number): number => Math.min(1, Math.max(0, 1 - (y - top - ENV_PAD) / (ENV_H - 2 * ENV_PAD)));

  function draw(): void {
    const height = heightNow();
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = `${height}px`;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const dim = css("--text-dim", "#9a9ba6");
    const border = css("--border", "#2a2c36");
    const green = css("--accent-green", "#3ee6b0");
    g.font = "11px sans-serif";
    g.textBaseline = "middle";

    if (!data || data.rows.length === 0) {
      g.fillStyle = dim;
      g.fillText("右の「素材」でフレーズを選んで、上の「刻む」を押すと、ここにトラックが並ぶ", 8, height / 2);
      return;
    }

    const sx = plotW() / data.totalSteps;
    const bars = Math.round(data.totalSteps / data.stepsPerBar);
    for (let s = 0; s <= data.totalSteps; s += data.stepsPerBar / 4) {
      const x = GUTTER + s * sx;
      const isBar = s % data.stepsPerBar === 0;
      const isUnit = s % (data.stepsPerBar * 4) === 0;
      g.strokeStyle = isUnit ? "rgba(255,255,255,0.32)" : isBar ? border : "rgba(255,255,255,0.04)";
      g.beginPath();
      g.moveTo(x, isBar ? 0 : HEAD_H);
      g.lineTo(x, height);
      g.stroke();
    }
    g.fillStyle = dim;
    for (let b = 0; b < bars; b++) g.fillText(String(b + 1), GUTTER + b * data.stepsPerBar * sx + 3, HEAD_H / 2);

    let top = HEAD_H;
    for (const row of data.rows) {
      const h = rowHeight(row);
      const mid = top + h / 2;
      if (row.type === "track") {
        if (row.selected) {
          g.fillStyle = "rgba(255,255,255,0.07)";
          g.fillRect(0, top, width, h);
          g.fillStyle = green;
          g.fillRect(0, top + 2, 3, h - 4);
        } else if (row.kind !== "lane") {
          g.fillStyle = "rgba(255,255,255,0.03)";
          g.fillRect(0, top, width, h);
        } else if (row.locked) {
          g.fillStyle = "rgba(94,180,255,0.10)";
          g.fillRect(0, top, width, h);
        }
        if (row.kind === "lane" || row.kind === "bed") {
          g.strokeStyle = "rgba(255,255,255,0.18)";
          g.beginPath();
          g.moveTo(GUTTER, mid);
          g.lineTo(width, mid);
          g.stroke();
        }
        if (row.kind === "bed") {
          g.fillStyle = "rgba(200,200,210,0.55)";
          for (const ev of row.events) g.fillRect(GUTTER + ev.step * sx, mid - 5, Math.max(1.5, sx * 0.6), 10);
        } else if (row.kind === "lane") {
          g.globalAlpha = row.muted ? 0.25 : 1;
          const takes = new Set(row.takeSteps ?? []);
          const sel = data.selectedHit?.track === row.key ? data.selectedHit.step : null;
          for (const ev of row.events) {
            const y = mid - 3 - (ev.pitch / 12) * 8;
            const x = GUTTER + ev.step * sx;
            const w = Math.max(2, ev.len * sx - 1);
            g.fillStyle = `hsl(${(ev.slice * 47) % 360} 75% 62%)`;
            g.fillRect(x, y, w, 6);
            if (takes.has(ev.step)) {
              // テイクFXのある断片：上に小さな印
              g.fillStyle = green;
              g.fillRect(x, y - 4, Math.min(w, 6), 2);
            }
            if (sel === ev.step) {
              g.strokeStyle = "#ffc450";
              g.lineWidth = 2;
              g.strokeRect(x - 1, y - 2, w + 2, 10);
              g.lineWidth = 1;
            }
          }
          g.globalAlpha = 1;
        } else {
          g.fillStyle = dim;
          g.fillText(row.kind === "master" ? "曲のぜんぶ（最後にFX）" : "和音を伸ばした音（うしろでうっすら）", GUTTER + 6, mid);
        }
      } else {
        // エンベロープ：折れ線と点
        const points = drag?.id === row.key ? drag.points : row.points;
        g.fillStyle = "rgba(255,196,80,0.05)";
        g.fillRect(0, top, width, h);
        g.strokeStyle = row.active ? "#ffc450" : "rgba(255,255,255,0.3)";
        g.lineWidth = 1.5;
        g.beginPath();
        const first = points[0];
        g.moveTo(GUTTER, envY(top, first ? first.v : 0));
        for (const p of points) g.lineTo(xOf(p.t), envY(top, p.v));
        const last = points[points.length - 1];
        g.lineTo(width, envY(top, last ? last.v : 0));
        g.stroke();
        g.lineWidth = 1;
        g.fillStyle = row.active ? "#ffc450" : dim;
        for (const p of points) {
          g.beginPath();
          g.arc(xOf(p.t), envY(top, p.v), POINT_R, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.strokeStyle = "rgba(255,255,255,0.05)";
      g.beginPath();
      g.moveTo(0, top + h - 0.5);
      g.lineTo(width, top + h - 0.5);
      g.stroke();
      top += h;
    }

    if (progress !== null) {
      const x = GUTTER + progress * plotW();
      g.strokeStyle = "#ffffff";
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
    }
  }

  const local = (e: MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** エンベロープの点のうち、(x, y) に近いもの。 */
  function nearPoint(points: EnvPoint[], top: number, x: number, y: number): number {
    let best = -1;
    let bestD = (POINT_R + 6) ** 2;
    points.forEach((p, i) => {
      const d = (xOf(p.t) - x) ** 2 + (envY(top, p.v) - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  // トラックの行：名前・FXボタン・断片
  canvas.addEventListener("click", (e) => {
    if (!data) return;
    const { x, y } = local(e);
    const hit = rowAt(y);
    if (!hit || hit.row.type !== "track") return;
    const row = hit.row;
    if (row.kind !== "lane") {
      handlers.onHit(row.key, null);
      return;
    }
    const step = stepOf(x);
    let best: LaneEvent | undefined;
    let bestD = Infinity;
    for (const ev of row.events) {
      const d = step < ev.step ? ev.step - step : step > ev.step + ev.len ? step - ev.step - ev.len : 0;
      if (d < bestD) {
        bestD = d;
        best = ev;
      }
    }
    // 細い棒でも押しやすいよう、少し離れていても近い断片を選ぶ（画面で10pxくらいまで）
    const slack = Math.max(1, 10 / (plotW() / data.totalSteps));
    handlers.onHit(row.key, best && bestD <= slack ? best.step : null);
  });

  // エンベロープの行：点を足す・動かす
  canvas.addEventListener("pointerdown", (e) => {
    if (!data) return;
    const { x, y } = local(e);
    const hit = rowAt(y);
    if (!hit || hit.row.type !== "env" || x < GUTTER || e.button === 2) return;
    const row = hit.row;
    const points = row.points.map((p) => ({ ...p }));
    let index = nearPoint(points, hit.top, x, y);
    const added = index < 0;
    if (added) {
      const t = Math.round(Math.min(data.totalSteps, Math.max(0, stepOf(x))));
      points.push({ t, v: envV(hit.top, y) });
      points.sort((a, b) => a.t - b.t || 0);
      index = points.findIndex((p) => p.t === t);
    }
    drag = { id: row.key, points, index, moved: false, added };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || !data) return;
    const { x, y } = local(e);
    let top = HEAD_H;
    for (const r of data.rows) {
      if (r.type === "env" && r.key === drag.id) break;
      top += rowHeight(r);
    }
    const p = drag.points[drag.index];
    const prev = drag.points[drag.index - 1];
    const next = drag.points[drag.index + 1];
    // 前後の点を追い越さない（順番を保つ）。16分の格子にそろえる
    let t = Math.round(Math.min(data.totalSteps, Math.max(0, stepOf(x))));
    if (prev) t = Math.max(prev.t, t);
    if (next) t = Math.min(next.t, t);
    p.t = t;
    p.v = envV(top, y);
    drag.moved = true;
    draw();
  });
  const finish = (): void => {
    if (!drag) return;
    const { id, points, moved, added } = drag;
    drag = null;
    if (moved || added) handlers.onEnvEdit(id, points);
    else draw();
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", () => {
    drag = null;
    draw();
  });
  // 点を消す：ダブルタップ／右クリック
  const removeAt = (e: MouseEvent): boolean => {
    if (!data) return false;
    const { x, y } = local(e);
    const hit = rowAt(y);
    if (!hit || hit.row.type !== "env") return false;
    const i = nearPoint(hit.row.points, hit.top, x, y);
    if (i < 0 || hit.row.points.length <= 1) return false;
    handlers.onEnvEdit(hit.row.key, hit.row.points.filter((_, j) => j !== i));
    return true;
  };
  canvas.addEventListener("dblclick", (e) => {
    removeAt(e);
  });
  canvas.addEventListener("contextmenu", (e) => {
    if (removeAt(e)) e.preventDefault();
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
      if (!drag) draw();
    },
    setProgress(t) {
      if (t === progress) return;
      progress = t;
      if (!drag) draw();
    },
  };
}
