/**
 * units.js — Units list (#/units).
 *
 * Purpose
 *   Show every unit with its emoji, title, description, stars, progress bar and
 *   lock state, and link to the unit detail screen.
 *
 * How it fits
 *   Registered by main.js. Reads store.curriculum / store.progress and
 *   state/progress.js (unitStats). Links to #/unit/:id.
 *
 * Key concepts
 *   - Locked units are still tappable (the detail screen offers "Unlock early").
 *   - Units whose content file failed to load are greyed out and not tappable.
 *
 * Public API
 *   render(root) -> void
 */

import { h, icon, stars, statusBar } from "./dom.js";
import { store } from "./store.js";
import { unitStats } from "../state/progress.js";

/**
 * Render the Units screen.
 * @param {HTMLElement} root
 */
export function render(root) {
  const { curriculum, progress } = store;
  const list = h("ul", { class: "unit-list" }, curriculum.units.map((u) => {
    const locked = !progress.unlocked.includes(u.id);
    const s = unitStats(progress, curriculum, u.id);
    const cls = `unit-row${locked ? " locked" : ""}${u.available ? "" : " unavailable"}`;
    const label = `${u.title}${locked ? ", locked" : ""}${u.available ? "" : ", not available"}`;
    return h("li", null, h("a", { class: cls, href: `#/unit/${u.id}`, "aria-label": label, dataset: { unit: u.id } },
      h("span", { class: "emoji", "aria-hidden": "true" }, u.emoji || "📘"),
      h("div", null, h("h3", null, u.title), h("p", null, u.description || ""), u.available ? statusBar(s) : null),
      h("div", { class: "right" }, locked ? icon("lock", 20) : stars(s.stars), u.available ? `${s.total - s.new}/${s.total}` : "soon")));
  }));
  root.append(h("div", { class: "page" }, h("h1", { class: "page-title" }, "Units"),
    h("p", { class: "page-sub" }, "Each unit unlocks when you know about 70% of the one before."), list));
}
