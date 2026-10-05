import { quantizeBeat } from "../phrase/quantize";
import { sectionBeats, type MixLayer, type Section } from "./types";
import {
  energyAt,
  filterOffsetCents,
  getMacro,
  layerAudible,
  macroValue,
  noteKept,
  hash01,
  type EnergyCurve,
  type Macro,
} from "./energy";

export interface SongPlayerCallbacks {
  /** voiceKey は再生1回ごとに一意（同じ音がループで重なっても声を奪い合わないため）。 */
  playNote: (layer: MixLayer, note: MixLayer["notes"][number], time: number, voiceKey: string) => void;
  stopNote: (layer: MixLayer, note: MixLayer["notes"][number], time: number, voiceKey: string) => void;
  /** いまどのセクションの何拍目か（画面表示用）。 */
  onSection?: (index: number | null) => void;
  /** 盛り上がりマクロ「フィルターの開き」が動かす量（セント）。マクロを使わないときは0。 */
  onFilterOffset?: (cents: number) => void;
  onEnd?: () => void;
}

/** 曲を通して鳴らすときに、盛り上がりの線とマクロを反映する。 */
export interface Shaping {
  curve: EnergyCurve;
  macros: Macro[];
}

const FILL_SNARE = 38;
const FILL_TOM = 45;

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
  private shaping: Shaping | null = null;
  private songStart = 0;
  private songSeconds = 1;
  /** セクションごとの、曲の頭からの開始秒。 */
  private sectionOffsets: number[] = [];

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

  /** 曲を通して鳴らしているときの、線の上の位置（0〜1）。それ以外はnull。 */
  progress(): number | null {
    if (!this.shaping || this.timer === null) return null;
    const t = (this.ctx.currentTime - this.songStart) / this.songSeconds;
    return t < 0 ? 0 : Math.min(1, t);
  }

  start(sections: Section[], mode: PlayMode, shaping?: Shaping): void {
    this.stop();
    this.sections = sections;
    this.mode = mode;
    if (sections.length === 0) return;
    this.shaping = mode.kind === "song" && shaping ? shaping : null;
    this.sectionOffsets = [];
    let acc = 0;
    for (const sec of sections) {
      this.sectionOffsets.push(acc);
      acc += (sectionBeats(sec) * 60) / sec.bpm;
    }
    this.songSeconds = Math.max(acc, 0.001);
    this.nextTime = this.ctx.currentTime + 0.08;
    this.songStart = this.nextTime;
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
    this.shaping = null;
    this.cb.onFilterOffset?.(0);
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

    const filter = this.shaping && getMacro(this.shaping.macros, "filter");
    if (this.shaping && filter) {
      const t = (now + 0.1 - this.songStart) / this.songSeconds;
      const e = energyAt(this.shaping.curve, Math.min(1, Math.max(0, t)));
      this.cb.onFilterOffset?.(filterOffsetCents(macroValue(filter, e)));
    }

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

  /** 小節 bar の真ん中の、線の高さ。 */
  private energyForBar(sectionIndex: number, bar: number, section: Section): number {
    if (!this.shaping) return 1;
    const barSeconds = (section.beatsPerBar * 60) / section.bpm;
    const sec = this.sectionOffsets[sectionIndex] + (bar + 0.5) * barSeconds;
    return energyAt(this.shaping.curve, Math.min(1, sec / this.songSeconds));
  }

  private enqueue(section: Section, index: number, start: number): void {
    this.secondsPerBeat = 60 / section.bpm;
    this.marks.push({ time: start, index });
    const total = sectionBeats(section);
    const bpb = section.beatsPerBar;
    const hasSolo = section.layers.some((l) => l.solo);
    const run = this.plays;
    const shaping = this.shaping;
    const layersMacro = shaping && getMacro(shaping.macros, "layers");
    const densityMacro = shaping && getMacro(shaping.macros, "density");
    const fillMacro = shaping && getMacro(shaping.macros, "fill");
    const audible = section.layers.filter((l) => !l.muted && (!hasSolo || l.solo));
    const roles = audible.map((l) => l.role);

    // 小節ごとの盛り上がり度（段階的な変化は小節の頭で切り替わる）
    const bars = Math.max(1, Math.round(total / bpb));
    const barEnergy = Array.from({ length: bars }, (_, b) => this.energyForBar(index, b, section));

    for (const layer of audible) {
      for (const note of layer.notes) {
        const raw = layer.quantizeGrid ? quantizeBeat(note.startBeats, layer.quantizeGrid) : note.startBeats;
        const wrapped = ((raw % total) + total) % total;
        const bar = Math.min(bars - 1, Math.floor(wrapped / bpb));
        const e = barEnergy[bar];
        if (layersMacro && !layerAudible(layer.role, roles, macroValue(layersMacro, e))) continue;
        if (densityMacro) {
          const onDownbeat = Math.abs(wrapped - bar * bpb) < 1e-6;
          if (!noteKept(note.id, onDownbeat, macroValue(densityMacro, e))) continue;
        }
        const on = start + wrapped * this.secondsPerBeat;
        const off = on + note.durationBeats * this.secondsPerBeat;
        const key = `${run}:${note.id}`;
        this.queue.push({ time: on, fire: () => this.cb.playNote(layer, note, on, key) });
        this.queue.push({ time: off, fire: () => this.cb.stopNote(layer, note, off, key) });
      }
    }

    // フィルイン：4小節ごとの区切りと、セクションの最後の小節の終わりに入れる
    const drums = audible.find((l) => l.role === "drums");
    if (fillMacro && drums) {
      for (let bar = 0; bar < bars; bar++) {
        const isEnd = bar === bars - 1 || (bar + 1) % 4 === 0;
        if (!isEnd) continue;
        const e = barEnergy[bar];
        if (layersMacro && !layerAudible("drums", roles, macroValue(layersMacro, e))) continue;
        if (hash01(`${section.id}:fill:${bar}`) >= macroValue(fillMacro, e)) continue;
        for (let i = 0; i < 4; i++) {
          const beat = bar * bpb + bpb - 1 + i * 0.25;
          const note = {
            id: `fill:${section.id}:${bar}:${i}`,
            pitch: i === 3 ? FILL_TOM : FILL_SNARE,
            velocity: 0.55 + i * 0.12,
            startBeats: beat,
            durationBeats: 0.2,
          };
          const on = start + beat * this.secondsPerBeat;
          const key = `${run}:${note.id}`;
          this.queue.push({ time: on, fire: () => this.cb.playNote(drums, note, on, key) });
        }
      }
    }
  }
}
