/**
 * progress.js — pure functions on the progress blob (ARCHITECTURE §6, §7.5).
 *
 * Purpose
 *   Everything that changes or summarises the learner's saved state: cards,
 *   XP, levels, daily log, streak, unit unlocks and statistics. No I/O — the
 *   blob goes in, a new blob comes out; storage.js persists it.
 *
 * How it fits
 *   ui/quiz.js and ui/listen.js call applyIntro / applyAnswer /
 *   applyDialogueAnswer / applyListen / finishSession and then
 *   storage.saveProgress(). ui/home.js, units.js, unit.js and stats.js read
 *   levelInfo / unitStats / overallStats. engine/session.js reads the blob.
 *   Uses engine/srs.js. Pure: `now` is a parameter, nothing is mutated.
 *
 * Key concepts
 *   - Every apply* function returns an envelope
 *       { progress, xpGained, events }
 *     where events is an array of objects with a `type`:
 *       { type:"levelUp", level, title, titleEn }
 *       { type:"goalReached", day }
 *       { type:"streak", current }          (when the streak advanced)
 *       { type:"comboBonus", bonus }
 *       { type:"unitUnlocked", unitId }     (only when a curriculum is passed)
 *   - Day keys are the device-local calendar date "YYYY-MM-DD".
 *   - Streak: a day counts once its XP reaches settings.dailyGoalXp.
 *
 * Public API
 *   DEFAULT_SETTINGS, ACCENTS, XP
 *   defaultProgress(now) -> Progress
 *   dayKey(now) / shiftDayKey(key, delta)
 *   getCard(progress, id) -> Card
 *   applyIntro(progress, {itemId, now, curriculum?})
 *   applyAnswer(progress, {itemId, correct, now, combo, curriculum?})
 *   applyDialogueAnswer(progress, {dialogueId, correct, now, combo, countPlay?, curriculum?})
 *   applyListen(progress, {introducedIds, reviewedIds, dialogueIds?, seconds, now, curriculum?})
 *   finishSession(progress, now)
 *   effectiveStreak(progress, now) -> number
 *   levelInfo(xp) -> {level, title, titleEn, xpIntoLevel, xpForNext, fraction}
 *   unitStats(progress, curriculum, unitId)
 *   checkUnlocks(progress, curriculum) -> {progress, newlyUnlocked}
 *   unlockUnit(progress, unitId) -> Progress
 *   overallStats(progress, curriculum, now)
 */

import { newCard, introduce, review, status } from "../engine/srs.js";

// ===== Section: Types =====

/**
 * @typedef {Object} DayLog
 * @property {number} xp
 * @property {number} answered
 * @property {number} correct
 * @property {number} listenSec
 * @property {number} sessions
 */

/**
 * @typedef {Object} Progress
 * @property {number} version                       Schema version (1).
 * @property {number} createdAt                     Epoch ms.
 * @property {Object<string, import("../engine/srs.js").Card>} cards
 * @property {Object<string, {heard:number, correct:number, wrong:number}>} dialogues
 * @property {string[]} unlocked                    Unit ids.
 * @property {number} xp                            Lifetime XP.
 * @property {Object<string, DayLog>} daily         Keyed by local day key.
 * @property {{current:number, best:number, lastDay:(string|null)}} streak
 * @property {{pinyin:string, sessionLength:string, zhSpeed:string, dailyGoalXp:number, sfx:boolean, accent:"sg"|"cn"}} settings
 */

// ===== Section: Constants =====

/**
 * Default user settings (§6).
 * WHY accent "sg": the learner lives in Singapore, so Singapore Mandarin is the
 * default; the app falls back to Mainland audio while no Singapore clips exist (§5).
 */
export const DEFAULT_SETTINGS = Object.freeze({
  pinyin: "always", sessionLength: "normal", zhSpeed: "normal", dailyGoalXp: 60, sfx: true, accent: "sg",
});

/** Allowed values of `settings.accent`. */
export const ACCENTS = Object.freeze(["sg", "cn"]);

/** XP awards (§7.5). */
export const XP = Object.freeze({
  correct: 10, dialogueCorrect: 15, wrong: 2, intro: 2, segment: 3, comboBonus: 10, comboEvery: 5,
});

/** Unlock threshold: percent of a unit's items at box >= 2. */
const UNLOCK_PERCENT = 70;

const LEVEL_TITLES = [
  [20, "大师", "Master"], [15, "达人", "Expert"], [10, "行者", "Traveller"],
  [6, "听众", "Listener"], [3, "学生", "Student"], [1, "新手", "Newcomer"],
];

// ===== Section: Construction and day keys =====

/**
 * A brand-new progress blob.
 * WHY: unlocked starts as ["u01"] because "the first unit is always unlocked"
 * and unit ids are a stable contract (§4); checkUnlocks also repairs this
 * against the real curriculum.
 * @param {number} now Epoch ms.
 * @returns {Progress}
 */
export function defaultProgress(now) {
  return {
    version: 1, createdAt: now, cards: {}, dialogues: {}, unlocked: ["u01"], xp: 0,
    daily: {}, streak: { current: 0, best: 0, lastDay: null }, settings: { ...DEFAULT_SETTINGS },
  };
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Device-local calendar date of a timestamp.
 * @param {number} now Epoch ms.
 * @returns {string} "YYYY-MM-DD"
 */
export function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Move a day key by whole calendar days.
 * WHY: uses Date's calendar arithmetic (not "- 86400000") so DST changes
 * cannot skip or repeat a day.
 * @param {string} key "YYYY-MM-DD"
 * @param {number} delta Days (negative = earlier).
 * @returns {string}
 */
export function shiftDayKey(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + delta, 12).getTime());
}

// ===== Section: Cards =====

/**
 * Card for an id, or a fresh one if none stored yet.
 * @param {Progress} progress
 * @param {string} id
 * @returns {import("../engine/srs.js").Card}
 */
export function getCard(progress, id) {
  return progress.cards[id] || newCard();
}

// ===== Section: Levels =====

/** Total XP required to reach level L (L >= 1). */
const xpToReach = (L) => 50 * (L - 1) * L;

/**
 * Level information for a lifetime XP total.
 * WHY: ARCHITECTURE says "level n needs 50*n*(n+1) total XP", while titles start
 * at level 1. We read it as "to go from level n to n+1 you need a lifetime total
 * of 50*n*(n+1)", i.e. level 1 starts at 0 XP, level 2 at 100, level 3 at 300.
 * @param {number} xp Lifetime XP.
 * @returns {{level:number, title:string, titleEn:string, xpIntoLevel:number, xpForNext:number, fraction:number}}
 *   `xpForNext` is the XP span of the current level (so the bar is xpIntoLevel / xpForNext).
 */
export function levelInfo(xp) {
  let level = 1;
  while (xp >= xpToReach(level + 1)) level++;
  const [, title, titleEn] = LEVEL_TITLES.find(([min]) => level >= min);
  const xpIntoLevel = xp - xpToReach(level);
  const xpForNext = xpToReach(level + 1) - xpToReach(level);
  return { level, title, titleEn, xpIntoLevel, xpForNext, fraction: xpIntoLevel / xpForNext };
}

// ===== Section: Internal XP / daily / streak plumbing =====

const emptyDay = () => ({ xp: 0, answered: 0, correct: 0, listenSec: 0, sessions: 0 });

/**
 * Add XP and daily counters, then derive events (level up, goal, streak).
 * @param {Progress} progress
 * @param {number} xp XP to add (>= 0).
 * @param {number} now
 * @param {Partial<DayLog>} dayDelta Extra daily counters to add (answered, correct, listenSec, sessions).
 * @returns {{progress: Progress, events: Object[]}}
 */
function addXp(progress, xp, now, dayDelta = {}) {
  const key = dayKey(now);
  const day = { ...emptyDay(), ...progress.daily[key] };
  const before = day.xp;
  for (const k of Object.keys(dayDelta)) day[k] += dayDelta[k];
  day.xp += xp;

  const events = [];
  const oldLevel = levelInfo(progress.xp).level;
  const newXp = progress.xp + xp;
  const li = levelInfo(newXp);
  if (li.level > oldLevel) events.push({ type: "levelUp", level: li.level, title: li.title, titleEn: li.titleEn });

  let streak = progress.streak;
  const goal = progress.settings.dailyGoalXp;
  if (before < goal && day.xp >= goal) {
    events.push({ type: "goalReached", day: key });
    streak = advanceStreak(streak, key);
    events.push({ type: "streak", current: streak.current });
  }
  return {
    progress: { ...progress, xp: newXp, daily: { ...progress.daily, [key]: day }, streak },
    events,
  };
}

/**
 * Count `key` as a goal-met day.
 * @param {Progress["streak"]} streak
 * @param {string} key Today's day key.
 * @returns {Progress["streak"]}
 */
function advanceStreak(streak, key) {
  if (streak.lastDay === key) return streak;
  const continues = streak.lastDay === shiftDayKey(key, -1);
  const current = continues ? streak.current + 1 : 1; // WHY: a gap restarts at 1 (today counts)
  return { current, best: Math.max(streak.best, current), lastDay: key };
}

/** Append unitUnlocked events by running checkUnlocks when a curriculum is supplied. */
function withUnlocks(result, curriculum) {
  if (!curriculum) return result;
  const u = checkUnlocks(result.progress, curriculum);
  return {
    ...result, progress: u.progress,
    events: [...result.events, ...u.newlyUnlocked.map((unitId) => ({ type: "unitUnlocked", unitId }))],
  };
}

/** Combo bonus for the combo count that includes this correct answer. */
function comboBonus(correct, combo) {
  return correct && combo > 0 && combo % XP.comboEvery === 0 ? XP.comboBonus : 0;
}

/**
 * The streak value to show: a streak whose last counted day is older than
 * yesterday has lapsed and displays as 0 (§7.5 "missing a day resets current").
 * @param {Progress} progress
 * @param {number} now
 * @returns {number}
 */
export function effectiveStreak(progress, now) {
  const { lastDay, current } = progress.streak;
  if (!lastDay) return 0;
  const today = dayKey(now);
  return lastDay === today || lastDay === shiftDayKey(today, -1) ? current : 0;
}

// ===== Section: Applying learning events =====

/**
 * Record that an item was introduced (intro step shown / new segment heard).
 * Already-introduced items give no XP (prevents farming by re-listening).
 * @param {Progress} progress
 * @param {{itemId: string, now: number, curriculum?: Object}} args
 * @returns {{progress: Progress, xpGained: number, events: Object[]}}
 */
export function applyIntro(progress, { itemId, now, curriculum }) {
  const card = getCard(progress, itemId);
  if (card.introduced) return { progress, xpGained: 0, events: [] };
  const p = { ...progress, cards: { ...progress.cards, [itemId]: introduce(card, now) } };
  const r = addXp(p, XP.intro, now);
  return withUnlocks({ ...r, xpGained: XP.intro }, curriculum);
}

/**
 * Record an answer to an item question.
 * @param {Progress} progress
 * @param {Object} args
 * @param {string} args.itemId
 * @param {boolean} args.correct
 * @param {number} args.now
 * @param {number} [args.combo] Consecutive correct answers INCLUDING this one
 *   (the quiz screen tracks it; ignored when wrong). Every 5th earns +10.
 * @param {Object} [args.curriculum] If given, unit unlocks are checked and reported.
 * @returns {{progress: Progress, xpGained: number, events: Object[]}}
 */
export function applyAnswer(progress, { itemId, correct, now, combo = 0, curriculum }) {
  // WHY: an answered card is by definition known to the learner; marking it
  // introduced keeps statuses sane even if a caller skipped applyIntro.
  const card = { ...review(getCard(progress, itemId), correct, now), introduced: true };
  const bonus = comboBonus(correct, combo);
  const xpGained = (correct ? XP.correct : XP.wrong) + bonus;
  const p = { ...progress, cards: { ...progress.cards, [itemId]: card } };
  const r = addXp(p, xpGained, now, { answered: 1, correct: correct ? 1 : 0 });
  if (bonus) r.events.push({ type: "comboBonus", bonus });
  return withUnlocks({ ...r, xpGained }, curriculum);
}

/**
 * Record an answer to a dialogue comprehension question.
 * @param {Progress} progress
 * @param {Object} args
 * @param {string} args.dialogueId
 * @param {boolean} args.correct
 * @param {number} args.now
 * @param {number} [args.combo] As in applyAnswer.
 * @param {boolean} [args.countPlay=true] Also increment `heard`; the UI passes
 *   false for the 2nd question of the same dialogue step.
 * @param {Object} [args.curriculum]
 * @returns {{progress: Progress, xpGained: number, events: Object[]}}
 */
export function applyDialogueAnswer(progress, { dialogueId, correct, now, combo = 0, countPlay = true, curriculum }) {
  const d = progress.dialogues[dialogueId] || { heard: 0, correct: 0, wrong: 0 };
  const nd = {
    heard: d.heard + (countPlay ? 1 : 0),
    correct: d.correct + (correct ? 1 : 0),
    wrong: d.wrong + (correct ? 0 : 1),
  };
  const bonus = comboBonus(correct, combo);
  const xpGained = (correct ? XP.dialogueCorrect : XP.wrong) + bonus;
  const p = { ...progress, dialogues: { ...progress.dialogues, [dialogueId]: nd } };
  const r = addXp(p, xpGained, now, { answered: 1, correct: correct ? 1 : 0 });
  if (bonus) r.events.push({ type: "comboBonus", bonus });
  return withUnlocks({ ...r, xpGained }, curriculum);
}

/**
 * Record a finished hands-free (commute) session or part of it.
 * Introduced ids get `introduce`; reviewed ids only get seen/lastSeen bumped
 * (we cannot know whether the listener understood, §7.4).
 * @param {Progress} progress
 * @param {Object} args
 * @param {string[]} args.introducedIds Items from completed `new` segments.
 * @param {string[]} args.reviewedIds   Items from completed `review` segments.
 * @param {string[]} [args.dialogueIds] Dialogues fully played (heard++).
 * @param {number} args.seconds         Listening time to add to daily.listenSec.
 * @param {number} args.now
 * @param {Object} [args.curriculum]
 * @returns {{progress: Progress, xpGained: number, events: Object[]}}
 */
export function applyListen(progress, { introducedIds = [], reviewedIds = [], dialogueIds = [], seconds, now, curriculum }) {
  const cards = { ...progress.cards };
  for (const id of introducedIds) {
    const c = cards[id] || newCard();
    // WHY: re-hearing an already introduced item must not reset its schedule.
    cards[id] = c.introduced ? { ...c, seen: c.seen + 1, lastSeen: now } : { ...introduce(c, now), seen: c.seen + 1, lastSeen: now };
  }
  for (const id of reviewedIds) {
    const c = cards[id] || newCard();
    cards[id] = { ...c, seen: c.seen + 1, lastSeen: now };
  }
  const dialogues = { ...progress.dialogues };
  for (const id of dialogueIds) {
    const d = dialogues[id] || { heard: 0, correct: 0, wrong: 0 };
    dialogues[id] = { ...d, heard: d.heard + 1 };
  }
  const xpGained = XP.segment * (introducedIds.length + reviewedIds.length + dialogueIds.length);
  const r = addXp({ ...progress, cards, dialogues }, xpGained, now, { listenSec: Math.max(0, Math.round(seconds || 0)) });
  return withUnlocks({ ...r, xpGained }, curriculum);
}

/**
 * Close a session: count it in today's log and lapse an expired streak.
 * @param {Progress} progress
 * @param {number} now
 * @returns {{progress: Progress, xpGained: number, events: Object[]}}
 */
export function finishSession(progress, now) {
  const key = dayKey(now);
  const day = { ...emptyDay(), ...progress.daily[key] };
  day.sessions += 1;
  let streak = progress.streak;
  // WHY: store the lapse explicitly so exported/imported data shows 0 too.
  if (streak.lastDay && effectiveStreak(progress, now) === 0 && streak.current !== 0) {
    streak = { ...streak, current: 0 };
  }
  return { progress: { ...progress, daily: { ...progress.daily, [key]: day }, streak }, xpGained: 0, events: [] };
}

// ===== Section: Unit statistics and unlocking =====

/**
 * Per-unit counts by status, stars and unlock percentage.
 * @param {Progress} progress
 * @param {import("../engine/curriculum.js").Curriculum} curriculum
 * @param {string} unitId
 * @returns {{total:number, new:number, learning:number, familiar:number, mastered:number, stars:number, percentAtBox2:number}}
 *   stars: 1 = all introduced, 2 = all at box >= 2, 3 = all mastered. percentAtBox2 is 0..100.
 */
export function unitStats(progress, curriculum, unitId) {
  const s = { total: 0, new: 0, learning: 0, familiar: 0, mastered: 0, stars: 0, percentAtBox2: 0 };
  let box2 = 0;
  for (const it of curriculum.itemsOfUnit(unitId)) {
    const c = getCard(progress, it.id);
    s.total++;
    s[status(c)]++;
    if (c.introduced && c.box >= 2) box2++;
  }
  if (s.total > 0) {
    s.percentAtBox2 = (box2 * 100) / s.total; // WHY: multiply first so 7/10 is exactly 70
    if (s.new === 0) s.stars = 1;
    if (box2 === s.total) s.stars = 2;
    if (s.mastered === s.total) s.stars = 3;
  }
  return s;
}

/**
 * Unlock units whose predecessor has >= 70 % of items at box >= 2; the first
 * unit is always unlocked.
 * @param {Progress} progress
 * @param {import("../engine/curriculum.js").Curriculum} curriculum
 * @returns {{progress: Progress, newlyUnlocked: string[]}}
 */
export function checkUnlocks(progress, curriculum) {
  const unlocked = progress.unlocked.slice();
  const newly = [];
  const add = (id) => { if (!unlocked.includes(id)) { unlocked.push(id); newly.push(id); } };
  const units = curriculum.units;
  if (units.length && !unlocked.includes(units[0].id)) unlocked.unshift(units[0].id); // repair, not "newly"
  for (let i = 1; i < units.length; i++) {
    const prev = unitStats(progress, curriculum, units[i - 1].id);
    if (prev.total > 0 && prev.percentAtBox2 >= UNLOCK_PERCENT) add(units[i].id);
  }
  if (!newly.length && unlocked.length === progress.unlocked.length) return { progress, newlyUnlocked: [] };
  return { progress: { ...progress, unlocked }, newlyUnlocked: newly };
}

/**
 * Manually unlock a unit ("Unlock early" button). Idempotent.
 * @param {Progress} progress
 * @param {string} unitId
 * @returns {Progress}
 */
export function unlockUnit(progress, unitId) {
  if (progress.unlocked.includes(unitId)) return progress;
  return { ...progress, unlocked: [...progress.unlocked, unitId] };
}

// ===== Section: Overall statistics =====

/**
 * Summary numbers for the stats screen.
 * @param {Progress} progress
 * @param {import("../engine/curriculum.js").Curriculum} curriculum
 * @param {number} now
 * @returns {{
 *   totals: {items:number, new:number, learning:number, familiar:number, mastered:number},
 *   accuracy7: (number|null), accuracy30: (number|null),
 *   answered: number, listenMinutes: number, xp: number, level: Object,
 *   streak: number, bestStreak: number, goalToday: {xp:number, goal:number, met:boolean},
 *   series14: Array<{day:string, xp:number, answered:number, correct:number, listenSec:number, goalMet:boolean}>,
 *   units: Array<Object>
 * }} accuracy values are fractions 0..1 (null when nothing answered);
 *   series14 is oldest -> today.
 */
export function overallStats(progress, curriculum, now) {
  const totals = { items: 0, new: 0, learning: 0, familiar: 0, mastered: 0 };
  for (const it of curriculum.items.values()) {
    totals.items++;
    totals[status(getCard(progress, it.id))]++;
  }
  const today = dayKey(now);
  const goal = progress.settings.dailyGoalXp;
  const series14 = [];
  for (let i = 13; i >= 0; i--) {
    const day = shiftDayKey(today, -i);
    const d = { ...emptyDay(), ...progress.daily[day] };
    series14.push({ day, xp: d.xp, answered: d.answered, correct: d.correct, listenSec: d.listenSec, goalMet: d.xp >= goal });
  }
  const accuracy = (days) => {
    let a = 0, c = 0;
    for (let i = 0; i < days; i++) {
      const d = progress.daily[shiftDayKey(today, -i)];
      if (d) { a += d.answered; c += d.correct; }
    }
    return a ? c / a : null;
  };
  let listenSec = 0, answered = 0;
  for (const d of Object.values(progress.daily)) { listenSec += d.listenSec || 0; answered += d.answered || 0; }
  const todayLog = progress.daily[today];
  return {
    totals,
    accuracy7: accuracy(7), accuracy30: accuracy(30),
    answered, listenMinutes: listenSec / 60,
    xp: progress.xp, level: levelInfo(progress.xp),
    streak: effectiveStreak(progress, now), bestStreak: progress.streak.best,
    goalToday: { xp: todayLog ? todayLog.xp : 0, goal, met: (todayLog ? todayLog.xp : 0) >= goal },
    series14,
    units: curriculum.units.map((u) => ({ unitId: u.id, ...unitStats(progress, curriculum, u.id) })),
  };
}
