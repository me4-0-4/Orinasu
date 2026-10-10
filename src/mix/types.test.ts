import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SONG_ID,
  createEmptySong,
  formatDuration,
  isSavedSongId,
  laneIsCustom,
  migrateSong,
  openedSong,
  sameSongContent,
  snapshotSong,
  songSeconds,
  type Lane,
} from "./types.ts";

test("曲の長さ：小節数・拍子・曲のBPMから決まる（フレーズのBPMは関係ない）", () => {
  const s = { ...createEmptySong(), lengthBars: 4 }; // 4小節・4拍・120BPM
  assert.equal(songSeconds(s), 8);
  assert.equal(songSeconds({ ...s, bpm: 60 }), 16);
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(8), "0:08");
});

test("古い形の曲からは、名前・選んだ曲・BPM・長さだけ引き継ぐ", () => {
  const old = {
    name: "むかしの曲",
    materialIds: ["a", "b"],
    sections: [{ id: "s1", layers: [] }],
    plan: [{ kind: "play", from: "a", dst: 0, len: 4, src: 0 }],
    baseId: "a",
    bpm: 100,
    lengthBars: 16,
    energy: [{ t: 0, v: 0.2 }],
    updatedAt: 5,
  };
  const s = migrateSong(old);
  assert.equal(s.name, "むかしの曲");
  assert.deepEqual(s.materialIds, ["a", "b"]);
  assert.equal(s.bpm, 100);
  assert.equal(s.lengthBars, 16);
  assert.equal(s.lanes, undefined);
  assert.equal("sections" in s || "plan" in s, false);
  assert.equal(s.params.busy, 0.5);
});

test("いまの形はそのまま読める。壊れた値は初期値に戻す", () => {
  const lanes = [{ phraseId: "a", cutSeed: 1, rhythmSeed: 2, orderSeed: 3, locked: true }, { phraseId: 5 }];
  const s = migrateSong({ ...createEmptySong(), lanes, params: { busy: 2, breaks: 0.3, mode: "divide", size: "x" } });
  assert.deepEqual(s.lanes, [lanes[0]]);
  assert.equal(s.params.busy, 1);
  assert.equal(s.params.breaks, 0.3);
  assert.equal(s.params.mode, "divide");
  assert.equal(s.params.size, 0.5);
  assert.equal(migrateSong(null).bpm, 120);
  assert.equal(migrateSong({ bpm: 9999, lengthBars: 7 }).lengthBars, 16);
});

test("ずらし：層に効く値＝全体＋ずらし（0〜1に収める）。切り方は層の指定があればそれ", async () => {
  const { effectiveParams, setLaneShape, laneIsCustom } = await import("./types.ts");
  const global = { ...createEmptySong().params, busy: 0.5, motion: 0.9 };
  let lane: Lane = { phraseId: "a", cutSeed: 1, rhythmSeed: 2, orderSeed: 3 };
  assert.equal(laneIsCustom(lane), false);
  lane = setLaneShape(lane, global, "busy", 0.7);
  assert.ok(Math.abs((lane.shift?.busy ?? 0) - 0.2) < 1e-9);
  assert.ok(Math.abs(effectiveParams(global, lane).busy - 0.7) < 1e-9);
  // 全体を動かすと、差を保って一緒に動く
  assert.ok(Math.abs(effectiveParams({ ...global, busy: 0.3 }, lane).busy - 0.5) < 1e-9);
  // 上限で止まる
  lane = setLaneShape(lane, global, "motion", 1);
  assert.equal(effectiveParams({ ...global, motion: 1 }, lane).motion, 1);
  assert.equal(laneIsCustom(lane), true);
  // 全体と同じ値に戻すと、ずらしは消える
  lane = setLaneShape(lane, global, "busy", 0.5);
  lane = setLaneShape(lane, global, "motion", 0.9);
  assert.equal(lane.shift, undefined);
  assert.equal(effectiveParams(global, { mode: "divide" }).mode, "divide");
  assert.equal(laneIsCustom({ ...lane, muted: true }), true);
});

test("保存データの層：ずらし・切り方・音量・ミュートを読む。おかしな値は捨てる", () => {
  const s = migrateSong({
    lanes: [
      { phraseId: "a", cutSeed: 1, rhythmSeed: 2, orderSeed: 3, shift: { busy: 0.3, motion: 5, nope: 1 }, mode: "divide", volume: 9, muted: true },
      { phraseId: "b", cutSeed: 1, rhythmSeed: 2, orderSeed: 3, mode: "weird", shift: "x" },
    ],
  });
  assert.deepEqual(s.lanes![0], { phraseId: "a", cutSeed: 1, rhythmSeed: 2, orderSeed: 3, muted: true, mode: "divide", volume: 1.5, shift: { busy: 0.3, motion: 1 } });
  assert.deepEqual(s.lanes![1], { phraseId: "b", cutSeed: 1, rhythmSeed: 2, orderSeed: 3 });
});

test("音の長さ・余韻の設定を読む。古いデータには無いので初期値（音の長さ60%・余韻なし）", () => {
  const old = migrateSong({ params: { busy: 0.4 } });
  assert.equal(old.params.hold, 0.6);
  assert.equal(old.params.dry, true);
  const s = migrateSong({ params: { hold: 0.2, dry: false }, lanes: [{ phraseId: "a", cutSeed: 1, rhythmSeed: 2, orderSeed: 3, shift: { hold: -0.3 } }] });
  assert.equal(s.params.hold, 0.2);
  assert.equal(s.params.dry, false);
  assert.deepEqual(s.lanes![0].shift, { hold: -0.3 });
});

test("刻み方のモード：初期は音楽モード。保存データから読める", () => {
  assert.equal(createEmptySong().params.style, "music");
  assert.equal(migrateSong({ params: { style: "material" } }).params.style, "material");
  assert.equal(migrateSong({ params: { style: "???" } }).params.style, "music");
});

test("エフェクト：マスターの初期はリバーブ15%。前の「仕上げの響き」はマスターのリバーブに。層のFX・テイクFXも読める", () => {
  const s0 = createEmptySong();
  assert.deepEqual(s0.fx.master.chain.map((x) => [x.kind, x.amount]), [["reverb", 0.15]]);
  assert.deepEqual(s0.fx.bed.chain, []);
  assert.equal(migrateSong({ params: { reverb: 0.4 } }).fx.master.chain[0].amount, 0.4);
  assert.deepEqual(migrateSong({ params: { reverb: 0 } }).fx.master.chain, []);
  const s1 = migrateSong({
    fx: { master: { chain: [{ id: "d", kind: "delay", amount: 0.5, time: "1/4" }], envelopes: [] }, bed: { lowCut: 0.5 } },
    lanes: [
      {
        phraseId: "a",
        cutSeed: 1,
        rhythmSeed: 2,
        orderSeed: 3,
        fx: { chain: [{ kind: "drive", amount: 0.3 }], envelopes: [] },
        takes: [{ step: 4, chain: [{ kind: "crush" }] }],
      },
      { phraseId: "b", cutSeed: 1, rhythmSeed: 2, orderSeed: 3, fx: [{ kind: "delay", when: "hits", steps: [2] }] },
    ],
  });
  assert.equal(s1.fx.master.chain[0].time, "1/4");
  assert.equal(s1.fx.bed.chain[0].kind, "lowCut");
  assert.equal(s1.lanes![0].fx!.chain[0].amount, 0.3);
  assert.equal(s1.lanes![0].takes![0].step, 4);
  assert.ok(laneIsCustom(s1.lanes![0]));
  assert.equal(s1.lanes![1].fx, undefined); // 選んだ断片だけのものは、テイクFXへ
  assert.equal(s1.lanes![1].takes![0].chain[0].kind, "delay");
});

test("曲の長さ：初期は16小節。8〜64小節はテンポに関係なく選べる（短くても伸ばさない）", () => {
  assert.equal(createEmptySong().lengthBars, 16);
  assert.equal(migrateSong({ bpm: 200, lengthBars: 8 }).lengthBars, 8);
  assert.equal(migrateSong({ bpm: 200, lengthBars: 7 }).lengthBars, 16);
});

test("下地・スウィング・層の組み方を引き継ぐ。決めていない下地は undefined のまま", () => {
  const s = migrateSong({ drumId: "a", params: { swing: 0.4, turns: "swap", bedVolume: 2 } });
  assert.equal(s.drumId, "a");
  assert.equal(s.params.swing, 0.4);
  assert.equal(s.params.turns, "swap");
  assert.equal(s.params.bedVolume, 1);
  assert.equal(migrateSong({ drumId: null }).drumId, null);
  assert.equal(migrateSong({}).drumId, undefined);
  assert.equal(migrateSong({}).params.turns, "mix");
});

test("層の組み方：初期は「混ぜる」。古い掛け合い・交代もそのまま", () => {
  assert.equal(createEmptySong().params.turns, "mix");
  assert.equal(migrateSong({ params: { turns: "call" } }).params.turns, "call");
  assert.equal(migrateSong({ params: { turns: "mix" } }).params.turns, "mix");
});

test("保存した曲：写しは作業中の曲と中身が同じで、idと更新時刻だけ違う", () => {
  const song = createEmptySong();
  song.name = "テスト";
  song.lanes = [{ phraseId: "p1", cutSeed: 1, rhythmSeed: 2, orderSeed: 3 }];
  song.savedId = "saved_x_1";
  const saved = snapshotSong(song, "saved_a_1", 123);
  assert.equal(saved.id, "saved_a_1");
  assert.equal(saved.updatedAt, 123);
  assert.equal(saved.savedId, undefined);
  assert.ok(isSavedSongId(saved.id));
  assert.ok(sameSongContent(saved, song));
  // 写しを直しても、元は変わらない
  saved.lanes![0].cutSeed = 99;
  assert.equal(song.lanes[0].cutSeed, 1);
  assert.ok(!sameSongContent(saved, song));
  // 開くと、作業中のid・どの保存した曲かが付く
  const opened = openedSong(saved);
  assert.equal(opened.id, SONG_ID);
  assert.equal(opened.savedId, "saved_a_1");
  assert.ok(sameSongContent(opened, saved));
  // 読み込みで savedId は残るが、保存した曲のid以外は捨てる
  assert.equal(migrateSong(opened).savedId, "saved_a_1");
  assert.equal(migrateSong({ ...opened, savedId: "song" }).savedId, undefined);
});

test("保存データ：ドラムループのミュートを読む。ソロは保存しない", () => {
  const song = migrateSong({ ...createEmptySong(), bedMuted: true });
  assert.equal(song.bedMuted, true);
  assert.equal(migrateSong({ ...createEmptySong(), bedMuted: "x" }).bedMuted, undefined);
  assert.equal(migrateSong(createEmptySong()).bedMuted, undefined);
  const lanes = [{ phraseId: "a", cutSeed: 1, rhythmSeed: 2, orderSeed: 3, solo: true }];
  assert.ok(!("solo" in migrateSong({ ...createEmptySong(), lanes }).lanes![0]));
});
