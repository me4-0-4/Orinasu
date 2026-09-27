import { quantizeBeat } from "../phrase/quantize";
import type { Layer, Note, Phrase } from "../phrase/types";

const PITCH_MIN = 33; // A1
const PITCH_MAX = 96; // C7
const ROW_HEIGHT = 14;
const HEADER_HEIGHT = 20;

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
  private phrase: Phrase | null = null;
  private activeLayerId: string | null = null;
  private selectedNoteId: string | null = null;
  private playheadBeats: number | null = null;
  private drag: DragState | null = null;
  private pxPerBeat = 40;

  onChange: () => void = () => {};

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "piano-roll";

    this.scrollWrap = document.createElement("div");
    this.scrollWrap.className = "piano-roll-scroll";

    this.canvas = document.createElement("canvas");
    this.canvas.className = "piano-roll-canvas";
    this.canvas.tabIndex = 0;

    this.scrollWrap.appendChild(this.canvas);
    this.el.appendChild(this.scrollWrap);

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
    this.selectedNoteId = null;
    this.draw();
    this.onChange();
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
    return Math.max(rect.width, this.totalBeats() * this.pxPerBeat);
  }

  private pitchToY(pitch: number): number {
    return HEADER_HEIGHT + (PITCH_MAX - pitch) * ROW_HEIGHT;
  }

  private yToPitch(y: number): number {
    return PITCH_MAX - Math.floor((y - HEADER_HEIGHT) / ROW_HEIGHT);
  }

  private beatToX(beat: number): number {
    return beat * this.pxPerBeat;
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

    // 白鍵/黒鍵の背景
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
      const isBlack = [1, 3, 6, 8, 10].includes(p % 12);
      if (isBlack) {
        ctx.fillStyle = "#101014";
        ctx.fillRect(0, this.pitchToY(p), width, ROW_HEIGHT);
      }
    }

    // 他レイヤー（参考表示・編集不可）
    if (this.phrase) {
      for (const l of this.phrase.layers) {
        if (l.id === this.activeLayerId) continue;
        for (const note of l.notes) {
          this.drawNote(ctx, l, note, "#5eb4ff33", "#5eb4ff55");
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

  private drawNote(
    ctx: CanvasRenderingContext2D,
    layer: Layer,
    note: Note,
    fill: string,
    stroke: string,
  ): void {
    const total = this.totalBeats();
    const effectiveStart = layer.quantizeGrid
      ? quantizeBeat(note.startBeats, layer.quantizeGrid)
      : note.startBeats;
    const wrapped = ((effectiveStart % total) + total) % total;
    const x = this.beatToX(wrapped);
    const w = Math.max(4, this.beatToX(note.durationBeats));
    const y = this.pitchToY(note.pitch);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y + 1, w, ROW_HEIGHT - 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 1.5, w - 1, ROW_HEIGHT - 3);
  }

  private noteAt(x: number, y: number): { note: Note; nearRightEdge: boolean } | null {
    const layer = this.activeLayer();
    if (!layer) return null;
    const pitch = this.yToPitch(y);
    const total = this.totalBeats();
    for (let i = layer.notes.length - 1; i >= 0; i--) {
      const note = layer.notes[i];
      if (note.pitch !== pitch) continue;
      const effectiveStart = layer.quantizeGrid
        ? quantizeBeat(note.startBeats, layer.quantizeGrid)
        : note.startBeats;
      const wrapped = ((effectiveStart % total) + total) % total;
      const startX = this.beatToX(wrapped);
      const endX = startX + Math.max(4, this.beatToX(note.durationBeats));
      if (x >= startX && x <= endX) {
        return { note, nearRightEdge: endX - x < 6 };
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
      this.selectedNoteId = null;
      this.draw();
      return;
    }
    this.selectedNoteId = hit.note.id;
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
      this.drag.note.durationBeats = Math.max(0.05, this.drag.origDuration + deltaBeats);
    } else {
      let newStart = this.drag.origStartBeats + deltaBeats;
      newStart = ((newStart % total) + total) % total;
      this.drag.note.startBeats = newStart;

      if (layer.role !== "drums") {
        const deltaRows = Math.round((e.clientY - this.drag.startClientY) / ROW_HEIGHT);
        const newPitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.drag.origPitch - deltaRows));
        this.drag.note.pitch = newPitch;
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
