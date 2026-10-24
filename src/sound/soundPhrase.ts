import { PAD_BASE_PITCH, defaultSamplerParams, normalizeSlices } from "./sampler.ts";
import { barsOf, type StoredSound } from "./types.ts";
import type { Phrase } from "../phrase/types.ts";

const PREFIX = "sound:";

/** 刻むタブの材料のうち、読み込んだ音から作ったもの（フレーズの id の頭が sound:）。 */
export function isSoundPhraseId(id: string): boolean {
  return id.startsWith(PREFIX);
}

/** 1拍目から何小節ぶんを材料にするか（1〜64。端数は四捨五入）。テンポが無ければ null。 */
export function soundBars(meta: Pick<StoredSound, "durationSec" | "bpm" | "downbeatSec" | "beatsPerBar">): number | null {
  const bars = barsOf(meta);
  if (bars === null || !Number.isFinite(bars)) return null;
  return Math.min(64, Math.max(1, Math.round(bars)));
}

/**
 * 読み込んだ音を、刻むタブの材料（1曲）にする。テンポが分かる音だけ。
 * 中身は「サンプラーの層が1つ、1拍目から N 小節ぶんを1音で鳴らす」フレーズ。
 * 曲のテンポに合わせて、音の速さ（と高さ）を変える。パッド型にしてあるので、調の判定には使わない。
 */
export function soundPhrase(s: StoredSound): Phrase | null {
  const bars = soundBars(s);
  if (bars === null || !s.bpm) return null;
  const beatsPerBar = s.beatsPerBar ?? 4;
  const down = Math.min(s.durationSec, Math.max(0, s.downbeatSec ?? 0));
  const end = down + (bars * beatsPerBar * 60) / s.bpm;
  const cuts = [0, down / s.durationSec];
  if (end < s.durationSec) cuts.push(end / s.durationSec);
  const slices = normalizeSlices(cuts);
  // 1拍目から始まる断片の番号（1拍目が頭なら 0）
  const index = slices.findIndex((v) => Math.abs(v - down / s.durationSec) < 1e-4);
  return {
    id: `${PREFIX}${s.id}`,
    name: s.name,
    lengthBars: bars as Phrase["lengthBars"],
    bpm: s.bpm,
    beatsPerBar,
    layers: [
      {
        id: `${PREFIX}${s.id}:layer`,
        role: "other",
        muted: false,
        solo: false,
        instrument: "sampler",
        sampler: {
          ...defaultSamplerParams(s.id),
          mode: "pads",
          slices,
          hold: "oneshot",
          attack: 0.002,
          release: 0.01,
          sourceBpm: s.bpm,
        },
        notes: [{ id: `${PREFIX}${s.id}:note`, pitch: PAD_BASE_PITCH + Math.max(0, index), velocity: 1, startBeats: 0, durationBeats: bars * beatsPerBar }],
      },
    ],
    createdAt: s.createdAt,
    // 中身を取り寄せたら作り直してほしいので、中身の有無も「新しさ」に入れる（書き出しの使い回しの目印）
    updatedAt: s.updatedAt + (s.blob ? 1 : 0),
  };
}
