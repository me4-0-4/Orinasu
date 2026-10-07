import "./style.css";
import { AudioEngine } from "./audio/context";
import type { SynthEngine } from "./audio/synth";
import { LayerSynths, DEFAULT_VOLUME } from "./audio/layerSynths";
import { DrumMachine, drumNoteNumbers, noteNumberToDrum, type DrumId } from "./audio/drums";
import { clone, defaultSynthParams, synthPresets, type SynthParams } from "./audio/synthParams";
import { PianoKeyboard } from "./ui/pianoKeyboard";
import { buildSynthPanel } from "./ui/synthPanel";
import { buildDrumPads } from "./ui/drumPads";
import { Visualizer } from "./ui/visualizer";
import { baseMidiNote, drumKeyMap, noteKeyMap, octaveDownKey, octaveUpKey } from "./input/keymap";
import { Transport, type TransportState } from "./audio/transport";
import { Recorder } from "./phrase/recorder";
import { buildTransportPanel } from "./ui/transportPanel";
import { buildLayerPanel } from "./ui/layerPanel";
import { buildPhraseBrowser } from "./ui/phraseBrowser";
import { PianoRoll } from "./ui/pianoRoll";
import {
  createEmptyLayer,
  createEmptyPhrase,
  makeId,
  totalBeats as phraseTotalBeats,
  roleLabels,
  type Layer,
  type LayerRole,
  type Note,
  type Phrase,
} from "./phrase/types";
import { Arpeggiator } from "./audio/arpeggiator";
import { buildAssistPanel } from "./ui/assistPanel";
import {
  detectKeys,
  noteNamesFor,
  scalePitchClasses,
  snapToScale,
  type Key,
  type KeyCandidate,
} from "./theory/key";
import {
  chordAt,
  chordName,
  chordPitchClasses,
  fifthPitchClass,
  makeSegments,
  rankChordsForSegment,
  suggestProgression,
  type ChordSlot,
} from "./theory/chords";
import { drumParts, generateDrumPart, partPitches, type DrumGenre, type DrumPart } from "./theory/drumPattern";
import { nextRecommendation } from "./theory/recommend";
import { randomSeed } from "./theory/rng";
import {
  loadAllPhrases,
  savePhrase,
  deletePhrase,
  loadUserPresets,
  loadSong,
  saveSong,
  saveUserPreset,
  deleteUserPreset,
  type UserPreset,
} from "./storage/db";
import { initCloud } from "./cloud/sync";
import { createCloudPanel } from "./ui/cloudPanel";
import { buildUserPresets } from "./ui/userPresets";
import { buildMixPanel } from "./ui/mixPanel";
import { SongPlayer } from "./mix/player";
import { SONG_ID, createEmptySong, type Song } from "./mix/types";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = "";

const engine = new AudioEngine();
// 音色と音量は層ごと。層のないとき（まだ何も録音していない状態）の試し弾き用に、仮の層を1つ持つ。
const synths = new LayerSynths(engine);
const scratchLayer: Layer = {
  ...createEmptyLayer("melody"),
  id: "scratch",
  synth: clone(defaultSynthParams),
};

/** 音色ツマミの編集対象・ライブ演奏の音源にする層。ドラム層を選んでいる間は直前のシンセ層のまま。 */
let lastSoundLayerId: string | null = null;
function soundLayer(): Layer {
  const active = activeLayer();
  if (active && active.role !== "drums") {
    lastSoundLayerId = active.id;
    return active;
  }
  const last = currentPhrase?.layers.find((l) => l.id === lastSoundLayerId && l.role !== "drums");
  return last ?? scratchLayer;
}

/** 鳴らし始めた音を、どのシンセで鳴らしたか覚えておく（途中で編集対象の層が変わっても正しく止める）。 */
const liveEngines = new Map<string, SynthEngine>();
function liveOn(voiceId: string, pitch: number, velocity = 1): void {
  const eng = synths.forLayer(soundLayer());
  liveEngines.set(voiceId, eng);
  eng.noteOn(voiceId, pitch, velocity);
}
function liveOff(voiceId: string): void {
  const eng = liveEngines.get(voiceId);
  if (!eng) return;
  liveEngines.delete(voiceId);
  eng.noteOff(voiceId);
}
function allSoundsOff(): void {
  synths.allNotesOff();
  liveEngines.clear();
}

const drums = new DrumMachine(engine.ctx, engine.noiseBuffer, engine.drumOut);

// アルペジエーターは楽器に依存しない独立部品。ここでシンセ（と録音）につないでいる。
const arp = new Arpeggiator(engine.ctx, {
  getBpm: () => currentPhrase?.bpm ?? 120,
  noteOn: (pitch) => {
    liveOn(`arp:${pitch}`, pitch);
    recorder.noteOn(pitch);
  },
  noteOff: (pitch) => {
    liveOff(`arp:${pitch}`);
    recorder.noteOff(pitch);
  },
});

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
    layer.synth = clone(scratchLayer.synth ?? defaultSynthParams); // 試し弾きで作った音を引き継ぐ
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

let persistTimer: number | null = null;
/** ツマミやスライダーを動かしている間に何度も保存しないよう、少し待ってからまとめて保存する。 */
function persistSoon(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void persistCurrentPhrase();
  }, 600);
}

async function reloadPhraseList(): Promise<void> {
  savedPhrases = await loadAllPhrases();
  phraseBrowser.render(savedPhrases, currentPhrase?.id ?? null);
  mixPanel.refreshMaterials();
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
  synths.prune(new Set([...(currentPhrase?.layers.map((l) => l.id) ?? []), ...mixPanel.layerIds()]));
  updateFooterMode();
  syncSoundPanel();
  refreshAssist();
}

// --- トランスポート（メトロノーム・録音・再生のクロック） -------------------------

const transport = new Transport(engine.ctx, engine.drumOut, {
  getPhrase: () => currentPhrase,
  playNote: (layer, note, time) => {
    if (layer.role === "drums") {
      const id = noteNumberToDrum[note.pitch];
      if (id) drums.trigger(id, note.velocity * (layer.volume ?? DEFAULT_VOLUME), time);
    } else {
      synths.forLayer(layer).noteOn(`sched:${note.id}`, note.pitch, note.velocity, time);
    }
  },
  stopNote: (layer, note, time) => {
    if (layer.role !== "drums") {
      synths.forLayer(layer).noteOff(`sched:${note.id}`, false, time);
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

// --- MIX（セクションを並べて鳴らす） -----------------------------------------

const songPlayer = new SongPlayer(engine.ctx, {
  playNote: (layer, note, time, voiceKey) => {
    if (layer.role === "drums") {
      const id = noteNumberToDrum[note.pitch];
      if (id) drums.trigger(id, note.velocity * (layer.volume ?? DEFAULT_VOLUME), time, synths.drumOut(layer));
    } else {
      synths.forLayer(layer).noteOn(`mix:${voiceKey}`, note.pitch, note.velocity, time);
    }
  },
  stopNote: (layer, _note, time, voiceKey) => {
    if (layer.role !== "drums") synths.forLayer(layer).noteOff(`mix:${voiceKey}`, false, time);
  },
  onSection: (index) => mixPanel.setPlaying(index),
  onFilterOffset: (cents) => synths.setFilterOffsetAll(cents),
  onEnd: () => {
    allSoundsOff();
    mixPanel.setPlaying(null);
  },
});

function stopSongPlayer(): void {
  if (!songPlayer.playing) return;
  songPlayer.stop();
  allSoundsOff();
}

let persistSongTimer: number | null = null;
function persistSongSoon(song: Song): void {
  if (persistSongTimer !== null) window.clearTimeout(persistSongTimer);
  persistSongTimer = window.setTimeout(() => {
    persistSongTimer = null;
    void saveSong(song);
  }, 400);
}

const mixPanel = buildMixPanel({
  getPhrases: () => savedPhrases,
  onSongChange: persistSongSoon,
  onPlay: (sections, mode, song) => {
    void ensureAudio();
    stopPreview();
    if (transport.state !== "stopped") transport.stop();
    allSoundsOff();
    // 山とマクロは、曲を通して鳴らすときだけ効かせる（セクションの試聴は素のまま）
    const shaping = song.energy && song.macros ? { curve: song.energy, macros: song.macros } : undefined;
    songPlayer.start(sections, mode, shaping);
  },
  onStop: stopSongPlayer,
  onMixChange: (layer) => synths.refresh(layer),
});

function toggleRecord(): void {
  void ensureAudio();
  stopPreview();
  stopSongPlayer();
  if (transport.state !== "stopped") {
    transport.stop();
    allSoundsOff();
    return;
  }
  const phrase = ensurePhrase();
  if (!activeLayerId && phrase.layers.length > 0) activeLayerId = phrase.layers[0].id;
  refreshPhraseUI();
  transport.start(true);
}

function togglePlay(): void {
  void ensureAudio();
  stopPreview();
  stopSongPlayer();
  if (transport.state !== "stopped") {
    transport.stop();
    allSoundsOff();
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
header.append(title, audioStartButton, latency, createCloudPanel());

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

let panelBoundParams: SynthParams | null = null;
const panel = buildSynthPanel(defaultSynthParams, (params) => {
  // パネルは同じオブジェクトを書き換え続けるので、必ずコピーを層に渡す
  const target = soundLayer();
  synths.setParams(target, clone(params));
  panelBoundParams = target.synth ?? null;
  visualizer.drawStatic();
  if (target !== scratchLayer) persistSoon();
});

const visualizer = new Visualizer(
  engine.ctx,
  engine.analyser,
  () => soundLayer().synth ?? defaultSynthParams,
);

/** 音色ツマミの表示を、編集対象の層の音色に合わせる。 */
function syncSoundPanel(): void {
  const target = soundLayer();
  synths.forLayer(target); // 音色が未設定なら役割ごとの初期音色が入る
  if (target.synth && target.synth !== panelBoundParams) {
    panelBoundParams = target.synth;
    panel.setParams(target.synth);
    visualizer.drawStatic();
  }
  synthHeading.textContent =
    target === scratchLayer ? "シンセ" : `シンセ（編集中：${roleLabels[target.role]}の層）`;
}

// 自分の音色：いま編集中の層の音色を名前を付けて保存し、あとで別の層にも使える
let userPresets: UserPreset[] = [];
const userPresetUi = buildUserPresets({
  onApply: (preset) => {
    void ensureAudio();
    panel.applyPreset(preset.params);
  },
  onSave: (name) => {
    const params = soundLayer().synth;
    if (!params) return;
    // 同じ名前があれば上書きする
    const existing = userPresets.find((p) => p.name === name);
    const preset: UserPreset = {
      id: existing?.id ?? makeId("preset"),
      name,
      params: clone(params),
      updatedAt: Date.now(),
    };
    void saveUserPreset(preset).then(reloadUserPresets);
  },
  onDelete: (preset) => {
    if (!window.confirm(`音色「${preset.name}」を削除する？`)) return;
    void deleteUserPreset(preset.id).then(reloadUserPresets);
  },
});
async function reloadUserPresets(): Promise<void> {
  userPresets = await loadUserPresets();
  userPresetUi.render(userPresets);
}
void reloadUserPresets();

synthColumn.append(synthHeading, presetRow, userPresetUi.el, panel.el, visualizer.el);

const drumColumn = document.createElement("section");
drumColumn.className = "panel-column panel-column-narrow";
const drumHeading = document.createElement("div");
drumHeading.className = "panel-heading";
drumHeading.textContent = "ドラム";
function hitDrum(id: DrumId): void {
  void ensureAudio();
  drums.trigger(id);
  recorder.hit(drumNoteNumbers[id]);
}
const pads = buildDrumPads(hitDrum);
drumColumn.append(drumHeading, pads.el);

const performTab = document.createElement("div");
performTab.className = "tab-panel";
performTab.append(synthColumn, drumColumn);
main.append(performTab);

// --- 段階3：手助け（調・コード・ベース・ドラム候補・アルペジエーター） -----------------

let detectedKeys: KeyCandidate[] = [];
let selectedChordIndex: number | null = null;
let chordsPerBar: 1 | 2 = 1;
let previewing = false;
let previewIndex: number | null = null;
let previewTimers: number[] = [];
let previewVoices: string[] = [];
let appliedGuide: number | null | undefined = undefined;

/** 調やコードの材料にする音（ドラム以外の全レイヤー）。 */
function harmonicNotes(): Note[] {
  if (!currentPhrase) return [];
  return currentPhrase.layers.filter((l) => l.role !== "drums").flatMap((l) => l.notes);
}

function currentKey(): Key | null {
  return currentPhrase?.keyOverride ?? detectedKeys[0] ?? null;
}

function chordsFitPhrase(phrase: Phrase): boolean {
  const chords = phrase.chords;
  if (!chords || chords.length === 0) return false;
  const sum = chords.reduce((acc, c) => acc + c.lengthBeats, 0);
  return Math.abs(sum - phraseTotalBeats(phrase)) < 1e-6;
}

function setScaleLock(on: boolean): void {
  const phrase = ensurePhrase();
  phrase.scaleLock = on;
  refreshAssist();
  void persistCurrentPhrase();
}

function changeArp(patch: Parameters<Arpeggiator["update"]>[0]): void {
  arp.update(patch);
  refreshAssist();
}

function commitChords(chords: ChordSlot[] | undefined): void {
  ensurePhrase().chords = chords;
  refreshAssist();
  void persistCurrentPhrase();
}

function generateChords(perBar: 1 | 2, opts: { seed?: number; keepLocks?: boolean } = {}): void {
  const key = currentKey();
  if (!key) return;
  const phrase = ensurePhrase();
  chordsPerBar = perBar;
  const segments = makeSegments(phrase.lengthBars, phrase.beatsPerBar, perBar);
  const existing = phrase.chords;
  const locked =
    opts.keepLocks && existing && existing.length === segments.length
      ? existing.map((c) => (c.locked ? c : null))
      : [];
  stopPreview();
  commitChords(
    suggestProgression({
      key,
      segments,
      melody: harmonicNotes(),
      totalBeats: phraseTotalBeats(phrase),
      locked,
      seed: opts.seed,
    }),
  );
}

function altChord(index: number): void {
  const key = currentKey();
  const phrase = currentPhrase;
  const slot = phrase?.chords?.[index];
  if (!key || !phrase || !phrase.chords || !slot) return;
  const ranked = rankChordsForSegment(
    key,
    { startBeats: slot.startBeats, lengthBeats: slot.lengthBeats },
    harmonicNotes(),
    phraseTotalBeats(phrase),
  ).slice(0, 4);
  const at = ranked.findIndex((c) => c.root === slot.root && c.quality === slot.quality);
  const next = ranked[(at + 1) % ranked.length];
  phrase.chords[index] = { ...slot, root: next.root, quality: next.quality };
  selectedChordIndex = index;
  stickyGuideIndex = index;
  commitChords(phrase.chords);
}

/** コードの試聴用の音の並べ方：3和音を中音域に、ルートをオクターブ下に足す。 */
function chordVoicing(slot: ChordSlot): number[] {
  const base = 48 + slot.root;
  const tones = chordPitchClasses(slot).map((pc) => base + ((pc - slot.root + 12) % 12));
  return [...tones, 36 + slot.root];
}

function stopPreview(): void {
  for (const t of previewTimers) window.clearTimeout(t);
  previewTimers = [];
  for (const id of previewVoices) liveOff(id);
  previewVoices = [];
  if (previewing) {
    previewing = false;
    previewIndex = null;
    refreshAssist();
  }
}

function togglePreview(): void {
  if (previewing) {
    stopPreview();
    return;
  }
  const phrase = currentPhrase;
  if (!phrase?.chords) return;
  void ensureAudio();
  transport.stop();
  allSoundsOff();
  previewing = true;
  const spb = 60 / phrase.bpm;
  phrase.chords.forEach((slot, i) => {
    previewTimers.push(
      window.setTimeout(() => {
        previewIndex = i;
        updateGuide();
        chordVoicing(slot).forEach((pitch, k) => {
          const id = `preview:${i}:${k}`;
          previewVoices.push(id);
          liveOn(id, pitch, 0.7);
        });
      }, slot.startBeats * spb * 1000),
    );
    previewTimers.push(
      window.setTimeout(
        () => {
          chordVoicing(slot).forEach((_, k) => liveOff(`preview:${i}:${k}`));
        },
        (slot.startBeats + slot.lengthBeats) * spb * 1000 - 40,
      ),
    );
  });
  previewTimers.push(window.setTimeout(() => stopPreview(), phraseTotalBeats(phrase) * spb * 1000));
  refreshAssist();
}

function placeDrums(genre: DrumGenre, locked: Set<DrumPart>): void {
  const phrase = ensurePhrase();
  let layer = phrase.layers.find((l) => l.role === "drums" && l.generated);
  const existed = !!layer;
  if (!layer) {
    layer = createEmptyLayer("drums");
    layer.generated = true;
    phrase.layers.push(layer);
  }
  const seed = randomSeed();
  for (const part of drumParts) {
    // 固定した楽器は、すでに層があるときだけ手を付けない
    if (existed && locked.has(part.id)) continue;
    const pitches = partPitches[part.id];
    layer.notes = layer.notes.filter((n) => !pitches.includes(n.pitch));
    layer.notes.push(
      ...generateDrumPart(part.id, {
        genre,
        lengthBars: phrase.lengthBars,
        beatsPerBar: phrase.beatsPerBar,
        seed,
      }),
    );
  }
  refreshPhraseUI();
  void persistCurrentPhrase();
}

/** 最後に案内を出したコード区間。再生や試聴が止まっても、鍵盤の光は消さずにここへ戻す。 */
let stickyGuideIndex: number | null = null;

/** いま鍵盤に案内を出すべきコード区間の番号。再生中＞試聴中＞（停止中は）最後に見ていた区間。 */
function computeGuideIndex(): number | null {
  const chords = currentPhrase?.chords;
  if (!chords || chords.length === 0) return null;
  let idx: number | null = null;
  if (previewing) idx = previewIndex;
  else {
    const pos = transport.currentPositionBeats();
    if (pos !== null) idx = chordAt(chords, pos)?.index ?? null;
  }
  if (idx !== null) stickyGuideIndex = idx;
  if (stickyGuideIndex === null || stickyGuideIndex >= chords.length) stickyGuideIndex = 0;
  return idx ?? stickyGuideIndex;
}

function updateGuide(force = false): void {
  const idx = computeGuideIndex();
  if (!force && idx === appliedGuide) return;
  appliedGuide = idx;
  const slot = idx !== null ? currentPhrase?.chords?.[idx] : undefined;
  const key = currentKey();
  if (slot && key) {
    const names = noteNamesFor(key);
    keyboard.setGuide({
      chordTones: new Set(chordPitchClasses(slot)),
      root: slot.root,
      bassTones: new Set([slot.root, fifthPitchClass(slot)]),
    });
    guideReadout.textContent = `${chordName(slot, key)}　ベース：${names[slot.root]}／${names[fifthPitchClass(slot)]}`;
  } else {
    keyboard.setGuide(null);
    guideReadout.textContent = "";
  }
  assistPanel.setPlayingIndex(previewing || transport.state === "running" ? idx : null);
}

function refreshAssist(): void {
  const phrase = currentPhrase;
  detectedKeys = phrase ? detectKeys(harmonicNotes(), 3) : [];
  if (phrase?.chords && !chordsFitPhrase(phrase)) phrase.chords = undefined;
  const key = currentKey();
  const scaleOn = !!(phrase?.scaleLock && key);
  keyboard.setScale(scaleOn && key ? scalePitchClasses(key) : null);
  pianoRoll.pitchFilter = scaleOn && key ? (p) => snapToScale(p, key) : (p) => p;
  scaleLockButton.classList.toggle("on", scaleOn);
  scaleLockButton.disabled = !key;
  arpButton.classList.toggle("on", arp.enabled);

  const chords = phrase?.chords ?? null;
  if (selectedChordIndex !== null && !chords?.[selectedChordIndex]) selectedChordIndex = null;
  if (chords && chords.length > 0) {
    // 1小節あたりのコード数を、保存されているコードの並びに合わせる
    chordsPerBar = chords.length > (phrase?.lengthBars ?? 1) ? 2 : 1;
  }
  const names = noteNamesFor(key ?? { tonic: 0, mode: "major" });
  const recommendation = nextRecommendation({
    layers: (phrase?.layers ?? []).map((l) => ({ role: l.role, noteCount: l.notes.length })),
    hasChords: !!chords,
  });
  recommendInline.textContent = recommendation;
  assistPanel.render({
    recommendation,
    detected: detectedKeys,
    key,
    manual: !!phrase?.keyOverride,
    scaleLock: scaleOn,
    chords: chords
      ? chords.map((c) => ({
          name: chordName(c, key ?? { tonic: 0, mode: "major" }),
          bass: `ベース：${names[c.root]}／${names[fifthPitchClass(c)]}`,
          locked: c.locked,
        }))
      : null,
    selectedIndex: selectedChordIndex,
    previewing,
    hasGeneratedDrums: !!phrase?.layers.some((l) => l.role === "drums" && l.generated),
    arpEnabled: arp.enabled,
    chordsPerBar,
  });
  updateGuide(true);
}

const assistPanel = buildAssistPanel({
  onPickKey: (key) => {
    ensurePhrase().keyOverride = key ?? undefined;
    refreshAssist();
    void persistCurrentPhrase();
  },
  onScaleLock: setScaleLock,
  onGenerateChords: (perBar) => generateChords(perBar),
  onChordsPerBar: (perBar) => {
    chordsPerBar = perBar;
    if (currentPhrase?.chords) generateChords(perBar);
    else refreshAssist();
  },
  onRerollChords: () => generateChords(chordsPerBar, { seed: randomSeed(), keepLocks: true }),
  onAltChord: altChord,
  onToggleChordLock: (index) => {
    const chords = currentPhrase?.chords;
    if (!chords?.[index]) return;
    chords[index] = { ...chords[index], locked: !chords[index].locked };
    commitChords(chords);
  },
  onSelectChord: (index) => {
    selectedChordIndex = index;
  stickyGuideIndex = index;
    refreshAssist();
  },
  onClearChords: () => {
    stopPreview();
    selectedChordIndex = null;
    stickyGuideIndex = null;
    commitChords(undefined);
  },
  onPreview: togglePreview,
  onPlaceDrums: placeDrums,
  onArpChange: changeArp,
});

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
      allSoundsOff();
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
  onVolumeChange: (id, volume) => {
    const layer = currentPhrase?.layers.find((l) => l.id === id);
    if (!layer) return;
    synths.setVolume(layer, volume);
    persistSoon();
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
  refreshAssist();
};

const phraseBrowser = buildPhraseBrowser({
  onNew: () => {
    transport.stop();
    stopPreview();
    selectedChordIndex = null;
    stickyGuideIndex = null;
    currentPhrase = createEmptyPhrase(1, 120, 4);
    const layer = createEmptyLayer("melody");
    currentPhrase.layers.push(layer);
    activeLayerId = layer.id;
    refreshPhraseUI();
    void reloadPhraseList();
  },
  onLoad: (id) => {
    transport.stop();
    stopPreview();
    selectedChordIndex = null;
    stickyGuideIndex = null;
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

const recommendInline = document.createElement("div");
recommendInline.className = "recommend-strip recommend-inline";

phraseColumn.append(
  phraseHeading,
  transportPanel.el,
  recommendInline,
  layerPanel.el,
  phraseBrowser.el,
);
// フレーズタブ：上は左右2分割（左＝フレーズ、右＝手助け）、下は鍵盤のすぐ上にピアノロールを固定
const phraseSplit = document.createElement("div");
phraseSplit.className = "phrase-split";
phraseSplit.append(phraseColumn, assistPanel.el);
const rollDock = document.createElement("div");
rollDock.className = "roll-dock";
rollDock.append(pianoRoll.el);
const phraseTab = document.createElement("div");
phraseTab.className = "tab-panel phrase-tab";
phraseTab.append(phraseSplit, rollDock);
main.append(phraseTab, mixPanel.el);

// --- タブ切り替え ---------------------------------------------------------

const tabBar = document.createElement("nav");
tabBar.className = "tab-bar";
const tabs: { id: string; label: string; panel: HTMLElement }[] = [
  { id: "perform", label: "演奏", panel: performTab },
  { id: "phrase", label: "フレーズ", panel: phraseTab },
  { id: "mix", label: "MIX", panel: mixPanel.el },
];
function selectTab(id: string): void {
  if (id !== "mix") {
    stopSongPlayer();
    mixPanel.setPlaying(null);
  }
  pianoRoll.deleteButton.hidden = id !== "phrase"; // ノート削除はピアノロールのあるタブだけ
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

const guideReadout = document.createElement("div");
guideReadout.className = "guide-readout";
const scaleLockButton = document.createElement("button");
scaleLockButton.type = "button";
scaleLockButton.className = "layer-toggle";
scaleLockButton.textContent = "スケールロック";
scaleLockButton.addEventListener("click", () => setScaleLock(!currentPhrase?.scaleLock));
const arpButton = document.createElement("button");
arpButton.type = "button";
arpButton.className = "layer-toggle";
arpButton.textContent = "ARP";
arpButton.title = "アルペジエーターのオン/オフ";
arpButton.addEventListener("click", () => changeArp({ enabled: !arp.enabled }));

const footerTools = document.createElement("div");
footerTools.className = "footer-tools";
footerTools.append(octaveLabel, guideReadout, scaleLockButton, arpButton, pianoRoll.deleteButton);

const keyboardWrap = document.createElement("div");
keyboardWrap.append(keyboard.el);

const footerDrumPads = buildDrumPads(hitDrum);
footerDrumPads.el.classList.add("footer-drum-pads");
footerDrumPads.el.hidden = true;

footer.append(footerTools, keyboardWrap, footerDrumPads.el);

app.append(header, tabBar, main, footer);

/** 録音対象のレイヤーがドラムの時は、足元の操作面を鍵盤からドラムパッドに切り替える。 */
let lastFooterRole: LayerRole | null = null;
function updateFooterMode(): void {
  const role = activeLayer()?.role ?? null;
  const isDrumLayer = role === "drums";
  keyboardWrap.hidden = isDrumLayer;
  octaveLabel.style.visibility = isDrumLayer ? "hidden" : "visible";
  footerDrumPads.el.hidden = !isDrumLayer;

  // ベース層に切り替えたときだけ、鍵盤を低い音域に寄せる（その後のZ/X操作は邪魔しない）
  if (role !== lastFooterRole) {
    const wasBass = lastFooterRole === "bass";
    lastFooterRole = role;
    if (role === "bass") {
      octaveShift = -2;
      keyboard.setStartNote(36);
      updateOctaveLabel();
      updateKeyLabels();
    } else if (wasBass) {
      octaveShift = 0;
      keyboard.setStartNote(48);
      updateOctaveLabel();
      updateKeyLabels();
    }
  }
}

// ブラウザの自動再生制限により、最初の操作（鍵盤・ツマミ・ボタンなど何でも）で
// AudioContextを解放する。専用の開始画面は置かず、最初から普通に触れる状態にする。
window.addEventListener("pointerdown", () => void ensureAudio());
window.addEventListener("keydown", () => void ensureAudio());

// --- 鍵盤の演奏 -----------------------------------------------------------

const activeNotes = new Set<number>();
/** 押された鍵（生の音）→ 実際に鳴らした音。スケールロックで寄せた場合でも、離すときに同じ音を止められるようにする。 */
const rawToNote = new Map<number, number>();
/** アルペジエーター経由で鳴らし始めた音（途中でオン/オフを切り替えても止め損ねないため）。 */
const arpVoices = new Set<number>();

function lockedNote(raw: number): number {
  const key = currentKey();
  return currentPhrase?.scaleLock && key ? snapToScale(raw, key) : raw;
}

function noteOn(raw: number): void {
  void ensureAudio();
  if (rawToNote.has(raw)) return;
  const note = lockedNote(raw);
  rawToNote.set(raw, note);
  if (activeNotes.has(note)) return;
  activeNotes.add(note);
  if (arp.enabled) {
    arpVoices.add(note);
    arp.press(note);
  } else {
    liveOn(`live:${note}`, note);
    recorder.noteOn(note);
  }
  keyboard.setActiveNotes(activeNotes);
}
function noteOff(raw: number): void {
  const note = rawToNote.get(raw);
  if (note === undefined) return;
  rawToNote.delete(raw);
  for (const other of rawToNote.values()) if (other === note) return; // 同じ音を別の鍵がまだ押している
  activeNotes.delete(note);
  if (arpVoices.delete(note)) {
    arp.unpress(note);
  } else {
    liveOff(`live:${note}`);
    recorder.noteOff(note);
  }
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
  const drumId = drumKeyMap[key];
  if (drumId) {
    if (!e.repeat) {
      hitDrum(drumId);
      pads.flash(drumId);
    }
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
  mixPanel.setProgress(songPlayer.progress());
  if (beats !== lastPlayheadBeats) {
    pianoRoll.setPlayheadBeats(beats);
    lastPlayheadBeats = beats;
  }
  updateGuide();
  requestAnimationFrame(playheadLoop);
}
playheadLoop();

void reloadPhraseList();
mixPanel.setSong(createEmptySong());
void loadSong(SONG_ID).then((song) => {
  if (song) mixPanel.setSong(song);
  mixPanel.refreshMaterials();
});
refreshPhraseUI();

// クラウドから新しいデータを取り込んだら、一覧を読み直す（編集中のフレーズは触らない）。
initCloud({
  onSynced: () => {
    void reloadPhraseList();
    void reloadUserPresets();
  },
});
