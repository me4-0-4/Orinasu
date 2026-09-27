import type { Phrase } from "../phrase/types";

export interface PhraseBrowserHandlers {
  onNew: () => void;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSave: () => void;
}

export interface PhraseBrowser {
  el: HTMLElement;
  render: (phrases: Phrase[], currentId: string | null) => void;
}

export function buildPhraseBrowser(handlers: PhraseBrowserHandlers): PhraseBrowser {
  const root = document.createElement("div");
  root.className = "phrase-browser";

  const heading = document.createElement("div");
  heading.className = "panel-heading";
  heading.textContent = "フレーズ";

  const buttonRow = document.createElement("div");
  buttonRow.className = "preset-row";
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "preset-button";
  newBtn.textContent = "新規";
  newBtn.addEventListener("click", handlers.onNew);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "preset-button";
  saveBtn.textContent = "保存";
  saveBtn.addEventListener("click", handlers.onSave);

  buttonRow.append(newBtn, saveBtn);

  const list = document.createElement("div");
  list.className = "phrase-list";

  root.append(heading, buttonRow, list);

  function render(phrases: Phrase[], currentId: string | null): void {
    list.innerHTML = "";
    if (phrases.length === 0) {
      const empty = document.createElement("div");
      empty.className = "layer-empty";
      empty.textContent = "保存されたフレーズはありません";
      list.appendChild(empty);
      return;
    }
    for (const phrase of phrases) {
      const row = document.createElement("div");
      row.className = "phrase-row" + (phrase.id === currentId ? " active" : "");

      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "phrase-name-button";
      nameBtn.textContent = `${phrase.name}（${phrase.lengthBars}小節 / ${phrase.bpm}BPM）`;
      nameBtn.addEventListener("click", () => handlers.onLoad(phrase.id));

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "layer-toggle";
      renameBtn.textContent = "名前変更";
      renameBtn.addEventListener("click", () => {
        const name = window.prompt("フレーズ名", phrase.name);
        if (name) handlers.onRename(phrase.id, name);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "layer-toggle";
      deleteBtn.textContent = "削除";
      deleteBtn.addEventListener("click", () => handlers.onDelete(phrase.id));

      row.append(nameBtn, renameBtn, deleteBtn);
      list.appendChild(row);
    }
  }

  return { el: root, render };
}
