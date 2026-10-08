type Rng = () => number;

/** 1拍を16分で4つに分けた格子に打つ。 */
export const STEPS_PER_BEAT = 4;

/** 形のつまみ（どれも0〜1）。 */
export interface ShapeParams {
  /** 密度：どれくらい打つか。 */
  busy: number;
  /** 休み：打たない所をまとめて作る（最大でフレーズの半分）。 */
  breaks: number;
  /** 拍に寄せる：1・2・3・4拍目に打ちやすくする。 */
  onBeat: number;
  /** 音程の動き：断片の高さを、近い高さへ少しずつ動かす。 */
  motion: number;
  /** 音の長さ：次に打つ所までの、どれだけ鳴らすか（0で短く切る、1で次まで伸ばす）。素材モード用。 */
  hold: number;
  /** キレ：音楽モードで、短い隙間を入れてメリハリをつける小節の割合（残りは「なめらか」につなぐ）。 */
  crisp: number;
  /** パン：刻んだ所を左右に交互に振る強さ。 */
  pan: number;
  /** エフェクト：音楽モードのフィルの小節に、エフェクトを掛ける割合。 */
  fx: number;
}

/** フィルに掛けるエフェクト。 */
export type FxKind = "lowpass" | "highpass" | "tapestop" | "crush" | "reverse";

/** 打つ1回に掛けるエフェクト。a〜b は、エフェクトの流れ（0〜1）のうち、この1回が受け持つ範囲。 */
export interface EventFx {
  kind: FxKind;
  a: number;
  b: number;
}

/**
 * 音の長さのつまみ（0〜1）を、次に打つ所までに鳴らす割合にする。
 * 素材モードは 0で15%〜1で100%。音楽モードは流れを切りすぎないよう、0で50%〜1で100%。
 */
export function holdFraction(hold: number, style: "music" | "material" = "material"): number {
  return style === "music" ? 0.5 + 0.5 * clamp01(hold) : 0.15 + 0.85 * clamp01(hold);
}

/** 打つ1回：何ステップ目から、何ステップぶん、どの断片を、何半音ずらして。 */
export interface LaneEvent {
  step: number;
  len: number;
  slice: number;
  pitch: number;
  /** 左右（-1〜1）。無ければ真ん中。 */
  pan?: number;
  /** 次に打つ所までの、どれだけ鳴らすか（0〜1）。無ければ層の「音の長さ」に従う。 */
  gate?: number;
  fx?: EventFx;
  /** 強さ（0〜1）。無ければ1。 */
  vel?: number;
}

/**
 * 打つ位置で決まる強さ：小節の頭がいちばん強く、拍の頭、8分の裏、16分の裏の順に弱くする（ノリが出る）。
 */
export function accentOf(step: number, stepsPerBar: number): number {
  if (step % stepsPerBar === 0) return 1;
  if (step % STEPS_PER_BEAT === 0) return 0.9;
  if (step % 2 === 0) return 0.8;
  return 0.7;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const randInt = (n: number, rng: Rng): number => Math.min(n - 1, Math.floor(rng() * n));

/** 音程のはしご（半音）。音程が動くときは、ここを1〜2段ずつ上り下りする（近い高さへつなぐ）。 */
export const PITCH_LADDER = [-12, -10, -7, -5, -3, 0, 2, 4, 5, 7, 9, 12];
const ZERO = PITCH_LADDER.indexOf(0);

/** 休みの場所（true＝打たない）。拍の頭から、1拍・2拍・1小節のまとまりで作る。 */
export function restMask(steps: number, stepsPerBar: number, breaks: number, rng: Rng): boolean[] {
  const mask = new Array<boolean>(steps).fill(false);
  const target = Math.round(clamp01(breaks) * 0.5 * steps);
  let covered = 0;
  for (let guard = 0; covered < target && guard < 200; guard++) {
    const spans = [STEPS_PER_BEAT, STEPS_PER_BEAT * 2, stepsPerBar];
    const span = spans[randInt(spans.length, rng)];
    const start = randInt(Math.max(1, Math.floor(steps / STEPS_PER_BEAT)), rng) * STEPS_PER_BEAT;
    for (let s = start; s < Math.min(steps, start + span) && covered < target; s++) {
      if (!mask[s]) {
        mask[s] = true;
        covered++;
      }
    }
  }
  return mask;
}

/** いつ打つか。音の長さは、次に打つ所か、休みが始まる所まで（最長1小節）。 */
export function planRhythm(
  steps: number,
  beatsPerBar: number,
  params: Pick<ShapeParams, "busy" | "breaks" | "onBeat">,
  rng: Rng,
): { step: number; len: number }[] {
  const stepsPerBar = beatsPerBar * STEPS_PER_BEAT;
  const rest = restMask(steps, stepsPerBar, params.breaks, rng);
  const p = 0.08 + 0.92 * clamp01(params.busy);
  const o = clamp01(params.onBeat);
  const hits: number[] = [];
  for (let s = 0; s < steps; s++) {
    const r = rng(); // 休みでも引いておく（休みを変えても、ほかの所の打ち方が変わりにくい）
    if (rest[s]) continue;
    const prob = s % STEPS_PER_BEAT === 0 ? p + (1 - p) * o : p * (1 - 0.6 * o);
    if (r < prob) hits.push(s);
  }
  return hits.map((step, i) => {
    let end = hits[i + 1] ?? steps;
    for (let s = step + 1; s < end; s++) {
      if (rest[s]) {
        end = s;
        break;
      }
    }
    return { step, len: Math.max(1, Math.min(end - step, stepsPerBar)) };
  });
}

/**
 * どの断片を打つか・どの高さで打つか。
 * 前と同じ断片をもう一度（連打、45%）、前の続きの断片（15%）、どれでも、の3つから偶然で選ぶ。
 */
export function planOrder(
  hits: { step: number; len: number }[],
  sliceCount: number,
  motion: number,
  rng: Rng,
): LaneEvent[] {
  if (sliceCount <= 0) return [];
  let prev = -1;
  let rung = ZERO;
  const moves = [-2, -1, 1, 2];
  return hits.map(({ step, len }) => {
    // 1回ごとに引く数をそろえる（密度などを変えても、打ち方の傾向が大きく崩れない）
    const r = rng();
    const any = randInt(sliceCount, rng);
    const m = rng();
    const move = moves[randInt(moves.length, rng)];
    const slice = prev < 0 ? any : r < 0.45 ? prev : r < 0.6 ? (prev + 1) % sliceCount : any;
    if (m < clamp01(motion)) rung = Math.min(PITCH_LADDER.length - 1, Math.max(0, rung + move));
    prev = slice;
    return { step, len, slice, pitch: PITCH_LADDER[rung] };
  });
}
