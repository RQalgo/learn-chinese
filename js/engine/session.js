/**
 * session.js — plans a quiz session (§7.2) or a hands-free commute playlist (§7.4).
 *
 * Purpose
 *   Decide WHAT to practise and in which order. Planning is separate from
 *   question building: a quiz step only names an item and qtype; the body is
 *   built lazily by questions.js when the step is reached.
 *
 * How it fits
 *   ui/quiz.js calls planQuizSession() then walks plan.steps, calling
 *   requeue() after wrong answers. ui/listen.js calls planListenSession() and
 *   feeds each segment's clip ids to audio/player.js's Playlist. Reads
 *   progress cards through srs.js; uses questions.js (chooseQtype) and rng.js.
 *   Pure: `now` and `rng` are parameters.
 *
 * Key concepts
 *   - Quiz length counts QUESTIONS (intro steps are extra).
 *   - Budget order: dialogue slots and new items are reserved first, then due
 *     reviews fill up to 70 % of the length, then not-yet-due cards fill the rest.
 *   - Quiz sessions with little due get second questions for new items (appended, spaced >= 3).
 *   - Listen plans are built from clip ids only and sized by estimated seconds; the
 *     self-test section cycles through this playlist's new words when little is due.
 *
 * Public API
 *   QUIZ_LENGTHS
 *   planQuizSession({curriculum, progress, now, rng, length, unitId?}) -> QuizPlan
 *   requeue(plan, index, step, rng) -> QuizPlan
 *   planListenSession({curriculum, progress, now, rng, minutes, unitId?, durations?}) -> ListenPlan
 *   planClipIds(listenPlan) -> string[]
 */

import { shuffle, sample } from "./rng.js";
import { isDue, newCard } from "./srs.js";
import { chooseQtype } from "./questions.js";

// ===== Section: Types =====

/**
 * @typedef {Object} Step
 * @property {"intro"|"question"|"dialogue"} kind
 * @property {string} [itemId]        intro / question
 * @property {string} [qtype]         question
 * @property {string} [dialogueId]    dialogue
 * @property {string[]} [questionIds] dialogue
 * @property {boolean} [requeued]     True on a copy inserted by requeue().
 */

/**
 * @typedef {Object} QuizPlan
 * @property {"quiz"} kind
 * @property {Step[]} steps
 * @property {number} length          Requested number of questions.
 * @property {{review:number, new:number, dialogue:number, fill:number, second:number}} counts Questions per source (second = repeat questions for new items).
 * @property {string[]} requeued      Item ids already re-queued (once per item per session).
 */

/**
 * @typedef {Object} Segment
 * @property {"new"|"review"|"dialogue"|"prompt"} kind
 * @property {string} refId   Item id, dialogue id, or the sys clip id for prompts.
 * @property {string[]} clips Clip ids played in order.
 */

/**
 * @typedef {Object} ListenPlan
 * @property {"listen"} kind
 * @property {Segment[]} segments
 * @property {number} targetSec
 * @property {number} estimatedSec
 */

// ===== Section: Constants =====

/** Questions per session length setting. */
export const QUIZ_LENGTHS = { short: 10, normal: 20, long: 30 };
/** New-item cap per quiz session by length: short / normal / long (and anything in between rounds up). */
const NEW_CAP = { short: 4, normal: 8, long: 10 };
/** Gap (steps) between a new item's first and second question. */
const SECOND_Q_GAP = 3;
/** Listen: one new item per this many target seconds, at most MAX_NEW_LISTEN. */
const LISTEN_SEC_PER_NEW = 40;
const MAX_NEW_LISTEN = 12;
/** Listen: how many times the self-test pool may be cycled to fill the time. */
const MAX_SELFTEST_ROUNDS = 6;
const REVIEW_SHARE = 0.7;
/** A dialogue is offered once this share of its unit's items are introduced. */
const DIALOGUE_READY = 0.6;

// ===== Section: Shared helpers =====

/** Card for id from the blob (read-only; avoids importing progress.js to keep engine -> state one-way). */
const cardOf = (progress, id) => progress.cards[id] || newCard();

/**
 * Items in scope for a session: one unit if `unitId`, otherwise all unlocked units.
 * WHY: an explicit unitId may name a locked unit ("practise this unit" is the
 * user's choice), so unlocked state is only applied when no unit is given.
 * @returns {import("./curriculum.js").Item[]}
 */
function itemsInScope(curriculum, progress, unitId) {
  if (unitId) return curriculum.itemsOfUnit(unitId);
  const out = [];
  for (const u of curriculum.units) if (progress.unlocked.includes(u.id)) out.push(...curriculum.itemsOfUnit(u.id));
  return out;
}

/** The earliest in-scope unit that still has un-introduced items, with those items (file order). */
function nextNewItems(curriculum, progress, unitId) {
  const units = unitId ? [curriculum.unit(unitId)].filter(Boolean)
    : curriculum.units.filter((u) => progress.unlocked.includes(u.id));
  for (const u of units) {
    const fresh = curriculum.itemsOfUnit(u.id).filter((it) => !cardOf(progress, it.id).introduced);
    if (fresh.length) return { unit: u, items: fresh };
  }
  return { unit: null, items: [] };
}

// ===== Section: Quiz session =====

/**
 * Plan a quiz session.
 * @param {Object} args
 * @param {import("./curriculum.js").Curriculum} args.curriculum
 * @param {import("../state/progress.js").Progress} args.progress
 * @param {number} args.now Epoch ms.
 * @param {() => number} args.rng
 * @param {number|"short"|"normal"|"long"} [args.length="normal"] Number of questions or a named size.
 * @param {string} [args.unitId] Practise only this unit.
 * @returns {QuizPlan}
 */
export function planQuizSession({ curriculum, progress, now, rng, length = "normal", unitId }) {
  const L = typeof length === "number" ? length : (QUIZ_LENGTHS[length] || QUIZ_LENGTHS.normal);
  const scope = itemsInScope(curriculum, progress, unitId);
  const scopeIds = new Set(scope.map((i) => i.id));

  // --- new items (earliest unit with new items, capped) ---
  const { unit: newUnit, items: freshItems } = nextNewItems(curriculum, progress, unitId);
  const newCap = L <= QUIZ_LENGTHS.short ? NEW_CAP.short : L <= QUIZ_LENGTHS.normal ? NEW_CAP.normal : NEW_CAP.long;
  const newItems = freshItems.slice(0, Math.min(newCap, L));

  // --- dialogue (decided early so its slots are reserved) ---
  const dlg = pickDialogue(curriculum, progress, unitId, newUnit, newItems);
  const dlgQuestions = dlg ? sample(dlg.questions || [], L >= QUIZ_LENGTHS.normal ? 2 : 1, rng) : [];
  const dlgCount = Math.min(dlgQuestions.length, Math.max(0, L - newItems.length));
  const dlgIds = dlgQuestions.slice(0, dlgCount).map((q) => q.id);

  // --- reviews: due, introduced, most overdue first, capped at 70 % of L ---
  // WHY: new items + dialogue are reserved BEFORE reviews are trimmed so that a
  // learner with a big backlog still gets to progress; the 70 % cap still applies.
  const due = scope
    .filter((it) => isDue(cardOf(progress, it.id), now))
    .sort((a, b) => cardOf(progress, a.id).due - cardOf(progress, b.id).due);
  const reviewCap = Math.min(Math.floor(L * REVIEW_SHARE), L - newItems.length - dlgIds.length);
  const reviews = due.slice(0, Math.max(0, reviewCap));

  // --- fill: not-yet-due introduced cards, lowest box first ---
  const used = new Set(reviews.map((i) => i.id));
  const room = L - reviews.length - newItems.length - dlgIds.length;
  const fillPool = shuffle(scope, rng) // shuffle first so equal boxes vary between sessions
    .filter((it) => !used.has(it.id) && cardOf(progress, it.id).introduced)
    .sort((a, b) => cardOf(progress, a.id).box - cardOf(progress, b.id).box);
  const fill = fillPool.slice(0, Math.max(0, room));

  // --- assemble question steps for reviews + fill (shuffled) ---
  const qStep = (it) => ({ kind: "question", qtype: chooseQtype(it, cardOf(progress, it.id), rng), itemId: it.id });
  const steps = shuffle([...reviews, ...fill].map(qStep), rng);
  if (dlgIds.length) steps.push({ kind: "dialogue", dialogueId: dlg.id, questionIds: dlgIds });

  // --- insert new items: intro first, its question >= 2 steps later ---
  newItems.forEach((it, j) => {
    const p = Math.min(j, steps.length);
    steps.splice(p, 0, { kind: "intro", itemId: it.id });
    const q = Math.min(steps.length, p + 2 + Math.floor(rng() * 3));
    steps.splice(q, 0, { kind: "question", qtype: "listen-meaning", itemId: it.id });
  });
  // WHY: inserting later intros at the front can pull an earlier question closer
  // to its intro; push any too-close question to the end instead.
  enforceSpacing(steps);

  // --- second questions for new items, only while the session is still short ---
  // WHY: a learner with few reviews due (new learner, or just after a break)
  // would otherwise get ~8 questions. Asking each freshly introduced item a
  // second time later is good practice (repetition inside the session) and
  // never pushes the question count past `length`.
  // WHY listen-meaning: at plan time a new card is box 0, which only allows
  // listen-meaning; questions.js builds the body lazily, so the distractor
  // set and option order are drawn fresh when the step is reached.
  let secondCount = 0;
  let room2 = L - (reviews.length + newItems.length + dlgIds.length + fill.length);
  const order = newItems
    .map((it) => ({ it, at: steps.findIndex((x) => x.kind === "question" && x.itemId === it.id) }))
    .sort((a, b) => a.at - b.at);
  // WHY: second questions are appended as a block at the end, in the order of the
  // first questions. Inserting them mid-session would push the last new item's
  // first question to the very end with nothing after it, so it could never be
  // spaced >= SECOND_Q_GAP; appending in order guarantees the spacing for
  // everyone but a lone item at the very end of a tiny session (skipped).
  for (const { it, at } of order) {
    if (room2 <= 0) break;
    const first = steps.findIndex((x) => x.kind === "question" && x.itemId === it.id);
    if (at === -1 || first === -1 || steps.length - first < SECOND_Q_GAP) continue;
    steps.push({ kind: "question", qtype: "listen-meaning", itemId: it.id });
    secondCount++; room2--;
  }

  return {
    kind: "quiz", steps, length: L, requeued: [],
    counts: { review: reviews.length, new: newItems.length, dialogue: dlgIds.length, fill: fill.length, second: secondCount },
  };
}

/** Move questions of newly introduced items that sit < 2 steps after their intro to the end. */
function enforceSpacing(steps) {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].kind !== "intro") continue;
    const qi = steps.findIndex((s, k) => k > i && s.kind === "question" && s.itemId === steps[i].itemId);
    if (qi !== -1 && qi - i < 2) {
      const [q] = steps.splice(qi, 1);
      steps.push(q);
    }
  }
}

/**
 * Choose a dialogue to include, or null.
 * The "current" unit is the one providing the new items; if none, the unit
 * given by unitId, else the latest unlocked unit that has any introduced item.
 */
function pickDialogue(curriculum, progress, unitId, newUnit, newItems) {
  let unit = newUnit || (unitId ? curriculum.unit(unitId) : null);
  if (!unit) {
    for (const u of curriculum.units) {
      if (progress.unlocked.includes(u.id) && curriculum.itemsOfUnit(u.id).some((i) => cardOf(progress, i.id).introduced)) unit = u;
    }
  }
  if (!unit) return null;
  const items = curriculum.itemsOfUnit(unit.id);
  if (!items.length) return null;
  const newSet = new Set(newItems.map((i) => i.id));
  // WHY: items about to be introduced this session count as introduced, so a
  // dialogue can follow right after the last words of a unit are taught.
  const ready = items.filter((i) => cardOf(progress, i.id).introduced || newSet.has(i.id)).length / items.length;
  if (ready < DIALOGUE_READY) return null;
  const dialogues = curriculum.dialoguesOfUnit(unit.id).filter((d) => (d.questions || []).length);
  if (!dialogues.length) return null;
  // least-heard first (stable by file order)
  return dialogues.slice().sort((a, b) => ((progress.dialogues[a.id] || {}).heard || 0) - ((progress.dialogues[b.id] || {}).heard || 0))[0];
}

// ===== Section: Re-queue after a wrong answer =====

/**
 * Re-insert a missed question 3-5 steps later, at most once per item per session.
 * @param {QuizPlan} plan
 * @param {number} index Index of the step just answered.
 * @param {Step} step The step answered wrongly (must be kind "question").
 * @param {() => number} rng
 * @returns {QuizPlan} A new plan; the same object if nothing was re-queued.
 */
export function requeue(plan, index, step, rng) {
  if (!step || step.kind !== "question") return plan;
  if (plan.requeued.includes(step.itemId)) return plan;
  const offset = 3 + Math.floor(rng() * 3); // 3, 4 or 5
  const at = Math.min(index + offset, plan.steps.length);
  const steps = plan.steps.slice();
  steps.splice(at, 0, { ...step, requeued: true });
  return { ...plan, steps, requeued: [...plan.requeued, step.itemId] };
}

// ===== Section: Commute / listen playlist =====

/** Default per-clip estimate (seconds) when no manifest duration is known. */
const EST_CLIP_SEC = 1.2;

/** Duration estimator: manifest map first, silences parsed from their id, else 1.2 s (slow clips x1.8, they are 1.45-2x the normal clip). */
function makeDur(durations) {
  return (id) => {
    if (durations && durations[id] != null) return durations[id];
    const m = /^sys\.silence\.(\d+)$/.exec(id);
    if (m) return Number(m[1]) / 1000;
    return id.endsWith(".slow") ? EST_CLIP_SEC * 1.8 : EST_CLIP_SEC;
  };
}

/**
 * Plan a hands-free playlist of about `minutes` minutes.
 * @param {Object} args
 * @param {import("./curriculum.js").Curriculum} args.curriculum
 * @param {import("../state/progress.js").Progress} args.progress
 * @param {number} args.now
 * @param {() => number} args.rng
 * @param {number} [args.minutes=8]
 * @param {string} [args.unitId]
 * @param {Object<string, number>} [args.durations] clipId -> seconds (from audio manifest `dur`).
 * @returns {ListenPlan}
 */
export function planListenSession({ curriculum, progress, now, rng, minutes = 8, unitId, durations }) {
  const dur = makeDur(durations);
  const clipsSec = (clips) => clips.reduce((s, c) => s + dur(c), 0);
  const targetSec = minutes * 60;

  // --- segment builders (§7.4) ---
  const prompt = (id) => ({ kind: "prompt", refId: id, clips: [id] });
  const newSeg = (it) => ({ kind: "new", refId: it.id, clips: [
    `${it.id}.slow`, "sys.silence.1000", `${it.id}.en`, "sys.silence.500", it.id, "sys.silence.1500", it.id] });
  const reviewSeg = (it, first) => ({ kind: "review", refId: it.id, clips: [
    ...(first ? ["sys.whatMeans"] : []), it.id, "sys.silence.3000", `${it.id}.en`, "sys.silence.500", it.id] });
  const dialogueSeg = (d) => {
    const n = (d.lines || []).length;
    const ids = Array.from({ length: n }, (_, i) => `${d.id}.l${i + 1}`);
    return { kind: "dialogue", refId: d.id, clips: [
      ...ids.flatMap((c) => [c, "sys.silence.500", `${c}.en`]),
      "sys.again", ...ids] };
  };

  // --- candidates ---
  const scope = itemsInScope(curriculum, progress, unitId);
  const { unit: newUnit, items: allFresh } = nextNewItems(curriculum, progress, unitId);
  // WHY: cap new items by time so a long playlist is not all vocabulary firehose.
  const newCap = Math.min(MAX_NEW_LISTEN, Math.max(1, Math.floor(targetSec / LISTEN_SEC_PER_NEW)));
  const freshItems = allFresh.slice(0, newCap);
  const due = scope.filter((it) => isDue(cardOf(progress, it.id), now))
    .sort((a, b) => cardOf(progress, a.id).due - cardOf(progress, b.id).due);
  const dueIds = new Set(due.map((i) => i.id));
  // WHY: if little is due, revisit the weakest introduced items so a session is never empty.
  const extra = shuffle(scope.filter((it) => cardOf(progress, it.id).introduced && !dueIds.has(it.id)), rng)
    .sort((a, b) => cardOf(progress, a.id).box - cardOf(progress, b.id).box);
  // Self-test pool order: due items, then items introduced earlier in THIS
  // playlist (listen again and test yourself), then the weakest not-due items.
  const poolFor = (placedNew) => [...due, ...placedNew, ...extra];

  // Dialogue: prefer the new-items unit, else unitId, else the latest unit with introduced items.
  let dlgUnit = newUnit || (unitId ? curriculum.unit(unitId) : null);
  if (!dlgUnit) for (const u of curriculum.units) {
    if (progress.unlocked.includes(u.id) && curriculum.itemsOfUnit(u.id).some((i) => cardOf(progress, i.id).introduced)) dlgUnit = u;
  }
  const dlgCandidates = dlgUnit ? curriculum.dialoguesOfUnit(dlgUnit.id).filter((d) => (d.lines || []).length) : [];
  const dlg = dlgCandidates.length
    ? dlgCandidates.slice().sort((a, b) => ((progress.dialogues[a.id] || {}).heard || 0) - ((progress.dialogues[b.id] || {}).heard || 0))[0]
    : null;

  // --- budget ---
  const endSeg = prompt("sys.done");
  let used = clipsSec(endSeg.clips);
  const dlgSeg = dlg ? dialogueSeg(dlg) : null;
  const dlgCost = dlgSeg ? clipsSec(dlgSeg.clips) + dur("sys.dialogue") : 0;
  // WHY: a dialogue is only included if it fits in 35 % of the target, so a short
  // session is not swallowed by one long conversation.
  const useDialogue = dlgSeg && dlgCost <= targetSec * 0.35;
  if (useDialogue) used += dlgCost;

  const newSegs = [], revSegs = [];
  const budget = targetSec - used;
  let newSpent = dur("sys.newWords"), revSpent = dur("sys.review");
  let ni = 0;
  // New items get at most ~40 % of the budget; the self-test/review section
  // below takes whatever time is left.
  const newBudget = budget * 0.4;
  while (ni < freshItems.length) {
    const seg = newSeg(freshItems[ni]);
    const c = clipsSec(seg.clips);
    if (newSpent + c > newBudget && newSegs.length) break;
    if (newSpent + c > budget) break;
    newSegs.push(seg); newSpent += c; ni++;
  }
  // Only new items that actually made it into the playlist are self-tested.
  const reviewPool = poolFor(newSegs.map((g) => curriculum.items.get(g.refId)));
  // WHY: cycle the pool (reshuffled) when it is smaller than the time budget,
  // e.g. a brand-new learner who only has this playlist's new words to test.
  let full = false, firstReview = true;
  for (let round = 0; round < MAX_SELFTEST_ROUNDS && !full && reviewPool.length; round++) {
    const pool = round === 0 ? reviewPool : shuffle(reviewPool, rng);
    for (const it of pool) {
      const seg = reviewSeg(it, firstReview);
      const c = clipsSec(seg.clips);
      if (newSpent + revSpent + c > budget) { full = true; break; }
      revSegs.push(seg); revSpent += c; firstReview = false;
    }
  }

  const segments = [];
  if (newSegs.length) segments.push(prompt("sys.newWords"), ...newSegs);
  if (revSegs.length) segments.push(prompt("sys.review"), ...revSegs);
  if (useDialogue) segments.push(prompt("sys.dialogue"), dlgSeg);
  segments.push(endSeg);
  const estimatedSec = segments.reduce((s, g) => s + clipsSec(g.clips), 0);
  return { kind: "listen", segments, targetSec, estimatedSec };
}

/**
 * Flatten a listen plan to its clip id list (used for preloading and in tests).
 * @param {ListenPlan} plan
 * @returns {string[]}
 */
export function planClipIds(plan) {
  return plan.segments.flatMap((s) => s.clips);
}
