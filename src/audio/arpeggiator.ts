export type ArpMode = "up" | "down" | "updown" | "random";

export interface ArpSettings {
  enabled: boolean;
  mode: ArpMode;
  /** 1拍を何分割するか。1=4分音符、2=8分、4=16分、3=8分3連。 */
  stepsPerBeat: number;
  octaves: 1 | 2 | 3 | 4;
  /** 音の長さ（1ステップに対する割合 0.1〜1） */
  gate: number;
}

export const defaultArpSettings: ArpSettings = {
  enabled: false,
  mode: "up",
  stepsPerBeat: 2,
  octaves: 2,
  gate: 0.6,
};

export interface ArpCallbacks {
  noteOn: (pitch: number) => void;
  noteOff: (pitch: number) => void;
  getBpm: () => number;
}

const TICK_MS = 10;

/**
 * アルペジエーター。特定の楽器には依存せず、「押されている音」を受け取って
 * 「鳴らす/止める」コールバックを呼ぶだけの独立した部品。
 * どの楽器に挿すかは呼び出し側（コールバックの中身）で決める。
 */
export class Arpeggiator {
  settings: ArpSettings = { ...defaultArpSettings };

  private readonly ctx: AudioContext;
  private readonly cb: ArpCallbacks;
  private held: number[] = []; // 押された順
  private timer: number | null = null;
  private nextStepTime = 0;
  private stepIndex = 0;
  private direction = 1;
  private sounding: number | null = null;
  private offTime = 0;

  constructor(ctx: AudioContext, callbacks: ArpCallbacks) {
    this.ctx = ctx;
    this.cb = callbacks;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  update(patch: Partial<ArpSettings>): void {
    const wasEnabled = this.settings.enabled;
    this.settings = { ...this.settings, ...patch };
    if (wasEnabled && !this.settings.enabled) this.release();
  }

  press(pitch: number): void {
    if (this.held.includes(pitch)) return;
    const wasEmpty = this.held.length === 0;
    this.held.push(pitch);
    if (wasEmpty) this.begin();
  }

  unpress(pitch: number): void {
    this.held = this.held.filter((p) => p !== pitch);
    if (this.held.length === 0) this.release();
  }

  /** 押されている音をすべて忘れて止める（ウィンドウのフォーカス喪失時など）。 */
  release(): void {
    this.held = [];
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.endSounding();
  }

  private begin(): void {
    this.stepIndex = 0;
    this.direction = 1;
    this.nextStepTime = this.ctx.currentTime;
    if (this.timer === null) this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private endSounding(): void {
    if (this.sounding !== null) {
      this.cb.noteOff(this.sounding);
      this.sounding = null;
    }
  }

  private tick(): void {
    const now = this.ctx.currentTime;
    if (this.sounding !== null && now >= this.offTime) this.endSounding();
    if (now < this.nextStepTime) return;

    const pool = this.pool();
    if (pool.length === 0) return;

    const stepSeconds = 60 / this.cb.getBpm() / this.settings.stepsPerBeat;
    const pitch = this.pick(pool);
    // 前の音が残っていたら先に止めてから鳴らす（同じ音でも録音が壊れないように）
    this.endSounding();
    this.sounding = pitch;
    this.cb.noteOn(pitch);
    this.offTime = now + stepSeconds * this.settings.gate;
    // 遅れが溜まっても連打にならないよう、次のステップは今からの相対で決める
    this.nextStepTime = Math.max(this.nextStepTime + stepSeconds, now + stepSeconds * 0.5);
  }

  private pool(): number[] {
    const base = [...this.held].sort((a, b) => a - b);
    const out: number[] = [];
    for (let o = 0; o < this.settings.octaves; o++) {
      for (const p of base) out.push(p + o * 12);
    }
    return out;
  }

  private pick(pool: number[]): number {
    const n = pool.length;
    switch (this.settings.mode) {
      case "up": {
        const p = pool[this.stepIndex % n];
        this.stepIndex = (this.stepIndex + 1) % n;
        return p;
      }
      case "down": {
        const p = pool[n - 1 - (this.stepIndex % n)];
        this.stepIndex = (this.stepIndex + 1) % n;
        return p;
      }
      case "updown": {
        if (n === 1) return pool[0];
        // 端の音は2回続けて鳴らさず、折り返す
        if (this.stepIndex >= n) {
          this.stepIndex = n - 2;
          this.direction = -1;
        }
        if (this.stepIndex < 0) {
          this.stepIndex = 1;
          this.direction = 1;
        }
        const p = pool[this.stepIndex];
        this.stepIndex += this.direction;
        return p;
      }
      case "random":
        return pool[Math.floor(Math.random() * n)];
    }
  }
}
