import { computeFilterCurve } from "../audio/filterResponse";
import type { SynthParams } from "../audio/synthParams";

function makeCanvas(label: string): { wrap: HTMLElement; canvas: HTMLCanvasElement } {
  const wrap = document.createElement("div");
  wrap.className = "viz-cell";
  const title = document.createElement("div");
  title.className = "viz-label";
  title.textContent = label;
  const canvas = document.createElement("canvas");
  canvas.className = "viz-canvas";
  wrap.appendChild(title);
  wrap.appendChild(canvas);
  return { wrap, canvas };
}

function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(rect.width, 120);
  const h = Math.max(rect.height, 80);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export class Visualizer {
  readonly el: HTMLElement;
  private readonly waveform: HTMLCanvasElement;
  private readonly spectrum: HTMLCanvasElement;
  private readonly filterCurve: HTMLCanvasElement;
  private readonly envelope: HTMLCanvasElement;
  private timeData: Uint8Array;
  private freqData: Uint8Array;
  private rafId = 0;
  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly getParams: () => SynthParams;

  constructor(ctx: AudioContext, analyser: AnalyserNode, getParams: () => SynthParams) {
    this.ctx = ctx;
    this.analyser = analyser;
    this.getParams = getParams;

    this.el = document.createElement("div");
    this.el.className = "visualizer-grid";

    const w1 = makeCanvas("波形");
    const w2 = makeCanvas("スペクトラム");
    const w3 = makeCanvas("フィルター特性");
    const w4 = makeCanvas("アンプ・エンベロープ");
    this.el.append(w1.wrap, w2.wrap, w3.wrap, w4.wrap);

    this.waveform = w1.canvas;
    this.spectrum = w2.canvas;
    this.filterCurve = w3.canvas;
    this.envelope = w4.canvas;

    this.timeData = new Uint8Array(analyser.fftSize);
    this.freqData = new Uint8Array(analyser.frequencyBinCount);

    window.addEventListener("resize", () => this.drawStatic());
  }

  start(): void {
    const loop = () => {
      this.drawWaveform();
      this.drawSpectrum();
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
    this.drawStatic();
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  /** ツマミが変わったときに呼ぶ（フィルター特性・エンベロープ形状を再描画） */
  drawStatic(): void {
    this.drawFilterCurve();
    this.drawEnvelope();
  }

  private drawWaveform(): void {
    const ctx = fitCanvas(this.waveform);
    const rect = this.waveform.getBoundingClientRect();
    const w = Math.max(rect.width, 120);
    const h = Math.max(rect.height, 80);
    this.analyser.getByteTimeDomainData(this.timeData as any);

    ctx.fillStyle = "#0c0d12";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#3ee6b0";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const step = w / this.timeData.length;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = this.timeData[i] / 128 - 1;
      const y = h / 2 + (v * h) / 2.2;
      const x = i * step;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private drawSpectrum(): void {
    const ctx = fitCanvas(this.spectrum);
    const rect = this.spectrum.getBoundingClientRect();
    const w = Math.max(rect.width, 120);
    const h = Math.max(rect.height, 80);
    this.analyser.getByteFrequencyData(this.freqData as any);

    ctx.fillStyle = "#0c0d12";
    ctx.fillRect(0, 0, w, h);
    const barCount = 64;
    const binsPerBar = Math.floor(this.freqData.length / barCount);
    const barWidth = w / barCount;
    ctx.fillStyle = "#ff6f4d";
    for (let i = 0; i < barCount; i++) {
      let sum = 0;
      for (let j = 0; j < binsPerBar; j++) sum += this.freqData[i * binsPerBar + j];
      const avg = sum / binsPerBar / 255;
      const barH = avg * h;
      ctx.fillRect(i * barWidth + 1, h - barH, barWidth - 2, barH);
    }
  }

  private drawFilterCurve(): void {
    const ctx = fitCanvas(this.filterCurve);
    const rect = this.filterCurve.getBoundingClientRect();
    const w = Math.max(rect.width, 120);
    const h = Math.max(rect.height, 80);
    const params = this.getParams();

    ctx.fillStyle = "#0c0d12";
    ctx.fillRect(0, 0, w, h);

    const { freqs, magDb } = computeFilterCurve(
      this.ctx,
      params.filter.type,
      params.filter.cutoff,
      params.filter.resonance,
    );

    ctx.strokeStyle = "#5eb4ff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const minDb = -36;
    const maxDb = 18;
    for (let i = 0; i < freqs.length; i++) {
      const x = (i / (freqs.length - 1)) * w;
      const t = (magDb[i] - minDb) / (maxDb - minDb);
      const y = h - Math.min(1, Math.max(0, t)) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // カットオフの位置に目印
    const cutoffT =
      (Math.log10(params.filter.cutoff) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20));
    ctx.strokeStyle = "#5eb4ff55";
    ctx.beginPath();
    ctx.moveTo(cutoffT * w, 0);
    ctx.lineTo(cutoffT * w, h);
    ctx.stroke();
  }

  private drawEnvelope(): void {
    const ctx = fitCanvas(this.envelope);
    const rect = this.envelope.getBoundingClientRect();
    const w = Math.max(rect.width, 120);
    const h = Math.max(rect.height, 80);
    const { attack, decay, sustain, release } = this.getParams().ampEnv;

    ctx.fillStyle = "#0c0d12";
    ctx.fillRect(0, 0, w, h);

    const holdSeconds = 0.3;
    const total = attack + decay + holdSeconds + release || 1;
    const ax = (attack / total) * w;
    const dx = ax + (decay / total) * w;
    const hx = dx + (holdSeconds / total) * w;
    const rx = hx + (release / total) * w;

    const y0 = h - 4;
    const yPeak = 4;
    const ySustain = h - 4 - sustain * (h - 8);

    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(ax, yPeak);
    ctx.lineTo(dx, ySustain);
    ctx.lineTo(hx, ySustain);
    ctx.lineTo(rx, y0);
    ctx.stroke();
  }
}
