/**
 * clips.js — pick the effective audio clip table for the chosen Mandarin accent.
 *
 * Purpose
 *   Merge the two audio manifests (Mainland `audio/manifest.json`, Singapore
 *   `audio-sg/manifest.json`) into the single `{clipId: {src, dur}}` table the
 *   player, the commute planner and the offline download use (ARCHITECTURE §5).
 *
 * How it fits
 *   Pure (no fetch, no DOM). data/loader.js fetches the manifests; ui/store.js
 *   calls effectiveClips() at boot and whenever settings.accent changes, then
 *   hands the result to audio/player.js.
 *
 * Key concepts
 *   - The Mainland manifest is the base and owns every English (`.en`) and
 *     `sys.*` clip; the Singapore manifest only ever holds Mandarin clips.
 *   - For accent "sg", a Mandarin clip uses its Singapore entry when it has one
 *     and otherwise falls back to the Mainland entry, so a partial Singapore set
 *     still plays everything.
 *   - If the Singapore manifest has no usable Mandarin clip at all, the
 *     effective accent is "cn" (Settings shows Singapore as "coming soon").
 *
 * Public API
 *   isMandarinClip(id), manifestClips(manifest), effectiveClips(cn, sg, accent)
 */

// ===== Section: Helpers =====

/**
 * Is this clip id a Mandarin clip (the only kind the Singapore set may hold)?
 * WHY by id: the clip-id grammar (§5) already separates languages: English clips
 * end in `.en` and prompts start with `sys.`; everything else is Mandarin.
 * @param {string} id
 * @returns {boolean}
 */
export function isMandarinClip(id) {
  return !id.startsWith("sys.") && !id.endsWith(".en");
}

/** A usable manifest entry has a string `src`. */
const usable = (e) => !!e && typeof e === "object" && typeof e.src === "string" && e.src !== "";

/**
 * Safely read the `clips` map of a manifest (null/garbage gives `{}`).
 * @param {any} manifest Parsed manifest JSON or null.
 * @returns {Object<string, {src: string, dur?: number}>}
 */
export function manifestClips(manifest) {
  return (manifest && manifest.clips && typeof manifest.clips === "object") ? manifest.clips : {};
}

// ===== Section: Public API =====

/**
 * Build the clip table for an accent.
 * @param {any} cnManifest Parsed `audio/manifest.json` (or null).
 * @param {any} sgManifest Parsed `audio-sg/manifest.json` (or null: missing/404).
 * @param {"sg"|"cn"} accent The accent the learner asked for.
 * @returns {{clips: Object<string, {src: string, dur: number}>, durations: Object<string, number>,
 *   accent: "sg"|"cn", sgAvailable: boolean}} `accent` is the EFFECTIVE accent
 *   (a request for "sg" with no Singapore clips yields "cn"); `sgAvailable` says
 *   whether the Singapore option can be offered.
 */
export function effectiveClips(cnManifest, sgManifest, accent) {
  const cn = manifestClips(cnManifest);
  const sgAll = manifestClips(sgManifest);
  const sg = {};
  for (const [id, e] of Object.entries(sgAll)) if (isMandarinClip(id) && usable(e)) sg[id] = e;
  const sgAvailable = Object.keys(sg).length > 0;
  const effective = accent === "sg" && sgAvailable ? "sg" : "cn";

  // WHY copy: callers must be able to mutate/keep the table without touching the manifest objects.
  const clips = { ...cn };
  if (effective === "sg") Object.assign(clips, sg);

  const durations = {};
  for (const [id, c] of Object.entries(clips)) if (c && typeof c.dur === "number") durations[id] = c.dur;
  return { clips, durations, accent: effective, sgAvailable };
}
