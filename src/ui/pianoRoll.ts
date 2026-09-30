import { quantizeBeat } from "../phrase/quantize";
import type { Layer, Note, Phrase } from "../phrase/types";

const PITCH_MIN = 33; // A1
const PITCH_MAX = 96; // C7
const ROW_HEIGHT = 14;
const HEADER_HEIGHT = 20;
const KEY_STRIP_WIDTH = 34;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function pitchName(pitch: number): string {
  const octave = Math.floor(pitch / 12) - 1; // MIDI 60 = C4
  return `${NOTE_NAMES[pitch % 12]}${octave}`;
}

type DragMode = "move" | "resize";

interface DragState {
  mode: DragMode;
  note: Note;
  origStartBeats: number;
  origDuration: number;
  origPitch: number;
  startClientX: number;
  startClientY: number;
}

export class PianoRoll {
  readonly el: HTMLElement;
  private readonly scrollWrap: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly deleteButton: HTMLButtonElement;
  private phrase: Phrase | null = null;
  private activeLayerId: string | null = null;
  private selectedNoteId: string | null = null;
  private playheadBeats: number | null = null;
  private drag: DragState | null = null;
  private pxPerBeat = 40;

  onChange: () => void = () => {};
  /** ノートを上下に動かしたときの音高の補正（スケールロック用）。 */
  pitchFilter: (pitch: number) => number = (p) => p;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "piano-roll";

    const toolbar = document.createElement("div");
    toolbar.className = "piano-roll-toolbar";
    this.deleteButton = document.createElement("button");
    this.deleteButton.type = "button";
    this.deleteButton.className = "piano-roll-delete-button";
    this.deleteButton.textContent = "選択ノートを削除";
    this.deleteButton.disabled = true;
    this.deleteButton.addEventListener("click", () => this.deleteSelected());
    toolbar.appendChild(this.deleteButton);

    this.scrollWrap = document.createElement("div");
    this.scrollWrap.className = "piano-roll-scroll";

    this.canvas = document.createElement("canvas");
    this.canvas.className = "piano-roll-canvas";
    this.canvas.tabIndex = 0;

    this.scrollWrap.appendChild(this.canvas);
    this.el.append(toolbar, this.scrollWrap);

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("resize", () => this.draw());
  }

  setPhrase(phrase: Phrase | null, activeLayerId: string | null): void {
    this.phrase = phrase;
    this.activeLayerId = activeLayerId;
    this.draw();
    this.scrollToNotesIfHidden();
  }

  /** アクティブレイヤーの音が今のスクロール位置から見えていない場合だけ、見える位置まで合わせる。 */
  private scrollToNotesIfHidden(): void {
    const layer = this.activeLayer();
    if (!layer || layer.notes.length === 0) return;
    const pitches = layer.notes.map((n) => n.pitch);
    const minY = this.pitchToY(Math.max(...pitches));
    const maxY = this.pitchToY(Math.min(...pitches)) + ROW_HEIGHT;
    const wrapHeight = this.scrollWrap.getBoundingClientRect().height || 260;
    const viewTop = this.scrollWrap.scrollTop;
    const viewBottom = viewTop + wrapHeight;
    if (minY >= viewTop && maxY <= viewBottom) return;
    const centerY = (minY + maxY) / 2;
    this.scrollWrap.scrollTop = Math.max(0, centerY - wrapHeight / 2);
  }

  setPlayheadBeats(beats: number | null): void {
    this.playheadBeats = beats;
    this.draw();
  }

  getSelectedNoteId(): string | null {
    return this.selectedNoteId;
  }

  deleteSelected(): void {
    if (!this.selectedNoteId || !this.phrase) return;
    const layer = this.activeLayer();
    if (!layer) return;
    layer.notes = layer.notes.filter((n) => n.id !== this.selectedNoteId);
    this.setSelected(null);
    this.draw();
    this.onChange();
  }

  private setSelected(noteId: string | null): void {
    this.selectedNoteId = noteId;
    this.deleteButton.disabled = noteId === null;
  }

  private activeLayer(): Layer | null {
    if (!this.phrase || !this.activeLayerId) return null;
    return this.phrase.layers.find((l) => l.id === this.activeLayerId) ?? null;
  }

  private totalBeats(): number {
    if (!this.phrase) return 4;
    return this.phrase.lengthBars * this.phrase.beatsPerBar;
  }

  private layoutWidth(): number {
    const rect = this.scrollWrap.getBoundingClientRect();
    return Math.max(rect.width, KEY_STRIP_WIDTH + this.totalBeats() * this.pxPerBeat);
  }

  private pitchToY(pitch: number): number {
    return HEADER_HEIGHT + (PITCH_MAX - pitch) * ROW_HEIGHT;
  }

  private yToPitch(y: number): number {
    return PITCH_MAX - Math.floor((y - HEADER_HEIGHT) / ROW_HEIGHT);
  }

  /** 拍位置(0起点)を、鍵盤の目印分オフセットした絶対x座標にする。 */
  private beatToX(beat: number): number {
    return KEY_STRIP_WIDTH + beat * this.pxPerBeat;
  }

  /** 拍の「長さ」をピクセル幅に変える（オフセットは含めない）。 */
  private beatsToPx(beats: number): number {
    return beats * this.pxPerBeat;
  }

  private draw(): void {
    const width = this.layoutWidth();
    const realHeight = (PITCH_MAX - PITCH_MIN + 1) * ROW_HEIGHT + HEADER_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${realHeight}px`;
    this.canvas.width = width * dpr;
    this.canvas.height = realHeight * dpr;

    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0c0d12";
    ctx.fillRect(0, 0, width, realHeight);

    const total = this.totalBeats();
    const layer = this.activeLayer();
    const grid = layer?.quantizeGrid;

    // 白鍵/黒鍵の背景（鍵盤の目印の帯も含めて塗る）
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
      const isBlack = [1, 3, 6, 8, 10].includes(p % 12);
      if (isBlack) {
        ctx.fillStyle = "#101014";
        ctx.fillRect(0, this.pitchToY(p), width, ROW_HEIGHT);
      }
    }

    // 拍・小節のグリッド線
    for (let b = 0; b <= total; b += 1) {
      const x = this.beatToX(b);
      const isBar = this.phrase ? b % this.phrase.beatsPerBar === 0 : false;
      ctx.strokeStyle = isBar ? "#3a3c48" : "#22232b";
      ctx.lineWidth = isBar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x, realHeight);
      ctx.stroke();
    }
    if (grid) {
      ctx.strokeStyle = "#22232b88";
      ctx.lineWidth = 1;
      for (let b = 0; b < total; b += grid) {
        const x = this.beatToX(b);
        ctx.beginPath();
        ctx.moveTo(x, HEADER_HEIGHT);
        ctx.lineTo(x, realHeight);
        ctx.stroke();
      }
    }

    // 左端：実際の鍵盤のように白鍵/黒鍵の帯を描き、どのCかが一目で分かるようにする
    ctx.fillStyle = "#0c0d12";
    ctx.fillRect(0, 0, KEY_STRIP_WIDTH, realHeight);
    const blackKeyWidth = KEY_STRIP_WIDTH * 0.62;
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
      const y = this.pitchToY(p);
      const isBlack = [1, 3, 6, 8, 10].includes(p % 12);
      ctx.fillStyle = isBlack ? "#1c1d24" : "#d8d9de";
      ctx.fillRect(0, y, isBlack ? blackKeyWidth : KEY_STRIP_WIDTH, ROW_HEIGHT);
      if (!isBlack) {
        ctx.strokeStyle = "#0c0d1288";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + ROW_HEIGHT + 0.5);
        ctx.lineTo(KEY_STRIP_WIDTH, y + ROW_HEIGHT + 0.5);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = "#3a3c48";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(KEY_STRIP_WIDTH, 0);
    ctx.lineTo(KEY_STRIP_WIDTH, realHeight);
    ctx.stroke();
    // Cの鍵にだけオクターブ番号込みの音名を出す（「C」だけだと何番目のCか分からないため）
    ctx.fillStyle = "#0c0d12";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
      if (p % 12 !== 0) continue;
      const y = this.pitchToY(p);
      ctx.fillText(pitchName(p), 2, y + ROW_HEIGHT - 4);
    }

    // 他レイヤー（参考表示・編集不可）
    if (this.phrase) {
      for (const l of this.phrase.layers) {
        if (l.id === this.activeLayerId) continue;
        for (const note of l.notes) {
          this.drawNote(ctx, l, note, "#5eb4ff66", "#5eb4ff99");
        }
      }
    }

    // アクティブレイヤー
    if (layer) {
      for (const note of layer.notes) {
        const selected = note.id === this.selectedNoteId;
        this.drawNote(
          ctx,
          layer,
          note,
          selected ? "#3ee6b0" : "#3ee6b0cc",
          selected ? "#e9e9ee" : "#0c0d12",
        );
      }
    }

    // 再生位置
    if (this.playheadBeats !== null) {
      const x = this.beatToX(this.playheadBeats);
      ctx.strokeStyle = "#ff6f4d";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, realHeight);
      ctx.stroke();
    }

    ctx.fillStyle = "#9a9ba6";
    ctx.font = "10px sans-serif";
    for (let b = 0; b < total; b += this.phrase?.beatsPerBar ?? 4) {
      ctx.fillText(`${b / (this.phrase?.beatsPerBar ?? 4) + 1}`, this.beatToX(b) + 3, 13);
    }
  }

  /** ノートの区間（開始・長さ）を1つ描く。小節の終わりをまたぐ場合は呼び出し側で2回に分けて呼ぶ。 */
  private drawNoteSegment(
    ctx: CanvasRenderingContext2D,
    startBeat: number,
    durationBeats: number,
    pitch: number,
    fill: string,
    stroke: string,
  ): { x: number; endX: number } {
    const x = this.beatToX(startBeat);
    const w = Math.max(4, this.beatsToPx(durationBeats));
    const y = this.pitchToY(pitch);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y + 1, w, ROW_HEIGHT - 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 1.5, w - 1, ROW_HEIGHT - 3);
    return { x, endX: x + w };
  }

  /** ノートの実効開始位置・長さを求める（クオンタイズ適用・小節長にクランプ済み）。 */
  private effectiveNoteSpan(layer: Layer, note: Note): { wrapped: number; duration: number } {
    const total = this.totalBeats();
    const effectiveStart = layer.quantizeGrid
      ? quantizeBeat(note.startBeats, layer.quantizeGrid)
      : note.startBeats;
    const wrapped = ((effectiveStart % total) + total) % total;
    const duration = Math.min(note.durationBeats, total);
    return { wrapped, duration };
  }

  private drawNote(
    ctx: CanvasRenderingContext2D,
    layer: Layer,
    note: Note,
    fill: string,
    stroke: string,
  ): void {
    const total = this.totalBeats();
    const { wrapped, duration } = this.effectiveNoteSpan(layer, note);

    if (wrapped + duration <= total) {
      this.drawNoteSegment(ctx, wrapped, duration, note.pitch, fill, stroke);
    } else {
      // 小節の終わりをまたぐ場合、はみ出さないよう2つに分けて描く（続きは先頭に戻る）
      const firstPart = total - wrapped;
      this.drawNoteSegment(ctx, wrapped, firstPart, note.pitch, fill, stroke);
      this.drawNoteSegment(ctx, 0, duration - firstPart, note.pitch, fill, stroke);
    }
  }

  private noteAt(x: number, y: number): { note: Note; nearRightEdge: boolean } | null {
    const layer = this.activeLayer();
    if (!layer) return null;
    const pitch = this.yToPitch(y);
    const total = this.totalBeats();
    for (let i = layer.notes.length - 1; i >= 0; i--) {
      const note = layer.notes[i];
      if (note.pitch !== pitch) continue;
      const { wrapped, duration } = this.effectiveNoteSpan(layer, note);

      const seg1Start = wrapped;
      const seg1Duration = Math.min(duration, total - wrapped);
      const seg1X = this.beatToX(seg1Start);
      const seg1EndX = seg1X + Math.max(4, this.beatsToPx(seg1Duration));
      if (x >= seg1X && x <= seg1EndX) {
        return { note, nearRightEdge: seg1EndX - x < 6 && seg1Duration >= duration };
      }

      if (duration > seg1Duration) {
        const seg2Duration = duration - seg1Duration;
        const seg2X = this.beatToX(0);
        const seg2EndX = seg2X + Math.max(4, this.beatsToPx(seg2Duration));
        if (x >= seg2X && x <= seg2EndX) {
          return { note, nearRightEdge: seg2EndX - x < 6 };
        }
      }
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.focus();
    const layer = this.activeLayer();
    if (!layer) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = this.noteAt(x, y);
    if (!hit) {
      this.setSelected(null);
      this.draw();
      return;
    }
    this.setSelected(hit.note.id);
    this.drag = {
      mode: hit.nearRightEdge ? "resize" : "move",
      note: hit.note,
      origStartBeats: hit.note.startBeats,
      origDuration: hit.note.durationBeats,
      origPitch: hit.note.pitch,
      startClientX: e.clientX,
      startClientY: e.clientY,
    };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.draw();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const layer = this.activeLayer();
    if (!layer) return;
    const deltaBeats = (e.clientX - this.drag.startClientX) / this.pxPerBeat;
    const total = this.totalBeats();

    if (this.drag.mode === "resize") {
      this.drag.note.durationBeats = Math.min(
        total,
        Math.max(0.05, this.drag.origDuration + deltaBeats),
      );
    } else {
      let newStart = this.drag.origStartBeats + deltaBeats;
      newStart = ((newStart % total) + total) % total;
      this.drag.note.startBeats = newStart;

      if (layer.role !== "drums") {
        const deltaRows = Math.round((e.clientY - this.drag.startClientY) / ROW_HEIGHT);
        const newPitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.drag.origPitch - deltaRows));
        this.drag.note.pitch = this.pitchFilter(newPitch);
      }
    }
    this.draw();
  };

  private onPointerUp = (): void => {
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    if (this.drag) {
      this.drag = null;
      this.onChange();
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.deleteSelected();
    }
  };
}
