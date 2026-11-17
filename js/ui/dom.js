/**
 * dom.js — tiny DOM helpers shared by every screen.
 *
 * Purpose
 *   Build elements without innerHTML (content strings are never parsed as
 *   HTML, so lesson text cannot inject markup), plus a few shared widgets:
 *   modal confirm, toast, segmented control, stacked status bar, stars, icons.
 *
 * How it fits
 *   Imported by main.js and every file in js/ui/. Depends on nothing else, so
 *   it can be loaded first. Styles for the widgets live in css/app.css
 *   ("Components" section).
 *
 * Key concepts
 *   - h(tag, attrs, ...children) is the only element builder. `class`, `style`
 *     (object), `dataset`, `on<Event>` handlers and boolean attributes are
 *     handled; everything else is set as an attribute.
 *   - confirmModal() replaces window.confirm: it is styled, thumb-friendly and
 *     works in automated tests (native dialogs are auto-dismissed there).
 *
 * Public API
 *   h, svg, clear, fmtTime, fmtMinutes, pct, icon, stars, statusBar,
 *   segmented, confirmModal, toast, STATUS_LABEL
 */

// ===== Section: Element builders =====

const SVG_NS = "http://www.w3.org/2000/svg";

/** Append children (strings, nodes, arrays, null) to a parent. */
function appendAll(parent, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendAll(parent, c);
    else parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Apply an attribute bag to an element (shared by h and svg). */
function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
}

/**
 * Create an HTML element.
 * @param {string} tag Tag name, optionally with classes: "button.btn.primary".
 * @param {Object|null} [attrs] Attributes / handlers.
 * @param {...(Node|string|number|null|Array)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  // WHY: "div.card.big" shorthand keeps screen code compact and readable.
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  applyAttrs(el, attrs);
  if (attrs && attrs.class && classes.length) el.className = `${classes.join(" ")} ${attrs.class}`;
  appendAll(el, children);
  return el;
}

/**
 * Create an SVG element (namespace-aware version of h).
 * @param {string} tag
 * @param {Object|null} [attrs]
 * @param {...(Node|string|number|null|Array)} children
 * @returns {SVGElement}
 */
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  appendAll(el, children);
  return el;
}

/**
 * Remove all children of a node.
 * @param {Node} node
 * @returns {Node} The same node.
 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ===== Section: Formatters =====

/**
 * Seconds -> "m:ss".
 * @param {number} sec
 * @returns {string}
 */
export function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Minutes (float) -> "12 min" / "1.5 min" / "< 1 min".
 * @param {number} min
 * @returns {string}
 */
export function fmtMinutes(min) {
  if (min <= 0) return "0 min";
  if (min < 1) return "< 1 min";
  return `${Math.round(min * 10) / 10} min`;
}

/**
 * Fraction (0..1) or null -> "85%" / "—".
 * @param {number|null} f
 * @returns {string}
 */
export function pct(f) {
  return f == null ? "—" : `${Math.round(f * 100)}%`;
}

/** Display labels for the srs.js status buckets. */
export const STATUS_LABEL = { new: "New", learning: "Learning", familiar: "Familiar", mastered: "Mastered" };

// ===== Section: Icons =====

/** 24x24 stroke/fill icon paths. Kept inline so the app needs no image assets. */
const ICONS = {
  home: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  units: "M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v6H4zM13 14h7v6h-7z",
  stats: "M5 20V11M12 20V4M19 20v-6",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6",
  play: "M8 5.5v13l11-6.5z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  next: "M6 5.5v13l9-6.5zM17 5h2v14h-2z",
  prev: "M18 5.5v13L9 12zM5 5h2v14H5z",
  replay: "M5 12a7 7 0 1 1 2.2 5.1M5 12V6.5M5 12h5.5",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6L6 18",
  headphones: "M4 15v-3a8 8 0 0 1 16 0v3M4 15h3.5v5H5.5A1.5 1.5 0 0 1 4 18.5zM20 15h-3.5v5h2a1.5 1.5 0 0 0 1.5-1.5z",
  download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14",
};
const FILLED = new Set(["play", "pause", "next", "prev"]);

/**
 * Inline SVG icon.
 * @param {keyof typeof ICONS} name
 * @param {number} [size=24]
 * @returns {SVGElement}
 */
export function icon(name, size = 24) {
  const filled = FILLED.has(name);
  return svg("svg", {
    viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", class: "icon",
    fill: filled ? "currentColor" : "none", stroke: filled ? "none" : "currentColor",
    "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
  }, svg("path", { d: ICONS[name] }));
}

// ===== Section: Shared widgets =====

/**
 * Three-star rating row.
 * @param {number} n 0..3 filled stars.
 * @returns {HTMLElement}
 */
export function stars(n) {
  return h("span", { class: "stars", role: "img", "aria-label": `${n} of 3 stars` },
    [1, 2, 3].map((i) => h("span", { class: i <= n ? "star on" : "star", "aria-hidden": "true" }, "★")));
}

/**
 * Stacked horizontal bar of item statuses (+ optional legend).
 * @param {{new:number, learning:number, familiar:number, mastered:number}} counts
 * @param {{legend?: boolean}} [opts]
 * @returns {HTMLElement}
 */
export function statusBar(counts, { legend = false } = {}) {
  const total = counts.new + counts.learning + counts.familiar + counts.mastered || 1;
  const order = ["mastered", "familiar", "learning", "new"];
  const bar = h("div", { class: "statusbar", role: "img",
    "aria-label": order.map((k) => `${counts[k]} ${k}`).join(", ") },
  order.map((k) => counts[k] ? h("span", { class: `seg ${k}`, style: { flexGrow: String(counts[k] / total) } }) : null));
  if (!legend) return bar;
  return h("div", { class: "statusbar-wrap" }, bar,
    h("ul", { class: "legend" }, order.map((k) =>
      h("li", null, h("span", { class: `dot ${k}`, "aria-hidden": "true" }), `${STATUS_LABEL[k]} `, h("b", null, counts[k])))));
}

/**
 * Segmented control (radio group) with big tap targets.
 * @param {Array<{value: any, label: string}>} options
 * @param {any} value Currently selected value.
 * @param {(v: any) => void} onChange
 * @param {string} label Accessible group label.
 * @returns {HTMLElement}
 */
export function segmented(options, value, onChange, label) {
  const group = h("div", { class: "segmented", role: "radiogroup", "aria-label": label });
  const paint = (v) => {
    for (const b of group.children) {
      const on = b.dataset.value === String(v);
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.classList.toggle("on", on);
    }
  };
  for (const o of options) {
    group.append(h("button", {
      type: "button", role: "radio", class: "seg-btn", dataset: { value: String(o.value) },
      onclick: () => { paint(o.value); onChange(o.value); },
    }, o.label));
  }
  paint(value);
  return group;
}

// ===== Section: Modal and toast =====

/**
 * Show a modal confirmation and resolve with the user's choice.
 * WHY: window.confirm() blocks audio/timers, looks out of place on mobile and
 * is auto-dismissed by test browsers; this is a real in-page dialog.
 * @param {{title: string, body?: string, confirmText?: string, cancelText?: string, danger?: boolean}} o
 * @returns {Promise<boolean>} true when confirmed.
 */
export function confirmModal({ title, body = "", confirmText = "OK", cancelText = "Cancel", danger = false }) {
  const root = document.getElementById("modal-root");
  const previouslyFocused = document.activeElement;
  return new Promise((resolve) => {
    const close = (v) => {
      root.removeEventListener("keydown", onKey);
      clear(root);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    const ok = h("button", { type: "button", class: `btn ${danger ? "danger" : "primary"} modal-ok`, onclick: () => close(true) }, confirmText);
    const cancel = h("button", { type: "button", class: "btn ghost modal-cancel", onclick: () => close(false) }, cancelText);
    const dlg = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "modal-title" },
      h("h2", { id: "modal-title" }, title),
      body ? h("p", null, body) : null,
      h("div", { class: "modal-actions" }, cancel, ok));
    clear(root).append(h("div", { class: "scrim", onclick: (e) => { if (e.target === e.currentTarget) close(false); } }, dlg));
    root.addEventListener("keydown", onKey);
    // WHY: focus the safe choice (cancel) first so a stray Enter never destroys data.
    cancel.focus();
  });
}

let toastTimer = 0;
/**
 * Show a short message at the bottom of the screen.
 * @param {string} message
 * @param {number} [ms=2600]
 */
export function toast(message, ms = 2600) {
  const root = document.getElementById("modal-root");
  let t = root.querySelector(".toast");
  if (!t) { t = h("div", { class: "toast", role: "status" }); root.append(t); }
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
