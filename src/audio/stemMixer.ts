import { CHANNEL_FADERS, type StemSet } from "../mix/collageSong";
import { liveReverbChain } from "../mix/fx";
import workletUrl from "./masterBusWorklet.ts?worker&url";
import { reverbImpulse } from "./reverbWet";

/** ステムの波形を、AudioBuffer にしたもの（同じ波形は使い回す。ミュートなどで作り直しても、コピーし直さない）。 */
const bufferCache = new WeakMap<object, AudioBuffer>();

function bufferOf(pcm: { l: Float32Array; r: Float32Array }, sampleRate: number): AudioBuffer {
  let buffer = bufferCache.get(pcm);
  if (!buffer || buffer.sampleRate !== sampleRate || buffer.length !== pcm.l.length) {
    buffer = new AudioBuffer({ numberOfChannels: 2, length: pcm.l.length, sampleRate });
    buffer.copyToChannel(pcm.l as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(pcm.r as Float32Array<ArrayBuffer>, 1);
    bufferCache.set(pcm, buffer);
  }
  return buffer;
}

const loadedWorklets = new WeakSet<object>();

/** マスター用の AudioWorklet を読み込む（コンテキストごとに1回）。使えなければ false。 */
export async function loadMasterWorklet(ctx: BaseAudioContext): Promise<boolean> {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
  if (loadedWorklets.has(ctx)) return true;
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    loadedWorklets.add(ctx);
    return true;
  } catch (err) {
    console.error("マスター処理（AudioWorklet）を読み込めませんでした", err);
    return false;
  }
}

/** ミキサーの1回ぶんの配線（再生を始めるたびに作る）。 */
export interface MixerGraph {
  /** when（コンテキストの時刻）から、曲の offsetSeconds の位置を鳴らし始める。 */
  start(when: number, offsetSeconds: number): void;
  stop(when?: number): void;
  /** フェーダー（層の曲の id、または @bed・@pad・@sfx）を動かす。プチ音が出ないよう、短くなめらかに。 */
  setFader(name: string, value: number, smooth?: boolean): void;
  dispose(): void;
}

/**
 * ステムごとに「ループ再生 → 層のフェーダー」→ 足す → 全体のリバーブ → マスターのコンプ＋リミッター → out、と配線する。
 * 全体のリバーブは、曲の頭に余韻を重ねる書き出しと同じ音になる（ループなので、余韻は自然に頭へ続く）。
 * 呼ぶ前に loadMasterWorklet が true で、liveReverbChain(set.masterFx) が null でないこと。
 */
export function buildMixerGraph(ctx: BaseAudioContext, set: StemSet, out: AudioNode, faders: Record<string, number> = set.faders): MixerGraph {
  const chain = liveReverbChain(set.masterFx);
  if (!chain) throw new Error("マスターのエフェクトが、リアルタイムでは掛けられない形です");
  const sampleRate = ctx.sampleRate;
  const bus = ctx.createGain();
  /** フェーダーの名前（層の曲の id、@bed・@pad・@sfx）ごとの音量ノード。 */
  const gains = new Map<string, GainNode>();
  const faderNode = (name: string, to: AudioNode): GainNode => {
    let g = gains.get(name);
    if (!g) {
      g = ctx.createGain();
      g.gain.value = faders[name] ?? 1;
      g.connect(to);
      gains.set(name, g);
    }
    return g;
  };
  const sources: AudioBufferSourceNode[] = [];
  for (const stem of set.stems) {
    const src = ctx.createBufferSource();
    src.buffer = bufferOf(stem.pcm, sampleRate);
    src.loop = true;
    // ステム → チャンネルのフェーダー → 層のフェーダー → 足す、の順（どちらも掛け算なので、順番で音は変わらない）
    const lane = stem.phraseId !== undefined ? faderNode(stem.phraseId, bus) : bus;
    const target = stem.channel ? faderNode(CHANNEL_FADERS[stem.channel], lane) : lane;
    src.connect(target);
    sources.push(src);
  }
  // 全体のリバーブ（直接音＋送った音の響き。書き出しの applyTrack と同じ式）
  let node: AudioNode = bus;
  const owned: AudioNode[] = [bus];
  for (const rv of chain) {
    const stageOut = ctx.createGain();
    const send = ctx.createGain();
    send.gain.value = rv.send;
    const conv = ctx.createConvolver();
    conv.buffer = reverbImpulse(ctx, rv.seconds, rv.toneHz);
    node.connect(stageOut);
    node.connect(send);
    send.connect(conv);
    conv.connect(stageOut);
    owned.push(stageOut, send, conv);
    node = stageOut;
  }
  const master = new AudioWorkletNode(ctx, "orinasu-master-bus", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
  });
  node.connect(master);
  master.connect(out);
  owned.push(master);

  let started = false;
  return {
    start(when, offsetSeconds) {
      for (const s of sources) s.start(when, offsetSeconds);
      started = true;
    },
    stop(when) {
      if (!started) return;
      for (const s of sources) {
        try {
          s.stop(when);
        } catch {
          // すでに止まっている
        }
      }
    },
    setFader(name, value, smooth = true) {
      const g = gains.get(name);
      if (!g) return;
      if (smooth) g.gain.setTargetAtTime(value, ctx.currentTime, 0.008);
      else g.gain.value = value;
    },
    dispose() {
      for (const s of sources) s.disconnect();
      for (const g of gains.values()) g.disconnect();
      for (const n of owned) n.disconnect();
    },
  };
}

/**
 * 再生側のミキサー（DAW のミキサーと同じ考え方）。ステムをそれぞれ鳴らし、ミュート・音量はフェーダーを動かすだけ（作り直さない）。
 * LoopPlayer と同じ使い方：play / stop / progress / playing。
 */
export class StemMixer {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  private set: StemSet | null = null;
  private faders: Record<string, number> = {};
  private graph: MixerGraph | null = null;
  private startedAt = 0;
  private duration = 0;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = out;
  }

  get playing(): boolean {
    return this.graph !== null;
  }

  /** ステムを渡す。この曲をリアルタイムで鳴らせるなら true（マスターがリバーブだけ、AudioWorklet が使える）。false なら、呼び出し側が書き出しと同じミックスダウンを鳴らす。 */
  async load(set: StemSet, faders: Record<string, number> = set.faders): Promise<boolean> {
    if (!(await loadMasterWorklet(this.ctx)) || liveReverbChain(set.masterFx) === null) {
      this.set = null;
      return false;
    }
    this.set = set;
    this.faders = { ...faders };
    return true;
  }

  /** startFraction：曲のどこから鳴らすか（0〜1）。 */
  play(startFraction = 0): void {
    this.replaceGraph(startFraction);
  }

  private replaceGraph(startFraction: number): void {
    const set = this.set;
    if (!set || set.stems.length === 0) return;
    const old = this.graph;
    const graph = buildMixerGraph(this.ctx, set, this.out, this.faders);
    const frames = set.stems[0].pcm.l.length;
    this.duration = frames / set.sampleRate;
    const offset = Math.min(0.999, Math.max(0, startFraction)) * this.duration;
    const when = this.ctx.currentTime;
    this.startedAt = when - offset;
    graph.start(when, offset);
    this.graph = graph;
    if (old) {
      old.stop(when);
      window.setTimeout(() => old.dispose(), 200);
    }
  }

  stop(): void {
    const g = this.graph;
    if (!g) return;
    this.graph = null;
    g.stop();
    window.setTimeout(() => g.dispose(), 200);
  }

  /** フェーダー（層のミュート・音量、ドラムループ・パッド・効果音の量）を動かす。 */
  setFader(name: string, value: number): void {
    this.faders[name] = value;
    this.graph?.setFader(name, value);
  }

  /** いま曲のどこか（0〜1）。鳴っていなければ null。 */
  progress(): number | null {
    if (!this.graph || this.duration <= 0) return null;
    return ((((this.ctx.currentTime - this.startedAt) % this.duration) + this.duration) % this.duration) / this.duration;
  }
}
