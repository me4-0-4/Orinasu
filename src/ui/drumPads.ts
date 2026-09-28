import { drumList, type DrumId } from "../audio/drums";
import { drumKeyMap } from "../input/keymap";

const drumIdToKey: Partial<Record<DrumId, string>> = Object.fromEntries(
  Object.entries(drumKeyMap).map(([key, id]) => [id, key]),
);

export interface DrumPads {
  el: HTMLElement;
  /** キーボード操作など、外部からの発音に合わせてパッドを光らせる。 */
  flash: (id: DrumId) => void;
}

export function buildDrumPads(onHit: (id: DrumId) => void): DrumPads {
  const root = document.createElement("div");
  root.className = "drum-pads";
  const padEls = new Map<DrumId, HTMLButtonElement>();

  for (const drum of drumList) {
    const pad = document.createElement("button");
    pad.type = "button";
    pad.className = "drum-pad";

    const label = document.createElement("span");
    label.textContent = drum.label;
    pad.appendChild(label);

    const key = drumIdToKey[drum.id];
    if (key) {
      const keyLabel = document.createElement("span");
      keyLabel.className = "drum-pad-key";
      keyLabel.textContent = key;
      pad.appendChild(keyLabel);
    }

    const trigger = () => {
      pad.classList.add("hit");
      window.setTimeout(() => pad.classList.remove("hit"), 120);
      onHit(drum.id);
    };
    pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      trigger();
    });
    padEls.set(drum.id, pad);
    root.appendChild(pad);
  }

  return {
    el: root,
    flash: (id) => {
      const pad = padEls.get(id);
      if (!pad) return;
      pad.classList.add("hit");
      window.setTimeout(() => pad.classList.remove("hit"), 120);
    },
  };
}
