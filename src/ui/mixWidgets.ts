/** 刻むタブの、小さな部品（つまみ・選択・見出し・説明）。 */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(label: string, onClick: () => void, cls = "preset-button", title?: string): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** つまみ・選択などの1行。refresh で、いまの値に合わせる。 */
export interface Control {
  el: HTMLElement;
  refresh: () => void;
}

/**
 * つまみ（横のスライダー）。名前・値・説明（ふだんは隠す。「説明を表示」で出す。マウスを乗せても出る）。
 */
export function knob(opts: {
  label: string;
  get: () => number;
  set: (v: number) => void;
  /** 値の表示（無ければ %）。 */
  format?: (v: number) => string;
  hint?: () => string;
  min?: number;
  max?: number;
  step?: number;
  /** 全体からのずらしなど、値の横に添える短い注記。 */
  note?: () => string;
}): Control {
  const row = el("div", "ins-row");
  const name = el("span", "ins-label", opts.label);
  const input = el("input", "ins-range");
  input.type = "range";
  input.min = String(opts.min ?? 0);
  input.max = String(opts.max ?? 1);
  input.step = String(opts.step ?? 0.01);
  const value = el("span", "ins-value");
  const hint = el("div", "ins-hint");
  row.append(name, input, value, hint);
  const fmt = opts.format ?? pct;
  const show = (v: number): void => {
    value.textContent = fmt(v) + (opts.note ? opts.note() : "");
    const h = opts.hint?.() ?? "";
    hint.textContent = h;
    row.title = h;
  };
  input.addEventListener("input", () => {
    opts.set(Number(input.value));
    show(Number(input.value));
  });
  input.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
  return {
    el: row,
    refresh() {
      const v = opts.get();
      if (document.activeElement !== input) input.value = String(v);
      show(v);
    },
  };
}

/** 選択（セレクト）の1行。 */
export function choice<T extends string>(opts: {
  label: string;
  options: () => [T, string][];
  get: () => T;
  set: (v: T) => void;
  hint?: () => string;
}): Control {
  const row = el("label", "ins-row ins-choice");
  const name = el("span", "ins-label", opts.label);
  const select = el("select", "quantize-select ins-select");
  const hint = el("div", "ins-hint");
  row.append(name, select, hint);
  let signature = "";
  select.addEventListener("change", () => opts.set(select.value as T));
  return {
    el: row,
    refresh() {
      const options = opts.options();
      const sig = JSON.stringify(options);
      if (sig !== signature) {
        signature = sig;
        select.innerHTML = "";
        for (const [v, label] of options) {
          const o = el("option", undefined, label);
          o.value = v;
          select.appendChild(o);
        }
      }
      select.value = opts.get();
      const h = opts.hint?.() ?? "";
      hint.textContent = h;
      row.title = h;
    },
  };
}

/** 開け閉めできる見出し（中身はその下）。開け閉めは覚えておく。 */
export function section(id: string, title: string, ...children: HTMLElement[]): HTMLDetailsElement {
  const d = el("details", "ins-section");
  const s = el("summary", "ins-summary", title);
  d.append(s, ...children);
  const key = `orinasu.mix.section.${id}`;
  try {
    d.open = localStorage.getItem(key) !== "closed";
  } catch {
    d.open = true;
  }
  d.addEventListener("toggle", () => {
    try {
      localStorage.setItem(key, d.open ? "open" : "closed");
    } catch {
      // 覚えられなくても動く
    }
  });
  return d;
}

/** 小さな説明（「説明を表示」のときだけ出る）。 */
export function note(text: string): HTMLElement {
  return el("div", "ins-hint ins-note", text);
}
