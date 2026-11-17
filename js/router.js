/**
 * router.js — minimal hash router.
 *
 * Purpose
 *   Map location.hash ("#/unit/u03", "#/quiz?unit=u01") to a screen render
 *   function and manage screen lifecycle (dispose of the previous screen).
 *
 * How it fits
 *   main.js registers routes with route() and calls startRouter(). Each screen
 *   module exports render(root, ctx) which may return a dispose() function;
 *   the router calls it before showing the next screen, which is how audio is
 *   stopped and timers cleared when the user navigates away.
 *
 * Key concepts
 *   - Patterns use ":param" segments: "/unit/:id".
 *   - ctx = { path, params, query } where query is a plain object.
 *   - Re-navigating to the SAME hash does not fire `hashchange`, so screens
 *     that want a restart (e.g. "Another lesson") restart themselves.
 *
 * Public API
 *   route(pattern, handler, meta), startRouter(root, {onChange, notFound}),
 *   navigate(hash), parseHash(hash), currentPath()
 */

// ===== Section: State =====

/** @type {Array<{pattern: string[], handler: Function, meta: Object}>} */
const routes = [];
let rootEl = null;
let disposeCurrent = null;
let hooks = {};

// ===== Section: Parsing =====

/**
 * Split a hash into path, params-free segments and query object.
 * @param {string} hash e.g. "#/quiz?unit=u01"
 * @returns {{path: string, query: Object<string,string>}}
 */
export function parseHash(hash) {
  const raw = (hash || "").replace(/^#/, "") || "/home";
  const [path, qs = ""] = raw.split("?");
  const query = {};
  for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  return { path: path || "/home", query };
}

/**
 * Current route path ("/home").
 * @returns {string}
 */
export function currentPath() { return parseHash(location.hash).path; }

/** Match a path against registered routes. */
function match(path) {
  const segs = path.split("/").filter(Boolean);
  for (const r of routes) {
    if (r.pattern.length !== segs.length) continue;
    const params = {};
    let ok = true;
    r.pattern.forEach((p, i) => {
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segs[i]);
      else if (p !== segs[i]) ok = false;
    });
    if (ok) return { route: r, params };
  }
  return null;
}

// ===== Section: Public API =====

/**
 * Register a screen.
 * @param {string} pattern e.g. "/unit/:id"
 * @param {(root: HTMLElement, ctx: {path: string, params: Object, query: Object}) => (void|(() => void))} handler
 * @param {{session?: boolean, tab?: string}} [meta] session: hide the tab bar; tab: which tab to highlight.
 */
export function route(pattern, handler, meta = {}) {
  routes.push({ pattern: pattern.split("/").filter(Boolean), handler, meta });
}

/**
 * Go to a hash route.
 * @param {string} hash e.g. "#/home"
 */
export function navigate(hash) { location.hash = hash; }

/** Render whatever the current hash points at. */
function renderCurrent() {
  const { path, query } = parseHash(location.hash);
  const m = match(path);
  if (disposeCurrent) { try { disposeCurrent(); } catch (e) { console.error(e); } disposeCurrent = null; }
  if (!m) { if (hooks.notFound) hooks.notFound(); else navigate("#/home"); return; }
  rootEl.replaceChildren();
  rootEl.scrollTop = 0;
  if (hooks.onChange) hooks.onChange(m.route.meta, path);
  const ret = m.route.handler(rootEl, { path, params: m.params, query });
  disposeCurrent = typeof ret === "function" ? ret : null;
}

/**
 * Start listening to hash changes and render the first screen.
 * @param {HTMLElement} root Element screens render into.
 * @param {{onChange?: (meta: Object, path: string) => void, notFound?: () => void}} [opts]
 */
export function startRouter(root, opts = {}) {
  rootEl = root;
  hooks = opts;
  window.addEventListener("hashchange", renderCurrent);
  renderCurrent();
}
