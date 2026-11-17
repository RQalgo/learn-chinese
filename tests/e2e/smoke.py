#!/usr/bin/env python3
"""
smoke.py - end-to-end smoke test for 听 Tīng (Playwright + headless Chrome).

Purpose
    Drive the real app in a mobile-sized Chrome through every screen and every
    step type, fail on any console error / page error / unexpected HTTP error,
    and save a screenshot of each screen to /tmp/shots/ (light and dark).

How it fits
    Run from anywhere:  python3 tests/e2e/smoke.py [--schemes light,dark]
    It starts its own `python3 -m http.server` on a free port (serving the
    repository root) and stops it afterwards. Needs `playwright` for Python and
    Chrome at /usr/bin/google-chrome. Independent of the node engine tests
    (`node --test tests/engine/*.test.mjs`).

Key concepts
    * No audio files exist yet, so every clip uses the speechSynthesis
      fallback. Headless Chrome has no voices, so the fallback's safety
      timeouts drive the commute playlist (that path is exercised for real).
    * The test reads data/units/*.json to know the right answers, so it can
      click correct or deliberately wrong options and assert that the app's
      verdict matches.
    * Expected 404: audio/manifest.json (audio is not generated yet). Any other
      4xx/5xx response fails the test.
    * Flow (per colour scheme): home -> lesson 1 (fresh progress, intros) ->
      summary -> home XP -> reload persistence -> seed progress -> lessons that
      cover every question type + dialogue -> units -> unit detail (play) ->
      stats chart -> settings (pinyin "after" really hides pinyin) -> commute
      (segments advance, skip, stop) -> commute to the end -> export / import /
      reset.
"""
import argparse
import re
import glob
import json
import os
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHOTS = "/tmp/shots"
CHROME = "/usr/bin/google-chrome"
ALLOWED_404 = ("audio/manifest.json",)

STATE_JS = """() => {
  const q = (s) => document.querySelector(s);
  if (q('#summary')) return 'summary';
  if (q('.feedback')) return 'feedback';
  if (q('#got-it')) return 'intro';
  if (q('#check-btn')) return 'meaning-audio';
  if (q('.tf-pair')) return 'true-false';
  if (q('#replay-conv')) return 'dialogue';
  if (q('.stage-bottom .opt')) return 'listen-meaning';
  return 'wait';
}"""


# ----------------------------------------------------------------------------
# Content knowledge (so the test can pick right/wrong answers)
# ----------------------------------------------------------------------------
def load_content():
    """pinyin -> {english}, english-of-question -> correct answer text."""
    py2en, dq = {}, {}
    for f in sorted(glob.glob(os.path.join(ROOT, "data", "units", "*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        for it in d.get("items", []):
            py2en.setdefault(it["pinyin"], set()).add(it["english"])
        for dl in d.get("dialogues", []):
            for q in dl.get("questions", []):
                dq[q["question"]] = q["answer"]
    return py2en, dq


# ----------------------------------------------------------------------------
# Tiny server helper
# ----------------------------------------------------------------------------
def start_server():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", ROOT],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            return proc, port
        except OSError:
            time.sleep(0.1)
    proc.terminate()
    raise RuntimeError("test server did not start")


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("  ok  " + msg)


# ----------------------------------------------------------------------------
# One full run for one colour scheme
# ----------------------------------------------------------------------------
class Run:
    def __init__(self, browser, base, scheme, py2en, dq):
        self.scheme, self.base, self.py2en, self.dq = scheme, base, py2en, dq
        self.errors, self.bad_responses = [], []
        self.ctx = browser.new_context(viewport={"width": 412, "height": 915}, is_mobile=True, has_touch=True,
                                       device_scale_factor=1, color_scheme=scheme, accept_downloads=True)
        self.page = self.ctx.new_page()
        p = self.page
        p.on("console", self._on_console)
        p.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        p.on("response", self._on_response)
        self.shots_done = set()
        self.seen_types = set()

    # --- collectors ---
    def _on_console(self, m):
        if m.type == "error" and not m.text.startswith("Failed to load resource"):
            self.errors.append(f"console.error: {m.text}")

    def _on_response(self, r):
        if r.status >= 400 and not any(r.url.endswith(a) for a in ALLOWED_404):
            self.bad_responses.append(f"{r.status} {r.url}")

    # --- helpers ---
    def shot(self, name, once=True):
        if once and name in self.shots_done:
            return
        self.shots_done.add(name)
        os.makedirs(SHOTS, exist_ok=True)
        self.page.screenshot(path=f"{SHOTS}/{name}-{self.scheme}.png")

    def goto(self, hash_):
        self.page.goto(f"{self.base}/index.html{hash_}")
        self.page.wait_for_selector("#screen > *:not(#boot)", timeout=10000)

    def state(self):
        return self.page.evaluate(STATE_JS)

    def wait_state(self, want, timeout=15):
        t0 = time.time()
        while time.time() - t0 < timeout:
            s = self.state()
            if s in want:
                return s
            time.sleep(0.05)
        raise AssertionError(f"timed out waiting for {want}; state={self.state()}")

    def progress(self):
        return self.page.evaluate("JSON.parse(localStorage.getItem('tingProgress.v1') || 'null')")

    def set_progress(self, blob):
        self.page.evaluate("(b) => localStorage.setItem('tingProgress.v1', JSON.stringify(b))", blob)

    # --- the lesson driver ---
    def answer_current(self, want_wrong):
        """Answer the visible question. Returns the expected verdict ('ok'/'miss'/None)."""
        p = self.page
        s = self.state()
        self.seen_types.add(s)
        expect = None
        if s == "listen-meaning":
            self.shot("quiz-question")
            pyn = p.locator(".prompt-pinyin")
            labels = [o.inner_text() for o in p.locator(".stage-bottom .opt").all()]
            idx = 0
            if pyn.count():
                good = self.py2en.get(pyn.inner_text().strip(), set())
                right = [i for i, l in enumerate(labels) if l in good]
                wrong = [i for i, l in enumerate(labels) if l not in good]
                if right and wrong:
                    idx, expect = (wrong[0], "miss") if want_wrong else (right[0], "ok")
            p.locator(".stage-bottom .opt").nth(idx).click()
        elif s == "true-false":
            self.shot("quiz-truefalse")
            pyn = p.locator(".prompt-pinyin")
            shown = p.locator(".statement b").inner_text()
            idx = 0
            if pyn.count():
                is_true = shown in self.py2en.get(pyn.inner_text().strip(), set())
                idx = (0 if is_true else 1)
                expect = "ok"
                if want_wrong:
                    idx, expect = 1 - idx, "miss"
            p.locator(".tf-pair .opt").nth(idx).click()
        elif s == "meaning-audio":
            self.shot("quiz-meaning-audio")
            eng = p.locator(".prompt-en").inner_text()
            rows = p.locator(".opt-row")
            texts = [r.inner_text().strip() for r in rows.all()]
            idx = 0
            if any(t and not t.startswith("Option") for t in texts):
                good = [pn for pn, en in self.py2en.items() if eng in en]
                right = [i for i, t in enumerate(texts) if t in good]
                wrong = [i for i, t in enumerate(texts) if t not in good]
                if right and wrong:
                    idx, expect = (wrong[0], "miss") if want_wrong else (right[0], "ok")
            rows.nth(idx).click()
            p.locator("#check-btn").click()
        elif s == "dialogue":
            self.shot("quiz-dialogue")
            q = p.locator(".prompt-en").inner_text()
            ans = self.dq.get(q)
            labels = [o.inner_text() for o in p.locator(".stage-bottom .opt").all()]
            idx = 0
            if ans in labels:
                right = labels.index(ans)
                wrong = [i for i in range(len(labels)) if i != right]
                idx, expect = (wrong[0], "miss") if want_wrong else (right, "ok")
            # transcript must NOT be visible before answering (comprehension test)
            check(p.locator(".transcript").count() == 0, "dialogue transcript hidden before answering")
            p.locator(".stage-bottom .opt").nth(idx).click()
        return expect

    def run_session(self, label, wrong_every=4, max_steps=80):
        """Play every step until the summary. Returns step counts by type."""
        p = self.page
        counts, n_q = {}, 0
        for _ in range(max_steps):
            s = self.wait_state({"intro", "listen-meaning", "meaning-audio", "true-false", "dialogue", "summary"})
            if s == "summary":
                break
            counts[s] = counts.get(s, 0) + 1
            # guard against template slips such as a stray "null" / "undefined" on screen
            text = p.locator("#screen").inner_text()
            assert not re.search(r"\b(null|undefined|NaN)\b", text), f"{label}: stray null/undefined/NaN on screen: {text[:200]!r}"
            if s == "intro":
                self.shot("quiz-intro")
                p.locator("#got-it").click()
                continue
            n_q += 1
            expect = self.answer_current(want_wrong=(n_q % wrong_every == 0))
            fb = p.wait_for_selector(".feedback", timeout=5000)
            cls = fb.get_attribute("class")
            if expect:
                check(expect in cls.split(), f"{label}: {s} verdict matches expectation ({expect})")
            self.shot("quiz-feedback-" + ("ok" if "ok" in cls.split() else "miss"))
            if s == "dialogue" and p.locator(".fb-transcript").count():
                self.shot("quiz-dialogue-feedback")
            # real tap on Next for the first feedback of the run, JS click afterwards (auto-advance race)
            p.evaluate("document.querySelector('#next-btn') && document.querySelector('#next-btn').click()")
        else:
            raise AssertionError(f"{label}: session did not finish")
        p.wait_for_selector("#summary")
        return counts


def main():
    ap = argparse.ArgumentParser(description="Playwright smoke test for 听 Tīng")
    ap.add_argument("--schemes", default="light,dark", help="comma-separated colour schemes to run (default: light,dark)")
    args = ap.parse_args()
    py2en, dq = load_content()
    proc, port = start_server()
    base = f"http://127.0.0.1:{port}"
    failures = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROME, headless=True,
                                         args=["--autoplay-policy=no-user-gesture-required", "--no-sandbox"])
            for scheme in args.schemes.split(","):
                print(f"\n=== colour scheme: {scheme} ===")
                run = Run(browser, base, scheme, py2en, dq)
                try:
                    flow(run)
                except Exception as e:  # keep going so both schemes report
                    try:
                        run.page.screenshot(path=f"{SHOTS}/FAILURE-{scheme}.png")
                    except Exception:
                        pass
                    failures.append(f"[{scheme}] {type(e).__name__}: {e}")
                if run.errors:
                    failures.append(f"[{scheme}] browser errors: {run.errors}")
                if run.bad_responses:
                    failures.append(f"[{scheme}] bad HTTP responses: {run.bad_responses}")
                run.ctx.close()
            browser.close()
    finally:
        proc.terminate()
    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print("\nAll smoke checks passed. Screenshots in " + SHOTS)


# ----------------------------------------------------------------------------
# The flow
# ----------------------------------------------------------------------------
def flow(r: Run):
    p = r.page

    # --- home ---
    r.goto("#/home")
    p.wait_for_selector("#start-lesson")
    check(p.locator("#start-lesson").inner_text().count("questions") == 1, "home shows the Lesson action with a question count")
    check("hands-free" in p.locator("#start-commute").inner_text(), "home shows the Commute action")
    check(p.locator(".tabbar").is_visible(), "tab bar visible on home")
    r.shot("home-fresh")

    # --- PWA bits ---
    check(p.evaluate("!!document.querySelector('link[rel=manifest]')"), "manifest linked")
    p.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller === null || true")
    p.evaluate("navigator.serviceWorker.ready.then(() => true)")
    keys = p.evaluate("caches.keys()")
    check(any(k.startswith("ting-shell-") for k in keys), "service worker installed the shell cache")

    # --- lesson 1 on fresh progress ---
    p.locator("#start-lesson").click()
    p.wait_for_selector("#got-it", timeout=10000)
    check(not p.locator(".tabbar").is_visible(), "tab bar hidden during a lesson")
    counts = r.run_session("lesson 1")
    print("  lesson 1 steps:", counts)
    check(counts.get("intro", 0) >= 3, "lesson 1 has intro steps")
    xp_text = p.locator("#sum-xp").inner_text()
    xp = int(xp_text.replace("+", ""))
    check(xp > 0, f"summary shows XP gained ({xp_text})")
    r.shot("quiz-summary")

    # --- home reflects XP; persistence across reload ---
    p.locator("#to-home").click()
    p.wait_for_selector("#start-lesson")
    ring = p.locator(".ring .label").inner_text().replace("\n", " ")
    check(str(xp) in ring or "✓" in ring, f"home goal ring updated ({ring!r})")
    r.shot("home-after")
    saved_xp = r.progress()["xp"]
    check(saved_xp == xp, f"progress saved to localStorage (xp {saved_xp})")
    p.reload()
    p.wait_for_selector("#start-lesson")
    check(r.progress()["xp"] == xp, "progress persisted after reload")

    # --- seed: u01 learned, spread over boxes, all due; then lessons covering every type ---
    blob = r.progress()
    now = int(time.time() * 1000)
    unit1 = json.load(open(os.path.join(ROOT, "data", "units", "u01-greetings.json"), encoding="utf-8"))
    for i, it in enumerate(unit1["items"]):
        blob["cards"][it["id"]] = {"box": 1 + (i % 4), "due": now - 86400000, "introduced": True,
                                   "seen": 3, "correct": 2, "wrong": 1, "lastSeen": now - 100000}
    r.set_progress(blob)
    p.reload()  # WHY: the app keeps progress in memory; reload so it reads the seeded blob
    p.wait_for_selector("#start-lesson")
    r.seen_types = set()
    r.goto("#/quiz?unit=u01")
    for attempt in range(5):
        counts = r.run_session(f"lesson seeded #{attempt + 1}")
        print("  seeded lesson steps:", counts)
        if {"listen-meaning", "meaning-audio", "true-false", "dialogue"} <= r.seen_types:
            break
        p.locator("#another").click()  # "Another lesson" restarts the quiz in place
    check({"listen-meaning", "meaning-audio", "true-false", "dialogue"} <= r.seen_types,
          f"every question type was exercised ({sorted(r.seen_types)})")
    ev = p.locator(".event-list")
    r.shot("quiz-summary-2")

    # --- units ---
    r.goto("#/units")
    p.wait_for_selector(".unit-row")
    check(p.locator(".unit-row").count() == 24, "units list shows 24 units")
    check(p.locator(".unit-row.locked").count() >= 1, "locked units are marked")
    r.shot("units")

    # --- unit detail ---
    p.locator(".unit-row").first.click()
    p.wait_for_selector(".item")
    check(p.locator(".item").count() == 26, "unit 1 lists 26 items")
    check(p.locator(".dlg").count() == 2, "unit 1 lists 2 dialogues")
    p.locator(".item .icon-btn").first.click()
    time.sleep(0.4)
    p.locator(".dlg summary").first.click()
    check(p.locator(".dlg .transcript li").count() >= 4, "dialogue transcript expands")
    r.shot("unit")
    # locked unit: unlock early
    r.goto("#/unit/u24")
    p.wait_for_selector("#unlock-early")
    p.locator("#unlock-early").click()
    p.wait_for_selector(".modal")
    r.shot("modal")
    p.locator(".modal-ok").click()
    p.wait_for_function("!document.querySelector('#unlock-early')")
    check("u24" in r.progress()["unlocked"], "unlock early works")

    # --- player contract: cancel-safety and the speech-fallback safety timeout ---
    res = p.evaluate("""async () => {
      const m = await import('./js/audio/player.js');
      const a = m.playClip('u01-w01'); const b = m.playClip('u01-w02');
      const ra = await a; m.stop(); const rb = await b;
      const t0 = performance.now();
      // WHY: with generated audio the clip plays as a real file ("ended"); without it the
      // speech fallback must finish by itself ("fallback"). Either way it must not hang.
      const rc = await m.playClip('u01-w01');
      const dt = (performance.now() - t0) / 1000;
      const rd = await m.playSequence(['sys.silence.500', 'sys.silence.500']);
      return {ra, rb, rc, dt, rd};
    }""")
    check(res["ra"] == "cancelled" and res["rb"] == "cancelled", "starting/stopping playback cancels the previous one cleanly")
    check(res["rc"] in ("ended", "fallback") and res["dt"] < 4.0, f"single clip finishes by itself, no hang ({res['rc']}, {res['dt']:.1f}s)")
    check(res["rd"] in ("ended", "fallback"), f"silence clips play or fall back to timed waits ({res['rd']})")

    # --- stats ---
    r.goto("#/stats")
    p.wait_for_selector("#xp-chart")
    check(p.locator("#xp-chart rect").count() == 14, "stats chart has 14 bars")
    p.locator("#xp-chart").scroll_into_view_if_needed()
    time.sleep(3)  # let any toast from the previous screen fade out
    r.shot("stats")

    # --- settings: pinyin 'after' really hides pinyin before answering ---
    r.goto("#/settings")
    p.wait_for_selector(".segmented")
    p.get_by_role("radio", name="After answering").click()
    check(r.progress()["settings"]["pinyin"] == "after", "pinyin setting saved")
    r.shot("settings")
    r.goto("#/quiz?unit=u01")
    s = r.wait_state({"listen-meaning", "true-false", "meaning-audio", "dialogue"})
    check(p.locator(".prompt-pinyin").count() == 0, f"no pinyin before answering with 'after' ({s})")
    if s == "meaning-audio":
        check(all(t.startswith("Option") for t in [x.inner_text().strip() for x in p.locator(".opt-row").all()]), "options hide pinyin labels")
    r.answer_current(False)
    p.wait_for_selector(".feedback")
    check(p.locator(".fb-py").count() == 1 or s == "dialogue", "pinyin appears in feedback with 'after'")
    r.shot("quiz-after-feedback")
    p.locator("#close-session").click()
    p.wait_for_selector(".modal")
    p.locator(".modal-ok").click()
    p.wait_for_selector("#start-lesson")
    check(True, "closing a lesson asks for confirmation then goes home")
    r.goto("#/settings")
    p.get_by_role("radio", name="Always").click()

    # --- commute mode: setup, advance, skip, stop ---
    r.goto("#/listen")
    p.wait_for_selector("#start-listen")
    r.shot("listen-setup")
    p.get_by_role("radio", name="5 min").click()
    p.locator("#start-listen").click()
    p.wait_for_selector(".section-label")
    r.shot("listen-playing", once=False)
    p.wait_for_function("document.querySelector('.seg-count') && document.querySelector('.seg-count').textContent.startsWith('2 /')", timeout=90000)
    check(True, "commute playlist advanced to segment 2 by itself (fallback timeouts)")
    r.shot("listen-playing-2")
    title = p.evaluate("navigator.mediaSession && navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : ''")
    check(bool(title), f"Media Session metadata is set ({title!r})")
    before = p.locator(".seg-count").inner_text()
    p.locator("#next-seg").click()
    p.wait_for_function("(b) => document.querySelector('.seg-count').textContent !== b", arg=before, timeout=10000)
    check(True, "skip moves to the next segment")
    p.locator("#toggle-play").click()
    check(p.locator("#toggle-play").get_attribute("aria-label") == "Play", "pause toggles the button")
    p.locator("#toggle-play").click()
    p.locator("#prev-seg").click()
    p.locator("#close-session").click()
    p.wait_for_selector(".modal")
    p.locator(".modal-ok").click()
    p.wait_for_selector("#start-lesson")
    day = time.strftime("%Y-%m-%d")
    listen_sec = sum(d.get("listenSec", 0) for d in r.progress()["daily"].values())
    check(listen_sec >= 1, f"listening seconds recorded ({listen_sec}s)")

    # --- commute to the end via skipping ---
    r.goto("#/listen")
    p.get_by_role("radio", name="5 min").click()
    p.locator("#start-listen").click()
    p.wait_for_selector("#next-seg")
    for _ in range(60):
        if p.locator("#listen-summary").count():
            break
        p.locator("#next-seg").click(timeout=3000) if p.locator("#next-seg").count() else None
        time.sleep(0.05)
    p.wait_for_selector("#listen-summary", timeout=10000)
    check(p.locator("#test-yourself").count() == 1, "commute finish summary offers Test yourself")
    r.shot("listen-summary")
    p.locator("#test-yourself").click()
    p.wait_for_selector("#got-it, .stage-bottom .opt, #check-btn, .tf-pair", timeout=10000)
    check("#/quiz" in p.url, "Test yourself starts a quiz")

    # --- export / import / reset ---
    r.goto("#/settings")
    p.wait_for_selector("#export-progress")
    with p.expect_download() as dl:
        p.locator("#export-progress").click()
    path = dl.value.path()
    exported = json.load(open(path, encoding="utf-8"))
    check(exported["version"] == 1 and exported["xp"] > 0, "export produces a valid progress JSON")
    p.set_input_files("#import-file", path)
    p.wait_for_selector(".modal")
    p.locator(".modal-ok").click()
    p.wait_for_selector(".toast.show")
    check(r.progress()["xp"] == exported["xp"], "import restores the backup")
    p.locator("#reset-progress").click()
    p.wait_for_selector(".modal")
    p.locator(".modal-ok").click()
    p.wait_for_function("document.querySelector('#modal-title') && document.querySelector('#modal-title').textContent.startsWith('Really')")
    p.locator(".modal-ok").click()
    p.wait_for_function("JSON.parse(localStorage.getItem('tingProgress.v1')).xp === 0")
    check(True, "reset (double confirm) clears progress")
    r.goto("#/stats")
    p.wait_for_selector("#stats-empty")
    r.shot("stats-empty")
    check(True, "stats empty state renders")


if __name__ == "__main__":
    main()
