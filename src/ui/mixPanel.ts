import { DEFAULT_VOLUME, MAX_VOLUME } from "../audio/layerSynths";
import { collectMaterials, remix, remixLabels, remixNew, type RemixMode } from "../mix/remix";
import {
  MAX_BPM,
  MIN_BPM,
  createEmptySong,
  duplicateSection,
  effectiveSections,
  formatDuration,
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
  /** 「編集」で曲の中のセクションから戻したときの元のid。「上書き」で差し替える先。 */
  let editingId: string | null = null;
  /** ミキサーを開いている層のid。 */
  const openMixers = new Set<string>();
  /** 試聴の対象：ドラフトか、並べたセクションの番号か。 */
  let previewing: "draft" | number | null = null;
  /** 「曲を再生」で並べた順に通して鳴らしている最中か。 */
  let songPlaying = false;

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
    energyEditor.setData(song.energy, song.macros, effectiveSections(song));
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
    touch();
    renderSections();
  }, "preset-button", "編集元のセクションを、いまの内容で差し替える");
  overwrite.hidden = true;
  const previewDraft = button("試聴", () => togglePreview("draft"), "preset-button");
  draftActions.append(previewDraft, addToSong, overwrite);
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
  });
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
  songMeta.append(bpmLabel, totalLabel);
  songActions.append(playSong);

  columns.append(
    column("材料", materialEmpty, materialList, makeRow),
    column("いまのセクション", draftEmpty, draftBox),
    column("曲の流れ", songMeta, sectionList, songActions),
  );
  root.append(columns, energyEditor.el);
  draftBox.append(draftName, draftInfo, draftLayers, draftTools, draftActions);
  draftBox.hidden = true;

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
    if (previewing === "draft" && draft) deps.onPlay(draftForPlay(draft), { kind: "loop", index: 0 }, song);
  }

  function stopAll(): void {
    previewing = null;
    songPlaying = false;
    deps.onStop();
    updateButtons(false);
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
    draftBox.hidden = !draft;
    draftEmpty.hidden = !!draft;
    overwrite.hidden = !editingId || !song.sections.some((x) => x.id === editingId);
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
        deps.onMixChange(layer);
      });
      volume.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
      const mixOpen = openMixers.has(layer.id);
      const mixBtn = button("MIX", () => {
        if (mixOpen) openMixers.delete(layer.id);
        else openMixers.add(layer.id);
        renderDraft();
      }, "layer-toggle" + (mixOpen ? " on" : ""), "パン・リバーブ・ディレイ・コンプ");
      row.append(label, volume, lock, mute, solo, mixBtn);
      draftLayers.appendChild(row);
      if (mixOpen) draftLayers.appendChild(mixerStrip(layer));
    }
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
          editingId = section.id;
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
      editingId = null;
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
