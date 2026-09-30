import { DEFAULT_VOLUME, MAX_VOLUME } from "../audio/layerSynths";
import { quantizeGrids } from "../phrase/quantize";
import { roleLabels, type Layer, type LayerRole, type Phrase } from "../phrase/types";

export interface LayerPanelHandlers {
  onAddLayer: (role: LayerRole) => void;
  onSelectActive: (layerId: string) => void;
  onToggleMute: (layerId: string) => void;
  onToggleSolo: (layerId: string) => void;
  onDeleteLayer: (layerId: string) => void;
  onVolumeChange: (layerId: string, volume: number) => void;
  onQuantizeChange: (layerId: string, gridBeats: number | undefined) => void;
}

export interface LayerPanel {
  el: HTMLElement;
  render: (phrase: Phrase | null, activeLayerId: string | null) => void;
}

export function buildLayerPanel(handlers: LayerPanelHandlers): LayerPanel {
  const root = document.createElement("div");
  root.className = "layer-panel";

  const list = document.createElement("div");
  list.className = "layer-list";

  const addRow = document.createElement("div");
  addRow.className = "layer-add-row";
  const roleSelect = document.createElement("select");
  for (const role of Object.keys(roleLabels) as LayerRole[]) {
    const opt = document.createElement("option");
    opt.value = role;
    opt.textContent = roleLabels[role];
    roleSelect.appendChild(opt);
  }
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "preset-button";
  addBtn.textContent = "レイヤー追加";
  addBtn.addEventListener("click", () => handlers.onAddLayer(roleSelect.value as LayerRole));
  addRow.append(roleSelect, addBtn);

  root.append(list, addRow);

  function render(phrase: Phrase | null, activeLayerId: string | null): void {
    list.innerHTML = "";
    if (!phrase || phrase.layers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "layer-empty";
      empty.textContent = "レイヤーがありません";
      list.appendChild(empty);
      return;
    }

    for (const layer of phrase.layers) {
      list.appendChild(renderLayerRow(layer, layer.id === activeLayerId));
    }
  }

  function renderLayerRow(layer: Layer, active: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "layer-row" + (active ? " active" : "");

    const activeRadio = document.createElement("input");
    activeRadio.type = "radio";
    activeRadio.name = "active-layer";
    activeRadio.checked = active;
    activeRadio.title = "録音対象にする";
    activeRadio.addEventListener("change", () => handlers.onSelectActive(layer.id));

    const label = document.createElement("span");
    label.className = "layer-role-label";
    label.textContent = `${roleLabels[layer.role]}${layer.generated ? "・候補" : ""}（${layer.notes.length}音）`;

    const muteBtn = document.createElement("button");
    muteBtn.type = "button";
    muteBtn.className = "layer-toggle" + (layer.muted ? " on" : "");
    muteBtn.textContent = "M";
    muteBtn.title = "ミュート";
    muteBtn.addEventListener("click", () => handlers.onToggleMute(layer.id));

    const soloBtn = document.createElement("button");
    soloBtn.type = "button";
    soloBtn.className = "layer-toggle" + (layer.solo ? " on" : "");
    soloBtn.textContent = "S";
    soloBtn.title = "ソロ";
    soloBtn.addEventListener("click", () => handlers.onToggleSolo(layer.id));

    const quantizeSelect = document.createElement("select");
    quantizeSelect.className = "quantize-select";
    const offOpt = document.createElement("option");
    offOpt.value = "";
    offOpt.textContent = "合わせる: オフ";
    if (!layer.quantizeGrid) offOpt.selected = true;
    quantizeSelect.appendChild(offOpt);
    for (const g of quantizeGrids) {
      const opt = document.createElement("option");
      opt.value = String(g.beats);
      opt.textContent = `合わせる: ${g.label}`;
      if (layer.quantizeGrid === g.beats) opt.selected = true;
      quantizeSelect.appendChild(opt);
    }
    quantizeSelect.addEventListener("change", () => {
      const v = quantizeSelect.value;
      handlers.onQuantizeChange(layer.id, v === "" ? undefined : Number(v));
    });

    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "layer-volume";
    volume.min = "0";
    volume.max = String(MAX_VOLUME);
    volume.step = "0.05";
    volume.value = String(layer.volume ?? DEFAULT_VOLUME);
    volume.title = `音量 ${Math.round((layer.volume ?? DEFAULT_VOLUME) * 100)}%`;
    volume.addEventListener("input", () => {
      volume.title = `音量 ${Math.round(Number(volume.value) * 100)}%`;
      handlers.onVolumeChange(layer.id, Number(volume.value));
    });
    // スライダーの上で指を動かしても、行の選択やスクロールに取られないようにする
    volume.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "layer-toggle";
    deleteBtn.textContent = "削除";
    deleteBtn.addEventListener("click", () => handlers.onDeleteLayer(layer.id));

    row.append(activeRadio, label, volume, muteBtn, soloBtn, quantizeSelect, deleteBtn);
    return row;
  }

  return { el: root, render };
}
