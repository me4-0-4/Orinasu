import type { SynthParams } from "../audio/synthParams";
import type { Phrase } from "../phrase/types";

export interface UserPreset {
  id: string;
  name: string;
  params: SynthParams;
  updatedAt: number;
}

const DB_NAME = "orinasu";
const DB_VERSION = 2;
const STORE = "phrases";
const PRESET_STORE = "presets";

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePhrase(phrase: Phrase): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(phrase);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function deletePhrase(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
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

export async function saveUserPreset(preset: UserPreset): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, "readwrite");
    tx.objectStore(PRESET_STORE).put(preset);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function deleteUserPreset(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, "readwrite");
    tx.objectStore(PRESET_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
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
