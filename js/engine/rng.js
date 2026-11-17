/**
 * rng.js — seeded random numbers and small array helpers.
 *
 * Purpose
 *   The engine must be deterministic and testable, so it never calls
 *   Math.random(). Callers create one generator with makeRng(seed) (the UI seeds
 *   it from the clock once per session) and pass it down as the `rng` argument.
 *
 * How it fits
 *   Used by engine/questions.js (distractor choice, option order),
 *   engine/session.js (ordering, requeue offsets) and the tests.
 *   Depends on nothing.
 *
 * Key concepts
 *   - `rng` is simply `() => number` in [0, 1).
 *   - Every helper that "changes" an array returns a NEW array; inputs are
 *     never mutated.
 *
 * Public API
 *   makeRng(seed)          -> () => [0,1)
 *   shuffle(arr, rng)      -> new shuffled array (Fisher-Yates)
 *   pick(arr, rng)         -> one random element (undefined if empty)
 *   sample(arr, n, rng)    -> up to n distinct elements, random order
 */

// ===== Section: Generator =====

/**
 * Create a mulberry32 pseudo-random generator.
 * WHY: mulberry32 is 6 lines, fast, and good enough for shuffling quiz options;
 * no need for a heavier algorithm.
 * @param {number} seed Any integer (non-integers are truncated to 32 bits).
 * @returns {() => number} Function returning a float in [0, 1).
 */
export function makeRng(seed) {
  let a = seed | 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===== Section: Array helpers =====

/**
 * Return a shuffled copy (Fisher-Yates). The input is not modified.
 * @template T
 * @param {T[]} arr
 * @param {() => number} rng
 * @returns {T[]}
 */
export function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pick one random element.
 * @template T
 * @param {T[]} arr
 * @param {() => number} rng
 * @returns {T|undefined} undefined when the array is empty.
 */
export function pick(arr, rng) {
  if (!arr.length) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Pick up to `n` distinct elements in random order.
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @param {() => number} rng
 * @returns {T[]} Fewer than n when the array is shorter.
 */
export function sample(arr, n, rng) {
  return shuffle(arr, rng).slice(0, Math.max(0, n));
}
