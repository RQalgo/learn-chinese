/**
 * offline.js — ask the service worker to cache audio clips for offline use.
 *
 * Purpose
 *   Power the unit screen's "Download audio for offline" button: send the
 *   list of clip URLs to sw.js and report progress back.
 *
 * How it fits
 *   ui/unit.js calls downloadClips(urls, onProgress). The protocol is shared
 *   with sw.js: page -> SW {type:"cacheClips", id, urls};
 *   SW -> page {type:"cacheProgress", id, done, total, failed, finished}.
 *
 * Key concepts
 *   - Works only when a service worker is active (secure context / localhost).
 *   - Resolves when the SW reports `finished`; a safety timeout prevents a
 *     hung button if the SW is killed mid-download.
 *
 * Public API
 *   offlineSupported(), downloadClips(urls, onProgress)
 */

// ===== Section: Public API =====

/**
 * Is a service worker available for offline caching?
 * @returns {boolean}
 */
export function offlineSupported() {
  return "serviceWorker" in navigator;
}

/**
 * Cache the given audio URLs through the service worker.
 * @param {string[]} urls Relative clip URLs (from the audio manifest `src`).
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{done: number, failed: number, total: number}>}
 * @throws {Error} When no service worker is active.
 */
export async function downloadClips(urls, onProgress = () => {}) {
  if (!offlineSupported()) throw new Error("Offline downloads need a service worker, which this browser does not provide.");
  const reg = await navigator.serviceWorker.ready;
  const worker = reg.active;
  if (!worker) throw new Error("The offline service is not active yet. Reload the app and try again.");
  const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // WHY: the SW resolves relative URLs against its own location; sending absolute
  // URLs avoids any ambiguity when the app is served from a sub-path.
  const absolute = urls.map((u) => new URL(u, document.baseURI).href);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("The download timed out.")); }, 120000);
    const onMsg = (e) => {
      const m = e.data;
      if (!m || m.type !== "cacheProgress" || m.id !== id) return;
      onProgress(m.done, m.total);
      if (m.finished) { cleanup(); resolve({ done: m.done, failed: m.failed, total: m.total }); }
    };
    const cleanup = () => { clearTimeout(timeout); navigator.serviceWorker.removeEventListener("message", onMsg); };
    navigator.serviceWorker.addEventListener("message", onMsg);
    worker.postMessage({ type: "cacheClips", id, urls: absolute });
  });
}
