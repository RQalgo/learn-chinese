/**
 * quiz.js — the tap-to-answer Lesson (#/quiz[?unit=id]).
 *
 * Purpose
 *   Run a planned quiz session step by step: new-word intros, listening
 *   questions (4 types), dialogue comprehension, feedback, combo/XP tracking
 *   and the end-of-session summary.
 *
 * How it fits
 *   Registered by main.js (session screen: no tab bar). Calls
 *   engine/session.js (planQuizSession, requeue), engine/questions.js
 *   (makeQuestion, makeDialogueQuestion), state/progress.js (applyIntro,
 *   applyAnswer, applyDialogueAnswer, finishSession), ui/store.js (commit /
 *   settings), audio/player.js (playback + Media Session) and audio/sfx.js.
 *   Progress is committed (and therefore saved) after EVERY answer, so leaving
 *   mid-lesson never loses work.
 *
 * Key concepts
 *   - Layout: prompt in the upper half, answer buttons in the lower half
 *     (thumb zone). After answering, the feedback panel REPLACES the answer
 *     buttons in the same spot, so the "Next" button is where the thumb is.
 *   - Pinyin visibility follows settings.pinyin: "always" shows it while
 *     listening, "after" only in feedback, "never" not at all.
 *   - Correct answers auto-advance after ~1.4 s (tap Next to skip; can be
 *     disabled in Settings); wrong answers wait for "Continue" and the item
 *     is re-queued by requeue().
 *   - WHY the dialogue transcript is hidden until the LAST question of that
 *     dialogue has been answered: the exercise tests listening comprehension;
 *     showing the text first would turn it into a reading exercise. (The
 *     transcript is also available on the unit screen.)
 *   - Media Session: play = replay the current prompt, pause = stop.
 *
 * Public API
 *   render(root, ctx) -> dispose function
 */

import { h, put, clear, icon, confirmModal } from "./dom.js";
import { store, commit, newRng, getSetting, pinyinMode } from "./store.js";
import { navigate } from "../router.js";
import { planQuizSession, requeue } from "../engine/session.js";
import { makeQuestion, makeDialogueQuestion } from "../engine/questions.js";
import { applyIntro, applyAnswer, applyDialogueAnswer, finishSession } from "../state/progress.js";
import { playClip, playSequence, stop, onPlayingChange, setMediaHandlers, setMediaMetadata, clearMediaSession } from "../audio/player.js";
import { playSfx } from "../audio/sfx.js";

// ===== Section: Constants =====

/** How long a correct-answer feedback stays before auto-advancing. */
const AUTO_ADVANCE_MS = 1400;

// ===== Section: Screen =====

/**
 * Render the quiz screen.
 * @param {HTMLElement} root
 * @param {{query: {unit?: string}}} ctx
 * @returns {() => void} dispose: saves the session count, stops audio and timers.
 */
export function render(root, ctx) {
  const unitId = ctx.query.unit || undefined;
  const { curriculum } = store;
  const rng = newRng(1);

  // ----- session state -----
  let plan, idx, S;
  let advanceTimer = 0;
  let cleanups = [];        // per-step unsubscribe functions
  let replayFn = () => {};  // what the media "play" key does
  let stageEl, topEl, bottomEl, barEl, comboEl;
  let disposed = false;

  // ===== Section: Session lifecycle =====

  /** (Re)start: plan a session and show its first step. */
  function start() {
    plan = planQuizSession({
      curriculum, progress: store.progress, now: Date.now(), rng,
      length: store.progress.settings.sessionLength, unitId,
    });
    idx = 0;
    S = { xp: 0, answered: 0, correct: 0, combo: 0, best: 0, newItems: [], events: [], touched: false, finished: false };
    if (!plan.steps.length) { showEmpty(); return; }
    buildShell();
    showStep();
  }

  /** Count the session in today's log exactly once, if anything happened. */
  function finishOnce() {
    if (S && S.touched && !S.finished) {
      S.finished = true;
      commit(finishSession(store.progress, Date.now()));
    }
  }

  /** Close button: confirm, then leave. */
  async function onClose() {
    if (S && S.finished) { navigate("#/home"); return; }
    const ok = await confirmModal({
      title: "Leave this lesson?", body: "Your answers so far are already saved.",
      confirmText: "Leave", cancelText: "Keep going",
    });
    if (ok) { finishOnce(); navigate("#/home"); }
  }

  // ===== Section: Shell and step routing =====

  /** Header (close, progress, combo) + stage containers. */
  function buildShell() {
    barEl = h("span", { style: { width: "0%" } });
    comboEl = h("div", { class: "combo", "aria-live": "off" });
    topEl = h("div", { class: "stage-top" });
    bottomEl = h("div", { class: "stage-bottom", "aria-live": "polite" });
    stageEl = h("div", { class: "stage" }, topEl, bottomEl);
    clear(root).append(h("div", { class: "session quiz" },
      h("header", { class: "session-bar" },
        h("button", { type: "button", class: "icon-btn", id: "close-session", "aria-label": "Close lesson", onclick: onClose }, "✕"),
        h("div", { class: "bar", role: "progressbar", "aria-label": "Lesson progress", "aria-valuemin": 0, "aria-valuemax": 100 }, barEl),
        comboEl),
      stageEl));
  }

  function updateBar() {
    const pct = Math.round((idx / plan.steps.length) * 100);
    barEl.style.width = `${pct}%`;
    barEl.parentElement.setAttribute("aria-valuenow", pct);
    const on = S.combo >= 3;
    comboEl.classList.toggle("on", on);
    comboEl.textContent = on ? `🔥 ×${S.combo}` : "";
  }

  /** Reset per-step state and show step `idx`. */
  function showStep() {
    clearTimeout(advanceTimer);
    stop();
    cleanups.forEach((f) => f()); cleanups = [];
    replayFn = () => {};
    if (idx >= plan.steps.length) { showSummary(); return; }
    updateBar();
    clear(topEl); clear(bottomEl);
    stageEl.scrollTop = 0;
    const step = plan.steps[idx];
    if (step.kind === "intro") introStep(step);
    else if (step.kind === "dialogue") dialogueStep(step);
    else questionStep(step);
  }

  function next() { idx++; showStep(); }

  /** Make the lock-screen play button replay the current prompt. */
  function setReplay(fn, meta) {
    replayFn = fn;
    setMediaHandlers({ play: () => replayFn(), pause: () => stop() });
    if (meta) setMediaMetadata(meta);
  }

  // ===== Section: Shared widgets =====

  /** Big round play button with ripple + optional slow button. */
  function playControl(onPlay, onSlow) {
    const wrap = h("div", { class: "play-wrap" },
      h("button", { type: "button", class: "play-btn", "aria-label": "Play again", onclick: onPlay }, icon("play", 48)));
    cleanups.push(onPlayingChange((p) => wrap.classList.toggle("playing", p)));
    return h("div", { class: "row" }, wrap,
      onSlow ? h("button", { type: "button", class: "icon-btn big", "aria-label": "Play slowly", title: "Slow", onclick: onSlow }, "🐢") : null);
  }

  /** Large pinyin line. */
  function pinyinLine(text) {
    return h("div", { class: `prompt-pinyin pinyin${text.length > 22 ? " long" : ""}`, lang: "zh-Latn-pinyin" }, text);
  }

  /** Build option buttons that call pick(index). */
  function optionButtons(options, pick) {
    return options.map((o, i) => h("button", { type: "button", class: "opt", dataset: { index: String(i) }, onclick: () => pick(i) }, o.label));
  }

  // ===== Section: Scoring =====

  /** Fold an apply* envelope into the session tallies and play sounds. */
  function record(res, correct) {
    S.touched = true;
    S.answered++;
    if (correct) { S.correct++; S.combo++; S.best = Math.max(S.best, S.combo); } else S.combo = 0;
    S.xp += res.xpGained;
    S.events.push(...res.events);
    if (res.events.some((e) => e.type === "levelUp")) { playSfx("correct"); setTimeout(() => playSfx("levelUp"), 350); }
    else playSfx(correct ? "correct" : "wrong");
    updateBar();
  }

  // ===== Section: Feedback panel =====

  /**
   * Replace the answer area with the feedback panel.
   * @param {Object} o
   * @param {boolean} o.correct
   * @param {number} o.xp
   * @param {string} o.english Correct English (or answer text).
   * @param {string} [o.pinyin]
   * @param {string} [o.hanzi]
   * @param {string} [o.hint]
   * @param {string} [o.note]  Extra line, e.g. what the learner chose.
   * @param {HTMLElement} [o.transcript]
   * @param {() => void} o.replay
   * @param {() => void} o.onNext
   */
  function showFeedback(o) {
    const showPy = pinyinMode() !== "never";
    const nextBtn = h("button", { type: "button", class: "btn primary", id: "next-btn", onclick: () => { clearTimeout(advanceTimer); o.onNext(); } },
      o.correct ? "Next" : "Continue");
    const panel = h("div", { class: `feedback ${o.correct ? "ok" : "miss"}`, role: "status" },
      h("div", { class: "fb-verdict" }, h("span", null, o.correct ? "✓ Correct" : "Not quite"), h("span", { class: "xp-chip" }, `+${o.xp} XP`)),
      h("div", { class: "fb-en" }, o.english),
      showPy && o.pinyin ? h("div", { class: "fb-py pinyin" }, o.pinyin) : null,
      o.hanzi ? h("div", { class: "fb-hz hanzi" }, o.hanzi) : null,
      o.note ? h("div", { class: "fb-you" }, o.note) : null,
      o.hint ? h("div", { class: "fb-hint" }, o.hint) : null,
      o.transcript || null,
      h("div", { class: "fb-actions" },
        h("button", { type: "button", class: "icon-btn", "aria-label": "Replay", onclick: () => { clearTimeout(advanceTimer); o.replay(); } }, icon("replay", 24)),
        nextBtn));
    put(clear(bottomEl), panel);
    nextBtn.focus({ preventScroll: true });
    if (o.correct && getSetting("autoAdvance") !== false) advanceTimer = setTimeout(() => { if (!disposed) o.onNext(); }, AUTO_ADVANCE_MS);
  }

  // ===== Section: Step — intro =====

  function introStep(step) {
    const item = curriculum.items.get(step.itemId);
    const mode = pinyinMode();
    const playBoth = () => playSequence([`${item.id}.slow`, item.id]);
    setReplay(playBoth, { title: item.pinyin, artist: item.english, album: `听 Tīng · ${curriculum.unitOf(item.id)?.title || ""}` });
    put(topEl, 
      h("span", { class: "badge" }, "New"),
      mode === "never" ? h("div", { class: "intro-hanzi big hanzi" }, item.hanzi) : h("div", { class: "intro-pinyin pinyin" }, item.pinyin),
      h("div", { class: "intro-en" }, item.english),
      item.hint ? h("p", { class: "intro-hint" }, item.hint) : null,
      mode === "never" ? null : h("div", { class: "intro-hanzi hanzi" }, item.hanzi),
      playControl(playBoth, () => playClip(item.id, { slow: true })));
    put(bottomEl, h("button", { type: "button", class: "btn primary block", id: "got-it", onclick: () => {
      const res = commit(applyIntro(store.progress, { itemId: item.id, now: Date.now(), curriculum }));
      S.touched = true; S.xp += res.xpGained; S.events.push(...res.events);
      if (!S.newItems.includes(item)) S.newItems.push(item);
      next();
    } }, "Got it"));
    // WHY: the intro plays slow then normal automatically, like a teacher saying the word twice.
    playBoth();
  }

  // ===== Section: Step — item questions =====

  function questionStep(step) {
    const q = makeQuestion(step.qtype, step.itemId, curriculum, store.progress, rng);
    const item = curriculum.items.get(q.itemId);
    let answered = false;

    /** Score an item answer and show feedback. */
    const answer = (chosen, extra = {}) => {
      if (answered) return;
      answered = true;
      stop();
      const correct = chosen === q.answerIndex;
      const res = commit(applyAnswer(store.progress, { itemId: item.id, correct, now: Date.now(), combo: correct ? S.combo + 1 : 0, curriculum }));
      record(res, correct);
      if (!correct) plan = requeue(plan, idx, step, rng);
      showFeedback({
        correct, xp: res.xpGained, english: item.english, pinyin: item.pinyin, hanzi: item.hanzi, hint: item.hint,
        note: extra.note !== undefined ? extra.note : (!correct && q.options[chosen] ? `You chose: ${q.options[chosen].label}` : ""),
        replay: () => playClip(item.id), onNext: next,
      });
      updateBar();
    };

    const meta = { title: item.pinyin, artist: item.english, album: `听 Tīng · ${curriculum.unitOf(item.id)?.title || ""}` };
    const showPyNow = pinyinMode() === "always";

    if (q.qtype === "meaning-audio") {
      let selected = -1;
      const check = h("button", { type: "button", class: "btn primary block", id: "check-btn", disabled: true, onclick: () => answer(selected) }, "Check");
      const rows = q.options.map((o, i) => h("button", { type: "button", class: "opt opt-row", dataset: { index: String(i) },
        onclick: () => {
          selected = i;
          rows.forEach((r, j) => r.classList.toggle("selected", j === i));
          check.disabled = false;
          playClip(o.clip);
        } }, icon("play", 22), showPyNow ? h("span", { class: "pinyin" }, o.label) : `Option ${"ABC"[i]}`));
      setReplay(() => {}, { title: "Which one means…", artist: q.prompt.text, album: "听 Tīng" });
      put(topEl, h("div", { class: "prompt-label" }, "Which one means…"), h("div", { class: "prompt-en" }, q.prompt.text),
        h("div", { class: "prompt-label" }, "Tap a row to listen, then check."));
      put(bottomEl, ...rows, check);
      return;
    }

    const play = () => playClip(q.prompt.clip);
    setReplay(play, meta);

    if (q.qtype === "true-false") {
      put(topEl, playControl(play, () => playClip(q.prompt.clip, { slow: true })),
        showPyNow ? pinyinLine(item.pinyin) : null,
        h("p", { class: "statement" }, "Does it mean: ", h("b", null, q.prompt.text), "?"));
      const shown = curriculum.items.get(q.shownItemId);
      const note = q.isTrue ? "" : `It doesn't mean “${shown.english}”.`;
      put(bottomEl, h("div", { class: "tf-pair" },
        h("button", { type: "button", class: "opt tf", "aria-label": "Yes, it means that", dataset: { index: "0" }, onclick: () => answer(0, { note }) }, "✓"),
        h("button", { type: "button", class: "opt tf", "aria-label": "No, it does not mean that", dataset: { index: "1" }, onclick: () => answer(1, { note }) }, "✗")));
      play();
      return;
    }

    // listen-meaning
    put(topEl, playControl(play, () => playClip(q.prompt.clip, { slow: true })),
      showPyNow ? pinyinLine(item.pinyin) : null,
      h("div", { class: "prompt-label" }, "What does it mean?"));
    put(bottomEl, ...optionButtons(q.options, (i) => answer(i)));
    play();
  }

  // ===== Section: Step — dialogue =====

  function dialogueStep(step) {
    const dlg = curriculum.dialogues.get(step.dialogueId);
    const convClips = (dlg.lines || []).flatMap((_, i) => [`${dlg.id}.l${i + 1}`, "sys.silence.500"]);
    let qi = 0;

    /** Transcript (pinyin + English + small hanzi) for the feedback panel. */
    const transcript = () => h("ol", { class: "transcript fb-transcript" }, (dlg.lines || []).map((l) =>
      h("li", null, h("span", { class: "who" }, l.speaker),
        h("div", null, pinyinMode() !== "never" ? h("div", { class: "py pinyin" }, l.pinyin) : null,
          h("div", { class: "en" }, l.english), h("div", { class: "hz hanzi" }, l.hanzi)))));

    function showQuestion() {
      clearTimeout(advanceTimer); stop();
      clear(topEl); clear(bottomEl);
      const q = makeDialogueQuestion(step.questionIds[qi], curriculum, rng);
      const isLast = qi === step.questionIds.length - 1;
      let answered = false;
      const playAll = () => playSequence([...convClips, q.prompt.questionClip]);
      setReplay(playAll, { title: dlg.title, artist: q.prompt.text, album: `听 Tīng · ${curriculum.unitOf(dlg.id)?.title || ""}` });
      put(topEl, h("div", { class: "prompt-label" }, step.questionIds.length > 1 ? `Conversation · question ${qi + 1} of ${step.questionIds.length}` : "Conversation"),
        playControl(playAll), h("div", { class: "prompt-en" }, q.prompt.text),
        h("button", { type: "button", class: "btn small ghost", id: "replay-conv", onclick: () => playSequence(convClips) }, icon("replay", 20), "Replay conversation"));
      put(bottomEl, ...optionButtons(q.options, (i) => {
        if (answered) return;
        answered = true;
        stop();
        const correct = i === q.answerIndex;
        const res = commit(applyDialogueAnswer(store.progress, { dialogueId: dlg.id, correct, now: Date.now(), combo: correct ? S.combo + 1 : 0, countPlay: qi === 0, curriculum }));
        record(res, correct);
        showFeedback({
          correct, xp: res.xpGained, english: q.options[q.answerIndex].label,
          note: !correct ? `You chose: ${q.options[i].label}` : "",
          // WHY: transcript only after the final question (comprehension test, see header).
          transcript: isLast ? transcript() : null,
          replay: () => playSequence(convClips),
          onNext: () => { if (isLast) next(); else { qi++; showQuestion(); } },
        });
      }));
      // First question: whole conversation then the question. Later ones: just the question.
      if (qi === 0) playAll(); else playClip(q.prompt.questionClip);
    }
    showQuestion();
  }

  // ===== Section: Summary =====

  function eventLines() {
    const lines = [];
    for (const e of S.events) {
      if (e.type === "levelUp") lines.push(`🎉 Level ${e.level}: ${e.title} ${e.titleEn}`);
      else if (e.type === "goalReached") lines.push("🎯 Daily goal reached");
      else if (e.type === "streak") lines.push(`🔥 ${e.current}-day streak`);
      else if (e.type === "unitUnlocked") lines.push(`🔓 Unit unlocked: ${curriculum.unit(e.unitId)?.title || e.unitId}`);
    }
    return [...new Set(lines)];
  }

  function showSummary() {
    finishOnce();
    clearMediaSession();
    updateBar();
    const acc = S.answered ? Math.round((S.correct / S.answered) * 100) : null;
    const ev = eventLines();
    clear(root).append(h("div", { class: "summary", id: "summary" },
      h("div", { class: "row" }, h("span", { class: "seal large", "aria-hidden": "true" }, "听")),
      h("h1", null, acc != null && acc >= 80 ? "Lesson complete. Nice listening!" : "Lesson complete"),
      h("div", { class: "stat-grid" },
        h("div", { class: "stat" }, h("b", { id: "sum-xp" }, `+${S.xp}`), h("span", null, "XP earned")),
        h("div", { class: "stat" }, h("b", null, acc == null ? "—" : `${acc}%`), h("span", null, "Accuracy")),
        h("div", { class: "stat" }, h("b", null, S.best), h("span", null, "Best combo")),
        h("div", { class: "stat" }, h("b", null, S.newItems.length), h("span", null, "New words"))),
      S.newItems.length ? h("div", { class: "chips", "aria-label": "New words" }, S.newItems.map((it) => h("span", { class: "chip" }, h("span", { class: "pinyin" }, it.pinyin), ` ${it.english}`))) : null,
      ev.length ? h("ul", { class: "event-list" }, ev.map((l) => h("li", null, l))) : null,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn primary block", id: "another", onclick: start }, "Another lesson"),
        h("a", { class: "btn block", href: "#/home", id: "to-home" }, "Home"))));
  }

  function showEmpty() {
    clear(root).append(h("div", { class: "center-screen" },
      h("span", { class: "seal large", "aria-hidden": "true" }, "听"),
      h("h1", null, "Nothing to practise yet"),
      h("p", null, "There are no lessons available here yet. Try another unit."),
      h("a", { class: "btn primary", href: "#/units" }, "Browse units")));
  }

  start();

  return () => {
    disposed = true;
    clearTimeout(advanceTimer);
    cleanups.forEach((f) => f());
    finishOnce();
    stop();
    clearMediaSession();
  };
}
