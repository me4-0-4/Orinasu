import { LoopPlayer } from "../audio/loopPlayer";
import { encodeWav } from "../audio/wav";
import {
  applySeeds,
  buildCollage,
  collectSources,
  hasDrums,
  pickDrum,
  rerollLanes,
  seedSnapshot,
  syncLanes,
  type ReverbFn,
  type CollageResult,
  type RenderOpts,
  type RerollPart,
  type SeedSnapshot,
} from "../mix/collageSong";
import type { Pcm } from "../mix/pcm";
import { repeatPcm } from "../mix/loopFold";
import { STEPS_PER_BEAT, holdFraction } from "../mix/sequencer";
import { musicSlotSteps } from "../mix/musicChop";
import { divisionsFor, sliceLimits, type CutMode } from "../mix/slicer";
import {
  LENGTH_OPTIONS,
  MAX_BPM,
  MAX_LANE_VOLUME,
  MIN_BPM,
  createEmptySong,
  formatDuration,
  effectiveParams,
  laneIsCustom,
  setLaneShape,
  songSeconds,
  type ChopStyle,
  type Lane,
  type ShapeKey,
  type Song,
  type TurnStyle,
} from "../mix/types";
import type { Phrase } from "../phrase/types";
import { randomSeed } from "../theory/rng";
import { ENV_H, HEAD_H, ROW_H, buildLaneView, type Row } from "./laneView";
import { buildFxWindow } from "./fxWindow";
import { ENV_PARAM_LABELS, FX_LABELS, FX_SHORT, emptyTrack, trackHasFx, type EnvPoint, type TrackFx } from "../mix/fx";
import { button, choice, el, knob, note, section, type Control } from "./mixWidgets";
import { assignToGroup, groupOf, newGroup, type HitGroup, type HitRef } from "../mix/groups";

export interface MixPanelDeps {
  /** 保存されているフレーズ（刻む曲の候補）。 */
  getPhrases: () => Phrase[];
  /** 曲が変わったので保存してほしい。 */
  onSongChange: (song: Song) => void;
  /** 鳴らす前に呼ぶ：音を出す準備と、ほかの音（演奏・フレーズの再生）を止める。 */
  prepareAudio: () => Promise<void>;
  audio: { ctx: AudioContext; out: AudioNode };
  /** フレーズを、指定のBPMで1周ぶんの波形に書き出す。 */
  render: (phrase: Phrase, bpm: number, opts: RenderOpts) => Promise<Pcm>;
  /** リバーブの響きだけを作る（エフェクトのリバーブに使う）。 */
  reverb: ReverbFn;
}

export interface MixPanel {
  el: HTMLElement;
  setSong: (song: Song) => void;
  /** フレーズ一覧が変わったとき。 */
  refreshMaterials: () => void;
  /** 鳴らしているものを止める。 */
  stop: () => void;
  /** 毎フレーム呼ぶ。再生位置の線と時間の表示を動かす。 */
  tick: () => void;
  /** 再生⇔停止（スペースキー用）。 */
  togglePlay: () => void;
}

/** いま右のインスペクタに出しているもの：曲・トラック・断片。 */
/** 選んだ断片（track はトラックの鍵 lane:<曲のid>）。 */
type Hit = { track: string; step: number };
type Selection =
  | { type: "song" }
  | { type: "track"; key: string }
  | { type: "hit"; track: string; step: number }
  | { type: "hits"; hits: Hit[] }
  | { type: "group"; id: string };

/**
 * 刻むタブ（DAW 風）。
 * - 上：トランスポート（再生・位置・BPM・長さ・刻む・元に戻す・書き出し）
 * - 左：アレンジ画面。トラックヘッダー（名前・ミュート・音量・FX）と、トラックの線（断片・エンベロープ）
 * - 右：インスペクタ。選んだもの（曲／トラック／断片）の設定だけを出す
 */
export function buildMixPanel(deps: MixPanelDeps): MixPanel {
  let song: Song = createEmptySong();
  let result: CollageResult | null = null;
  /** 作り直しの途中で、新しい作り直しが始まったら古いほうを捨てるための番号。 */
  let buildToken = 0;
  let rebuildTimer: number | null = null;
  /** BPMを自分で触ったか。触っていなければ、最初に刻むときだけ、いちばん上のトラックの曲のテンポから始める。 */
  let bpmTouched = false;
  const undoStack: SeedSnapshot[] = [];
  const redoStack: SeedSnapshot[] = [];
  /** 最後に作ったときの、トラックの曲の更新時刻（フレーズを直したら作り直すため）。 */
  let builtStamps = "";
  let sel: Selection = { type: "song" };
  let busy = "";
  const renderCache = new Map<string, Promise<Pcm>>();
  /** 素材から外したトラック（また選んだら、設定ごと戻す）。この画面を開いているあいだだけ覚える。 */
  const removedLanes = new Map<string, Lane>();
  const player = new LoopPlayer(deps.audio.ctx, deps.audio.out);
  const sampleRate = deps.audio.ctx.sampleRate;

  function stampsOf(lanes: Lane[]): string {
    const phrases = deps.getPhrases();
    const byId = new Map(phrases.map((p) => [p.id, p.updatedAt]));
    const drum = pickDrum(song, phrases);
    return [...lanes.map((l) => l.phraseId), ...(drum ? [drum] : [])].map((id) => `${id}:${byId.get(id) ?? 0}`).join(",");
  }

  // ------------------------------------------------------------------ トラックとエフェクト

  const laneKey = (l: Pick<Lane, "phraseId">): string => `lane:${l.phraseId}`;
  const laneOfKey = (key: string): Lane | undefined => song.lanes?.find((l) => laneKey(l) === key);
  const totalStepsNow = (): number => song.lengthBars * song.beatsPerBar * STEPS_PER_BEAT;
  const drumNow = (): string | null => {
    const phrases = deps.getPhrases();
    const drum = pickDrum(song, phrases);
    return drum && phrases.some((p) => p.id === drum && hasDrums(p)) ? drum : null;
  };
  function trackFx(key: string): TrackFx {
    if (key === "master" || key === "bed" || key === "pad") return song.fx[key];
    return laneOfKey(key)?.fx ?? emptyTrack();
  }
  function setTrackFx(key: string, fx: TrackFx): void {
    if (key === "master" || key === "bed" || key === "pad") {
      song.fx = { ...song.fx, [key]: fx };
      return;
    }
    song.lanes = song.lanes?.map((l) => {
      if (laneKey(l) !== key) return l;
      const { fx: _old, ...rest } = l;
      return fx.chain.length === 0 ? rest : { ...rest, fx };
    });
  }
  function setTakeFx(track: string, step: number, fx: TrackFx): void {
    song.lanes = song.lanes?.map((l) => {
      if (laneKey(l) !== track) return l;
      const takes = (l.takes ?? []).filter((t) => t.step !== step);
      if (fx.chain.length > 0) takes.push({ step, chain: fx.chain });
      const { takes: _old, ...rest } = l;
      return takes.length === 0 ? rest : { ...rest, takes: takes.sort((a, b) => a.step - b.step) };
    });
  }
  const takeOf = (track: string, step: number): TrackFx => ({
    chain: laneOfKey(track)?.takes?.find((t) => t.step === step)?.chain ?? [],
    envelopes: [],
  });
  function trackName(key: string): string {
    if (key === "master") return "マスター";
    if (key === "pad") return "パッド";
    const phrases = deps.getPhrases();
    if (key === "bed") return `ドラムループ（${phrases.find((p) => p.id === drumNow())?.name ?? "なし"}）`;
    return phrases.find((p) => `lane:${p.id}` === key)?.name ?? "トラック";
  }
  /** ステップを「小節.拍.16分」で（DAW と同じ数え方）。 */
  function posName(step: number): string {
    const spb = song.beatsPerBar * STEPS_PER_BEAT;
    return `${Math.floor(step / spb) + 1}.${Math.floor((step % spb) / STEPS_PER_BEAT) + 1}.${(step % STEPS_PER_BEAT) + 1}`;
  }
  /** 変更を保存して、画面を直して、音を作り直す。 */
  function changed(rebuildAfter = true): void {
    touch();
    refresh();
    if (rebuildAfter) scheduleRebuild();
  }

  const fxWindow = buildFxWindow({
    get: (t) =>
      t.type === "track" ? trackFx(t.key) : t.type === "take" ? takeOf(t.track, t.step) : { chain: groupById(t.id)?.fx ?? [], envelopes: [] },
    set: (t, fx) => {
      if (t.type === "track") setTrackFx(t.key, fx);
      else if (t.type === "take") setTakeFx(t.track, t.step, fx);
      else {
        song.groups = song.groups?.map((g) => (g.id === t.id ? { ...g, fx: fx.chain } : g));
      }
      changed();
    },
    title: (t) =>
      t.type === "track"
        ? `FX：${trackName(t.key)}`
        : t.type === "take"
          ? `テイクFX：${trackName(t.track)} ${posName(t.step)}`
          : `グループFX：${groupById(t.id)?.name ?? ""}`,
    totalSteps: totalStepsNow,
    onClose: () => refresh(),
  });
  const openTrackFx = (key: string): void => fxWindow.open({ type: "track", key });

  // ------------------------------------------------------------------ トランスポート

  const transport = el("div", "mix-transport");
  const playButton = button("▶ 再生", () => void togglePlay(), "preset-button tp-play", "再生／停止（スペースキー）");
  const posBox = el("div", "tp-pos");
  const posMain = el("span", "tp-pos-main", "1.1.1");
  const posTime = el("span", "tp-pos-time", "0:00 / 0:00");
  posBox.append(posMain, posTime);
  posBox.title = "位置（小節.拍.16分）と時間";
  const bpmInput = el("input", "tp-bpm");
  bpmInput.type = "number";
  bpmInput.min = String(MIN_BPM);
  bpmInput.max = String(MAX_BPM);
  bpmInput.title = "刻んだ曲のテンポ（もとのフレーズのBPMとは別）";
  bpmInput.addEventListener("change", () => {
    const v = Math.round(Number(bpmInput.value));
    if (!Number.isFinite(v) || bpmInput.value === "") {
      bpmInput.value = String(song.bpm);
      return;
    }
    song.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, v));
    bpmTouched = true;
    touch();
    refresh();
    if (song.lanes) void rebuild(); // 新しいテンポで、曲を書き出し直す
  });
  const bpmBox = el("label", "tp-field");
  bpmBox.append(el("span", "tp-label", "BPM"), bpmInput);
  const lengthSelect = el("select", "quantize-select tp-length");
  lengthSelect.title = "曲の長さ（かっこの中は、いまのテンポでの時間）";
  for (const n of LENGTH_OPTIONS) {
    const o = el("option", undefined, `${n}小節`);
    o.value = String(n);
    lengthSelect.appendChild(o);
  }
  lengthSelect.addEventListener("change", () => {
    song.lengthBars = Number(lengthSelect.value);
    changed();
  });
  const lengthBox = el("label", "tp-field");
  lengthBox.append(el("span", "tp-label", "長さ"), lengthSelect);
  // 刻む（▾で、部分だけ刻み直す）
  const chopButton = button("刻む", () => void chop("all"), "roll-button tp-chop", "選んだ素材を、新しく刻む（固定したトラックは残す）");
  const chopMore = button("▾", () => {
    chopMenu.hidden = !chopMenu.hidden;
  }, "preset-button tp-chop-more", "一部だけ刻み直す");
  const chopMenu = el("div", "tp-menu");
  chopMenu.hidden = true;
  for (const [part, label, desc] of [
    ["cut", "切れ目だけ", "断片の切れ目だけ変える（打つ所と順番はそのまま）"],
    ["rhythm", "リズムだけ", "打つ所だけ変える"],
    ["order", "順番だけ", "どの断片を打つか（と音程）だけ変える"],
  ] as const) {
    const item = button("", () => {
      chopMenu.hidden = true;
      void chop(part);
    }, "tp-menu-item");
    item.append(el("span", "tp-menu-label", label), el("span", "tp-menu-desc", desc));
    chopMenu.appendChild(item);
  }
  document.addEventListener("pointerdown", (e) => {
    if (!chopMenu.hidden && !chopMenu.contains(e.target as Node) && e.target !== chopMore) chopMenu.hidden = true;
  });
  const chopBox = el("div", "tp-chop-box");
  chopBox.append(chopButton, chopMore, chopMenu);
  const undoButton = button("↶", () => undo(), "preset-button", "元に戻す（ひとつ前の刻みに）");
  const redoButton = button("↷", () => redo(), "preset-button", "やり直す（戻した刻みを、もう一度）");
  const statusText = el("span", "tp-status");
  const loopSelect = el("select", "quantize-select");
  loopSelect.title = "書き出すWAVに、曲を何回くり返して入れるか";
  for (const n of [1, 2, 4, 8]) {
    const o = el("option", undefined, `×${n}`);
    o.value = String(n);
    loopSelect.appendChild(o);
  }
  const exportButton = button("書き出し", () => saveWav(), "preset-button", "刻んだ曲を、WAVファイルにして保存する");
  const exportBox = el("div", "tp-export");
  exportBox.append(exportButton, loopSelect);
  transport.append(playButton, posBox, bpmBox, lengthBox, chopBox, undoButton, redoButton, statusText, exportBox);

  // ------------------------------------------------------------------ アレンジ画面（トラックヘッダー＋線）

  const laneView = buildLaneView({
    onHit: (track, step, add) => {
      if (step === null) {
        if (add || multiMode) return; // 足して選んでいる最中は、空いた所のタップで選び直さない
        sel = sel.type === "track" && sel.key === track ? { type: "song" } : { type: "track", key: track };
      } else if (add || multiMode) {
        // 足して選ぶ（もう選んでいれば外す）。グループを開いていたら、そのグループのメンバーを選び直す
        if (sel.type === "group") regrouping = sel.id;
        const cur = selectedHits();
        const has = cur.some((h) => h.track === track && h.step === step);
        setHits(has ? cur.filter((h) => !(h.track === track && h.step === step)) : [...cur, { track, step }]);
      } else {
        sel = sel.type === "hit" && sel.track === track && sel.step === step ? { type: "track", key: track } : { type: "hit", track, step };
        // テイクFXの窓を開いているなら、選んだ断片のテイクFXに切り替える
        if (sel.type === "hit" && fxWindow.target()?.type === "take") fxWindow.open({ type: "take", track, step });
      }
      refresh();
    },
    onRect: (hits, add) => {
      if (sel.type === "group" && (add || multiMode)) regrouping = sel.id;
      setHits(add || multiMode ? [...selectedHits(), ...hits] : hits);
      refresh();
    },
    onEnvEdit: (id, points: EnvPoint[]) => {
      for (const key of allTrackKeys()) {
        const fx = trackFx(key);
        if (!fx.envelopes.some((e) => e.id === id)) continue;
        setTrackFx(key, { ...fx, envelopes: fx.envelopes.map((e) => (e.id === id ? { ...e, points } : e)) });
        break;
      }
      changed();
    },
  });
  const allTrackKeys = (): string[] => [...(song.lanes ?? []).map(laneKey), "bed", "pad", "master"];

  // --- 断片の選び方（いくつでも）とグループ ---
  /** 足して選ぶモード（タッチでシフトの代わり）。 */
  let multiMode = false;
  /** グループのメンバーを選び直している最中なら、そのグループのid。 */
  let regrouping: string | null = null;
  const toRef = (h: Hit): HitRef => ({ phraseId: h.track.slice(5), step: h.step });
  const toHit = (r: HitRef): Hit => ({ track: `lane:${r.phraseId}`, step: r.step });
  function selectedHits(): Hit[] {
    if (sel.type === "hit") return [{ track: sel.track, step: sel.step }];
    if (sel.type === "hits") return sel.hits;
    if (sel.type === "group") return groupById(sel.id)?.members.map(toHit) ?? [];
    return [];
  }
  function setHits(hits: Hit[]): void {
    const seen = new Map(hits.map((h) => [`${h.track}@${h.step}`, h]));
    const list = [...seen.values()].sort((a, b) => a.step - b.step);
    sel = list.length === 0 ? { type: "song" } : list.length === 1 && !regrouping ? { type: "hit", ...list[0] } : { type: "hits", hits: list };
  }
  const groupById = (id: string): HitGroup | undefined => song.groups?.find((g) => g.id === id);
  function updateGroup(id: string, fn: (g: HitGroup) => HitGroup): void {
    song.groups = song.groups?.map((g) => (g.id === id ? fn(g) : g));
    changed();
  }
  function makeGroup(hits: Hit[]): void {
    const g = newGroup(hits.map(toRef), song.groups ?? []);
    song.groups = assignToGroup(song.groups ?? [], g, g.members);
    regrouping = null;
    sel = { type: "group", id: g.id };
    changed();
  }

  const headerCol = el("div", "arr-headers");
  const arrange = el("div", "mix-arrange");
  const arrangeBody = el("div", "arr-body");
  arrangeBody.append(headerCol, laneView.el);
  const notice = el("div", "arr-notice");
  arrange.append(arrangeBody);

  /** トラックヘッダーの1行（つまみを動かしている最中に作り直さないよう、行の並びが変わったときだけ作り直す）。 */
  let headerSignature = "";
  let headerRefreshers: (() => void)[] = [];
  function renderHeaders(rows: Row[]): void {
    const signature = JSON.stringify(rows.map((r) => [r.type, r.key]));
    if (signature !== headerSignature) {
      headerSignature = signature;
      headerRefreshers = [];
      headerCol.innerHTML = "";
      const ruler = el("div", "arr-head-ruler", "トラック");
      ruler.style.height = `${HEAD_H}px`;
      headerCol.appendChild(ruler);
      for (const row of rows) headerCol.appendChild(row.type === "track" ? trackHeader(row.key, row.kind) : envHeader(row.key));
    }
    for (const f of headerRefreshers) f();
  }

  function trackHeader(key: string, kind: "lane" | "bed" | "pad" | "master"): HTMLElement {
    const box = el("div", `arr-head arr-head-${kind}`);
    box.style.height = `${ROW_H}px`;
    const name = el("button", "arr-name");
    name.type = "button";
    name.addEventListener("click", () => {
      sel = sel.type === "track" && sel.key === key ? { type: "song" } : { type: "track", key };
      refresh();
    });
    box.appendChild(name);
    let mute: HTMLButtonElement | null = null;
    if (kind === "lane") {
      mute = button("M", () => {
        const lane = laneOfKey(key);
        if (!lane) return;
        updateLane(key, (l) => ({ ...l, muted: !l.muted }));
      }, "arr-btn arr-mute", "ミュート");
      box.appendChild(mute);
    }
    let vol: HTMLInputElement | null = null;
    if (kind !== "master") {
      vol = el("input", "arr-vol");
      vol.type = "range";
      vol.min = "0";
      vol.max = kind === "lane" ? String(MAX_LANE_VOLUME) : "1";
      vol.step = "0.01";
      vol.title = kind === "lane" ? "音量" : kind === "bed" ? "ドラムループの音量" : "パッドの量";
      vol.addEventListener("input", () => {
        const v = Number(vol!.value);
        if (kind === "lane") {
          updateLane(key, (l) => {
            const { volume: _v, ...rest } = l;
            return Math.abs(v - 1) < 1e-9 ? rest : { ...rest, volume: v };
          });
        } else if (kind === "bed") {
          song.params.bedVolume = v;
          changed();
        } else {
          song.params.pad = v;
          changed();
        }
      });
      vol.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
      box.appendChild(vol);
    } else {
      box.appendChild(el("span", "arr-vol-spacer"));
    }
    const fx = button("FX", () => openTrackFx(key), "arr-btn arr-fx", "このトラックのFXチェーンを開く");
    box.appendChild(fx);
    headerRefreshers.push(() => {
      const lane = laneOfKey(key);
      const selected = (sel.type === "track" && sel.key === key) || (sel.type === "hit" && sel.track === key);
      box.classList.toggle("selected", selected);
      box.classList.toggle("muted", !!lane?.muted);
      // ヘッダーは短い名前（ドラムループの元のフレーズは、乗せたときの説明とインスペクタで）
      name.textContent = `${lane?.locked ? "🔒 " : ""}${kind === "bed" ? "ドラムループ" : trackName(key)}`;
      name.title = `${trackName(key)}（タップで選ぶ）`;
      if (mute) mute.classList.toggle("on", !!lane?.muted);
      if (vol && document.activeElement !== vol) {
        vol.value = String(kind === "lane" ? (lane?.volume ?? 1) : kind === "bed" ? song.params.bedVolume : song.params.pad);
      }
      fx.classList.toggle("on", trackHasFx(trackFx(key)));
      fx.textContent = trackHasFx(trackFx(key)) ? `FX ${trackFx(key).chain.filter((p) => !p.bypass).length}` : "FX";
    });
    return box;
  }

  function envHeader(id: string): HTMLElement {
    const box = el("div", "arr-head arr-head-env");
    box.style.height = `${ENV_H}px`;
    const label = el("span", "arr-env-label");
    const toggle = button("", () => editEnvelope(id, (e) => ({ ...e, active: !e.active })), "arr-btn", "エンベロープのオン／オフ");
    const hide = button("×", () => editEnvelope(id, (e) => ({ ...e, visible: false })), "arr-btn", "しまう（FXの窓の [E] でまた出せる）");
    box.append(label, toggle, hide);
    box.title = "線の上：タップで点を足す／ドラッグで動かす／ダブルタップ（右クリック）で消す";
    headerRefreshers.push(() => {
      const found = findEnvelope(id);
      if (!found) return;
      const p = found.fx.chain.find((x) => x.id === found.env.pluginId);
      label.textContent = `└ ${p ? FX_SHORT[p.kind] : ""} ${ENV_PARAM_LABELS[found.env.param]}`;
      toggle.textContent = found.env.active ? "ON" : "OFF";
      toggle.classList.toggle("on", found.env.active);
    });
    return box;
  }
  function findEnvelope(id: string) {
    for (const key of allTrackKeys()) {
      const fx = trackFx(key);
      const env = fx.envelopes.find((e) => e.id === id);
      if (env) return { key, fx, env };
    }
    return null;
  }
  function editEnvelope(id: string, fn: (e: TrackFx["envelopes"][number]) => TrackFx["envelopes"][number]): void {
    const found = findEnvelope(id);
    if (!found) return;
    setTrackFx(found.key, { ...found.fx, envelopes: found.fx.envelopes.map((e) => (e.id === id ? fn(e) : e)) });
    changed();
  }

  // ------------------------------------------------------------------ インスペクタ

  const inspector = el("div", "mix-inspector");
  const insHead = el("div", "ins-head");
  const crumbs = el("div", "ins-crumbs");
  const hintToggle = button("説明を表示", () => {
    showHints = !showHints;
    try {
      localStorage.setItem("orinasu.mix.hints", showHints ? "1" : "0");
    } catch {
      // 覚えられなくても動く
    }
    refresh();
  }, "preset-button ins-hint-toggle", "つまみの説明を出す／隠す（マウスを乗せても出る）");
  let showHints = false;
  try {
    showHints = localStorage.getItem("orinasu.mix.hints") === "1";
  } catch {
    showHints = false;
  }
  const multiToggle = button("複数選択", () => {
    multiMode = !multiMode;
    refresh();
  }, "preset-button ins-hint-toggle", "オンのあいだ、断片をタップすると足して選ぶ（シフト＋クリックと同じ）");
  const insTools = el("div", "preset-row");
  insTools.append(multiToggle, hintToggle);
  insHead.append(crumbs, insTools);
  const songPanel = el("div", "ins-panel");
  const trackPanel = el("div", "ins-panel");
  const hitPanel = el("div", "ins-panel");
  const hitsPanel = el("div", "ins-panel");
  const groupPanel = el("div", "ins-panel");
  inspector.append(insHead, songPanel, trackPanel, hitPanel, hitsPanel, groupPanel);

  const controls: Control[] = [];
  const reg = <T extends Control>(c: T): T => {
    controls.push(c);
    return c;
  };
  const show = (c: Control | HTMLElement, visible: boolean): void => {
    ("el" in c ? c.el : c).hidden = !visible;
  };

  // --- 曲：グループの一覧 ---
  const groupList = el("div", "ins-group-list");

  // --- 曲：素材 ---
  const materialList = el("div", "mix-list");
  const materialEmpty = el("div", "layer-empty", "フレーズタブで保存したフレーズが、ここに並ぶ");
  function renderMaterials(): void {
    const phrases = deps.getPhrases();
    materialList.innerHTML = "";
    materialEmpty.hidden = phrases.length > 0;
    for (const p of phrases) {
      const row = el("label", "layer-row");
      const check = el("input");
      check.type = "checkbox";
      check.checked = song.materialIds.includes(p.id);
      check.addEventListener("change", () => {
        // 外したトラックの設定（種・FX・テイクFX・ずらし・音量）は取っておき、また選んだら戻す
        const old = song.lanes?.find((l) => l.phraseId === p.id);
        if (!check.checked && old) removedLanes.set(p.id, old);
        song.materialIds = check.checked ? [...song.materialIds, p.id] : song.materialIds.filter((id) => id !== p.id);
        if (song.lanes) {
          const kept = check.checked ? removedLanes.get(p.id) : undefined;
          song.lanes = syncLanes(song, randomSeed).map((l) => (kept && l.phraseId === p.id ? kept : l)); // トラックを足す・消す（ほかのトラックはそのまま）
        }
        changed();
      });
      row.append(check, el("span", "layer-role-label", `${p.name}（${p.lengthBars}小節・元${p.bpm}BPM）`));
      materialList.appendChild(row);
    }
  }

  // --- 曲：情報 ---
  const nameInput = el("input", "mix-name");
  nameInput.type = "text";
  nameInput.placeholder = "曲の名前（書き出すファイル名）";
  nameInput.addEventListener("input", () => {
    song.name = nameInput.value;
    touch();
  });
  const nameRow = el("label", "ins-row ins-choice");
  nameRow.append(el("span", "ins-label", "名前"), nameInput);
  const keyInfo = el("div", "ins-meta");

  // --- 曲：刻み方 ---
  const styleChoice = reg(
    choice<ChopStyle>({
      label: "モード",
      options: () => [
        ["music", "音楽（拍とコードを守る）"],
        ["material", "素材（phrz風。自由に切る）"],
      ],
      get: () => song.params.style,
      set: (v) => {
        song.params.style = v;
        changed();
      },
      hint: () =>
        song.params.style === "music"
          ? "拍の格子で切って、元の同じ小節（コード）から取る。1〜2小節のパターンをくり返し、4小節目はフィル"
          : "音の立ち上がりか等分で自由に切って、偶然で打つ。複数のトラックは重なる",
    }),
  );
  const turnsChoice = reg(
    choice<TurnStyle>({
      label: "組み方",
      options: () => [
        ["mix", "混ぜる（1つのリズムに）"],
        ["call", "掛け合い（2拍ずつ）"],
        ["swap", "交代（4小節ずつ）"],
      ],
      get: () => song.params.turns,
      set: (v) => {
        song.params.turns = v;
        changed();
      },
      hint: () =>
        ({
          mix: "1つのリズムの中で、打つ1回ごとにどのトラックの断片を使うかを偶然で決める（刻み方は全体のつまみ。トラックごとのずらしは効かない）",
          call: "前半2拍と後半2拍を別のトラックが受け持つ（4小節ごとに呼ぶ側が替わる）",
          swap: "4小節ごとに、鳴らすトラックが替わる",
        })[song.params.turns],
    }),
  );
  const cutChoice = reg(
    choice<CutMode>({
      label: "切り方",
      options: () => [
        ["transient", "アタックで切る"],
        ["divide", "等分に切る"],
      ],
      get: () => song.params.mode,
      set: (v) => {
        song.params.mode = v;
        changed();
      },
    }),
  );
  /** 刻み方のつまみ（全体）。 */
  const shapeKnob = (key: ShapeKey, label: string, hint: () => string): Control =>
    reg(
      knob({
        label,
        get: () => song.params[key],
        set: (v) => {
          song.params[key] = v;
          changed();
        },
        hint,
      }),
    );
  const sizeHint = (v: number): string => {
    if (song.params.style === "music") {
      const words = { 1: "16分", 2: "8分", 4: "1拍" } as const;
      return `${words[musicSlotSteps(v)]}ごとに刻む（元の拍の位置にそろう）`;
    }
    const { minMs, maxMs } = sliceLimits(v);
    return song.params.mode === "divide" ? `曲を ${divisionsFor(v)} 等分` : `最短 ${minMs}ms・最長 ${maxMs}ms`;
  };
  const shapeDefs: [ShapeKey, string, (v: number) => string, "music" | "material" | "both"][] = [
    ["busy", "密度", () => "どれくらい打つか", "both"],
    ["breaks", "休み", (v) => `曲の約${Math.round(v * 50)}%を、まとめて休みにする`, "both"],
    ["onBeat", "拍に寄せる", () => "1・2・3・4拍目に打ちやすく", "both"],
    ["size", "断片の長さ", sizeHint, "both"],
    ["hold", "音の長さ", (v) => `次に打つ所までの ${Math.round(holdFraction(v, song.params.style) * 100)}% で切る`, "material"],
    ["crisp", "キレ", (v) => `小節の約${Math.round(v * 100)}%を、短い隙間でメリハリをつける（残りは隙間なくつなぐ）`, "music"],
    ["motion", "音程の動き", () => (song.params.style === "music" ? "繰り返しの1オクターブ上げ、フィルの終わりの階段" : "断片の高さを近い高さへ動かす"), "both"],
    ["pan", "パン", () => "刻んだ所を左右に交互に振る", "music"],
    ["fx", "フィルの加工", () => "フィルに、フィルター・テープストップ・音質下げ・逆再生のどれかを掛ける割合", "music"],
  ];
  const songShape = shapeDefs.map(([key, label, hint, mode]) => ({ mode, c: shapeKnob(key, label, () => hint(song.params[key])) }));
  const swingKnob = reg(
    knob({
      label: "スウィング",
      get: () => song.params.swing,
      set: (v) => {
        song.params.swing = v;
        changed();
      },
      hint: () => "16分の裏を後ろにずらして、はねさせる（100%で3連符のはね。ドラムループにも掛かる）",
    }),
  );

  // --- 曲：ドラムループ ---
  const drumChoice = reg(
    choice<string>({
      label: "ドラム",
      options: () => drumOptions(),
      get: () => drumNow() ?? "",
      set: (v) => {
        song.drumId = v === "" ? null : v;
        changed();
      },
      hint: () => "選んだフレーズのドラムだけを、刻まずに最初から最後まで鳴らす（ノリの軸）。刻む素材と同じフレーズでもいい",
    }),
  );
  const bedKnob = reg(
    knob({
      label: "音量",
      get: () => song.params.bedVolume,
      set: (v) => {
        song.params.bedVolume = v;
        changed();
      },
    }),
  );
  const pumpKnob = reg(
    knob({
      label: "サイドチェイン",
      get: () => song.params.pump,
      set: (v) => {
        song.params.pump = v;
        changed();
      },
      hint: () => "ドラムループのキックに合わせて、刻んだ音とパッドを沈ませる（キックが無ければ4つ打ちで）",
    }),
  );

  // --- 曲：仕上げ ---
  const sfxKnob = reg(
    knob({
      label: "効果音",
      get: () => song.params.sfx,
      set: (v) => {
        song.params.sfx = v;
        changed();
      },
      hint: () => "8小節ごとにライザーとインパクト・クラッシュ、4小節ごとにリバースシンバル",
    }),
  );
  const padKnob = reg(
    knob({
      label: "パッド",
      get: () => song.params.pad,
      set: (v) => {
        song.params.pad = v;
        changed();
      },
      hint: () => "元の曲の和音を引き伸ばして、うしろでうっすら鳴らし続ける（断片の間をつなぐ）",
    }),
  );
  const dryChoice = reg(
    choice<"dry" | "wet">({
      label: "素材の残響",
      options: () => [
        ["dry", "なし（キレよく）"],
        ["wet", "あり（フレーズのリバーブ・ディレイごと）"],
      ],
      get: () => (song.params.dry ? "dry" : "wet"),
      set: (v) => {
        song.params.dry = v === "dry";
        changed();
      },
      hint: () => "刻む前にフレーズを書き出すとき、フレーズ側のリバーブ・ディレイを含めるか",
    }),
  );

  songPanel.append(
    section("material", "素材", note("刻むフレーズを選ぶ。1つのフレーズが、1つのトラックになる"), materialEmpty, materialList),
    section(
      "chop",
      "刻み方",
      styleChoice.el,
      turnsChoice.el,
      cutChoice.el,
      ...songShape.map((s) => s.c.el),
      swingKnob.el,
    ),
    section("drums", "ドラムループ", drumChoice.el, bedKnob.el, pumpKnob.el),
    section("finish", "仕上げ", sfxKnob.el, padKnob.el, dryChoice.el, button("マスターのFXを開く", () => openTrackFx("master"), "preset-button")),
    section("groups", "グループ", note("断片をいくつか選んで「グループにする」と、まとめて刻み方・ミュート・FXを変えられる"), groupList),
    section("info", "曲の情報", nameRow, keyInfo),
  );

  // --- トラック ---
  const trackTitle = el("div", "ins-title");
  const lockButton = button("固定", () => sel.type === "track" && updateLane(sel.key, (l) => ({ ...l, locked: !l.locked }), false), "preset-button", "固定すると、刻み直してもこのトラックは変わらない");
  const muteButton = button("ミュート", () => sel.type === "track" && updateLane(sel.key, (l) => ({ ...l, muted: !l.muted })), "preset-button");
  const resetButton = button(
    "全体に戻す",
    () =>
      sel.type === "track" &&
      updateLane(sel.key, (l) => ({ phraseId: l.phraseId, cutSeed: l.cutSeed, rhythmSeed: l.rhythmSeed, orderSeed: l.orderSeed, locked: l.locked })),
    "preset-button",
    "このトラックのずらし・切り方・音量・ミュート・FX・テイクFXを消して、全体と同じにする",
  );
  const laneButtons = el("div", "preset-row");
  laneButtons.append(lockButton, muteButton, resetButton);
  const selLane = (): Lane | undefined => (sel.type === "track" ? laneOfKey(sel.key) : undefined);
  const laneVolume = reg(
    knob({
      label: "音量",
      max: MAX_LANE_VOLUME,
      get: () => selLane()?.volume ?? 1,
      set: (v) => {
        if (sel.type !== "track") return;
        updateLane(sel.key, (l) => {
          const { volume: _v, ...rest } = l;
          return Math.abs(v - 1) < 1e-9 ? rest : { ...rest, volume: v };
        });
      },
    }),
  );
  const laneCut = reg(
    choice<string>({
      label: "切り方",
      options: () => [
        ["", "全体と同じ"],
        ["transient", "アタックで切る"],
        ["divide", "等分に切る"],
      ],
      get: () => selLane()?.mode ?? "",
      set: (v) => {
        if (sel.type !== "track") return;
        updateLane(sel.key, (l) => {
          const { mode: _m, ...rest } = l;
          return v === "" ? rest : { ...rest, mode: v as CutMode };
        });
      },
    }),
  );
  const shiftNote = note("");
  const laneShape = shapeDefs.map(([key, label, , mode]) => ({
    mode,
    c: reg(
      knob({
        label,
        get: () => {
          const lane = selLane();
          return lane ? effectiveParams(song.params, lane)[key] : 0;
        },
        set: (v) => {
          if (sel.type !== "track") return;
          updateLane(sel.key, (l) => setLaneShape(l, song.params, key, v));
        },
        note: () => {
          const shift = selLane()?.shift?.[key] ?? 0;
          return Math.abs(shift) < 1e-9 ? "" : ` (全体${shift > 0 ? "＋" : "−"}${Math.round(Math.abs(shift) * 100)})`;
        },
      }),
    ),
  }));
  const laneShapeSection = section("laneShape", "刻み方（このトラックだけ・全体からのずらし）", shiftNote, ...laneShape.map((s) => s.c.el));
  const laneGroup = el("div", "ins-group");
  laneGroup.append(laneButtons, laneVolume.el, laneCut.el, laneShapeSection);
  const bedGroup = el("div", "ins-group");
  const drumOptions = (): [string, string][] => [["", "なし"], ...deps.getPhrases().filter(hasDrums).map((p): [string, string] => [p.id, `${p.name}のドラム`])];
  const bedDrum = reg(
    choice<string>({
      label: "ドラム",
      options: drumOptions,
      get: () => drumNow() ?? "",
      set: (v) => {
        song.drumId = v === "" ? null : v;
        changed();
      },
    }),
  );
  const bedVol = reg(knob({ label: "音量", get: () => song.params.bedVolume, set: (v) => {
    song.params.bedVolume = v;
    changed();
  } }));
  const bedPump = reg(knob({ label: "サイドチェイン", get: () => song.params.pump, set: (v) => {
    song.params.pump = v;
    changed();
  }, hint: () => "このキックに合わせて、刻んだ音とパッドを沈ませる" }));
  bedGroup.append(bedDrum.el, bedVol.el, bedPump.el);
  const padGroup = el("div", "ins-group");
  const padAmount = reg(knob({ label: "量", get: () => song.params.pad, set: (v) => {
    song.params.pad = v;
    changed();
  }, hint: () => "元の曲の和音を引き伸ばして、うしろでうっすら鳴らす" }));
  padGroup.append(padAmount.el);
  const fxSummary = el("div", "ins-fx");
  const fxList = el("div", "ins-fx-list");
  const envList = el("div", "ins-env-list");
  const fxOpen = button("FXチェーンを開く", () => sel.type === "track" && openTrackFx(sel.key), "preset-button");
  fxSummary.append(fxList, envList, fxOpen);
  trackPanel.append(trackTitle, laneGroup, bedGroup, padGroup, section("trackFx", "FX", fxSummary));

  function renderFxSummary(key: string): void {
    const fx = trackFx(key);
    fxList.innerHTML = "";
    if (fx.chain.length === 0) fxList.appendChild(el("div", "ins-meta", "プラグインなし"));
    fx.chain.forEach((p, i) => fxList.appendChild(el("div", "ins-fx-item" + (p.bypass ? " bypassed" : ""), `${i + 1}. ${FX_LABELS[p.kind]}${p.bypass ? "（バイパス）" : ""}`)));
    envList.innerHTML = "";
    for (const e of fx.envelopes) {
      const p = fx.chain.find((x) => x.id === e.pluginId);
      if (!p) continue;
      const row = el("div", "preset-row ins-env");
      row.append(
        el("span", "ins-meta", `エンベロープ：${FX_SHORT[p.kind]} ${ENV_PARAM_LABELS[e.param]}`),
        button(e.visible ? "隠す" : "表示", () => editEnvelope(e.id, (x) => ({ ...x, visible: !x.visible })), "preset-button"),
      );
      envList.appendChild(row);
    }
  }

  // --- 断片 ---
  const hitTitle = el("div", "ins-title");
  const hitMeta = el("div", "ins-meta");
  const takeList = el("div", "ins-fx-list");
  const takeOpen = button("テイクFXを開く", () => sel.type === "hit" && fxWindow.open({ type: "take", track: sel.track, step: sel.step }), "preset-button", "この断片だけに掛けるFXチェーン");
  const takeClear = button("テイクFXを消す", () => {
    if (sel.type !== "hit") return;
    setTakeFx(sel.track, sel.step, emptyTrack());
    changed();
  }, "preset-button");
  const takeButtons = el("div", "preset-row");
  takeButtons.append(takeOpen, takeClear);
  const hitGroupRow = el("div", "preset-row ins-group-row");
  hitPanel.append(
    hitTitle,
    hitMeta,
    hitGroupRow,
    section("take", "テイクFX（この断片だけ）", note("トラックのFXより先に掛かる。位置で覚えるので、刻み直してこの位置に断片が無くなると掛からない"), takeList, takeButtons),
  );

  // --- 断片をいくつか選んだとき ---
  const hitsTitle = el("div", "ins-title");
  const hitsMeta = el("div", "ins-meta");
  const hitsButtons = el("div", "preset-row");
  hitsPanel.append(
    hitsTitle,
    hitsMeta,
    hitsButtons,
    note("線の上をドラッグして四角で囲む／シフト（Ctrl）を押しながらタップで、断片を足したり外したりできる。タッチなら右上の「複数選択」をオンに"),
  );

  // --- グループ ---
  const groupNameInput = el("input", "mix-name");
  groupNameInput.type = "text";
  groupNameInput.addEventListener("input", () => {
    if (sel.type !== "group") return;
    const id = sel.id;
    song.groups = song.groups?.map((g) => (g.id === id ? { ...g, name: groupNameInput.value } : g));
    touch();
  });
  const groupNameRow = el("label", "ins-row ins-choice");
  groupNameRow.append(el("span", "ins-label", "名前"), groupNameInput);
  const groupMeta = el("div", "ins-meta");
  const selGroup = (): HitGroup | undefined => (sel.type === "group" ? groupById(sel.id) : undefined);
  const editGroup = (fn: (g: HitGroup) => HitGroup): void => {
    if (sel.type === "group") updateGroup(sel.id, fn);
  };
  const groupMute = button("ミュート", () => editGroup((g) => ({ ...g, muted: !g.muted })), "preset-button", "このグループの断片を鳴らさない");
  const groupReverse = button("逆再生", () => editGroup((g) => ({ ...g, reverse: !g.reverse })), "preset-button", "このグループの断片を逆から鳴らす");
  const groupReselect = button("メンバーを選び直す", () => {
    const g = selGroup();
    if (!g) return;
    regrouping = g.id;
    sel = { type: "hits", hits: g.members.map(toHit) };
    refresh();
  }, "preset-button", "いまのメンバーを選んだ状態にする。足したり外したりして「このグループにする」");
  const groupDelete = button("グループを解く", () => {
    if (sel.type !== "group") return;
    const id = sel.id;
    song.groups = song.groups?.filter((g) => g.id !== id);
    if (song.groups?.length === 0) delete song.groups;
    sel = { type: "song" };
    changed();
  }, "preset-button", "グループをやめる（断片は刻んだときのままに戻る）");
  const groupButtons = el("div", "preset-row");
  groupButtons.append(groupMute, groupReverse);
  const groupPitch = reg(
    knob({
      label: "音程",
      min: -12,
      max: 12,
      step: 1,
      get: () => selGroup()?.pitch ?? 0,
      set: (v) => editGroup((g) => ({ ...g, pitch: Math.round(v) })),
      format: (v) => (Math.round(v) === 0 ? "そのまま" : `${v > 0 ? "+" : ""}${Math.round(v)}半音`),
      hint: () => "サンプラーと同じく、速さごと変わる（高いほど短く）",
    }),
  );
  const groupPan = reg(
    knob({
      label: "パン",
      min: -1,
      max: 1,
      step: 0.05,
      get: () => selGroup()?.pan ?? 0,
      set: (v) => editGroup((g) => ({ ...g, pan: v })),
      format: (v) => (selGroup()?.pan === null ? "そのまま" : Math.abs(v) < 0.025 ? "中央" : `${v < 0 ? "左" : "右"}${Math.round(Math.abs(v) * 100)}`),
    }),
  );
  const groupGate = reg(
    knob({
      label: "音の長さ",
      min: 0.05,
      max: 1,
      step: 0.05,
      get: () => selGroup()?.gate ?? 1,
      set: (v) => editGroup((g) => ({ ...g, gate: v })),
      format: (v) => (selGroup()?.gate === null ? "そのまま" : `${Math.round(v * 100)}%`),
      hint: () => "次に打つ所までの何割を鳴らすか（短いほどブツ切れ）",
    }),
  );
  const groupVel = reg(
    knob({
      label: "強さ",
      max: 1.5,
      get: () => selGroup()?.vel ?? 1,
      set: (v) => editGroup((g) => ({ ...g, vel: v })),
    }),
  );
  const groupResetShape = button("刻んだときのままに戻す", () => editGroup((g) => ({ ...g, pitch: 0, pan: null, gate: null, vel: 1, reverse: false })), "preset-button");
  const groupFxList = el("div", "ins-fx-list");
  const groupFxOpen = button("グループのFXを開く", () => sel.type === "group" && fxWindow.open({ type: "group", id: sel.id }), "preset-button");
  groupPanel.append(
    groupNameRow,
    groupMeta,
    groupButtons,
    section("groupShape", "刻み方（このグループだけ）", groupPitch.el, groupPan.el, groupGate.el, groupVel.el, groupResetShape),
    section("groupFx", "グループのFX", note("このグループの断片にだけ掛かる（テイクFXのあと、トラックのFXの前）"), groupFxList, groupFxOpen),
    el("div", "preset-row", undefined),
  );
  const groupFoot = groupPanel.lastElementChild as HTMLElement;
  groupFoot.append(groupReselect, groupDelete);

  // ------------------------------------------------------------------ 全体の並び

  const stageHead = el("div", "mix-stage-head");
  stageHead.append(transport, arrange, notice);
  const stagePane = el("div", "mix-stage-pane");
  stagePane.append(stageHead);
  const split = el("div", "mix-split");
  split.append(stagePane, inspector);
  const root = el("div", "tab-panel mix-tab");
  root.append(split, fxWindow.el);

  // ------------------------------------------------------------------ 動作

  function touch(): void {
    song.updatedAt = Date.now();
    deps.onSongChange(song);
  }

  /** トラック（刻む曲）を変える。音に関わる変更なら作り直す。 */
  function updateLane(key: string, fn: (lane: Lane) => Lane, rebuildAfter = true): void {
    if (!song.lanes) return;
    const i = song.lanes.findIndex((l) => laneKey(l) === key);
    if (i < 0) return;
    song.lanes[i] = fn(song.lanes[i]);
    changed(rebuildAfter);
  }

  /** フレーズを書き出す（同じ曲・同じテンポなら、書き出したものを使い回す）。 */
  function render(phrase: Phrase, bpm: number, opts: RenderOpts): Promise<Pcm> {
    const key = `${phrase.id}|${phrase.updatedAt}|${bpm}|${opts.dry ? "dry" : "wet"}|${opts.drumsOnly ? `drums|${opts.swing ?? 0}` : "all"}`;
    let hit = renderCache.get(key);
    if (!hit) {
      hit = deps.render(phrase, bpm, opts);
      renderCache.set(key, hit);
      if (renderCache.size > 24) renderCache.delete(renderCache.keys().next().value as string);
    }
    return hit;
  }

  function scheduleRebuild(): void {
    if (!song.lanes) return;
    if (rebuildTimer !== null) window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(() => {
      rebuildTimer = null;
      void rebuild();
    }, 120);
  }

  function setNotice(text: string): void {
    notice.textContent = text;
    notice.hidden = text === "";
  }

  /** 種と設定から、曲を作り直す。鳴らしていれば、同じ位置から鳴らし直す。 */
  async function rebuild(): Promise<void> {
    const token = ++buildToken;
    if (!song.lanes || song.lanes.length === 0) {
      result = null;
      refresh();
      return;
    }
    busy = "作っています…";
    refresh();
    try {
      const out = await buildCollage(song, deps.getPhrases(), render, sampleRate, deps.reverb);
      if (token !== buildToken) return;
      result = out;
      builtStamps = stampsOf(song.lanes ?? []);
      setNotice(out ? "" : "刻むフレーズが見つからない。右の「素材」で選び直して");
      if (player.playing) {
        if (out) player.play(out.pcm, sampleRate, player.progress() ?? 0);
        else player.stop();
      }
    } catch (err) {
      if (token !== buildToken) return;
      console.error("曲の書き出しに失敗しました", err);
      result = null;
      setNotice("曲を作れなかった。もう一度「刻む」を押して");
    }
    busy = "";
    refresh();
  }

  async function chop(part: RerollPart): Promise<void> {
    const sources = collectSources(song, deps.getPhrases());
    if (sources.length === 0) {
      setNotice(song.materialIds.length === 0 ? "先に、右の「素材」で刻むフレーズを選んで" : "選んだフレーズに、音符がない");
      sel = { type: "song" };
      refresh();
      return;
    }
    if (song.lanes) {
      undoStack.push(seedSnapshot(song.lanes));
      if (undoStack.length > 50) undoStack.shift();
      redoStack.length = 0;
    }
    const first = !song.lanes;
    const lanes = syncLanes(song, randomSeed);
    song.lanes = first ? lanes : rerollLanes(lanes, part, randomSeed);
    if (first && !bpmTouched) {
      // 最初に刻むときだけ、いちばん上のトラックの曲のテンポから始める（このあとは曲のBPMだけで決まる）
      const top = sources.find((p) => p.id === song.lanes![0].phraseId) ?? sources[0];
      song.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(top.bpm)));
    }
    // ドラムループをまだ決めていなければ、ドラムのある最初の素材にする（あとで選び直せる）
    if (song.drumId === undefined) song.drumId = pickDrum(song, deps.getPhrases());
    setNotice("");
    touch();
    refresh();
    await rebuild();
  }

  function undo(): void {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(seedSnapshot(song.lanes ?? []));
    song.lanes = applySeeds(song.lanes ?? [], prev);
    touch();
    void rebuild();
  }

  function redo(): void {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(seedSnapshot(song.lanes ?? []));
    song.lanes = applySeeds(song.lanes ?? [], next);
    touch();
    void rebuild();
  }

  async function togglePlay(): Promise<void> {
    if (player.playing) {
      player.stop();
      refresh();
      return;
    }
    if (!result) return;
    await deps.prepareAudio();
    player.play(result.pcm, sampleRate);
    refresh();
  }

  function saveWav(): void {
    if (!result) return;
    const bytes = encodeWav(repeatPcm(result.pcm, Number(loopSelect.value)), sampleRate);
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${song.name.trim() || "orinasu"}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /** 線の表示の行：トラック（刻む曲・ドラムループ・パッド・マスター）と、その下の表示中のエンベロープ。 */
  function trackRows(res: CollageResult | null): Row[] {
    const rows: Row[] = [];
    const envRows = (key: string): void => {
      const fx = trackFx(key);
      for (const e of fx.envelopes) {
        if (!e.visible) continue;
        const p = fx.chain.find((x) => x.id === e.pluginId);
        if (!p) continue;
        rows.push({ type: "env", key: e.id, label: `${FX_SHORT[p.kind]} ${ENV_PARAM_LABELS[e.param]}`, points: e.points, active: e.active && !p.bypass });
      }
    };
    const base = { locked: false, muted: false, custom: false, selected: false, fx: false };
    for (const l of res?.lanes ?? []) {
      const lane = song.lanes?.find((x) => x.phraseId === l.phraseId);
      const key = laneKey(l);
      rows.push({
        ...base,
        type: "track",
        key,
        kind: "lane",
        name: l.name,
        locked: !!lane?.locked,
        muted: !!lane?.muted,
        custom: !!lane && laneIsCustom(lane),
        selected: (sel.type === "track" && sel.key === key) || (sel.type === "hit" && sel.track === key),
        events: l.events,
        takeSteps: lane?.takes?.map((t) => t.step),
      });
      envRows(key);
    }
    if (res?.bed) {
      rows.push({ ...base, type: "track", key: "bed", kind: "bed", name: res.bed.name, events: res.bed.events, selected: sel.type === "track" && sel.key === "bed" });
      envRows("bed");
    }
    if (res && song.params.pad > 0) {
      rows.push({ ...base, type: "track", key: "pad", kind: "pad", name: "パッド", events: [], selected: sel.type === "track" && sel.key === "pad" });
      envRows("pad");
    }
    if (res) {
      rows.push({ ...base, type: "track", key: "master", kind: "master", name: "マスター", events: [], selected: sel.type === "track" && sel.key === "master" });
      envRows("master");
    }
    return rows;
  }

  /** 画面を、いまの状態に合わせる。 */
  function refresh(): void {
    // 選んでいるものが無くなっていたら、曲に戻す
    if (sel.type === "track" && !allTrackKeys().includes(sel.key)) sel = { type: "song" };
    if (sel.type === "hit") {
      const { track, step } = sel;
      if (!result?.lanes.some((l) => laneKey(l) === track && l.events.some((e) => e.step === step))) sel = { type: "song" };
    }
    if (sel.type === "group" && !groupById(sel.id)) sel = { type: "song" };
    if (sel.type !== "hits") regrouping = null;

    // トランスポート
    playButton.textContent = player.playing ? "■ 停止" : "▶ 再生";
    playButton.classList.toggle("on", player.playing);
    playButton.disabled = !result;
    if (document.activeElement !== bpmInput) bpmInput.value = String(song.bpm);
    for (const o of Array.from(lengthSelect.options)) {
      const n = Number(o.value);
      o.textContent = `${n}小節（${formatDuration(songSeconds({ ...song, lengthBars: n }))}）`;
    }
    lengthSelect.value = String(song.lengthBars);
    chopMore.disabled = !song.lanes;
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
    exportButton.disabled = !result;
    statusText.textContent = busy || (result ? [result.keyName ? `キー ${result.keyName}` : null, `${result.lanes.length}トラック`].filter(Boolean).join("・") : "");
    updateTime();

    // アレンジ画面
    const rows = trackRows(result);
    const groupMarks = (song.groups ?? []).flatMap((g) => g.members.map((m) => ({ ...toHit(m), hue: g.hue, muted: g.muted })));
    laneView.setData(
      result ? { rows, totalSteps: result.totalSteps, stepsPerBar: song.beatsPerBar * STEPS_PER_BEAT, selectedHits: selectedHits(), groupMarks } : null,
    );
    arrangeBody.classList.toggle("empty", !result);
    headerCol.hidden = !result;
    if (result) renderHeaders(rows);

    // インスペクタ
    inspector.classList.toggle("show-hints", showHints);
    hintToggle.classList.toggle("on", showHints);
    songPanel.hidden = sel.type !== "song";
    trackPanel.hidden = sel.type !== "track";
    hitPanel.hidden = sel.type !== "hit";
    hitsPanel.hidden = sel.type !== "hits";
    groupPanel.hidden = sel.type !== "group";
    multiToggle.classList.toggle("on", multiMode);
    multiToggle.hidden = !result;
    crumbs.innerHTML = "";
    const crumb = (label: string, onClick?: () => void): void => {
      if (crumbs.childElementCount > 0) crumbs.appendChild(el("span", "ins-crumb-sep", "›"));
      crumbs.appendChild(onClick ? button(label, onClick, "ins-crumb") : el("span", "ins-crumb current", label));
    };
    crumb("曲", sel.type === "song" ? undefined : () => {
      sel = { type: "song" };
      refresh();
    });
    if (sel.type === "track") crumb(trackName(sel.key));
    if (sel.type === "hit") {
      const track = sel.track;
      crumb(trackName(track), () => {
        sel = { type: "track", key: track };
        refresh();
      });
      crumb(`断片 ${posName(sel.step)}`);
    }
    if (sel.type === "hits") crumb(`断片 ${sel.hits.length}個`);
    if (sel.type === "group") crumb(groupById(sel.id)?.name ?? "グループ");

    const music = song.params.style === "music";
    const playingLanes = (song.lanes ?? []).filter((l) => !l.muted).length;
    if (sel.type === "song") {
      show(turnsChoice, music && song.materialIds.length > 1);
      show(cutChoice, !music);
      for (const s of songShape) show(s.c, s.mode === "both" || (s.mode === "music") === music);
      const drum = drumNow();
      show(bedKnob, !!drum);
      if (document.activeElement !== nameInput) nameInput.value = song.name;
      keyInfo.textContent = result?.keyName ? `キー：${result.keyName}（いちばん上のトラックの調。ほかのトラックはこれに寄せる）` : "キー：まだ刻んでいない";
      groupList.innerHTML = "";
      if (!song.groups?.length) groupList.appendChild(el("div", "ins-meta", "まだグループがない"));
      for (const g of song.groups ?? []) {
        const b = button("", () => {
          sel = { type: "group", id: g.id };
          refresh();
        }, "ins-group-item");
        const dot = el("span", "ins-dot");
        dot.style.background = `hsl(${g.hue} 85% 60%)`;
        b.append(dot, el("span", undefined, `${g.name}（${g.members.length}個${g.muted ? "・ミュート" : ""}）`));
        groupList.appendChild(b);
      }
    } else if (sel.type === "track") {
      const key = sel.key;
      const lane = laneOfKey(key);
      trackTitle.textContent = trackName(key);
      laneGroup.hidden = !lane;
      bedGroup.hidden = key !== "bed";
      padGroup.hidden = key !== "pad";
      if (lane) {
        lockButton.textContent = lane.locked ? "固定中" : "固定";
        lockButton.classList.toggle("on", !!lane.locked);
        muteButton.textContent = lane.muted ? "ミュート中" : "ミュート";
        muteButton.classList.toggle("on", !!lane.muted);
        resetButton.disabled = !laneIsCustom(lane);
        show(laneCut, !music);
        const mixing = music && song.params.turns === "mix" && playingLanes > 1;
        shiftNote.textContent = mixing
          ? "いまは「混ぜる」なので、刻み方は全体のつまみで決まる（ここのずらしは効かない）"
          : "全体のつまみからの差として持つ。全体を動かすと、差を保ったまま一緒に動く";
        shiftNote.classList.toggle("ins-warn", mixing);
        for (const s of laneShape) show(s.c, s.mode === "both" || (s.mode === "music") === music);
      }
      renderFxSummary(key);
    } else if (sel.type === "hits") {
      const hits = sel.hits;
      hitsTitle.textContent = `${hits.length}個の断片を選んでいる`;
      const byTrack = new Map<string, number>();
      for (const h of hits) byTrack.set(h.track, (byTrack.get(h.track) ?? 0) + 1);
      hitsMeta.textContent = [...byTrack].map(([t, n]) => `${trackName(t)} ${n}個`).join("・");
      hitsButtons.innerHTML = "";
      const regroup = regrouping ? groupById(regrouping) : undefined;
      if (regroup) {
        hitsButtons.append(
          button(`「${regroup.name}」をこの選択にする`, () => {
            song.groups = assignToGroup(song.groups ?? [], regroup, hits.map(toRef));
            regrouping = null;
            sel = { type: "group", id: regroup.id };
            changed();
          }, "preset-button on"),
        );
      } else {
        hitsButtons.append(button("グループにする", () => makeGroup(hits), "preset-button on", "選んだ断片を1つのまとまりにする（まとめて刻み方・ミュート・FXを変えられる）"));
      }
      hitsButtons.append(
        button("選ぶのをやめる", () => {
          regrouping = null;
          sel = { type: "song" };
          refresh();
        }),
      );
    } else if (sel.type === "group") {
      const g = groupById(sel.id)!;
      if (document.activeElement !== groupNameInput) groupNameInput.value = g.name;
      const tracks = new Set(g.members.map((m) => m.phraseId));
      const alive = g.members.filter((m) => result?.lanes.some((l) => l.phraseId === m.phraseId && l.events.some((e) => e.step === m.step))).length;
      groupMeta.textContent = `${g.members.length}個の断片（${tracks.size}トラック）${alive < g.members.length ? `・うち${g.members.length - alive}個は、刻み直してその位置に断片が無い` : ""}`;
      groupMute.textContent = g.muted ? "ミュート中" : "ミュート";
      groupMute.classList.toggle("on", g.muted);
      groupReverse.textContent = g.reverse ? "逆再生中" : "逆再生";
      groupReverse.classList.toggle("on", g.reverse);
      groupResetShape.disabled = g.pitch === 0 && g.pan === null && g.gate === null && g.vel === 1 && !g.reverse;
      groupFxList.innerHTML = "";
      if (g.fx.length === 0) groupFxList.appendChild(el("div", "ins-meta", "プラグインなし"));
      g.fx.forEach((p, i) => groupFxList.appendChild(el("div", "ins-fx-item" + (p.bypass ? " bypassed" : ""), `${i + 1}. ${FX_LABELS[p.kind]}`)));
    } else {
      const { track, step } = sel;
      const ev = result?.lanes.find((l) => laneKey(l) === track)?.events.find((e) => e.step === step);
      const g = groupOf(song.groups, toRef({ track, step }));
      hitGroupRow.innerHTML = "";
      if (g) {
        hitGroupRow.append(
          el("span", "ins-meta", `グループ：${g.name}`),
          button("グループを開く", () => {
            sel = { type: "group", id: g.id };
            refresh();
          }),
        );
      } else {
        hitGroupRow.append(button("グループにする", () => makeGroup([{ track, step }]), "preset-button", "この断片だけのグループを作る（あとでメンバーを足せる）"));
      }
      hitTitle.textContent = `断片：${trackName(track)}`;
      hitMeta.textContent = ev
        ? `位置 ${posName(step)}・長さ ${ev.len}／16・${ev.pitch === 0 ? "元の高さ" : `${ev.pitch > 0 ? "+" : ""}${ev.pitch}半音`}・断片 #${ev.slice + 1}`
        : "";
      const take = takeOf(track, step);
      takeList.innerHTML = "";
      if (take.chain.length === 0) takeList.appendChild(el("div", "ins-meta", "テイクFXなし"));
      take.chain.forEach((p, i) => takeList.appendChild(el("div", "ins-fx-item" + (p.bypass ? " bypassed" : ""), `${i + 1}. ${FX_LABELS[p.kind]}`)));
      takeClear.disabled = take.chain.length === 0;
    }
    for (const c of controls) if (!c.el.hidden) c.refresh();
    fxWindow.refresh();
  }

  function updateTime(): void {
    const total = songSeconds(song);
    const t = player.progress();
    const steps = totalStepsNow();
    const step = t === null ? 0 : Math.min(steps - 1, Math.floor(t * steps));
    posMain.textContent = posName(step);
    posTime.textContent = `${formatDuration(t === null ? 0 : t * total)} / ${formatDuration(total)}`;
  }

  setNotice("");
  refresh();

  return {
    el: root,
    setSong(next) {
      player.stop();
      song = next;
      buildToken++;
      result = null;
      undoStack.length = 0;
      redoStack.length = 0;
      bpmTouched = !!next.lanes;
      removedLanes.clear();
      sel = { type: "song" };
      setNotice("");
      renderMaterials();
      refresh();
      if (song.lanes) void rebuild();
    },
    refreshMaterials() {
      // 消えたフレーズは素材から外す
      const alive = new Set(deps.getPhrases().map((p) => p.id));
      song.materialIds = song.materialIds.filter((id) => alive.has(id));
      if (song.lanes) {
        song.lanes = song.lanes.filter((l) => alive.has(l.phraseId));
        if (song.lanes.length === 0) delete song.lanes; // 刻む前と同じ状態に（読み込み直したときと同じふるまい）
      }
      // ドラムループの曲が消えたら、「なし」ではなく「自動」（ドラムのある最初の素材）に戻す
      if (song.drumId && !alive.has(song.drumId)) delete song.drumId;
      // 消えたフレーズの断片はグループから外し、空になったグループは消す
      if (song.groups) {
        song.groups = song.groups
          .map((g) => ({ ...g, members: g.members.filter((m) => alive.has(m.phraseId)) }))
          .filter((g) => g.members.length > 0);
        if (song.groups.length === 0) delete song.groups;
      }
      renderMaterials();
      refresh();
      if (song.lanes && !result) void rebuild(); // 起動直後は、フレーズが読み込まれてから曲を作り直す
      else if (song.lanes && stampsOf(song.lanes) !== builtStamps) scheduleRebuild(); // フレーズタブで曲を直したら、作り直す
    },
    stop() {
      if (!player.playing) return;
      player.stop();
      refresh();
    },
    tick() {
      laneView.setProgress(player.progress());
      if (player.playing) updateTime();
    },
    togglePlay() {
      void togglePlay();
    },
  };
}
