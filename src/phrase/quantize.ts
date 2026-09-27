/**
 * クオンタイズのマス目（拍単位）。
 * 4分音符 = 1拍として、8分 = 0.5拍、16分 = 0.25拍、3連符(8分3連) = 1/3拍。
 */
export const quantizeGrids: { label: string; beats: number }[] = [
  { label: "8分", beats: 0.5 },
  { label: "16分", beats: 0.25 },
  { label: "3連符", beats: 1 / 3 },
];

/**
 * 生のタイミング（拍）を、指定したマス目に丸める。
 * 元の値は変更しない（呼び出し側が startRaw を別途保持することで非破壊にする）。
 */
export function quantizeBeat(rawBeats: number, gridBeats: number): number {
  if (gridBeats <= 0) return rawBeats;
  return Math.round(rawBeats / gridBeats) * gridBeats;
}
