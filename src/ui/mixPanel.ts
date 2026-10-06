import { DEFAULT_VOLUME, MAX_VOLUME } from "../audio/layerSynths";
import { collectMaterials, remix, remixLabels, remixNew, type RemixMode } from "../mix/remix";
import { createEmptySong, duplicateSection, type Section, type Song } from "../mix/types";
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

function column(heading: string, ...children: HTMLElement[]): HTMLElement {
  const col = document.createElement("div");
  col.className = "panel-column";
  const h = document.createElement("div");
  h.className = "panel-heading";
  h.textContent = heading;
  col.append(h, ...children);
  return col;
}

export function buildMixPanel(deps: MixPanelDeps): MixPanel {
  let song: Song = createEmptySong();
  let draft: Section | null = null;
  let draftLength = 4;
  let playingIndex: number | null = null;
  /** 試聴の対象：ドラフトか、並べたセクションの番号か。 */
  let previewing: "draft" | number | null = null;

  const root = document.createElement("div");
  root.className = "tab-panel mix-tab";
  const columns = document.createElement("div");
  columns.className = "mix-columns";

  const energyEditor = buildEnergyEditor({
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
    energyEditor.setData(song.energy, song.macros, song.sections);
  }

  // --- 材料 ---
  const materialList = document.createElement("div");
  materialList.className = "mix-list";
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
  const makeRow = document.createElement("div");
  makeRow.className = "preset-row";
  makeRow.append(
    lengthSelect,
    button("組み替える", () => generate("new"), "preset-button", "材料から新しいセクションを作る。固定した層は残す"),
  );
  const materialEmpty = document.createElement("div");
  materialEmpty.className = "layer-empty";
  materialEmpty.textContent = "フレーズタブで保存したフレーズが、ここに並びます";

  // --- ドラフト ---
  const draftName = document.createElement("input");
  draftName.type = "text";
  draftName.className = "mix-name";
  draftName.placeholder = "セクション名（イントロ、A、サビ…）";
  draftName.addEventListener("input", () => {
    if (draft) draft.name = draftName.value;
  });
  const draftInfo = document.createElement("div");
  draftInfo.className = "mix-info";
  const draftLayers = document.createElement("div");
  draftLayers.className = "layer-list";
  const draftActions = document.createElement("div");
  draftActions.className = "preset-row";
  const draftTools = document.createElement("div");
  draftTools.className = "preset-row";
  for (const mode of ["recut", "rhythm", "order"] as const) {
    draftTools.appendChild(
      button(remixLabels[mode], () => generate(mode), "preset-button", "固定していない層だけ振り直す"),
    );
  }
  draftTools.append(
    button("全部振り直す", () => generate("new", true), "preset-button", "固定も外して、まるごと作り直す"),
  );
  const addToSong = button("曲に追加", () => {
    if (!draft) return;
    const copy = duplicateSection(draft);
    copy.name = draft.name.trim() || `セクション${song.sections.length + 1}`;
    song.sections.push(copy);
    touch();
    renderSections();
  });
  const previewDraft = button("試聴", () => togglePreview("draft"), "preset-button");
  draftActions.append(previewDraft, addToSong);
  const draftBox = document.createElement("div");
  draftBox.className = "mix-draft";
  const draftEmpty = document.createElement("div");
  draftEmpty.className = "layer-empty";
  draftEmpty.textContent = "材料を選んで「組み替える」";

  // --- 曲の流れ ---
  const sectionList = document.createElement("div");
  sectionList.className = "mix-list";
  const songActions = document.createElement("div");
  songActions.className = "preset-row";
  const playSong = button("曲を再生", () => {
    if (previewing === "draft" || typeof previewing === "number" || playingIndex !== null) {
      stopAll();
      return;
    }
    if (song.sections.length === 0) return;
    previewing = null;
    deps.onPlay(song.sections, { kind: "song" }, song);
    updateButtons(true);
  });
  songActions.append(playSong);

  columns.append(
    column("材料", materialEmpty, materialList, makeRow),
    column("いまのセクション", draftEmpty, draftBox),
    column("曲の流れ", sectionList, songActions),
  );
  root.append(columns, energyEditor.el);
  draftBox.append(draftName, draftInfo, draftLayers, draftTools, draftActions);
  draftBox.hidden = true;

  // --- 動作 ---

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
      draftEmpty.textContent = "材料に入れたフレーズに、音符のある層がありません";
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
    if (previewing === "draft" && draft) deps.onPlay([draft], { kind: "loop", index: 0 }, song);
  }

  function stopAll(): void {
    previewing = null;
    deps.onStop();
    updateButtons(false);
  }

  function togglePreview(target: "draft" | number): void {
    if (previewing === target) {
      stopAll();
      return;
    }
    if (target === "draft") {
      if (!draft) return;
      previewing = "draft";
      deps.onPlay([draft], { kind: "loop", index: 0 }, song);
    } else {
      if (!song.sections[target]) return;
      previewing = target;
      deps.onPlay(song.sections, { kind: "loop", index: target }, song);
    }
    updateButtons(true);
  }

  function updateButtons(playing: boolean): void {
    previewDraft.textContent = previewing === "draft" ? "止める" : "試聴";
    playSong.textContent = playing ? "止める" : "曲を再生";
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
    draftBox.hidden = !draft;
    draftEmpty.hidden = !!draft;
    if (!draft) return;
    const d = draft;
    draftName.value = d.name;
    draftInfo.textContent = `${d.lengthBars}小節 / ${d.bpm}BPM${d.key ? ` / ${keyShortName(d.key)}に合わせる` : ""}`;
    draftLayers.innerHTML = "";
    for (const layer of d.layers) {
      const row = document.createElement("div");
      row.className = "layer-row" + (layer.locked ? " active" : "");
      const label = document.createElement("span");
      label.className = "layer-role-label";
      label.textContent = `${roleLabels[layer.role]}（${layer.notes.length}音）`;
      label.title = layer.sourceLabel ?? "";
      const lock = button(layer.locked ? "固定中" : "固定", () => {
        layer.locked = !layer.locked;
        renderDraft();
      }, "layer-toggle" + (layer.locked ? " on" : ""), "固定すると振り直しで変わらない");
      const mute = button("M", () => {
        layer.muted = !layer.muted;
        renderDraft();
      }, "layer-toggle" + (layer.muted ? " on" : ""), "ミュート");
      const solo = button("S", () => {
        layer.solo = !layer.solo;
        renderDraft();
      }, "layer-toggle" + (layer.solo ? " on" : ""), "ソロ");
      const volume = document.createElement("input");
      volume.type = "range";
      volume.className = "layer-volume";
      volume.min = "0";
      volume.max = String(MAX_VOLUME);
      volume.step = "0.05";
      volume.value = String(layer.volume ?? DEFAULT_VOLUME);
      volume.title = `音量 ${Math.round((layer.volume ?? DEFAULT_VOLUME) * 100)}%`;
      volume.addEventListener("input", () => {
        layer.volume = Number(volume.value);
        volume.title = `音量 ${Math.round(layer.volume * 100)}%`;
      });
      volume.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
      row.append(label, volume, lock, mute, solo);
      draftLayers.appendChild(row);
    }
  }

  function renderSections(): void {
    syncEnergy();
    sectionList.innerHTML = "";
    if (song.sections.length === 0) {
      const empty = document.createElement("div");
      empty.className = "layer-empty";
      empty.textContent = "「曲に追加」で、ここに並びます";
      sectionList.appendChild(empty);
    }
    song.sections.forEach((section, i) => {
      const row = document.createElement("div");
      row.className = "layer-row" + (playingIndex === i ? " active" : "");
      const name = document.createElement("input");
      name.type = "text";
      name.className = "mix-name";
      name.value = section.name;
      name.addEventListener("change", () => {
        section.name = name.value.trim() || section.name;
        touch();
      });
      const info = document.createElement("span");
      info.className = "mix-info";
      info.textContent = `${section.lengthBars}小節`;
      const move = (to: number): void => {
        if (to < 0 || to >= song.sections.length) return;
        const [s] = song.sections.splice(i, 1);
        song.sections.splice(to, 0, s);
        touch();
        renderSections();
      };
      row.append(
        name,
        info,
        button(previewing === i ? "止める" : "試聴", () => togglePreview(i), "layer-toggle"),
        button("↑", () => move(i - 1), "layer-toggle", "前へ"),
        button("↓", () => move(i + 1), "layer-toggle", "後ろへ"),
        button("編集", () => {
          // 並べたものは触らず、複製をドラフトに戻して作り直せるようにする
          draft = duplicateSection(section);
          draft.name = section.name;
          renderDraft();
        }, "layer-toggle", "複製をいまのセクションに戻す"),
        button("複製", () => {
          song.sections.splice(i + 1, 0, duplicateSection(section));
          touch();
          renderSections();
        }, "layer-toggle"),
        button("削除", () => {
          song.sections.splice(i, 1);
          touch();
          renderSections();
        }, "layer-toggle"),
      );
      sectionList.appendChild(row);
    });
  }

  return {
    el: root,
    setSong(next) {
      song = next;
      renderMaterials();
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
