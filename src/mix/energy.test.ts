import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultMacros,
  energyAt,
  filterOffsetCents,
  getMacro,
  hash01,
  layerAudible,
  macroValue,
  noteKept,
  paintCurve,
  shapeCurve,
} from "./energy.ts";

test("線の高さは点の間を直線でつなぐ。両端の外は端の値", () => {
  const c = [{ t: 0, v: 0 }, { t: 1, v: 1 }];
  assert.equal(energyAt(c, 0.25), 0.25);
  assert.equal(energyAt(c, -1), 0);
  assert.equal(energyAt(c, 2), 1);
  assert.equal(energyAt([], 0.3), 0.5);
});

test("型：J-POPはサビが最高、EDMはドロップで急に上がる", () => {
  const jpop = shapeCurve("jpop");
  assert.ok(energyAt(jpop, 0.1) < energyAt(jpop, 0.5));
  assert.ok(energyAt(jpop, 0.5) < energyAt(jpop, 0.9));
  const edm = shapeCurve("edm");
  assert.ok(energyAt(edm, 0.34) < 0.2);
  assert.ok(energyAt(edm, 0.37) > 0.9);
});

test("ペンでなぞると、その範囲の点だけが置き換わる", () => {
  const base = [{ t: 0, v: 0.1 }, { t: 0.5, v: 0.1 }, { t: 1, v: 0.1 }];
  const out = paintCurve(base, [{ t: 0.4, v: 0.9 }, { t: 0.6, v: 0.9 }]);
  assert.deepEqual(out.map((p) => p.t), [0, 0.4, 0.6, 1]);
  assert.equal(energyAt(out, 0.5), 0.9);
  assert.equal(energyAt(out, 0), 0.1);
});

test("層の数：低いと少なく（ドラムから）、高いと全部。最低1つ", () => {
  const roles = ["melody", "bass", "drums", "chords"] as const;
  const r = [...roles];
  assert.equal(layerAudible("drums", r, 0), true);
  assert.equal(layerAudible("melody", r, 0), false);
  assert.equal(layerAudible("bass", r, 0.5), true);
  assert.equal(layerAudible("chords", r, 0.5), false);
  assert.equal(layerAudible("melody", r, 1), true);
});

test("密度：1なら全部残り、0.5ならおよそ半分、頭の音は残りやすい", () => {
  const ids = Array.from({ length: 400 }, (_, i) => `note_${i}`);
  assert.equal(ids.filter((id) => noteKept(id, false, 1)).length, 400);
  const kept = ids.filter((id) => noteKept(id, false, 0.5)).length;
  assert.ok(kept > 150 && kept < 250, String(kept));
  const keptDown = ids.filter((id) => noteKept(id, true, 0.1)).length;
  assert.ok(keptDown > 150, String(keptDown)); // 頭の音は最低でも半分の密度
  assert.equal(noteKept("x", false, 0.3), noteKept("x", false, 0.3)); // 同じ結果
  assert.equal(hash01("a"), hash01("a"));
});

test("マクロ：山の高さで from〜to に写り、オフなら無効", () => {
  const macros = defaultMacros();
  const filter = getMacro(macros, "filter")!;
  assert.equal(macroValue(filter, 0), filter.from);
  assert.equal(macroValue(filter, 1), filter.to);
  assert.equal(filterOffsetCents(1), -0);
  assert.equal(filterOffsetCents(0), -3600);
  filter.enabled = false;
  assert.equal(getMacro(macros, "filter"), undefined);
});
