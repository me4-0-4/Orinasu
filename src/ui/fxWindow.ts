import {
  ENV_PARAM_LABELS,
  FX_KINDS,
  FX_LABELS,
  describeAmount,
  newEnvelope,
  newPlugin,
  reverbSeconds,
  reverbToneHz,
  type DelayTime,
  type EnvParam,
  type FxKind,
  type FxPlugin,
  type TrackFx,
} from "../mix/fx";

/** FXチェーンの窓で開いているもの：トラック（エンベロープつき）か、断片1つ（テイクFX）。 */
export type FxTarget = { type: "track"; key: string } | { type: "take"; track: string; step: number };

export interface FxWindowDeps {
  /** 開いているもののFX。テイクFXは、エンベロープの無いトラックとして扱う。 */
  get: (target: FxTarget) => TrackFx;
  /** FXを変えた（保存して、作り直して、画面を直す）。 */
  set: (target: FxTarget, fx: TrackFx) => void;
  /** 窓の題（「FX：テストA」など）。 */
  title: (target: FxTarget) => string;
  /** 曲の長さ（ステップ）：新しいエンベロープを、頭から終わりまで引く。 */
  totalSteps: () => number;
  /** 窓を閉じた（線の表示を直す）。 */
  onClose: () => void;
}

export interface FxWindow {
  el: HTMLElement;
  open: (target: FxTarget) => void;
  close: () => void;
  isOpen: () => boolean;
  /** いま開いているもの。 */
  target: () => FxTarget | null;
  refresh: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(label: string, onClick: () => void, title?: string, cls = "preset-button"): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * FXチェーンの窓（REAPER 風）。左にプラグインの一覧（チェックでオン／オフ＝バイパス、ドラッグか ↑↓ で並べ替え）、
 * 右に選んだプラグインのつまみ。量とウェットは [E] でエンベロープ（トラックの下の折れ線）にできる。
 */
export function buildFxWindow(deps: FxWindowDeps): FxWindow {
  let target: FxTarget | null = null;
  /** 一覧で選んでいるプラグインのid。 */
  let selected: string | null = null;

  const overlay = el("div", "fx-overlay");
  overlay.hidden = true;
  const win = el("div", "fx-window");
  win.setAttribute("role", "dialog");
  overlay.appendChild(win); // 窓は浮かせるだけ（後ろの線は触れる。エンベロープを描きながらつまみを見られる）
  document.addEventListener("keydown", (e) => {
    if (!overlay.hidden && e.key === "Escape") close();
  });

  const head = el("div", "fx-head");
  const titleEl = el("div", "fx-title");
  head.append(titleEl, btn("×", () => close(), "閉じる", "preset-button fx-close"));
  const body = el("div", "fx-body");
  const listPane = el("div", "fx-list-pane");
  const list = el("div", "fx-list");
  const addKind = el("select", "quantize-select");
  for (const k of FX_KINDS) {
    const o = el("option", undefined, FX_LABELS[k]);
    o.value = k;
    addKind.appendChild(o);
  }
  const listButtons = el("div", "preset-row");
  const upButton = btn("↑", () => move(-1), "先に掛ける");
  const downButton = btn("↓", () => move(1), "あとに掛ける");
  const removeButton = btn("削除", () => remove(), "選んだプラグインを外す");
  listButtons.append(btn("追加", () => add(), "選んだ種類のプラグインを、いちばん下に足す"), upButton, downButton, removeButton);
  listPane.append(list, addKind, listButtons);
  const params = el("div", "fx-params");
  body.append(listPane, params);
  const foot = el("div", "mix-info fx-foot");
  win.append(head, body, foot);

  const fx = (): TrackFx => (target ? deps.get(target) : { chain: [], envelopes: [] });
  const save = (next: TrackFx): void => {
    if (target) deps.set(target, next);
  };
  const plugin = (): FxPlugin | undefined => fx().chain.find((p) => p.id === selected);

  function add(): void {
    const p = newPlugin(addKind.value as FxKind);
    const cur = fx();
    selected = p.id;
    save({ ...cur, chain: [...cur.chain, p] });
  }
  function move(d: number): void {
    const cur = fx();
    const i = cur.chain.findIndex((p) => p.id === selected);
    const j = i + d;
    if (i < 0 || j < 0 || j >= cur.chain.length) return;
    const chain = [...cur.chain];
    [chain[i], chain[j]] = [chain[j], chain[i]];
    save({ ...cur, chain });
  }
  function moveTo(id: string, to: number): void {
    const cur = fx();
    const i = cur.chain.findIndex((p) => p.id === id);
    if (i < 0) return;
    const chain = [...cur.chain];
    const [p] = chain.splice(i, 1);
    chain.splice(Math.min(chain.length, Math.max(0, to > i ? to - 1 : to)), 0, p);
    save({ ...cur, chain });
  }
  function remove(): void {
    const cur = fx();
    const i = cur.chain.findIndex((p) => p.id === selected);
    if (i < 0) return;
    const chain = cur.chain.filter((p) => p.id !== selected);
    selected = chain[Math.min(i, chain.length - 1)]?.id ?? null;
    save({ chain, envelopes: cur.envelopes.filter((e) => e.pluginId !== cur.chain[i].id) });
  }
  const patch = (changes: Partial<FxPlugin>): void => {
    const cur = fx();
    save({ ...cur, chain: cur.chain.map((p) => (p.id === selected ? { ...p, ...changes } : p)) });
  };

  // --- 一覧 ---
  function renderList(): void {
    const chain = fx().chain;
    list.innerHTML = "";
    if (chain.length === 0) list.appendChild(el("div", "layer-empty", "プラグインがない。下で種類を選んで「追加」"));
    chain.forEach((p, i) => {
      const row = el("div", "fx-item" + (p.id === selected ? " selected" : "") + (p.bypass ? " bypassed" : ""));
      row.draggable = true;
      const check = el("input");
      check.type = "checkbox";
      check.checked = !p.bypass;
      check.title = "オン／オフ（バイパス）";
      check.addEventListener("click", (e) => e.stopPropagation());
      check.addEventListener("change", () => {
        const cur = fx();
        save({ ...cur, chain: cur.chain.map((q) => (q.id === p.id ? { ...q, bypass: !check.checked } : q)) });
      });
      const hasEnv = fx().envelopes.some((e) => e.pluginId === p.id);
      row.append(check, el("span", "fx-item-name", `${i + 1}. ${FX_LABELS[p.kind]}`), el("span", "fx-item-env", hasEnv ? "E" : ""));
      row.addEventListener("click", () => {
        selected = p.id;
        refresh();
      });
      // ドラッグで並べ替え
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", p.id);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        row.classList.add("drop");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("drop");
        const id = e.dataTransfer?.getData("text/plain");
        const r = row.getBoundingClientRect();
        if (id) moveTo(id, e.clientY > r.top + r.height / 2 ? i + 1 : i);
      });
      list.appendChild(row);
    });
    const i = chain.findIndex((p) => p.id === selected);
    upButton.disabled = i <= 0;
    downButton.disabled = i < 0 || i >= chain.length - 1;
    removeButton.disabled = i < 0;
  }

  // --- つまみ ---
  let paramsSignature = "";
  let paramRefreshers: (() => void)[] = [];

  function knob(label: string, get: () => number, set: (v: number) => void, show: (v: number) => string, env?: EnvParam): HTMLElement {
    const row = el("div", "mix-slider-row");
    const input = el("input", "layer-volume");
    input.type = "range";
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    const value = el("span", "mix-slider-value");
    row.append(el("span", "mix-slider-name", label), input, value);
    const note = el("div", "mix-info mix-slider-hint");
    let envButton: HTMLButtonElement | null = null;
    if (env && target?.type === "track") {
      envButton = btn("E", () => toggleEnvelope(env), "エンベロープ（時間で動かす折れ線）を、トラックの下に出す／しまう", "preset-button fx-env-button");
      row.appendChild(envButton);
    }
    row.appendChild(note);
    paramRefreshers.push(() => {
      const v = get();
      if (document.activeElement !== input) input.value = String(v);
      value.textContent = show(v);
      const e = env ? fx().envelopes.find((x) => x.pluginId === selected && x.param === env) : undefined;
      input.disabled = !!e?.active;
      note.textContent = e
        ? e.active
          ? `エンベロープで動かしている（トラックの下の折れ線。${e.visible ? "表示中" : "隠し中"}）`
          : "エンベロープは切ってある（つまみの値のまま）"
        : "";
      envButton?.classList.toggle("on", !!e);
    });
    input.addEventListener("input", () => {
      value.textContent = show(Number(input.value));
      set(Number(input.value));
    });
    input.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
    return row;
  }

  /** エンベロープ：無ければ作って出す。あれば、出す⇔しまう。 */
  function toggleEnvelope(param: EnvParam): void {
    const cur = fx();
    const p = plugin();
    if (!p) return;
    const e = cur.envelopes.find((x) => x.pluginId === p.id && x.param === param);
    if (!e) save({ ...cur, envelopes: [...cur.envelopes, newEnvelope(p, param, deps.totalSteps())] });
    else save({ ...cur, envelopes: cur.envelopes.map((x) => (x === e ? { ...x, visible: !x.visible } : x)) });
  }

  function envControls(param: EnvParam): HTMLElement | null {
    if (target?.type !== "track") return null;
    const row = el("div", "preset-row fx-env-row");
    const label = el("span", "mix-info");
    const activeButton = btn("", () => {
      const cur = fx();
      save({ ...cur, envelopes: cur.envelopes.map((x) => (x.pluginId === selected && x.param === param ? { ...x, active: !x.active } : x)) });
    });
    const deleteButton = btn("エンベロープを消す", () => {
      const cur = fx();
      save({ ...cur, envelopes: cur.envelopes.filter((x) => !(x.pluginId === selected && x.param === param)) });
    });
    row.append(label, activeButton, deleteButton);
    paramRefreshers.push(() => {
      const e = fx().envelopes.find((x) => x.pluginId === selected && x.param === param);
      row.hidden = !e;
      label.textContent = `${ENV_PARAM_LABELS[param]}のエンベロープ：`;
      activeButton.textContent = e?.active ? "オン" : "オフ";
      activeButton.className = "preset-button" + (e?.active ? " on" : "");
    });
    return row;
  }

  function renderParams(): void {
    const p = plugin();
    const signature = JSON.stringify([target, p?.id, p?.kind]);
    if (signature !== paramsSignature) {
      paramsSignature = signature;
      paramRefreshers = [];
      params.innerHTML = "";
      if (!p) {
        params.appendChild(el("div", "layer-empty", "左の一覧からプラグインを選ぶと、ここにつまみが出る"));
      } else {
        const cur = (): FxPlugin => plugin() ?? p;
        params.appendChild(el("div", "fx-params-title", FX_LABELS[p.kind]));
        const amountLabel =
          p.kind === "reverb" || p.kind === "delay" ? "送る量" : p.kind === "lowCut" || p.kind === "highCut" ? "周波数" : p.kind === "drive" ? "ドライブ" : "クラッシュ";
        params.append(
          knob(amountLabel, () => cur().amount, (v) => patch({ amount: v }), (v) => describeAmount(p, v), "amount"),
        );
        const ea = envControls("amount");
        if (ea) params.appendChild(ea);
        params.append(knob("ウェット", () => cur().mix, (v) => patch({ mix: v }), pct, "mix"));
        const em = envControls("mix");
        if (em) params.appendChild(em);
        if (p.kind === "reverb") {
          params.append(
            knob("長さ", () => cur().size, (v) => patch({ size: v }), (v) => `${reverbSeconds(v).toFixed(1)} 秒`),
            knob("明るさ", () => cur().tone, (v) => patch({ tone: v }), (v) => `${Math.round(reverbToneHz(v))} Hz`),
          );
        } else if (p.kind === "delay") {
          const time = el("select", "quantize-select");
          for (const [v, label] of [
            ["1/16", "1/16"],
            ["1/8", "1/8"],
            ["1/8d", "1/8 付点"],
            ["1/4", "1/4"],
          ] as const) {
            const o = el("option", undefined, label);
            o.value = v;
            time.appendChild(o);
          }
          time.addEventListener("change", () => patch({ time: time.value as DelayTime }));
          paramRefreshers.push(() => {
            time.value = cur().time;
          });
          const timeRow = el("label", "mix-slider-row mix-field-row");
          timeRow.append(el("span", "mix-slider-name", "間隔"), time);
          params.append(timeRow, knob("フィードバック", () => cur().feedback, (v) => patch({ feedback: v }), pct));
        }
      }
    }
    for (const f of paramRefreshers) f();
  }

  function refresh(): void {
    if (!target || overlay.hidden) return;
    const chain = fx().chain;
    if (!chain.some((p) => p.id === selected)) selected = chain[0]?.id ?? null;
    titleEl.textContent = deps.title(target);
    foot.textContent =
      target.type === "take"
        ? "テイクFX：この断片だけに掛かる（トラックのFXより先）。刻み直して、この位置に断片が無くなると掛からない"
        : "上から順に掛かる。チェックを外すとバイパス。[E] で、量・ウェットを時間で動かすエンベロープを出せる（点はトラックの下でタップ・ドラッグ、ダブルタップで消す）";
    renderList();
    renderParams();
  }

  function open(next: FxTarget): void {
    target = next;
    selected = null;
    paramsSignature = "";
    overlay.hidden = false;
    refresh();
  }

  function close(): void {
    if (overlay.hidden) return;
    overlay.hidden = true;
    target = null;
    deps.onClose();
  }

  return {
    el: overlay,
    open,
    close,
    isOpen: () => !overlay.hidden,
    target: () => target,
    refresh,
  };
}
