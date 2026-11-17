/**
 * home.js — Home screen (#/home).
 *
 * Purpose
 *   Show today's status (streak, level/XP, daily goal) and the two ways to
 *   practise: a tap-to-answer Lesson and the hands-free Commute mode.
 *
 * How it fits
 *   Registered by main.js. Reads progress via ui/store.js and
 *   state/progress.js (levelInfo, effectiveStreak, overallStats, unitStats).
 *   Links to #/quiz, #/listen and #/unit/:id.
 *
 * Key concepts
 *   - The two action buttons sit at the bottom of the screen (thumb zone).
 *   - "Current unit" = earliest available, unlocked unit that is not fully mastered.
 *
 * Public API
 *   render(root) -> void
 */

import { h, svg, icon, stars, statusBar } from "./dom.js";
import { store } from "./store.js";
import { levelInfo, effectiveStreak, unitStats, overallStats } from "../state/progress.js";
import { QUIZ_LENGTHS } from "../engine/session.js";

// ===== Section: Pieces =====

/**
 * Daily goal progress ring.
 * @param {number} xp
 * @param {number} goal
 * @returns {HTMLElement}
 */
function goalRing(xp, goal) {
  const r = 42, c = 2 * Math.PI * r;
  const frac = Math.min(1, goal ? xp / goal : 0);
  const met = xp >= goal;
  return h("div", { class: `ring${met ? " met" : ""}`, role: "img", "aria-label": `Daily goal: ${xp} of ${goal} XP` },
    svg("svg", { viewBox: "0 0 100 100", width: 96, height: 96, "aria-hidden": "true" },
      svg("circle", { class: "track", cx: 50, cy: 50, r, fill: "none", "stroke-width": 9 }),
      svg("circle", { class: "fill", cx: 50, cy: 50, r, fill: "none", "stroke-width": 9,
        "stroke-dasharray": c.toFixed(1), "stroke-dashoffset": (c * (1 - frac)).toFixed(1) })),
    h("div", { class: "label" }, met ? h("b", null, "✓") : h("b", null, xp), h("span", null, `/ ${goal} XP`)));
}

// ===== Section: Screen =====

/**
 * Render the Home screen.
 * @param {HTMLElement} root
 */
export function render(root) {
  const { curriculum, progress } = store;
  const now = Date.now();
  const ov = overallStats(progress, curriculum, now);
  const lv = levelInfo(progress.xp);
  const streak = effectiveStreak(progress, now);
  const firstTime = progress.xp === 0 && ov.answered === 0;
  const lessonLen = QUIZ_LENGTHS[progress.settings.sessionLength] || QUIZ_LENGTHS.normal;

  const current = curriculum.units.find((u) => {
    if (!u.available || !progress.unlocked.includes(u.id)) return false;
    const s = unitStats(progress, curriculum, u.id);
    return s.total > 0 && s.mastered < s.total;
  });

  const page = h("div", { class: "page" },
    h("header", { class: "home-head" },
      h("div", { class: "brand" }, h("span", { class: "seal", "aria-hidden": "true" }, "听"),
        h("div", null, "Tīng", h("small", null, "Listen. Understand."))),
      h("div", { class: `streak${streak ? "" : " off"}`, "aria-label": `${streak} day streak` }, "🔥", h("span", null, streak))),

    h("section", { class: "card status-card", "aria-label": "Today" },
      goalRing(ov.goalToday.xp, ov.goalToday.goal),
      h("div", null,
        h("div", { class: "level-line" }, h("span", { class: "lv" }, `Level ${lv.level}`),
          h("span", { class: "hanzi" }, lv.title), h("span", { class: "muted" }, lv.titleEn)),
        h("div", { class: "bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": lv.xpForNext, "aria-valuenow": lv.xpIntoLevel, "aria-label": "XP to next level" },
          h("span", { style: { width: `${Math.round(lv.fraction * 100)}%` } })),
        h("p", { class: "xp-note" }, `${lv.xpForNext - lv.xpIntoLevel} XP to level ${lv.level + 1}`))),

    current ? (() => {
      const s = unitStats(progress, curriculum, current.id);
      return h("a", { class: "card unit-card", href: `#/unit/${current.id}`, "aria-label": `Current unit: ${current.title}` },
        h("span", { class: "emoji", "aria-hidden": "true" }, current.emoji || "📘"),
        h("div", { class: "grow" }, h("h3", null, current.title),
          h("p", { class: "muted", style: { fontSize: ".85rem", margin: "2px 0 8px" } }, `${s.total - s.new} of ${s.total} heard`),
          statusBar(s)),
        stars(s.stars));
    })() : null,

    firstTime ? h("p", { class: "tip" }, "New here? Put your earphones in, tap Lesson, and pick what you hear. No speaking needed.") : null,

    h("div", { class: "actions" },
      h("a", { class: "action primary", href: "#/quiz", id: "start-lesson" },
        h("span", { class: "ico" }, icon("play", 26)),
        h("span", null, h("b", null, "Lesson"), h("span", { class: "sub" }, `~${lessonLen} questions · tap to answer`))),
      h("a", { class: "action", href: "#/listen", id: "start-commute" },
        h("span", { class: "ico" }, icon("headphones", 26)),
        h("span", null, h("b", null, "Commute mode"), h("span", { class: "sub" }, "8 min · hands-free, screen can be off")))));
  root.append(page);
}
