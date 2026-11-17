/**
 * sfx.js — tiny synthesised feedback sounds (correct / wrong / level up).
 *
 * Purpose
 *   Give quick, pleasant audio feedback in the quiz without shipping sound
 *   files. Tones are generated with WebAudio and mixed quietly so they never
 *   drown out the spoken Mandarin.
 *
 * How it fits
 *   ui/quiz.js calls playSfx("correct" | "wrong" | "levelUp"). ui/store.js
 *   calls setSfxEnabled() whenever progress.settings.sfx changes. Independent of
 *   audio/player.js (separate AudioContext) so it never touches the single
 *   <audio> element.
 *
 * Key concepts
 *   - The AudioContext is created lazily on the first call: browsers only
 *     allow it after a user gesture, and every call here happens inside a tap
 *     handler or right after one.
 *   - Wrong-answer sound is a soft low two-note "hm", not a buzzer: this is a
 *     learning app and mistakes are normal.
 *
 * Public API
 *   setSfxEnabled(bool), playSfx(kind)
 */

// ===== Section: State =====

let ctx = null;
let enabled = true;
/** Master volume. WHY: quiet by default; earphones on a quiet train are loud already. */
const MASTER = 0.05;

/**
 * Turn sound effects on or off.
 * @param {boolean} on
 */
export function setSfxEnabled(on) { enabled = !!on; }

// ===== Section: Synthesis =====

/** Lazily create (and resume) the shared AudioContext. */
function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Schedule one tone with a soft attack and exponential decay.
 * @param {AudioContext} c
 * @param {number} freq Hz
 * @param {number} at Seconds from now.
 * @param {number} dur Seconds.
 * @param {OscillatorType} type
 */
function tone(c, freq, at, dur, type = "sine") {
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(MASTER, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

const SOUNDS = {
  correct: (c) => { tone(c, 659.25, 0, 0.16); tone(c, 880, 0.09, 0.26); },          // E5 -> A5, rising
  wrong: (c) => { tone(c, 311.13, 0, 0.18, "triangle"); tone(c, 261.63, 0.12, 0.3, "triangle"); }, // soft descent
  levelUp: (c) => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, f, i * 0.1, 0.3)); }, // C major arpeggio
};

/**
 * Play a feedback sound (no-op when disabled or unsupported).
 * @param {"correct"|"wrong"|"levelUp"} kind
 */
export function playSfx(kind) {
  if (!enabled) return;
  try {
    const c = audioCtx();
    if (c && SOUNDS[kind]) SOUNDS[kind](c);
  } catch { /* sound is a nicety; never break the lesson */ }
}
