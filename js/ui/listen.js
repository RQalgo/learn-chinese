/**
 * listen.js — Commute mode (#/listen[?unit=id]): hands-free listening.
 *
 * Purpose
 *   Let the learner press Start, lock the phone and just listen: new words,
 *   self-test reviews and a short conversation, played back to back.
 *
 * How it fits
 *   Registered by main.js (session screen). Plans with engine/session.js
 *   (planListenSession, durations from the audio manifest), plays with
 *   audio/player.js (Playlist + Media Session) and records progress with
 *   state/progress.js (applyListen, finishSession) through ui/store.js.
 *   "Test yourself" links to #/quiz.
 *
 * Key concepts
 *   - Three views: setup (length / scope), now-playing, finished summary.
 *   - Progress is batched: at every natural segment end the finished item ids
 *     go to applyListen() together with the seconds actually listened since the
 *     last flush, then saved. Skipped segments are NOT counted as heard.
 *   - Review segments are self-tests: the English is revealed only when its
 *     clip starts playing (the answer is spoken), so on screen it appears at
 *     the same moment as in the audio. Same idea for pinyin when set to
 *     "after answering".
 *   - Nothing here depends on timers for playback; the Playlist advances from
 *     audio `ended` events so it keeps running with the screen off.
 *
 * Public API
 *   render(root, ctx) -> dispose function
 */

import { h, put, clear, icon, segmented, confirmModal, fmtTime, fmtMinutes } from "./dom.js";
import { store, commit, newRng, pinyinMode, itemPinyin, linePinyin } from "./store.js";
import { navigate } from "../router.js";
import { planListenSession } from "../engine/session.js";
import { applyListen, finishSession } from "../state/progress.js";
import { Playlist, describeClip, setMediaMetadata, clearMediaSession } from "../audio/player.js";

// ===== Section: Constants =====

const LENGTHS = [5, 8, 12];
const PROMPT_LABEL = { "sys.newWords": "New words", "sys.review": "Review", "sys.dialogue": "Conversation", "sys.done": "Finished", "sys.welcome": "Welcome" };
const KIND_LABEL = { new: "New words", review: "Review", dialogue: "Conversation", prompt: "" };

// ===== Section: Screen =====

/**
 * Render the commute-mode screen.
 * @param {HTMLElement} root
 * @param {{query: {unit?: string}}} ctx
 * @returns {() => void} dispose: flushes progress and stops playback.
 */
export function render(root, ctx) {
  const { curriculum } = store;
  const unitId = ctx.query.unit && curriculum.unit(ctx.query.unit) ? ctx.query.unit : undefined;
  let minutes = 8;
  let scopeUnit = !!unitId;
  /** @type {Playlist|null} */ let playlist = null;
  let session = null; // tallies for the summary

  // ===== Section: Setup view =====

  function drawSetup() {
    if (playlist) { playlist.stop(); playlist = null; }
    session = null;
    const unit = unitId ? curriculum.unit(unitId) : null;
    clear(root).append(h("div", { class: "setup" },
      h("a", { class: "back", href: "#/home" }, "‹ Home"),
      h("h1", null, "Commute mode"),
      h("p", { class: "muted" }, "Plug in your earphones, press Start, then lock your phone. You'll hear new words, a quick review and a short conversation."),
      h("div", null, h("span", { class: "field-label" }, "Length"),
        segmented(LENGTHS.map((m) => ({ value: m, label: `${m} min` })), minutes, (v) => { minutes = v; }, "Session length")),
      unit ? h("div", null, h("span", { class: "field-label" }, "What to listen to"),
        segmented([{ value: "course", label: "My course" }, { value: "unit", label: `${unit.emoji || ""} ${unit.title}` }],
          scopeUnit ? "unit" : "course", (v) => { scopeUnit = v === "unit"; }, "Scope")) : null,
      store.audioAvailable ? null : h("p", { class: "card muted", style: { fontSize: ".9rem" } },
        "Recorded audio isn't published yet, so the phone's built-in voice is used. It may stop when the screen locks."),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary block", id: "start-listen", onclick: start }, "Start"))));
  }

  // ===== Section: Starting a session =====

  function start() {
    const plan = planListenSession({
      curriculum, progress: store.progress, now: Date.now(), rng: newRng(2), minutes,
      unitId: scopeUnit ? unitId : undefined, durations: store.durations,
    });
    const content = plan.segments.filter((s) => s.kind !== "prompt");
    if (!content.length) {
      clear(root).append(h("div", { class: "center-screen" }, h("h1", null, "Nothing to listen to yet"),
        h("p", null, "Do a lesson first so there are words to review, or pick a unit with new words."),
        h("a", { class: "btn primary", href: "#/quiz" }, "Start a lesson"), h("a", { class: "btn ghost", href: "#/home" }, "Home")));
      return;
    }
    session = { batch: { intro: [], reviewed: [], dialogues: [] }, flushedSec: 0, xp: 0, events: [], introduced: [], reviewed: 0, dialoguesHeard: 0, touched: false, finished: false };
    drawNowPlaying(plan, content.length);
  }

  /** Send the batch and the unflushed listening seconds to progress, and save. */
  function flush() {
    if (!session || !playlist) return;
    const total = playlist.listenedSec;
    const sec = total - session.flushedSec;
    const b = session.batch;
    if (!b.intro.length && !b.reviewed.length && !b.dialogues.length && sec < 1) return;
    const res = commit(applyListen(store.progress, {
      introducedIds: b.intro, reviewedIds: b.reviewed, dialogueIds: b.dialogues, seconds: sec, now: Date.now(), curriculum,
    }));
    session.flushedSec = total;
    session.touched = true;
    session.xp += res.xpGained;
    session.events.push(...res.events);
    b.intro = []; b.reviewed = []; b.dialogues = [];
  }

  function finishOnce() {
    if (session && session.touched && !session.finished) {
      session.finished = true;
      commit(finishSession(store.progress, Date.now()));
    }
  }

  // ===== Section: Now-playing view =====

  function drawNowPlaying(plan, contentCount) {
    const mode = pinyinMode();
    const nowEl = h("div", { class: "now", "aria-live": "polite" });
    const countEl = h("span", { class: "seg-count" });
    const barFill = h("span", { style: { width: "0%" } });
    const elapsedEl = h("span", null, "0:00");
    const totalEl = h("span", null, fmtTime(plan.estimatedSec));
    const toggleBtn = h("button", { type: "button", class: "icon-btn big accent", id: "toggle-play", "aria-label": "Pause" }, icon("pause", 30));
    let contentNo = 0; // index among non-prompt segments

    // ---- per-segment view builders (all return refs for clip-level updates) ----
    let view = null;

    function showPrompt(seg) {
      const label = PROMPT_LABEL[seg.refId] || "Listen";
      const text = describeClip(seg.refId).text;
      // WHY: skip the sentence when it only repeats the chip ("New words" / "New words.").
      put(clear(nowEl), h("span", { class: "section-label" }, label), text.replace(/\.$/, "") === label ? null : h("div", { class: "prompt-en" }, text));
      view = { kind: "prompt" };
      setMediaMetadata({ title: label, artist: text, album: "听 Tīng · Commute" });
    }

    function showItem(seg) {
      const it = curriculum.items.get(seg.refId);
      const isNew = seg.kind === "new";
      const py = itemPinyin(it);
      const pyEl = h("div", { class: `prompt-pinyin pinyin${py.length > 22 ? " long" : ""}`, hidden: !isNew && mode !== "always" });
      pyEl.textContent = mode === "never" ? "" : py;
      const enEl = h("div", { class: `prompt-en${isNew ? "" : " hidden"}` }, it.english);
      const hzEl = h("div", { class: `fb-hz hanzi${isNew ? "" : " hidden"}`, style: { visibility: isNew ? "visible" : "hidden" } }, it.hanzi);
      const hint = h("p", { class: "muted" }, isNew ? "" : "Think of the meaning…");
      put(clear(nowEl), h("span", { class: "section-label" }, KIND_LABEL[seg.kind]),
        mode === "never" && isNew ? h("div", { class: "intro-hanzi big hanzi" }, it.hanzi) : pyEl,
        enEl, mode === "never" ? null : hzEl, hint);
      view = { kind: seg.kind, it, pyEl, enEl, hzEl, hint };
      const album = `听 Tīng · ${curriculum.unitOf(it.id)?.title || ""}`;
      view.album = album;
      // Lock screen: new items show everything; review hides the answer until it is spoken.
      setMediaMetadata(isNew ? { title: py, artist: it.english, album } : { title: "Review: what does this mean?", artist: "", album });
    }

    function showDialogue(seg) {
      const d = curriculum.dialogues.get(seg.refId);
      const lis = (d.lines || []).map((l, i) => {
        const pyText = linePinyin(d.id, i, l);
        const py = h("div", { class: "py pinyin" }, pyText);
        const en = h("div", { class: "en", style: { visibility: "hidden" } }, l.english);
        const hz = h("div", { class: "hz hanzi", style: { visibility: "hidden" } }, l.hanzi);
        if (mode !== "always") py.style.visibility = "hidden";
        const li = h("li", { hidden: true }, h("span", { class: "who" }, l.speaker), h("div", null, mode === "never" ? null : py, en, hz));
        return { li, py, en, hz, line: l, pyText };
      });
      put(clear(nowEl), h("span", { class: "section-label" }, "Conversation"), h("div", { class: "prompt-label" }, d.title),
        h("ol", { class: "transcript" }, lis.map((x) => x.li)));
      view = { kind: "dialogue", d, lis, mode };
    }

    function onSegmentStart(seg, i) {
      if (seg.kind !== "prompt") { contentNo = plan.segments.slice(0, i + 1).filter((s) => s.kind !== "prompt").length; }
      countEl.textContent = contentNo ? `${contentNo} / ${contentCount}` : "";
      if (seg.kind === "prompt") showPrompt(seg);
      else if (seg.kind === "dialogue") showDialogue(seg);
      else showItem(seg);
    }

    function onClipStart(seg, i, clipId) {
      if (!view) return;
      if (view.kind === "review" && clipId.endsWith(".en")) {
        // WHY: reveal the answer exactly when the audio says it.
        view.enEl.classList.remove("hidden");
        view.hzEl.style.visibility = "visible";
        view.pyEl.hidden = mode === "never";
        view.hint.textContent = "";
        setMediaMetadata({ title: itemPinyin(view.it), artist: view.it.english, album: view.album });
      } else if (view.kind === "dialogue") {
        const m = /\.l(\d+)(\.en)?$/.exec(clipId);
        if (!m) return;
        const k = Number(m[1]) - 1;
        const x = view.lis[k];
        if (!x) return;
        view.lis.forEach((y) => y.li.classList.remove("now"));
        x.li.hidden = false;
        x.li.classList.add("now");
        x.li.scrollIntoView({ block: "nearest" });
        if (m[2]) {
          x.en.style.visibility = "visible"; x.hz.style.visibility = "visible"; x.py.style.visibility = "visible";
        }
        setMediaMetadata({ title: x.pyText, artist: x.line.english, album: `听 Tīng · ${view.d.title}` });
      }
    }

    function onSegmentEnd(seg) {
      const b = session.batch;
      if (seg.kind === "new") { b.intro.push(seg.refId); session.introduced.push(curriculum.items.get(seg.refId)); }
      else if (seg.kind === "review") { b.reviewed.push(seg.refId); session.reviewed++; }
      else if (seg.kind === "dialogue") { b.dialogues.push(seg.refId); session.dialoguesHeard++; }
      flush();
    }

    function onProgress(elapsed, total) {
      barFill.style.width = `${Math.min(100, (elapsed / (total || 1)) * 100)}%`;
      elapsedEl.textContent = fmtTime(elapsed);
    }

    function onState(state) {
      const playing = state === "playing";
      toggleBtn.replaceChildren(icon(playing ? "pause" : "play", 30));
      toggleBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    }

    playlist = new Playlist(plan.segments, {
      durations: store.durations, onSegmentStart, onSegmentEnd, onClipStart, onProgress, onState, onFinish: showFinished,
    });
    toggleBtn.addEventListener("click", () => playlist.toggle());

    clear(root).append(h("div", { class: "session listen" },
      h("header", { class: "session-bar" },
        h("button", { type: "button", class: "icon-btn", id: "close-session", "aria-label": "Stop and close", onclick: onClose }, "✕"),
        h("div", { style: { flex: 1, textAlign: "center" } }, countEl), h("span", { style: { width: "48px" } })),
      nowEl,
      h("div", { class: "player" },
        h("div", null, h("div", { class: "bar", role: "progressbar", "aria-label": "Session progress" }, barFill), h("div", { class: "time-row" }, elapsedEl, totalEl)),
        h("div", { class: "controls" },
          h("button", { type: "button", class: "icon-btn big", id: "prev-seg", "aria-label": "Replay this part", onclick: () => playlist.previous() }, icon("prev", 26)),
          toggleBtn,
          h("button", { type: "button", class: "icon-btn big", id: "next-seg", "aria-label": "Skip to next part", onclick: () => playlist.next() }, icon("next", 26))),
        h("p", { class: "screen-off" }, "You can turn the screen off. Playback keeps going."))));
    playlist.play(); // inside the Start tap: satisfies the browser's autoplay rule
  }

  async function onClose() {
    const ok = await confirmModal({ title: "Stop listening?", body: "What you've heard so far is saved.", confirmText: "Stop", cancelText: "Keep listening" });
    if (!ok) return;
    flush(); finishOnce();
    if (playlist) playlist.stop();
    navigate("#/home");
  }

  // ===== Section: Finished view =====

  function showFinished() {
    flush();
    const heardSec = playlist ? playlist.listenedSec : 0;
    finishOnce();
    const ev = [];
    for (const e of session.events) {
      if (e.type === "levelUp") ev.push(`🎉 Level ${e.level}: ${e.title} ${e.titleEn}`);
      else if (e.type === "goalReached") ev.push("🎯 Daily goal reached");
      else if (e.type === "streak") ev.push(`🔥 ${e.current}-day streak`);
      else if (e.type === "unitUnlocked") ev.push(`🔓 Unit unlocked: ${curriculum.unit(e.unitId)?.title || e.unitId}`);
    }
    const testHref = scopeUnit && unitId ? `#/quiz?unit=${unitId}` : "#/quiz";
    clear(root).append(h("div", { class: "summary", id: "listen-summary" },
      h("div", { class: "row" }, h("span", { class: "seal large", "aria-hidden": "true" }, "听")),
      h("h1", null, "Session finished"),
      h("div", { class: "stat-grid" },
        h("div", { class: "stat" }, h("b", null, fmtMinutes(heardSec / 60)), h("span", null, "Listened")),
        h("div", { class: "stat" }, h("b", null, `+${session.xp}`), h("span", null, "XP earned")),
        h("div", { class: "stat" }, h("b", null, session.introduced.length), h("span", null, "New words")),
        h("div", { class: "stat" }, h("b", null, session.reviewed + session.dialoguesHeard), h("span", null, "Reviewed"))),
      session.introduced.length ? h("div", { class: "chips" }, session.introduced.map((it) => h("span", { class: "chip" }, h("span", { class: "pinyin" }, itemPinyin(it)), ` ${it.english}`))) : null,
      ev.length ? h("ul", { class: "event-list" }, [...new Set(ev)].map((l) => h("li", null, l))) : null,
      h("div", { class: "actions" },
        h("a", { class: "btn primary block", href: testHref, id: "test-yourself" }, "Test yourself"),
        h("button", { type: "button", class: "btn block", onclick: drawSetup }, "Listen again"),
        h("a", { class: "btn ghost block", href: "#/home" }, "Home"))));
  }

  drawSetup();

  return () => {
    flush();
    finishOnce();
    if (playlist) playlist.stop();
    clearMediaSession();
  };
}
