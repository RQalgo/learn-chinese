/**
 * loader.js — fetch all lesson content and build the Curriculum.
 *
 * Purpose
 *   Step 1 at boot: data/units.json, then every unit file in parallel, then the
 *   (optional) audio manifests. Returns a ready Curriculum plus the raw
 *   Mainland and Singapore manifests; ui/store.js turns them into the effective
 *   clip table for the chosen accent (data/clips.js).
 *
 * How it fits
 *   main.js calls loadContent() and shows an error screen if it throws. The
 *   result goes to ui/store.js and audio/player.js. Calls
 *   engine/curriculum.js (buildCurriculum). All URLs are relative so the site
 *   works under a sub-path such as /learn-chinese/.
 *
 * Key concepts
 *   - Both audio manifests are optional: before audio is generated they 404, and
 *     they may be partial. A missing one is `null`; the player then falls back
 *     to speechSynthesis per missing clip. The Singapore manifest
 *     (`audio-sg/manifest.json`) usually 404s until that set is generated.
 *   - `data/pinyin-sg.json` (Singapore pinyin for display, data/pinyinSg.js) is optional
 *     too: a 404 gives `{}` and the content pinyin is shown.
 *   - A single failing unit file does not abort boot: that unit is passed on
 *     as missing and the curriculum marks it `available: false`.
 *     A failing units.json is fatal (nothing to show).
 *
 * Public API
 *   loadContent() -> Promise<{curriculum, manifests: {cn, sg}, pinyinSg, failedUnits}>
 */

import { buildCurriculum } from "../engine/curriculum.js";
import { normalizePinyinSg } from "./pinyinSg.js";

// ===== Section: Fetch helpers =====

/**
 * Fetch JSON, throwing a readable error on HTTP or parse failure.
 * @param {string} url Relative URL.
 * @returns {Promise<any>}
 */
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// ===== Section: Public API =====

/**
 * Load everything the app needs.
 * @returns {Promise<{curriculum: import("../engine/curriculum.js").Curriculum,
 *   manifests: {cn: Object|null, sg: Object|null}, pinyinSg: Object<string, string>, failedUnits: string[]}>}
 * @throws {Error} When units.json (or every unit file) cannot be loaded.
 */
export async function loadContent() {
  const index = await getJson("data/units.json");
  const units = index.units || [];

  // WHY: all unit files and the audio manifests are independent, so fetch them concurrently
  // (matters on a slow mobile connection).
  const [unitResults, cnManifest, sgManifest, pinyinSg] = await Promise.all([
    Promise.all(units.map(async (u) => {
      try { return { id: u.id, file: await getJson(u.file) }; }
      catch (e) { console.warn("unit failed to load:", u.id, e.message); return { id: u.id, file: null }; }
    })),
    getJson("audio/manifest.json").catch(() => null),
    getJson("audio-sg/manifest.json").catch(() => null),
    getJson("data/pinyin-sg.json").then(normalizePinyinSg).catch(() => ({})),
  ]);

  const unitFiles = {};
  const failedUnits = [];
  for (const r of unitResults) { if (r.file) unitFiles[r.id] = r.file; else failedUnits.push(r.id); }
  if (units.length && !Object.keys(unitFiles).length) throw new Error("None of the lesson files could be loaded.");

  return { curriculum: buildCurriculum(index, unitFiles), manifests: { cn: cnManifest, sg: sgManifest }, pinyinSg, failedUnits };
}
