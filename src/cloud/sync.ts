import type { Session } from "@supabase/supabase-js";
import type { Phrase } from "../phrase/types";
import {
  clearLocalData,
  deletePhrase,
  deleteUserPreset,
  loadAllPhrases,
  loadUserPresets,
  savePhrase,
  saveUserPreset,
  storageHooks,
  type UserPreset,
} from "../storage/db";
import { supabase, type CloudTable } from "./client";

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
    for (const table of ["phrases", "presets"] as const) {
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
    setState({ ...state, status: "synced", message: undefined });
    if (phrasesChanged || presetsChanged) onSynced?.();
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

export function initCloud(handlers: { onSynced: () => void; onCleared?: () => void }): void {
  onSynced = handlers.onSynced;
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
