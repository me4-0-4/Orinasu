import type { Session } from "@supabase/supabase-js";
import type { Phrase } from "../phrase/types";
import { migrateSong, type Song } from "../mix/types";
import {
  clearLocalData,
  deletePhrase,
  deleteSound,
  loadSounds,
  saveSound,
  deleteSong,
  deleteUserPreset,
  loadAllPhrases,
  loadSavedSongs,
  loadUserPresets,
  savePhrase,
  saveSong,
  saveUserPreset,
  storageHooks,
  type UserPreset,
} from "../storage/db";
import { SOUND_BUCKET, supabase, type CloudTable } from "./client";
import { migrateSoundMeta, soundMetaOf, type StoredSound } from "../sound/types";

export type SyncStatus = "signedOut" | "syncing" | "synced" | "error";

export interface CloudState {
  status: SyncStatus;
  email: string | null;
  /** エラーのときの説明。 */
  message?: string;
}

const LAST_USER_KEY = "orinasu.cloudUserId";

let state: CloudState = { status: "signedOut", email: null };
let session: Session | null = null;
let onSynced: (() => void) | null = null;
let onCleared: (() => void) | null = null;
const listeners = new Set<(s: CloudState) => void>();

function setState(next: CloudState): void {
  state = next;
  for (const fn of listeners) fn(state);
}

export function getCloudState(): CloudState {
  return state;
}

export function subscribeCloud(fn: (s: CloudState) => void): void {
  listeners.add(fn);
  fn(state);
}

function readLastUser(): string | null {
  try {
    return localStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
}

function writeLastUser(id: string): void {
  try {
    localStorage.setItem(LAST_USER_KEY, id);
  } catch {
    // localStorage が使えなくても同期自体は続ける。
  }
}

// --- 端末 → クラウド ----------------------------------------------------------

interface Row {
  id: string;
  data: unknown;
  updated_at: number;
  deleted: boolean;
}

async function pushRows(table: CloudTable, rows: Row[]): Promise<void> {
  if (!session || rows.length === 0) return;
  const userId = session.user.id;
  const { error } = await supabase
    .from(table)
    .upsert(rows.map((r) => ({ ...r, user_id: userId })), { onConflict: "user_id,id" });
  if (error) throw error;
}

// 続けて何度も保存されても、同じIDは最後の1回だけ送る。
const pending = new Map<string, Row & { table: CloudTable }>();
let flushTimer: number | null = null;

function queuePush(table: CloudTable, row: Row): void {
  if (!session) return;
  pending.set(`${table}:${row.id}`, { ...row, table });
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushPending();
  }, 800);
}

async function flushPending(): Promise<void> {
  if (!session || pending.size === 0) return;
  const batch = [...pending.values()];
  pending.clear();
  try {
    for (const table of ["phrases", "presets", "songs", "sounds"] as const) {
      const rows = batch.filter((r) => r.table === table).map(({ table: _t, ...row }) => row);
      await pushRows(table, rows);
    }
    if (state.status !== "syncing") setState({ ...state, status: "synced", message: undefined });
  } catch (e) {
    // 送れなかった分は、次の全体同期（起動時・オンライン復帰時）で端末側の新しいデータとして送り直される。
    setState({ ...state, status: "error", message: describeError(e) });
  }
}

function describeError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

storageHooks.phraseSaved = (p) =>
  queuePush("phrases", { id: p.id, data: p, updated_at: p.updatedAt, deleted: false });
storageHooks.phraseDeleted = (id) =>
  queuePush("phrases", { id, data: {}, updated_at: Date.now(), deleted: true });
storageHooks.presetSaved = (p) =>
  queuePush("presets", { id: p.id, data: p, updated_at: p.updatedAt, deleted: false });
storageHooks.presetDeleted = (id) =>
  queuePush("presets", { id, data: {}, updated_at: Date.now(), deleted: true });
storageHooks.songSaved = (s) =>
  queuePush("songs", { id: s.id, data: s, updated_at: s.updatedAt, deleted: false });
storageHooks.songDeleted = (id) =>
  queuePush("songs", { id, data: {}, updated_at: Date.now(), deleted: true });
storageHooks.soundAdded = (s) => void uploadSound(s.id);
storageHooks.soundUpdated = (s) => {
  // 上げている途中なら、上げ終わったときに最新の情報を送る
  if (!soundCloud.uploading.has(s.id)) queuePush("sounds", soundRow(s));
};
storageHooks.soundDeleted = (id) => {
  queuePush("sounds", { id, data: {}, updated_at: Date.now(), deleted: true });
  void removeSoundObject(id).catch(() => {
    // 消せなかった中身は、次の全体同期で消す
  });
};

// --- 読み込んだ音（中身は Storage、情報は sounds の表） -------------------------------

export interface SoundCloudState {
  /** クラウドに中身がある音。 */
  ids: Set<string>;
  /** いま上げている音。 */
  uploading: Set<string>;
  /** いま取り寄せている音。 */
  downloading: Set<string>;
  /** クラウドで使っている大きさ（バイト）。分からないときは null。 */
  usedBytes: number | null;
  /** 音の同期だけの問題（置き場がまだ無い、など）。 */
  message?: string;
}

const soundCloud: SoundCloudState = { ids: new Set(), uploading: new Set(), downloading: new Set(), usedBytes: null };
const objectSizes = new Map<string, number>();
const soundListeners = new Set<(s: SoundCloudState) => void>();
let onSoundsChanged: (() => void) | null = null;

function emitSounds(): void {
  soundCloud.ids = new Set(objectSizes.keys());
  soundCloud.usedBytes = session ? [...objectSizes.values()].reduce((a, b) => a + b, 0) : null;
  for (const fn of soundListeners) fn(soundCloud);
}

export function subscribeSoundCloud(fn: (s: SoundCloudState) => void): void {
  soundListeners.add(fn);
  fn(soundCloud);
}

function soundRow(s: StoredSound): Row {
  return { id: s.id, data: soundMetaOf(s), updated_at: s.updatedAt, deleted: false };
}

function soundPath(id: string): string {
  return `${session!.user.id}/${id}`;
}

/** 置き場（表・バケット）がまだ作られていないときの、分かりやすい説明。 */
function describeSoundError(e: unknown): string {
  const msg = describeError(e);
  if (/sounds|bucket/i.test(msg) && /not (be )?found|does not exist|could not find/i.test(msg)) {
    return "クラウドに音の置き場がまだありません（supabase/schema.sql をもう一度実行してください）";
  }
  return msg;
}

async function listSoundObjects(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.storage
      .from(SOUND_BUCKET)
      .list(session!.user.id, { limit: pageSize, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw error;
    for (const o of data ?? []) {
      const size = (o.metadata as { size?: number } | null)?.size;
      if (o.id) out.set(o.name, typeof size === "number" ? size : 0);
    }
    if (!data || data.length < pageSize) break;
  }
  return out;
}

async function putSoundObject(s: StoredSound): Promise<void> {
  if (!s.blob) return;
  const { error } = await supabase.storage.from(SOUND_BUCKET).upload(soundPath(s.id), s.blob, {
    upsert: true,
    contentType: s.blob.type || s.mime || "application/octet-stream",
  });
  if (error) throw error;
  objectSizes.set(s.id, s.blob.size);
}

async function removeSoundObject(id: string): Promise<void> {
  if (!session) return;
  const { error } = await supabase.storage.from(SOUND_BUCKET).remove([soundPath(id)]);
  if (error) throw error;
  objectSizes.delete(id);
  emitSounds();
}

/** 新しく読み込んだ音：中身を上げてから、情報の行を送る（中身の無い行を他の端末に見せない）。 */
async function uploadSound(id: string): Promise<void> {
  if (!session || soundCloud.uploading.has(id)) return;
  soundCloud.uploading.add(id);
  emitSounds();
  try {
    const s = (await loadSounds()).find((x) => x.id === id);
    if (!s) return;
    await putSoundObject(s);
    // 上げている間に名前などを変えていたら、その最新を送る
    const latest = (await loadSounds()).find((x) => x.id === id);
    if (latest) await pushRows("sounds", [soundRow(latest)]);
    soundCloud.message = undefined;
  } catch (e) {
    // 上げられなかった音は、次の全体同期でまた上げる
    soundCloud.message = describeSoundError(e);
  } finally {
    soundCloud.uploading.delete(id);
    emitSounds();
  }
}

/** 音の突き合わせ。情報は新しい方が勝つ。中身はクラウドに無ければ上げ、端末に無ければ取り寄せる。 */
async function syncSounds(): Promise<boolean> {
  const remote = await fetchRemote("sounds");
  const objects = await listSoundObjects();
  objectSizes.clear();
  for (const [k, v] of objects) objectSizes.set(k, v);
  emitSounds();

  const local = await loadSounds();
  const localById = new Map(local.map((l) => [l.id, l]));
  const remoteIds = new Set<string>();
  const toPush: StoredSound[] = [];
  let changed = false;

  for (const r of remote) {
    remoteIds.add(r.id);
    const l = localById.get(r.id);
    if (r.deleted) {
      if (objectSizes.has(r.id)) await removeSoundObject(r.id).catch(() => undefined);
      if (l && r.updated_at >= l.updatedAt) {
        await deleteSound(r.id, { silent: true });
        localById.delete(r.id);
        changed = true;
      } else if (l) {
        toPush.push(l);
      }
      continue;
    }
    const meta = migrateSoundMeta(r.data);
    if (!meta) continue;
    if (!l) {
      const s: StoredSound = { ...meta };
      await saveSound(s, { silent: true });
      localById.set(s.id, s);
      changed = true;
    } else if (r.updated_at > l.updatedAt) {
      const s: StoredSound = { ...meta, blob: l.blob };
      await saveSound(s, { silent: true });
      localById.set(s.id, s);
      changed = true;
    } else if (l.updatedAt > r.updated_at) {
      toPush.push(l);
    }
  }
  for (const l of local) if (!remoteIds.has(l.id)) toPush.push(l);

  // 中身がクラウドに無い音は上げる。上げられた音（と、もともと中身がある音）の行だけ送る
  let failure: unknown = null;
  for (const s of localById.values()) {
    if (!s.blob || objectSizes.has(s.id)) continue;
    soundCloud.uploading.add(s.id);
    emitSounds();
    try {
      await putSoundObject(s);
    } catch (e) {
      failure = failure ?? e;
    } finally {
      soundCloud.uploading.delete(s.id);
      emitSounds();
    }
  }
  await pushRows(
    "sounds",
    toPush.filter((s) => objectSizes.has(s.id)).map(soundRow),
  );
  if (changed) onSoundsChanged?.();

  // 端末に中身が無い音を取り寄せる（裏で。1つずつ）
  void downloadMissing([...localById.values()].filter((s) => !s.blob && objectSizes.has(s.id)).map((s) => s.id));
  if (failure) throw failure;
  return changed;
}

async function downloadMissing(ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!session || soundCloud.downloading.has(id)) continue;
    soundCloud.downloading.add(id);
    emitSounds();
    try {
      const { data, error } = await supabase.storage.from(SOUND_BUCKET).download(soundPath(id));
      if (error) throw error;
      const current = (await loadSounds()).find((s) => s.id === id);
      if (current && !current.blob) {
        await saveSound({ ...current, blob: data }, { silent: true });
        onSoundsChanged?.();
      }
    } catch (e) {
      soundCloud.message = describeSoundError(e);
    } finally {
      soundCloud.downloading.delete(id);
      emitSounds();
    }
  }
}

// --- 全体の突き合わせ（新しい方が勝つ） --------------------------------------------

async function fetchRemote(table: CloudTable): Promise<Row[]> {
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select("id,data,updated_at,deleted")
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data as Row[]));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

interface Syncable {
  id: string;
  updatedAt: number;
}

/** 戻り値は、端末内のデータが変わったかどうか。 */
async function reconcile<T extends Syncable>(
  table: CloudTable,
  local: T[],
  writeLocal: (item: T) => Promise<void>,
  deleteLocal: (id: string) => Promise<void>,
): Promise<boolean> {
  const remote = await fetchRemote(table);
  const localById = new Map(local.map((l) => [l.id, l]));
  const remoteIds = new Set<string>();
  const toPush: Row[] = [];
  let changed = false;

  for (const r of remote) {
    remoteIds.add(r.id);
    const l = localById.get(r.id);
    if (!l) {
      if (!r.deleted) {
        await writeLocal(r.data as T);
        changed = true;
      }
    } else if (r.updated_at > l.updatedAt) {
      if (r.deleted) await deleteLocal(r.id);
      else await writeLocal(r.data as T);
      changed = true;
    } else if (l.updatedAt > r.updated_at) {
      toPush.push({ id: l.id, data: l, updated_at: l.updatedAt, deleted: false });
    }
  }
  for (const l of local) {
    if (!remoteIds.has(l.id)) {
      toPush.push({ id: l.id, data: l, updated_at: l.updatedAt, deleted: false });
    }
  }
  await pushRows(table, toPush);
  return changed;
}

let syncing = false;

export async function syncAll(): Promise<void> {
  if (!session || syncing) return;
  syncing = true;
  setState({ ...state, status: "syncing", message: undefined });
  try {
    await flushPending();
    const phrasesChanged = await reconcile<Phrase>(
      "phrases",
      await loadAllPhrases(),
      (p) => savePhrase(p, { silent: true }),
      (id) => deletePhrase(id, { silent: true }),
    );
    const presetsChanged = await reconcile<UserPreset>(
      "presets",
      await loadUserPresets(),
      (p) => saveUserPreset(p, { silent: true }),
      (id) => deleteUserPreset(id, { silent: true }),
    );
    // 保存した曲はいちばん最後。テーブルがまだ無いときも、フレーズ・音色の同期は済んでいる
    const songsChanged = await reconcile<Song>(
      "songs",
      await loadSavedSongs().then((list) => list.map((s) => ({ ...migrateSong(s), id: s.id }))),
      (s) => saveSong({ ...migrateSong(s), id: s.id }, { silent: true }),
      (id) => deleteSong(id, { silent: true }),
    );
    if (phrasesChanged || presetsChanged || songsChanged) onSynced?.();
    // 音はいちばん最後。置き場がまだ無くても、ほかの同期は済んでいる
    try {
      await syncSounds();
      soundCloud.message = undefined;
    } catch (e) {
      soundCloud.message = describeSoundError(e);
    }
    emitSounds();
    setState({ ...state, status: "synced", message: undefined });
  } catch (e) {
    setState({ ...state, status: "error", message: describeError(e) });
  } finally {
    syncing = false;
  }
}

// --- ログイン ------------------------------------------------------------------

async function handleSession(next: Session | null): Promise<void> {
  session = next;
  if (!next) {
    objectSizes.clear();
    emitSounds();
    setState({ status: "signedOut", email: null });
    return;
  }
  setState({ status: "syncing", email: next.user.email ?? null });
  // 前にこの端末を使った人と別のアカウントなら、前の人のデータを新しい人のアカウントに混ぜない。
  const last = readLastUser();
  if (last && last !== next.user.id) {
    onCleared?.();
    await clearLocalData();
    onSynced?.();
  }
  writeLastUser(next.user.id);
  await syncAll();
}

export function initCloud(handlers: { onSynced: () => void; onCleared?: () => void; onSoundsChanged?: () => void }): void {
  onSynced = handlers.onSynced;
  onSoundsChanged = handlers.onSoundsChanged ?? null;
  onCleared = handlers.onCleared ?? null;
  supabase.auth.onAuthStateChange((_event, next) => {
    // コールバックの中でSupabaseを呼ぶと止まることがあるので、一拍置く。
    window.setTimeout(() => void handleSession(next), 0);
  });
  window.addEventListener("online", () => void syncAll());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncAll();
  });
}

export async function signInWithGoogle(): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) setState({ ...state, status: "error", message: describeError(error) });
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
