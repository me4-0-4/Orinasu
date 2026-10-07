import { LoopPlayer } from "../audio/loopPlayer";
import { encodeWav } from "../audio/wav";
import {
  applySeeds,
  buildCollage,
  collectSources,
  rerollLanes,
  seedSnapshot,
  syncLanes,
  type CollageResult,
  type RerollPart,
  type SeedSnapshot,
} from "../mix/collageSong";
import type { Pcm } from "../mix/pcm";
import { STEPS_PER_BEAT } from "../mix/sequencer";
import { divisionsFor, sliceLimits, type CutMode } from "../mix/slicer";
import {
  LENGTH_OPTIONS,
  MAX_BPM,
  MAX_LANE_VOLUME,
  MIN_BPM,
  createEmptySong,
  formatDuration,
  effectiveParams,
  laneIsCustom,
  setLaneShape,
  songSeconds,
  type Lane,
  type ShapeKey,
  type Song,
} from "../mix/types";
import type { Phrase } from "../phrase/types";
import { randomSeed } from "../theory/rng";
import { buildLaneView } from "./laneView";

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
  /** 毎フレーム呼ぶ。再生位置の線と時間の表示を動かす。 */
  tick: () => void;
  /** 再生⇔停止（スペースキー用）。 */
  togglePlay: () => void;
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

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export function buildMixPanel(deps: MixPanelDeps): MixPanel {
  let song: Song = createEmptySong();
  let result: CollageResult | null = null;
  /** 作り直しの途中で、新しい作り直しが始まったら古いほうを捨てるための番号。 */
  let buildToken = 0;
  let rebuildTimer: number | null = null;
  /** BPMを自分で触ったか。触っていなければ、最初に刻むときだけ、いちばん上の層の曲のテンポから始める。 */
  let bpmTouched = false;
  const undoStack: SeedSnapshot[] = [];
  const redoStack: SeedSnapshot[] = [];
  /** いま選んでいる層（曲のid）。選ぶと、その層だけの形を変えられる。 */
  let selectedId: string | null = null;
  const renderCache = new Map<string, Promise<Pcm>>();
  const player = new LoopPlayer(deps.audio.ctx, deps.audio.out);
  const sampleRate = deps.audio.ctx.sampleRate;

  const root = document.createElement("div");
  root.className = "tab-panel mix-tab";
  const split = document.createElement("div");
  split.className = "mix-split";

  const laneView = buildLaneView((i) => {
    const id = result?.lanes[i]?.phraseId;
    if (!id) return;
    selectedId = selectedId === id ? null : id;
    refresh();
  });

  // --- 材料（刻む曲） ---
  const materialList = document.createElement("div");
  materialList.className = "mix-list";
  const materialEmpty = document.createElement("div");
  materialEmpty.className = "layer-empty";
  materialEmpty.textContent = "フレーズタブで保存したフレーズが、ここに並びます";

  // --- 曲（名前・BPM・長さ・切り方） ---
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
    if (song.lanes) void rebuild(); // 新しいテンポで、曲を書き出し直す
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
    scheduleRebuild();
  });
  const modeSelect = document.createElement("select");
  modeSelect.className = "quantize-select";
  for (const [value, label] of [
    ["transient", "アタックで切る"],
    ["divide", "等分に切る"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    modeSelect.appendChild(opt);
  }
  modeSelect.addEventListener("change", () => {
    song.params.mode = modeSelect.value as CutMode;
    touch();
    refreshSliders();
    scheduleRebuild();
  });
  const fieldRow = (label: string, ...children: HTMLElement[]): HTMLElement => {
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

  // --- 形（つまみ）。動かすと、すぐ作り直す（同じ種のまま） ---
  const sliderRefreshers: (() => void)[] = [];
  function slider(key: ShapeKey, label: string, hint: () => string): HTMLElement {
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
      input.value = String(song.params[key]);
      value.textContent = pct(song.params[key]);
      note.textContent = hint();
    };
    input.addEventListener("input", () => {
      song.params[key] = Number(input.value);
      show();
      touch();
      scheduleRebuild();
    });
    input.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
    row.append(name, input, value, note);
    sliderRefreshers.push(show);
    return row;
  }
  const busyRow = slider("busy", "密度", () => {
    const perBar =
      result && result.lanes.length > 0
        ? result.lanes.reduce((a, l) => a + l.events.length, 0) / result.lanes.length / song.lengthBars
        : (0.08 + 0.72 * song.params.busy) * song.beatsPerBar * STEPS_PER_BEAT;
    return `密度 – 1小節に平均 ${perBar.toFixed(1)} 回打つ（1層あたり）`;
  });
  const breaksRow = slider("breaks", "休み", () => `休み – 曲の約${Math.round(song.params.breaks * 50)}%を、まとめて休みにする（最大で半分）`);
  const onBeatRow = slider("onBeat", "拍に寄せる", () => `拍に寄せる – ${pct(song.params.onBeat)}（1・2・3・4拍目に打ちやすく）`);
  const sizeRow = slider("size", "断片の長さ", () => {
    const { minMs, maxMs } = sliceLimits(song.params.size);
    return song.params.mode === "divide"
      ? `断片の長さ – 曲を ${divisionsFor(song.params.size)} 等分（切るたびに少し揺れる）`
      : `断片の長さ – 最短 ${minMs}ms · 最長 ${maxMs}ms（長いほど、拾うアタックが減る）`;
  });
  const motionRow = slider("motion", "音程の動き", () =>
    song.params.motion < 0.05 ? "音程の動き – 動かさない" : `音程の動き – ${pct(song.params.motion)}（断片の高さを、近い高さへ少しずつ動かす）`,
  );
  function refreshSliders(): void {
    for (const f of sliderRefreshers) f();
  }

  // --- 選んだ層の形（全体からのずらし） ---
  const laneTitle = document.createElement("div");
  laneTitle.className = "mix-lane-title";
  const laneEmpty = document.createElement("div");
  laneEmpty.className = "layer-empty";
  const laneBox = document.createElement("div");
  laneBox.className = "mix-lane-box";
  const lockButton = button("固定", () => updateLane((l) => ({ ...l, locked: !l.locked }), false), "preset-button", "固定すると、刻み直してもこの層は変わらない");
  const muteButton = button("ミュート", () => updateLane((l) => ({ ...l, muted: !l.muted })), "preset-button");
  const resetButton = button("全体に戻す", () =>
    updateLane((l) => ({ phraseId: l.phraseId, cutSeed: l.cutSeed, rhythmSeed: l.rhythmSeed, orderSeed: l.orderSeed, locked: l.locked })),
  "preset-button", "この層のずらし・切り方・音量・ミュートを消して、全体と同じにする");
  const laneButtons = document.createElement("div");
  laneButtons.className = "preset-row";
  laneButtons.append(lockButton, muteButton, resetButton);
  const laneVolume = document.createElement("input");
  laneVolume.type = "range";
  laneVolume.className = "layer-volume";
  laneVolume.min = "0";
  laneVolume.max = String(MAX_LANE_VOLUME);
  laneVolume.step = "0.05";
  const laneVolumeValue = document.createElement("span");
  laneVolumeValue.className = "mix-slider-value";
  laneVolume.addEventListener("input", () => {
    const v = Number(laneVolume.value);
    updateLane((l) => {
      const { volume: _v, ...rest } = l;
      return Math.abs(v - 1) < 1e-9 ? rest : { ...rest, volume: v };
    });
  });
  laneVolume.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
  const volumeRow = document.createElement("div");
  volumeRow.className = "mix-slider-row";
  const volumeName = document.createElement("span");
  volumeName.className = "mix-slider-name";
  volumeName.textContent = "音量";
  volumeRow.append(volumeName, laneVolume, laneVolumeValue);
  const laneMode = document.createElement("select");
  laneMode.className = "quantize-select";
  for (const [value, label] of [
    ["", "全体と同じ"],
    ["transient", "アタックで切る"],
    ["divide", "等分に切る"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    laneMode.appendChild(opt);
  }
  laneMode.addEventListener("change", () => {
    const v = laneMode.value;
    updateLane((l) => {
      const { mode: _m, ...rest } = l;
      return v === "" ? rest : { ...rest, mode: v as CutMode };
    });
  });
  const laneSliderSync: (() => void)[] = [];
  function laneSlider(key: ShapeKey, label: string): HTMLElement {
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
    laneSliderSync.push(() => {
      const lane = selectedLane();
      if (!lane) return;
      const eff = effectiveParams(song.params, lane)[key];
      const shift = lane.shift?.[key] ?? 0;
      input.value = String(eff);
      value.textContent = pct(eff);
      note.textContent =
        Math.abs(shift) < 1e-9
          ? `全体と同じ（${pct(song.params[key])}）`
          : `全体 ${pct(song.params[key])} ${shift > 0 ? "＋" : "−"}${Math.round(Math.abs(shift) * 100)}%`;
    });
    input.addEventListener("input", () => updateLane((l) => setLaneShape(l, song.params, key, Number(input.value))));
    input.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
    row.append(name, input, value, note);
    return row;
  }
  laneBox.append(
    laneButtons,
    volumeRow,
    fieldRow("切り方", laneMode),
    laneSlider("busy", "密度"),
    laneSlider("breaks", "休み"),
    laneSlider("onBeat", "拍に寄せる"),
    laneSlider("size", "断片の長さ"),
    laneSlider("motion", "音程の動き"),
  );

  function selectedLane(): Lane | undefined {
    return selectedId ? song.lanes?.find((l) => l.phraseId === selectedId) : undefined;
  }

  /** 選んでいる層を変える。音に関わる変更なら作り直す。 */
  function updateLane(fn: (lane: Lane) => Lane, rebuildAfter = true): void {
    if (!song.lanes || !selectedId) return;
    const i = song.lanes.findIndex((l) => l.phraseId === selectedId);
    if (i < 0) return;
    song.lanes[i] = fn(song.lanes[i]);
    touch();
    refresh();
    if (rebuildAfter) scheduleRebuild();
  }

  function syncLanePanel(): void {
    const lane = selectedLane();
    laneBox.hidden = !lane;
    laneEmpty.hidden = !!lane;
    laneTitle.hidden = !lane;
    laneEmpty.textContent = !song.lanes
      ? "「刻む」と、左に層（選んだ曲）の線が出る"
      : "左の層の名前をタップで選ぶと、その層だけの形を変えられる（全体からのずらし）";
    if (!lane) return;
    laneTitle.textContent = `${result?.lanes.find((l) => l.phraseId === lane.phraseId)?.name ?? "層"}${laneIsCustom(lane) ? " ＊" : ""}`;
    lockButton.textContent = lane.locked ? "固定中" : "固定";
    lockButton.className = "preset-button" + (lane.locked ? " on" : "");
    muteButton.textContent = lane.muted ? "ミュート中" : "ミュート";
    muteButton.className = "preset-button" + (lane.muted ? " on" : "");
    resetButton.disabled = !laneIsCustom(lane);
    const vol = lane.volume ?? 1;
    laneVolume.value = String(vol);
    laneVolumeValue.textContent = pct(vol);
    laneMode.value = lane.mode ?? "";
    for (const f of laneSliderSync) f();
  }

  // --- 左：層の線と操作 ---
  const status = document.createElement("div");
  status.className = "mix-info mix-status";
  const timeInfo = document.createElement("div");
  timeInfo.className = "mix-info mix-status";
  const notice = document.createElement("div");
  notice.className = "layer-empty";
  notice.hidden = true;
  const playButton = button("再生", () => void togglePlay(), "preset-button on");
  const rollButton = button("刻む", () => void chop("all"), "roll-button", "選んだ曲を、新しく刻む（固定した層は残す）");
  const undoButton = button("ひとつ戻す", () => undo(), "preset-button", "ひとつ前の刻みに戻す");
  const redoButton = button("やり直す", () => redo(), "preset-button", "戻した刻みを、もう一度");
  const rollRow = document.createElement("div");
  rollRow.className = "preset-row mix-roll-row";
  rollRow.append(rollButton, playButton, undoButton, redoButton);
  const partRow = document.createElement("div");
  partRow.className = "preset-row";
  partRow.append(
    button("切り直し", () => void chop("cut"), "preset-button", "断片の切れ目だけ変える（打つ所と順番はそのまま）"),
    button("リズムだけ", () => void chop("rhythm"), "preset-button", "打つ所だけ変える"),
    button("順番だけ", () => void chop("order"), "preset-button", "どの断片を打つか（と音程）だけ変える"),
  );
  const saveButton = button("WAVで保存", () => saveWav(), "preset-button", "刻んだ曲を、WAVファイルにして保存する");
  partRow.append(saveButton);

  const stagePane = document.createElement("div");
  stagePane.className = "mix-stage-pane";
  stagePane.append(
    laneView.el,
    status,
    timeInfo,
    rollRow,
    partRow,
    notice,
    rule("層", "選んだ層だけの形。全体からの差として持つので、全体を動かすと一緒に動く", laneEmpty, laneTitle, laneBox),
  );
  const sidePane = document.createElement("div");
  sidePane.className = "mix-side-pane";
  sidePane.append(
    rule("材料", "刻む曲（フレーズ）を選ぶ。曲1つが、層1本になる（中のドラム・ベースなどには分けない）。複数選ぶと重なる", materialEmpty, materialList),
    rule(
      "曲",
      "刻んだあとの曲の設定",
      fieldRow("名前", nameInput),
      fieldRow("BPM", bpmInput, bpmHint),
      fieldRow("長さ", lengthSelect),
      fieldRow("切り方", modeSelect),
    ),
    rule("形（全体）", "曲全体の雰囲気。動かすと、同じ刻みのまま形だけ変わる。層ごとのずらしは、左の「層」で", busyRow, breaksRow, onBeatRow, sizeRow, motionRow),
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

  /** フレーズを書き出す（同じ曲・同じテンポなら、書き出したものを使い回す）。 */
  function render(phrase: Phrase, bpm: number): Promise<Pcm> {
    const key = `${phrase.id}|${phrase.updatedAt}|${bpm}`;
    let hit = renderCache.get(key);
    if (!hit) {
      hit = deps.render(phrase, bpm);
      renderCache.set(key, hit);
      if (renderCache.size > 24) renderCache.delete(renderCache.keys().next().value as string);
    }
    return hit;
  }

  function scheduleRebuild(): void {
    if (!song.lanes) return;
    if (rebuildTimer !== null) window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(() => {
      rebuildTimer = null;
      void rebuild();
    }, 120);
  }

  /** 種と設定から、曲を作り直す。鳴らしていれば、同じ位置から鳴らし直す。 */
  async function rebuild(): Promise<void> {
    const token = ++buildToken;
    if (!song.lanes || song.lanes.length === 0) {
      result = null;
      refresh();
      return;
    }
    setNotice("曲を作っています…");
    try {
      const out = await buildCollage(song, deps.getPhrases(), render, sampleRate);
      if (token !== buildToken) return;
      result = out;
      setNotice(out ? "" : "刻む曲が見つからない。材料を選び直して");
      if (player.playing) {
        if (out) player.play(out.pcm, sampleRate, player.progress() ?? 0);
        else player.stop();
      }
    } catch (err) {
      if (token !== buildToken) return;
      console.error("曲の書き出しに失敗しました", err);
      result = null;
      setNotice("曲を作れなかった。もう一度「刻む」を押して");
    }
    refresh();
  }

  function snapshot(): SeedSnapshot {
    return seedSnapshot(song.lanes ?? []);
  }

  async function chop(part: RerollPart): Promise<void> {
    const sources = collectSources(song, deps.getPhrases());
    if (sources.length === 0) {
      setNotice(song.materialIds.length === 0 ? "先に、刻む曲（フレーズ）を選んで" : "選んだ曲に、音符がありません");
      return;
    }
    if (song.lanes) {
      undoStack.push(snapshot());
      if (undoStack.length > 50) undoStack.shift();
      redoStack.length = 0;
    }
    const first = !song.lanes;
    const lanes = syncLanes(song, randomSeed);
    song.lanes = first ? lanes : rerollLanes(lanes, part, randomSeed);
    if (first && !bpmTouched) {
      // 最初に刻むときだけ、いちばん上の層の曲のテンポから始める（このあとは曲のBPMだけで決まる）
      const top = sources.find((p) => p.id === song.lanes![0].phraseId) ?? sources[0];
      song.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(top.bpm)));
    }
    touch();
    refresh();
    await rebuild();
  }

  function undo(): void {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(snapshot());
    song.lanes = applySeeds(song.lanes ?? [], prev);
    touch();
    void rebuild();
  }

  function redo(): void {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(snapshot());
    song.lanes = applySeeds(song.lanes ?? [], next);
    touch();
    void rebuild();
  }

  async function togglePlay(): Promise<void> {
    if (player.playing) {
      player.stop();
      refresh();
      return;
    }
    if (!result) return;
    await deps.prepareAudio();
    player.play(result.pcm, sampleRate);
    refresh();
  }

  function saveWav(): void {
    if (!result) return;
    const bytes = encodeWav(result.pcm, sampleRate);
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
        song.materialIds = check.checked ? [...song.materialIds, p.id] : song.materialIds.filter((id) => id !== p.id);
        if (song.lanes) song.lanes = syncLanes(song, randomSeed); // 層を足す・消す（ほかの層はそのまま）
        touch();
        refresh();
        scheduleRebuild();
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
    laneView.setData(
      result
        ? {
            lanes: result.lanes.map((l) => {
              const lane = song.lanes?.find((x) => x.phraseId === l.phraseId);
              return {
                name: l.name,
                locked: !!lane?.locked,
                muted: !!lane?.muted,
                custom: !!lane && laneIsCustom(lane),
                selected: l.phraseId === selectedId,
                events: l.events,
              };
            }),
            totalSteps: result.totalSteps,
            stepsPerBar: song.beatsPerBar * STEPS_PER_BEAT,
          }
        : null,
    );
    if (document.activeElement !== nameInput) nameInput.value = song.name;
    if (document.activeElement !== bpmInput) bpmInput.value = String(song.bpm);
    lengthSelect.value = String(song.lengthBars);
    modeSelect.value = song.params.mode;
    const hits = result ? result.lanes.reduce((a, l) => a + l.events.length, 0) : 0;
    status.textContent = [
      `層 ${result?.lanes.length ?? 0}`,
      `${song.lengthBars}小節`,
      `${song.bpm}BPM`,
      result?.keyName ?? null,
      `${hits}打`,
    ]
      .filter(Boolean)
      .join(" · ");
    playButton.textContent = player.playing ? "止める" : "再生";
    playButton.disabled = !result;
    saveButton.disabled = !result;
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
    partRow.hidden = !song.lanes;
    if (selectedId && !song.lanes?.some((l) => l.phraseId === selectedId)) selectedId = null;
    refreshSliders();
    syncLanePanel();
    updateTime();
  }

  function updateTime(): void {
    const total = songSeconds(song);
    const t = player.progress();
    const steps = song.lengthBars * song.beatsPerBar * STEPS_PER_BEAT;
    const pos = t === null ? 1 : Math.floor(t * steps) + 1;
    timeInfo.textContent = `位置 ${pos} / ${steps} · ${formatDuration(t === null ? 0 : t * total)} / ${formatDuration(total)}`;
  }

  refresh();

  return {
    el: root,
    setSong(next) {
      player.stop();
      song = next;
      buildToken++;
      result = null;
      undoStack.length = 0;
      redoStack.length = 0;
      bpmTouched = !!next.lanes;
      selectedId = null;
      setNotice("");
      renderMaterials();
      refresh();
      if (song.lanes) void rebuild();
    },
    refreshMaterials() {
      // 消えたフレーズは材料から外す
      const alive = new Set(deps.getPhrases().map((p) => p.id));
      song.materialIds = song.materialIds.filter((id) => alive.has(id));
      if (song.lanes) song.lanes = song.lanes.filter((l) => alive.has(l.phraseId));
      renderMaterials();
      refresh();
      if (song.lanes && !result) void rebuild(); // 起動直後は、フレーズが読み込まれてから曲を作り直す
    },
    stop() {
      if (!player.playing) return;
      player.stop();
      refresh();
    },
    tick() {
      laneView.setProgress(player.progress());
      if (player.playing) updateTime();
    },
    togglePlay() {
      void togglePlay();
    },
  };
}
