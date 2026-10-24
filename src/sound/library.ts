import { deleteSound, loadSounds, saveSound } from "../storage/db";
import { makeId } from "../phrase/types";
import {
  MAX_SOUND_BYTES,
  computePeaks,
  firstSoundSec,
  formatBytes,
  soundNameFromFile,
  type SoundMeta,
  type StoredSound,
} from "./types";

/**
 * 読み込んだ音の棚。端末の中の音の一覧と、音にした中身（AudioBuffer）の覚え書きを持つ。
 * サンプラー・刻む・曲に置く、のどれもここから音を取る。
 */
export class SoundLibrary {
  sounds: StoredSound[] = [];
  private readonly ctx: BaseAudioContext;
  private readonly buffers = new Map<string, { blob: Blob; buffer: Promise<AudioBuffer> }>();
  private readonly listeners = new Set<() => void>();

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
  }

  subscribe(fn: () => void): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get(id: string): StoredSound | undefined {
    return this.sounds.find((s) => s.id === id);
  }

  async reload(): Promise<void> {
    this.sounds = await loadSounds();
    const alive = new Set(this.sounds.map((s) => s.id));
    for (const id of this.buffers.keys()) if (!alive.has(id)) this.buffers.delete(id);
    this.emit();
  }

  /** ファイルを読み込んで棚に足す。読めなかったファイルは、理由を返す。 */
  async addFiles(files: File[]): Promise<{ added: StoredSound[]; errors: string[] }> {
    const added: StoredSound[] = [];
    const errors: string[] = [];
    for (const file of files) {
      if (file.size > MAX_SOUND_BYTES) {
        errors.push(`${file.name}：大きすぎます（${formatBytes(file.size)}。${formatBytes(MAX_SOUND_BYTES)}まで）`);
        continue;
      }
      let buffer: AudioBuffer;
      try {
        buffer = await this.ctx.decodeAudioData(await file.arrayBuffer());
      } catch {
        errors.push(`${file.name}：音として読めませんでした`);
        continue;
      }
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
      const now = Date.now();
      const sound: StoredSound = {
        id: makeId("sound"),
        name: soundNameFromFile(file.name),
        mime: file.type,
        bytes: file.size,
        durationSec: buffer.duration,
        channels: buffer.numberOfChannels,
        sampleRate: buffer.sampleRate,
        peaks: computePeaks(channels),
        // 頭の無音は飛ばして、最初の音を1拍目にしておく（あとで動かせる）
        downbeatSec: firstSoundSec(channels, buffer.sampleRate),
        createdAt: now,
        updatedAt: now,
        blob: file,
      };
      this.buffers.set(sound.id, { blob: file, buffer: Promise.resolve(buffer) });
      await saveSound(sound, { added: true });
      added.push(sound);
    }
    await this.reload();
    return { added, errors };
  }

  /** 名前・テンポなど、情報だけ変える。 */
  async update(id: string, patch: Partial<Omit<SoundMeta, "id" | "createdAt">>): Promise<void> {
    const s = this.get(id);
    if (!s) return;
    const next: StoredSound = { ...s, ...patch, updatedAt: Date.now() };
    this.sounds = this.sounds.map((x) => (x.id === id ? next : x));
    this.emit();
    await saveSound(next);
  }

  async remove(id: string): Promise<void> {
    this.buffers.delete(id);
    this.sounds = this.sounds.filter((s) => s.id !== id);
    this.emit();
    await deleteSound(id);
  }

  /** 音の中身。端末にまだ無い（クラウドから取り寄せ中）・読めないときは null。 */
  async buffer(id: string): Promise<AudioBuffer | null> {
    const s = this.get(id);
    if (!s?.blob) return null;
    const cached = this.buffers.get(id);
    if (cached && cached.blob === s.blob) return cached.buffer.catch(() => null);
    const blob = s.blob;
    const buffer = blob.arrayBuffer().then((data) => this.ctx.decodeAudioData(data));
    this.buffers.set(id, { blob, buffer });
    return buffer.catch(() => null);
  }
}
