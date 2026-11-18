/**
 * pinyinSg.js — which pinyin to show for an item or dialogue line.
 *
 * Purpose
 *   Singapore Mandarin is spoken with full tones where Mainland Mandarin has neutral
 *   tones (谢谢 xièxiè, not xièxie). The Singapore audio set is rendered from that reading,
 *   and `data/pinyin-sg.json` (built by tools/build_sg_pinyin.py from the same code)
 *   holds the matching on-screen pinyin. This module picks the right text.
 *
 * How it fits
 *   Pure (no fetch, no DOM). data/loader.js fetches the JSON; ui/store.js keeps it and
 *   exposes itemPinyin()/linePinyin() to the screens. The content files keep the
 *   Mainland pinyin, so with accent "cn" (or no entry) nothing changes.
 *
 * Key concepts
 *   - Keys: an item id (`u01-w02`) or `<dialogueId>.l<N>` (N is 1-based, like the clip id).
 *   - The file holds ONLY entries that differ from the content pinyin.
 *   - Display accent = the EFFECTIVE accent (store.accent): "sg" only when Singapore clips exist,
 *     so the text always matches the voice that is actually playing.
 *
 * Public API
 *   normalizePinyinSg(raw), pinyinFor(key, contentPinyin, map, accent), lineKey(dialogueId, lineNumber)
 */

/**
 * Keep only string values of a parsed `pinyin-sg.json` (null/garbage gives `{}`).
 * @param {any} raw Parsed JSON or null (missing file).
 * @returns {Object<string, string>}
 */
export function normalizePinyinSg(raw) {
  const out = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

/**
 * Key of a dialogue line in `pinyin-sg.json` (same numbering as the line's clip id).
 * @param {string} dialogueId e.g. "u01-d01"
 * @param {number} lineNumber 1-based.
 * @returns {string} e.g. "u01-d01.l3"
 */
export function lineKey(dialogueId, lineNumber) {
  return `${dialogueId}.l${lineNumber}`;
}

/**
 * The pinyin to display.
 * @param {string} key Item id or `lineKey(...)`.
 * @param {string} contentPinyin The pinyin written in the content (Mainland reading).
 * @param {Object<string, string>} map Normalised `pinyin-sg.json`.
 * @param {"sg"|"cn"} accent The effective accent.
 * @returns {string} The Singapore pinyin when accent is "sg" and the map has an entry, else `contentPinyin`.
 */
export function pinyinFor(key, contentPinyin, map, accent) {
  if (accent === "sg" && map && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  return contentPinyin;
}
