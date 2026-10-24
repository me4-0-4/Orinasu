import type { SynthParams } from "../audio/synthParams";
import type { Phrase } from "../phrase/types";
import { isSavedSongId, type Song } from "../mix/types";
import type { StoredSound } from "../sound/types";

export interface UserPreset {
  id: string;
  name: string;
  params: SynthParams;
  updatedAt: number;
}

/** 端末内に保存・削除したときの通知口。クラウド同期が使う。 */
export const storageHooks: {
  phraseSaved?: (phrase: Phrase) => void;
  phraseDeleted?: (id: string) => void;
  presetSaved?: (preset: UserPreset) => void;
  presetDeleted?: (id: string) => void;
  /** 名前を付けて残した曲だけ通知する（作業中の曲は同期しない）。 */
  songSaved?: (song: Song) => void;
  songDeleted?: (id: string) => void;
  /** 新しく読み込んだ音（中身ごとクラウドへ上げる）。 */
  soundAdded?: (sound: StoredSound) => void;
  /** 音の情報（名前・テンポなど）だけ変えた。 */
  soundUpdated?: (sound: StoredSound) => void;
  soundDeleted?: (id: string) => void;
} = {};

/** silent: true にすると通知しない（クラウドから取り込んだデータを書くときに使う）。 */
export interface WriteOptions {
  silent?: boolean;
}

const DB_NAME = "orinasu";
const DB_VERSION = 5;
const STORE = "phrases";
const PRESET_STORE = "presets";
const SONG_STORE = "songs";
/** 映像の素材（写真・動画）。重いので端末の中だけに置く（クラウドには上げない）。 */
const MATERIAL_STORE = "materials";
/** 読み込んだ音（サンプラーなどの材料）。中身もクラウドに上げる。 */
const SOUND_STORE = "sounds";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PRESET_STORE)) {
        db.createObjectStore(PRESET_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SONG_STORE)) {
        db.createObjectStore(SONG_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MATERIAL_STORE)) {
        db.createObjectStore(MATERIAL_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SOUND_STORE)) {
        db.createObjectStore(SOUND_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePhrase(phrase: Phrase, opts: WriteOptions = {}): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(phrase);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  if (!opts.silent) storageHooks.phraseSaved?.(phrase);
}

export async function deletePhrase(id: string, opts: WriteOptions = {}): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  if (!opts.silent) storageHooks.phraseDeleted?.(id);
}

export async function loadAllPhrases(): Promise<Phrase[]> {
  const db = await openDb();
  const result = await new Promise<Phrase[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as Phrase[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveUserPreset(preset: UserPreset, opts: WriteOptions = {}): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, "readwrite");
    tx.objectStore(PRESET_STORE).put(preset);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  if (!opts.silent) storageHooks.presetSaved?.(preset);
}

export async function deleteUserPreset(id: string, opts: WriteOptions = {}): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, "readwrite");
    tx.objectStore(PRESET_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  if (!opts.silent) storageHooks.presetDeleted?.(id);
}

export async function loadUserPresets(): Promise<UserPreset[]> {
  const db = await openDb();
  const result = await new Promise<UserPreset[]>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, "readonly");
    const req = tx.objectStore(PRESET_STORE).getAll();
    req.onsuccess = () => resolve(req.result as UserPreset[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result.sort((a, b) => a.updatedAt - b.updatedAt);
}

/**
 * 刻んだ曲（選んだ曲・BPM・刻み方の計画）。いまは端末内だけに保存する（クラウド同期は未対応）。
 * 作業中の曲（SONG_ID）も、名前を付けて残した曲（saved_…）も、同じ保存場所に入れる。
 */
export async function saveSong(song: Song, opts: WriteOptions = {}): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SONG_STORE, "readwrite");
    tx.objectStore(SONG_STORE).put(song);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  if (!opts.silent && isSavedSongId(song.id)) storageHooks.songSaved?.(song);
}

export async function loadSong(id: string): Promise<Song | null> {
  const db = await openDb();
  const result = await new Promise<Song | null>((resolve, reject) => {
    const req = db.transaction(SONG_STORE, "readonly").objectStore(SONG_STORE).get(id);
    req.onsuccess = () => resolve((req.result as Song | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

/** 名前を付けて残した曲を、新しい順に全部読む（作業中の曲は含めない）。 */
export async function loadSavedSongs(): Promise<Song[]> {
  const db = await openDb();
  const result = await new Promise<Song[]>((resolve, reject) => {
    const req = db.transaction(SONG_STORE, "readonly").objectStore(SONG_STORE).getAll();
    req.onsuccess = () => resolve(req.result as Song[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result.filter((s) => isSavedSongId(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSong(id: string, opts: WriteOptions = {}): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SONG_STORE, "readwrite");
    tx.objectStore(SONG_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  if (!opts.silent && isSavedSongId(id)) storageHooks.songDeleted?.(id);
}

/** 端末内のフレーズと自分の音色を全部消す。別のアカウントでログインしたときに前の人のデータを残さないために使う。 */
export async function clearLocalData(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, PRESET_STORE, SONG_STORE, MATERIAL_STORE, SOUND_STORE], "readwrite");
    tx.objectStore(MATERIAL_STORE).clear();
    tx.objectStore(SOUND_STORE).clear();
    tx.objectStore(STORE).clear();
    tx.objectStore(PRESET_STORE).clear();
    tx.objectStore(SONG_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** 映像の素材（写真・動画）1つ。 */
export interface StoredMaterial {
  id: string;
  name: string;
  kind: "image" | "video";
  blob: Blob;
  /** どの音で出すか。null＝どれでも。 */
  tr: "chop" | "drum" | null;
  /** 素材パネル用の画像なら、そのパネルの id（素材の棚には並べない）。 */
  panelId?: number;
  createdAt: number;
}

export async function saveMaterial(m: StoredMaterial): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MATERIAL_STORE, "readwrite");
    tx.objectStore(MATERIAL_STORE).put(m);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function deleteMaterial(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MATERIAL_STORE, "readwrite");
    tx.objectStore(MATERIAL_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadMaterials(): Promise<StoredMaterial[]> {
  const db = await openDb();
  const result = await new Promise<StoredMaterial[]>((resolve, reject) => {
    const tx = db.transaction(MATERIAL_STORE, "readonly");
    const req = tx.objectStore(MATERIAL_STORE).getAll();
    req.onsuccess = () => resolve(req.result as StoredMaterial[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result.sort((a, b) => a.createdAt - b.createdAt);
}

/** silent でなければ、added＝新しい音（中身ごと上げる）、そうでなければ情報だけ変えた、として通知する。 */
export async function saveSound(sound: StoredSound, opts: WriteOptions & { added?: boolean } = {}): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SOUND_STORE, "readwrite");
    tx.objectStore(SOUND_STORE).put(sound);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  if (opts.silent) return;
  if (opts.added) storageHooks.soundAdded?.(sound);
  else storageHooks.soundUpdated?.(sound);
}

export async function deleteSound(id: string, opts: WriteOptions = {}): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SOUND_STORE, "readwrite");
    tx.objectStore(SOUND_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  if (!opts.silent) storageHooks.soundDeleted?.(id);
}

/** 読み込んだ音を、古い順に全部。 */
export async function loadSounds(): Promise<StoredSound[]> {
  const db = await openDb();
  const result = await new Promise<StoredSound[]>((resolve, reject) => {
    const req = db.transaction(SOUND_STORE, "readonly").objectStore(SOUND_STORE).getAll();
    req.onsuccess = () => resolve(req.result as StoredSound[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result.sort((a, b) => a.createdAt - b.createdAt);
}
