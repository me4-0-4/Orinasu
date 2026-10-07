import { DEFAULT_CHOP, neededSources, planChops, type ChopSegment, type ChopSource } from "./chop.ts";
import { chopPcm, limitPeak, type Pcm } from "./audioChop.ts";
import type { Song } from "./types.ts";
import { totalBeats, type Phrase } from "../phrase/types.ts";

type Rng = () => number;

/** 刻む曲（フレーズ）：音符のある曲だけ。選んだ順。 */
export function collectSources(song: Pick<Song, "materialIds">, phrases: Phrase[]): Phrase[] {
  const byId = new Map(phrases.map((p) => [p.id, p]));
  return song.materialIds
    .map((id) => byId.get(id))
    .filter((p): p is Phrase => !!p && p.layers.some((l) => l.notes.length > 0));
}

export function chopSourceOf(phrase: Phrase): ChopSource {
  return { id: phrase.id, bars: Math.max(1, Math.round(totalBeats(phrase) / phrase.beatsPerBar)) };
}

/** 計画が覆っている小節数。 */
export function planBars(plan: ChopSegment[] | undefined, beatsPerBar: number): number {
  if (!plan || plan.length === 0) return 0;
  return Math.round(Math.max(...plan.map((s) => s.dst + s.len)) / beatsPerBar);
}

export interface PlanOptions {
  /** メインの曲も選び直す（false なら、いまのメインの曲のまま刻み方だけ）。 */
  newBase: boolean;
  /** 固定する小節（0から数える）。 */
  keepBars: number[];
}

/** 刻み方の計画を作る。曲（song）の長さ・スライダー・前の計画を使う。 */
export function planForSong(
  song: Song,
  sources: Phrase[],
  rng: Rng,
  opts: PlanOptions,
): { plan: ChopSegment[]; baseId: string } | null {
  if (sources.length === 0) return null;
  const keepBase = !opts.newBase && song.baseId !== undefined && sources.some((p) => p.id === song.baseId);
  const baseId = keepBase ? (song.baseId as string) : sources[Math.floor(rng() * sources.length) % sources.length].id;
  // 長さが変わったときは、前の計画の固定は使えない
  const sameLength = planBars(song.plan, song.beatsPerBar) === song.lengthBars;
  const plan = planChops(
    {
      dstBeats: song.lengthBars * song.beatsPerBar,
      beatsPerBar: song.beatsPerBar,
      sources: sources.map(chopSourceOf),
      baseId,
      params: { ...DEFAULT_CHOP, ...song.chop },
      keep: sameLength && opts.keepBars.length > 0 && song.plan ? { bars: opts.keepBars, plan: song.plan } : undefined,
    },
    rng,
  );
  return { plan, baseId };
}

/**
 * 曲の計画から、刻んだ曲の波形を作る。
 * render は「フレーズ → そのBPMで書き出した1周の波形」。計画に出てくる (曲, 速さ) ごとに、曲のBPM×速さで書き出す
 * （フレーズ自身のBPMは関係ない）。
 */
export async function buildSongPcm(
  song: Song,
  sources: Phrase[],
  render: (phrase: Phrase, bpm: number) => Promise<Pcm>,
  sampleRate: number,
): Promise<Pcm | null> {
  if (!song.plan || song.plan.length === 0 || sources.length === 0) return null;
  const byId = new Map(sources.map((p) => [p.id, p]));
  const rendered = new Map<string, Pcm>();
  await Promise.all(
    neededSources(song.plan).map(async ({ from, rate }) => {
      const phrase = byId.get(from);
      if (phrase) rendered.set(`${from}@${rate}`, await render(phrase, song.bpm * rate));
    }),
  );
  const pcm = chopPcm({
    plan: song.plan,
    dstBeats: song.lengthBars * song.beatsPerBar,
    bpm: song.bpm,
    sampleRate,
    getSource: (from, rate) => rendered.get(`${from}@${rate}`),
    beatsOf: (from) => {
      const p = byId.get(from);
      return p ? totalBeats(p) : 0;
    },
  });
  return limitPeak(pcm);
}
