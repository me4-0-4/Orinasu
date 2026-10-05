import { quantizeBeat } from "../phrase/quantize";
import { sectionBeats, type MixLayer, type Section } from "./types";

export interface SongPlayerCallbacks {
  /** voiceKey は再生1回ごとに一意（同じ音がループで重なっても声を奪い合わないため）。 */
  playNote: (layer: MixLayer, note: MixLayer["notes"][number], time: number, voiceKey: string) => void;
  stopNote: (layer: MixLayer, note: MixLayer["notes"][number], time: number, voiceKey: string) => void;
  /** いまどのセクションの何拍目か（画面表示用）。 */
  onSection?: (index: number | null) => void;
  onEnd?: () => void;
}

const SCHEDULE_AHEAD_SECONDS = 0.12;
const TICK_MS = 25;

export type PlayMode = { kind: "loop"; index: number } | { kind: "song" };

/**
 * セクションを順に（またはひとつをループで）鳴らす。メトロノームもカウントインもなし。
 * 予約の仕方は Transport と同じ：先に1セクション分のイベントを計算して溜め、
 * 発音時刻の直前になったものだけ Web Audio に渡す。
 */
export class SongPlayer {
  private timer: number | null = null;
  private queue: { time: number; fire: () => void }[] = [];
  private nextTime = 0;
  private cursor = 0;
  private plays = 0;
  private sections: Section[] = [];
  private mode: PlayMode = { kind: "song" };
  private currentIndex: number | null = null;
  private currentStart = 0;
  private endTime = Infinity;
  /** 区間ごとの (開始時刻, セクション番号)。表示の更新に使う。 */
  private marks: { time: number; index: number }[] = [];
  private secondsPerBeat = 0.5;

  private readonly ctx: AudioContext;
  private readonly cb: SongPlayerCallbacks;

  constructor(ctx: AudioContext, cb: SongPlayerCallbacks) {
    this.ctx = ctx;
    this.cb = cb;
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  /** 再生中の位置（セクション内の拍）。画面表示用。 */
  position(): { index: number; beats: number } | null {
    if (this.currentIndex === null) return null;
    const beats = (this.ctx.currentTime - this.currentStart) / this.secondsPerBeat;
    return { index: this.currentIndex, beats: Math.max(0, beats) };
  }

  start(sections: Section[], mode: PlayMode): void {
    this.stop();
    this.sections = sections;
    this.mode = mode;
    if (sections.length === 0) return;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.cursor = mode.kind === "loop" ? mode.index : 0;
    this.plays = 0;
    this.queue = [];
    this.marks = [];
    this.endTime = Infinity;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
    this.marks = [];
    this.currentIndex = null;
    this.cb.onSection?.(null);
  }

  private tick(): void {
    const now = this.ctx.currentTime;

    // 次のセクションを、いまのセクションが鳴り終わる少し前に計算しておく
    while (this.endTime === Infinity && this.nextTime < now + 1.5) {
      const section = this.sections[this.cursor];
      if (!section) break;
      this.enqueue(section, this.cursor, this.nextTime);
      this.nextTime += (sectionBeats(section) * 60) / section.bpm;
      this.plays++;
      if (this.mode.kind === "song") {
        this.cursor++;
        if (this.cursor >= this.sections.length) this.endTime = this.nextTime;
      }
    }

    const horizon = now + SCHEDULE_AHEAD_SECONDS;
    const due: (() => void)[] = [];
    this.queue = this.queue.filter((ev) => {
      if (ev.time > horizon) return true;
      due.push(ev.fire);
      return false;
    });
    for (const fire of due) fire();

    while (this.marks.length > 0 && this.marks[0].time <= now) {
      const m = this.marks.shift()!;
      this.currentIndex = m.index;
      this.currentStart = m.time;
      this.cb.onSection?.(m.index);
    }

    if (now >= this.endTime) {
      this.stop();
      this.cb.onEnd?.();
    }
  }

  private enqueue(section: Section, index: number, start: number): void {
    this.secondsPerBeat = 60 / section.bpm;
    this.marks.push({ time: start, index });
    const total = sectionBeats(section);
    const hasSolo = section.layers.some((l) => l.solo);
    const run = this.plays;
    for (const layer of section.layers) {
      if (layer.muted || (hasSolo && !layer.solo)) continue;
      for (const note of layer.notes) {
        const raw = layer.quantizeGrid ? quantizeBeat(note.startBeats, layer.quantizeGrid) : note.startBeats;
        const wrapped = ((raw % total) + total) % total;
        const on = start + wrapped * this.secondsPerBeat;
        const off = on + note.durationBeats * this.secondsPerBeat;
        const key = `${run}:${note.id}`;
        this.queue.push({ time: on, fire: () => this.cb.playNote(layer, note, on, key) });
        this.queue.push({ time: off, fire: () => this.cb.stopNote(layer, note, off, key) });
      }
    }
  }
}
