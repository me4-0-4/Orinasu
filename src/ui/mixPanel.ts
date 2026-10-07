import { LoopPlayer } from "../audio/loopPlayer";
import { encodeWav } from "../audio/wav";
import { peaksOf, type Pcm } from "../mix/audioChop";
import { DEFAULT_CHOP, type ChopParams, type ChopSegment } from "../mix/chop";
import { buildSongPcm, collectSources, planBars, planForSong } from "../mix/chopSong";
import {
  LENGTH_OPTIONS,
  MAX_BPM,
  MIN_BPM,
  createEmptySong,
  formatDuration,
  songSeconds,
  type Song,
} from "../mix/types";
import { type Phrase } from "../phrase/types";
import { createRng, randomSeed } from "../theory/rng";
import { buildChopStage } from "./chopStage";

export interface MixPanelDeps {
  /** 保存されているフレーズ（刻む曲の候補）。 */
  getPhrases: () => Phrase[];
  /** 曲が変わったので保存してほしい。 */
  onSongChange: (song: Song) => void;
  /** 鳴らす前に呼ぶ：音を出す準備と、ほかの音（演奏・フレーズの再生）を止める。 */
  prepareAudio: () => Promise<void>;
  audio: { ctx: AudioContext; out: AudioNode };
  /** フレーズを、指定のBPMで1周ぶんの波形に書き出す。 */
  render: (phrase: Phrase, bpm: number) => Promise<Pcm>;
}

export interface MixPanel {
  el: HTMLElement;
  setSong: (song: Song) => void;
  /** フレーズ一覧が変わったとき。 */
  refreshMaterials: () => void;
  /** 鳴らしているものを止める。 */
  stop: () => void;
  /** 毎フレーム呼ぶ。再生位置の線を動かす。 */
  tick: () => void;
}

function button(label: string, onClick: () => void, cls = "preset-button", title?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

/** 細い線つきの見出し（見出し＋ひとこと説明）。中身はその下に並べる。 */
function rule(heading: string, hint: string, ...children: HTMLElement[]): HTMLElement {
  const box = document.createElement("section");
  box.className = "mix-rule";
  const h = document.createElement("div");
  h.className = "mix-rule-head";
  const t = document.createElement("span");
  t.className = "panel-heading";
  t.textContent = heading;
  const line = document.createElement("span");
  line.className = "mix-rule-line";
  h.append(t, line);
  box.appendChild(h);
  if (hint) {
    const hi = document.createElement("div");
    hi.className = "mix-info mix-rule-hint";
    hi.textContent = hint;
    box.appendChild(hi);
  }
  box.append(...children);
  return box;
}

interface HistoryEntry {
  plan: ChopSegment[];
  baseId: string;
  lengthBars: number;
}

export function buildMixPanel(deps: MixPanelDeps): MixPanel {
  let song: Song = createEmptySong();
  /** 刻んだ曲の波形。まだ刻んでいなければ null。 */
  let pcm: Pcm | null = null;
  let peaks: Float32Array = new Float32Array(0);
  /** 作り直しの途中で、新しい作り直しが始まったら古いほうを捨てるための番号。 */
  let buildToken = 0;
  /** BPMを自分で触ったか。触っていなければ、最初に刻むときだけ、メインの曲のテンポから始める。 */
  let bpmTouched = false;
  const history: HistoryEntry[] = [];
  /** 固定している小節（0から数える）。刻み直しても、その小節は変えない。 */
  const lockedBars = new Set<number>();
  const chop: ChopParams = { ...DEFAULT_CHOP };
  const renderCache = new Map<string, Promise<Pcm>>();
  const player = new LoopPlayer(deps.audio.ctx, deps.audio.out);

  const root = document.createElement("div");
  root.className = "tab-panel mix-tab";
  const split = document.createElement("div");
  split.className = "mix-split";

  const stage = buildChopStage((bar) => {
    if (!song.plan) return;
    if (lockedBars.has(bar)) lockedBars.delete(bar);
    else lockedBars.add(bar);
    refresh();
  });

  // --- 材料（刻む曲） ---
  const materialList = document.createElement("div");
  materialList.className = "mix-list";
  const materialEmpty = document.createElement("div");
  materialEmpty.className = "layer-empty";
  materialEmpty.textContent = "フレーズタブで保存したフレーズが、ここに並びます";

  // --- 曲（名前・BPM・長さ） ---
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "mix-name";
  nameInput.placeholder = "曲の名前";
  nameInput.addEventListener("input", () => {
    song.name = nameInput.value;
    touch();
  });
  const bpmInput = document.createElement("input");
  bpmInput.type = "number";
  bpmInput.className = "mix-bpm";
  bpmInput.min = String(MIN_BPM);
  bpmInput.max = String(MAX_BPM);
  bpmInput.addEventListener("change", () => {
    const v = Math.round(Number(bpmInput.value));
    if (!Number.isFinite(v) || bpmInput.value === "") {
      bpmInput.value = String(song.bpm);
      return;
    }
    song.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, v));
    bpmInput.value = String(song.bpm);
    bpmTouched = true;
    touch();
    refresh();
    if (song.plan) void rebuild(); // 新しいテンポで、曲を書き出し直す
  });
  const lengthSelect = document.createElement("select");
  lengthSelect.className = "quantize-select";
  for (const n of LENGTH_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = `${n}小節`;
    lengthSelect.appendChild(opt);
  }
  lengthSelect.addEventListener("change", () => {
    song.lengthBars = Number(lengthSelect.value);
    touch();
    refresh();
    if (song.plan) setNotice("長さは、次に「刻む」ときから変わる");
  });
  const fieldRow = (label: string, ...children: (HTMLElement | string)[]): HTMLElement => {
    const row = document.createElement("label");
    row.className = "mix-slider-row mix-field-row";
    const name = document.createElement("span");
    name.className = "mix-slider-name";
    name.textContent = label;
    row.append(name, ...children);
    return row;
  };
  const bpmHint = document.createElement("span");
  bpmHint.className = "mix-info mix-slider-hint";
  bpmHint.textContent = "刻んだ曲のテンポ（もとのフレーズのBPMとは別）";
  const songFields = [fieldRow("名前", nameInput), fieldRow("BPM", bpmInput, bpmHint), fieldRow("長さ", lengthSelect)];

  // --- 刻み方（スライダー。偶然の強さ） ---
  const sizeWords = ["2拍", "1拍", "半拍", "1/4拍"];
  function chopSlider(key: keyof ChopParams, label: string, hint: () => string): HTMLElement {
    const row = document.createElement("div");
    row.className = "mix-slider-row";
    const name = document.createElement("span");
    name.className = "mix-slider-name";
    name.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    input.className = "layer-volume";
    input.min = "0";
    input.max = "1";
    input.step = "0.05";
    const value = document.createElement("span");
    value.className = "mix-slider-value";
    const note = document.createElement("div");
    note.className = "mix-info mix-slider-hint";
    const show = (): void => {
      input.value = String(chop[key]);
      value.textContent = `${Math.round(chop[key] * 100)}%`;
      note.textContent = hint();
    };
    show();
    input.addEventListener("input", () => {
      chop[key] = Number(input.value);
      song.chop = { ...chop };
      show();
      touch();
    });
    input.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
    row.append(name, input, value, note);
    sliderRefreshers.push(show);
    return row;
  }
  const sliderRefreshers: (() => void)[] = [];
  const busyRow = chopSlider("busy", "いじる量", () => `いじる量 – 小節の約${Math.round(chop.busy * 80)}%を切り貼りする（頭は控えめ、終わりは多め）`);
  const breaksRow = chopSlider("breaks", "無音", () => {
    const b6 = chop.breaks * 6;
    return `無音 – いじった所の約${Math.round((b6 / (12 + b6)) * 100)}%を、音を落として無音にする`;
  });
  const sizeRow = chopSlider("size", "細かさ", () => `細かさ – 断片は${sizeWords[Math.round(chop.size * 3)]}くらいから`);
  const pitchRow = chopSlider("pitch", "音程", () =>
    chop.pitch < 0.05 ? "音程 – 変えない" : `音程 – 断片の約${Math.round(chop.pitch * 100)}%を高く・低くして、メロディのように鳴らす`,
  );

  // --- ステージ（左）と操作 ---
  const status = document.createElement("div");
  status.className = "mix-info mix-status";
  const notice = document.createElement("div");
  notice.className = "layer-empty";
  notice.hidden = true;
  const rollButton = button("刻む", () => void generate("new"), "roll-button", "選んだ曲を、新しく切り貼りする。固定した小節は残す");
  const playButton = button("再生", () => void togglePlay(), "preset-button on");
  const undoButton = button("ひとつ戻す", () => undo(), "preset-button", "ひとつ前の刻みに戻す（何回でも）");
  const rollRow = document.createElement("div");
  rollRow.className = "preset-row mix-roll-row";
  rollRow.append(rollButton, playButton, undoButton);
  const replanButton = button(
    "刻み方だけ変える",
    () => void generate("replan"),
    "preset-button",
    "メインにする曲はそのまま、切り貼りだけやり直す（固定した小節は残す）",
  );
  const unlockButton = button("固定を全部外す", () => {
    lockedBars.clear();
    refresh();
  });
  const saveButton = button("WAVで保存", () => saveWav(), "preset-button", "刻んだ曲を、WAVファイルにして保存する");
  const toolRow = document.createElement("div");
  toolRow.className = "preset-row";
  toolRow.append(replanButton, unlockButton, saveButton);

  const lockInfo = document.createElement("div");
  lockInfo.className = "layer-empty";

  const stagePane = document.createElement("div");
  stagePane.className = "mix-stage-pane";
  stagePane.append(stage.el, status, rollRow, toolRow, notice);
  const sidePane = document.createElement("div");
  sidePane.className = "mix-side-pane";
  sidePane.append(
    rule("材料", "刻む曲（フレーズ）を選ぶ。複数なら、曲をまたいで刻む", materialEmpty, materialList),
    rule("曲", "刻んだあとの曲の設定", ...songFields),
    rule("刻み方", "「刻む」ときの偶然の強さ", busyRow, breaksRow, sizeRow, pitchRow),
    rule("固定", "左の波形の小節をタップで固定。固定した小節は、刻み直しても変わらない", lockInfo),
  );
  split.append(stagePane, sidePane);
  root.append(split);

  // --- 動作 ---

  function touch(): void {
    song.updatedAt = Date.now();
    deps.onSongChange(song);
  }

  function setNotice(text: string): void {
    notice.textContent = text;
    notice.hidden = text === "";
  }

  function phraseNames(): Record<string, string> {
    return Object.fromEntries(deps.getPhrases().map((p) => [p.id, p.name]));
  }

  /** フレーズを書き出す（同じ曲・同じテンポなら、書き出したものを使い回す）。 */
  function render(phrase: Phrase, bpm: number): Promise<Pcm> {
    const key = `${phrase.id}|${phrase.updatedAt}|${bpm}`;
    let hit = renderCache.get(key);
    if (!hit) {
      hit = deps.render(phrase, bpm);
      renderCache.set(key, hit);
      if (renderCache.size > 40) renderCache.delete(renderCache.keys().next().value as string);
    }
    return hit;
  }

  /** 計画から、刻んだ曲の波形を作り直す。鳴らしていれば、同じ位置から鳴らし直す。 */
  async function rebuild(): Promise<void> {
    const token = ++buildToken;
    if (!song.plan) {
      pcm = null;
      peaks = new Float32Array(0);
      refresh();
      return;
    }
    setNotice("曲を作っています…");
    try {
      const sources = collectSources(song, deps.getPhrases());
      const out = await buildSongPcm(song, sources, render, deps.audio.ctx.sampleRate);
      if (token !== buildToken) return;
      pcm = out;
      peaks = out ? peaksOf(out, 900) : new Float32Array(0);
      setNotice(out ? "" : "刻む曲が見つからない。材料を選び直して");
      if (player.playing) {
        if (out) player.play(out, deps.audio.ctx.sampleRate, player.progress() ?? 0);
        else player.stop();
      }
    } catch (err) {
      if (token !== buildToken) return;
      console.error("曲の書き出しに失敗しました", err);
      pcm = null;
      setNotice("曲を作れなかった。もう一度「刻む」を押して");
    }
    refresh();
  }

  function pushHistory(): void {
    if (!song.plan || !song.baseId) return;
    history.push({ plan: structuredClone(song.plan), baseId: song.baseId, lengthBars: song.lengthBars });
    if (history.length > 30) history.shift();
  }

  function undo(): void {
    const prev = history.pop();
    if (!prev) return;
    song.plan = prev.plan;
    song.baseId = prev.baseId;
    song.lengthBars = prev.lengthBars;
    touch();
    refresh();
    void rebuild();
  }

  async function generate(mode: "new" | "replan"): Promise<void> {
    const sources = collectSources(song, deps.getPhrases());
    if (sources.length === 0) {
      setNotice(song.materialIds.length === 0 ? "先に、刻む曲（フレーズ）を選んで" : "選んだ曲に、音符がありません");
      return;
    }
    const rng = createRng(randomSeed());
    const lengthChanged = !!song.plan && planBars(song.plan, song.beatsPerBar) !== song.lengthBars;
    if (lengthChanged) lockedBars.clear();
    const result = planForSong(song, sources, rng, { newBase: mode === "new", keepBars: [...lockedBars] });
    if (!result) return;
    pushHistory();
    const first = !song.plan;
    song.plan = result.plan;
    song.baseId = result.baseId;
    if (first && !bpmTouched) {
      // 最初に刻むときだけ、メインにした曲のテンポから始める（このあとは曲のBPMだけで決まる）
      const base = sources.find((p) => p.id === result.baseId);
      if (base) song.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(base.bpm)));
    }
    touch();
    setNotice("");
    refresh();
    await rebuild();
  }

  async function togglePlay(): Promise<void> {
    if (player.playing) {
      player.stop();
      refresh();
      return;
    }
    if (!pcm) return;
    await deps.prepareAudio();
    player.play(pcm, deps.audio.ctx.sampleRate);
    refresh();
  }

  function saveWav(): void {
    if (!pcm) return;
    const bytes = encodeWav(pcm, deps.audio.ctx.sampleRate);
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${song.name.trim() || "orinasu"}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
        refresh();
        if (song.plan) void rebuild(); // 材料が変わったので、曲を作り直す
      });
      const label = document.createElement("span");
      label.className = "layer-role-label";
      label.textContent = `${p.name}（${p.lengthBars}小節・元${p.bpm}BPM）`;
      row.append(check, label);
      materialList.appendChild(row);
    }
  }

  /** 画面を、いまの状態に合わせる。 */
  function refresh(): void {
    const has = !!song.plan && !!pcm;
    stage.setView(
      has && song.plan && song.baseId
        ? {
            plan: song.plan,
            baseId: song.baseId,
            names: phraseNames(),
            bars: planBars(song.plan, song.beatsPerBar),
            beatsPerBar: song.beatsPerBar,
            peaks,
          }
        : null,
      lockedBars,
    );
    if (document.activeElement !== nameInput) nameInput.value = song.name;
    if (document.activeElement !== bpmInput) bpmInput.value = String(song.bpm);
    lengthSelect.value = String(song.lengthBars);
    status.textContent = `${song.lengthBars}小節 · ${song.bpm}BPM · ${formatDuration(songSeconds(song))} · ${song.materialIds.length}曲`;
    playButton.textContent = player.playing ? "止める" : "再生";
    playButton.disabled = !pcm;
    undoButton.disabled = history.length === 0;
    saveButton.disabled = !pcm;
    unlockButton.disabled = lockedBars.size === 0;
    // 曲が1つだけなら「刻む」と同じ動きなので、2つ以上選んでいるときだけ出す
    replanButton.hidden = song.materialIds.length < 2 || !song.plan;
    toolRow.hidden = !song.plan;
    const bars = [...lockedBars].sort((x, y) => x - y).map((b) => b + 1);
    lockInfo.textContent = !song.plan
      ? "「刻む」と、左に波形が出る"
      : bars.length === 0
        ? "固定している小節：なし"
        : `固定している小節：${bars.join("・")}小節目`;
  }

  for (const f of sliderRefreshers) f();
  refresh();

  return {
    el: root,
    setSong(next) {
      player.stop();
      song = next;
      buildToken++;
      pcm = null;
      peaks = new Float32Array(0);
      history.length = 0;
      lockedBars.clear();
      bpmTouched = !!next.plan;
      Object.assign(chop, DEFAULT_CHOP, next.chop ?? {});
      for (const f of sliderRefreshers) f();
      setNotice("");
      renderMaterials();
      refresh();
      if (song.plan) void rebuild();
    },
    refreshMaterials() {
      // 消えたフレーズは材料から外す
      const alive = new Set(deps.getPhrases().map((p) => p.id));
      song.materialIds = song.materialIds.filter((id) => alive.has(id));
      renderMaterials();
      refresh();
      if (song.plan && !pcm) void rebuild(); // 起動直後は、フレーズが読み込まれてから曲を作り直す
    },
    stop() {
      if (!player.playing) return;
      player.stop();
      refresh();
    },
    tick() {
      stage.setProgress(player.progress());
    },
  };
}
