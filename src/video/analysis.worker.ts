import { analyze } from "./analysis.ts";

// 曲の解析（FFT）を、画面を止めないように裏で計算する。
self.onmessage = (e: MessageEvent<{ l: Float32Array; r: Float32Array; sampleRate: number; stepSamples: number; totalSteps: number }>) => {
  const { l, r, sampleRate, stepSamples, totalSteps } = e.data;
  const an = analyze({ l, r }, sampleRate, stepSamples, totalSteps);
  (self as unknown as { postMessage(m: unknown, transfer: Transferable[]): void }).postMessage(an, [an.loud.buffer, an.spec.buffer, an.width.buffer]);
};
