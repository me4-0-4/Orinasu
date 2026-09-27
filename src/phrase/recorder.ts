import type { Transport } from "../audio/transport";
import { makeId, type Layer, type Note } from "./types";

interface PendingNote {
  startBeats: number;
  velocity: number;
}

/** ライブ演奏（画面鍵盤・PCキーボード・ドラムパッド）を、録音中のアクティブレイヤーへ書き込む。 */
export class Recorder {
  private pending = new Map<number, PendingNote>();
  private readonly transport: Transport;
  private readonly getActiveLayer: () => Layer | null;

  constructor(transport: Transport, getActiveLayer: () => Layer | null) {
    this.transport = transport;
    this.getActiveLayer = getActiveLayer;
  }

  noteOn(pitch: number, velocity = 1): void {
    if (!this.transport.recording) return;
    const pos = this.transport.currentPositionBeats();
    if (pos === null) return;
    this.pending.set(pitch, { startBeats: pos, velocity });
  }

  noteOff(pitch: number): void {
    if (!this.transport.recording) return;
    const start = this.pending.get(pitch);
    if (!start) return;
    this.pending.delete(pitch);

    const layer = this.getActiveLayer();
    if (!layer) return;

    const pos = this.transport.currentPositionBeats();
    const total = this.transport.totalBeats;
    let duration = (pos ?? start.startBeats) - start.startBeats;
    if (duration <= 0) duration += total;
    if (duration <= 0) duration = 0.05;

    layer.notes.push(this.makeNote(pitch, start.velocity, start.startBeats, duration));
  }

  /** ドラムパッドのような、押した瞬間だけの単発ヒットを記録する。 */
  hit(pitch: number, velocity = 1, durationBeats = 0.1): void {
    if (!this.transport.recording) return;
    const pos = this.transport.currentPositionBeats();
    if (pos === null) return;
    const layer = this.getActiveLayer();
    if (!layer) return;
    layer.notes.push(this.makeNote(pitch, velocity, pos, durationBeats));
  }

  private makeNote(pitch: number, velocity: number, startBeats: number, durationBeats: number): Note {
    return { id: makeId("note"), pitch, velocity, startBeats, durationBeats };
  }
}
