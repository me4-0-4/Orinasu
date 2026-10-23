import { PRESETS, type Colors, type Rect } from "./panels.ts";

// 映像の設定（曲と一緒に保存する）と、パネルの配置（分割の木）を動かす関数。

export type Aspect = "tall" | "square" | "wide";
export type FrameStyle = "card" | "line" | "kakko" | "none";
export type Anchor = "tl" | "t" | "tr" | "l" | "c" | "r" | "bl" | "b" | "br";
/** 浮かせたパネルの位置：画面を3×3に分けたどこに寄せるか＋ずれ（短い辺に対する割合）。比率を変えても崩れにくい。 */
export interface FloatPos { anchor: Anchor; ox: number; oy: number; w: number; h: number }
export interface Leaf {
  id: number;
  panel: string;
  locked?: boolean;
  style: FrameStyle;
  /** このパネルだけの差し色1。無ければ全体の色。 */
  color?: string | null;
  /** LED にするか。無ければ全体の設定（とパネルの初期値）。 */
  led?: boolean | null;
  float?: FloatPos;
}
/** 枠を割ったもの。long＝画面の長い辺に沿って並べる、short＝短い辺に沿って並べる（縦⇔横で自動で向きが変わる）。 */
export interface Split { id: number; split: "long" | "short"; ratios: number[]; children: TreeNode[] }
export type TreeNode = Leaf | Split;
/** 比率ごとの上書き（「この比率だけ直す」）。 */
export interface Override { panel?: string; style?: FrameStyle; color?: string | null; led?: boolean | null; split?: "long" | "short"; ratios?: number[]; float?: FloatPos }

export type BaseMode = "none" | "cut" | "collage";
export const TREATMENTS = ["plain", "crt", "halftone", "mosh", "track", "key", "thresh", "contour", "edge", "stretch", "led"] as const;
export type Treatment = (typeof TREATMENTS)[number];

export interface VideoSettings {
  aspect: Aspect;
  preset: string;
  colors: Colors;
  /** 名札：札（左上の白黒反転）／耳（左端の縦書き）／なし。 */
  label: "fuda" | "mimi" | "none";
  lang: "ja" | "en";
  fx: { led: boolean; zure: boolean; glitch: boolean; sumi: boolean; halftone: boolean; weave: boolean };
  tree: TreeNode;
  floats: Leaf[];
  ov: Record<Aspect, Record<string, Override>>;
  layers: {
    base: { mode: BaseMode; treat: Record<Treatment, boolean>; density: number; life: number; zoom: number; dim: number };
    panels: { show: boolean; alpha: number };
    top: { show: boolean; text: string; pos: "lt" | "c" | "lb"; size: number; ring: boolean; lines: boolean };
  };
  nextId: number;
}

export const FRAMES: Record<Aspect, [number, number]> = { tall: [1080, 1920], square: [1080, 1080], wide: [1920, 1080] };
export const ASPECT_LABEL: Record<Aspect, string> = { tall: "9:16", square: "1:1", wide: "16:9" };
const ANCH: Record<Anchor, [number, number]> = { tl: [0, 0], t: [0.5, 0], tr: [1, 0], l: [0, 0.5], c: [0.5, 0.5], r: [1, 0.5], bl: [0, 1], b: [0.5, 1], br: [1, 1] };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const isSplit = (n: TreeNode): n is Split => "split" in n;

export function defaultVideo(text = ""): VideoSettings {
  let id = 1;
  const leaf = (panel: string): Leaf => ({ id: id++, panel, style: "card" });
  const split = (dir: "long" | "short", children: TreeNode[], ratios?: number[]): Split => ({ id: id++, split: dir, children, ratios: ratios ?? children.map(() => 1) });
  const tree = split("long", [leaf("ticker"), leaf("score"), split("short", [leaf("dial"), leaf("sky")]), split("short", [leaf("weave"), split("long", [leaf("gauge"), leaf("board")], [0.55, 0.45])])], [0.3, 1, 1, 1]);
  return {
    aspect: "tall",
    preset: "shuden",
    colors: clone(PRESETS.shuden),
    label: "fuda",
    lang: "ja",
    fx: { led: false, zure: true, glitch: true, sumi: true, halftone: false, weave: false },
    tree,
    floats: [],
    ov: { tall: {}, square: {}, wide: {} },
    layers: {
      base: { mode: "none", treat: { plain: true, crt: true, halftone: false, mosh: true, track: true, key: true, thresh: true, contour: false, edge: true, stretch: true, led: false }, density: 1, life: 6, zoom: 0.4, dim: 0.1 },
      panels: { show: true, alpha: 1 },
      top: { show: false, text, pos: "lb", size: 0.5, ring: false, lines: false },
    },
    nextId: id,
  };
}

/** 保存したもの（古い形も）を、今の形に直す。 */
export function migrateVideo(raw: unknown): VideoSettings {
  const d = defaultVideo();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<VideoSettings>;
  const v: VideoSettings = {
    ...d,
    ...r,
    colors: { ...d.colors, ...(r.colors ?? {}) },
    fx: { ...d.fx, ...(r.fx ?? {}) },
    ov: { tall: { ...(r.ov?.tall ?? {}) }, square: { ...(r.ov?.square ?? {}) }, wide: { ...(r.ov?.wide ?? {}) } },
    floats: Array.isArray(r.floats) ? r.floats : [],
    tree: r.tree ?? d.tree,
    layers: {
      base: { ...d.layers.base, ...(r.layers?.base ?? {}), treat: { ...d.layers.base.treat, ...(r.layers?.base?.treat ?? {}) } },
      panels: { ...d.layers.panels, ...(r.layers?.panels ?? {}) },
      top: { ...d.layers.top, ...(r.layers?.top ?? {}) },
    },
  };
  if (!FRAMES[v.aspect]) v.aspect = "tall";
  // id は木と浮かせたパネルのいちばん大きい番号の次から
  let max = 0;
  const walk = (n: TreeNode): void => { max = Math.max(max, n.id); if (isSplit(n)) n.children.forEach(walk); };
  walk(v.tree);
  v.floats.forEach((f) => (max = Math.max(max, f.id)));
  v.nextId = Math.max(v.nextId ?? 1, max + 1);
  return v;
}

export interface Geom { VW: number; VH: number; u: number; content: Rect; gap: number }
export function frameGeom(aspect: Aspect): Geom {
  const [VW, VH] = FRAMES[aspect], u = Math.min(VW, VH) / 100, m = u * 3, foot = u * 3.6;
  return { VW, VH, u, content: { x: m, y: m, w: VW - m * 2, h: VH - m * 2 - foot }, gap: u * 1.1 };
}
export interface Placed { leaf: Leaf; rect: Rect; float?: boolean }
export interface Divider { node: Split; i: number; parent: Rect; horiz: boolean; pos: number }

/** 配置を動かす。only＝true のときは、いまの比率だけを直す（上書き）。 */
export class Layout {
  v: VideoSettings;
  only = false;
  constructor(v: VideoSettings) {
    this.v = v;
  }

  private ovOf(): Record<string, Override> {
    return this.v.ov[this.v.aspect];
  }
  /** 上書きがあればそれ、無ければ元の値。 */
  eff<K extends keyof Override>(node: TreeNode, key: K): Override[K] {
    const o = this.ovOf()[node.id];
    if (o && key in o) {
      if (key === "ratios" && isSplit(node) && o.ratios!.length !== node.ratios.length) return node.ratios as Override[K];
      return o[key];
    }
    return (node as unknown as Override)[key];
  }
  set<K extends keyof Override>(node: TreeNode, key: K, val: Override[K]): void {
    const o = this.ovOf();
    if (this.only) (o[node.id] ??= {})[key] = clone(val);
    else {
      (node as unknown as Override)[key] = clone(val);
      if (o[node.id]) {
        delete o[node.id][key];
        if (!Object.keys(o[node.id]).length) delete o[node.id];
      }
    }
  }
  overridden(node: TreeNode): boolean {
    return !!this.ovOf()[node.id];
  }
  resetNode(node: TreeNode): void {
    delete this.ovOf()[node.id];
  }
  resetAspect(): void {
    this.v.ov[this.v.aspect] = {};
  }
  private dropRatioOverrides(node: TreeNode): void {
    for (const a of Object.keys(this.v.ov) as Aspect[]) {
      const o = this.v.ov[a][node.id];
      if (o) {
        delete o.ratios;
        if (!Object.keys(o).length) delete this.v.ov[a][node.id];
      }
    }
  }
  private purge(id: number): void {
    for (const a of Object.keys(this.v.ov) as Aspect[]) delete this.v.ov[a][id];
  }

  private longH(): boolean {
    const [VW, VH] = FRAMES[this.v.aspect];
    return VW > VH;
  }
  /** 画面で左右に並べたい（horiz）とき、木に書く向き。 */
  dirFor(horiz: boolean): "long" | "short" {
    return horiz === this.longH() ? "long" : "short";
  }
  newLeaf(panel: string, extra: Partial<Leaf> = {}): Leaf {
    return { id: this.v.nextId++, panel, style: "card", ...extra };
  }
  private newSplit(dir: "long" | "short", children: TreeNode[], ratios?: number[]): Split {
    return { id: this.v.nextId++, split: dir, children, ratios: ratios ?? children.map(() => 1) };
  }

  layoutTree(node: TreeNode, r: Rect, out: Placed[], divs: Divider[]): void {
    if (!isSplit(node)) {
      out.push({ leaf: node, rect: r });
      return;
    }
    const dir = this.eff(node, "split"), R = this.eff(node, "ratios")!, horiz = dir === "long" ? this.longH() : !this.longH();
    const sum = R.reduce((a, b) => a + b, 0);
    let acc = 0;
    node.children.forEach((ch, i) => {
      const a0 = acc / sum;
      acc += R[i];
      const a1 = acc / sum;
      const cr = horiz ? { x: r.x + r.w * a0, y: r.y, w: r.w * (a1 - a0), h: r.h } : { x: r.x, y: r.y + r.h * a0, w: r.w, h: r.h * (a1 - a0) };
      if (i > 0) divs.push({ node, i, parent: r, horiz, pos: horiz ? cr.x : cr.y });
      this.layoutTree(ch, cr, out, divs);
    });
  }
  floatRect(f: Leaf, c: Rect): Rect {
    const fl = this.eff(f, "float") ?? { anchor: "c", ox: 0, oy: 0, w: 0.5, h: 0.3 };
    const s = Math.min(c.w, c.h), w = fl.w * s, h = fl.h * s, [ax, ay] = ANCH[fl.anchor];
    return { x: c.x + ax * (c.w - w) + fl.ox * s, y: c.y + ay * (c.h - h) + fl.oy * s, w, h };
  }
  rectToFloat(r: Rect, c: Rect): FloatPos {
    const s = Math.min(c.w, c.h);
    const col = Math.min(2, Math.max(0, Math.floor(((r.x + r.w / 2 - c.x) / c.w) * 3)));
    const row = Math.min(2, Math.max(0, Math.floor(((r.y + r.h / 2 - c.y) / c.h) * 3)));
    const anchor = ([["tl", "t", "tr"], ["l", "c", "r"], ["bl", "b", "br"]] as Anchor[][])[row][col], [ax, ay] = ANCH[anchor];
    let ox = (r.x - (c.x + ax * (c.w - r.w))) / s, oy = (r.y - (c.y + ay * (c.h - r.h))) / s;
    if (Math.abs(ox) < 0.025) ox = 0;
    if (Math.abs(oy) < 0.025) oy = 0;
    return { anchor, ox, oy, w: r.w / s, h: r.h / s };
  }
  /** いまの比率での、全部のパネルの位置（木→浮かせたもの）と、境目。 */
  place(): { g: Geom; out: Placed[]; divs: Divider[] } {
    const g = frameGeom(this.v.aspect), out: Placed[] = [], divs: Divider[] = [];
    this.layoutTree(this.v.tree, g.content, out, divs);
    this.v.floats.forEach((f) => out.push({ leaf: f, rect: this.floatRect(f, g.content), float: true }));
    return { g, out, divs };
  }

  replace(root: TreeNode, target: TreeNode, repl: TreeNode): TreeNode {
    if (root === target) return repl;
    if (isSplit(root)) root.children = root.children.map((c) => this.replace(c, target, repl));
    return root;
  }
  parentOf(root: TreeNode, t: TreeNode): Split | null {
    if (!isSplit(root)) return null;
    if (root.children.includes(t)) return root;
    for (const c of root.children) {
      const p = this.parentOf(c, t);
      if (p) return p;
    }
    return null;
  }
  leaves(n: TreeNode = this.v.tree, acc: Leaf[] = []): Leaf[] {
    if (isSplit(n)) n.children.forEach((c) => this.leaves(c, acc));
    else acc.push(n);
    return acc;
  }
  find(id: number | null): Leaf | null {
    if (id === null) return null;
    return this.leaves().concat(this.v.floats).find((l) => l.id === id) ?? null;
  }
  isFloat(lf: Leaf): boolean {
    return this.v.floats.includes(lf);
  }
  /** まだ使っていないパネルを1つ（無ければどれか）。 */
  unused(keys: string[], rng: () => number, extra: Leaf[] = []): string {
    const used = new Set(this.leaves().concat(this.v.floats, extra).map((l) => this.eff(l, "panel")));
    const free = keys.filter((k) => !used.has(k)), pool = free.length ? free : keys;
    return pool[Math.floor(rng() * pool.length)];
  }
  /** 木から外す（親が1つになったら、親ごと畳む）。根は外せない。 */
  remove(lf: Leaf): boolean {
    const par = this.parentOf(this.v.tree, lf);
    if (!par) return false;
    const i = par.children.indexOf(lf);
    par.children.splice(i, 1);
    par.ratios.splice(i, 1);
    this.dropRatioOverrides(par);
    if (par.children.length === 1) this.v.tree = this.replace(this.v.tree, par, par.children[0]);
    return true;
  }
  /** 消す（木からでも、浮かせたものからでも）。 */
  delete(lf: Leaf): void {
    if (this.isFloat(lf)) this.v.floats = this.v.floats.filter((x) => x !== lf);
    else if (!this.remove(lf)) return;
    this.purge(lf.id);
  }
  /** target の横（horiz＝左右、before＝左・上）に lf を入れる。 */
  insertBeside(target: Leaf, lf: Leaf, horiz: boolean, before: boolean): void {
    const dir = this.dirFor(horiz), par = this.parentOf(this.v.tree, target);
    if (par && par.split === dir && this.eff(par, "split") === dir) {
      const i = par.children.indexOf(target), r = par.ratios[i] / 2, at = before ? i : i + 1;
      par.ratios[i] = r;
      par.children.splice(at, 0, lf);
      par.ratios.splice(at, 0, r);
      this.dropRatioOverrides(par);
    } else this.v.tree = this.replace(this.v.tree, target, this.newSplit(dir, before ? [lf, target] : [target, lf]));
  }
  /** lf を n 個に割る（新しいパネルは、まだ使っていないもの）。親と同じ向きなら、親の中に並べる。 */
  split(lf: Leaf, horiz: boolean, n: number, keys: string[], rng: () => number): void {
    const dir = this.dirFor(horiz), par = this.parentOf(this.v.tree, lf), fresh: Leaf[] = [];
    for (let k = 1; k < n; k++) fresh.push(this.newLeaf(this.unused(keys, rng, fresh)));
    if (par && par.split === dir && this.eff(par, "split") === dir) {
      const i = par.children.indexOf(lf), r = par.ratios[i] / n;
      par.ratios[i] = r;
      par.children.splice(i + 1, 0, ...fresh);
      par.ratios.splice(i + 1, 0, ...fresh.map(() => r));
      this.dropRatioOverrides(par);
    } else this.v.tree = this.replace(this.v.tree, lf, this.newSplit(dir, [lf, ...fresh]));
  }
  /** 中身（と枠）を入れ替える。 */
  swap(a: Leaf, b: Leaf): void {
    const pa = this.eff(a, "panel"), sa = this.eff(a, "style"), pb = this.eff(b, "panel"), sb = this.eff(b, "style");
    this.set(a, "panel", pb);
    this.set(a, "style", sb);
    this.set(b, "panel", pa);
    this.set(b, "style", sa);
    if (!this.only) [a.locked, b.locked] = [b.locked, a.locked];
  }
  /** ドラッグで、target の端に落とした：そこを割って入る。 */
  moveBeside(lf: Leaf, target: Leaf, horiz: boolean, before: boolean): void {
    if (lf === target || !this.remove(lf)) return;
    this.insertBeside(target, lf, horiz, before);
  }
  float(lf: Leaf): void {
    if (!this.remove(lf)) return;
    for (const a of Object.keys(this.v.ov) as Aspect[]) if (this.v.ov[a][lf.id]) delete this.v.ov[a][lf.id].float;
    lf.float = { anchor: "c", ox: 0, oy: 0, w: 0.5, h: 0.32 };
    this.v.floats.push(lf);
  }
  unfloat(lf: Leaf): void {
    this.v.floats = this.v.floats.filter((x) => x !== lf);
    delete lf.float;
    for (const a of Object.keys(this.v.ov) as Aspect[]) if (this.v.ov[a][lf.id]) delete this.v.ov[a][lf.id].float;
    const out: Placed[] = [];
    this.layoutTree(this.v.tree, frameGeom(this.v.aspect).content, out, []);
    out.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    this.insertBeside(out[0].leaf, lf, out[0].rect.w >= out[0].rect.h, false);
  }
  /** 境目を動かす：dv の左（上）と右（下）の割合を、位置 fr（親の中の 0〜1）で分け直す。 */
  moveDivider(dv: Divider, fr: number): void {
    const i = dv.i, R = (this.eff(dv.node, "ratios") ?? dv.node.ratios).slice(), sum = R.reduce((a, b) => a + b, 0);
    let start = 0;
    for (let k = 0; k < i - 1; k++) start += R[k];
    start /= sum;
    const end = start + (R[i - 1] + R[i]) / sum, v = Math.max(start + 0.05, Math.min(end - 0.05, fr));
    R[i - 1] = (v - start) * sum;
    R[i] = (end - v) * sum;
    this.set(dv.node, "ratios", R);
  }

  /** 振り直す：固定したパネルは残して、枠の割り方と中身を作り直す。浮かせたパネルはそのまま。 */
  shuffle(keys: string[], rng: () => number): void {
    const range = { tall: [4, 6], square: [3, 5], wide: [4, 6] }[this.v.aspect];
    const count = range[0] + Math.floor(rng() * (range[1] - range[0] + 1));
    const locked = this.leaves().filter((l) => l.locked);
    const floatIds = new Set(this.v.floats.map((f) => String(f.id)));
    for (const a of Object.keys(this.v.ov) as Aspect[]) for (const id of Object.keys(this.v.ov[a])) if (!floatIds.has(id)) delete this.v.ov[a][id];
    const n = Math.max(count, locked.length), c = frameGeom(this.v.aspect).content;
    let root: TreeNode = this.newLeaf(keys[0]);
    for (;;) {
      const out: Placed[] = [];
      this.layoutTree(root, c, out, []);
      if (out.length >= n) break;
      out.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
      const t = out[0], horiz = (t.rect.w >= t.rect.h) === rng() < 0.8, r = 0.36 + rng() * 0.28;
      const kids = rng() < 0.5 ? [t.leaf, this.newLeaf(keys[0])] : [this.newLeaf(keys[0]), t.leaf];
      root = this.replace(root, t.leaf, this.newSplit(this.dirFor(horiz), kids, [r, 1 - r]));
    }
    const leaves = this.leaves(root).sort(() => rng() - 0.5);
    const used = new Set(locked.map((l) => l.panel).concat(this.v.floats.map((f) => this.eff(f, "panel") ?? f.panel)));
    const fresh = keys.filter((k) => !used.has(k)).sort(() => rng() - 0.5);
    leaves.forEach((l, i) => {
      if (i < locked.length) root = this.replace(root, l, locked[i]);
      else l.panel = fresh.length ? fresh[(i - locked.length) % fresh.length] : keys[i % keys.length];
    });
    this.v.tree = root;
  }
}
