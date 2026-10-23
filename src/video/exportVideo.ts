import type { Pcm } from "../mix/pcm";

/**
 * 動画の書き出し（ブラウザだけでできる方式）。
 * 映像を描いた Canvas と、曲の音を MediaRecorder で実時間で録る。Chrome なら MP4、無理なら WebM になる。
 * 実時間なので、書き出しには曲の長さぶんの時間がかかる。
 */

/** 使える形式（上から順に試す）。 */
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export const extensionOf = (mime: string): string => (mime.startsWith("video/mp4") ? "mp4" : "webm");

export interface RecordOptions {
  canvas: HTMLCanvasElement;
  ctx: AudioContext;
  pcm: Pcm;
  sampleRate: number;
  fps: number;
  /** 毎コマ呼ぶ：t＝曲の頭からの秒数。ここで canvas に描く。 */
  draw: (t: number, dt: number) => void;
  /** 進み具合（0〜1）。 */
  onProgress: (fraction: number) => void;
  /** true を返したら途中でやめる。 */
  cancelled: () => boolean;
}

/** 録って、動画の Blob を返す（やめたら null）。 */
export async function recordVideo(o: RecordOptions): Promise<{ blob: Blob; mime: string } | null> {
  const mime = pickMime();
  if (!mime) throw new Error("このブラウザは動画を書き出せません");
  const stream = o.canvas.captureStream(o.fps);
  const dest = o.ctx.createMediaStreamDestination();
  const buf = o.ctx.createBuffer(2, o.pcm.l.length, o.sampleRate);
  buf.copyToChannel(o.pcm.l as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(o.pcm.r as Float32Array<ArrayBuffer>, 1);
  const src = o.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(dest);
  for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 192_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  const duration = buf.duration;
  o.draw(0, 0);
  if (o.ctx.state !== "running") await o.ctx.resume();
  rec.start(500);
  const t0 = o.ctx.currentTime + 0.15;
  src.start(t0);
  let cancelled = false;
  await new Promise<void>((resolve) => {
    let last = 0;
    const step = (): void => {
      if (o.cancelled()) {
        cancelled = true;
        resolve();
        return;
      }
      const t = Math.max(0, o.ctx.currentTime - t0);
      if (t >= duration) {
        o.draw(Math.max(0, duration - 1e-3), t - last);
        resolve();
        return;
      }
      o.draw(t, t - last);
      last = t;
      o.onProgress(t / duration);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  try {
    src.stop();
  } catch {
    // 鳴り終わっていれば止めなくてよい
  }
  src.disconnect();
  rec.stop();
  await stopped;
  for (const t of stream.getTracks()) t.stop();
  if (cancelled) return null;
  return { blob: new Blob(chunks, { type: mime.split(";")[0] }), mime };
}
