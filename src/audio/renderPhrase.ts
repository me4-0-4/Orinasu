import { AudioBuses, createNoiseBuffer } from "./context";
import { DrumMachine, noteNumberToDrum } from "./drums";
import { DEFAULT_VOLUME, LayerSynths } from "./layerSynths";
import { quantizeBeat } from "../phrase/quantize";
import { totalBeats, type Phrase } from "../phrase/types";
import type { Pcm } from "../mix/audioChop";

/** リバーブ・ディレイの余韻を取っておく長さ（秒）。余韻は曲の頭に重ねて、繰り返してもつながるようにする。 */
const TAIL_SECONDS = 2.5;

/**
 * フレーズ（1曲）を、指定のBPMで1周ぶんの波形に書き出す。
 * 層（ドラム・ベース…）は、ここで1本に混ぜてしまう。刻むときは、この波形だけを扱う。
 */
export async function renderPhrase(phrase: Phrase, bpm: number, sampleRate: number): Promise<Pcm> {
  const secondsPerBeat = 60 / bpm;
  const loopFrames = Math.max(1, Math.round(totalBeats(phrase) * secondsPerBeat * sampleRate));
  const totalFrames = loopFrames + Math.ceil(TAIL_SECONDS * sampleRate);
  const ctx = new OfflineAudioContext(2, totalFrames, sampleRate);

  const master = ctx.createGain();
  master.gain.value = 0.8; // ライブの出力と同じ音量
  master.connect(ctx.destination);
  const buses = new AudioBuses(ctx, master);
  const synths = new LayerSynths({
    ctx,
    synthDry: buses.synthDry,
    synthReverbSend: buses.synthReverbSend,
    synthDelaySend: buses.synthDelaySend,
    drumOut: buses.drumOut,
  });
  const drums = new DrumMachine(ctx, createNoiseBuffer(ctx), buses.drumOut);

  // 元のフレーズは触らない（シンセの初期音色を層に入れるため、複製して使う）
  const layers = structuredClone(phrase.layers);
  const hasSolo = layers.some((l) => l.solo);
  for (const layer of layers) {
    if (layer.muted || (hasSolo && !layer.solo)) continue;
    for (const note of layer.notes) {
      const beat = layer.quantizeGrid ? quantizeBeat(note.startBeats, layer.quantizeGrid) : note.startBeats;
      const start = beat * secondsPerBeat;
      if (layer.role === "drums") {
        const id = noteNumberToDrum[note.pitch];
        if (id) drums.trigger(id, note.velocity * (layer.volume ?? DEFAULT_VOLUME), start, synths.drumOut(layer));
      } else {
        const engine = synths.forLayer(layer);
        engine.noteOn(`r:${note.id}`, note.pitch, note.velocity, start);
        engine.noteOff(`r:${note.id}`, false, start + Math.max(0.02, note.durationBeats * secondsPerBeat));
      }
    }
  }

  const rendered = await ctx.startRendering();
  const out: Pcm = { l: new Float32Array(loopFrames), r: new Float32Array(loopFrames) };
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);
  for (let i = 0; i < loopFrames; i++) {
    out.l[i] = left[i];
    out.r[i] = right[i];
  }
  // 余韻を曲の頭に重ねる（繰り返したとき、つなぎ目で余韻が途切れない）
  for (let i = 0; i < totalFrames - loopFrames && i < loopFrames; i++) {
    out.l[i] += left[loopFrames + i];
    out.r[i] += right[loopFrames + i];
  }
  return out;
}
