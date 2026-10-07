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
      const gate = Math.max(1, Math.round(fullGate * Math.min(1, Math.max(0, lane.holdFraction ?? 1))));
      const ratio = Math.pow(2, (ev.pitch + lane.keyShift) / 12);
      const available = Math.floor((slice.end - slice.start - 1) / ratio);
      const len = Math.min(gate, available, total - start);
      if (len <= 0) continue;
      const fade = Math.min(fadeMax, Math.floor(len / 2));
      for (let k = 0; k < len; k++) {
        const x = slice.start + k * ratio;
        const i0 = Math.floor(x);
        const f = x - i0;
        let g = gain;
        if (fade > 0) {
          if (k < fade) g *= k / fade;
          if (len - 1 - k < fade) g *= (len - 1 - k) / fade;
        }
        out.l[start + k] += (sl[i0] * (1 - f) + sl[i0 + 1] * f) * g;
        out.r[start + k] += (sr[i0] * (1 - f) + sr[i0 + 1] * f) * g;
      }
    }
  }
  return out;
}
