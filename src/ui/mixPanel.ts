import { DEFAULT_VOLUME, MAX_VOLUME } from "../audio/layerSynths";
import { collectMaterials, remix, remixLabels, remixNew, type RemixMode } from "../mix/remix";
import {
  MAX_BPM,
  MIN_BPM,
  createEmptySong,
  duplicateSection,
  effectiveSections,
  formatDuration,
  sectionSeconds,
  songSeconds,
  type MixLayer,
  type Section,
  type Song,
} from "../mix/types";
import { roleLabels, type Phrase } from "../phrase/types";
import { randomSeed, createRng } from "../theory/rng";
import { keyShortName } from "../theory/key";
import { buildEnergyEditor } from "./energyEditor";
import { defaultCurve, defaultMacros } from "../mix/energy";

export interface MixPanelDeps {
  /** 保存されているフレーズ（材料の候補）。 */
  getPhrases: () => Phrase[];
  /** 曲が変わったので保存してほしい。 */
  onSongChange: (song: Song) => void;
  /** 鳴らす。sections の並びで、loop ならひとつをループ。 */
  onPlay: (sections: Section[], mode: { kind: "loop"; index: number } | { kind: "song" }, song: Song) => void;
  onStop: () => void;
  /** ミキサー・音量を動かした。鳴っている音にもすぐ反映してほしい。 */
  onMixChange: (layer: MixLayer) => void;
}

export interface MixPanel {
  el: HTMLElement;
  setSong: (song: Song) => void;
  /** フレーズ一覧が変わったとき。 */
  refreshMaterials: () => void;
  /** 再生位置の表示（セクション番号。ドラフトは -1）。 */
  setPlaying: (index: number | null) => void;
  /** いま画面にあるセクション（ドラフト＋並べたもの）の層id。シンセの掃除用。 */
  layerIds: () => string[];
  /** 山の上の再生位置（0〜1）。 */
  setProgress: (t: number | null) => void;
}

const LENGTHS = [1, 2, 4, 8];

function button(label: string, onClick: () => void, cls = "preset-button", title?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

/** 作業の1ステップ（番号つきの見出し＋中身）。 */
function step(num: number, heading: string, hint: string, ...children: HTMLElement[]): HTMLElement {
  const box = document.createElement("section");
  box.className = "mix-step";
  const h = document.createElement("div");
  h.className = "mix-step-head";
  const n = document.createElement("span");
  n.className = "mix-step-num";
  n.textContent = String(num);
  const t = document.createElement("span");
  t.className = "panel-heading";
  t.textContent = heading;
  const hi = document.createElement("span");
  hi.className = "mix-info";
  hi.textContent = hint;
  h.append(n, t, hi);
  box.append(h, ...children);
  return box;
}

export function buildMixPanel(deps: MixPanelDeps): MixPanel {
  let song: Song = createEmptySong();
  let draft: Section | null = null;
  let draftLength = 4;
  let playingIndex: number | null = null;
  /** 「編集」で曲の中のセクションから戻したときの元のid。「上書き」で差し替える先。 */
  let editingId: string | null = null;
  /** 「音づくり」（音量・M/S・ミキサー）を開いているか。 */
  let soundOpen = false;
  /** 試聴の対象：ドラフトか、並べたセクションの番号か。 */
  let previewing: "draft" | number | null = null;
  /** 「曲を再生」で並べた順に通して鳴らしている最中か。 */
  let songPlaying = false;
  /** タイムラインで選んでいるセクションの番号。 */
  let selected: number | null = null;

  const root = document.createElement("div");
  root.className = "tab-panel mix-tab";
  const steps = document.createElement("div");
  steps.className = "mix-steps";

  const energyEditor = buildEnergyEditor({
    onEnabledChange: (on) => {
      song.energyOn = on;
      touch();
    },
    onCurveChange: (curve) => {
      song.energy = curve;
      touch();
    },
    onMacrosChange: (macros) => {
      song.macros = macros;
      touch();
    },
  });
  function syncEnergy(): void {
    if (!song.energy) song.energy = defaultCurve();
    if (!song.macros) song.macros = defaultMacros();
    energyEditor.setData(song.energy, song.macros, effectiveSections(song), !!song.energyOn);
  }

  // --- 1 材料 ---
  const materialList = document.createElement("div");
  materialList.className = "mix-list";
  const materialEmpty = document.createElement("div");
  materialEmpty.className = "layer-empty";
  materialEmpty.textContent = "フレーズタブで保存したフレーズが、ここに並びます";

  // --- 2 振る ---
  const lengthSelect = document.createElement("select");
  lengthSelect.className = "quantize-select";
  for (const n of LENGTHS) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = `${n}小節`;
    if (n === draftLength) opt.selected = true;
    lengthSelect.appendChild(opt);
  }
  lengthSelect.addEventListener("change", () => {
    draftLength = Number(lengthSelect.value);
  });
  const rollButton = button("振る", () => generate("new"), "roll-button", "材料から新しいセクションを作る。固定した層は残す");
  const previewDraft = button("試聴", () => togglePreview("draft"), "preset-button");
  previewDraft.hidden = true;
  const rollRow = document.createElement("div");
  rollRow.className = "preset-row mix-roll-row";
  rollRow.append(rollButton, lengthSelect, previewDraft);
  const draftTools = document.createElement("div");
  draftTools.className = "preset-row";
  for (const mode of ["recut", "rhythm", "order"] as const) {
    draftTools.appendChild(
      button(remixLabels[mode], () => generate(mode), "preset-button", "固定していない層だけ振り直す"),
    );
  }
  draftTools.append(button("まるごと振り直す", () => generate("new", true), "preset-button", "固定も外して、まるごと作り直す"));
  draftTools.hidden = true;

  // --- 3 固定 ---
  const draftEmpty = document.createElement("div");
  draftEmpty.className = "layer-empty";
  draftEmpty.textContent = "材料を選んで「振る」と、ここに層が出る";
  const draftInfo = document.createElement("div");
  draftInfo.className = "mix-info";
  const draftLayers = document.createElement("div");
  draftLayers.className = "layer-list";
  const soundButton = button("音づくり", () => {
    soundOpen = !soundOpen;
    renderDraft();
  }, "preset-button", "層ごとの音量・ミュート・ソロ・パン・リバーブ・ディレイ・コンプ");
  const draftBox = document.createElement("div");
  draftBox.className = "mix-draft";
  draftBox.append(draftInfo, draftLayers, soundButton);
  draftBox.hidden = true;

  // --- 4 並べる ---
  const draftName = document.createElement("input");
  draftName.type = "text";
  draftName.className = "mix-name";
  draftName.placeholder = "セクション名（イントロ、A、サビ…）";
  draftName.addEventListener("input", () => {
    if (draft) draft.name = draftName.value;
  });
  const addToSong = button("曲に追加", () => {
    if (!draft) return;
    const copy = duplicateSection(draft);
    copy.name = draft.name.trim() || `セクション${song.sections.length + 1}`;
    song.sections.push(copy);
    selected = song.sections.length - 1;
    touch();
    renderSections();
  }, "preset-button on");
  const overwrite = button("上書き", () => {
    if (!draft || !editingId) return;
    const i = song.sections.findIndex((x) => x.id === editingId);
    if (i < 0) {
      editingId = null;
      renderDraft();
      return;
    }
    const copy = duplicateSection(draft);
    copy.id = editingId;
    copy.name = draft.name.trim() || song.sections[i].name;
    song.sections[i] = copy;
    selected = i;
    touch();
    renderSections();
  }, "preset-button", "編集元のセクションを、いまの内容で差し替える");
  overwrite.hidden = true;
  const addRow = document.createElement("div");
  addRow.className = "preset-row mix-add-row";
  addRow.append(draftName, addToSong, overwrite);
  addRow.hidden = true;

  const playSong = button("曲を再生", () => {
    if (songPlaying) {
      stopAll();
      return;
    }
    if (song.sections.length === 0) return;
    previewing = null;
    songPlaying = false; // 鳴らし直しで一度 stop が呼ばれるので、始まってから立てる
    deps.onPlay(effectiveSections(song), { kind: "song" }, song);
    songPlaying = true;
    updateButtons(true);
  }, "preset-button on");
  const bpmInput = document.createElement("input");
  bpmInput.type = "number";
  bpmInput.className = "mix-bpm";
  bpmInput.min = String(MIN_BPM);
  bpmInput.max = String(MAX_BPM);
  bpmInput.title = "曲全体のBPM。空にすると、セクションごとのBPM（最初に選んだ材料のもの）のまま";
  bpmInput.addEventListener("change", () => {
    const v = Math.round(Number(bpmInput.value));
    song.bpm = bpmInput.value === "" || !Number.isFinite(v) ? undefined : Math.min(MAX_BPM, Math.max(MIN_BPM, v));
    touch();
    renderSections();
  });
  const bpmLabel = document.createElement("label");
  bpmLabel.className = "mix-info";
  bpmLabel.append("BPM ", bpmInput);
  const totalLabel = document.createElement("span");
  totalLabel.className = "mix-info";
  const songMeta = document.createElement("div");
  songMeta.className = "preset-row mix-song-meta";
  songMeta.append(playSong, bpmLabel, totalLabel);

  // 曲の流れ：長さに比例した横のブロック。タップで選ぶ
  const timeline = document.createElement("div");
  timeline.className = "mix-timeline";

  // 選んだセクションの操作（要素は使い回し、中身だけ更新する）
  const selName = document.createElement("input");
  selName.type = "text";
  selName.className = "mix-name";
  selName.addEventListener("change", () => {
    const s = selected === null ? undefined : song.sections[selected];
    if (!s) return;
    s.name = selName.value.trim() || s.name;
    touch();
    renderSections();
  });
  const selPreview = button("試聴", () => {
    if (selected !== null) togglePreview(selected);
  }, "layer-toggle");
  const selBar = document.createElement("div");
  selBar.className = "preset-row mix-selection";
  selBar.append(
    selName,
    selPreview,
    button("←", () => moveSelected(-1), "layer-toggle", "前へ"),
    button("→", () => moveSelected(1), "layer-toggle", "後ろへ"),
    button("編集", () => {
      const section = selected === null ? undefined : song.sections[selected];
      if (!section) return;
      // 並べたものは触らず、複製をドラフトに戻して作り直せるようにする
      draft = duplicateSection(section);
      draft.name = section.name;
      editingId = section.id;
      renderDraft();
      root.scrollTo?.({ top: 0, behavior: "smooth" });
    }, "layer-toggle", "複製を「振る」の側に戻して作り直す"),
    button("複製", () => {
      const section = selected === null ? undefined : song.sections[selected];
      if (!section || selected === null) return;
      stopNumberedPreview();
      song.sections.splice(selected + 1, 0, duplicateSection(section));
      selected += 1;
      touch();
      renderSections();
    }, "layer-toggle"),
    button("削除", () => {
      if (selected === null || !song.sections[selected]) return;
      stopNumberedPreview();
      song.sections.splice(selected, 1);
      selected = song.sections.length === 0 ? null : Math.min(selected, song.sections.length - 1);
      touch();
      renderSections();
    }, "layer-toggle"),
  );

  root.append(steps);
  const draftColumn = document.createElement("div");
  draftColumn.className = "mix-draft-col";
  draftColumn.append(
    step(2, "振る", "偶然で組み替える", rollRow, draftTools),
    step(3, "固定", "層をタップで固定。固定した層は、振っても変わらない", draftEmpty, draftBox),
  );
  const arrangeStep = step(4, "並べる", "セクションを曲にして、通して聴く", addRow, songMeta, timeline, selBar, energyEditor.el);
  arrangeStep.classList.add("mix-step-wide");
  steps.append(step(1, "材料", "使うフレーズを選ぶ", materialEmpty, materialList), draftColumn, arrangeStep);

  // --- 動作 ---

  /** 試聴用：曲のBPMを反映した、ドラフトだけの並び。 */
  function draftForPlay(d: Section): Section[] {
    return effectiveSections({ sections: [d], bpm: song.bpm });
  }

  function updateSongMeta(): void {
    const first = song.sections[0]?.bpm;
    bpmInput.value = song.bpm ? String(song.bpm) : "";
    bpmInput.placeholder = first ? String(first) : "";
    const n = song.sections.length;
    totalLabel.textContent = n === 0 ? "合計 0:00" : `合計 ${formatDuration(songSeconds(song))}（${n}セクション）`;
  }

  function touch(): void {
    song.updatedAt = Date.now();
    deps.onSongChange(song);
  }

  function materialPhrases(): Phrase[] {
    const ids = new Set(song.materialIds);
    return deps.getPhrases().filter((p) => ids.has(p.id));
  }

  function generate(mode: RemixMode, unlock = false): void {
    const materials = collectMaterials(materialPhrases());
    if (materials.length === 0) {
      draftEmpty.textContent =
        song.materialIds.length === 0
          ? "先に、材料のフレーズを選んで"
          : "材料に入れたフレーズに、音符のある層がありません";
      draftEmpty.hidden = false;
      return;
    }
    const rng = createRng(randomSeed());
    if (draft && unlock) for (const l of draft.layers) l.locked = false;
    if (!draft) {
      draft = remixNew(materials, { lengthBars: draftLength }, rng);
    } else if (mode === "new" && draft.lengthBars !== draftLength) {
      // 長さを変えたときは、固定も含めて長さに合わせて作り直す
      draft = remixNew(materials, { lengthBars: draftLength }, rng, draft);
    } else {
      draft = remix(draft, mode, materials, rng);
    }
    renderDraft();
    // 試聴中なら、振り直した結果をすぐ聴けるように鳴らし直す
    if (previewing === "draft" && draft) deps.onPlay(draftForPlay(draft), { kind: "loop", index: 0 }, song);
  }

  function stopAll(): void {
    previewing = null;
    songPlaying = false;
    deps.onStop();
    updateButtons(false);
  }

  /** 並びが変わるので、番号で指していた試聴は止める。 */
  function stopNumberedPreview(): void {
    if (typeof previewing === "number") stopAll();
  }

  function moveSelected(dir: number): void {
    if (selected === null) return;
    const to = selected + dir;
    if (to < 0 || to >= song.sections.length) return;
    stopNumberedPreview();
    const [s] = song.sections.splice(selected, 1);
    song.sections.splice(to, 0, s);
    selected = to;
    touch();
    renderSections();
  }

  function togglePreview(target: "draft" | number): void {
    if (previewing === target) {
      stopAll();
      return;
    }
    songPlaying = false;
    if (target === "draft") {
      if (!draft) return;
      previewing = "draft";
      deps.onPlay(draftForPlay(draft), { kind: "loop", index: 0 }, song);
    } else {
      if (!song.sections[target]) return;
      previewing = target;
      deps.onPlay(effectiveSections(song), { kind: "loop", index: target }, song);
    }
    updateButtons(true);
  }

  function updateButtons(playing: boolean): void {
    previewDraft.textContent = previewing === "draft" ? "止める" : "試聴";
    playSong.textContent = playing && songPlaying ? "止める" : "曲を再生";
    renderSections();
  }

  function renderMaterials(): void {
    const phrases = deps.getPhrases();
    materialList.innerHTML = "";
    materialEmpty.hidden = phrases.length > 0;
    for (const p of phrases) {
      const row = document.createElement("label");
      row.className = "layer-row";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = song.materialIds.includes(p.id);
      check.addEventListener("change", () => {
        song.materialIds = check.checked
          ? [...song.materialIds, p.id]
          : song.materialIds.filter((id) => id !== p.id);
        touch();
      });
      const label = document.createElement("span");
      label.className = "layer-role-label";
      const roles = [...new Set(p.layers.filter((l) => l.notes.length > 0).map((l) => roleLabels[l.role]))];
      label.textContent = `${p.name}（${p.lengthBars}小節 / ${roles.join("・") || "音なし"}）`;
      row.append(check, label);
      materialList.appendChild(row);
    }
  }

  function renderDraft(): void {
    const has = !!draft;
    draftBox.hidden = !has;
    draftEmpty.hidden = has;
    draftTools.hidden = !has;
    previewDraft.hidden = !has;
    addRow.hidden = !has;
    overwrite.hidden = !editingId || !song.sections.some((x) => x.id === editingId);
    soundButton.className = "preset-button" + (soundOpen ? " on" : "");
    if (!draft) return;
    const d = draft;
    if (document.activeElement !== draftName) draftName.value = d.name;
    draftInfo.textContent = `${d.lengthBars}小節 / ${d.bpm}BPM${d.key ? ` / ${keyShortName(d.key)}に合わせる` : ""}`;
    draftLayers.innerHTML = "";
    for (const layer of d.layers) {
      const row = document.createElement("div");
      row.className = "layer-row lock-row" + (layer.locked ? " active" : "");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-pressed", String(!!layer.locked));
      row.title = "タップで固定／解除。固定すると振り直しで変わらない";
      const toggleLock = (): void => {
        layer.locked = !layer.locked;
        renderDraft();
      };
      row.addEventListener("click", toggleLock);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleLock();
        }
      });
      const label = document.createElement("span");
      label.className = "layer-role-label";
      const flags = [layer.muted ? "ミュート中" : "", layer.solo ? "ソロ" : ""].filter(Boolean).join("・");
      label.textContent = `${roleLabels[layer.role]}（${layer.notes.length}音）${flags ? ` ${flags}` : ""}`;
      label.title = layer.sourceLabel ?? "";
      const badge = document.createElement("span");
      badge.className = "lock-badge";
      badge.textContent = layer.locked ? "固定中" : "タップで固定";
      row.append(label, badge);
      draftLayers.appendChild(row);
      if (soundOpen) draftLayers.appendChild(soundStrip(layer));
    }
  }

  /** 音づくり：層ごとの 音量・M・S と、ミキサー（パン・リバーブ・ディレイ・コンプ）。 */
  function soundStrip(layer: MixLayer): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "sound-strip";
    const basic = document.createElement("div");
    basic.className = "sound-basic";
    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "layer-volume";
    volume.min = "0";
    volume.max = String(MAX_VOLUME);
    volume.step = "0.05";
    volume.value = String(layer.volume ?? DEFAULT_VOLUME);
    const showVolume = (): void => {
      volume.title = `音量 ${Math.round((layer.volume ?? DEFAULT_VOLUME) * 100)}%`;
    };
    showVolume();
    volume.addEventListener("input", () => {
      layer.volume = Number(volume.value);
      showVolume();
      deps.onMixChange(layer);
    });
    volume.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
    const volText = document.createElement("span");
    volText.className = "mix-info";
    volText.textContent = "音量";
    const mute = button("M", () => {
      layer.muted = !layer.muted;
      renderDraft();
    }, "layer-toggle" + (layer.muted ? " on" : ""), "ミュート");
    const solo = button("S", () => {
      layer.solo = !layer.solo;
      renderDraft();
    }, "layer-toggle" + (layer.solo ? " on" : ""), "ソロ");
    basic.append(volText, volume, mute, solo);
    strip.append(basic, mixerStrip(layer));
    return strip;
  }

  /** 層のミキサー：パン・リバーブ・ディレイ・コンプ。動かすと鳴っている音にもすぐ効く。 */
  function mixerStrip(layer: MixLayer): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "mixer-strip";
    const defaults = {
      pan: 0,
      reverb: layer.role === "drums" ? 0 : (layer.synth?.effects.reverbSend ?? 0),
      delay: layer.role === "drums" ? 0 : (layer.synth?.effects.delaySend ?? 0),
      comp: 0,
    };
    const controls: { key: "pan" | "reverb" | "delay" | "comp"; label: string; min: number; max: number; fmt: (v: number) => string }[] = [
      { key: "pan", label: "パン", min: -1, max: 1, fmt: (v) => (Math.abs(v) < 0.03 ? "中央" : v < 0 ? `左${Math.round(-v * 100)}` : `右${Math.round(v * 100)}`) },
      { key: "reverb", label: "リバーブ", min: 0, max: 1, fmt: (v) => `${Math.round(v * 100)}%` },
      { key: "delay", label: "ディレイ", min: 0, max: 1, fmt: (v) => `${Math.round(v * 100)}%` },
      { key: "comp", label: "コンプ", min: 0, max: 1, fmt: (v) => (v < 0.02 ? "なし" : `${Math.round(v * 100)}%`) },
    ];
    for (const c of controls) {
      const wrap = document.createElement("label");
      wrap.className = "mixer-control";
      const text = document.createElement("span");
      text.className = "mix-info";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "layer-volume";
      slider.min = String(c.min);
      slider.max = String(c.max);
      slider.step = "0.02";
      const current = (): number => layer.mix?.[c.key] ?? defaults[c.key];
      slider.value = String(current());
      const show = (): void => {
        text.textContent = `${c.label} ${c.fmt(current())}`;
      };
      show();
      slider.addEventListener("input", () => {
        layer.mix = { ...layer.mix, [c.key]: Number(slider.value) };
        show();
        deps.onMixChange(layer);
      });
      slider.addEventListener("dblclick", () => {
        // ダブルクリックで初期値に戻す
        const next = { ...layer.mix };
        delete next[c.key];
        layer.mix = next;
        slider.value = String(defaults[c.key]);
        show();
        deps.onMixChange(layer);
      });
      slider.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
      wrap.append(text, slider);
      strip.appendChild(wrap);
    }
    return strip;
  }

  function renderSections(): void {
    syncEnergy();
    updateSongMeta();
    if (selected !== null && !song.sections[selected]) selected = null;
    timeline.innerHTML = "";
    if (song.sections.length === 0) {
      const empty = document.createElement("div");
      empty.className = "timeline-empty layer-empty";
      empty.textContent = "「曲に追加」で、ここに横に並びます";
      timeline.appendChild(empty);
    }
    const secs = effectiveSections(song);
    song.sections.forEach((section, i) => {
      const block = document.createElement("button");
      block.type = "button";
      block.className =
        "timeline-block" + (selected === i ? " selected" : "") + (playingIndex === i ? " playing" : "");
      // 幅は鳴らす長さに比例（山のキャンバスの帯と同じ）
      block.style.flex = `${Math.max(0.01, sectionSeconds(secs[i]))} 1 0`;
      block.title = `${section.name}（${section.lengthBars}小節）`;
      const name = document.createElement("span");
      name.className = "timeline-name";
      name.textContent = section.name;
      const info = document.createElement("span");
      info.className = "mix-info";
      info.textContent = `${section.lengthBars}小節`;
      block.append(name, info);
      block.addEventListener("click", () => {
        selected = i;
        renderSections();
      });
      timeline.appendChild(block);
    });
    selBar.hidden = selected === null;
    if (selected !== null) {
      if (document.activeElement !== selName) selName.value = song.sections[selected].name;
      selPreview.textContent = previewing === selected ? "止める" : "試聴";
    }
  }

  return {
    el: root,
    setSong(next) {
      song = next;
      editingId = null;
      selected = null;
      renderMaterials();
      renderDraft();
      renderSections();
    },
    refreshMaterials() {
      // 消えたフレーズは材料から外す
      const alive = new Set(deps.getPhrases().map((p) => p.id));
      song.materialIds = song.materialIds.filter((id) => alive.has(id));
      renderMaterials();
    },
    setPlaying(index) {
      if (previewing === "draft") index = null; // ドラフトの試聴は並べたセクションの表示に出さない
      if (index === null && previewing === null && songPlaying) {
        songPlaying = false; // 曲が最後まで鳴り終わった
        playSong.textContent = "曲を再生";
      }
      if (index === playingIndex) return;
      playingIndex = index;
      if (index === null && previewing === null) updateButtons(false);
      else renderSections();
    },
    setProgress(t) {
      energyEditor.setProgress(t);
    },
    layerIds() {
      return [...song.sections.flatMap((s) => s.layers.map((l) => l.id)), ...(draft?.layers.map((l) => l.id) ?? [])];
    },
  };
}
