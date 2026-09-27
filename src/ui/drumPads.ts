import { drumList, type DrumId } from "../audio/drums";

export function buildDrumPads(onHit: (id: DrumId) => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "drum-pads";

  for (const drum of drumList) {
    const pad = document.createElement("button");
    pad.type = "button";
    pad.className = "drum-pad";
    pad.textContent = drum.label;
    const trigger = () => {
      pad.classList.add("hit");
      window.setTimeout(() => pad.classList.remove("hit"), 120);
      onHit(drum.id);
    };
    pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      trigger();
    });
    root.appendChild(pad);
  }

  return root;
}
