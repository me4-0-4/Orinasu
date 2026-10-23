import type { Phrase } from "../phrase/types";
import type { Pcm } from "../mix/pcm";
import type { StemSet } from "../mix/collageSong";
import type { Song } from "../mix/types";
import { analyze, type Analysis } from "../video/analysis";
import { featAt } from "../video/features";
import { buildTimeline, type Timeline } from "../video/timeline";
import { timelineInput } from "../video/source";
import { bindTimeline, COLOR_KEYS, PANELS, PRESETS, rt, type Colors } from "../video/panels";
import { ASPECT_LABEL, defaultVideo, FRAMES, Layout, migrateVideo, type Aspect, type Divider, type FrameStyle, type Leaf, type Placed, type Treatment, type VideoSettings } from "../video/settings";
import { FrameTarget, renderFrame } from "../video/renderer";
import { makeSamples, srcSize, type Material } from "../video/materials";
import type { StoredMaterial } from "../storage/db";

export interface VideoPanelDeps {
  mix: {
    current: () => { set: StemSet; song: Song } | null;
    mixdown: () => Promise<Pcm> | null;
    position: () => number;
    playing: () => boolean;
    togglePlay: () => void;
    seek: (fraction: number) => void;
    song: () => Song;
    videoChanged: () => void;
  };
  getPhrases: () => Phrase[];
  /** 素材（写真・動画）の置き場所（端末の中）。 */
  materials: {
    load: () => Promise<StoredMaterial[]>;
    save: (m: StoredMaterial) => Promise<void>;
    remove: (id: string) => Promise<void>;
  };
}

export interface VideoPanel {
  el: HTMLElement;
  /** 毎フレーム呼ぶ（タブが見えているときだけ描く）。 */
  tick: () => void;
  /** キー操作（R＝振り直す、Esc＝選択を外す）。使ったら true。 */
  key: (code: string) => boolean;
  /** 曲が入れ替わった（開き直したなど）。 */
  setSong: () => void;
}

type Attrs = Record<string, string | (() => void)>;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") e.addEventListener("click", v as () => void);
    else if (k === "class") e.className = v as string;
    else e.setAttribute(k, v as string);
  }
  e.append(...kids);
  return e;
}
/** ランプつきの切り替え（点いている＝オン）。 */
const lamp = (label: string, on: boolean, handler: () => void, extra = ""): HTMLButtonElement =>
  el("button", { type: "button", class: "vid-sw" + (extra ? " " + extra : ""), "aria-pressed": on ? "true" : "false", on: handler }, el("i", { class: "vid-lamp" }), label);
const key = (label: string, handler: () => void, extra = ""): HTMLButtonElement => el("button", { type: "button", class: "vid-key" + (extra ? " " + extra : ""), on: handler }, label);
const section = (title: string, ...kids: Node[]): HTMLElement => el("section", { class: "vid-isec" }, el("h3", {}, title), ...kids);
const row = (...kids: Node[]): HTMLElement => el("div", { class: "vid-row" }, ...kids);
function slider(label: string, get: () => number, set: (v: number) => void, fmt = (v: number) => `${Math.round(v * 100)}%`): HTMLElement {
  const id = `vid-sl-${label}`, out = el("span", { class: "vid-sv" }, fmt(get()));
  const inp = el("input", { type: "range", min: "0", max: "1", step: "0.01", id });
  inp.value = String(get());
  inp.addEventListener("input", () => {
    set(Number(inp.value));
    out.textContent = fmt(Number(inp.value));
  });
  return el("label", { class: "vid-sl", for: id }, el("span", {}, label), inp, out);
}
const pct = (v: number, total: number): string => `${(v / total) * 100}%`;
const GROUPS = ["音", "拍", "響き", "文字", "その他"];
const PANEL_ORDER = Object.keys(PANELS);
const KEYS_RANDOM = PANEL_ORDER.filter((k) => k !== "sozai");

/**
 * 映像タブ。刻むタブで作った曲に合わせて、パネル・素材・大きな文字の3つの層を重ねて描く。
 * - 上：配電盤（比率・配色・名札・効果・再生・直す範囲）
 * - 左：映像（パネルをタップで選ぶ、ドラッグで入れ替え・割り込み、境目をドラッグ）
 * - 右：インスペクタ（素材｜パネル｜上）
 */
export function buildVideoPanel(deps: VideoPanelDeps): VideoPanel {
  const root = el("div", { class: "tab-panel video-tab" });
  const board = el("div", { class: "vid-board" });
  const colorsBox = el("div", { class: "vid-colors" });
  colorsBox.hidden = true;
  const canvas = el("canvas", { class: "vid-canvas" });
  const ov = el("div", { class: "vid-ov" });
  const stage = el("div", { class: "vid-stage" }, el("i", { class: "vid-tm tl" }), el("i", { class: "vid-tm tr" }), el("i", { class: "vid-tm bl" }), el("i", { class: "vid-tm br" }), canvas, ov);
  const note = el("p", { class: "vid-note" });
  const scrub = el("input", { type: "range", min: "0", max: "1", step: "0.001", class: "vid-scrub", "aria-label": "再生位置" });
  const stageWrap = el("div", { class: "vid-stagewrap" }, stage, note, scrub);
  const insp = el("aside", { class: "vid-insp" });
  root.append(board, colorsBox, el("div", { class: "vid-main" }, stageWrap, insp));

  const target = new FrameTarget(canvas);
  let v: VideoSettings = defaultVideo();
  let L = new Layout(v);
  let sel: number | null = null;
  let tab: "base" | "panels" | "top" = "panels";
  let clean = false, auto = false, colorOpen = false;
  // 素材の棚：自分の素材が1つも無いあいだは、見本を並べる
  const samples = makeSamples();
  const mats: Material[] = [...samples];
  const records = new Map<string, StoredMaterial>();
  let matError = "";
  // 曲：作り直されたら、出来事の並びと解析をやり直す
  let builtFrom: StemSet | null = null;
  let tl: Timeline | null = null;
  let an: Analysis | null = null;
  let analyzing = false;
  let lastT = performance.now(), lastBlock = -1, lastPlaying = false;
  let lastLayout: { out: Placed[]; g: ReturnType<Layout["place"]>["g"] } | null = null;

  let songRef: Song | null = null;
  function loadSettings(): void {
    const song = deps.mix.song();
    songRef = song;
    if (!song.video) song.video = defaultVideo(song.name);
    v = song.video = migrateVideo(song.video);
    L = new Layout(v);
    sel = null;
  }
  const saveSoon = (): void => deps.mix.videoChanged();

  // ---- 曲の解析 ----
  function syncSong(): void {
    const cur = deps.mix.current();
    if (!cur) {
      builtFrom = null;
      tl = null;
      an = null;
      return;
    }
    if (cur.set === builtFrom) return;
    builtFrom = cur.set;
    tl = buildTimeline(timelineInput(cur.set, cur.song, deps.getPhrases()));
    an = null;
    const pending = deps.mix.mixdown();
    if (!pending) return;
    analyzing = true;
    const forSet = cur.set;
    void pending.then((pcm) => {
      // 解析は重いので、画面を一度描いてから
      window.setTimeout(() => {
        if (builtFrom !== forSet || !tl) return;
        an = analyze(pcm, forSet.sampleRate, forSet.stepSamples, forSet.totalSteps);
        bindTimeline(tl, an);
        analyzing = false;
      }, 30);
    }).catch((err) => {
      console.error("映像のための解析に失敗しました", err);
      analyzing = false;
    });
  }

  // ---- 映像の大きさ ----
  function sizeStage(): void {
    const [VW, VH] = FRAMES[v.aspect];
    const aw = Math.max(120, stageWrap.clientWidth - 48), ah = Math.max(200, Math.min(window.innerHeight * 0.7, 900));
    const scale = Math.min(aw / VW, ah / VH), dw = Math.floor(VW * scale), dh = Math.floor(VH * scale), dpr = Math.min(2, window.devicePixelRatio || 1);
    stage.style.width = `${dw}px`;
    stage.style.height = `${dh}px`;
    target.resize(Math.floor(dw * dpr), Math.floor(dh * dpr), VW);
  }
  new ResizeObserver(() => sizeStage()).observe(stageWrap);

  // ---- 描く ----
  function tick(): void {
    if (!root.classList.contains("active")) return;
    if (deps.mix.song() !== songRef) {
      // 刻むタブで別の曲を開いた
      loadSettings();
      sizeStage();
      refresh();
    }
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    syncSong();
    const playing = deps.mix.playing();
    if (playing !== lastPlaying) {
      // スペースキーや刻むタブで再生⇔停止したら、配電盤のランプも変える
      lastPlaying = playing;
      buildBoard();
    }
    rt.frameDt = playing ? dt : 0;
    rt.playing = playing;
    rt.lang = v.lang;
    const song = deps.mix.song();
    rt.song = { name: song.name || "無題", key: builtFrom?.keyName ?? "", keyJa: builtFrom?.keyName ?? "", bars: song.lengthBars };
    if (!tl || !an) {
      note.textContent = !deps.mix.current() ? "刻むタブで曲を作ると、ここに映像が出ます。" : analyzing ? "曲を解析しています…" : "";
      note.hidden = note.textContent === "";
      const ctx = target.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = v.colors.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    note.hidden = true;
    const pos = deps.mix.position();
    const S = pos * tl.totalSteps;
    if (document.activeElement !== scrub) scrub.value = String(pos);
    const block = Math.floor(S / (tl.stepsPerBar * 8));
    if (auto && playing && lastBlock >= 0 && block !== lastBlock) shuffle();
    lastBlock = block;
    renderFrame(target, v, L, tl, mats, featAt(tl, an, S));
  }
  scrub.addEventListener("input", () => deps.mix.seek(Number(scrub.value)));

  function shuffle(): void {
    L.shuffle(KEYS_RANDOM, Math.random);
    if (sel !== null && !L.find(sel)) sel = null;
    for (const k of Object.keys(rt.parts)) delete rt.parts[Number(k)];
    saveSoon();
    refresh();
  }

  // ---- 映像の上の操作 ----
  function toVirtual(ev: PointerEvent): [number, number] {
    const r = ov.getBoundingClientRect(), [VW, VH] = FRAMES[v.aspect];
    return [((ev.clientX - r.left) / r.width) * VW, ((ev.clientY - r.top) / r.height) * VH];
  }
  function drag(t: HTMLElement, ev: PointerEvent, move: (e: PointerEvent) => void, up: () => void): void {
    t.setPointerCapture(ev.pointerId);
    const end = (): void => {
      t.removeEventListener("pointermove", move);
      t.removeEventListener("pointerup", end);
      t.removeEventListener("pointercancel", end);
      up();
    };
    t.addEventListener("pointermove", move);
    t.addEventListener("pointerup", end);
    t.addEventListener("pointercancel", end);
  }
  function boxStyle(r: { x: number; y: number; w: number; h: number }, g: { VW: number; VH: number; gap: number }): Partial<CSSStyleDeclaration> {
    return { left: pct(r.x + g.gap / 2, g.VW), top: pct(r.y + g.gap / 2, g.VH), width: pct(r.w - g.gap, g.VW), height: pct(r.h - g.gap, g.VH) };
  }
  function renderOverlay(): void {
    const { g, out, divs } = L.place();
    lastLayout = { g, out };
    ov.replaceChildren();
    ov.hidden = clean;
    stage.classList.toggle("clean", clean);
    if (!v.layers.panels.show) return;
    for (const dv of divs) ov.append(dividerEl(dv, g));
    for (const o of out) {
      const lf = o.leaf, blank = L.eff(lf, "panel") === "blank";
      const d = el("div", { class: "vid-pnl" + (sel === lf.id ? " sel" : "") + (o.float ? " float" : "") + (blank ? " blank" : "") });
      Object.assign(d.style, boxStyle(o.rect, g));
      const badges = el("div", { class: "vid-badges" });
      if (o.float) badges.append(el("span", { class: "vid-bdg" }, "浮き"));
      if (lf.locked) badges.append(el("span", { class: "vid-bdg lock" }, "固定"));
      if (L.overridden(lf)) badges.append(el("span", { class: "vid-bdg only" }, `${ASPECT_LABEL[v.aspect]}だけ`));
      if (badges.childNodes.length) d.append(badges);
      if (blank) d.append(el("span", { class: "vid-blank" }, "余白"));
      if (o.float && sel === lf.id) d.append(el("div", { class: "vid-rs" }));
      d.addEventListener("pointerdown", (ev) => (o.float ? onFloatDown(ev, lf, d) : onLeafDown(ev, lf, d)));
      ov.append(d);
    }
  }
  function dividerEl(dv: Divider, g: { VW: number; VH: number; u: number }): HTMLElement {
    const d = el("div", { class: "vid-dv " + (dv.horiz ? "h" : "v") }), hit = g.u * 1.6, p = dv.parent;
    if (dv.horiz) Object.assign(d.style, { left: pct(dv.pos - hit / 2, g.VW), top: pct(p.y, g.VH), width: pct(hit, g.VW), height: pct(p.h, g.VH) });
    else Object.assign(d.style, { left: pct(p.x, g.VW), top: pct(dv.pos - hit / 2, g.VH), width: pct(p.w, g.VW), height: pct(hit, g.VH) });
    d.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      d.classList.add("drag");
      drag(d, ev, (e2) => {
        const [vx, vy] = toVirtual(e2);
        L.moveDivider(dv, dv.horiz ? (vx - p.x) / p.w : (vy - p.y) / p.h);
        const R = L.eff(dv.node, "ratios") ?? dv.node.ratios, sum = R.reduce((a, b) => a + b, 0);
        let acc = 0;
        for (let k = 0; k < dv.i; k++) acc += R[k];
        const pos = dv.horiz ? p.x + (p.w * acc) / sum : p.y + (p.h * acc) / sum;
        if (dv.horiz) d.style.left = pct(pos - hit / 2, g.VW);
        else d.style.top = pct(pos - hit / 2, g.VH);
      }, () => {
        saveSoon();
        refresh();
      });
    });
    return d;
  }
  function onLeafDown(ev: PointerEvent, lf: Leaf, d: HTMLElement): void {
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY;
    let dragging = false;
    let drop: { leaf: Leaf; zone: "center" | "left" | "right" | "top" | "bottom" } | null = null;
    const ind = el("div", { class: "vid-drop" }), ghost = el("div", { class: "vid-ghost" }, PANELS[L.eff(lf, "panel") ?? ""]?.ja ?? "余白");
    drag(d, ev, (e2) => {
      if (!dragging && Math.hypot(e2.clientX - sx, e2.clientY - sy) < 8) return;
      if (!dragging) {
        dragging = true;
        ov.append(ind, ghost);
        d.classList.add("lifted");
      }
      const [vx, vy] = toVirtual(e2), g = lastLayout!.g;
      ghost.style.left = pct(vx, g.VW);
      ghost.style.top = pct(vy, g.VH);
      drop = null;
      for (const o of lastLayout!.out) {
        if (o.float) continue;
        const r = o.rect;
        if (vx < r.x || vx > r.x + r.w || vy < r.y || vy > r.y + r.h) continue;
        if (o.leaf === lf) break;
        const px = (vx - r.x) / r.w, py = (vy - r.y) / r.h, m = Math.min(px, 1 - px, py, 1 - py);
        const zone = m >= 0.25 ? "center" : m === px ? "left" : m === 1 - px ? "right" : m === py ? "top" : "bottom";
        drop = { leaf: o.leaf, zone };
        const t = 0.3;
        const rr = zone === "center" ? r : zone === "left" ? { ...r, w: r.w * t } : zone === "right" ? { ...r, x: r.x + r.w * (1 - t), w: r.w * t } : zone === "top" ? { ...r, h: r.h * t } : { ...r, y: r.y + r.h * (1 - t), h: r.h * t };
        Object.assign(ind.style, { display: "flex", left: pct(rr.x, g.VW), top: pct(rr.y, g.VH), width: pct(rr.w, g.VW), height: pct(rr.h, g.VH) });
        ind.textContent = zone === "center" ? "入れ替え" : "割り込む";
        break;
      }
      if (!drop) ind.style.display = "none";
    }, () => {
      sel = lf.id;
      tab = "panels";
      if (dragging && drop) {
        const z = drop.zone;
        if (z === "center") L.swap(lf, drop.leaf);
        else L.moveBeside(lf, drop.leaf, z === "left" || z === "right", z === "left" || z === "top");
        saveSoon();
      }
      refresh();
    });
  }
  function onFloatDown(ev: PointerEvent, lf: Leaf, d: HTMLElement): void {
    ev.preventDefault();
    const resize = (ev.target as HTMLElement).classList.contains("vid-rs");
    const { g } = L.place(), c = g.content, s = Math.min(c.w, c.h), r0 = L.floatRect(lf, c), [sx, sy] = toVirtual(ev);
    let moved = false, r = r0;
    drag(d, ev, (e2) => {
      const [vx, vy] = toVirtual(e2), dx = vx - sx, dy = vy - sy;
      if (!moved && Math.hypot(dx, dy) < g.u) return;
      moved = true;
      r = resize ? { x: r0.x, y: r0.y, w: Math.max(s * 0.12, r0.w + dx), h: Math.max(s * 0.08, r0.h + dy) } : { x: r0.x + dx, y: r0.y + dy, w: r0.w, h: r0.h };
      Object.assign(d.style, boxStyle(r, g));
    }, () => {
      if (moved) {
        L.set(lf, "float", L.rectToFloat(r, c));
        saveSoon();
      }
      sel = lf.id;
      tab = "panels";
      refresh();
    });
  }

  // ---- 配電盤 ----
  function buildBoard(): void {
    const group = (label: string, ...kids: Node[]): HTMLElement => el("fieldset", { class: "vid-grp" }, el("legend", {}, label), el("div", { class: "vid-grp-in" }, ...kids));
    const change = (fn: () => void) => () => {
      fn();
      saveSoon();
      refresh();
    };
    board.replaceChildren(
      group("比率", ...(Object.keys(FRAMES) as Aspect[]).map((a) => lamp(ASPECT_LABEL[a], v.aspect === a, change(() => { v.aspect = a; sizeStage(); })))),
      group("配色",
        ...Object.entries(PRESETS).map(([k, p]) => lamp(p.name, v.preset === k, change(() => { v.preset = k; v.colors = { ...p } as unknown as Colors; }))),
        lamp("自分で", colorOpen, () => { colorOpen = !colorOpen; refresh(); }),
      ),
      group("名札",
        ...([["fuda", "札"], ["mimi", "耳"], ["none", "なし"]] as const).map(([k, l]) => lamp(l, v.label === k, change(() => (v.label = k)))),
        el("span", { class: "vid-sep" }),
        lamp("和", v.lang === "ja", change(() => (v.lang = "ja"))),
        lamp("英", v.lang === "en", change(() => (v.lang = "en"))),
      ),
      group("効果", ...([["led", "LED"], ["zure", "版ズレ"], ["glitch", "グリッチ"], ["sumi", "墨"], ["halftone", "網点"], ["weave", "織り目"]] as const).map(([k, l]) => lamp(l, v.fx[k], change(() => (v.fx[k] = !v.fx[k]))))),
      group("再生",
        lamp(deps.mix.playing() ? "再生中" : "停止中", deps.mix.playing(), () => { deps.mix.togglePlay(); window.setTimeout(refresh, 50); }),
        key("振り直す", shuffle),
        lamp("8小節ごと", auto, () => { auto = !auto; refresh(); }),
      ),
      group("直す範囲",
        lamp(`${ASPECT_LABEL[v.aspect]} だけ直す`, L.only, () => { L.only = !L.only; refresh(); }, "warn"),
        lamp("書き出しの見え方", clean, () => { clean = !clean; refresh(); }),
      ),
    );
    colorsBox.hidden = !colorOpen;
    colorsBox.replaceChildren(
      ...COLOR_KEYS.map(([k, label]) => {
        const id = `vid-c-${k}`, inp = el("input", { type: "color", id });
        inp.value = v.colors[k as keyof Colors];
        inp.addEventListener("input", () => {
          v.colors[k as keyof Colors] = inp.value;
          v.preset = "custom";
        });
        inp.addEventListener("change", () => { saveSoon(); buildBoard(); });
        return el("label", { class: "vid-cin", for: id }, inp, el("span", {}, label));
      }),
      key("元に戻す", change(() => { const p = PRESETS[v.preset as keyof typeof PRESETS] ?? PRESETS.shuden; v.colors = { ...p } as unknown as Colors; }), "tx"),
    );
  }

  // ---- インスペクタ ----
  function renderInspector(): void {
    const tabs = el("div", { class: "vid-tabs", role: "tablist" });
    for (const [k, l] of [["base", "素材"], ["panels", "パネル"], ["top", "上"]] as const) {
      tabs.append(el("button", { type: "button", class: "vid-tab", role: "tab", "aria-selected": tab === k ? "true" : "false", on: () => { tab = k; renderInspector(); } }, l));
    }
    insp.replaceChildren(tabs);
    if (tab === "base") baseInsp();
    else if (tab === "top") topInsp();
    else panelInsp();
  }
  const edit = (fn: () => void) => () => {
    fn();
    saveSoon();
    refresh();
  };

  function baseInsp(): void {
    const B = v.layers.base;
    insp.append(section("素材の層", row(...([["none", "なし"], ["cut", "切り替え"], ["collage", "コラージュ"]] as const).map(([k, l]) => lamp(l, B.mode === k, edit(() => (B.mode = k)))))));
    const names: [Treatment, string][] = [["plain", "そのまま"], ["crt", "CRT"], ["halftone", "網点"], ["mosh", "モッシュ"], ["track", "追跡"], ["key", "色抜き"], ["thresh", "二値化"], ["contour", "等高線"], ["edge", "輪郭線"], ["stretch", "引き伸ばし"], ["led", "LED"]];
    insp.append(section("処理", row(...names.map(([k, l]) => lamp(l, B.treat[k], edit(() => (B.treat[k] = !B.treat[k])))))));
    if (B.mode !== "none") {
      const knobs = B.mode === "collage"
        ? [slider("密度", () => B.density, (x) => (B.density = x)), slider("残る長さ", () => B.life / 8, (x) => (B.life = Math.max(0.25, x * 8)), (x) => `${Math.max(0.25, x * 8).toFixed(1)}拍`)]
        : [slider("寄り", () => B.zoom, (x) => (B.zoom = x))];
      knobs.push(slider("暗く", () => B.dim, (x) => (B.dim = x)));
      const box = el("div", { class: "vid-sls" }, ...knobs);
      box.addEventListener("change", saveSoon);
      insp.append(section("つまみ", box));
    }
    const shelf = el("div", { class: "vid-shelf" });
    for (const m of mats) {
      const th = el("canvas", { class: "vid-thumb", width: "64", height: "48" });
      try {
        const [iw, ih] = srcSize(m);
        th.getContext("2d")!.drawImage(m.el, 0, 0, iw, ih, 0, 0, 64, 48);
      } catch {
        // まだ描けない動画
      }
      const s = el("select", { "aria-label": `${m.name} を出すトラック` });
      for (const [val, label] of [["", "どれでも"], ["chop", "刻んだ音"], ["drum", "ドラム"]]) {
        const o = el("option", { value: val }, label);
        o.selected = (m.tr ?? "") === val;
        s.append(o);
      }
      s.addEventListener("change", () => setMaterialTrack(m, s.value === "chop" || s.value === "drum" ? s.value : null));
      shelf.append(el("div", { class: "vid-mat" }, th, el("span", { class: "vid-mname" }, m.sample ? `${m.name}（見本）` : m.name), s, key("外す", () => removeMaterial(m), "tx")));
    }
    const fin = el("input", { type: "file", accept: "image/*,video/*", multiple: "" });
    fin.addEventListener("change", () => [...(fin.files ?? [])].forEach((file) => void addFile(file)));
    const kids: Node[] = [shelf, el("label", { class: "vid-file" }, fin)];
    if (matError) kids.push(el("p", { class: "vid-err" }, matError));
    insp.append(section(`素材 ${mats.length}`, ...kids));
  }
  /** 保存した素材（Blob）から、描ける要素を作る。 */
  function materialFrom(rec: StoredMaterial): Promise<Material> {
    const url = URL.createObjectURL(rec.blob);
    return new Promise((resolve, reject) => {
      if (rec.kind === "video") {
        const vid = document.createElement("video");
        vid.muted = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.addEventListener("loadeddata", () => {
          void vid.play().catch(() => {});
          resolve({ id: rec.id, name: rec.name, kind: "video", el: vid, tr: rec.tr });
        }, { once: true });
        vid.addEventListener("error", () => reject(new Error(rec.name)), { once: true });
        vid.src = url;
      } else {
        const im = new Image();
        im.onload = () => resolve({ id: rec.id, name: rec.name, kind: "image", el: im, tr: rec.tr });
        im.onerror = () => reject(new Error(rec.name));
        im.src = url;
      }
    });
  }
  function addOwn(m: Material): void {
    if (mats.length && mats.every((x) => x.sample)) mats.length = 0; // 自分の素材を入れたら、見本は下げる
    mats.push(m);
  }
  async function addFile(file: File): Promise<void> {
    const kind = file.type.startsWith("video") ? "video" : "image";
    const rec: StoredMaterial = { id: `mat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: file.name, kind, blob: file, tr: null, createdAt: Date.now() };
    try {
      const m = await materialFrom(rec);
      records.set(rec.id, rec);
      addOwn(m);
      matError = "";
      await deps.materials.save(rec);
    } catch (err) {
      console.error("素材を読み込めませんでした", err);
      matError = `${file.name} を読み込めませんでした。別の形式で試してください。`;
    }
    renderInspector();
  }
  async function loadOwnMaterials(): Promise<void> {
    try {
      for (const rec of await deps.materials.load()) {
        records.set(rec.id, rec);
        const m = await materialFrom(rec).catch(() => null);
        if (!m) continue;
        if (rec.panelId !== undefined) rt.imgs.set(rec.panelId, m.el as HTMLImageElement);
        else addOwn(m);
      }
    } catch (err) {
      console.error("素材の一覧を読み込めませんでした", err);
    }
    if (tab === "base") renderInspector();
  }
  function setMaterialTrack(m: Material, tr: Material["tr"]): void {
    m.tr = tr;
    const rec = records.get(m.id);
    if (rec) void deps.materials.save({ ...rec, tr }).catch((err) => console.error("素材を保存できませんでした", err));
  }
  function removeMaterial(m: Material): void {
    mats.splice(mats.indexOf(m), 1);
    if (records.has(m.id)) {
      records.delete(m.id);
      void deps.materials.remove(m.id).catch((err) => console.error("素材を消せませんでした", err));
    }
    if (!mats.length) mats.push(...samples);
    renderInspector();
  }

  function topInsp(): void {
    const T = v.layers.top;
    const inp = el("input", { type: "text", maxlength: "40", "aria-label": "大きな文字" });
    inp.value = T.text;
    inp.addEventListener("input", () => (T.text = inp.value));
    inp.addEventListener("change", saveSoon);
    insp.append(section("大きな文字", row(lamp("出す", T.show, edit(() => (T.show = !T.show))), el("label", { class: "vid-txt" }, inp))));
    insp.append(section("飾り", row(lamp("光る輪", T.ring, edit(() => (T.ring = !T.ring))), lamp("細い線", T.lines, edit(() => (T.lines = !T.lines))))));
    insp.append(section("置き場所", row(...([["lt", "左上"], ["c", "真ん中"], ["lb", "左下"]] as const).map(([k, l]) => lamp(l, T.pos === k, edit(() => (T.pos = k)))))));
    const sz = el("div", { class: "vid-sls" }, slider("大きさ", () => T.size, (x) => (T.size = x)));
    sz.addEventListener("change", saveSoon);
    insp.append(section("大きさ", sz));
  }

  function panelInsp(): void {
    const lf = L.find(sel), A = ASPECT_LABEL[v.aspect], PL = v.layers.panels;
    const alpha = el("div", { class: "vid-sls" }, slider("面の濃さ", () => PL.alpha, (x) => (PL.alpha = x)));
    alpha.addEventListener("change", saveSoon);
    insp.append(section("パネルの層", row(lamp("出す", PL.show, edit(() => (PL.show = !PL.show)))), alpha));
    const nOv = Object.keys(v.ov[v.aspect]).length;
    if (L.only || nOv) {
      const r = el("div", { class: "vid-scope" }, el("span", {}, L.only ? `${A} だけに効きます` : `${A} に直しが ${nOv} か所あります`));
      if (nOv) r.append(key("全部戻す", edit(() => L.resetAspect()), "tx"));
      insp.append(r);
    }
    if (!lf) {
      insp.append(section("パネル", row(key("浮かせて足す", edit(() => {
        const n = L.newLeaf(L.unused(KEYS_RANDOM, Math.random), { style: "none", float: { anchor: "c", ox: 0, oy: 0, w: 0.5, h: 0.3 } });
        v.floats.push(n);
        sel = n.id;
      })))));
      return;
    }
    const isFloat = L.isFloat(lf), cur = L.eff(lf, "panel") ?? lf.panel;
    const kinds = el("div", { class: "vid-kinds" });
    for (const g of GROUPS) {
      const keys = PANEL_ORDER.filter((k) => (PANELS[k].g ?? "その他") === g).concat(g === "その他" ? ["blank"] : []);
      const list = el("div", { class: "vid-kind-list" });
      for (const k of keys) {
        const label = k === "blank" ? "余白" : PANELS[k].ja;
        list.append(el("button", { type: "button", class: "vid-kind" + (cur === k ? " on" : ""), "aria-pressed": cur === k ? "true" : "false", on: edit(() => L.set(lf, "panel", k)) }, label));
      }
      kinds.append(el("div", { class: "vid-kind-row" }, el("span", { class: "vid-kind-g" }, g), list));
    }
    insp.append(section(isFloat ? "中身（浮き）" : "中身", kinds));
    if (cur === "sozai") {
      const fin = el("input", { type: "file", accept: "image/*" });
      fin.addEventListener("change", () => {
        const file = fin.files?.[0];
        if (!file) return;
        const rec: StoredMaterial = { id: `panel_${lf.id}`, name: file.name, kind: "image", blob: file, tr: null, panelId: lf.id, createdAt: Date.now() };
        void materialFrom(rec).then((m) => {
          rt.imgs.set(lf.id, m.el as HTMLImageElement);
          return deps.materials.save(rec);
        }).catch((err) => console.error("素材パネルの画像を読み込めませんでした", err));
      });
      insp.append(section("画像", el("label", { class: "vid-file" }, fin)));
    }
    if (cur !== "blank") {
      const frames = row(...([["card", "面"], ["line", "縫い目"], ["kakko", "「」"], ["none", "なし"]] as [FrameStyle, string][]).map(([k, l]) => lamp(l, L.eff(lf, "style") === k, edit(() => L.set(lf, "style", k)))));
      const ledV = L.eff(lf, "led"), ledOn = ledV == null ? v.fx.led || !!PANELS[cur]?.led : ledV;
      const cin = el("input", { type: "color", "aria-label": "このパネルの差し色" });
      cin.value = L.eff(lf, "color") || v.colors.a1;
      cin.addEventListener("change", edit(() => L.set(lf, "color", cin.value)));
      const look = row(lamp("LED", ledOn, edit(() => L.set(lf, "led", !ledOn))), el("label", { class: "vid-cin" }, cin, el("span", {}, "差し色")));
      if (L.eff(lf, "color")) look.append(key("全体に合わせる", edit(() => L.set(lf, "color", null)), "tx"));
      insp.append(section("枠", frames), section("表示", look));
    }
    if (!isFloat) {
      const sp = el("div", { class: "vid-splits" });
      for (const [label, horiz] of [["上下", false], ["左右", true]] as const) {
        sp.append(row(el("span", { class: "vid-rl" }, label), ...[2, 3, 4].map((n) => key(String(n), edit(() => L.split(lf, horiz, n, KEYS_RANDOM, Math.random)), "num"))));
      }
      insp.append(section("割る", sp));
    }
    const ops = row(lamp("固定", !!lf.locked, edit(() => (lf.locked = !lf.locked))));
    if (isFloat) ops.append(key("木に戻す", edit(() => L.unfloat(lf))));
    else if (v.tree !== lf) ops.append(key("浮かせる", edit(() => L.float(lf))));
    if (L.overridden(lf)) ops.append(key(`${A} の直しを戻す`, edit(() => L.resetNode(lf))));
    if (isFloat || v.tree !== lf) ops.append(key("消す", edit(() => { L.delete(lf); sel = null; }), "danger"));
    insp.append(section("操作", ops));
  }

  function refresh(): void {
    renderOverlay();
    renderInspector();
    buildBoard();
  }

  loadSettings();
  sizeStage();
  refresh();
  void loadOwnMaterials();

  return {
    el: root,
    tick,
    key(code) {
      if (code === "KeyR") {
        shuffle();
        return true;
      }
      if (code === "Escape") {
        sel = null;
        refresh();
        return true;
      }
      return false;
    },
    setSong() {
      loadSettings();
      builtFrom = null;
      sizeStage();
      refresh();
    },
  };
}
