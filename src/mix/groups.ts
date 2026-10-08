import { fxId, sanitizePlugin, type FxPlugin } from "./fx.ts";
import type { LaneEvent } from "./sequencer.ts";

/**
 * グループ：選んだ断片のまとまり（トラックをまたいでもいい）。まとめて刻み方を変えたり、ミュートしたり、FXを掛けたりする。
 * 断片は「どのトラック（曲のid）の、どの位置（ステップ）か」で覚える（テイクFXと同じ）。刻み直して、その位置に断片が無くなると効かない。
 */
export interface HitRef {
  /** トラック（刻む曲）のid。 */
  phraseId: string;
  step: number;
}

export interface HitGroup {
  id: string;
  name: string;
  /** 線の上の印の色（色相 0〜360）。 */
  hue: number;
  members: HitRef[];
  /** ミュート：このグループの断片を鳴らさない。 */
  muted: boolean;
  /** 音程を、半音いくつずらすか（-12〜12）。 */
  pitch: number;
  /** パン（-1〜1）。null なら、刻んだときのまま。 */
  pan: number | null;
  /** 音の長さ（次に打つ所までの何割を鳴らすか、0.05〜1）。null なら、刻んだときのまま。 */
  gate: number | null;
  /** 強さの倍率（0〜1.5）。 */
  vel: number;
  /** 逆再生。 */
  reverse: boolean;
  /** グループのFXチェーン（このグループの断片にだけ掛かる。テイクFXのあと、トラックFXの前）。 */
  fx: FxPlugin[];
}

const GROUP_HUES = [200, 320, 40, 140, 270, 10, 90, 180];

export function newGroup(members: HitRef[], existing: HitGroup[]): HitGroup {
  const n = existing.length + 1;
  return {
    id: fxId("grp"),
    name: `グループ${n}`,
    hue: GROUP_HUES[(n - 1) % GROUP_HUES.length],
    members: uniqueRefs(members),
    muted: false,
    pitch: 0,
    pan: null,
    gate: null,
    vel: 1,
    reverse: false,
    fx: [],
  };
}

export const refKey = (r: HitRef): string => `${r.phraseId}@${r.step}`;

export function uniqueRefs(refs: HitRef[]): HitRef[] {
  const seen = new Map<string, HitRef>();
  for (const r of refs) seen.set(refKey(r), { phraseId: r.phraseId, step: r.step });
  return [...seen.values()].sort((a, b) => a.step - b.step || a.phraseId.localeCompare(b.phraseId));
}

/** 断片が、どのグループに入っているか（あとに作ったものが優先）。 */
export function groupOf(groups: HitGroup[] | undefined, ref: HitRef): HitGroup | undefined {
  if (!groups) return undefined;
  const key = refKey(ref);
  for (let i = groups.length - 1; i >= 0; i--) if (groups[i].members.some((m) => refKey(m) === key)) return groups[i];
  return undefined;
}

/** 断片を1つのグループにだけ入れる：ほかのグループからは外す。空になったグループは消す。 */
export function assignToGroup(groups: HitGroup[], target: HitGroup, refs: HitRef[]): HitGroup[] {
  const keys = new Set(refs.map(refKey));
  const out: HitGroup[] = [];
  for (const g of groups) {
    if (g.id === target.id) continue;
    const members = g.members.filter((m) => !keys.has(refKey(m)));
    if (members.length > 0) out.push({ ...g, members });
  }
  out.push({ ...target, members: uniqueRefs(refs) });
  return out;
}

/** グループが、音を変えるか（変えなければ処理を省ける）。 */
export function groupChangesSound(g: HitGroup): boolean {
  return g.muted || g.pitch !== 0 || g.pan !== null || g.gate !== null || g.vel !== 1 || g.reverse || g.fx.some((p) => !p.bypass);
}

/**
 * グループの編集を、1つのトラックの打つ予定に当てはめる。
 * 返すのは、鳴らす予定（ミュートした断片を除く）と、表示用の予定（ミュートも含む）。
 */
export function applyGroups(phraseId: string, events: LaneEvent[], groups: HitGroup[] | undefined): { play: LaneEvent[]; view: LaneEvent[] } {
  if (!groups || groups.length === 0) return { play: events, view: events };
  const play: LaneEvent[] = [];
  const view: LaneEvent[] = [];
  for (const ev of events) {
    const g = groupOf(groups, { phraseId, step: ev.step });
    if (!g) {
      play.push(ev);
      view.push(ev);
      continue;
    }
    const edited: LaneEvent = { ...ev, pitch: Math.max(-24, Math.min(24, ev.pitch + g.pitch)) };
    if (g.pan !== null) {
      if (g.pan === 0) delete edited.pan;
      else edited.pan = g.pan;
    }
    if (g.gate !== null) edited.gate = g.gate;
    if (g.vel !== 1) edited.vel = Math.max(0, (ev.vel ?? 1) * g.vel);
    if (g.reverse) edited.fx = { kind: "reverse", a: 0, b: 1 };
    view.push(edited);
    if (!g.muted) play.push(edited);
  }
  return { play, view };
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** 保存されていたグループを読む。 */
export function sanitizeGroups(raw: unknown): HitGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: HitGroup[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (typeof r !== "object" || r === null || !Array.isArray(r.members)) continue;
    const members = uniqueRefs(
      (r.members as Record<string, unknown>[])
        .filter((m) => typeof m === "object" && m !== null && typeof m.phraseId === "string" && isNum(m.step))
        .map((m) => ({ phraseId: m.phraseId as string, step: Math.max(0, Math.round(m.step as number)) })),
    );
    if (members.length === 0) continue;
    const g = newGroup(members, out);
    if (typeof r.id === "string" && r.id) g.id = r.id;
    if (typeof r.name === "string" && r.name) g.name = r.name;
    if (isNum(r.hue)) g.hue = r.hue;
    g.muted = r.muted === true;
    if (isNum(r.pitch)) g.pitch = Math.max(-12, Math.min(12, Math.round(r.pitch)));
    if (isNum(r.pan)) g.pan = Math.max(-1, Math.min(1, r.pan));
    if (isNum(r.gate)) g.gate = Math.max(0.05, Math.min(1, r.gate));
    if (isNum(r.vel)) g.vel = Math.max(0, Math.min(1.5, r.vel));
    g.reverse = r.reverse === true;
    if (Array.isArray(r.fx)) g.fx = r.fx.map(sanitizePlugin).filter((p): p is FxPlugin => p !== null);
    out.push(g);
  }
  return out;
}
