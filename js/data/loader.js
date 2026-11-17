/**
 * loader.js — fetch all lesson content and build the Curriculum.
 *
 * Purpose
 *   Step 1 at boot: data/units.json, then every unit file in parallel, then the
 *   (optional) audio manifest. Returns a ready Curriculum plus the audio clip
 *   table and a clip-id -> seconds map used for commute planning.
 *
 * How it fits
 *   main.js calls loadContent() and shows an error screen if it throws. The
 *   result goes to ui/store.js and audio/player.js. Calls
 *   engine/curriculum.js (buildCurriculum). All URLs are relative so the site
 *   works under a sub-path such as /learn-chinese/.
 *
 * Key concepts
 *   - The audio manifest is optional: before audio is generated it 404s, and
 *     it may be partial. Both cases give an empty/partial `clips` map; the
 *     player then falls back to speechSynthesis per missing clip.
 *   - A single failing unit file does not abort boot: that unit is passed on
 *     as missing and the curriculum marks it `available: false`.
 *     A failing units.json is fatal (nothing to show).
 *
 * Public API
 *   loadContent() -> Promise<{curriculum, clips, durations, failedUnits}>
 */

import { buildCurriculum } from "../engine/curriculum.js";

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
 *   clips: Object<string, {src: string, dur: number}>, durations: Object<string, number>,
 *   failedUnits: string[]}>}
 * @throws {Error} When units.json (or every unit file) cannot be loaded.
 */
export async function loadContent() {
  const index = await getJson("data/units.json");
  const units = index.units || [];

  // WHY: all unit files and the audio manifest are independent, so fetch them concurrently
  // (matters on a slow mobile connection).
  const [unitResults, manifest] = await Promise.all([
    Promise.all(units.map(async (u) => {
      try { return { id: u.id, file: await getJson(u.file) }; }
      catch (e) { console.warn("unit failed to load:", u.id, e.message); return { id: u.id, file: null }; }
    })),
    getJson("audio/manifest.json").catch(() => null),
  ]);

  const unitFiles = {};
  const failedUnits = [];
  for (const r of unitResults) { if (r.file) unitFiles[r.id] = r.file; else failedUnits.push(r.id); }
  if (units.length && !Object.keys(unitFiles).length) throw new Error("None of the lesson files could be loaded.");

  const clips = (manifest && manifest.clips && typeof manifest.clips === "object") ? manifest.clips : {};
  const durations = {};
  for (const [id, c] of Object.entries(clips)) if (c && typeof c.dur === "number") durations[id] = c.dur;

  return { curriculum: buildCurriculum(index, unitFiles), clips, durations, failedUnits };
}
