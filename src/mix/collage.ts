import type { Pcm } from "./pcm.ts";
import type { Slice } from "./slicer.ts";
import type { LaneEvent } from "./sequencer.ts";

/** 1つの層：1本の波形と、その断片、打つ予定。 */
export interface CollageLane {
  pcm: Pcm;
  slices: Slice[];
  events: LaneEvent[];
  /** 層全体を半音いくつずらすか（調をそろえるため）。 */
  keyShift: number;
  gain?: number;
  /** 次に打つ所までに鳴らす割合（0〜1。無ければ1＝次まで伸ばす）。 */
  holdFraction?: number;
}

/** 断片の継ぎ目のプチ音を消す、短いフェード（秒）。 */
const FADE_SECONDS = 0.003;

/**
 * 全部の層の予定どおりに断片を打って、1本の波形にする。
 * 音程はサンプラーと同じく、再生の速さごと変える（高いほど速く・短く）。
 */
export function renderCollage(
  lanes: CollageLane[],
  opts: { totalSteps: number; stepSamples: number; sampleRate: number },
): Pcm {
  const total = Math.max(1, Math.round(opts.totalSteps * opts.stepSamples));
  const out: Pcm = { l: new Float32Array(total), r: new Float32Array(total) };
  const fadeMax = Math.max(1, Math.round(FADE_SECONDS * opts.sampleRate));
  for (const lane of lanes) {
    const gain = lane.gain ?? 0.9;
    if (gain <= 0) continue; // ミュートした層
    const { l: sl, r: sr } = lane.pcm;
    for (const ev of lane.events) {
      const slice = lane.slices[ev.slice];
      if (!slice) continue;
      const start = Math.round(ev.step * opts.stepSamples);
      if (start >= total) continue;
      const fullGate = Math.round((ev.step + ev.len) * opts.stepSamples) - start;
      const gateFrac = Math.min(1, Math.max(0, ev.gate ?? lane.holdFraction ?? 1));
      const gate = Math.max(1, Math.round(fullGate * gateFrac));
      const ratio = Math.pow(2, (ev.pitch + lane.keyShift) / 12);
      const available = Math.floor((slice.end - slice.start - 1) / ratio);
      const len = Math.min(gate, available, total - start);
      if (len <= 0) continue;
      const fade = Math.min(fadeMax, Math.floor(len / 2));
      // パン：真ん中は左右とも1。振ると反対側が下がる
      const pan = Math.min(1, Math.max(-1, ev.pan ?? 0));
      const gl = Math.min(1, 1 - pan);
      const gr = Math.min(1, 1 + pan);
      const fx = ev.fx;
      const progress = (k: number): number => (fx ? fx.a + ((fx.b - fx.a) * k) / len : 0);
      let pos = slice.start; // テープストップ用：だんだん遅くなる読み位置
      let yl = 0;
      let yr = 0;
      let held = { l: 0, r: 0 };
      for (let k = 0; k < len; k++) {
        let x: number;
        if (fx?.kind === "tapestop") {
          x = pos;
          pos += ratio * Math.max(0.08, 1 - 0.92 * progress(k));
          if (x >= slice.end - 1) break;
        } else if (fx?.kind === "reverse") {
          x = slice.start + (len - 1 - k) * ratio;
        } else {
          x = slice.start + k * ratio;
        }
        const i0 = Math.floor(x);
        const f = x - i0;
        let vl = sl[i0] * (1 - f) + sl[i0 + 1] * f;
        let vr = sr[i0] * (1 - f) + sr[i0 + 1] * f;
        if (fx?.kind === "crush") {
          // 音質を下げる：6サンプルごとに値を止め、5bitに丸める
          if (k % 6 === 0) held = { l: Math.round(vl * 16) / 16, r: Math.round(vr * 16) / 16 };
          vl = held.l;
          vr = held.r;
        } else if (fx?.kind === "lowpass" || fx?.kind === "highpass") {
          // フィルター：ローパスは閉じていき（こもる）、ハイパスは低音が戻ってくる
          const p = progress(k);
          const fc = fx.kind === "lowpass" ? 9000 * Math.pow(250 / 9000, p) : 3000 * Math.pow(30 / 3000, p);
          const alpha = 1 - Math.exp((-2 * Math.PI * fc) / opts.sampleRate);
          if (k === 0) {
            yl = vl;
            yr = vr;
          }
          yl += alpha * (vl - yl);
          yr += alpha * (vr - yr);
          if (fx.kind === "lowpass") {
            vl = yl;
            vr = yr;
          } else {
            vl -= yl;
            vr -= yr;
          }
        }
        let g = gain;
        if (fade > 0) {
          if (k < fade) g *= k / fade;
          if (len - 1 - k < fade) g *= (len - 1 - k) / fade;
        }
        out.l[start + k] += vl * g * gl;
        out.r[start + k] += vr * g * gr;
      }
    }
  }
  return out;
}
