import type { SoundLibrary } from "../sound/library";
import {
  CLOUD_QUOTA_BYTES,
  MAX_SOUND_BPM,
  MIN_SOUND_BPM,
  barsOf,
  beatGrid,
  bpmFromBars,
  bpmFromTaps,
  clampBpm,
  firstSoundSec,
  formatBytes,
  formatSeconds,
  type StoredSound,
} from "../sound/types";
import { getCloudState, subscribeCloud, subscribeSoundCloud, type SoundCloudState } from "../cloud/sync";
import { button, choice, el, knob, toggle, type Control } from "./mixWidgets";
import { usesSampler, type Layer } from "../phrase/types";
import {
  MAX_ATTACK,
  MAX_RELEASE,
  MAX_SLICES,
  PAD_BASE_PITCH,
  beatSlices,
  divideSlices,
  normalizeSlices,
  onsetSlices,
  pitchName,
  sliceRange,
  type SamplerHold,
  type SamplerMode,
  type SamplerParams,
  type SliceCut,
} from "../sound/sampler";
import { detectOnsets } from "../mix/slicer";

export interface SoundPanelDeps {
  library: SoundLibrary;
  audio: { ctx: AudioContext; out: AudioNode };
  /** 鳴らす前に呼ぶ：音を出す準備と、ほかの音を止める。 */
  prepareAudio: () => Promise<void>;
  /** 鍵盤で鳴らす楽器（編集中の層）。 */
  instrument: {
    target: () => { layer: Layer; label: string };
    /** この層を、その音で鳴らす。null ならシンセに戻す。 */
    useSound: (soundId: string | null) => void;
    change: (patch: Partial<SamplerParams>) => void;
  };
}

export interface SoundPanel {
  el: HTMLElement;
  /** スペース：選んだ音の試聴 ⇔ 停止。 */
  togglePlay: () => void;
  stop: () => void;
  /** 編集中の層が変わったとき。 */
  refreshInstrument: () => void;
}

const BAR_CHOICES = [1, 2, 4, 8, 16, 32];

/** サンプラーのタブ。いまは音の棚（読み込み・一覧・クラウド）と、選んだ音の波形・試聴・テンポ。 */
export function buildSoundPanel(deps: SoundPanelDeps): SoundPanel {
  const { library } = deps;
  const root = el("div", "tab-panel snd-tab");

  // --- 左：音の棚 ---------------------------------------------------------------
  const shelf = el("section", "panel-column snd-shelf");
  const shelfHead = el("div", "panel-heading", "音の棚");
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = "audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const importButton = button("音を読み込む", () => fileInput.click(), "preset-button snd-import");
  const dropHint = el("div", "snd-hint", "ファイルをここに落としても読み込めます（WAV・MP3 など、1つ50MBまで）");
  const message = el("div", "snd-message");
  const cloudLine = el("div", "snd-cloud");
  const list = el("div", "snd-list");
  shelf.append(shelfHead, importButton, fileInput, dropHint, message, cloudLine, list);

  // --- 右：選んだ音 -------------------------------------------------------------
  const detail = el("section", "panel-column snd-detail");
  const detailHead = el("div", "panel-heading", "選んだ音");
  const empty = el("div", "snd-empty", "左の棚から音を選ぶか、音を読み込んでください。");
  const body = el("div", "snd-body");
  const nameInput = el("input", "mix-name snd-name");
  nameInput.type = "text";
  nameInput.maxLength = 60;
  const info = el("div", "mix-info snd-info");
  const canvas = el("canvas", "snd-wave");
  const waveNote = el("div", "snd-hint");

  const playButton = button("▶ 試聴", () => togglePlay(), "preset-button snd-play");
  const downbeatButton = button("1拍目を置く", () => setPlacing(!placing), "layer-toggle");
  downbeatButton.title = "押してから波形をタップすると、そこを1拍目（小節の頭）にします";
  const firstSoundButton = button("最初の音に", () => void snapDownbeatToFirstSound(), "layer-toggle");
  firstSoundButton.title = "頭の無音を飛ばして、最初に音が鳴る所を1拍目にします";
  const playRow = el("div", "snd-row");
  playRow.append(playButton, downbeatButton, firstSoundButton);

  const bpmInput = el("input", "mix-bpm");
  bpmInput.type = "number";
  bpmInput.min = String(MIN_SOUND_BPM);
  bpmInput.max = String(MAX_SOUND_BPM);
  bpmInput.step = "0.01";
  bpmInput.placeholder = "未設定";
  const meterSelect = el("select", "quantize-select");
  for (const n of [2, 3, 4, 5, 6, 7]) {
    const o = el("option", undefined, `${n}拍`);
    o.value = String(n);
    meterSelect.appendChild(o);
  }
  const tapButton = button("叩いてテンポ", () => tap(), "layer-toggle");
  tapButton.title = "曲に合わせて何回か押すと、その速さをテンポにします";
  const clearBpmButton = button("テンポを消す", () => void setBpm(undefined), "layer-toggle");
  const tempoRow = el("div", "snd-row");
  tempoRow.append(el("span", "snd-label", "テンポ"), bpmInput, el("span", "snd-label", "1小節"), meterSelect, tapButton, clearBpmButton);

  const barsSelect = el("select", "quantize-select");
  for (const n of BAR_CHOICES) {
    const o = el("option", undefined, `${n}小節`);
    o.value = String(n);
    barsSelect.appendChild(o);
  }
  const barsButton = button("ちょうどこの長さとしてテンポを出す", () => void tempoFromBars(), "layer-toggle");
  const barsRow = el("div", "snd-row");
  barsRow.append(el("span", "snd-label", "1拍目から終わりまでが"), barsSelect, barsButton);
  const tempoNote = el("div", "snd-hint");

  const removeButton = button("この音を消す", () => void removeSelected(), "layer-toggle snd-remove");
  body.append(nameInput, info, canvas, waveNote, playRow, tempoRow, barsRow, tempoNote, removeButton);

  // --- 鍵盤で鳴らす（編集中の層の楽器） -------------------------------------------------
  const inst = deps.instrument;
  const instBox = el("div", "snd-inst");
  const instHead = el("div", "panel-heading", "鍵盤で鳴らす");
  const instTarget = el("div", "snd-inst-target");
  const useButton = button("この層を、選んだ音で鳴らす", () => {
    if (selectedId) inst.useSound(selectedId);
  }, "preset-button");
  const backButton = button("シンセに戻す", () => inst.useSound(null), "layer-toggle");
  const instRow = el("div", "snd-row");
  instRow.append(useButton, backButton);
  const instNote = el("div", "snd-hint");
  const sampler = (): SamplerParams | undefined => {
    const layer = inst.target().layer;
    return usesSampler(layer) ? layer.sampler : undefined;
  };
  const change = (patch: Partial<SamplerParams>): void => {
    inst.change(patch);
    refreshInstrument();
  };
  const sec = (v: number): string => (v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}秒`);
  /** 型ごとに出すつまみ。show が false のときは隠す。 */
  const modeIs = (m: SamplerMode) => (): boolean => sampler()?.mode === m;
  const always = (): boolean => true;
  const controls: { c: Control; show: () => boolean }[] = [
    {
      show: always,
      c: choice<SamplerMode>({
        label: "型",
        options: () => [
          ["keys", "鍵盤型（1つの音を高さを変えて弾く）"],
          ["pads", "パッド型（切った断片を鍵盤に並べる）"],
        ],
        get: () => sampler()?.mode ?? "keys",
        // パッド型は、すぐ離しても断片の終わりまで鳴るほうが叩きやすい
        set: (v) => change(v === "pads" ? { mode: v, hold: "oneshot" } : { mode: v, hold: "gate" }),
        hint: () => "鍵盤型：右の鍵盤ほど高く（速く）鳴る。パッド型：C4（PCキーボードの A）から右へ、断片が1つずつ並ぶ。左の鍵盤には後ろの断片が並ぶ",
      }),
    },
    {
      show: modeIs("pads"),
      c: choice<SliceCut>({
        label: "切り方",
        options: () => [
          ["divide", "等分"],
          ["transient", "音の頭（アタック）"],
          ...(selectedSoundOfLayer()?.bpm ? ([["beats", "拍"]] as [SliceCut, string][]) : []),
        ],
        get: () => sampler()?.cut ?? "divide",
        set: (v) => void recut({ cut: v }),
        hint: () => "切れ目は、波形の上の黄色い線をドラッグしても動かせます。「拍」はテンポを入れた音だけ",
      }),
    },
    {
      show: () => modeIs("pads")() && sampler()?.cut === "divide",
      c: knob({
        label: "数",
        min: 2,
        max: MAX_SLICES,
        step: 1,
        get: () => sampler()?.divisions ?? 8,
        set: (v) => void recut({ divisions: v }),
        format: (v) => `${v}個`,
        hint: () => "同じ長さに、いくつに切るか",
      }),
    },
    {
      show: () => modeIs("pads")() && sampler()?.cut === "transient",
      c: knob({
        label: "拾いやすさ",
        get: () => sampler()?.sensitivity ?? 0.5,
        set: (v) => void recut({ sensitivity: v }),
        hint: () => "大きいほど、小さな音の頭でも切ります",
      }),
    },
    {
      show: () => modeIs("pads")() && sampler()?.cut === "beats",
      c: choice<string>({
        label: "何拍ごと",
        options: () => [
          ["0.5", "8分（半拍）"],
          ["1", "1拍"],
          ["2", "2拍"],
          [String(selectedSoundOfLayer()?.beatsPerBar ?? 4), "1小節"],
        ],
        get: () => String(sampler()?.beatsPerSlice ?? 1),
        set: (v) => void recut({ beatsPerSlice: Number(v) }),
      }),
    },
    {
      show: modeIs("keys"),
      c: knob({
        label: "元の高さ",
        min: 24,
        max: 96,
        step: 1,
        get: () => sampler()?.rootPitch ?? 60,
        set: (v) => change({ rootPitch: v }),
        format: (v) => pitchName(v),
        hint: () => "この鍵盤を押すと、読み込んだときの高さで鳴ります。右の鍵盤ほど高く（速く）なります",
      }),
    },
    {
      show: always,
      c: knob({
        label: "細かい音程",
        min: -100,
        max: 100,
        step: 1,
        get: () => sampler()?.tune ?? 0,
        set: (v) => change({ tune: v }),
        format: (v) => `${v > 0 ? "+" : ""}${v}セント`,
        hint: () => "半音より細かく、高さを合わせます（100セント＝半音）",
      }),
    },
    {
      show: modeIs("keys"),
      c: knob({
        label: "始まり",
        get: () => sampler()?.start ?? 0,
        set: (v) => change({ start: Math.min(v, (sampler()?.end ?? 1) - 0.001) }),
        format: (v) => formatSeconds(v * (selectedSoundOfLayer()?.durationSec ?? 0)),
        hint: () => "音のどこから鳴らすか（波形の明るい所が鳴る範囲）",
      }),
    },
    {
      show: modeIs("keys"),
      c: knob({
        label: "終わり",
        get: () => sampler()?.end ?? 1,
        set: (v) => change({ end: Math.max(v, (sampler()?.start ?? 0) + 0.001) }),
        format: (v) => formatSeconds(v * (selectedSoundOfLayer()?.durationSec ?? 0)),
        hint: () => "音のどこまで鳴らすか",
      }),
    },
    {
      show: always,
      c: knob({
        label: "立ち上がり",
        min: 0,
        max: MAX_ATTACK,
        step: 0.001,
        get: () => sampler()?.attack ?? 0,
        set: (v) => change({ attack: v }),
        format: sec,
        hint: () => "押してから、いちばん大きくなるまでの時間。長くすると、ふわっと入ります",
      }),
    },
    {
      show: always,
      c: knob({
        label: "消え方",
        min: 0,
        max: MAX_RELEASE,
        step: 0.001,
        get: () => sampler()?.release ?? 0,
        set: (v) => change({ release: v }),
        format: sec,
        hint: () => "離してから、消えるまでの時間",
      }),
    },
    {
      show: always,
      c: choice<SamplerHold>({
        label: "鳴らし方",
        options: () => [
          ["gate", "押している間だけ"],
          ["oneshot", "最後まで鳴らす"],
        ],
        get: () => sampler()?.hold ?? "gate",
        set: (v) => change({ hold: v }),
        hint: () => "「最後まで鳴らす」は、すぐ離しても範囲（断片）の終わりまで鳴ります",
      }),
    },
    {
      show: () => modeIs("keys")() && sampler()?.hold === "gate",
      c: toggle({
        label: "ループ",
        get: () => sampler()?.loop ?? false,
        set: (v) => change({ loop: v }),
        hint: () => "押している間、範囲をくり返します（伸ばす音に）",
      }),
    },
    {
      show: always,
      c: toggle({
        label: "逆再生",
        get: () => sampler()?.reverse ?? false,
        set: (v) => change({ reverse: v }),
        hint: () => "音を逆さまに鳴らします",
      }),
    },
  ];
  const knobBox = el("div", "snd-knobs");
  knobBox.append(...controls.map((x) => x.c.el));

  /** パッド型の切り方を変えて、切り直す。 */
  async function recut(patch: Partial<SamplerParams>): Promise<void> {
    const p = sampler();
    if (!p) return;
    const next = { ...p, ...patch };
    const meta = library.get(p.soundId);
    let slices: number[] | null = null;
    if (next.cut === "divide") slices = divideSlices(next.divisions);
    else if (next.cut === "beats" && meta) slices = beatSlices(meta, next.beatsPerSlice);
    else if (next.cut === "transient") {
      const buffer = await library.buffer(p.soundId);
      if (buffer) {
        const l = buffer.getChannelData(0);
        const pcm = { l, r: buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l };
        // 拾いやすさが低いほど、断片は長め（音の頭どうしの最小の間を広げる）
        const minMs = 40 + (1 - next.sensitivity) * 160;
        slices = onsetSlices(detectOnsets(pcm, buffer.sampleRate, next.sensitivity, minMs), buffer.length);
      }
    }
    change({ ...patch, ...(slices ? { slices } : {}) });
  }
  instBox.append(instHead, instTarget, instRow, instNote, knobBox);
  body.append(instBox);

  /** 編集中の層が鳴らしている音（棚にあれば）。 */
  function selectedSoundOfLayer(): StoredSound | undefined {
    const p = sampler();
    return p ? library.get(p.soundId) : undefined;
  }

  function refreshInstrument(): void {
    const { layer, label } = inst.target();
    const p = sampler();
    const s = selected();
    const using = p ? library.get(p.soundId) : undefined;
    if (layer.role === "drums") {
      instTarget.textContent = `編集中：${label}`;
      instNote.textContent = "ドラムの層はサンプラーにできません。フレーズタブで、ほかの層を選んでください";
      useButton.hidden = true;
      backButton.hidden = true;
      knobBox.hidden = true;
      return;
    }
    instTarget.textContent = p
      ? `編集中：${label} ・ サンプラー（${using?.name ?? "棚に無い音"}）`
      : `編集中：${label} ・ シンセ`;
    useButton.hidden = !s || p?.soundId === s.id;
    useButton.textContent = p ? "選んだ音に替える" : "この層を、選んだ音で鳴らす";
    backButton.hidden = !p;
    knobBox.hidden = !p;
    instNote.textContent = p
      ? "下の鍵盤（PCキーボードの A・S・D… でも）で弾けます。フレーズタブで録音すると、この音で録れます"
      : "選んだ音を、編集中の層の楽器にします。どの層を編集するかは、フレーズタブで選びます";
    for (const x of controls) {
      x.c.el.hidden = !x.show();
      x.c.refresh();
    }
    renderDetail();
  }

  detail.append(detailHead, empty, body);
  root.append(shelf, detail);

  // --- 状態 ---------------------------------------------------------------------
  let selectedId: string | null = null;
  let placing = false;
  let taps: number[] = [];
  let signedIn = getCloudState().status !== "signedOut";
  let cloud: SoundCloudState | null = null;
  let source: AudioBufferSourceNode | null = null;
  let playStartedAt = 0;
  let playOffset = 0;
  let raf = 0;

  const selected = (): StoredSound | undefined => (selectedId ? library.get(selectedId) : undefined);

  function showMessage(text: string, kind: "error" | "info" = "info"): void {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  async function importFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    showMessage("読み込み中…");
    try {
      const { added, errors } = await library.addFiles(files);
      if (added.length > 0) selectedId = added[added.length - 1].id;
      showMessage(errors.join("\n"), errors.length > 0 ? "error" : "info");
    } catch (err) {
      console.error("音を読み込めませんでした", err);
      showMessage("音を読み込めませんでした", "error");
    }
    render();
    refreshInstrument();
  }

  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    void importFiles(files);
  });
  shelf.addEventListener("dragover", (e) => {
    e.preventDefault();
    shelf.classList.add("snd-drop");
  });
  shelf.addEventListener("dragleave", () => shelf.classList.remove("snd-drop"));
  shelf.addEventListener("drop", (e) => {
    e.preventDefault();
    shelf.classList.remove("snd-drop");
    void importFiles([...(e.dataTransfer?.files ?? [])]);
  });

  // --- 棚の一覧 -------------------------------------------------------------------
  function cloudLabel(s: StoredSound): string {
    if (!signedIn) return s.blob ? "" : "中身がありません";
    if (cloud?.uploading.has(s.id)) return "クラウドへ上げ中…";
    if (cloud?.downloading.has(s.id)) return "クラウドから取り寄せ中…";
    if (!s.blob) return cloud?.ids.has(s.id) ? "まだ取り寄せていません" : "クラウドに中身がありません";
    return cloud?.ids.has(s.id) ? "☁ クラウドにも保存済み" : "まだクラウドに上げていません";
  }

  function renderList(): void {
    list.innerHTML = "";
    if (library.sounds.length === 0) {
      list.append(el("div", "snd-hint", "まだ音がありません。"));
      return;
    }
    for (const s of library.sounds) {
      const row = el("button", "snd-item");
      row.type = "button";
      row.classList.toggle("active", s.id === selectedId);
      row.classList.toggle("missing", !s.blob);
      const thumb = el("canvas", "snd-thumb");
      const text = el("div", "snd-item-text");
      const name = el("div", "snd-item-name", s.name);
      const meta = [formatSeconds(s.durationSec), formatBytes(s.bytes)];
      if (s.bpm) meta.push(`BPM ${round(s.bpm)}`);
      const sub = el("div", "snd-item-sub", meta.join(" ・ "));
      const state = el("div", "snd-item-cloud", cloudLabel(s));
      text.append(name, sub, state);
      row.append(thumb, text);
      row.addEventListener("click", () => {
        if (selectedId !== s.id) stop();
        selectedId = s.id;
        setPlacing(false);
        render();
        refreshInstrument();
      });
      list.append(row);
      requestAnimationFrame(() => drawPeaks(thumb, s, { grid: false }));
    }
  }

  function renderCloud(): void {
    cloudLine.dataset.kind = cloud?.message ? "error" : "info";
    if (!signedIn) {
      cloudLine.textContent = "ログインすると、音をクラウドにも置けます（別の端末でも使えます）";
      return;
    }
    const used = cloud?.usedBytes;
    const usage =
      used === null || used === undefined
        ? "クラウドの使用量：確認中…"
        : `クラウドの使用量：${formatBytes(used)} / ${formatBytes(CLOUD_QUOTA_BYTES)}（${Math.round((used / CLOUD_QUOTA_BYTES) * 1000) / 10}%）`;
    cloudLine.textContent = cloud?.message ? `${usage}\n${cloud.message}` : usage;
  }

  // --- 選んだ音 ---------------------------------------------------------------------
  function renderDetail(): void {
    const s = selected();
    empty.hidden = !!s;
    body.hidden = !s;
    if (!s) return;
    if (document.activeElement !== nameInput) nameInput.value = s.name;
    info.textContent = [
      formatSeconds(s.durationSec),
      formatBytes(s.bytes),
      s.channels === 1 ? "モノラル" : s.channels === 2 ? "ステレオ" : `${s.channels}ch`,
      `${(s.sampleRate / 1000).toFixed(1)}kHz`,
    ].join(" ・ ");
    if (document.activeElement !== bpmInput) bpmInput.value = s.bpm ? String(round(s.bpm)) : "";
    meterSelect.value = String(s.beatsPerBar ?? 4);
    playButton.textContent = source ? "■ 止める" : "▶ 試聴";
    playButton.disabled = !s.blob;
    downbeatButton.classList.toggle("on", placing);
    waveNote.textContent = placing
      ? "波形をタップした所を1拍目にします"
      : padSlices(s)
        ? `黄色い線が切れ目（${padSlices(s)!.length}個。ドラッグで動かせる）。断片を押すと、その断片だけ鳴らします`
        : `波形をタップすると、そこから鳴らします。オレンジの線が1拍目（${formatSeconds(s.downbeatSec ?? 0)}）`;
    const bars = barsOf(s);
    tempoNote.textContent = s.bpm
      ? `1拍目から終わりまで 約${Math.round((bars ?? 0) * 100) / 100}小節。線は拍、太い線は小節の頭`
      : "テンポが分かると、刻むや曲に置くときに拍に合わせられます（後の段階）。分からなければ空のままで大丈夫です";
    drawPeaks(canvas, s, { grid: true });
  }

  function render(): void {
    renderList();
    renderCloud();
    renderDetail();
  }

  // --- 波形の絵 ---------------------------------------------------------------------
  function drawPeaks(c: HTMLCanvasElement, s: StoredSound, opts: { grid: boolean }): void {
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const green = css.getPropertyValue("--accent-green").trim() || "#3ee6b0";
    const orange = css.getPropertyValue("--accent-orange").trim() || "#ff6f4d";
    const dim = css.getPropertyValue("--border").trim() || "#2a2c36";
    const x = (sec: number): number => (sec / Math.max(1e-6, s.durationSec)) * w;

    g.fillStyle = s.blob ? green : dim;
    const n = s.peaks.length;
    const mid = h / 2;
    for (let i = 0; i < n; i++) {
      const px = (i / n) * w;
      const ph = Math.max(1, s.peaks[i] * (h / 2 - 2));
      g.fillRect(px, mid - ph, Math.max(1, w / n - 0.5), ph * 2);
    }
    // サンプラーで鳴らす範囲の外を暗くする（編集中の層がこの音を鳴らしているとき）
    const p = sampler();
    if (opts.grid && p && p.soundId === s.id && (p.start > 0 || p.end < 1)) {
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(0, 0, p.start * w, h);
      g.fillRect(p.end * w, 0, w - p.end * w, h);
    }
    if (opts.grid) {
      // 拍の線は波形の上に重ねる（音の頭と重なっても見えるように）
      for (const b of beatGrid(s)) {
        g.fillStyle = b.bar ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.22)";
        g.fillRect(Math.round(x(b.sec)), 0, b.bar ? 2 : 1, h);
      }
      g.fillStyle = orange;
      g.fillRect(Math.round(x(s.downbeatSec ?? 0)) - 1, 0, 3, h);
      // パッド型の切れ目と、その断片を鳴らす鍵盤の名前
      const slices = padSlices(s);
      if (slices) {
        const yellow = css.getPropertyValue("--accent-yellow").trim() || "#ffd166";
        g.font = "10px system-ui, sans-serif";
        slices.forEach((v, i) => {
          const px = Math.round(v * w);
          g.fillStyle = yellow;
          if (i > 0) g.fillRect(px - 1, 0, 2, h);
          const next = (slices[i + 1] ?? 1) * w;
          if (next - px > 18) g.fillText(pitchName(PAD_BASE_PITCH + i), px + 3, 11);
        });
      }
      if (source) {
        g.fillStyle = "#ffffff";
        g.fillRect(Math.round(x(playheadSec())), 0, 2, h);
      }
    }
  }

  /** パッド型で、この音を切っているとき：その切れ目。 */
  function padSlices(s: StoredSound): number[] | null {
    const p = sampler();
    return p && p.mode === "pads" && p.soundId === s.id ? (dragSlices ?? p.slices) : null;
  }

  let dragSlices: number[] | null = null;
  let dragIndex = -1;
  canvas.addEventListener("pointerdown", (e) => {
    const s = selected();
    if (!s) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const sec = frac * s.durationSec;
    if (placing) {
      setPlacing(false);
      void library.update(s.id, { downbeatSec: Math.round(sec * 1000) / 1000 });
      return;
    }
    const slices = padSlices(s);
    if (slices) {
      // 切れ目の近く（指で押しやすいよう 12px 以内）を押したら、その切れ目を動かす。頭（0）は動かさない
      const near = slices.findIndex((v, i) => i > 0 && Math.abs(v * rect.width - (e.clientX - rect.left)) < 12);
      if (near > 0) {
        dragSlices = [...slices];
        dragIndex = near;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      // 断片の中を押したら、その断片だけ鳴らす
      let i = 0;
      while (i + 1 < slices.length && slices[i + 1] <= frac) i++;
      const r = sliceRange(slices, i);
      void play(r.start * s.durationSec, r.end * s.durationSec);
      return;
    }
    void play(sec);
  });
  canvas.addEventListener("pointermove", (e) => {
    const s = selected();
    if (!s || !dragSlices || dragIndex <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    // 隣の切れ目は越えない
    const lo = dragSlices[dragIndex - 1] + 0.002;
    const hi = (dragSlices[dragIndex + 1] ?? 1) - 0.002;
    dragSlices[dragIndex] = Math.min(hi, Math.max(lo, frac));
    drawPeaks(canvas, s, { grid: true });
  });
  const endDrag = (): void => {
    if (!dragSlices) return;
    const slices = normalizeSlices(dragSlices);
    dragSlices = null;
    dragIndex = -1;
    inst.change({ slices });
    refreshInstrument();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // --- 試聴 -------------------------------------------------------------------------
  function playheadSec(): number {
    return playOffset + (deps.audio.ctx.currentTime - playStartedAt);
  }

  async function play(fromSec = 0, untilSec?: number): Promise<void> {
    const s = selected();
    if (!s) return;
    stop();
    await deps.prepareAudio();
    const buffer = await library.buffer(s.id);
    if (!buffer) {
      showMessage("この音は、まだ端末にありません", "error");
      return;
    }
    const ctx = deps.audio.ctx;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(deps.audio.out);
    node.onended = () => {
      if (source !== node) return;
      source = null;
      cancelAnimationFrame(raf);
      renderDetail();
    };
    playStartedAt = ctx.currentTime;
    playOffset = fromSec;
    if (untilSec !== undefined) node.start(0, fromSec, Math.max(0.005, untilSec - fromSec));
    else node.start(0, fromSec);
    source = node;
    const tick = (): void => {
      if (!source) return;
      drawPeaks(canvas, s, { grid: true });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    renderDetail();
  }

  function stop(): void {
    if (!source) return;
    const node = source;
    source = null;
    cancelAnimationFrame(raf);
    try {
      node.stop();
    } catch {
      // もう止まっている
    }
    node.disconnect();
    renderDetail();
  }

  function togglePlay(): void {
    if (source) stop();
    else void play(0);
  }

  // --- テンポ・1拍目 ------------------------------------------------------------------
  function setPlacing(on: boolean): void {
    placing = on;
    renderDetail();
  }

  async function setBpm(bpm: number | undefined): Promise<void> {
    const s = selected();
    if (!s) return;
    await library.update(s.id, { bpm });
  }

  bpmInput.addEventListener("change", () => {
    const v = Number(bpmInput.value);
    void setBpm(bpmInput.value === "" || !Number.isFinite(v) || v <= 0 ? undefined : clampBpm(v));
  });
  meterSelect.addEventListener("change", () => {
    const s = selected();
    if (s) void library.update(s.id, { beatsPerBar: Number(meterSelect.value) });
  });
  nameInput.addEventListener("change", () => {
    const s = selected();
    const name = nameInput.value.trim();
    if (s && name && name !== s.name) void library.update(s.id, { name });
  });

  function tap(): void {
    const now = performance.now();
    taps.push(now);
    taps = taps.filter((t) => now - t < 8000);
    const bpm = bpmFromTaps(taps);
    if (bpm) void setBpm(bpm);
  }

  async function tempoFromBars(): Promise<void> {
    const s = selected();
    if (!s) return;
    const bpm = bpmFromBars(s.durationSec, s.downbeatSec ?? 0, Number(barsSelect.value), s.beatsPerBar ?? 4);
    if (bpm) await setBpm(bpm);
  }

  async function snapDownbeatToFirstSound(): Promise<void> {
    const s = selected();
    if (!s) return;
    const buffer = await library.buffer(s.id);
    if (!buffer) return;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    await library.update(s.id, { downbeatSec: firstSoundSec(channels, buffer.sampleRate) });
  }

  async function removeSelected(): Promise<void> {
    const s = selected();
    if (!s) return;
    const where = signedIn ? "この端末とクラウドから" : "この端末から";
    if (!window.confirm(`音「${s.name}」を${where}消す？`)) return;
    stop();
    selectedId = null;
    await library.remove(s.id);
  }

  library.subscribe(() => {
    if (selectedId && !library.get(selectedId)) selectedId = null;
    render();
    refreshInstrument();
  });
  subscribeCloud((st) => {
    signedIn = st.status !== "signedOut";
    renderList();
    renderCloud();
  });
  subscribeSoundCloud((st) => {
    cloud = st;
    renderList();
    renderCloud();
  });
  new ResizeObserver(() => renderDetail()).observe(canvas);
  void library.reload();

  return { el: root, togglePlay, stop, refreshInstrument };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
