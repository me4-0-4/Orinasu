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

// ---- 速い書き出し（WebCodecs ＋ mediabunny） ----
// 1コマずつ描いて符号化するので、コマが落ちず、たいてい実時間より速い。

export interface EncodeOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  fps: number;
  pcm: Pcm;
  sampleRate: number;
  /** t 秒の絵を canvas に描く（dt＝前のコマからの秒数）。 */
  draw: (t: number, dt: number) => void;
  onProgress: (fraction: number) => void;
  cancelled: () => boolean;
}

/** 試す組み合わせ（上から）。SNS には MP4（H.264＋AAC）がいちばん通りやすい。 */
const PLANS: { fmt: "mp4" | "webm"; video: "avc" | "vp9" | "vp8"; audio: "aac" | "opus" }[] = [
  { fmt: "mp4", video: "avc", audio: "aac" },
  { fmt: "mp4", video: "avc", audio: "opus" },
  { fmt: "webm", video: "vp9", audio: "opus" },
  { fmt: "webm", video: "vp8", audio: "opus" },
];

/** WebCodecs で書き出せるか。書き出せない組み合わせしか無ければ null（実時間の書き出しに切り替える）。 */
export async function pickPlan(width: number, height: number, fps: number, sampleRate: number): Promise<(typeof PLANS)[number] | null> {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") return null;
  const { canEncodeAudio, canEncodeVideo, QUALITY_HIGH } = await import("mediabunny");
  for (const p of PLANS) {
    try {
      if ((await canEncodeVideo(p.video, { width, height, frameRate: fps, quality: QUALITY_HIGH })) && (await canEncodeAudio(p.audio, { numberOfChannels: 2, sampleRate, quality: QUALITY_HIGH }))) return p;
    } catch {
      // この組み合わせは使えない
    }
  }
  return null;
}

/** 動画を作って返す（やめたら null）。plan は pickPlan で選んだもの。 */
export async function encodeVideo(o: EncodeOptions, plan: (typeof PLANS)[number]): Promise<{ blob: Blob; ext: string; codecs: string } | null> {
  const { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat } = await import("mediabunny");
  const target = new BufferTarget();
  const output = new Output({ format: plan.fmt === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(), target });
  const video = new CanvasSource(o.canvas, { codec: plan.video, quality: QUALITY_HIGH });
  const audio = new AudioBufferSource({ codec: plan.audio, quality: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: o.fps });
  output.addAudioTrack(audio);
  await output.start();
  const ab = new AudioBuffer({ numberOfChannels: 2, length: o.pcm.l.length, sampleRate: o.sampleRate });
  ab.copyToChannel(o.pcm.l as Float32Array<ArrayBuffer>, 0);
  ab.copyToChannel(o.pcm.r as Float32Array<ArrayBuffer>, 1);
  await audio.add(ab);
  audio.close();
  const frames = Math.max(1, Math.round(ab.duration * o.fps)), dt = 1 / o.fps;
  for (let k = 0; k < frames; k++) {
    if (o.cancelled()) {
      await output.cancel();
      return null;
    }
    o.draw(k * dt, k === 0 ? 0 : dt);
    await video.add(k * dt, dt);
    if (k % 4 === 0) {
      o.onProgress(k / frames);
      // 画面（進み具合・やめるボタン）が動くように、ときどき手を離す
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  video.close();
  await output.finalize();
  return { blob: new Blob([target.buffer!], { type: output.format.mimeType }), ext: plan.fmt, codecs: `${plan.video}+${plan.audio}` };
}
