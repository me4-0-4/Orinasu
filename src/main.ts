import "./style.css";
import { AudioEngine } from "./audio/context";
import { SynthEngine } from "./audio/synth";
import { DrumMachine, drumNoteNumbers, noteNumberToDrum } from "./audio/drums";
import { defaultSynthParams, synthPresets } from "./audio/synthParams";
import { PianoKeyboard } from "./ui/pianoKeyboard";
import { buildSynthPanel } from "./ui/synthPanel";
import { buildDrumPads } from "./ui/drumPads";
import { Visualizer } from "./ui/visualizer";
import { baseMidiNote, noteKeyMap, octaveDownKey, octaveUpKey } from "./input/keymap";
import { Transport, type TransportState } from "./audio/transport";
import { Recorder } from "./phrase/recorder";
import { buildTransportPanel } from "./ui/transportPanel";
import { buildLayerPanel } from "./ui/layerPanel";
import { buildPhraseBrowser } from "./ui/phraseBrowser";
import { PianoRoll } from "./ui/pianoRoll";
import { createEmptyLayer, createEmptyPhrase, type Layer, type Phrase } from "./phrase/types";
import { loadAllPhrases, savePhrase, deletePhrase } from "./storage/db";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = "";

const engine = new AudioEngine();
const synth = new SynthEngine(
  engine.ctx,
  engine.synthDry,
  engine.synthReverbSend,
  engine.synthDelaySend,
  structuredClone(defaultSynthParams),
);
const drums = new DrumMachine(engine.ctx, engine.noiseBuffer, engine.drumOut);

let started = false;
async function ensureAudio(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await engine.resume();
  } catch (err) {
    console.error("AudioContextの再開に失敗しました", err);
    started = false; // 失敗した場合は次の操作でもう一度試せるようにする
    return;
  }
  audioStartButton.textContent = "音声オン";
  audioStartButton.disabled = true;
}

// --- フレーズの状態 ---------------------------------------------------------

let currentPhrase: Phrase | null = null;
let activeLayerId: string | null = null;
let savedPhrases: Phrase[] = [];

function activeLayer(): Layer | null {
  if (!currentPhrase || !activeLayerId) return null;
  return currentPhrase.layers.find((l) => l.id === activeLayerId) ?? null;
}

function ensurePhrase(): Phrase {
  if (!currentPhrase) {
    currentPhrase = createEmptyPhrase(1, 120, 4);
    const layer = createEmptyLayer("melody");
    currentPhrase.layers.push(layer);
    activeLayerId = layer.id;
  }
  return currentPhrase;
}

async function persistCurrentPhrase(): Promise<void> {
  if (!currentPhrase) return;
  currentPhrase.updatedAt = Date.now();
  await savePhrase(currentPhrase);
  await reloadPhraseList();
}

async function reloadPhraseList(): Promise<void> {
  savedPhrases = await loadAllPhrases();
  phraseBrowser.render(savedPhrases, currentPhrase?.id ?? null);
}

function refreshPhraseUI(): void {
  pianoRoll.setPhrase(currentPhrase, activeLayerId);
  layerPanel.render(currentPhrase, activeLayerId);
  if (currentPhrase) {
    transportPanel.setValues({
      bpm: currentPhrase.bpm,
      beatsPerBar: currentPhrase.beatsPerBar,
      lengthBars: currentPhrase.lengthBars,
    });
  }
}

// --- トランスポート（メトロノーム・録音・再生のクロック） -------------------------

const transport = new Transport(engine.ctx, engine.drumOut, {
  getPhrase: () => currentPhrase,
  playNote: (layer, note, time) => {
    if (layer.role === "drums") {
      const id = noteNumberToDrum[note.pitch];
      if (id) drums.trigger(id, note.velocity, time);
    } else {
      synth.noteOn(note.pitch, note.velocity, time);
    }
  },
  stopNote: (layer, note, time) => {
    if (layer.role !== "drums") {
      synth.noteOff(note.pitch, false, time);
    }
  },
  onStateChange: (state: TransportState) => {
    const label =
      state === "count-in" ? "カウントイン中…" : state === "running" ? "再生中" : "停止中";
    transportPanel.setStatus(transport.recording && state !== "stopped" ? `録音中 / ${label}` : label);
    transportPanel.setButtonsEnabled({
      recording: transport.recording && state !== "stopped",
      playing: state !== "stopped",
    });
    if (state === "stopped") {
      refreshPhraseUI();
      void persistCurrentPhrase();
    }
  },
});

const recorder = new Recorder(transport, activeLayer);

function toggleRecord(): void {
  void ensureAudio();
  if (transport.state !== "stopped") {
    transport.stop();
    synth.allNotesOff();
    return;
  }
  const phrase = ensurePhrase();
  if (!activeLayerId && phrase.layers.length > 0) activeLayerId = phrase.layers[0].id;
  refreshPhraseUI();
  transport.start(true);
}

function togglePlay(): void {
  void ensureAudio();
  if (transport.state !== "stopped") {
    transport.stop();
    synth.allNotesOff();
    return;
  }
  if (!currentPhrase) return;
  transport.start(false);
}

// --- 画面構築 -----------------------------------------------------------

const header = document.createElement("header");
header.className = "app-header";
const title = document.createElement("div");
title.className = "app-title";
title.textContent = "Orinasu";

const audioStartButton = document.createElement("button");
audioStartButton.type = "button";
audioStartButton.className = "audio-start-button";
audioStartButton.textContent = "音声を出す";
audioStartButton.addEventListener("click", () => void ensureAudio());

const latency = document.createElement("div");
latency.className = "latency-readout";
header.append(title, audioStartButton, latency);

const main = document.createElement("main");
main.className = "app-main";

const synthColumn = document.createElement("section");
synthColumn.className = "panel-column";
const synthHeading = document.createElement("div");
synthHeading.className = "panel-heading";
synthHeading.textContent = "シンセ";

const presetRow = document.createElement("div");
presetRow.className = "preset-row";
for (const preset of synthPresets) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "preset-button";
  btn.textContent = preset.name;
  btn.addEventListener("click", () => {
    void ensureAudio();
    panel.applyPreset(preset.params);
  });
  presetRow.appendChild(btn);
}

const panel = buildSynthPanel(defaultSynthParams, (params) => {
  synth.updateParams(params);
  visualizer.drawStatic();
});

const visualizer = new Visualizer(engine.ctx, engine.analyser, () => synth.params);

synthColumn.append(synthHeading, presetRow, panel.el, visualizer.el);

const drumColumn = document.createElement("section");
drumColumn.className = "panel-column panel-column-narrow";
const drumHeading = document.createElement("div");
drumHeading.className = "panel-heading";
drumHeading.textContent = "ドラム";
const pads = buildDrumPads((id) => {
  void ensureAudio();
  drums.trigger(id);
  recorder.hit(drumNoteNumbers[id]);
});
drumColumn.append(drumHeading, pads);

const performTab = document.createElement("div");
performTab.className = "tab-panel";
performTab.append(synthColumn, drumColumn);
main.append(performTab);

// --- フレーズ列 -----------------------------------------------------------

const phraseColumn = document.createElement("section");
phraseColumn.className = "panel-column phrase-column";
const phraseHeading = document.createElement("div");
phraseHeading.className = "panel-heading";
phraseHeading.textContent = "フレーズ";

const transportPanel = buildTransportPanel(
  { bpm: 120, beatsPerBar: 4, lengthBars: 1 },
  {
    onBpmChange: (bpm) => {
      ensurePhrase().bpm = bpm;
    },
    onBeatsPerBarChange: (n) => {
      ensurePhrase().beatsPerBar = n;
      refreshPhraseUI();
    },
    onLengthChange: (bars) => {
      ensurePhrase().lengthBars = bars;
      refreshPhraseUI();
    },
    onRecord: toggleRecord,
    onPlay: togglePlay,
    onStop: () => {
      transport.stop();
      synth.allNotesOff();
    },
    onMetronomeToggle: (enabled) => {
      transport.metronome.enabled = enabled;
    },
  },
);

const layerPanel = buildLayerPanel({
  onAddLayer: (role) => {
    const phrase = ensurePhrase();
    const layer = createEmptyLayer(role);
    phrase.layers.push(layer);
    activeLayerId = layer.id;
    refreshPhraseUI();
  },
  onSelectActive: (id) => {
    activeLayerId = id;
    refreshPhraseUI();
  },
  onToggleMute: (id) => {
    const layer = currentPhrase?.layers.find((l) => l.id === id);
    if (layer) layer.muted = !layer.muted;
    refreshPhraseUI();
  },
  onToggleSolo: (id) => {
    const layer = currentPhrase?.layers.find((l) => l.id === id);
    if (layer) layer.solo = !layer.solo;
    refreshPhraseUI();
  },
  onDeleteLayer: (id) => {
    if (!currentPhrase) return;
    currentPhrase.layers = currentPhrase.layers.filter((l) => l.id !== id);
    if (activeLayerId === id) {
      activeLayerId = currentPhrase.layers[0]?.id ?? null;
    }
    refreshPhraseUI();
    void persistCurrentPhrase();
  },
  onQuantizeChange: (id, grid) => {
    const layer = currentPhrase?.layers.find((l) => l.id === id);
    if (layer) layer.quantizeGrid = grid;
    refreshPhraseUI();
    void persistCurrentPhrase();
  },
});

const pianoRoll = new PianoRoll();
pianoRoll.onChange = () => {
  void persistCurrentPhrase();
  layerPanel.render(currentPhrase, activeLayerId);
};

const phraseBrowser = buildPhraseBrowser({
  onNew: () => {
    transport.stop();
    currentPhrase = createEmptyPhrase(1, 120, 4);
    const layer = createEmptyLayer("melody");
    currentPhrase.layers.push(layer);
    activeLayerId = layer.id;
    refreshPhraseUI();
    void reloadPhraseList();
  },
  onLoad: (id) => {
    transport.stop();
    const found = savedPhrases.find((p) => p.id === id);
    if (!found) return;
    currentPhrase = structuredClone(found);
    activeLayerId = currentPhrase.layers[0]?.id ?? null;
    refreshPhraseUI();
    void reloadPhraseList();
  },
  onDelete: async (id) => {
    await deletePhrase(id);
    if (currentPhrase?.id === id) {
      currentPhrase = null;
      activeLayerId = null;
      refreshPhraseUI();
    }
    await reloadPhraseList();
  },
  onRename: async (id, name) => {
    if (currentPhrase?.id === id) {
      currentPhrase.name = name;
      await persistCurrentPhrase();
      return;
    }
    const found = savedPhrases.find((p) => p.id === id);
    if (found) {
      found.name = name;
      found.updatedAt = Date.now();
      await savePhrase(found);
      await reloadPhraseList();
    }
  },
  onSave: () => {
    ensurePhrase();
    void persistCurrentPhrase();
  },
});

phraseColumn.append(
  phraseHeading,
  transportPanel.el,
  layerPanel.el,
  pianoRoll.el,
  phraseBrowser.el,
);
const phraseTab = document.createElement("div");
phraseTab.className = "tab-panel";
phraseTab.append(phraseColumn);
main.append(phraseTab);

// --- タブ切り替え ---------------------------------------------------------

const tabBar = document.createElement("nav");
tabBar.className = "tab-bar";
const tabs: { id: string; label: string; panel: HTMLElement }[] = [
  { id: "perform", label: "演奏", panel: performTab },
  { id: "phrase", label: "フレーズ", panel: phraseTab },
];
function selectTab(id: string): void {
  for (const tab of tabs) {
    const active = tab.id === id;
    tab.panel.classList.toggle("active", active);
  }
  for (const btn of tabBar.querySelectorAll<HTMLButtonElement>("button")) {
    btn.classList.toggle("active", btn.dataset.tabId === id);
  }
}
for (const tab of tabs) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tab-button";
  btn.textContent = tab.label;
  btn.dataset.tabId = tab.id;
  btn.addEventListener("click", () => selectTab(tab.id));
  tabBar.appendChild(btn);
}
selectTab("perform");

const footer = document.createElement("footer");
footer.className = "app-footer";
const octaveLabel = document.createElement("div");
octaveLabel.className = "octave-label";
const keyboard = new PianoKeyboard(48, 3);
footer.append(octaveLabel, keyboard.el);

app.append(header, tabBar, main, footer);

// ブラウザの自動再生制限により、最初の操作（鍵盤・ツマミ・ボタンなど何でも）で
// AudioContextを解放する。専用の開始画面は置かず、最初から普通に触れる状態にする。
window.addEventListener("pointerdown", () => void ensureAudio());
window.addEventListener("keydown", () => void ensureAudio());

// --- 鍵盤の演奏 -----------------------------------------------------------

const activeNotes = new Set<number>();
function noteOn(note: number): void {
  void ensureAudio();
  if (activeNotes.has(note)) return;
  activeNotes.add(note);
  synth.noteOn(note);
  recorder.noteOn(note);
  keyboard.setActiveNotes(activeNotes);
}
function noteOff(note: number): void {
  if (!activeNotes.has(note)) return;
  activeNotes.delete(note);
  synth.noteOff(note);
  recorder.noteOff(note);
  keyboard.setActiveNotes(activeNotes);
}

keyboard.onNoteOn = noteOn;
keyboard.onNoteOff = noteOff;

let octaveShift = 0;
function updateOctaveLabel(): void {
  octaveLabel.textContent = `オクターブ ${octaveShift >= 0 ? "+" : ""}${octaveShift}（Z/X）`;
}
function updateKeyLabels(): void {
  const labels = new Map<number, string>();
  for (const [key, offset] of Object.entries(noteKeyMap)) {
    const note = baseMidiNote + offset + octaveShift * 12;
    labels.set(note, key.toUpperCase());
  }
  keyboard.setKeyLabels(labels);
}
updateOctaveLabel();
updateKeyLabels();

const heldKeys = new Map<string, number>();

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "SELECT")) return;
  if (e.code === "Space") {
    // スペースキーはページスクロールやフォーカス中ボタンのクリックを引き起こすため、
    // それを止めた上で「再生⇔停止」専用のキーにする（録音の開始はしない）。
    e.preventDefault();
    togglePlay();
    return;
  }
  const key = e.key.toLowerCase();
  if (key === octaveDownKey) {
    octaveShift = Math.max(-3, octaveShift - 1);
    updateOctaveLabel();
    updateKeyLabels();
    return;
  }
  if (key === octaveUpKey) {
    octaveShift = Math.min(3, octaveShift + 1);
    updateOctaveLabel();
    updateKeyLabels();
    return;
  }
  const offset = noteKeyMap[key];
  if (offset === undefined) return;
  const note = baseMidiNote + offset + octaveShift * 12;
  heldKeys.set(key, note);
  noteOn(note);
});

window.addEventListener("keyup", (e) => {
  const key = e.key.toLowerCase();
  const note = heldKeys.get(key);
  if (note === undefined) return;
  heldKeys.delete(key);
  noteOff(note);
});

window.addEventListener("blur", () => {
  for (const note of heldKeys.values()) noteOff(note);
  heldKeys.clear();
});

// --- 表示更新 -------------------------------------------------------------

visualizer.start();

function updateLatency(): void {
  const ms = (engine.estimatedLatency * 1000).toFixed(1);
  latency.textContent = `出力遅延の目安: ${ms} ms`;
}
updateLatency();
window.setInterval(updateLatency, 500);

let lastPlayheadBeats: number | null = -1;
function playheadLoop(): void {
  const beats = transport.currentPositionBeats();
  if (beats !== lastPlayheadBeats) {
    pianoRoll.setPlayheadBeats(beats);
    lastPlayheadBeats = beats;
  }
  requestAnimationFrame(playheadLoop);
}
playheadLoop();

void reloadPhraseList();
refreshPhraseUI();
