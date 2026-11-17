/**
 * stats.js — Stats screen (#/stats).
 *
 * Purpose
 *   Show how the learner is doing: level/XP, streaks, how many words are in
 *   each learning status, accuracy, listening time, a 14-day XP chart and
 *   per-unit progress.
 *
 * How it fits
 *   Registered by main.js. Everything numeric comes from
 *   state/progress.js (overallStats, levelInfo); this file only lays it out.
 *   The chart is hand-made inline SVG (no library).
 *
 * Key concepts
 *   - overallStats().series14 is oldest -> today. Bars at or above the daily
 *     goal are solid, others are faded; a dashed line marks the goal.
 *   - Empty state: with no activity yet we still draw the (empty) chart and
 *     explain how to get data, instead of showing a wall of zeros.
 *
 * Public API
 *   render(root) -> void
 */

import { h, svg, stars, statusBar, fmtMinutes, pct } from "./dom.js";
import { store } from "./store.js";
import { overallStats } from "../state/progress.js";

// ===== Section: Chart =====

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * 14-day XP bar chart as inline SVG.
 * @param {Array<{day: string, xp: number, goalMet: boolean}>} series Oldest -> today.
 * @param {number} goal Daily goal XP.
 * @returns {SVGElement}
 */
function xpChart(series, goal) {
  const W = 336, H = 176, top = 18, bottom = 34;
  const plotH = H - top - bottom;
  const slot = W / series.length;
  const barW = Math.round(slot * 0.58);
  const maxV = Math.max(goal * 1.25, ...series.map((d) => d.xp), 10);
  const y = (v) => top + plotH * (1 - v / maxV);
  const summary = series.map((d) => `${d.day}: ${d.xp} XP`).join("; ");
  const chart = svg("svg", { class: "chart", id: "xp-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `XP per day for the last 14 days. Goal ${goal}. ${summary}` });
  // goal line
  chart.append(svg("line", { class: "goal", x1: 0, x2: W, y1: y(goal), y2: y(goal) }),
    svg("text", { x: 0, y: y(goal) - 4, "text-anchor": "start" }, `goal ${goal}`));
  series.forEach((d, i) => {
    const [yy, mm, dd] = d.day.split("-").map(Number);
    const cx = slot * i + slot / 2;
    const bh = d.xp > 0 ? Math.max(3, plotH * (d.xp / maxV)) : 2;
    const isToday = i === series.length - 1;
    chart.append(
      svg("rect", { class: d.goalMet ? "bar-on" : "bar-off", x: cx - barW / 2, y: top + plotH - bh, width: barW, height: bh, rx: 3 }, svg("title", null, `${d.day}: ${d.xp} XP`)),
      d.xp > 0 ? svg("text", { x: cx, y: top + plotH - bh - 3, "text-anchor": "middle", style: "font-size:9px" }, d.xp) : null,
      svg("text", { class: isToday ? "today" : "", x: cx, y: H - 18, "text-anchor": "middle" }, WEEKDAY[new Date(yy, mm - 1, dd).getDay()]),
      svg("text", { class: isToday ? "today" : "", x: cx, y: H - 6, "text-anchor": "middle", style: "font-size:9px" }, dd));
  });
  return chart;
}

// ===== Section: Screen =====

/**
 * Render the stats screen.
 * @param {HTMLElement} root
 */
export function render(root) {
  const { curriculum, progress } = store;
  const ov = overallStats(progress, curriculum, Date.now());
  const lv = ov.level;
  const empty = progress.xp === 0 && ov.answered === 0 && ov.listenMinutes === 0;
  const kpi = (value, label) => h("div", { class: "kpi" }, h("b", null, value), h("span", null, label));

  root.append(h("div", { class: "page" },
    h("h1", { class: "page-title" }, "Stats"),
    empty ? h("section", { class: "card empty", id: "stats-empty" }, h("p", null, "Nothing to show yet."),
      h("p", { class: "muted" }, "Finish a lesson or a commute session and your progress will appear here."),
      h("a", { class: "btn primary", style: { marginTop: "12px" }, href: "#/quiz" }, "Start a lesson")) : null,

    h("section", { class: "card" },
      h("div", { class: "level-line" }, h("span", { class: "lv" }, `Level ${lv.level}`), h("span", { class: "hanzi" }, lv.title), h("span", { class: "muted" }, lv.titleEn)),
      h("div", { class: "bar" }, h("span", { style: { width: `${Math.round(lv.fraction * 100)}%` } })),
      h("p", { class: "xp-note" }, `${ov.xp} XP in total · ${lv.xpForNext - lv.xpIntoLevel} to the next level`)),

    h("div", { class: "kpis" },
      kpi(`🔥 ${ov.streak}`, "Day streak"), kpi(ov.bestStreak, "Best streak"),
      kpi(pct(ov.accuracy7), "Accuracy, 7 days"), kpi(pct(ov.accuracy30), "Accuracy, 30 days"),
      kpi(fmtMinutes(ov.listenMinutes), "Time listening"), kpi(ov.answered, "Questions answered")),

    h("section", { class: "card" }, h("h2", null, `Your ${ov.totals.items} phrases`), statusBar(ov.totals, { legend: true })),

    h("section", { class: "card" }, h("h2", null, "XP, last 14 days"), xpChart(ov.series14, ov.goalToday.goal)),

    h("section", { class: "card" }, h("h2", null, "Units"),
      h("ul", { class: "unit-prog" }, ov.units.map((u) => {
        const unit = curriculum.unit(u.unitId);
        return h("li", null, h("span", { style: { fontSize: "1.3rem" } }, unit.emoji || "📘"),
          h("div", null, h("div", { class: "t" }, unit.title), unit.available ? statusBar(u) : h("span", { class: "muted" }, "not available")),
          unit.available ? stars(u.stars) : null);
      })))));
}
