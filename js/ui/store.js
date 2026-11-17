/**
 * store.js — the one mutable app state shared by all screens.
 *
 * Purpose
 *   Holds the loaded curriculum, audio manifest data and the current progress
 *   blob, and is the single place that saves progress. The engine and
 *   state/progress.js are pure and return NEW blobs; screens hand those to
 *   commit() so persistence and settings side effects cannot be forgotten.
 *
 * How it fits
 *   main.js calls initStore() after the loader finishes. Every screen reads
 *   `store.*` and calls commit()/updateSettings(). Calls state/storage.js
 *   (saveProgress), state/progress.js (checkUnlocks) and audio/sfx.js.
 *   This file is UI-side glue; it is not part of the engine layer.
 *
 * Key concepts
 *   - `store.progress` is always the latest blob; never keep a stale copy in a
 *     screen across an await/answer.
 *   - Settings live inside progress.settings (so they travel with backups).
 *     UI-only settings the engine does not define (e.g. `autoAdvance`) are
 *     stored there too; storage.js preserves unknown keys.
 *
 * Public API
 *   APP_VERSION, store, initStore(), commit(), setProgress(), updateSettings(),
 *   getSetting(), newRng(), pinyinMode()
 */

import { loadProgress, saveProgress } from "../state/storage.js";
import { checkUnlocks } from "../state/progress.js";
import { makeRng } from "../engine/rng.js";
import { setSfxEnabled } from "../audio/sfx.js";

// ===== Section: State =====

/** App version shown in Settings. Keep in step with VERSION in sw.js when releasing. */
export const APP_VERSION = "1.0.0";

/**
 * @type {{curriculum: Object|null, clips: Object, durations: Object<string,number>,
 *         audioAvailable: boolean, progress: Object|null}}
 */
export const store = { curriculum: null, clips: {}, durations: {}, audioAvailable: false, progress: null };

/** Defaults for UI-only settings that progress.js does not know about. */
const UI_DEFAULTS = { autoAdvance: true };

// ===== Section: Init and persistence =====

/**
 * Initialise the store from the loader result and saved progress.
 * @param {{curriculum: Object, clips: Object, durations: Object<string,number>}} content
 */
export function initStore({ curriculum, clips, durations }) {
  store.curriculum = curriculum;
  store.clips = clips;
  store.durations = durations;
  store.audioAvailable = Object.keys(clips).length > 0;
  let p = loadProgress(undefined, Date.now());
  // WHY: repair `unlocked` against the real curriculum (first unit always open,
  // units whose predecessor reached 70 % open) in case content changed.
  p = checkUnlocks(p, curriculum).progress;
  setProgress(p);
}

/**
 * Replace the progress blob and persist it.
 * @param {Object} progress
 */
export function setProgress(progress) {
  store.progress = progress;
  saveProgress(progress);
  setSfxEnabled(progress.settings.sfx !== false);
}

/**
 * Accept the envelope returned by a progress.js apply* function.
 * @template T
 * @param {{progress: Object, xpGained: number, events: Object[]} & T} result
 * @returns {{progress: Object, xpGained: number, events: Object[]} & T} The same envelope, for chaining.
 */
export function commit(result) {
  setProgress(result.progress);
  return result;
}

/**
 * Merge changes into settings and save.
 * @param {Object} patch
 */
export function updateSettings(patch) {
  setProgress({ ...store.progress, settings: { ...store.progress.settings, ...patch } });
}

/**
 * Read a setting with UI defaults applied.
 * @param {string} key
 * @returns {any}
 */
export function getSetting(key) {
  const v = store.progress.settings[key];
  return v === undefined ? UI_DEFAULTS[key] : v;
}

/**
 * Pinyin display mode: "always" | "after" | "never".
 * @returns {"always"|"after"|"never"}
 */
export function pinyinMode() {
  const v = store.progress.settings.pinyin;
  return v === "after" || v === "never" ? v : "always";
}

/**
 * Fresh seeded rng (engine functions never call Math.random).
 * @param {number} [salt=0] Mixed into the clock so two rngs made in the same ms differ.
 * @returns {() => number}
 */
export function newRng(salt = 0) {
  return makeRng((Date.now() ^ (salt * 2654435761)) | 0);
}
