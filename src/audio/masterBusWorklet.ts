import { MasterBusStream } from "../mix/masterBusStream";

// AudioWorklet の中（音を作る専用のスレッド）で動く。ここにある型は、その場所だけにあるもの。
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

/**
 * マスターの仕上げ（コンプ＋リミッター）を、再生しながらリアルタイムで掛ける。
 * 計算は書き出しと同じ MasterBusStream（先読みのぶん、約2ミリ秒だけ遅れる）。
 */
class MasterBusProcessor extends AudioWorkletProcessor {
  private readonly stream = new MasterBusStream(sampleRate);

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const inp = inputs[0];
    const n = out[0].length;
    const inL = inp && inp[0] ? inp[0] : new Float32Array(n);
    const inR = inp && inp[1] ? inp[1] : inL;
    const outR = out[1] ?? out[0];
    this.stream.process(inL, inR, out[0], outR);
    return true;
  }
}

registerProcessor("orinasu-master-bus", MasterBusProcessor);
