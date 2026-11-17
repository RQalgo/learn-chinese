/**
 * main.js — app boot.
 *
 * Purpose
 *   Load content and progress, wire the router and tab bar, register the
 *   service worker. Everything else lives in js/ui/*.
 *
 * How it fits
 *   Loaded by index.html. Calls data/loader.js (content), ui/store.js (state),
 *   audio/player.js (configure), router.js (screens) and each ui/<screen>.js
 *   render(root, ctx) function. Shows a friendly error screen if content
 *   cannot be loaded.
 *
 * Key concepts
 *   - Session screens (quiz, listen) hide the tab bar (route meta `session`).
 *   - Screens return an optional dispose() that the router calls on leave.
 *
 * Public API
 *   none (entry point).
 */

import { loadContent } from "./data/loader.js";
import { initStore, onClipsChange, store } from "./ui/store.js";
import { configurePlayer, stop as stopAudio, clearMediaSession } from "./audio/player.js";
import { route, startRouter } from "./router.js";
import { h, icon, clear } from "./ui/dom.js";
import * as home from "./ui/home.js";
import * as units from "./ui/units.js";
import * as unit from "./ui/unit.js";
import * as quiz from "./ui/quiz.js";
import * as listen from "./ui/listen.js";
import * as stats from "./ui/stats.js";
import * as settings from "./ui/settings.js";

// ===== Section: Tab bar =====

const TABS = [
  { id: "home", label: "Home", href: "#/home", icon: "home" },
  { id: "units", label: "Units", href: "#/units", icon: "units" },
  { id: "stats", label: "Stats", href: "#/stats", icon: "stats" },
  { id: "settings", label: "Settings", href: "#/settings", icon: "settings" },
];

/** Build the (static) tab bar once. */
function buildTabbar(nav) {
  clear(nav).append(...TABS.map((t) =>
    h("a", { class: "tab", href: t.href, dataset: { tab: t.id } }, icon(t.icon, 26), t.label)));
}

/** Show/hide the tab bar and mark the current tab. */
function onRouteChange(meta) {
  const nav = document.getElementById("tabbar");
  nav.hidden = !!meta.session;
  for (const a of nav.children) {
    if (a.dataset.tab === meta.tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

// ===== Section: Error screen =====

/**
 * Friendly full-screen error with a retry button.
 * @param {HTMLElement} root
 * @param {Error} err
 */
function showError(root, err) {
  clear(root).append(h("div", { class: "center-screen", role: "alert" },
    h("span", { class: "seal large", "aria-hidden": "true" }, "听"),
    h("h1", null, "The lessons didn't load"),
    h("p", null, "Check your internet connection and try again. Once loaded, the app also works offline."),
    h("p", { class: "muted" }, String(err && err.message || err)),
    h("button", { class: "btn primary", type: "button", onclick: () => location.reload() }, "Try again")));
}

// ===== Section: Service worker =====

/** Register sw.js (relative URL, scope = app folder). Failure is not fatal. */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker not registered:", e.message));
}

// ===== Section: Boot =====

async function boot() {
  const root = document.getElementById("screen");
  let content;
  try {
    content = await loadContent();
  } catch (e) {
    console.error(e);
    showError(root, e);
    return;
  }
  initStore(content);
  configurePlayer({ clips: store.clips, curriculum: store.curriculum });
  // WHY: switching the Mandarin accent in Settings swaps the clip table without a reload.
  onClipsChange(() => configurePlayer({ clips: store.clips, curriculum: store.curriculum }));

  buildTabbar(document.getElementById("tabbar"));
  route("/home", home.render, { tab: "home" });
  route("/units", units.render, { tab: "units" });
  route("/unit/:id", unit.render, { tab: "units" });
  route("/quiz", quiz.render, { session: true });
  route("/listen", listen.render, { session: true });
  route("/stats", stats.render, { tab: "stats" });
  route("/settings", settings.render, { tab: "settings" });
  startRouter(root, { onChange: onRouteChange, notFound: () => { location.hash = "#/home"; } });

  // WHY: leaving the page (or locking and closing the tab) should not leave speech queued.
  window.addEventListener("pagehide", () => { stopAudio(); clearMediaSession(); });
  registerServiceWorker();
}

boot();
