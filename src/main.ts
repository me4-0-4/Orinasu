import "./style.css";
import { AudioEngine } from "./audio/context";
import { SynthEngine } from "./audio/synth";
import { DrumMachine } from "./audio/drums";
import { defaultSynthParams, synthPresets } from "./audio/synthParams";
import { PianoKeyboard } from "./ui/pianoKeyboard";
import { buildSynthPanel } from "./ui/synthPanel";
import { buildDrumPads } from "./ui/drumPads";
import { Visualizer } from "./ui/visualizer";
import { baseMidiNote, noteKeyMap, octaveDownKey, octaveUpKey } from "./input/keymap";

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
  await engine.resume();
  startOverlay.remove();
}

// --- 画面構築 -----------------------------------------------------------

const header = document.createElement("header");
header.className = "app-header";
const title = document.createElement("div");
title.className = "app-title";
title.textContent = "Orinasu";
const latency = document.createElement("div");
latency.className = "latency-readout";
header.append(title, latency);

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
});
drumColumn.append(drumHeading, pads);

main.append(synthColumn, drumColumn);

const footer = document.createElement("footer");
footer.className = "app-footer";
const octaveLabel = document.createElement("div");
octaveLabel.className = "octave-label";
const keyboard = new PianoKeyboard(48, 3);
footer.append(octaveLabel, keyboard.el);

const startOverlay = document.createElement("div");
startOverlay.className = "start-overlay";
startOverlay.textContent = "タップして音を出す";
startOverlay.addEventListener("pointerdown", () => void ensureAudio());

app.append(header, main, footer, startOverlay);

// --- 鍵盤の演奏 -----------------------------------------------------------

const activeNotes = new Set<number>();
function noteOn(note: number): void {
  void ensureAudio();
  if (activeNotes.has(note)) return;
  activeNotes.add(note);
  synth.noteOn(note);
  keyboard.setActiveNotes(activeNotes);
}
function noteOff(note: number): void {
  if (!activeNotes.has(note)) return;
  activeNotes.delete(note);
  synth.noteOff(note);
  keyboard.setActiveNotes(activeNotes);
}

keyboard.onNoteOn = noteOn;
keyboard.onNoteOff = noteOff;

let octaveShift = 0;
function updateOctaveLabel(): void {
  octaveLabel.textContent = `オクターブ ${octaveShift >= 0 ? "+" : ""}${octaveShift}（Z/X）`;
}
updateOctaveLabel();

const heldKeys = new Map<string, number>();

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const key = e.key.toLowerCase();
  if (key === octaveDownKey) {
    octaveShift = Math.max(-3, octaveShift - 1);
    updateOctaveLabel();
    return;
  }
  if (key === octaveUpKey) {
    octaveShift = Math.min(3, octaveShift + 1);
    updateOctaveLabel();
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
