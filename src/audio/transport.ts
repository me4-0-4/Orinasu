import { Metronome } from "./metronome";
import { quantizeBeat } from "../phrase/quantize";
import type { Layer, Note, Phrase } from "../phrase/types";

export type TransportState = "stopped" | "count-in" | "running";

export interface TransportCallbacks {
  getPhrase: () => Phrase | null;
  playNote: (layer: Layer, note: Note, time: number) => void;
  stopNote: (layer: Layer, note: Note, time: number) => void;
  onStateChange?: (state: TransportState) => void;
  onIteration?: (iteration: number) => void;
}

const SCHEDULE_AHEAD_SECONDS = 0.12;
const TICK_MS = 25;
const COUNT_IN_BARS = 1;

export class Transport {
  readonly metronome: Metronome;
  state: TransportState = "stopped";
  recording = false;

  private bpm = 120;
  private beatsPerBar = 4;
  private lengthBars = 1;
  private secondsPerBeat = 0.5;
  private loopDurationSeconds = 2;
  private totalBeatsCache = 4;

  private loopStartTime = 0;
  private nextBoundary = 0;
  private iterationCounter = 0;
  private schedulerTimer: number | null = null;
  private stateTimer: number | null = null;
  // 1小節分の全イベント（ノートon/off・メトロノーム）を境界の少し前にまとめて計算はするが、
  // Web Audio側への実際のスケジュール呼び出し（noteOn等）は、ここに一旦積んでおき、
  // 実際の発音時刻がSCHEDULE_AHEAD_SECONDS以内に近づいたtickでのみ順次発火させる。
  // 小節が長い（1周が数秒に及ぶ）場合に、境界1回分の全ノートを数秒先まで一気に
  // Web Audio APIへ積んでしまうと、ブラウザによっては後半のノートが再生されない
  // 不具合が起きうるため（特にSafari実機で「最初の一音しか鳴らない」報告あり）。
  private eventQueue: { time: number; fire: () => void }[] = [];

  private readonly ctx: AudioContext;
  private readonly callbacks: TransportCallbacks;

  constructor(ctx: AudioContext, metronomeOut: AudioNode, callbacks: TransportCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.metronome = new Metronome(ctx, metronomeOut);
  }

  get totalBeats(): number {
    return this.totalBeatsCache;
  }

  start(withRecording: boolean): void {
    this.stop();
    const phrase = this.callbacks.getPhrase();
    if (!phrase) return;

    this.bpm = phrase.bpm;
    this.beatsPerBar = phrase.beatsPerBar;
    this.lengthBars = phrase.lengthBars;
    this.secondsPerBeat = 60 / this.bpm;
    this.totalBeatsCache = this.lengthBars * this.beatsPerBar;
    this.loopDurationSeconds = this.totalBeatsCache * this.secondsPerBeat;
    this.recording = withRecording;

    const startAt = this.ctx.currentTime + 0.05;
    const countInSeconds = COUNT_IN_BARS * this.beatsPerBar * this.secondsPerBeat;
    this.loopStartTime = startAt + countInSeconds;
    this.nextBoundary = this.loopStartTime;
    this.iterationCounter = 0;
    this.eventQueue = [];

    for (let b = 0; b < this.beatsPerBar; b++) {
      this.metronome.click(startAt + b * this.secondsPerBeat, b === 0);
    }

    this.state = "count-in";
    this.callbacks.onStateChange?.(this.state);

    this.stateTimer = window.setTimeout(
      () => {
        this.state = "running";
        this.callbacks.onStateChange?.(this.state);
      },
      (this.loopStartTime - this.ctx.currentTime) * 1000,
    );

    this.schedulerTimer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.stateTimer !== null) {
      window.clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    this.recording = false;
    this.eventQueue = [];
    if (this.state !== "stopped") {
      this.state = "stopped";
      this.callbacks.onStateChange?.(this.state);
    }
  }

  /** 現在のループ内の拍位置（0〜totalBeats）。カウントイン中や停止中はnull。 */
  currentPositionBeats(): number | null {
    if (this.state !== "running") return null;
    const elapsed = this.ctx.currentTime - this.loopStartTime;
    if (elapsed < 0) return null;
    const beats = elapsed / this.secondsPerBeat;
    return ((beats % this.totalBeatsCache) + this.totalBeatsCache) % this.totalBeatsCache;
  }

  currentIteration(): number {
    const elapsed = this.ctx.currentTime - this.loopStartTime;
    if (elapsed < 0) return -1;
    return Math.floor(elapsed / this.loopDurationSeconds);
  }

  private tick(): void {
    // イベントの「計算」自体は小節の少し前にまとめて行ってよい（Web Audioへの発火はまだしない）。
    while (this.nextBoundary < this.ctx.currentTime + this.loopDurationSeconds) {
      this.enqueueIteration(this.nextBoundary);
      this.callbacks.onIteration?.(this.iterationCounter);
      this.nextBoundary += this.loopDurationSeconds;
      this.iterationCounter++;
    }

    // 実際にWeb Audioへスケジュール（oscillator.start等）するのは、発音時刻が
    // 目前（SCHEDULE_AHEAD_SECONDS以内）に近づいたものだけに限る。
    const horizon = this.ctx.currentTime + SCHEDULE_AHEAD_SECONDS;
    const due: (() => void)[] = [];
    this.eventQueue = this.eventQueue.filter((ev) => {
      if (ev.time > horizon) return true;
      due.push(ev.fire);
      return false;
    });
    for (const fire of due) fire();
  }

  private enqueueIteration(boundaryTime: number): void {
    for (let b = 0; b < this.totalBeatsCache; b++) {
      const time = boundaryTime + b * this.secondsPerBeat;
      const isDownbeat = b % this.beatsPerBar === 0;
      this.eventQueue.push({ time, fire: () => this.metronome.click(time, isDownbeat) });
    }

    const phrase = this.callbacks.getPhrase();
    if (!phrase) return;
    const hasSolo = phrase.layers.some((l) => l.solo);

    for (const layer of phrase.layers) {
      if (layer.muted) continue;
      if (hasSolo && !layer.solo) continue;

      for (const note of layer.notes) {
        const rawStart = layer.quantizeGrid
          ? quantizeBeat(note.startBeats, layer.quantizeGrid)
          : note.startBeats;
        const wrapped =
          ((rawStart % this.totalBeatsCache) + this.totalBeatsCache) % this.totalBeatsCache;
        const onTime = boundaryTime + wrapped * this.secondsPerBeat;
        const offTime = onTime + note.durationBeats * this.secondsPerBeat;
        this.eventQueue.push({ time: onTime, fire: () => this.callbacks.playNote(layer, note, onTime) });
        this.eventQueue.push({ time: offTime, fire: () => this.callbacks.stopNote(layer, note, offTime) });
      }
    }
  }
}
