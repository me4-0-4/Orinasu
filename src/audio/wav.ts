import type { Pcm } from "../mix/pcm.ts";

/** ステレオの波形を、16bit PCM の WAV ファイルにする。 */
export function encodeWav(pcm: Pcm, sampleRate: number): Uint8Array<ArrayBuffer> {
  const frames = pcm.l.length;
  const dataBytes = frames * 2 * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const text = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // fmtチャンクの大きさ
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // ステレオ
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // 1秒あたりのバイト数
  view.setUint16(32, 4, true); // 1フレームのバイト数
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  let o = 44;
  const s16 = (x: number): number => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let i = 0; i < frames; i++) {
    view.setInt16(o, s16(pcm.l[i]), true);
    view.setInt16(o + 2, s16(pcm.r[i]), true);
    o += 4;
  }
  return new Uint8Array(buffer);
}
