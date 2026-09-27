export interface KnobOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  curve?: "linear" | "log";
  unit?: string;
  decimals?: number;
  onChange: (value: number) => void;
}

const SIZE = 48;
const START_ANGLE = -135; // 度
const END_ANGLE = 135;

export class Knob {
  readonly el: HTMLElement;
  private value: number;
  private readonly opts: Required<Omit<KnobOptions, "onChange">> & {
    onChange: (v: number) => void;
  };
  private readonly dial: HTMLElement;
  private readonly valueLabel: HTMLElement;
  private dragStartY = 0;
  private dragStartValue = 0;
  private dragging = false;

  constructor(opts: KnobOptions) {
    this.opts = {
      step: opts.step ?? (opts.max - opts.min) / 200,
      curve: opts.curve ?? "linear",
      unit: opts.unit ?? "",
      decimals: opts.decimals ?? 2,
      ...opts,
    };
    this.value = clamp(opts.value, opts.min, opts.max);

    this.el = document.createElement("div");
    this.el.className = "knob";

    const title = document.createElement("div");
    title.className = "knob-label";
    title.textContent = opts.label;

    this.dial = document.createElement("div");
    this.dial.className = "knob-dial";
    this.dial.style.setProperty("--size", `${SIZE}px`);

    const indicator = document.createElement("div");
    indicator.className = "knob-indicator";
    this.dial.appendChild(indicator);

    this.valueLabel = document.createElement("div");
    this.valueLabel.className = "knob-value";

    this.el.appendChild(this.dial);
    this.el.appendChild(title);
    this.el.appendChild(this.valueLabel);

    this.dial.addEventListener("pointerdown", this.onPointerDown);
    this.updateVisual();
  }

  setValue(value: number, notify = false): void {
    this.value = clamp(value, this.opts.min, this.opts.max);
    this.updateVisual();
    if (notify) this.opts.onChange(this.value);
  }

  getValue(): number {
    return this.value;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.dragStartY = e.clientY;
    this.dragStartValue = this.toNormalized(this.value);
    this.dial.setPointerCapture(e.pointerId);
    this.dial.addEventListener("pointermove", this.onPointerMove);
    this.dial.addEventListener("pointerup", this.onPointerUp);
    this.dial.addEventListener("pointercancel", this.onPointerUp);
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const deltaY = this.dragStartY - e.clientY;
    const range = 180; // 180pxのドラッグで全域が動く
    const normalized = clamp(this.dragStartValue + deltaY / range, 0, 1);
    const raw = this.fromNormalized(normalized);
    const stepped = Math.round(raw / this.opts.step) * this.opts.step;
    this.setValue(stepped, true);
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.dragging = false;
    this.dial.releasePointerCapture(e.pointerId);
    this.dial.removeEventListener("pointermove", this.onPointerMove);
    this.dial.removeEventListener("pointerup", this.onPointerUp);
    this.dial.removeEventListener("pointercancel", this.onPointerUp);
  };

  private toNormalized(value: number): number {
    const { min, max, curve } = this.opts;
    if (curve === "log") {
      const logMin = Math.log(Math.max(min, 1e-6));
      const logMax = Math.log(Math.max(max, 1e-6));
      return (Math.log(Math.max(value, 1e-6)) - logMin) / (logMax - logMin);
    }
    return (value - min) / (max - min);
  }

  private fromNormalized(t: number): number {
    const { min, max, curve } = this.opts;
    if (curve === "log") {
      const logMin = Math.log(Math.max(min, 1e-6));
      const logMax = Math.log(Math.max(max, 1e-6));
      return Math.exp(logMin + t * (logMax - logMin));
    }
    return min + t * (max - min);
  }

  private updateVisual(): void {
    const t = this.toNormalized(this.value);
    const angle = START_ANGLE + t * (END_ANGLE - START_ANGLE);
    this.dial.style.setProperty("--angle", `${angle}deg`);
    this.valueLabel.textContent = `${this.value.toFixed(this.opts.decimals)}${this.opts.unit}`;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
