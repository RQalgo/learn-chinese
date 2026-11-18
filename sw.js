/**
 * sw.js — service worker: offline app shell + audio cache (ARCHITECTURE §9).
 *
 * Purpose
 *   Make 听 Tīng work in MRT tunnels: the app files and lesson data are cached
 *   at install, and audio clips are cached as they are played or when the
 *   learner taps "Download audio for offline" on a unit.
 *
 * How it fits
 *   Registered by js/main.js (relative URL, scope = the app folder). The page
 *   talks to it through js/audio/offline.js with this message protocol:
 *     page -> SW : {type:"cacheClips", id, urls:[absoluteUrl…]}
 *     SW -> page : {type:"cacheProgress", id, done, total, failed, finished}
 *
 * Key concepts
 *   - Two caches: `ting-shell-v<VERSION>` (code/data, replaced on release) and
 *     `ting-audio-v1` (kept across releases: clips are large and rarely change).
 *   - Network-first for html/js/css/json, so updates arrive when online, with the
 *     cache as the offline fallback.
 *   - Cache-first for audio/ and audio-sg/ (the two accent sets). WHY range handling: media elements request audio
 *     with `Range` headers; a cached full response must be answered with a 206
 *     slice or Chrome may refuse to play/seek it.
 *   - Bump VERSION on every release that changes the shell file list (and keep
 *     APP_VERSION in js/ui/store.js in step).
 *
 * Public API
 *   none (event handlers only)
 */

// ===== Section: Config =====

/** Bump to force clients to re-download the app shell. */
const VERSION = "4";
const SHELL_CACHE = `ting-shell-v${VERSION}`;
const AUDIO_CACHE = "ting-audio-v1";

/** Every file the app needs to start offline. Relative to the SW location. */
const SHELL_FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/main.js",
  "js/router.js",
  "js/data/loader.js",
  "js/data/clips.js",
  "js/data/pinyinSg.js",
  "js/audio/player.js",
  "js/audio/sfx.js",
  "js/audio/offline.js",
  "js/engine/rng.js",
  "js/engine/srs.js",
  "js/engine/questions.js",
  "js/engine/session.js",
  "js/engine/curriculum.js",
  "js/engine/altvoice.js",
  "js/state/storage.js",
  "js/state/progress.js",
  "js/ui/dom.js",
  "js/ui/store.js",
  "js/ui/home.js",
  "js/ui/units.js",
  "js/ui/unit.js",
  "js/ui/quiz.js",
  "js/ui/listen.js",
  "js/ui/stats.js",
  "js/ui/settings.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "data/units.json",
];

/**
 * Optional JSON, precached when it exists: the audio manifests (Mainland set, Singapore set) and
 * data/pinyin-sg.json (Singapore pinyin for display). All end in .json, so they stay network-first.
 */
const AUDIO_MANIFESTS = ["audio/manifest.json", "audio-sg/manifest.json", "data/pinyin-sg.json"];

// ===== Section: Install / activate =====

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_FILES);
    // WHY: unit files are listed in units.json, so read it instead of hard-coding 24 names.
    try {
      const index = await (await cache.match("data/units.json")).json();
      await Promise.all((index.units || []).map((u) => cache.add(u.file).catch(() => {})));
    } catch { /* lessons will be cached on first use instead */ }
    // WHY best effort: the audio manifests and pinyin-sg.json are optional (audio-sg/ 404s until
    // generated), so they must not go through addAll; with them cached the app starts offline with
    // its voices and the matching pinyin.
    await Promise.all(AUDIO_MANIFESTS.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("ting-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ===== Section: Fetch strategies =====

/** Is this an audio clip request? */
// WHY (audio-sg): the Singapore Mandarin set lives beside audio/ (ARCHITECTURE §5) and is
// cached the same way. The manifests (audio/manifest.json, audio-sg/manifest.json) end in
// .json, so they are not matched here and stay network-first.
const isAudio = (url) => /\/audio(-sg)?\/.+\.(mp3|ogg|wav|m4a)$/i.test(url.pathname);

/**
 * Answer a (possibly ranged) request from a full cached response.
 * @param {Request} request
 * @param {Response} full A complete 200 response.
 * @returns {Promise<Response>}
 */
async function respondWithRange(request, full) {
  const range = request.headers.get("range");
  if (!range) return full;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return full;
  const buf = await full.clone().arrayBuffer();
  const size = buf.byteLength;
  let start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": full.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

/** Cache-first for audio, filling the cache on a miss. */
async function audioFirst(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const url = request.url.split("#")[0];
  const hit = await cache.match(url);
  if (hit) return respondWithRange(request, hit);
  // WHY: fetch the FULL file (no Range) so the cached copy is complete and reusable offline.
  const res = await fetch(url);
  if (res.ok) {
    await cache.put(url, res.clone());
    return respondWithRange(request, res);
  }
  return res;
}

/** Network-first with cache fallback for everything else. */
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request, { cache: "no-cache" });
    if (res.ok && res.type === "basic") cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === "navigate") { const shell = await cache.match("index.html"); if (shell) return shell; }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // audio/manifest.json and audio-sg/manifest.json are JSON: they must stay fresh, so they go network-first.
  event.respondWith(isAudio(url) ? audioFirst(request) : networkFirst(request));
});

// ===== Section: "Download audio for offline" =====

/**
 * Cache a list of clip URLs, reporting progress to the requesting client.
 * @param {Client|ServiceWorker|null} client
 * @param {string} id Request id echoed back.
 * @param {string[]} urls
 */
async function cacheClips(client, id, urls) {
  const cache = await caches.open(AUDIO_CACHE);
  let done = 0, failed = 0;
  const total = urls.length;
  const report = (finished) => client && client.postMessage({ type: "cacheProgress", id, done, total, failed, finished });
  const queue = urls.slice();
  // WHY: a few parallel fetches are much faster than serial on mobile but do not hog the connection.
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try {
        if (!(await cache.match(u))) {
          const res = await fetch(u);
          if (!res.ok) throw new Error(String(res.status));
          await cache.put(u, res);
        }
      } catch { failed++; }
      done++;
      if (done % 5 === 0 || done === total) report(done === total);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (total === 0) report(true);
}

self.addEventListener("message", (event) => {
  const m = event.data;
  if (!m || m.type !== "cacheClips" || !Array.isArray(m.urls)) return;
  // WHY: only cache same-origin URLs, so a message can never make the SW fetch elsewhere.
  const urls = m.urls.filter((u) => { try { return new URL(u).origin === self.location.origin; } catch { return false; } });
  event.waitUntil(cacheClips(event.source, m.id, urls));
});
