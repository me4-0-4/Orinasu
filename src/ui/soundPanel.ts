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
import { button, el } from "./mixWidgets";

export interface SoundPanelDeps {
  library: SoundLibrary;
  audio: { ctx: AudioContext; out: AudioNode };
  /** 鳴らす前に呼ぶ：音を出す準備と、ほかの音を止める。 */
  prepareAudio: () => Promise<void>;
}

export interface SoundPanel {
  el: HTMLElement;
  /** スペース：選んだ音の試聴 ⇔ 停止。 */
  togglePlay: () => void;
  stop: () => void;
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
    if (opts.grid) {
      // 拍の線は波形の上に重ねる（音の頭と重なっても見えるように）
      for (const b of beatGrid(s)) {
        g.fillStyle = b.bar ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.22)";
        g.fillRect(Math.round(x(b.sec)), 0, b.bar ? 2 : 1, h);
      }
      g.fillStyle = orange;
      g.fillRect(Math.round(x(s.downbeatSec ?? 0)) - 1, 0, 3, h);
      if (source) {
        g.fillStyle = "#ffffff";
        g.fillRect(Math.round(x(playheadSec())), 0, 2, h);
      }
    }
  }

  canvas.addEventListener("pointerdown", (e) => {
    const s = selected();
    if (!s) return;
    const rect = canvas.getBoundingClientRect();
    const sec = Math.min(s.durationSec, Math.max(0, ((e.clientX - rect.left) / rect.width) * s.durationSec));
    if (placing) {
      setPlacing(false);
      void library.update(s.id, { downbeatSec: Math.round(sec * 1000) / 1000 });
      return;
    }
    void play(sec);
  });

  // --- 試聴 -------------------------------------------------------------------------
  function playheadSec(): number {
    return playOffset + (deps.audio.ctx.currentTime - playStartedAt);
  }

  async function play(fromSec = 0): Promise<void> {
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
    node.start(0, fromSec);
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

  return { el: root, togglePlay, stop };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
