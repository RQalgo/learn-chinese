import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultProgress, dayKey, shiftDayKey, getCard, applyIntro, applyAnswer, applyDialogueAnswer, applyListen,
  finishSession, effectiveStreak, levelInfo, unitStats, checkUnlocks, unlockUnit, overallStats,
} from "../../js/state/progress.js";
import { buildCurriculum } from "../../js/engine/curriculum.js";
import { curriculum, fresh, T0, DAY } from "./fixture.mjs";

const cur = curriculum();
const at = (dayOffset, hour = 10) => new Date(2026, 10, 17 + dayOffset, hour).getTime();

test("dayKey is local and shiftDayKey crosses month ends", () => {
  assert.equal(dayKey(new Date(2026, 10, 17, 23, 59).getTime()), "2026-11-17");
  assert.equal(dayKey(new Date(2026, 10, 18, 0, 1).getTime()), "2026-11-18");
  assert.equal(shiftDayKey("2026-12-01", -1), "2026-11-30");
  assert.equal(shiftDayKey("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDayKey("2026-03-01", -1), "2026-02-28");
});

test("defaultProgress shape; getCard returns fresh card for unknown ids", () => {
  const p = defaultProgress(123);
  assert.equal(p.version, 1); assert.equal(p.createdAt, 123); assert.deepEqual(p.unlocked, ["u01"]);
  assert.equal(p.settings.dailyGoalXp, 60);
  assert.equal(getCard(p, "u01-w01").introduced, false);
});

test("levelInfo boundaries and titles", () => {
  const cases = [[0, 1], [99, 1], [100, 2], [299, 2], [300, 3], [599, 3], [600, 4], [1500, 6], [4500, 10], [10500, 15], [19000, 20]];
  for (const [xp, lvl] of cases) assert.equal(levelInfo(xp).level, lvl, `xp ${xp}`);
  assert.equal(levelInfo(0).title, "新手");
  assert.equal(levelInfo(300).title, "学生");
  assert.equal(levelInfo(1500).title, "听众");
  assert.equal(levelInfo(4500).title, "行者");
  assert.equal(levelInfo(10500).title, "达人");
  assert.equal(levelInfo(19000).title, "大师");
  const li = levelInfo(150);
  assert.equal(li.xpIntoLevel, 50); assert.equal(li.xpForNext, 200); assert.equal(li.fraction, 0.25);
});

test("applyIntro: +2 XP once, card introduced, immutable", () => {
  const p0 = fresh();
  const r = applyIntro(p0, { itemId: "u01-w01", now: T0 });
  assert.equal(r.xpGained, 2); assert.equal(r.progress.xp, 2);
  assert.equal(r.progress.cards["u01-w01"].introduced, true);
  assert.equal(p0.xp, 0); assert.deepEqual(p0.cards, {});
  const again = applyIntro(r.progress, { itemId: "u01-w01", now: T0 });
  assert.equal(again.xpGained, 0); assert.equal(again.progress, r.progress);
});

test("applyAnswer: correct +10, wrong +2, card and daily log updated", () => {
  let r = applyAnswer(fresh(), { itemId: "u01-w01", correct: true, now: T0, combo: 1 });
  assert.equal(r.xpGained, 10);
  assert.equal(r.progress.cards["u01-w01"].box, 1);
  assert.equal(r.progress.cards["u01-w01"].due, T0 + DAY);
  r = applyAnswer(r.progress, { itemId: "u01-w01", correct: false, now: T0 });
  assert.equal(r.xpGained, 2);
  assert.equal(r.progress.xp, 12);
  assert.deepEqual(r.progress.daily["2026-11-17"], { xp: 12, answered: 2, correct: 1, listenSec: 0, sessions: 0 });
});

test("combo bonus every 5th correct; none on wrong or other counts", () => {
  const f = (combo, correct = true) => applyAnswer(fresh(), { itemId: "u01-w01", correct, now: T0, combo });
  assert.equal(f(4).xpGained, 10);
  assert.equal(f(5).xpGained, 20);
  assert.ok(f(5).events.some((e) => e.type === "comboBonus" && e.bonus === 10));
  assert.equal(f(10).xpGained, 20);
  assert.equal(f(5, false).xpGained, 2);
  assert.equal(f(0).xpGained, 10);
});

test("dialogue answers: +15 correct, +2 wrong, counters", () => {
  let r = applyDialogueAnswer(fresh(), { dialogueId: "u01-d01", correct: true, now: T0, combo: 1 });
  assert.equal(r.xpGained, 15);
  r = applyDialogueAnswer(r.progress, { dialogueId: "u01-d01", correct: false, now: T0, countPlay: false });
  assert.equal(r.xpGained, 2);
  assert.deepEqual(r.progress.dialogues["u01-d01"], { heard: 1, correct: 1, wrong: 1 });
});

test("levelUp event fires at the boundary only", () => {
  let p = { ...fresh(), xp: 95 };
  let r = applyAnswer(p, { itemId: "u01-w01", correct: true, now: T0 });
  const lu = r.events.find((e) => e.type === "levelUp");
  assert.equal(lu.level, 2);
  r = applyAnswer(r.progress, { itemId: "u01-w02", correct: true, now: T0 });
  assert.ok(!r.events.some((e) => e.type === "levelUp"));
});

test("daily goal: goalReached once, streak starts at 1", () => {
  let p = fresh();
  const goals = [];
  for (let i = 0; i < 8; i++) {
    const r = applyAnswer(p, { itemId: `u01-w0${(i % 4) + 1}`, correct: true, now: T0 + i * 1000 });
    p = r.progress;
    goals.push(r.events.some((e) => e.type === "goalReached"));
  }
  assert.deepEqual(goals, [false, false, false, false, false, true, false, false]);
  assert.deepEqual(p.streak, { current: 1, best: 1, lastDay: "2026-11-17" });
});

test("streak across days, including a missed day", () => {
  const reach = (p, when) => {
    // 6 correct answers = 60 XP = goal
    for (let i = 0; i < 6; i++) p = applyAnswer(p, { itemId: "u01-w01", correct: true, now: when + i }).progress;
    return finishSession(p, when + 10).progress;
  };
  let p = fresh();
  p = reach(p, at(0));
  assert.equal(p.streak.current, 1);
  p = reach(p, at(1));
  assert.equal(p.streak.current, 2);
  assert.equal(effectiveStreak(p, at(2)), 2, "yesterday counted: still alive");
  assert.equal(effectiveStreak(p, at(3)), 0, "a full day missed: lapsed");
  // Day 4 (offset 3): a partial day does not count; finishing resets current.
  let q = applyAnswer(p, { itemId: "u01-w02", correct: true, now: at(3) }).progress;
  q = finishSession(q, at(3, 11)).progress;
  assert.equal(q.streak.current, 0);
  assert.equal(q.streak.best, 2);
  // Reaching the goal again after the gap restarts at 1.
  const r = reach(p, at(3));
  assert.equal(r.streak.current, 1);
  assert.equal(r.streak.best, 2);
  // Late-night second session on the same day does not double count
  const again = reach(r, at(3, 22));
  assert.equal(again.streak.current, 1);
});

test("finishSession increments sessions", () => {
  const p = finishSession(finishSession(fresh(), T0).progress, T0 + 5).progress;
  assert.equal(p.daily["2026-11-17"].sessions, 2);
});

test("applyListen: introduces, bumps seen, +3 per segment, listenSec", () => {
  const base = applyAnswer(fresh(), { itemId: "u01-w03", correct: true, now: T0 }).progress;
  const r = applyListen(base, { introducedIds: ["u01-w01"], reviewedIds: ["u01-w03"], dialogueIds: ["u01-d01"], seconds: 90, now: T0 + 1000 });
  assert.equal(r.xpGained, 9);
  assert.equal(r.progress.cards["u01-w01"].introduced, true);
  assert.equal(r.progress.cards["u01-w03"].box, 1, "review segment does not change box");
  assert.equal(r.progress.cards["u01-w03"].seen, 2);
  assert.equal(r.progress.cards["u01-w03"].lastSeen, T0 + 1000);
  assert.equal(r.progress.daily["2026-11-17"].listenSec, 90);
  assert.equal(r.progress.dialogues["u01-d01"].heard, 1);
});

function boxes(ids, box) {
  const cards = {};
  for (const id of ids) cards[id] = { box, due: 0, introduced: true, seen: 1, correct: 1, wrong: 0, lastSeen: 0 };
  return cards;
}

test("unitStats counts, stars and percent", () => {
  const ids = cur.unit("u01").itemIds;
  const none = unitStats(fresh(), cur, "u01");
  assert.deepEqual(none, { total: 9, new: 9, learning: 0, familiar: 0, mastered: 0, stars: 0, percentAtBox2: 0 });
  const all0 = unitStats({ ...fresh(), cards: boxes(ids, 0) }, cur, "u01");
  assert.equal(all0.stars, 1);
  const all2 = unitStats({ ...fresh(), cards: boxes(ids, 2) }, cur, "u01");
  assert.equal(all2.stars, 2); assert.equal(all2.percentAtBox2, 100);
  const all5 = unitStats({ ...fresh(), cards: boxes(ids, 5) }, cur, "u01");
  assert.equal(all5.stars, 3); assert.equal(all5.mastered, 9);
  const mixed = unitStats({ ...fresh(), cards: { ...boxes(ids.slice(0, 3), 4), ...boxes(ids.slice(3, 4), 1) } }, cur, "u01");
  assert.equal(mixed.familiar, 3); assert.equal(mixed.learning, 1); assert.equal(mixed.new, 5);
  assert.equal(unitStats(fresh(), cur, "nope").total, 0);
});

test("unlock at 70 % of items at box >= 2 (exact boundary with 10 items)", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `u01-w${String(i + 1).padStart(2, "0")}`, type: "word", hanzi: "x", pinyin: "x", english: `e${i}` }));
  const c = buildCurriculum({ units: [{ id: "u01", order: 1, title: "a" }, { id: "u02", order: 2, title: "b" }] }, { u01: { id: "u01", items } });
  const ids = items.map((i) => i.id);
  const six = checkUnlocks({ ...fresh(), cards: boxes(ids.slice(0, 6), 2) }, c);
  assert.deepEqual(six.newlyUnlocked, []); assert.deepEqual(six.progress.unlocked, ["u01"]);
  const seven = checkUnlocks({ ...fresh(), cards: boxes(ids.slice(0, 7), 2) }, c);
  assert.deepEqual(seven.newlyUnlocked, ["u02"]); assert.deepEqual(seven.progress.unlocked, ["u01", "u02"]);
  // box 1 does not count
  assert.deepEqual(checkUnlocks({ ...fresh(), cards: boxes(ids, 1) }, c).newlyUnlocked, []);
  // idempotent
  assert.deepEqual(checkUnlocks(seven.progress, c).newlyUnlocked, []);
});

test("first unit always unlocked; unlockUnit is idempotent; applyAnswer reports unitUnlocked", () => {
  const repaired = checkUnlocks({ ...fresh(), unlocked: [] }, cur).progress;
  assert.deepEqual(repaired.unlocked, ["u01"]);
  const p = unlockUnit(fresh(), "u03");
  assert.deepEqual(p.unlocked, ["u01", "u03"]);
  assert.equal(unlockUnit(p, "u03"), p);
  const ids = cur.unit("u01").itemIds;
  // 6 of 9 at box 2 (66 %), the 7th answer pushes to 77 %.
  const base = { ...fresh(), cards: boxes(ids.slice(0, 6), 2) };
  base.cards[ids[6]] = { box: 1, due: 0, introduced: true, seen: 1, correct: 1, wrong: 0, lastSeen: 0 };
  const r = applyAnswer(base, { itemId: ids[6], correct: true, now: T0, curriculum: cur });
  assert.ok(r.events.some((e) => e.type === "unitUnlocked" && e.unitId === "u02"));
  assert.ok(r.progress.unlocked.includes("u02"));
});

test("overallStats: totals, accuracy windows, listen minutes, 14-day series", () => {
  let p = fresh();
  p = applyAnswer(p, { itemId: "u01-w01", correct: true, now: at(-20) }).progress; // outside both 7d and... inside 30d
  p = applyAnswer(p, { itemId: "u01-w01", correct: false, now: at(-3) }).progress; // inside 7d
  p = applyAnswer(p, { itemId: "u01-w02", correct: true, now: at(0) }).progress;
  p = applyListen(p, { introducedIds: [], reviewedIds: [], seconds: 120, now: at(-1) }).progress;
  const s = overallStats(p, cur, at(0));
  assert.equal(s.totals.items, 27);
  assert.equal(s.totals.learning, 2); assert.equal(s.totals.new, 25);
  assert.equal(s.accuracy7, 0.5);
  assert.equal(s.accuracy30, 2 / 3);
  assert.equal(s.listenMinutes, 2);
  assert.equal(s.series14.length, 14);
  assert.equal(s.series14[13].day, "2026-11-17");
  assert.equal(s.series14[0].day, "2026-11-04");
  assert.equal(s.series14[13].answered, 1);
  assert.equal(s.series14[10].answered, 1); // 3 days ago
  assert.equal(s.series14[12].listenSec, 120);
  assert.equal(overallStats(fresh(), cur, T0).accuracy7, null);
  assert.equal(s.units.length, 3);
});
