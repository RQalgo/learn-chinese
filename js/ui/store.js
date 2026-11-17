/**
 * store.js — the one mutable app state shared by all screens.
 *
 * Purpose
 *   Holds the loaded curriculum, audio clip table and the current progress
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
 *   - `store.clips` / `store.durations` are the EFFECTIVE clip table for the
 *     Mandarin accent in settings (data/clips.js). They are recomputed when
 *     `settings.accent` changes (no reload) and subscribers are told through
 *     onClipsChange() so the player can be re-pointed. `store.accent` is the
 *     accent really in use ("cn" while no Singapore clips exist).
 *   - `store.progress` is always the latest blob; never keep a stale copy in a
 *     screen across an await/answer.
 *   - Settings live inside progress.settings (so they travel with backups).
 *     UI-only settings the engine does not define (e.g. `autoAdvance`) are
 *     stored there too; storage.js preserves unknown keys.
 *
 * Public API
 *   APP_VERSION, store, initStore(), onClipsChange(), commit(), setProgress(),
 *   updateSettings(), getSetting(), newRng(), pinyinMode()
 */

import { loadProgress, saveProgress } from "../state/storage.js";
import { checkUnlocks } from "../state/progress.js";
import { effectiveClips } from "../data/clips.js";
import { makeRng } from "../engine/rng.js";
import { setSfxEnabled } from "../audio/sfx.js";

// ===== Section: State =====

/** App version shown in Settings. Keep in step with VERSION in sw.js when releasing. */
export const APP_VERSION = "1.1.0";

/**
 * @type {{curriculum: Object|null, clips: Object, durations: Object<string,number>,
 *         audioAvailable: boolean, accent: "sg"|"cn", sgAvailable: boolean,
 *         manifests: {cn: Object|null, sg: Object|null}, progress: Object|null}}
 */
export const store = {
  curriculum: null, clips: {}, durations: {}, audioAvailable: false,
  accent: "cn", sgAvailable: false, manifests: { cn: null, sg: null }, progress: null,
};

/** Subscribers called after the effective clip table changed. @type {Set<() => void>} */
const clipListeners = new Set();
/** The requested accent the current table was built for (to skip needless rebuilds). */
let builtFor = null;

/** Defaults for UI-only settings that progress.js does not know about. */
const UI_DEFAULTS = { autoAdvance: true };

// ===== Section: Init and persistence =====

/**
 * Rebuild store.clips / durations for the accent in settings and notify subscribers.
 * No-op when the requested accent is unchanged since the last build.
 */
function refreshClips() {
  const want = store.progress.settings.accent;
  if (want === builtFor) return;
  builtFor = want;
  // WHY: anything but "cn" means the default, "sg" (storage.js already repairs bad values).
  const r = effectiveClips(store.manifests.cn, store.manifests.sg, want === "cn" ? "cn" : "sg");
  store.clips = r.clips;
  store.durations = r.durations;
  store.accent = r.accent;
  store.sgAvailable = r.sgAvailable;
  store.audioAvailable = Object.keys(r.clips).length > 0;
  clipListeners.forEach((cb) => cb());
}

/**
 * Subscribe to effective-clip-table changes (accent switched).
 * @param {() => void} cb
 * @returns {() => void} Unsubscribe.
 */
export function onClipsChange(cb) { clipListeners.add(cb); return () => clipListeners.delete(cb); }

/**
 * Initialise the store from the loader result and saved progress.
 * @param {{curriculum: Object, manifests: {cn: Object|null, sg: Object|null}}} content
 */
export function initStore({ curriculum, manifests }) {
  store.curriculum = curriculum;
  store.manifests = manifests;
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
  refreshClips();
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
