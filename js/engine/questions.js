/**
 * questions.js — builds one concrete question (prompt, options, answer index).
 *
 * Purpose
 *   Session plans only say "ask item X as qtype Y" (ARCHITECTURE §7.2). This
 *   module turns that into the data the quiz screen renders, picking plausible
 *   but never-also-correct distractors (§7.3).
 *
 * How it fits
 *   session.js calls chooseQtype() while planning; ui/quiz.js calls
 *   makeQuestion() / makeDialogueQuestion() lazily when a step is reached (so
 *   option order is fresh on a re-queued question). Uses srs.js (box) and
 *   rng.js. Pure.
 *
 * Key concepts
 *   - qtypes: listen-meaning, meaning-audio, true-false, dialogue.
 *   - Distractor ranking: same item type first, then nearest units (same unit
 *     = distance 0); within a rank, introduced items are preferred (so the
 *     learner is not just guessing between words never met) and ties are
 *     shuffled.
 *   - Exclusion: a candidate is dropped if its english/alt overlaps the
 *     answer's english/alt (case-insensitive) or its label duplicates one
 *     already chosen.
 *   - Graceful fallback: small pools give fewer options; if fewer than 2
 *     options are possible, the question degrades (meaning-audio ->
 *     listen-meaning -> true-false with a true statement).
 *
 * Public API
 *   QTYPES
 *   chooseQtype(item, card, rng)                                 -> qtype
 *   makeQuestion(qtype, itemId, curriculum, progress, rng)       -> Question
 *   makeDialogueQuestion(questionId, curriculum, rng)            -> Question
 *   pickDistractors(item, curriculum, progress, rng, count, labelOf?) -> Item[]
 */

import { shuffle } from "./rng.js";

// ===== Section: Types =====

/**
 * @typedef {Object} Option
 * @property {string} label        Text shown on the button.
 * @property {string} [clip]       Audio clip played when the option is tapped (meaning-audio).
 * @property {string} [itemId]     Item the option stands for (when it maps to one).
 */

/**
 * @typedef {Object} Question
 * @property {"listen-meaning"|"meaning-audio"|"true-false"|"dialogue"} qtype
 * @property {string} itemId        Item id (dialogue: the dialogue question id).
 * @property {{clip?: string, text?: string, clips?: string[], questionClip?: string}} prompt
 *   `clip` = single clip to autoplay; dialogue questions use `clips` (all lines
 *   in order) and `questionClip` (the English question), `text` = question text.
 * @property {Option[]} options
 * @property {number} answerIndex   Index into options of the correct one.
 * @property {boolean} [isTrue]     true-false only: whether the statement shown is true.
 * @property {string} [shownItemId] true-false only: item whose English is shown.
 * @property {string} [dialogueId]  dialogue only.
 */

// ===== Section: Constants =====

/** All question types. */
export const QTYPES = ["listen-meaning", "meaning-audio", "true-false", "dialogue"];

/** Probability of meaning-audio when eligible (word/phrase, box >= 2). */
const P_MEANING_AUDIO = 0.3;
/** Probability of true-false when eligible (box >= 1). */
const P_TRUE_FALSE = 0.3;

// ===== Section: Choosing a qtype =====

/**
 * Choose a question type for an item given its card.
 * WHY: listen-meaning is the easiest (recognition from audio), so it is the
 * default and the only type for brand-new cards. Harder reverse
 * (meaning-audio) needs the learner to discriminate three Chinese clips, which
 * is unfair for long sentences, so it is limited to word/phrase at box >= 2.
 * @param {import("./curriculum.js").Item} item
 * @param {import("./srs.js").Card} card
 * @param {() => number} rng
 * @returns {"listen-meaning"|"meaning-audio"|"true-false"} Never "dialogue".
 */
export function chooseQtype(item, card, rng) {
  const r = rng(); // single draw: ranges below partition [0,1)
  let acc = 0;
  if (card.box >= 2 && (item.type === "word" || item.type === "phrase")) {
    acc += P_MEANING_AUDIO;
    if (r < acc) return "meaning-audio";
  }
  if (card.box >= 1) {
    acc += P_TRUE_FALSE;
    if (r < acc) return "true-false";
  }
  return "listen-meaning";
}

// ===== Section: Distractor selection =====

const norm = (s) => String(s).trim().toLowerCase();
/** Set of normalised acceptable meanings for an item. */
const meaningSet = (item) => new Set([item.english, ...(item.alt || [])].map(norm));

/**
 * Could `cand` also be a correct answer for `answer`?
 * @param {import("./curriculum.js").Item} answer
 * @param {import("./curriculum.js").Item} cand
 * @returns {boolean}
 */
function overlapsMeaning(answer, cand) {
  const a = meaningSet(answer);
  for (const m of meaningSet(cand)) if (a.has(m)) return true;
  return false;
}

/**
 * Pick distractor items for an answer item.
 * @param {import("./curriculum.js").Item} item The correct item.
 * @param {import("./curriculum.js").Curriculum} curriculum
 * @param {import("../state/progress.js").Progress|null} progress Used only to prefer introduced items; may be null.
 * @param {() => number} rng
 * @param {number} count How many are wanted (fewer may be returned).
 * @param {(it: import("./curriculum.js").Item) => string} [labelOf]
 *   Label used for the no-duplicates rule (default: english).
 * @returns {import("./curriculum.js").Item[]}
 */
export function pickDistractors(item, curriculum, progress, rng, count, labelOf = (i) => i.english) {
  const cards = (progress && progress.cards) || {};
  const answerLabel = norm(labelOf(item));
  // Rank every other item: [typeRank, unitDistance, notIntroduced].
  const ranked = [];
  for (const cand of curriculum.items.values()) {
    if (cand.id === item.id) continue;
    ranked.push({
      cand,
      key: [
        cand.type === item.type ? 0 : 1,
        Math.abs(cand.unitOrder - item.unitOrder),
        cards[cand.id] && cards[cand.id].introduced ? 0 : 1,
      ],
    });
  }
  // WHY: shuffle first, then stable-sort by key, so ties are random but the
  // ranking is respected (Array.prototype.sort is stable in modern engines).
  const ordered = shuffle(ranked, rng).sort((x, y) =>
    x.key[0] - y.key[0] || x.key[1] - y.key[1] || x.key[2] - y.key[2]);

  const out = [];
  const seen = new Set([answerLabel]);
  for (const { cand } of ordered) {
    if (out.length >= count) break;
    if (overlapsMeaning(item, cand)) continue;
    const label = norm(labelOf(cand));
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(cand);
  }
  return out;
}

// ===== Section: Item questions =====

/** Shuffle options and locate the correct one. */
function finish(qtype, itemId, prompt, correctOpt, wrongOpts, rng, extra = {}) {
  const options = shuffle([correctOpt, ...wrongOpts], rng);
  return { qtype, itemId, prompt, options, answerIndex: options.indexOf(correctOpt), ...extra };
}

/**
 * Build a question for an item.
 * @param {"listen-meaning"|"meaning-audio"|"true-false"} qtype
 * @param {string} itemId
 * @param {import("./curriculum.js").Curriculum} curriculum
 * @param {import("../state/progress.js").Progress|null} progress
 * @param {() => number} rng
 * @returns {Question}
 * @throws {Error} When the item id is unknown.
 */
export function makeQuestion(qtype, itemId, curriculum, progress, rng) {
  const item = curriculum.items.get(itemId);
  if (!item) throw new Error(`makeQuestion: unknown item "${itemId}"`);

  if (qtype === "meaning-audio") {
    // Options are labelled by pinyin; also unique by hanzi via the same label rule.
    const wrong = pickDistractors(item, curriculum, progress, rng, 2, (i) => i.pinyin);
    if (wrong.length >= 1) {
      const correct = { label: item.pinyin, clip: item.id, itemId: item.id };
      return finish("meaning-audio", item.id, { text: item.english }, correct,
        wrong.map((w) => ({ label: w.pinyin, clip: w.id, itemId: w.id })), rng);
    }
    qtype = "listen-meaning"; // WHY: tiny pool; degrade rather than fail.
  }

  if (qtype === "listen-meaning") {
    const wrong = pickDistractors(item, curriculum, progress, rng, 3);
    if (wrong.length >= 1) {
      const correct = { label: item.english, itemId: item.id };
      return finish("listen-meaning", item.id, { clip: item.id }, correct,
        wrong.map((w) => ({ label: w.english, itemId: w.id })), rng);
    }
    qtype = "true-false"; // no distractor at all: can only state something true
  }

  if (qtype === "true-false") {
    const wrong = pickDistractors(item, curriculum, progress, rng, 1);
    // WHY: with no usable distractor the statement must be true; the question
    // is still valid, just not 50/50.
    const isTrue = wrong.length === 0 || rng() < 0.5;
    const shown = isTrue ? item : wrong[0];
    return {
      qtype: "true-false", itemId: item.id,
      prompt: { clip: item.id, text: shown.english },
      options: [{ label: "✓" }, { label: "✗" }],
      answerIndex: isTrue ? 0 : 1,
      isTrue, shownItemId: shown.id,
    };
  }

  throw new Error(`makeQuestion: unsupported qtype "${qtype}"`);
}

// ===== Section: Dialogue questions =====

/**
 * Build a dialogue comprehension question.
 * Distractors come from the content file itself (authored per question).
 * @param {string} questionId e.g. "u01-d01-q1"
 * @param {import("./curriculum.js").Curriculum} curriculum
 * @param {() => number} rng
 * @returns {Question} qtype "dialogue"; prompt.clips lists every line's clip in order.
 * @throws {Error} When the question id is unknown.
 */
export function makeDialogueQuestion(questionId, curriculum, rng) {
  const q = curriculum.questions.get(questionId);
  if (!q) throw new Error(`makeDialogueQuestion: unknown question "${questionId}"`);
  const d = curriculum.dialogues.get(q.dialogueId);
  const clips = (d.lines || []).map((_, i) => `${d.id}.l${i + 1}`);
  const seen = new Set([norm(q.answer)]);
  const wrong = [];
  for (const text of shuffle(q.distractors || [], rng)) {
    if (wrong.length >= 3) break;
    if (seen.has(norm(text))) continue; // never duplicate the answer or another option
    seen.add(norm(text));
    wrong.push({ label: text });
  }
  return finish("dialogue", q.id, { clips, text: q.question, questionClip: q.clip },
    { label: q.answer }, wrong, rng, { dialogueId: d.id });
}
