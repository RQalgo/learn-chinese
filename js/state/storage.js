/**
 * storage.js — load / save / migrate / export / import of the progress blob.
 *
 * Purpose
 *   The only impure module in state/: it talks to localStorage. Everything it
 *   returns is plain data that progress.js can work on.
 *
 * How it fits
 *   main.js calls loadProgress() at boot; the UI calls saveProgress() after each
 *   answer/session; settings.js calls exportProgress() / importProgress().
 *   Uses defaultProgress() and DEFAULT_SETTINGS from progress.js. The storage
 *   object is injectable (any {getItem,setItem,removeItem}) so Node tests can
 *   pass an in-memory fake.
 *
 * Key concepts
 *   - Key: "tingProgress.v1". The "v1" is the storage-key generation; the blob's
 *     own `version` field drives migrate().
 *   - migrate(): a chain of steps MIGRATIONS[n] upgrading version n -> n+1.
 *     Version 1 is current, so the chain is empty today; add a step when
 *     bumping CURRENT_VERSION.
 *   - A corrupt stored blob is never silently destroyed: it is copied to
 *     "<key>.corrupt" before a fresh progress is returned.
 *
 * Public API
 *   STORAGE_KEY, CURRENT_VERSION
 *   loadProgress(storage?, now) -> Progress
 *   saveProgress(progress, storage?) -> boolean
 *   exportProgress(progress) -> string (JSON)
 *   importProgress(json) -> Progress   (throws Error with a helpful message)
 *   migrate(blob) -> Progress
 *   validateProgress(blob) -> string[] (problems; empty = valid)
 */

import { defaultProgress, DEFAULT_SETTINGS } from "./progress.js";

// ===== Section: Constants =====

export const STORAGE_KEY = "tingProgress.v1";
export const CURRENT_VERSION = 1;

/**
 * Migration steps keyed by the version they upgrade FROM.
 * Example for the future: `1: (b) => ({ ...b, version: 2, newField: {} })`.
 * @type {Object<number, (blob: Object) => Object>}
 */
const MIGRATIONS = {};

// ===== Section: Migration and validation =====

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Upgrade an old blob to the current version and fill missing optional parts.
 * @param {Object} blob Parsed JSON of any known version.
 * @returns {import("./progress.js").Progress} A new object; the input is not mutated.
 * @throws {Error} When the blob is not an object, has no numeric version, or is from a newer app.
 */
export function migrate(blob) {
  if (!isObj(blob)) throw new Error("Progress data must be a JSON object.");
  if (!isNum(blob.version)) throw new Error("Progress data has no numeric \"version\" field - is this a Ting backup file?");
  if (blob.version > CURRENT_VERSION) {
    throw new Error(`Progress data is version ${blob.version}, but this app only understands up to ${CURRENT_VERSION}. Update the app first.`);
  }
  let b = { ...blob };
  while (b.version < CURRENT_VERSION) {
    const step = MIGRATIONS[b.version];
    if (!step) throw new Error(`No migration available from version ${b.version}.`);
    b = step(b);
  }
  // WHY: backups made by older/hand-edited files may lack sections; defaulting
  // them here keeps every other module free of "might be undefined" checks.
  const d = defaultProgress(isNum(b.createdAt) ? b.createdAt : 0);
  return {
    ...d, ...b,
    cards: isObj(b.cards) ? b.cards : {},
    dialogues: isObj(b.dialogues) ? b.dialogues : {},
    daily: isObj(b.daily) ? b.daily : {},
    unlocked: Array.isArray(b.unlocked) && b.unlocked.length ? b.unlocked : d.unlocked,
    streak: { ...d.streak, ...(isObj(b.streak) ? b.streak : {}) },
    settings: { ...DEFAULT_SETTINGS, ...(isObj(b.settings) ? b.settings : {}) },
  };
}

/**
 * Check a (migrated) progress blob for structural problems.
 * @param {Object} p
 * @returns {string[]} Human-readable problems; empty when valid.
 */
export function validateProgress(p) {
  const bad = [];
  if (!isObj(p)) return ["not an object"];
  if (p.version !== CURRENT_VERSION) bad.push(`version must be ${CURRENT_VERSION}`);
  if (!isNum(p.createdAt)) bad.push("createdAt must be a number");
  if (!isNum(p.xp) || p.xp < 0) bad.push("xp must be a non-negative number");
  if (!isObj(p.cards)) bad.push("cards must be an object");
  else {
    for (const [id, c] of Object.entries(p.cards)) {
      if (!isObj(c) || !isNum(c.box) || c.box < 0 || c.box > 6 || !Number.isInteger(c.box)) { bad.push(`card ${id}: box must be an integer 0-6`); break; }
      if (!isNum(c.due) || typeof c.introduced !== "boolean" || !isNum(c.seen) || !isNum(c.correct) || !isNum(c.wrong) || !isNum(c.lastSeen)) { bad.push(`card ${id}: malformed fields`); break; }
    }
  }
  if (!isObj(p.dialogues)) bad.push("dialogues must be an object");
  if (!Array.isArray(p.unlocked) || p.unlocked.some((u) => typeof u !== "string")) bad.push("unlocked must be an array of unit ids");
  if (!isObj(p.daily)) bad.push("daily must be an object");
  else {
    for (const [k, d] of Object.entries(p.daily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !isObj(d) || !isNum(d.xp) || !isNum(d.answered) || !isNum(d.correct)) { bad.push(`daily entry "${k}" is malformed`); break; }
    }
  }
  if (!isObj(p.streak) || !isNum(p.streak.current) || !isNum(p.streak.best)) bad.push("streak is malformed");
  if (!isObj(p.settings) || !isNum(p.settings.dailyGoalXp) || p.settings.dailyGoalXp <= 0) bad.push("settings.dailyGoalXp must be a positive number");
  return bad;
}

// ===== Section: Export / import =====

/**
 * Serialise progress for the backup file.
 * @param {import("./progress.js").Progress} progress
 * @returns {string} Pretty-printed JSON.
 */
export function exportProgress(progress) {
  return JSON.stringify(progress, null, 2);
}

/**
 * Parse and validate a backup.
 * @param {string} json File contents.
 * @returns {import("./progress.js").Progress}
 * @throws {Error} With a message the settings screen can show directly.
 */
export function importProgress(json) {
  let blob;
  try { blob = JSON.parse(json); } catch (e) { throw new Error("That file is not valid JSON, so it cannot be a Ting backup."); }
  const p = migrate(blob);
  const problems = validateProgress(p);
  if (problems.length) throw new Error(`Backup data is invalid: ${problems.join("; ")}.`);
  return p;
}

// ===== Section: localStorage access =====

/** @returns {Storage|null} The global localStorage if usable. */
function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; } // WHY: access can throw in locked-down browsers
}

/**
 * Load saved progress, or a fresh blob when nothing (valid) is stored.
 * @param {{getItem:Function,setItem:Function}} [storage] Defaults to localStorage.
 * @param {number} now Epoch ms, used as createdAt for a fresh blob.
 * @returns {import("./progress.js").Progress}
 */
export function loadProgress(storage = defaultStorage(), now = 0) {
  if (!storage) return defaultProgress(now);
  let raw = null;
  try { raw = storage.getItem(STORAGE_KEY); } catch { return defaultProgress(now); }
  if (raw == null) return defaultProgress(now);
  try {
    return importProgress(raw);
  } catch {
    // WHY: keep the unreadable data so it can be recovered by hand, instead of
    // overwriting it with an empty blob on the next save.
    try { storage.setItem(`${STORAGE_KEY}.corrupt`, raw); } catch { /* ignore */ }
    return defaultProgress(now);
  }
}

/**
 * Persist progress.
 * @param {import("./progress.js").Progress} progress
 * @param {{setItem:Function}} [storage] Defaults to localStorage.
 * @returns {boolean} False if the write failed (quota, private mode).
 */
export function saveProgress(progress, storage = defaultStorage()) {
  if (!storage) return false;
  try { storage.setItem(STORAGE_KEY, JSON.stringify(progress)); return true; } catch { return false; }
}
