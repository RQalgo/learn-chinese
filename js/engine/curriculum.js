/**
 * curriculum.js — index of all lesson content, built once after loading.
 *
 * Purpose
 *   Turn data/units.json plus the loaded unit files into fast lookups so the
 *   rest of the engine never walks raw JSON: items by id, dialogues, dialogue
 *   questions, items per unit, and the list of audio clips a unit needs.
 *
 * How it fits
 *   data/loader.js fetches the JSON and calls buildCurriculum(). Everything in
 *   engine/ and state/progress.js receives the resulting object. The offline
 *   "download audio" button calls clipsForUnit(). Pure: no fetch, no DOM.
 *
 * Key concepts
 *   - Items are copied and augmented with unitId, unitOrder and index (position
 *     inside the unit file); the original JSON is not mutated.
 *   - A unit listed in the index but without a loaded file is kept with
 *     `available: false` and no items, so the UI can show it greyed out.
 *   - Clip IDs follow ARCHITECTURE §5.
 *
 * Public API
 *   buildCurriculum(unitsIndex, unitFiles) -> Curriculum
 *   SYS_CLIPS                              -> sys.* clip ids used by the listen planner
 *   Curriculum: { units, items, dialogues, questions, unit(id), unitOf(id),
 *                 itemsOfUnit(unitId), dialoguesOfUnit(unitId),
 *                 clipsForUnit(unitId), allClipIds() }
 */

// ===== Section: Types =====

/**
 * @typedef {Object} Item
 * @property {string} id        e.g. "u01-w01"
 * @property {"word"|"phrase"|"sentence"} type
 * @property {string} hanzi
 * @property {string} pinyin
 * @property {string} english
 * @property {string[]} [alt]
 * @property {string} [hint]
 * @property {string} unitId    Added by buildCurriculum.
 * @property {number} unitOrder Added: the unit's `order`.
 * @property {number} index     Added: 0-based position in the unit file.
 */

/**
 * @typedef {Object} Unit
 * @property {string} id
 * @property {number} order
 * @property {string} title
 * @property {string} [emoji]
 * @property {string} [description]
 * @property {string} [file]
 * @property {boolean} available   False when no unit file was loaded.
 * @property {string[]} itemIds    In file order.
 * @property {string[]} dialogueIds
 */

/**
 * @typedef {Object} DialogueQuestionEntry
 * @property {string} id          e.g. "u01-d01-q1"
 * @property {string} dialogueId
 * @property {string} unitId
 * @property {string} clip        Question audio clip, "<dialogueId>.q<N>.en".
 * @property {string} question
 * @property {string} answer
 * @property {string[]} distractors
 */

/**
 * @typedef {Object} Curriculum
 * @property {Unit[]} units                       Sorted by `order`.
 * @property {Map<string, Item>} items
 * @property {Map<string, Object>} dialogues      Dialogue objects plus unitId.
 * @property {Map<string, DialogueQuestionEntry>} questions
 * @property {(unitId: string) => (Unit|undefined)} unit
 * @property {(id: string) => (Unit|undefined)} unitOf
 * @property {(unitId: string) => Item[]} itemsOfUnit
 * @property {(unitId: string) => Object[]} dialoguesOfUnit
 * @property {(unitId: string) => string[]} clipsForUnit
 * @property {() => string[]} allClipIds
 */

// ===== Section: Constants =====

/** Fixed English prompts and silences used by the commute playlist (docs/AUDIO.md). */
export const SYS_CLIPS = [
  "sys.welcome", "sys.newWords", "sys.review", "sys.whatMeans", "sys.dialogue",
  "sys.again", "sys.done",
  "sys.silence.500", "sys.silence.1000", "sys.silence.1500",
  "sys.silence.2000", "sys.silence.3000",
];

// ===== Section: Builder =====

/**
 * Normalise the unitFiles argument (object, Map or array of files) to a lookup.
 * WHY: the loader may naturally produce any of these; being liberal here keeps
 * the loader simple.
 * @param {Object|Map|Array} unitFiles
 * @returns {(id: string) => (Object|undefined)}
 */
function fileLookup(unitFiles) {
  if (!unitFiles) return () => undefined;
  if (unitFiles instanceof Map) return (id) => unitFiles.get(id);
  if (Array.isArray(unitFiles)) {
    const m = new Map(unitFiles.filter(Boolean).map((f) => [f.id, f]));
    return (id) => m.get(id);
  }
  return (id) => unitFiles[id];
}

/**
 * Build the curriculum index.
 * @param {{units: Object[]}} unitsIndex Parsed data/units.json.
 * @param {Object|Map|Array} unitFiles Parsed unit files keyed by unit id
 *   (plain object or Map), or an array of unit files. Missing ones are tolerated.
 * @returns {Curriculum}
 */
export function buildCurriculum(unitsIndex, unitFiles) {
  const getFile = fileLookup(unitFiles);
  const indexUnits = (unitsIndex && unitsIndex.units) || [];
  const ordered = indexUnits.slice().sort((a, b) => a.order - b.order);

  /** @type {Unit[]} */ const units = [];
  const items = new Map();
  const dialogues = new Map();
  const questions = new Map();
  const unitById = new Map();

  for (const u of ordered) {
    const file = getFile(u.id);
    const unit = {
      id: u.id, order: u.order, title: u.title, emoji: u.emoji,
      description: u.description, file: u.file,
      available: !!file, itemIds: [], dialogueIds: [],
    };
    if (file) {
      (file.items || []).forEach((raw, index) => {
        const item = { ...raw, unitId: u.id, unitOrder: u.order, index };
        items.set(item.id, item);
        unit.itemIds.push(item.id);
      });
      for (const rawD of file.dialogues || []) {
        const d = { ...rawD, unitId: u.id };
        dialogues.set(d.id, d);
        unit.dialogueIds.push(d.id);
        for (const q of d.questions || []) {
          // WHY: the clip number is the trailing number of the question id
          // ("u01-d01-q2" -> q2), which matches the audio generator's naming.
          const m = /-q(\d+)$/.exec(q.id);
          const n = m ? m[1] : "1";
          questions.set(q.id, {
            ...q, dialogueId: d.id, unitId: u.id, clip: `${d.id}.q${n}.en`,
          });
        }
      }
    }
    units.push(unit);
    unitById.set(unit.id, unit);
  }

  // ---- lookups ----
  const unit = (id) => unitById.get(id);
  /** Resolve any item / dialogue / question id or clip id to its unit. */
  const unitOf = (id) => {
    if (typeof id !== "string") return undefined;
    const base = id.split(".")[0]; // strip clip suffixes (.slow, .l2.en, ...)
    const hit = items.get(base) || dialogues.get(base) || questions.get(base);
    if (hit) return unitById.get(hit.unitId);
    // Fall back to the "uNN" prefix for ids of units without loaded content.
    return unitById.get(base.split("-")[0]);
  };
  const itemsOfUnit = (unitId) => (unitById.get(unitId)?.itemIds || []).map((i) => items.get(i));
  const dialoguesOfUnit = (unitId) => (unitById.get(unitId)?.dialogueIds || []).map((i) => dialogues.get(i));

  /** Every clip a unit needs (§5), plus shared sys clips so one download covers the commute mode. */
  const clipsForUnit = (unitId) => {
    const out = new Set();
    for (const it of itemsOfUnit(unitId)) {
      out.add(it.id); out.add(`${it.id}.slow`); out.add(`${it.id}.en`);
    }
    for (const d of dialoguesOfUnit(unitId)) {
      (d.lines || []).forEach((_, i) => {
        const n = i + 1;
        out.add(`${d.id}.l${n}`); out.add(`${d.id}.l${n}.slow`); out.add(`${d.id}.l${n}.en`);
      });
    }
    for (const q of questions.values()) if (q.unitId === unitId) out.add(q.clip);
    for (const s of SYS_CLIPS) out.add(s);
    return [...out];
  };

  const allClipIds = () => {
    const out = new Set();
    for (const u of units) for (const c of clipsForUnit(u.id)) out.add(c);
    return [...out];
  };

  return { units, items, dialogues, questions, unit, unitOf, itemsOfUnit, dialoguesOfUnit, clipsForUnit, allClipIds };
}
