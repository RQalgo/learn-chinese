/**
 * altvoice.js — choose a "quiz voice" clip for an item (`<itemId>.alt1` .. `.alt3`).
 *
 * Purpose
 *   The learning voice of an item (its primary clip `<itemId>`, used by the intro, the unit
 *   page and the commute "new word" segments) differs from the voices the quiz and the commute
 *   self-test use, so the learner cannot answer by recognising one speaker (ARCHITECTURE §5,
 *   §7.3, §7.4). Each item has up to three alternative voices: the other voices of the audio
 *   engine, in a stable order (docs/AUDIO.md "Voice variants").
 *
 * How it fits
 *   Pure (rng is passed in). engine/questions.js and engine/session.js call pickAltClip().
 *   The player resolves a missing alt back to the primary clip (data/clips.js resolveClipId),
 *   so this module may be optimistic when it does not know which clips exist.
 *
 * Public API
 *   ALT_COUNT, altClipIds(itemId), pickAltClip(itemId, rng, available?)
 */

/** Most alternative voices an item can have (a Kokoro item has 4 voices: 1 primary + 3 alts). */
export const ALT_COUNT = 3;

/**
 * The alt clip ids of an item, in voice order.
 * @param {string} itemId
 * @returns {string[]} `["<id>.alt1", "<id>.alt2", "<id>.alt3"]`
 */
export function altClipIds(itemId) {
  return Array.from({ length: ALT_COUNT }, (_, i) => `${itemId}.alt${i + 1}`);
}

/**
 * Pick a random alternative-voice clip for an item; NEVER the primary voice unless no alt exists.
 * @param {string} itemId
 * @param {() => number} rng Injected random source (a seeded rng gives the same pick).
 * @param {Object<string, any>|null} [available] The effective clip table (or any map keyed by clip id).
 *   When given, only alts present in it are candidates and the primary id is returned if there are none
 *   (old audio sets, or engines with fewer voices). When omitted, all alts are candidates and the
 *   player's fallback (resolveClipId) covers a missing file.
 * @returns {string} `<id>.altK`, or `<id>` as the fallback.
 */
export function pickAltClip(itemId, rng, available = null) {
  const alts = altClipIds(itemId).filter((id) => !available || (available[id] && available[id].src !== ""));
  if (!alts.length) return itemId;
  return alts[Math.min(alts.length - 1, Math.floor(rng() * alts.length))];
}
