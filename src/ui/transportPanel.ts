export interface TransportPanelHandlers {
  onBpmChange: (bpm: number) => void;
  onBeatsPerBarChange: (n: number) => void;
  onLengthChange: (bars: 1 | 2 | 4) => void;
  onRecord: () => void;
  onPlay: () => void;
  onStop: () => void;
  onMetronomeToggle: (enabled: boolean) => void;
}

export interface TransportPanel {
  el: HTMLElement;
  setStatus: (text: string) => void;
  setButtonsEnabled: (opts: { recording: boolean; playing: boolean }) => void;
  setValues: (values: { bpm: number; beatsPerBar: number; lengthBars: 1 | 2 | 4 }) => void;
}

function numberField(
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (v: number) => void,
): { el: HTMLElement; input: HTMLInputElement } {
  const wrap = document.createElement("div");
  wrap.className = "select-field";
  const title = document.createElement("label");
  title.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.className = "number-input";
  input.addEventListener("change", () => {
    const n = Math.min(max, Math.max(min, Number(input.value) || value));
    input.value = String(n);
    onChange(n);
  });
  wrap.append(title, input);
  return { el: wrap, input };
}

export function buildTransportPanel(
  initial: { bpm: number; beatsPerBar: number; lengthBars: 1 | 2 | 4 },
  handlers: TransportPanelHandlers,
): TransportPanel {
  const root = document.createElement("div");
  root.className = "transport-panel";

  const bpmField = numberField("BPM", initial.bpm, 40, 240, handlers.onBpmChange);
  const beatsField = numberField(
    "拍子（1小節の拍数）",
    initial.beatsPerBar,
    2,
    12,
    handlers.onBeatsPerBarChange,
  );

  const lengthWrap = document.createElement("div");
  lengthWrap.className = "select-field";
  const lengthTitle = document.createElement("label");
  lengthTitle.textContent = "長さ";
  const lengthSelect = document.createElement("select");
  for (const bars of [1, 2, 4] as const) {
    const opt = document.createElement("option");
    opt.value = String(bars);
    opt.textContent = `${bars}小節`;
    if (bars === initial.lengthBars) opt.selected = true;
    lengthSelect.appendChild(opt);
  }
  lengthSelect.addEventListener("change", () => {
    handlers.onLengthChange(Number(lengthSelect.value) as 1 | 2 | 4);
  });
  lengthWrap.append(lengthTitle, lengthSelect);

  const fieldsRow = document.createElement("div");
  fieldsRow.className = "knob-row";
  fieldsRow.append(bpmField.el, beatsField.el, lengthWrap);

  const buttonsRow = document.createElement("div");
  buttonsRow.className = "transport-buttons";

  const recordBtn = document.createElement("button");
  recordBtn.type = "button";
  recordBtn.className = "transport-button record";
  recordBtn.textContent = "録音";
  recordBtn.addEventListener("click", handlers.onRecord);

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "transport-button";
  playBtn.textContent = "再生";
  playBtn.addEventListener("click", handlers.onPlay);

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "transport-button";
  stopBtn.textContent = "停止";
  stopBtn.addEventListener("click", handlers.onStop);

  const metronomeLabel = document.createElement("label");
  metronomeLabel.className = "metronome-toggle";
  const metronomeCheckbox = document.createElement("input");
  metronomeCheckbox.type = "checkbox";
  metronomeCheckbox.checked = true;
  metronomeCheckbox.addEventListener("change", () =>
    handlers.onMetronomeToggle(metronomeCheckbox.checked),
  );
  metronomeLabel.append(metronomeCheckbox, document.createTextNode(" メトロノーム"));

  buttonsRow.append(recordBtn, playBtn, stopBtn, metronomeLabel);

  const status = document.createElement("div");
  status.className = "transport-status";
  status.textContent = "停止中";

  root.append(fieldsRow, buttonsRow, status);

  return {
    el: root,
    setStatus: (text: string) => {
      status.textContent = text;
    },
    setButtonsEnabled: ({ recording, playing }) => {
      recordBtn.classList.toggle("active", recording);
      playBtn.classList.toggle("active", playing && !recording);
    },
    setValues: ({ bpm, beatsPerBar, lengthBars }) => {
      bpmField.input.value = String(bpm);
      beatsField.input.value = String(beatsPerBar);
      lengthSelect.value = String(lengthBars);
    },
  };
}
