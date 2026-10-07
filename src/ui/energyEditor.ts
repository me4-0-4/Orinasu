import {
  curveShapeLabels,
  energyAt,
  macroInfo,
  macroOrder,
  normalizeCurve,
  paintCurve,
  shapeCurve,
  type CurveShape,
  type EnergyCurve,
  type EnergyPoint,
  type Macro,
} from "../mix/energy";
import { sectionBeats, type Section } from "../mix/types";

export interface EnergyEditorHandlers {
  onEnabledChange: (enabled: boolean) => void;
  onCurveChange: (curve: EnergyCurve) => void;
  onMacrosChange: (macros: Macro[]) => void;
}

export interface EnergyEditor {
  el: HTMLElement;
  setData: (curve: EnergyCurve, macros: Macro[], sections: Section[], enabled: boolean) => void;
  /** 再生位置（0〜1）。鳴っていないときはnull。 */
  setProgress: (t: number | null) => void;
}

const HEIGHT = 110;
const PAD_Y = 10;
const GRAB_PX = 14;

export function buildEnergyEditor(handlers: EnergyEditorHandlers): EnergyEditor {
  let curve: EnergyCurve = [];
  let macros: Macro[] = [];
  let sections: Section[] = [];
  let progress: number | null = null;
  let enabled = false;
  let width = 600;
  /** ドラッグ中に動かしている点の番号。ペンでなぞっているときは null。 */
  let dragIndex: number | null = null;
  let stroke: EnergyPoint[] | null = null;
  let strokeBase: EnergyCurve = [];
  /** 変える前の線（「ひとつ戻す」用）。新しいものが後ろ。 */
  const history: EnergyCurve[] = [];
  /** 操作の最中だけ持つ、操作を始める前の線。変わっていたら履歴に積む。 */
  let pending: EnergyCurve | null = null;

  const root = document.createElement("div");
  root.className = "energy-editor";

  // 見出し：山を使うかどうかのスイッチ。オフのあいだは、これだけ見せる
  const switchRow = document.createElement("label");
  switchRow.className = "preset-row energy-switch";
  const useCheck = document.createElement("input");
  useCheck.type = "checkbox";
  useCheck.addEventListener("change", () => {
    enabled = useCheck.checked;
    applyEnabled();
    draw();
    handlers.onEnabledChange(enabled);
  });
  const title = document.createElement("span");
  title.className = "panel-heading";
  title.textContent = "盛り上がりの山を使う";
  const switchHint = document.createElement("span");
  switchHint.className = "mix-info";
  switchHint.textContent = "曲の流れに沿って、層の数・音の密度などを自動で動かす";
  switchRow.append(useCheck, title, switchHint);

  const body = document.createElement("div");
  body.className = "energy-body";

  const head = document.createElement("div");
  head.className = "preset-row";
  for (const shape of Object.keys(curveShapeLabels) as CurveShape[]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preset-button";
    b.textContent = curveShapeLabels[shape];
    b.title = "型を選ぶと線がその形になる。あとから描き直せる";
    b.addEventListener("click", () => {
      pushHistory(copyCurve(curve));
      curve = shapeCurve(shape);
      draw();
      handlers.onCurveChange(curve);
    });
    head.appendChild(b);
  }
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "preset-button";
  undo.textContent = "ひとつ戻す";
  undo.title = "線を変える前の形に戻す（何回でも）";
  undo.addEventListener("click", () => {
    const prev = history.pop();
    if (!prev) return;
    curve = prev;
    updateUndo();
    draw();
    handlers.onCurveChange(curve);
  });
  head.appendChild(undo);
  const hint = document.createElement("span");
  hint.className = "mix-info";
  hint.textContent = "ドラッグでなぞって描く／点をつかんで動かす／点をダブルクリックで消す";
  head.appendChild(hint);

  const MAX_HISTORY = 50;
  function copyCurve(c: EnergyCurve): EnergyCurve {
    return c.map((p) => ({ t: p.t, v: p.v }));
  }
  function updateUndo(): void {
    undo.disabled = history.length === 0;
  }
  function pushHistory(before: EnergyCurve): void {
    history.push(before);
    if (history.length > MAX_HISTORY) history.shift();
    updateUndo();
  }
  updateUndo();

  const canvas = document.createElement("canvas");
  canvas.className = "energy-canvas";
  canvas.style.height = `${HEIGHT}px`;
  canvas.style.touchAction = "none";
  const g = canvas.getContext("2d")!;

  const macroBox = document.createElement("div");
  macroBox.className = "macro-list";

  body.append(head, canvas, macroBox);
  root.append(switchRow, body);

  function applyEnabled(): void {
    useCheck.checked = enabled;
    body.hidden = !enabled;
  }
  applyEnabled();

  // --- 描画 ---

  const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const xOf = (t: number): number => t * width;
  const yOf = (v: number): number => PAD_Y + (1 - v) * (HEIGHT - PAD_Y * 2);
  const tOf = (x: number): number => Math.min(1, Math.max(0, x / width));
  const vOf = (y: number): number => Math.min(1, Math.max(0, 1 - (y - PAD_Y) / (HEIGHT - PAD_Y * 2)));

  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(HEIGHT * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, HEIGHT);

    // セクションの帯（長さに比例）
    const seconds = sections.map((s) => (sectionBeats(s) * 60) / s.bpm);
    const total = seconds.reduce((a, b) => a + b, 0);
    if (total > 0) {
      let acc = 0;
      sections.forEach((s, i) => {
        const x0 = (acc / total) * width;
        acc += seconds[i];
        const x1 = (acc / total) * width;
        g.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.0)";
        g.fillRect(x0, 0, x1 - x0, HEIGHT);
        g.strokeStyle = css("--border") || "#2a2c36";
        g.beginPath();
        g.moveTo(x1, 0);
        g.lineTo(x1, HEIGHT);
        g.stroke();
        g.fillStyle = css("--text-dim") || "#9a9ba6";
        g.font = "11px sans-serif";
        g.fillText(s.name, x0 + 6, HEIGHT - 6, Math.max(0, x1 - x0 - 8));
      });
    } else {
      g.fillStyle = css("--text-dim") || "#9a9ba6";
      g.font = "11px sans-serif";
      g.fillText("曲に追加したセクションが、ここに帯として並びます", 8, HEIGHT - 6);
    }

    // 線と塗り
    const accent = css("--accent-green") || "#3ee6b0";
    const pts = curve.length > 0 ? curve : [];
    if (pts.length > 0) {
      g.beginPath();
      g.moveTo(0, yOf(energyAt(pts, 0)));
      for (const p of pts) g.lineTo(xOf(p.t), yOf(p.v));
      g.lineTo(width, yOf(energyAt(pts, 1)));
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.stroke();
      g.lineTo(width, HEIGHT);
      g.lineTo(0, HEIGHT);
      g.closePath();
      g.fillStyle = "rgba(62,230,176,0.12)";
      g.fill();
      for (const p of pts) {
        g.beginPath();
        g.arc(xOf(p.t), yOf(p.v), 4, 0, Math.PI * 2);
        g.fillStyle = accent;
        g.fill();
      }
    }

    if (progress !== null) {
      g.strokeStyle = "#ffffff";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(xOf(progress), 0);
      g.lineTo(xOf(progress), HEIGHT);
      g.stroke();
    }
  }

  new ResizeObserver((entries) => {
    const w = entries[0].contentRect.width;
    if (w > 0 && Math.abs(w - width) > 0.5) {
      width = w;
      draw();
    }
  }).observe(canvas);

  // --- 操作 ---

  function pos(e: PointerEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function nearestPoint(x: number, y: number): number | null {
    let best: number | null = null;
    let bestD = GRAB_PX;
    curve.forEach((p, i) => {
      const d = Math.hypot(xOf(p.t) - x, yOf(p.v) - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = pos(e);
    const hit = nearestPoint(x, y);
    pending = copyCurve(curve);
    if (hit !== null) {
      dragIndex = hit;
    } else {
      strokeBase = curve.slice();
      stroke = [{ t: tOf(x), v: vOf(y) }];
      curve = paintCurve(strokeBase, stroke);
      draw();
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const { x, y } = pos(e);
    if (dragIndex !== null) {
      const prev = curve[dragIndex - 1]?.t ?? 0;
      const next = curve[dragIndex + 1]?.t ?? 1;
      curve[dragIndex] = { t: Math.min(next, Math.max(prev, tOf(x))), v: vOf(y) };
      draw();
    } else if (stroke) {
      const last = stroke[stroke.length - 1];
      const t = tOf(x);
      if (Math.abs(t - last.t) >= 0.008) {
        stroke.push({ t, v: vOf(y) });
        curve = paintCurve(strokeBase, stroke);
        draw();
      }
    }
  });

  function finish(): void {
    if (dragIndex === null && !stroke) return;
    dragIndex = null;
    stroke = null;
    curve = normalizeCurve(curve);
    if (pending && JSON.stringify(pending) !== JSON.stringify(curve)) pushHistory(pending);
    pending = null;
    draw();
    handlers.onCurveChange(curve);
  }
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  canvas.addEventListener("dblclick", (e) => {
    const { x, y } = pos(e as unknown as PointerEvent);
    const hit = nearestPoint(x, y);
    if (hit === null || curve.length <= 2) return;
    pushHistory(copyCurve(curve));
    curve = curve.filter((_, i) => i !== hit);
    draw();
    handlers.onCurveChange(curve);
  });

  // --- マクロ（山が何を動かすか。見えて、設定し直せる） ---

  function pct(v: number): string {
    return `${Math.round(v * 100)}%`;
  }

  function renderMacros(): void {
    macroBox.innerHTML = "";
    for (const id of macroOrder) {
      const macro = macros.find((m) => m.id === id);
      if (!macro) continue;
      const info = macroInfo[id];
      const row = document.createElement("div");
      row.className = "layer-row macro-row";
      row.title = info.hint;

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = macro.enabled;
      check.addEventListener("change", () => {
        macro.enabled = check.checked;
        handlers.onMacrosChange(macros);
        renderMacros();
      });

      const label = document.createElement("span");
      label.className = "layer-role-label";
      label.textContent = info.label;

      const badge = document.createElement("span");
      badge.className = "mix-info";
      badge.textContent = info.mode === "stepped" ? "小節の頭で切替" : "線に沿って滑らか";

      const mkSlider = (key: "from" | "to", caption: string): HTMLElement => {
        const wrap = document.createElement("label");
        wrap.className = "macro-slider";
        const text = document.createElement("span");
        text.className = "mix-info";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "1";
        slider.step = "0.05";
        slider.value = String(macro[key]);
        slider.disabled = !macro.enabled;
        slider.className = "layer-volume";
        const update = (): void => {
          const word = key === "from" ? info.fromLabel : info.toLabel;
          text.textContent = `${caption} ${pct(macro[key])}（${word}）`;
        };
        update();
        slider.addEventListener("input", () => {
          macro[key] = Number(slider.value);
          update();
          handlers.onMacrosChange(macros);
        });
        slider.addEventListener("touchmove", (ev) => ev.stopPropagation(), { passive: true });
        wrap.append(text, slider);
        return wrap;
      };

      row.append(check, label, badge, mkSlider("from", "山が低いとき"), mkSlider("to", "山が高いとき"));
      macroBox.appendChild(row);
    }
  }

  return {
    el: root,
    setData(nextCurve, nextMacros, nextSections, nextEnabled) {
      enabled = nextEnabled;
      applyEnabled();
      if (nextCurve !== curve) {
        // 曲を読み込み直したなど、こちらが出した線ではないとき：履歴は引き継がない
        history.length = 0;
        updateUndo();
      }
      curve = nextCurve;
      macros = nextMacros;
      sections = nextSections;
      renderMacros();
      draw();
    },
    setProgress(t) {
      if (t === progress) return;
      progress = t;
      draw();
    },
  };
}
