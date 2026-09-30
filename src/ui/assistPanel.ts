import { defaultArpSettings, type ArpMode, type ArpSettings } from "../audio/arpeggiator";
import { drumGenres, drumParts, type DrumGenre, type DrumPart } from "../theory/drumPattern";
import { keyName, keyShortName, sameKey, noteNamesFor, type Key, type KeyCandidate } from "../theory/key";

export interface ChordView {
  name: string;
  /** ベースで弾く音の案内（例：「ルート C／5度 G」） */
  bass: string;
  locked: boolean;
}

export interface AssistView {
  recommendation: string;
  detected: KeyCandidate[];
  key: Key | null;
  manual: boolean;
  scaleLock: boolean;
  chords: ChordView[] | null;
  selectedIndex: number | null;
  previewing: boolean;
  hasGeneratedDrums: boolean;
  arpEnabled: boolean;
  chordsPerBar: 1 | 2;
}

export interface AssistHandlers {
  onPickKey: (key: Key | null) => void;
  onScaleLock: (on: boolean) => void;
  onGenerateChords: (perBar: 1 | 2) => void;
  onChordsPerBar: (perBar: 1 | 2) => void;
  onRerollChords: () => void;
  onAltChord: (index: number) => void;
  onToggleChordLock: (index: number) => void;
  onSelectChord: (index: number) => void;
  onClearChords: () => void;
  onPreview: () => void;
  onPlaceDrums: (genre: DrumGenre, locked: Set<DrumPart>) => void;
  onArpChange: (patch: Partial<ArpSettings>) => void;
}

export interface AssistPanel {
  /** 手助けの列（調・コード・ドラム・アルペジエーター）。フレーズタブの右半分に置く。 */
  el: HTMLElement;
  render: (view: AssistView) => void;
  setPlayingIndex: (index: number | null) => void;
  /** 「次のおすすめ」の一言（フレーズタブ側の帯にも同じ文を出す） */
  recommendationEl: HTMLElement;
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function selectField(
  label: string,
  options: { value: string; label: string }[],
  value: string,
  onChange: (v: string) => void,
): { el: HTMLElement; select: HTMLSelectElement } {
  const wrap = document.createElement("label");
  wrap.className = "assist-field";
  const span = document.createElement("span");
  span.textContent = label;
  const select = document.createElement("select");
  select.className = "quantize-select";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  wrap.append(span, select);
  return { el: wrap, select };
}

function section(title: string, hint?: string): { el: HTMLElement; body: HTMLElement } {
  const el = document.createElement("div");
  el.className = "assist-section";
  const h = document.createElement("div");
  h.className = "panel-heading";
  h.textContent = title;
  el.appendChild(h);
  if (hint) {
    const p = document.createElement("div");
    p.className = "assist-hint";
    p.textContent = hint;
    el.appendChild(p);
  }
  const body = document.createElement("div");
  body.className = "assist-body";
  el.appendChild(body);
  return { el, body };
}

export function buildAssistPanel(handlers: AssistHandlers): AssistPanel {
  // --- 次のおすすめ ---
  const recommendationEl = document.createElement("div");
  recommendationEl.className = "recommend-strip";

  // --- 調 ---
  const keySec = section("調", "弾いた音から推定した候補。合っていなければ自分で選び直せる。");
  const candidateRow = document.createElement("div");
  candidateRow.className = "assist-row";
  const tonicSelect = selectField(
    "手動で選ぶ",
    [{ value: "", label: "自動" }, ...noteNamesFor({ tonic: 0, mode: "major" }).map((n, i) => ({ value: String(i), label: n }))],
    "",
    () => pickManual(),
  );
  const modeSelect = selectField(
    "長調/短調",
    [
      { value: "major", label: "メジャー" },
      { value: "minor", label: "マイナー" },
    ],
    "major",
    () => pickManual(),
  );
  function pickManual(): void {
    if (tonicSelect.select.value === "") handlers.onPickKey(null);
    else
      handlers.onPickKey({
        tonic: Number(tonicSelect.select.value),
        mode: modeSelect.select.value as "major" | "minor",
      });
  }
  const manualRow = document.createElement("div");
  manualRow.className = "assist-row";
  manualRow.append(tonicSelect.el, modeSelect.el);
  const keyStatus = document.createElement("div");
  keyStatus.className = "assist-status";
  const scaleLockLabel = document.createElement("label");
  scaleLockLabel.className = "assist-check";
  const scaleLockInput = document.createElement("input");
  scaleLockInput.type = "checkbox";
  scaleLockInput.addEventListener("change", () => handlers.onScaleLock(scaleLockInput.checked));
  scaleLockLabel.append(
    scaleLockInput,
    document.createTextNode("スケールロック（スケール外の音は近いスケール音に寄せる）"),
  );
  keySec.body.append(keyStatus, candidateRow, manualRow, scaleLockLabel);

  // --- コード ---
  const chordSec = section(
    "コード案",
    "音は置かない。名前と、鍵盤の光り方で示すだけ。黄色＝構成音、青＝ルート、青い点＝ベースで弾く音。",
  );
  const chordControls = document.createElement("div");
  chordControls.className = "assist-row";
  const perBarSelect = selectField(
    "1小節あたり",
    [
      { value: "1", label: "1コード" },
      { value: "2", label: "2コード" },
    ],
    "1",
    (v) => handlers.onChordsPerBar(Number(v) as 1 | 2),
  );
  const generateBtn = button("コード案を出す", "preset-button", () =>
    handlers.onGenerateChords(Number(perBarSelect.select.value) as 1 | 2),
  );
  const rerollBtn = button("振り直し", "preset-button", () => handlers.onRerollChords());
  const previewBtn = button("試聴", "preset-button", () => handlers.onPreview());
  const clearBtn = button("消す", "layer-toggle", () => handlers.onClearChords());
  chordControls.append(generateBtn, rerollBtn, previewBtn, clearBtn, perBarSelect.el);
  const chordTimeline = document.createElement("div");
  chordTimeline.className = "chord-timeline";
  chordSec.body.append(chordControls, chordTimeline);

  // --- ドラム ---
  const drumSec = section(
    "ドラム候補",
    "ジャンルを選ぶとパターンを置く。固定した楽器は振り直しても変わらない。自分で録音したドラム層には触らない。",
  );
  const genreSelect = selectField(
    "ジャンル",
    drumGenres.map((g) => ({ value: g.id, label: g.label })),
    drumGenres[0].id,
    () => {},
  );
  const partLocks = new Set<DrumPart>();
  const lockRow = document.createElement("div");
  lockRow.className = "assist-row";
  for (const part of drumParts) {
    const label = document.createElement("label");
    label.className = "assist-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      if (input.checked) partLocks.add(part.id);
      else partLocks.delete(part.id);
    });
    label.append(input, document.createTextNode(`${part.label}を固定`));
    lockRow.appendChild(label);
  }
  const placeDrumsBtn = button("ドラム候補を置く", "preset-button", () =>
    handlers.onPlaceDrums(genreSelect.select.value as DrumGenre, new Set(partLocks)),
  );
  drumSec.body.append(genreSelect.el, lockRow, placeDrumsBtn);

  // --- アルペジエーター ---
  const arpSec = section("アルペジエーター", "押さえた音を1音ずつ順番に鳴らす。シンセの演奏に挿さっている。");
  const arpToggle = button("オフ", "layer-toggle arp-toggle", () => {
    handlers.onArpChange({ enabled: !arpToggle.classList.contains("on") });
  });
  const arpMode = selectField(
    "並び",
    [
      { value: "up", label: "上昇" },
      { value: "down", label: "下降" },
      { value: "updown", label: "往復" },
      { value: "random", label: "ランダム" },
    ],
    defaultArpSettings.mode,
    (v) => handlers.onArpChange({ mode: v as ArpMode }),
  );
  const arpRate = selectField(
    "速さ",
    [
      { value: "1", label: "4分" },
      { value: "2", label: "8分" },
      { value: "4", label: "16分" },
      { value: "3", label: "8分3連" },
    ],
    String(defaultArpSettings.stepsPerBeat),
    (v) => handlers.onArpChange({ stepsPerBeat: Number(v) }),
  );
  const arpOct = selectField(
    "オクターブ幅",
    [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n}` })),
    String(defaultArpSettings.octaves),
    (v) => handlers.onArpChange({ octaves: Number(v) as 1 | 2 | 3 | 4 }),
  );
  const gateWrap = document.createElement("label");
  gateWrap.className = "assist-field";
  const gateText = document.createElement("span");
  gateText.textContent = "ゲート長";
  const gate = document.createElement("input");
  gate.type = "range";
  gate.min = "0.1";
  gate.max = "1";
  gate.step = "0.05";
  gate.value = String(defaultArpSettings.gate);
  gate.addEventListener("input", () => handlers.onArpChange({ gate: Number(gate.value) }));
  gateWrap.append(gateText, gate);
  arpSec.body.append(arpToggle, arpMode.el, arpRate.el, arpOct.el, gateWrap);

  // --- 列にまとめる ---
  const column = document.createElement("section");
  column.className = "panel-column assist-column";
  const heading = document.createElement("div");
  heading.className = "panel-heading";
  heading.textContent = "手助け";
  // 「次のおすすめ」は左のフレーズ列に出すので、ここには置かない
  column.append(heading, keySec.el, chordSec.el, drumSec.el, arpSec.el);

  function render(view: AssistView): void {
    recommendationEl.textContent = view.recommendation;

    // 調
    candidateRow.innerHTML = "";
    if (view.detected.length === 0) {
      keyStatus.textContent = view.key
        ? `${keyName(view.key)}（手動）`
        : "まだ判定できない。メロディを2音以上録音してみよう。";
    } else {
      keyStatus.textContent = view.key
        ? `いまの調：${keyName(view.key)}${view.manual ? "（手動）" : "（自動）"}`
        : "";
      view.detected.forEach((c, i) => {
        const b = button(
          `${i + 1}. ${keyShortName(c)}　${Math.round(c.score * 100)}%`,
          "preset-button key-candidate" + (sameKey(view.key, c) ? " selected" : ""),
          () => handlers.onPickKey(c),
        );
        candidateRow.appendChild(b);
      });
    }
    if (document.activeElement !== tonicSelect.select) {
      tonicSelect.select.value = view.manual && view.key ? String(view.key.tonic) : "";
    }
    if (view.key && document.activeElement !== modeSelect.select) modeSelect.select.value = view.key.mode;
    // 手動選択のコード名表記も、いまの調に合わせる
    const names = noteNamesFor(view.key ?? { tonic: 0, mode: "major" });
    [...tonicSelect.select.options].forEach((opt, i) => {
      if (i > 0) opt.textContent = names[i - 1];
    });
    scaleLockInput.checked = view.scaleLock;
    scaleLockInput.disabled = !view.key;

    // コード
    perBarSelect.select.value = String(view.chordsPerBar);
    generateBtn.textContent = view.chords ? "作り直す" : "コード案を出す";
    generateBtn.disabled = !view.key;
    rerollBtn.disabled = !view.chords;
    previewBtn.disabled = !view.chords;
    previewBtn.textContent = view.previewing ? "停止" : "試聴";
    previewBtn.classList.toggle("on", view.previewing);
    clearBtn.disabled = !view.chords;
    chordTimeline.innerHTML = "";
    if (!view.chords) {
      const empty = document.createElement("div");
      empty.className = "layer-empty";
      empty.textContent = view.key
        ? "「コード案を出す」を押すと、この調に合う進行を提示する。"
        : "調が決まるとコード案を出せる。";
      chordTimeline.appendChild(empty);
    } else {
      view.chords.forEach((c, i) => {
        const card = document.createElement("div");
        card.className =
          "chord-card" + (view.selectedIndex === i ? " selected" : "") + (c.locked ? " locked" : "");
        card.dataset.index = String(i);
        const name = button(c.name, "chord-name", () => handlers.onSelectChord(i));
        const bass = document.createElement("div");
        bass.className = "chord-bass";
        bass.textContent = c.bass;
        const actions = document.createElement("div");
        actions.className = "chord-actions";
        actions.append(
          button("別の候補", "layer-toggle", () => handlers.onAltChord(i)),
          button(c.locked ? "固定中" : "固定", "layer-toggle" + (c.locked ? " on" : ""), () =>
            handlers.onToggleChordLock(i),
          ),
        );
        card.append(name, bass, actions);
        chordTimeline.appendChild(card);
      });
    }

    // ドラム
    placeDrumsBtn.textContent = view.hasGeneratedDrums ? "振り直す" : "ドラム候補を置く";

    // アルペジエーター
    arpToggle.classList.toggle("on", view.arpEnabled);
    arpToggle.textContent = view.arpEnabled ? "オン" : "オフ";
  }

  function setPlayingIndex(index: number | null): void {
    for (const card of chordTimeline.querySelectorAll<HTMLElement>(".chord-card")) {
      card.classList.toggle("playing", index !== null && card.dataset.index === String(index));
    }
  }

  return { el: column, render, setPlayingIndex, recommendationEl };
}
