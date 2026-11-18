/**
 * player.js — all audio playback: one <audio> element, speech fallback,
 * Media Session and the commute Playlist (ARCHITECTURE §8).
 *
 * Purpose
 *   Play clip ids (never file paths) reliably on Android Chrome, including
 *   hands-free with the screen off, and never hang a session when a clip or a
 *   voice is missing.
 *
 * How it fits
 *   main.js calls configurePlayer() once content is loaded. ui/quiz.js,
 *   ui/unit.js use playClip / playSequence / stop; ui/listen.js uses the
 *   Playlist class. Reads clip ids from the audio manifest (via configure) and
 *   fallback text from the Curriculum. Calls the browser's HTMLAudioElement,
 *   speechSynthesis and navigator.mediaSession.
 *
 * Key concepts
 *   - WHY one element: Chrome on Android keeps media playing in the
 *     background when the SAME element simply gets a new `src` after `ended`.
 *     New elements or setTimeout gaps stop working when the screen locks
 *     (timers are throttled). So there is exactly one element, gaps are real
 *     silent MP3 clips (`sys.silence.*`), and sequences advance from the
 *     `ended` event (the promise continuation runs in that same task).
 *   - A "run" is one cancellable playback request. Starting a new one aborts
 *     the previous one first, so audio never overlaps and every promise
 *     resolves ("cancelled" for the aborted one).
 *   - Fallback: a clip that is not in the manifest, or errors (404/decode), is
 *     spoken with speechSynthesis (zh-CN for Chinese, en-US for English/sys
 *     text) or, for silence clips, waited out. WHY the safety timeout: voices
 *     may be missing (headless Chrome has none) and `onend` may then never
 *     fire; a timer of 0.25 s per character + 1.5 s guarantees progress.
 *     (Fallback does not survive screen-off — it is only a stop-gap for
 *     content whose audio has not been generated yet.)
 *
 * Public API
 *   configurePlayer({clips, curriculum})
 *   playClip(clipId, {slow}) / (an `.altK` id falls back to the primary clip; {slow} of an alt = primary slow) / playSequence(clipIds) -> Promise<"ended"|"fallback"|"cancelled">
 *   stop(), onPlayingChange(cb), subscribeTime(cb)
 *   setMediaMetadata({title, artist, album}), setMediaHandlers(h), clearMediaSession()
 *   describeClip(clipId) -> {text, lang, rate, silenceMs?}
 *   class Playlist
 */

import { resolveClipId } from "../data/clips.js";

// ===== Section: State =====

/** The single audio element (see header). */
const audio = new Audio();
audio.preload = "auto";

/** @type {Object<string, {src: string, dur: number}>} */
let clipTable = {};
/** @type {import("../engine/curriculum.js").Curriculum|null} */
let curriculum = null;

/** The currently active run, if any. @type {{cancelled: boolean, abort: () => void}|null} */
let active = null;
const playingListeners = new Set();
const timeListeners = new Set();

/**
 * Provide the audio manifest clips and the curriculum (used for fallback text).
 * @param {{clips: Object<string, {src: string, dur: number}>, curriculum: Object}} cfg
 */
export function configurePlayer({ clips, curriculum: cur }) {
  clipTable = clips || {};
  curriculum = cur;
}

/**
 * Subscribe to "something is playing" changes (drives the pulsing play button).
 * @param {(playing: boolean) => void} cb
 * @returns {() => void} Unsubscribe.
 */
export function onPlayingChange(cb) { playingListeners.add(cb); return () => playingListeners.delete(cb); }

/**
 * Subscribe to playback position updates of real audio (for smooth progress).
 * @param {(currentSec: number) => void} cb
 * @returns {() => void} Unsubscribe.
 */
export function subscribeTime(cb) { timeListeners.add(cb); return () => timeListeners.delete(cb); }

audio.addEventListener("timeupdate", () => { for (const cb of timeListeners) cb(audio.currentTime); });

let lastPlaying = false;
/** Notify listeners when the playing flag changes. */
function setPlaying(v) {
  if (v === lastPlaying) return;
  lastPlaying = v;
  for (const cb of playingListeners) cb(v);
}

// ===== Section: Clip text (fallback) =====

/** Texts of fixed prompts, copied from docs/AUDIO.md. */
const SYS_TEXT = {
  welcome: "Let's start.",
  newWords: "New words.",
  review: "Review time. Listen, and think of the meaning.",
  whatMeans: "What does this mean?",
  dialogue: "Now, a short conversation.",
  again: "Once more, at normal speed.",
  done: "Well done. That's the end of this session.",
};

/**
 * What a clip says, for the speech fallback.
 * @param {string} id Clip id (ARCHITECTURE §5).
 * @returns {{text: string, lang: string, rate: number, silenceMs?: number}}
 */
export function describeClip(id) {
  const sil = /^sys\.silence\.(\d+)$/.exec(id);
  if (sil) return { text: "", lang: "en-US", rate: 1, silenceMs: Number(sil[1]) };
  if (id.startsWith("sys.")) return { text: SYS_TEXT[id.slice(4)] || "", lang: "en-US", rate: 1 };

  const slow = id.endsWith(".slow");
  const en = id.endsWith(".en");
  const base = id.replace(/\.alt\d+$/, "").replace(/\.(slow|en)$/, "");
  let zh = "", eng = "";
  const m = /^(.+)\.([lq])(\d+)$/.exec(base);
  if (m && curriculum) {
    if (m[2] === "l") {
      const line = (curriculum.dialogues.get(m[1])?.lines || [])[Number(m[3]) - 1];
      zh = line?.hanzi || ""; eng = line?.english || "";
    } else {
      eng = curriculum.questions.get(`${m[1]}-q${m[3]}`)?.question || "";
    }
  } else if (curriculum) {
    const it = curriculum.items.get(base);
    zh = it?.hanzi || ""; eng = it?.english || "";
  }
  if (en || (!zh && eng)) return { text: eng, lang: "en-US", rate: 1 };
  // WHY: 0.7 for slow clips (the slow clips are 1.45-1.6x or more as long as the normal ones).
  return { text: zh, lang: "zh-CN", rate: slow ? 0.7 : 0.95 };
}

// ===== Section: Running one clip =====

/** Stop whatever is currently sounding (element and speech). */
function haltOutput() {
  try { audio.pause(); } catch { /* ignore */ }
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* ignore */ }
}

/**
 * Play one clip inside a run.
 * @param {string} clipId
 * @param {{slow?: boolean}} opts `slow` plays `<id>.slow` instead when the id has no suffix.
 * @param {{cancelled: boolean, abort: () => void}} run
 * @returns {Promise<"ended"|"fallback"|"cancelled">}
 */
function runClip(clipId, opts, run) {
  return new Promise((resolve) => {
    if (run.cancelled) return resolve("cancelled");
    // WHY: the slow clip exists only in the primary voice, so "slow" of a quiz-voice id (`.altK`) is the
    // primary's slow clip; a missing alt falls back to the primary clip (data/clips.js, §5).
    const wantId = opts.slow ? clipId.replace(/\.alt\d+$/, "") : clipId;
    const id = opts.slow && !wantId.endsWith(".slow") && !wantId.startsWith("sys.") && !wantId.endsWith(".en")
      ? `${wantId}.slow` : resolveClipId(wantId, clipTable);
    const timers = [];
    const listeners = [];
    let settled = false;
    let fellBack = false;
    const on = (target, ev, fn) => { target.addEventListener(ev, fn); listeners.push([target, ev, fn]); };
    const cleanup = () => {
      timers.forEach(clearTimeout);
      listeners.forEach(([t, e, f]) => t.removeEventListener(e, f));
    };
    const settle = (r) => { if (settled) return; settled = true; cleanup(); resolve(r); };
    run.abort = () => { run.cancelled = true; haltOutput(); settle("cancelled"); };

    const desc = describeClip(id);

    /** Speech / silence path. */
    const fallback = () => {
      if (settled || fellBack || run.cancelled) return;
      fellBack = true;
      timers.forEach(clearTimeout); timers.length = 0;
      try { audio.pause(); } catch { /* ignore */ }
      if (desc.silenceMs != null) { timers.push(setTimeout(() => settle("fallback"), desc.silenceMs)); return; }
      speak(desc, timers, settle);
    };

    const entry = clipTable[id] || (id !== wantId ? clipTable[wantId] : null);
    if (!entry || !entry.src) return fallback();

    on(audio, "ended", () => settle("ended"));
    on(audio, "error", fallback);
    // WHY: if the file never starts (offline and uncached, stalled), give up after 8 s and use speech.
    on(audio, "playing", () => { timers.forEach(clearTimeout); timers.length = 0; });
    timers.push(setTimeout(fallback, 8000));
    audio.src = entry.src;
    audio.playbackRate = 1;
    const p = audio.play();
    if (p && p.catch) p.catch(() => fallback()); // autoplay blocked / aborted / decode error
  });
}

/**
 * Speak text with speechSynthesis, guarded by a safety timeout.
 * @param {{text: string, lang: string, rate: number}} desc
 * @param {number[]} timers Timer list owned by the caller (cleared on settle).
 * @param {(r: string) => void} settle
 */
function speak(desc, timers, settle) {
  const text = desc.text;
  if (!text) { timers.push(setTimeout(() => settle("fallback"), 300)); return; }
  const synth = window.speechSynthesis;
  const safetyMs = text.length * 250 + 1500; // see header: never hang on a missing voice
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    // No speech at all: just pace roughly like a short reading so the UI still flows.
    timers.push(setTimeout(() => settle("fallback"), Math.min(safetyMs, text.length * 60 + 600)));
    return;
  }
  timers.push(setTimeout(() => { try { synth.cancel(); } catch { /* ignore */ } settle("fallback"); }, safetyMs));
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = desc.lang;
    u.rate = desc.rate;
    u.onend = () => settle("fallback");
    u.onerror = () => settle("fallback");
    synth.cancel(); // drop anything queued by a previous (aborted) run
    synth.speak(u);
  } catch { /* the safety timer will settle */ }
}

// ===== Section: Public playback API =====

/** Start a new run, aborting any previous one. */
function begin() {
  if (active) active.abort();
  const run = { cancelled: false, abort: () => { run.cancelled = true; } };
  active = run;
  setPlaying(true);
  return run;
}

/** Mark a run finished (only if it is still the active one). */
function end(run) {
  if (active === run) { active = null; setPlaying(false); }
}

/**
 * Play a single clip, cancelling anything already playing.
 * @param {string} clipId
 * @param {{slow?: boolean}} [opts]
 * @returns {Promise<"ended"|"fallback"|"cancelled">}
 */
export async function playClip(clipId, opts = {}) {
  const run = begin();
  const r = await runClip(clipId, opts, run);
  end(run);
  return r;
}

/**
 * Play clips one after another (cancel-safe).
 * @param {string[]} clipIds
 * @returns {Promise<"ended"|"fallback"|"cancelled">} "cancelled" if interrupted at any point.
 */
export async function playSequence(clipIds) {
  const run = begin();
  let result = "ended";
  for (const id of clipIds) {
    if (run.cancelled) { result = "cancelled"; break; }
    const r = await runClip(id, {}, run);
    if (r === "cancelled") { result = "cancelled"; break; }
    if (r === "fallback") result = "fallback";
  }
  end(run);
  return result;
}

/** Stop all playback immediately. Pending promises resolve as "cancelled". */
export function stop() {
  if (active) active.abort();
  active = null;
  haltOutput();
  setPlaying(false);
}

// ===== Section: Media Session =====

const hasMS = () => "mediaSession" in navigator;

/**
 * Set lock-screen / notification metadata.
 * @param {{title: string, artist?: string, album?: string}} meta
 */
export function setMediaMetadata({ title, artist = "", album = "听 Tīng" }) {
  if (!hasMS() || typeof MediaMetadata === "undefined") return;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album }); } catch { /* ignore */ }
}

/**
 * Install media-key handlers. Missing keys are cleared so stale handlers from a
 * previous screen never fire.
 * @param {{play?: Function, pause?: Function, nexttrack?: Function, previoustrack?: Function}} handlers
 */
export function setMediaHandlers(handlers) {
  if (!hasMS()) return;
  for (const action of ["play", "pause", "nexttrack", "previoustrack"]) {
    try { navigator.mediaSession.setActionHandler(action, handlers[action] || null); } catch { /* unsupported action */ }
  }
}

/** Remove metadata and handlers (leaving a session screen). */
export function clearMediaSession() {
  if (!hasMS()) return;
  setMediaHandlers({});
  try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = "none"; } catch { /* ignore */ }
}

/** Reflect state on the lock screen. */
function setMediaState(state) {
  if (hasMS()) { try { navigator.mediaSession.playbackState = state; } catch { /* ignore */ } }
}

// ===== Section: Playlist (commute mode) =====

/**
 * Fallback duration estimate, mirroring engine/session.js: manifest value,
 * else silence from the id, else 1.2 s (slow x1.5).
 */
function makeDur(durations) {
  return (id) => {
    if (durations && durations[id] != null) return durations[id];
    const m = /^sys\.silence\.(\d+)$/.exec(id);
    if (m) return Number(m[1]) / 1000;
    return id.endsWith(".slow") ? 1.8 : 1.2;
  };
}

/**
 * Plays listen-plan segments back to back for hands-free use.
 *
 * Events (constructor options): onSegmentStart(seg, index), onSegmentEnd(seg, index)
 * (natural completion only — skipping a segment does NOT fire it, so skipped
 * material is not counted as heard), onClipStart(seg, index, clipId, clipIndex),
 * onProgress(elapsedSec, totalSec), onFinish(), onState(state).
 */
export class Playlist {
  /**
   * @param {import("../engine/session.js").Segment[]} segments
   * @param {Object} [opts]
   * @param {Object<string, number>} [opts.durations] clipId -> seconds.
   * @param {Function} [opts.onSegmentStart]
   * @param {Function} [opts.onSegmentEnd]
   * @param {Function} [opts.onClipStart]
   * @param {Function} [opts.onProgress]
   * @param {Function} [opts.onFinish]
   * @param {Function} [opts.onState]
   */
  constructor(segments, opts = {}) {
    this.segments = segments;
    this.opts = opts;
    this._dur = makeDur(opts.durations);
    this._seg = 0;
    this._clip = 0;
    this._fireStart = true;
    this._token = 0;
    this._state = "idle";
    this._listened = 0;
    this._clockStart = 0;
    // Cumulative start offsets for the progress bar.
    this._segOffset = [];
    let t = 0;
    for (const s of segments) { this._segOffset.push(t); t += s.clips.reduce((a, c) => a + this._dur(c), 0); }
    this.totalSec = t;
    this._unsubTime = null;
  }

  /** @returns {"idle"|"playing"|"paused"|"finished"|"stopped"} */
  get state() { return this._state; }
  /** @returns {number} Index of the current segment. */
  get index() { return this._seg; }
  /** @returns {number} Seconds of real (wall-clock) listening so far, excluding pauses. */
  get listenedSec() {
    return this._listened + (this._state === "playing" ? (performance.now() - this._clockStart) / 1000 : 0);
  }

  _cb(name, ...args) {
    const fn = this.opts[name];
    if (fn) { try { fn(...args); } catch (e) { console.error(`Playlist ${name}:`, e); } }
  }
  _setState(s) { this._state = s; setMediaState(s === "playing" ? "playing" : "paused"); this._cb("onState", s); }
  _startClock() { this._clockStart = performance.now(); }
  _stopClock() { if (this._state === "playing") this._listened += (performance.now() - this._clockStart) / 1000; }

  /** Elapsed seconds at the start of clip `clipIndex` of segment `segIndex`. */
  _elapsedAt(segIndex, clipIndex) {
    const seg = this.segments[segIndex];
    if (!seg) return this.totalSec;
    let t = this._segOffset[segIndex];
    for (let i = 0; i < clipIndex; i++) t += this._dur(seg.clips[i]);
    return t;
  }

  _installMedia() {
    setMediaHandlers({
      play: () => this.play(), pause: () => this.pause(),
      nexttrack: () => this.next(), previoustrack: () => this.previous(),
    });
    // WHY: real audio reports its position; use it so the bar moves smoothly within a clip.
    if (!this._unsubTime) {
      this._unsubTime = subscribeTime((cur) => {
        if (this._state !== "playing") return;
        const seg = this.segments[this._seg];
        if (seg) this._cb("onProgress", Math.min(this.totalSec, this._elapsedAt(this._seg, this._clip) + cur), this.totalSec);
      });
    }
  }

  /** Start or resume playback. */
  play() {
    if (this._state === "playing" || this._state === "finished") return;
    this._installMedia();
    this._startClock();
    this._setState("playing");
    this._loop(++this._token);
  }

  /** Pause. WHY: aborts at clip granularity; resume replays the current (short) clip. */
  pause() {
    if (this._state !== "playing") return;
    this._token++;
    this._stopClock();
    stop();
    this._setState("paused");
  }

  /** Toggle between play and pause. */
  toggle() { if (this._state === "playing") this.pause(); else this.play(); }

  /** Skip to the next segment (does not count the skipped one as heard). */
  next() {
    if (this._state === "finished" || this._state === "stopped") return;
    this._seg = Math.min(this._seg + 1, this.segments.length);
    this._clip = 0;
    this._fireStart = true;
    this._restart();
  }

  /** Replay the current segment from its beginning. */
  previous() {
    if (this._state === "finished" || this._state === "stopped") return;
    this._clip = 0;
    this._fireStart = true;
    this._restart();
  }

  /** Re-enter the loop after a jump (playing or paused). */
  _restart() {
    this._token++;
    stop();
    if (this._state === "paused" || this._state === "idle") { this._cb("onSegmentStart", this.segments[this._seg], this._seg); this._fireStart = false; return; }
    this._loop(++this._token);
  }

  /** Stop for good (leaving the screen). Safe to call repeatedly. */
  stop() {
    if (this._state === "stopped") return;
    this._token++;
    this._stopClock();
    stop();
    if (this._unsubTime) { this._unsubTime(); this._unsubTime = null; }
    clearMediaSession();
    this._state = "stopped";
  }

  /** The playback loop; exits silently when its token is superseded. */
  async _loop(token) {
    while (this._seg < this.segments.length) {
      const i = this._seg;
      const seg = this.segments[i];
      if (this._fireStart) { this._fireStart = false; this._cb("onSegmentStart", seg, i); }
      for (; this._clip < seg.clips.length; this._clip++) {
        const clipId = seg.clips[this._clip];
        this._cb("onClipStart", seg, i, clipId, this._clip);
        this._cb("onProgress", this._elapsedAt(i, this._clip), this.totalSec);
        const r = await playClip(clipId);
        // WHY: this continuation runs in the `ended` event task, so the next
        // clip's `src` is set without any timer — screen-off safe.
        if (token !== this._token || r === "cancelled") return;
      }
      this._cb("onSegmentEnd", seg, i);
      this._seg++;
      this._clip = 0;
      this._fireStart = true;
    }
    this._stopClock();
    this._setState("finished");
    this._cb("onProgress", this.totalSec, this.totalSec);
    if (this._unsubTime) { this._unsubTime(); this._unsubTime = null; }
    clearMediaSession();
    this._cb("onFinish");
  }
}
