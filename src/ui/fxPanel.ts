import {
  FX_KINDS,
  FX_LABELS,
  chainIsOff,
  fillBars,
  highCutHz,
  lowCutHz,
  newSlot,
  reverbSeconds,
  reverbToneHz,
  type DelayTime,
  type FxKind,
  type FxSlot,
  type FxWhen,
} from "../mix/fx";
import type { Lane, Song } from "../mix/types";
import type { Phrase } from "../phrase/types";

/** 線の表示に重ねる「いつ掛けるか」の印。 */
export interface FxHighlight {
  /** 断片を選ぶ層（曲のid）。 */
  lanePhraseId?: string;
  /** 選んだ断片の位置（ステップ）。 */
  steps?: number[];
  /** 掛ける小節（0から）。 */
  bars?: number[];
  /** いま、左の線をタップして断片を選べるか。 */
  picking: boolean;
}

export interface FxPanelDeps {
  getSong: () => Song;
  getPhrases: () => Phrase[];
  /** 下地に使っている曲のid（無ければ null）。 */
  drumId: () => string | null;
  /** エフェクトを変えた（保存して、作り直して、画面を直す）。 */
  onChange: () => void;
  /** 画面だけ直す（選んでいるエフェクトが変わった、など）。 */
  onView: () => void;
}

export interface FxPanel {
  el: HTMLElement;
  refresh: () => void;
  /** 掛ける所を、その層にする（左で層を選んだとき）。 */
  selectLane: (phraseId: string) => void;
  highlight: () => FxHighlight | null;
  /** 左の線で、層 phraseId の step の断片をタップした。選んでいる最中なら、選ぶ・外すをして true。 */
  pickHit: (phraseId: string, step: number) => boolean;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const WHEN_LABELS: Record<FxWhen, string> = {
  all: "曲のぜんぶ",
  bars: "小節を選ぶ",
  fills: "フィルの小節だけ",
  hits: "選んだ断片だけ",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function selectOf(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = el("select", "quantize-select");
  for (const [v, label] of options) {
    const o = el("option", undefined, label);
    o.value = v;
    s.appendChild(o);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

/**
 * エフェクトの欄：掛ける所を選び、そこにエフェクトを好きな順番で好きなだけ並べる（上から順に掛かる）。
 * 1つ1つ「いつ掛けるか」を決められる：曲のぜんぶ／小節を選ぶ／フィルの小節だけ／選んだ断片だけ（層のとき）。
 */
export function buildFxPanel(deps: FxPanelDeps): FxPanel {
  /** 掛ける所：master・bed・pad・lane:<曲のid>。 */
  let target = "master";
  /** いま触っているエフェクト（何番目か）。線の表示に、その「いつ」を重ねる。 */
  let focus = -1;

  const root = el("div", "mix-fx");
  const targetSelect = el("select", "quantize-select mix-fx-target");
  targetSelect.addEventListener("change", () => {
    target = targetSelect.value;
    focus = -1;
    refresh();
    deps.onView();
  });
  const targetHint = el("span", "mix-info mix-slider-hint");
  const targetRow = el("label", "mix-slider-row mix-field-row");
  targetRow.append(el("span", "mix-slider-name", "掛ける所"), targetSelect, targetHint);
  const list = el("div", "mix-fx-list");
  const addKind = selectOf(
    FX_KINDS.map((k) => [k, FX_LABELS[k]]),
    "reverb",
    () => undefined,
  );
  const addButton = el("button", "preset-button", "＋ 足す");
  addButton.type = "button";
  addButton.addEventListener("click", () => {
    const chain = getChain();
    const bars = deps.getSong().lengthBars;
    setChain([...chain, newSlot(addKind.value as FxKind, { to: Math.min(bars, 4) })]);
    focus = chain.length;
    deps.onView();
  });
  const addRow = el("div", "preset-row");
  addRow.append(addKind, addButton);
  root.append(targetRow, list, addRow);

  const isLane = (): boolean => target.startsWith("lane:");
  const laneOf = (song: Song): Lane | undefined => song.lanes?.find((l) => `lane:${l.phraseId}` === target);

  function getChain(): FxSlot[] {
    const song = deps.getSong();
    if (target === "master" || target === "bed" || target === "pad") return song.fx[target];
    return laneOf(song)?.fx ?? [];
  }

  function setChain(chain: FxSlot[]): void {
    const song = deps.getSong();
    if (target === "master" || target === "bed" || target === "pad") {
      song.fx = { ...song.fx, [target]: chain };
    } else if (song.lanes) {
      song.lanes = song.lanes.map((l) => {
        if (`lane:${l.phraseId}` !== target) return l;
        const { fx: _old, ...rest } = l;
        return chain.length === 0 ? rest : { ...rest, fx: chain };
      });
    }
    deps.onChange();
  }

  const updateSlot = (i: number, patch: Partial<FxSlot>): void => {
    setChain(getChain().map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  // --- 掛ける所の一覧 ---
  let targetSignature = "";
  function renderTargets(): void {
    const song = deps.getSong();
    const phrases = deps.getPhrases();
    const mark = (c: FxSlot[] | undefined): string => (chainIsOff(c) ? "" : " ＊");
    const options: [string, string][] = [["master", `全体（曲のぜんぶ）${mark(song.fx.master)}`]];
    for (const lane of song.lanes ?? []) {
      const name = phrases.find((p) => p.id === lane.phraseId)?.name ?? "層";
      options.push([`lane:${lane.phraseId}`, `層：${name}${mark(lane.fx)}`]);
    }
    const drum = deps.drumId();
    const drumName = drum ? phrases.find((p) => p.id === drum)?.name : undefined;
    if (drumName) options.push(["bed", `下地：${drumName}のドラム${mark(song.fx.bed)}`]);
    options.push(["pad", `伸ばし${mark(song.fx.pad)}`]);
    if (!options.some(([v]) => v === target)) target = "master";
    const signature = JSON.stringify(options);
    if (signature !== targetSignature) {
      targetSignature = signature;
      targetSelect.innerHTML = "";
      for (const [v, label] of options) {
        const o = el("option", undefined, label);
        o.value = v;
        targetSelect.appendChild(o);
      }
    }
    targetSelect.value = target;
    targetHint.textContent =
      target === "master"
        ? "曲のぜんぶに、最後に掛ける"
        : target === "bed"
          ? "下地のドラムにだけ掛ける"
          : target === "pad"
            ? "伸ばしにだけ掛ける"
            : "この層（曲）の刻んだ音にだけ掛ける。全体のエフェクトは、その上に重なる";
  }

  // --- エフェクトの並び ---
  let listSignature = "";
  let listRefreshers: (() => void)[] = [];

  function slider(label: string, get: () => number, set: (v: number) => void, hint: (v: number) => string, i: number): HTMLElement {
    const row = el("div", "mix-slider-row");
    const input = el("input", "layer-volume");
    input.type = "range";
    input.min = "0";
    input.max = "1";
    input.step = "0.05";
    const value = el("span", "mix-slider-value");
    const note = el("div", "mix-info mix-slider-hint");
    const show = (v: number): void => {
      value.textContent = pct(v);
      note.textContent = hint(v);
    };
    listRefreshers.push(() => {
      input.value = String(get());
      show(get());
    });
    input.addEventListener("input", () => {
      focus = i;
      show(Number(input.value));
      set(Number(input.value));
    });
    input.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
    row.append(el("span", "mix-slider-name", label), input, value, note);
    return row;
  }

  function card(slot: FxSlot, i: number, count: number): HTMLElement {
    const box = el("div", "mix-fx-card");
    box.addEventListener("pointerdown", () => {
      if (focus !== i) {
        focus = i;
        deps.onView();
      }
    });
    const head = el("div", "preset-row mix-fx-head");
    const kind = selectOf(
      FX_KINDS.map((k) => [k, `${i + 1}. ${FX_LABELS[k]}`]),
      slot.kind,
      (v) => updateSlot(i, { kind: v as FxKind }),
    );
    const up = el("button", "preset-button", "↑");
    up.type = "button";
    up.title = "先に掛ける";
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      const c = [...getChain()];
      [c[i - 1], c[i]] = [c[i], c[i - 1]];
      focus = i - 1;
      setChain(c);
    });
    const down = el("button", "preset-button", "↓");
    down.type = "button";
    down.title = "あとに掛ける";
    down.disabled = i === count - 1;
    down.addEventListener("click", () => {
      const c = [...getChain()];
      [c[i], c[i + 1]] = [c[i + 1], c[i]];
      focus = i + 1;
      setChain(c);
    });
    const remove = el("button", "preset-button", "消す");
    remove.type = "button";
    remove.addEventListener("click", () => {
      focus = -1;
      setChain(getChain().filter((_, j) => j !== i));
    });
    head.append(kind, up, down, remove);
    box.appendChild(head);

    const cur = (): FxSlot => getChain()[i] ?? slot;
    const off = (v: number): boolean => v < 0.01;
    const num = (key: "amount" | "size" | "tone" | "feedback", label: string, hint: (v: number) => string): HTMLElement =>
      slider(label, () => cur()[key], (v) => updateSlot(i, { [key]: v }), hint, i);
    if (slot.kind === "reverb") {
      box.append(
        num("amount", "量", (v) => (off(v) ? "掛けない" : `響きの量 ${pct(v)}`)),
        num("size", "響きの長さ", (v) => `${reverbSeconds(v).toFixed(1)}秒（短いと部屋、長いとホール）`),
        num("tone", "響きの明るさ", (v) => `${Math.round(reverbToneHz(v))}Hzより上を削る（小さいほどこもる）`),
      );
    } else if (slot.kind === "delay") {
      const time = selectOf(
        [
          ["1/16", "16分"],
          ["1/8", "8分"],
          ["1/8d", "付点8分"],
          ["1/4", "4分（1拍）"],
        ],
        slot.time,
        (v) => updateSlot(i, { time: v as DelayTime }),
      );
      listRefreshers.push(() => {
        time.value = cur().time;
      });
      const timeRow = el("label", "mix-slider-row mix-field-row");
      timeRow.append(el("span", "mix-slider-name", "間隔"), time);
      box.append(
        num("amount", "量", (v) => (off(v) ? "掛けない" : `やまびこの量 ${pct(v)}`)),
        timeRow,
        num("feedback", "くり返し", (v) => `${pct(v)}（大きいほど、やまびこが長く残る）`),
      );
    } else if (slot.kind === "lowCut") {
      box.append(num("amount", "削る", (v) => `${Math.round(lowCutHz(v))}Hzより下を削る（軽くなる）`));
    } else if (slot.kind === "highCut") {
      box.append(num("amount", "削る", (v) => `${Math.round(highCutHz(v))}Hzより上を削る（こもる）`));
    } else if (slot.kind === "drive") {
      box.append(num("amount", "歪み", (v) => (off(v) ? "掛けない" : `${pct(v)}（ザラっとさせる）`)));
    } else {
      box.append(num("amount", "音質下げ", (v) => (off(v) ? "掛けない" : `${pct(v)}（ローファイ。ビット数と細かさを下げる）`)));
    }

    // いつ掛けるか
    const whens: FxWhen[] = isLane() ? ["all", "bars", "fills", "hits"] : ["all", "bars", "fills"];
    const when = selectOf(
      whens.map((w) => [w, WHEN_LABELS[w]]),
      whens.includes(slot.when) ? slot.when : "all",
      (v) => {
        focus = i;
        updateSlot(i, { when: v as FxWhen });
      },
    );
    const whenRow = el("label", "mix-slider-row mix-field-row");
    whenRow.append(el("span", "mix-slider-name", "いつ"), when);
    box.appendChild(whenRow);
    if (slot.when === "bars") {
      const bars = deps.getSong().lengthBars;
      const numInput = (key: "from" | "to"): HTMLInputElement => {
        const input = el("input", "mix-bpm");
        input.type = "number";
        input.min = "1";
        input.max = String(bars);
        listRefreshers.push(() => {
          if (document.activeElement !== input) input.value = String(Math.min(bars, cur()[key]));
        });
        input.addEventListener("change", () => {
          focus = i;
          const v = Math.min(bars, Math.max(1, Math.round(Number(input.value) || 1)));
          const s = cur();
          const from = key === "from" ? v : Math.min(s.from, v);
          const to = key === "to" ? v : Math.max(s.to, v);
          updateSlot(i, { from, to });
        });
        return input;
      };
      const range = el("div", "mix-slider-row mix-field-row");
      range.append(el("span", "mix-slider-name", "小節"), numInput("from"), el("span", "mix-info", "〜"), numInput("to"), el("span", "mix-info", "小節目"));
      box.appendChild(range);
    } else if (slot.when === "fills") {
      box.appendChild(el("div", "mix-info mix-slider-hint", "4小節ごとの4小節目と、最後の小節に掛ける"));
    } else if (slot.when === "hits") {
      const info = el("div", "mix-info mix-slider-hint");
      const clear = el("button", "preset-button", "選んだ断片を外す");
      clear.type = "button";
      clear.addEventListener("click", () => updateSlot(i, { steps: [] }));
      listRefreshers.push(() => {
        const n = cur().steps.length;
        info.textContent =
          focus === i
            ? `左の線で、この層の断片（小さい棒）をタップして選ぶ・外す（いま ${n} 個）`
            : `${n} 個の断片に掛ける（このエフェクトをタップすると、選び直せる）`;
        clear.disabled = n === 0;
      });
      box.append(info, clear);
    }
    listRefreshers.push(() => box.classList.toggle("focused", focus === i));
    return box;
  }

  function renderList(): void {
    const chain = getChain();
    if (focus >= chain.length) focus = -1;
    // つまみを動かしている最中に作り直さないよう、形（種類・いつ・並び）が変わったときだけ作り直す
    const signature = JSON.stringify([target, isLane(), deps.getSong().lengthBars, chain.map((s) => [s.kind, s.when])]);
    if (signature !== listSignature) {
      listSignature = signature;
      listRefreshers = [];
      list.innerHTML = "";
      if (chain.length === 0) list.appendChild(el("div", "layer-empty", "まだエフェクトがない。下の「＋ 足す」で足す（上から順に掛かる）"));
      chain.forEach((slot, i) => list.appendChild(card(slot, i, chain.length)));
    }
    for (const f of listRefreshers) f();
  }

  function refresh(): void {
    renderTargets();
    renderList();
  }

  return {
    el: root,
    refresh,
    selectLane(phraseId) {
      if (target === `lane:${phraseId}`) return;
      target = `lane:${phraseId}`;
      focus = -1;
    },
    highlight() {
      const slot = getChain()[focus];
      if (!slot) return null;
      const bars = deps.getSong().lengthBars;
      const phraseId = isLane() ? target.slice(5) : undefined;
      if (slot.when === "bars") {
        const out: number[] = [];
        for (let b = Math.max(1, slot.from) - 1; b < Math.min(bars, slot.to); b++) out.push(b);
        return { bars: out, picking: false };
      }
      if (slot.when === "fills") return { bars: fillBars(bars), picking: false };
      if (slot.when === "hits" && phraseId) return { lanePhraseId: phraseId, steps: slot.steps, picking: true };
      return null;
    },
    pickHit(phraseId, step) {
      const slot = getChain()[focus];
      if (!slot || slot.when !== "hits" || target !== `lane:${phraseId}`) return false;
      const has = slot.steps.includes(step);
      const steps = has ? slot.steps.filter((s) => s !== step) : [...slot.steps, step].sort((a, b) => a - b);
      updateSlot(focus, { steps });
      return true;
    },
  };
}
