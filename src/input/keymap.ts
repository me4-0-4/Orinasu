/** PCキーボードでの演奏マッピング（DAWで定番の配置）。
 * A S D F G H J K L ; が白鍵、W E T Y U O P が黒鍵。Z/Xでオクターブ上下。
 * 値は基準オクターブ（C4=60）からの半音オフセット。
 */
export const noteKeyMap: Record<string, number> = {
  a: 0, // C
  w: 1, // C#
  s: 2, // D
  e: 3, // D#
  d: 4, // E
  f: 5, // F
  t: 6, // F#
  g: 7, // G
  y: 8, // G#
  h: 9, // A
  u: 10, // A#
  j: 11, // B
  k: 12, // C+1
  o: 13, // C#+1
  l: 14, // D+1
  p: 15, // D#+1
  ";": 16, // E+1
};

export const octaveDownKey = "z";
export const octaveUpKey = "x";

export const baseMidiNote = 60; // C4

/** ドラムパッドのキーボード割り当て（数字キー1〜5）。 */
export const drumKeyMap: Record<string, "kick" | "snare" | "hat" | "clap" | "tom"> = {
  "1": "kick",
  "2": "snare",
  "3": "hat",
  "4": "clap",
  "5": "tom",
};
