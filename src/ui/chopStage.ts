import { chopBarLabels, type ChopKind } from "../mix/chop";
import { sectionBeats, type Section } from "../mix/types";
import { roleLabels } from "../phrase/types";

export interface ChopStage {
  el: HTMLElement;
  /** いまのセクション（無ければ null）と、固定している小節。層ごとの音符と、刻み方の帯を描く。 */
  setSection: (section: Section | null, locked?: ReadonlySet<number>) => void;
}

const GUTTER = 96;
const LABEL_H = 16;
const BAND_H = 8;
const ROW_H = 22;
const PAD = 6;

const kindColors: Record<ChopKind, string> = {
  play: "rgba(255,255,255,0.10)",
  jump: "#5eb4ff",
  stutter: "#ff6f4d",
  reverse: "#ffd166",
  fill: "#ff9f4d",
  break: "#9a6bff",
};

/** onBarClick：小節（0から数える）をタップしたとき。固定の切り替えに使う。 */
export function buildChopStage(onBarClick: (bar: number) => void): ChopStage {
  const root = document.createElement("div");
  root.className = "chop-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "chop-canvas";
  root.appendChild(canvas);
  const g = canvas.getContext("2d")!;

  let section: Section | null = null;
  let locked: ReadonlySet<number> = new Set();
  let width = 400;

  const css = (name: string, fallback: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function heightFor(rows: number): number {
    return rows === 0 ? 64 : LABEL_H + BAND_H + PAD + rows * ROW_H + PAD;
  }

  function draw(): void {
    const rows = section?.layers.length ?? 0;
    const height = heightFor(rows);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = `${height}px`;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const dim = css("--text-dim", "#9a9ba6");
    const border = css("--border", "#2a2c36");
    g.font = "11px sans-serif";
    g.textBaseline = "middle";

    if (!section || rows === 0) {
      g.fillStyle = dim;
      g.fillText("「振る」で、ここに刻み方が出る", 8, height / 2);
      return;
    }

    const beats = sectionBeats(section);
    const plotW = Math.max(1, width - GUTTER);
    const sx = plotW / beats;
    const bpb = section.beatsPerBar;
    const bars = Math.max(1, Math.round(beats / bpb));

    // 刻み方の帯と、小節ごとの説明
    const bandY = LABEL_H;
    for (const seg of section.plan ?? []) {
      g.fillStyle = kindColors[seg.kind];
      g.fillRect(GUTTER + seg.dst * sx, bandY, Math.max(1, seg.len * sx - 1), BAND_H);
    }
    const byId: Record<string, string> = {};
    for (const l of section.layers) if (l.srcPhraseId) byId[l.srcPhraseId] = (l.sourceLabel ?? "").split("・")[0];
    const labels = section.plan
      ? chopBarLabels(section.plan, bpb, section.baseId ? { baseId: section.baseId, byId } : undefined)
      : [];
    for (let b = 0; b < bars; b++) {
      const x = GUTTER + b * bpb * sx;
      if (locked.has(b)) {
        g.fillStyle = "rgba(94,180,255,0.16)";
        g.fillRect(x, 0, bpb * sx, height);
      }
      g.strokeStyle = border;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
      if (labels[b]) {
        g.fillStyle = labels[b] === "そのまま" ? dim : css("--text", "#e8e8ee");
        g.fillText(`${locked.has(b) ? "● " : ""}${labels[b]}`, x + 3, LABEL_H / 2, bpb * sx - 4);
      }
    }

    // 層ごとの音符
    const accent = css("--accent-green", "#3ee6b0");
    section.layers.forEach((layer, i) => {
      const top = LABEL_H + BAND_H + PAD + i * ROW_H;
      g.fillStyle = dim;
      g.fillText(layer.sourceLabel ?? roleLabels[layer.role], 4, top + ROW_H / 2, GUTTER - 8);
      g.strokeStyle = border;
      g.beginPath();
      g.moveTo(GUTTER, top + ROW_H);
      g.lineTo(width, top + ROW_H);
      g.stroke();
      if (layer.notes.length === 0) return;
      const pitches = layer.notes.map((n) => n.pitch);
      const lo = Math.min(...pitches);
      const hi = Math.max(...pitches);
      const span = Math.max(1, hi - lo);
      g.fillStyle = accent;
      g.globalAlpha = layer.muted ? 0.25 : 1;
      for (const n of layer.notes) {
        const y = top + 3 + (1 - (n.pitch - lo) / span) * (ROW_H - 9);
        g.fillRect(GUTTER + n.startBeats * sx, y, Math.max(2, n.durationBeats * sx - 1), 4);
      }
      g.globalAlpha = 1;
    });
  }

  canvas.style.cursor = "pointer";
  canvas.addEventListener("click", (e) => {
    if (!section) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left - GUTTER;
    if (x < 0) return;
    const bpb = section.beatsPerBar;
    const bars = Math.max(1, Math.round(sectionBeats(section) / bpb));
    const bar = Math.floor((x / Math.max(1, width - GUTTER)) * bars);
    if (bar >= 0 && bar < bars) onBarClick(bar);
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
    setSection(next, nextLocked = new Set()) {
      section = next;
      locked = nextLocked;
      draw();
    },
  };
}
