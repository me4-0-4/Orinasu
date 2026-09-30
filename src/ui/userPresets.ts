import type { UserPreset } from "../storage/db";

export interface UserPresetsHandlers {
  onApply: (preset: UserPreset) => void;
  onSave: (name: string) => void;
  onDelete: (preset: UserPreset) => void;
}

export interface UserPresetsUi {
  el: HTMLElement;
  render: (presets: UserPreset[]) => void;
}

/** 自分で作った音色の保存・呼び出し。いま編集中の層の音色を、名前を付けて保存する。 */
export function buildUserPresets(handlers: UserPresetsHandlers): UserPresetsUi {
  const root = document.createElement("div");
  root.className = "user-presets";

  const saveRow = document.createElement("div");
  saveRow.className = "user-preset-save";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "user-preset-name";
  input.placeholder = "音色の名前";
  input.maxLength = 30;
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "preset-button";
  saveBtn.textContent = "いまの音色を保存";
  const save = () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    handlers.onSave(name);
    input.value = "";
  };
  saveBtn.addEventListener("click", save);
  input.addEventListener("keydown", (e) => {
    // 名前の入力中は、鍵盤やスペースのショートカットに取られないようにする
    e.stopPropagation();
    if (e.key === "Enter") save();
  });
  saveRow.append(input, saveBtn);

  const list = document.createElement("div");
  list.className = "preset-row user-preset-list";

  root.append(saveRow, list);

  function render(presets: UserPreset[]): void {
    list.innerHTML = "";
    for (const preset of presets) {
      const chip = document.createElement("div");
      chip.className = "user-preset-chip";
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "preset-button";
      apply.textContent = preset.name;
      apply.title = "この音色を選択中の層に使う";
      apply.addEventListener("click", () => handlers.onApply(preset));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "layer-toggle";
      del.textContent = "×";
      del.title = `「${preset.name}」を削除`;
      del.addEventListener("click", () => handlers.onDelete(preset));
      chip.append(apply, del);
      list.appendChild(chip);
    }
  }

  return { el: root, render };
}
