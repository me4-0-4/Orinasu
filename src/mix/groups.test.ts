import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGroups, assignToGroup, groupOf, newGroup, sanitizeGroups } from "./groups.ts";
import { newPlugin } from "./fx.ts";

const ev = (step: number, pitch = 0) => ({ step, len: 2, slice: step, pitch });

test("グループ：メンバーの断片だけ、音程・パン・長さ・強さ・逆再生が変わる。ミュートは鳴らさないが表示には残す", () => {
  const g = { ...newGroup([{ phraseId: "a", step: 4 }, { phraseId: "b", step: 8 }], []), pitch: 3, pan: -1, gate: 0.4, vel: 0.5, reverse: true };
  const { play } = applyGroups("a", [ev(0), ev(4, 12)], [g]);
  assert.deepEqual(play[0], ev(0));
  assert.equal(play[1].pitch, 15);
  assert.equal(play[1].pan, -1);
  assert.equal(play[1].gate, 0.4);
  assert.equal(play[1].vel, 0.5);
  assert.equal(play[1].fx?.kind, "reverse");
  const muted = applyGroups("a", [ev(0), ev(4)], [{ ...g, muted: true }]);
  assert.deepEqual(muted.play.map((e) => e.step), [0]);
  assert.deepEqual(muted.view.map((e) => e.step), [0, 4]);
  // 別のトラックの同じ位置には効かない
  assert.equal(applyGroups("b", [ev(4)], [g]).play[0].pitch, 0);
});

test("断片は1つのグループにだけ入る。空になったグループは消える", () => {
  const g1 = newGroup([{ phraseId: "a", step: 0 }, { phraseId: "a", step: 4 }], []);
  const g2 = newGroup([{ phraseId: "a", step: 4 }], [g1]);
  let groups = assignToGroup([g1], g2, g2.members);
  assert.deepEqual(groups.map((g) => g.members.length), [1, 1]);
  assert.equal(groupOf(groups, { phraseId: "a", step: 4 })?.id, g2.id);
  groups = assignToGroup(groups, g2, [{ phraseId: "a", step: 0 }, { phraseId: "a", step: 4 }]);
  assert.deepEqual(groups.map((g) => g.id), [g2.id]);
  assert.notEqual(g1.hue, g2.hue);
  assert.equal(g2.name, "グループ2");
});

test("グループの読み込み：おかしい値は直し、メンバーの無いものは捨てる", () => {
  const groups = sanitizeGroups([
    { id: "x", name: "サビ", members: [{ phraseId: "a", step: 4.4 }, { phraseId: "a", step: 4 }, { step: 1 }], pitch: 40, pan: 3, gate: 0, vel: 9, muted: true, fx: [{ kind: "delay" }, { kind: "?" }] },
    { members: [] },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "サビ");
  assert.deepEqual(groups[0].members, [{ phraseId: "a", step: 4 }]);
  assert.equal(groups[0].pitch, 12);
  assert.equal(groups[0].pan, 1);
  assert.equal(groups[0].gate, 0.05);
  assert.equal(groups[0].vel, 1.5);
  assert.equal(groups[0].muted, true);
  assert.deepEqual(groups[0].fx.map((p) => p.kind), ["delay"]);
  assert.ok(newPlugin("delay").id);
});
