import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultVideo, isSplit, Layout, migrateVideo, type Leaf } from "./settings.ts";

const KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const seq = (): (() => number) => { let i = 0; return () => ((i++ * 0.37) % 1); };

test("縦で上下に積んだものは、横では左右に並ぶ（長い辺に沿って並べる）", () => {
  const L = new Layout(defaultVideo());
  const tall = L.place().out.map((o) => o.rect);
  assert.ok(tall[1].y > tall[0].y && Math.abs(tall[1].x - tall[0].x) < 1e-6);
  L.v.aspect = "wide";
  const wide = L.place().out.map((o) => o.rect);
  assert.ok(wide[1].x > wide[0].x && Math.abs(wide[1].y - wide[0].y) < 1e-6);
});

test("割る：親と同じ向きなら親の中に並べ、外すと親が1つになったら畳む", () => {
  const L = new Layout(defaultVideo());
  const before = L.leaves().length;
  const first = L.leaves()[0];
  L.split(first, false, 3, KEYS, seq()); // 縦の画面で上下＝根と同じ向き
  assert.equal(L.leaves().length, before + 2);
  assert.ok(isSplit(L.v.tree) && L.v.tree.children.length === 6);
  const sky = L.leaves().find((l) => l.panel === "sky")!;
  L.delete(sky);
  assert.ok(!L.leaves().includes(sky));
  assert.ok(L.leaves().some((l) => l.panel === "dial"));
});

test("「この比率だけ直す」：ほかの比率には効かず、戻せる", () => {
  const L = new Layout(defaultVideo());
  const lf = L.leaves()[1];
  L.only = true;
  L.set(lf, "panel", "weave");
  assert.equal(L.eff(lf, "panel"), "weave");
  L.v.aspect = "wide";
  assert.equal(L.eff(lf, "panel"), "score");
  L.v.aspect = "tall";
  L.resetNode(lf);
  assert.equal(L.eff(lf, "panel"), "score");
});

test("浮かせたパネルの位置は、寄せる場所＋ずれに直しても同じ所に戻る", () => {
  const L = new Layout(defaultVideo());
  const c = L.place().g.content;
  const r = { x: c.x + c.w - 300, y: c.y + c.h - 200, w: 250, h: 150 };
  const pos = L.rectToFloat(r, c);
  assert.equal(pos.anchor, "br");
  const f: Leaf = { id: 99, panel: "x", style: "none", float: pos };
  const back = L.floatRect(f, c);
  assert.ok(Math.abs(back.x - r.x) < 1e-6 && Math.abs(back.y - r.y) < 1e-6);
});

test("境目を動かすと、隣り合う2つの割合だけが変わる。端は5%残す", () => {
  const L = new Layout(defaultVideo());
  const dv = L.place().divs[0];
  L.moveDivider(dv, 0);
  const R = (L.v.tree as { ratios: number[] }).ratios, sum = R.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(R[0] / sum - 0.05) < 1e-9);
  assert.equal(R[2], 1);
});

test("振り直しても、固定したパネルと浮かせたパネルは残る", () => {
  const L = new Layout(defaultVideo());
  const keep = L.leaves()[2];
  keep.locked = true;
  L.v.floats.push({ id: 500, panel: "title", style: "none", float: { anchor: "c", ox: 0, oy: 0, w: 0.5, h: 0.3 } });
  L.shuffle(KEYS, seq());
  assert.ok(L.leaves().includes(keep));
  assert.equal(L.v.floats.length, 1);
  const ids = L.leaves().map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("保存したものを読み直すと、足りない設定は初期値で埋まり、次の id は重ならない", () => {
  const v = migrateVideo({ aspect: "wide", tree: { id: 40, panel: "dial", style: "card" }, fx: { glitch: false } });
  assert.equal(v.aspect, "wide");
  assert.equal(v.fx.glitch, false);
  assert.equal(v.fx.zure, true);
  assert.ok(v.nextId > 40);
  assert.equal(migrateVideo(null).aspect, "tall");
});
