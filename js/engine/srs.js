/**
 * srs.js — spaced-repetition card state (Leitner boxes), ARCHITECTURE §7.1.
 *
 * Purpose
 *   Decide when an item should be asked again. A "card" is the per-item record
 *   stored in progress.cards[itemId].
 *
 * How it fits
 *   Called by state/progress.js (applyIntro / applyAnswer / applyListen) and by
 *   engine/session.js (isDue, status) and engine/questions.js (box -> qtype).
 *   Pure: `now` (ms since epoch) is always passed in; objects are never mutated.
 *
 * Key concepts
 *   - Boxes 0..6. A correct answer moves up one box and schedules the card
 *     INTERVAL_DAYS[newBox] days ahead. A wrong answer drops to box <= 1 and the
 *     card is due immediately so the session can re-ask it.
 *   - Status buckets: new (not introduced) / learning (box 0-2) /
 *     familiar (box 3-4) / mastered (box 5-6).
 *
 * Public API
 *   INTERVAL_DAYS, DAY_MS, MAX_BOX
 *   newCard()                    -> Card
 *   introduce(card, now)         -> Card
 *   review(card, correct, now)   -> Card
 *   status(card)                 -> "new"|"learning"|"familiar"|"mastered"
 *   isDue(card, now)             -> boolean
 */

// ===== Section: Types =====

/**
 * @typedef {Object} Card
 * @property {number} box        Leitner box 0..6.
 * @property {number} due        Epoch ms when the card is next due (0 = never scheduled).
 * @property {boolean} introduced True once the learner has heard the item introduced.
 * @property {number} seen       Times asked/heard.
 * @property {number} correct    Correct answers.
 * @property {number} wrong      Wrong answers.
 * @property {number} lastSeen   Epoch ms of the last interaction (0 = never).
 */

// ===== Section: Constants =====

/** Days until next review, indexed by the box the card has just entered. */
export const INTERVAL_DAYS = [0, 1, 2, 4, 8, 16, 32];
/** Milliseconds in one day (fixed 24h; DST drift is irrelevant for SRS gaps). */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Highest box number. */
export const MAX_BOX = INTERVAL_DAYS.length - 1;

// ===== Section: Transitions =====

/**
 * Create a fresh, un-introduced card.
 * @returns {Card}
 */
export function newCard() {
  return { box: 0, due: 0, introduced: false, seen: 0, correct: 0, wrong: 0, lastSeen: 0 };
}

/**
 * Mark a card as introduced (the learner has been shown/heard the item).
 * Box stays 0 and the card becomes due now so it is asked soon.
 * @param {Card} card
 * @param {number} now Epoch ms.
 * @returns {Card} New card object.
 */
export function introduce(card, now) {
  return { ...card, introduced: true, due: now };
}

/**
 * Apply an answer.
 * WHY: the interval is looked up with the NEW box, so a first correct answer
 * (0 -> 1) is due in 1 day, not "now" (INTERVAL_DAYS[0] is 0).
 * @param {Card} card
 * @param {boolean} correct
 * @param {number} now Epoch ms.
 * @returns {Card} New card object with updated counters.
 */
export function review(card, correct, now) {
  const base = { ...card, seen: card.seen + 1, lastSeen: now };
  if (correct) {
    const box = Math.min(card.box + 1, MAX_BOX);
    return { ...base, box, due: now + INTERVAL_DAYS[box] * DAY_MS, correct: card.correct + 1 };
  }
  return { ...base, box: Math.min(card.box, 1), due: now, wrong: card.wrong + 1 };
}

// ===== Section: Queries =====

/**
 * Bucket a card for display and statistics.
 * @param {Card} card
 * @returns {"new"|"learning"|"familiar"|"mastered"}
 */
export function status(card) {
  if (!card.introduced) return "new";
  if (card.box <= 2) return "learning";
  if (card.box <= 4) return "familiar";
  return "mastered";
}

/**
 * Is the card introduced and due at `now`?
 * @param {Card} card
 * @param {number} now Epoch ms.
 * @returns {boolean}
 */
export function isDue(card, now) {
  return card.introduced && card.due <= now;
}
