interface KeyGeometry {
  note: number;
  isBlack: boolean;
  x: number;
  width: number;
}

/** 鍵盤上の案内表示（コードの構成音・ベースのルートなど）。ピッチクラス（0-11）で指定する。 */
export interface KeyboardGuide {
  chordTones: Set<number>;
  root: number | null;
  /** ベースで弾く候補（ルートと5度）。 */
  bassTones: Set<number>;
}

const WHITE_PATTERN = [0, 2, 4, 5, 7, 9, 11]; // オクターブ内の白鍵オフセット
const BLACK_PATTERN = [1, 3, 6, 8, 10]; // オクターブ内の黒鍵オフセット

export class PianoKeyboard {
  readonly el: HTMLCanvasElement;
  private startNote: number;
  private octaves: number;
  private keys: KeyGeometry[] = [];
  private activeNotes = new Set<number>();
  private pointerNotes = new Map<number, number>();
  private keyLabels = new Map<number, string>();
  private scalePcs: Set<number> | null = null;
  private guide: KeyboardGuide | null = null;
  private height = 100;

  onNoteOn: (note: number) => void = () => {};
  onNoteOff: (note: number) => void = () => {};

  constructor(startNote: number, octaves: number) {
    this.startNote = startNote;
    this.octaves = octaves;
    this.el = document.createElement("canvas");
    this.el.className = "piano-keyboard";
    this.el.style.touchAction = "none";

    this.el.addEventListener("pointerdown", this.onPointerDown);
    this.el.addEventListener("pointermove", this.onPointerMove);
    this.el.addEventListener("pointerup", this.onPointerUp);
    this.el.addEventListener("pointercancel", this.onPointerUp);
    this.el.addEventListener("pointerleave", this.onPointerUp);

    // コンストラクタの時点ではまだDOMに追加されておらずサイズが取れないため、
    // 実際に表示サイズが確定した瞬間（DOM追加時・リサイズ時）に再計算する。
    new ResizeObserver(() => this.layout()).observe(this.el);
    this.layout();
  }

  setStartNote(note: number): void {
    this.releaseAllPointers();
    this.startNote = note;
    this.layout();
  }

  setActiveNotes(notes: Set<number>): void {
    this.activeNotes = notes;
    this.draw();
  }

  /** PCキーボードのどのキーがどの音に対応するかを鍵盤上に表示する（音名→キー文字）。 */
  setKeyLabels(labels: Map<number, string>): void {
    this.keyLabels = labels;
    this.draw();
  }

  /** スケールロック中などに、スケール外の鍵盤を暗く表示する。null で解除。 */
  setScale(pcs: Set<number> | null): void {
    this.scalePcs = pcs;
    this.draw();
  }

  /** コードの構成音・ルートを光らせる。null で解除。 */
  setGuide(guide: KeyboardGuide | null): void {
    this.guide = guide;
    this.draw();
  }

  private guideColor(note: number, isBlack: boolean): string | null {
    const g = this.guide;
    if (!g) return null;
    const pc = ((note % 12) + 12) % 12;
    if (g.root === pc) return isBlack ? "#3c8fd9" : "#5eb4ff";
    if (g.chordTones.has(pc)) return isBlack ? "#c9a13f" : "#ffd166";
    return null;
  }

  private layout(): void {
    const rect = this.el.getBoundingClientRect();
    const width = Math.max(rect.width, 280);
    const dpr = window.devicePixelRatio || 1;
    this.el.width = width * dpr;
    this.el.height = this.height * dpr;
    this.el.style.height = `${this.height}px`;

    const ctx = this.el.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const whiteCount = this.octaves * 7 + 1;
    const whiteWidth = width / whiteCount;

    this.keys = [];
    let whiteIndex = 0;
    for (let o = 0; o < this.octaves; o++) {
      for (const offset of WHITE_PATTERN) {
        this.keys.push({
          note: this.startNote + o * 12 + offset,
          isBlack: false,
          x: whiteIndex * whiteWidth,
          width: whiteWidth,
        });
        whiteIndex++;
      }
    }
    // 最後のC
    this.keys.push({
      note: this.startNote + this.octaves * 12,
      isBlack: false,
      x: whiteIndex * whiteWidth,
      width: whiteWidth,
    });

    const blackWidth = whiteWidth * 0.62;
    whiteIndex = 0;
    for (let o = 0; o < this.octaves; o++) {
      for (const offset of BLACK_PATTERN) {
        const whiteOffsetIndex = WHITE_PATTERN.findIndex((w) => w > offset);
        const precedingWhiteIndex = o * 7 + (whiteOffsetIndex === -1 ? 7 : whiteOffsetIndex) - 1;
        this.keys.push({
          note: this.startNote + o * 12 + offset,
          isBlack: true,
          x: (precedingWhiteIndex + 1) * whiteWidth - blackWidth / 2,
          width: blackWidth,
        });
      }
      whiteIndex += 7;
    }

    this.draw();
  }

  private draw(): void {
    const ctx = this.el.getContext("2d")!;
    const rect = this.el.getBoundingClientRect();
    const width = Math.max(rect.width, 280);
    ctx.clearRect(0, 0, width, this.height);

    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";

    for (const key of this.keys) {
      if (key.isBlack) continue;
      const active = this.activeNotes.has(key.note);
      ctx.fillStyle = active ? "#3ee6b0" : (this.guideColor(key.note, false) ?? "#e9e9ee");
      ctx.strokeStyle = "#15161c";
      ctx.lineWidth = 1;
      ctx.fillRect(key.x, 0, key.width, this.height);
      ctx.strokeRect(key.x, 0, key.width, this.height);
      if (!active && this.isOutOfScale(key.note)) {
        ctx.fillStyle = "rgba(20, 22, 30, 0.42)";
        ctx.fillRect(key.x, 0, key.width, this.height);
      }
      if (this.guide?.bassTones.has(((key.note % 12) + 12) % 12)) {
        ctx.fillStyle = "#3c8fd9";
        ctx.fillRect(key.x + key.width / 2 - 3, this.height - 24, 6, 6);
      }

      const label = this.keyLabels.get(key.note);
      if (label) {
        ctx.fillStyle = "#15161c";
        ctx.fillText(label, key.x + key.width / 2, this.height - 10);
      }
    }
    for (const key of this.keys) {
      if (!key.isBlack) continue;
      const active = this.activeNotes.has(key.note);
      ctx.fillStyle = active ? "#2bbd8f" : (this.guideColor(key.note, true) ?? "#101014");
      const blackHeight = this.height * 0.62;
      ctx.fillRect(key.x, 0, key.width, blackHeight);
      if (!active && this.isOutOfScale(key.note)) {
        ctx.fillStyle = "rgba(233, 233, 238, 0.18)";
        ctx.fillRect(key.x, 0, key.width, blackHeight);
      }
      if (this.guide?.bassTones.has(((key.note % 12) + 12) % 12)) {
        ctx.fillStyle = "#5eb4ff";
        ctx.fillRect(key.x + key.width / 2 - 3, blackHeight - 22, 6, 6);
      }

      const label = this.keyLabels.get(key.note);
      if (label) {
        ctx.fillStyle = "#e9e9ee";
        ctx.fillText(label, key.x + key.width / 2, blackHeight - 8);
      }
    }
  }

  private isOutOfScale(note: number): boolean {
    return this.scalePcs !== null && !this.scalePcs.has(((note % 12) + 12) % 12);
  }

  private noteAt(x: number, y: number): number | null {
    const blackHeight = this.height * 0.62;
    if (y < blackHeight) {
      for (let i = this.keys.length - 1; i >= 0; i--) {
        const key = this.keys[i];
        if (key.isBlack && x >= key.x && x <= key.x + key.width) return key.note;
      }
    }
    for (const key of this.keys) {
      if (!key.isBlack && x >= key.x && x <= key.x + key.width) return key.note;
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    const rect = this.el.getBoundingClientRect();
    const note = this.noteAt(e.clientX - rect.left, e.clientY - rect.top);
    if (note === null) return;
    this.el.setPointerCapture(e.pointerId);
    this.pointerNotes.set(e.pointerId, note);
    this.onNoteOn(note);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointerNotes.has(e.pointerId)) return;
    const rect = this.el.getBoundingClientRect();
    const note = this.noteAt(e.clientX - rect.left, e.clientY - rect.top);
    const prev = this.pointerNotes.get(e.pointerId)!;
    if (note !== null && note !== prev) {
      this.onNoteOff(prev);
      this.pointerNotes.set(e.pointerId, note);
      this.onNoteOn(note);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const note = this.pointerNotes.get(e.pointerId);
    if (note !== undefined) {
      this.onNoteOff(note);
      this.pointerNotes.delete(e.pointerId);
    }
  };

  private releaseAllPointers(): void {
    for (const note of this.pointerNotes.values()) {
      this.onNoteOff(note);
    }
    this.pointerNotes.clear();
  }
}
