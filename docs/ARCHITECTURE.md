# Architecture — 听 Tīng: Mandarin listening trainer

This document is the contract every part of the codebase follows. If code and
this document disagree, fix one of them in the same branch.

## 1. Goals and constraints

| Need | Consequence for the design |
|---|---|
| Used on an **Android phone (Chrome)** during commutes, earphones in | Mobile-first layout, big tap targets in the lower half of the screen, one-handed use |
| **Listening only** — no speaking, writing or reading practice | Every exercise starts from audio. Pinyin is shown (user's choice); characters are secondary and small |
| **Hands-free** option with the screen off | Audio is **pre-recorded MP3**, played through one `<audio>` element with the Media Session API. Chrome's `speechSynthesis` stops when the screen locks, so it is only a fallback |
| **Absolute beginner**, wide range of topics | 24 topic units, ordered by difficulty, unlocked progressively |
| Light **gamification** | XP, levels, daily goal, streak, combo, unit stars |
| **Progress tracking** | Per-item spaced repetition state, daily log, stats screen, backup export/import |
| Sessions of **5–10 minutes** | Default quiz session ≈ 20 questions; commute session ≈ 8 minutes |

Non-goals: accounts, servers, sync between devices (export/import covers backup).

## 2. Technology

* **Static site, no build step.** Plain HTML + CSS + vanilla JavaScript ES modules.
  Hosted on GitHub Pages at `https://rqalgo.github.io/learn-chinese/`, so **all
  URLs must be relative** (never start a path with `/`).
* **PWA**: `manifest.webmanifest` + `sw.js` so it installs to the home screen and
  works offline (MRT tunnels).
* **Storage**: `localStorage` (one JSON blob). Small enough; no IndexedDB needed.
* **Audio generation** (offline, at authoring time): Python + `sherpa-onnx` running
  the Kokoro multi-lang v1.0 model (Apache-2.0). Output: mono MP3.
* **Audio verification**: Python + `sherpa-onnx` Mandarin ASR model; transcribes
  each generated clip and compares with the source text.
* **Tests**: `node --test` for the pure engine modules; Python Playwright +
  headless Chrome for end-to-end smoke tests.

## 3. Repository layout

```
index.html                 App shell: one page, screens are swapped in by the router
manifest.webmanifest       PWA metadata
sw.js                      Service worker (app-shell cache + audio cache)
css/app.css                All styles (mobile-first, light/dark via prefers-color-scheme)
js/
  main.js                  Boot: load data, load progress, start router
  router.js                Hash router (#/home, #/units, #/unit/u01, #/quiz, #/listen, #/stats, #/settings)
  data/loader.js           Fetches units index, unit files, audio manifest → Curriculum object
  engine/                  PURE logic. No DOM, no fetch, no Date.now() — time and randomness are passed in.
    srs.js                 Spaced-repetition card state (Leitner boxes)
    questions.js           Builds one question (options, distractors) from an item
    session.js             Plans a quiz session or a commute (hands-free) playlist
    rng.js                 Seeded random number generator (mulberry32) + helpers
  state/
    storage.js             Load/save/migrate/export/import of the progress blob
    progress.js            Pure functions that update the progress blob (answers, XP, streak, unlocks, stats)
  audio/
    player.js              Single <audio> element queue, Media Session, speechSynthesis fallback
    sfx.js                 Tiny WebAudio beeps for correct/wrong
  ui/
    dom.js                 Small helpers: h() element builder, clear(), formatters
    home.js, units.js, unit.js, quiz.js, listen.js, stats.js, settings.js   One module per screen
data/
  units.json               Ordered index of units
  units/uNN-slug.json      One file per unit (items + dialogues)
audio/
  manifest.json            clipId → { src, dur }
  zh/ zh-slow/ en/ sys/    Generated MP3 files (committed)
tools/                     Python authoring tools (not shipped to the browser, but harmless if served)
  validate_content.py      Schema + pinyin cross-check (pypinyin) + duplicate checks
  generate_audio.py        Builds all clips listed by the content; incremental
  verify_audio.py          ASR round-trip check → report
  requirements.txt
tests/
  engine/*.test.mjs        node --test
  e2e/smoke.py             Playwright smoke test
docs/                      This file, CONTENT.md, AUDIO.md
```

## 4. Content data (contract between content, audio and app)

### 4.1 `data/units.json`

```json
{
  "version": 1,
  "units": [
    { "id": "u01", "order": 1, "title": "Greetings", "emoji": "👋",
      "description": "Say hello, goodbye, thank you and sorry.",
      "file": "data/units/u01-greetings.json" }
  ]
}
```

### 4.2 `data/units/uNN-slug.json`

```json
{
  "id": "u01",
  "title": "Greetings",
  "items": [
    { "id": "u01-w01", "type": "word", "hanzi": "你好", "pinyin": "nǐ hǎo",
      "english": "hello", "alt": ["hi"], "hint": "The most common greeting." }
  ],
  "dialogues": [
    { "id": "u01-d01", "title": "Meeting someone",
      "lines": [
        { "speaker": "A", "hanzi": "你好！", "pinyin": "Nǐ hǎo!", "english": "Hello!" },
        { "speaker": "B", "hanzi": "你好！你叫什么名字？", "pinyin": "Nǐ hǎo! Nǐ jiào shénme míngzi?", "english": "Hello! What's your name?" }
      ],
      "questions": [
        { "id": "u01-d01-q1", "question": "What does B ask?",
          "answer": "A's name", "distractors": ["A's age", "Where A is from", "What A does"] }
      ]
    }
  ]
}
```

Field rules:

* `id`: `uNN-wNN` (word), `uNN-pNN` (phrase), `uNN-sNN` (sentence), `uNN-dNN` (dialogue),
  `uNN-dNN-qN` (dialogue question). IDs are permanent — progress is keyed by them.
  Never renumber; append new IDs instead.
* `type`: `word` | `phrase` | `sentence`.
* `hanzi`: simplified characters. Numbers written in characters (三, not 3).
* `pinyin`: tone marks, words separated by spaces, proper nouns capitalised,
  sentences capitalised with the same final punctuation as the hanzi.
* `english`: the canonical meaning shown as the correct answer. Short. Within one
  unit, no two items may share the same `english`.
* `alt` (optional): other acceptable meanings — used to stop a "distractor" that
  is actually also correct.
* `hint` (optional, ≤ 80 chars): usage or culture note shown after answering.
* Dialogue `speaker`: `A` or `B` (the audio uses a different voice for each).

Detailed writing guidelines are in `docs/CONTENT.md`.

## 5. Audio (contract between audio pipeline and app)

`audio/manifest.json`:

```json
{ "version": 1, "generatedAt": "…",
  "clips": { "u01-w01": { "src": "audio/zh/u01-w01.mp3", "dur": 0.92 } } }
```

Clip IDs (the app only ever refers to clip IDs, never to file paths):

| Clip ID | Content | Voice |
|---|---|---|
| `<itemId>` | item hanzi, normal speed | Mandarin voice chosen per item (rotating) |
| `<itemId>.slow` | item hanzi, slow | same voice |
| `<itemId>.en` | item `english` | English voice |
| `<dialogueId>.l<N>` | dialogue line N (1-based), normal speed | voice by speaker A/B |
| `<dialogueId>.l<N>.slow` | same, slow | voice by speaker |
| `<dialogueId>.l<N>.en` | English of line N | English voice |
| `<dialogueId>.q<N>.en` | dialogue question N read in English | English voice |
| `sys.silence.<ms>` | silence: 500, 1000, 2000, 3000 | — |
| `sys.<name>` | fixed English prompts (see `docs/AUDIO.md`) | English voice |

If a clip is missing from the manifest, `player.js` falls back to
`speechSynthesis` (zh-CN or en-US) so new content still works before audio is
regenerated.

## 6. Progress state (localStorage key `tingProgress.v1`)

```js
{
  version: 1,
  createdAt: 1731830400000,
  cards: { "u01-w01": { box: 2, due: 1731916800000, introduced: true,
                        seen: 5, correct: 4, wrong: 1, lastSeen: 1731830400000 } },
  dialogues: { "u01-d01": { heard: 2, correct: 3, wrong: 1 } },
  unlocked: ["u01", "u02"],
  xp: 340,
  daily: { "2026-11-17": { xp: 120, answered: 22, correct: 19, listenSec: 480, sessions: 2 } },
  streak: { current: 3, best: 5, lastDay: "2026-11-17" },
  settings: { pinyin: "always", sessionLength: "normal", zhSpeed: "normal",
              dailyGoalXp: 60, sfx: true }
}
```

Day keys use the **device's local date** (`YYYY-MM-DD`).

## 7. Learning engine

### 7.1 Spaced repetition (`engine/srs.js`)

Leitner boxes 0–6. `INTERVAL_DAYS = [0, 1, 2, 4, 8, 16, 32]`.

* New card: `{ box: 0, due: 0, introduced: false, seen: 0, correct: 0, wrong: 0, lastSeen: 0 }`.
* `introduce(card, now)` → `introduced: true`, `box` stays 0, `due = now`.
* `review(card, correct, now)`:
  * correct → `box = min(box + 1, 6)`, `due = now + INTERVAL_DAYS[box] days`.
  * wrong → `box = min(box, 1)`, `due = now` (so the session can re-ask it).
* `status(card)`: `new` (not introduced) · `learning` (box 0–2) · `familiar` (box 3–4) · `mastered` (box 5–6).

### 7.2 Quiz session (`engine/session.js → planQuizSession`)

Inputs: curriculum, progress, `now`, `rng`, length (`short` 10 / `normal` 20 / `long` 30 questions),
optional `unitId` to practise one unit only.

1. **Reviews**: introduced cards with `due <= now`, most overdue first, up to 70 % of the length.
2. **New items**: next un-introduced items from the earliest unlocked unit that still has new
   items (in file order), max 6 per session (3 for `short`). Each new item gets an `intro` step,
   and later in the session (≥ 2 steps after its intro) a question.
3. **Dialogue**: if the current unit has a dialogue whose items are mostly introduced, add one
   dialogue step (1–2 questions).
4. **Fill**: if still short, add not-yet-due cards with the lowest box.
5. Wrong answers are re-queued 3–5 steps later, once per item per session (handled at run time
   by `ui/quiz.js` calling `requeue()`).

Step shapes:

```js
{ kind: "intro", itemId }
{ kind: "question", qtype, itemId }      // question body built lazily by questions.js
{ kind: "dialogue", dialogueId, questionIds: ["u01-d01-q1"] }
```

### 7.3 Question types (`engine/questions.js`)

| qtype | Prompt | Answer by | Used for |
|---|---|---|---|
| `listen-meaning` | play Chinese | tap 1 of 4 English meanings | all items (default) |
| `meaning-audio` | show English | play 3 Chinese clips, tap the match | words/phrases at box ≥ 2 |
| `true-false` | play Chinese + show an English meaning | tap ✓ or ✗ (50 % true) | any item at box ≥ 1 (fast, one-thumb) |
| `dialogue` | play the dialogue | tap 1 of 4 English answers | dialogues |

Distractors: same `type` first, same unit first, then neighbouring units; never an item
whose `english` or `alt` matches the answer; no duplicate labels.

### 7.4 Commute / hands-free playlist (`planListenSession`)

Target length ≈ `minutes` (default 8). Built from clip IDs only, so it can run with the screen off:

* Section prompt `sys.newWords`, then per new item:
  `item.slow → silence.1000 → item.en → silence.500 → item → silence.1500 → item`
* Section prompt `sys.review`, then per due/review item (self-test):
  `sys.whatMeans`(first only) `item → silence.3000 → item.en → silence.500 → item`
* Optional dialogue: `sys.dialogue`, each line `l<N> → silence.500 → l<N>.en`, then all lines again at normal speed.
* End with `sys.done`.

Each segment = `{ kind: "new"|"review"|"dialogue"|"prompt", refId, clips: [clipId…] }`.
Completing a `new` segment calls `introduce`; review segments update `seen`/`lastSeen` only
(we cannot know if the listener understood). Listening seconds go to `daily.listenSec`.

### 7.5 Gamification (`state/progress.js`)

* XP: correct answer +10, dialogue question correct +15, wrong answer +2 (for trying),
  intro +2, commute segment +3. Combo: every 5 correct in a row +10 bonus.
* Level `n` needs `50 * n * (n + 1)` total XP. Titles: 1 新手 Newcomer · 3 学生 Student ·
  6 听众 Listener · 10 行者 Traveller · 15 达人 Expert · 20 大师 Master.
* Daily goal: `settings.dailyGoalXp` (default 60).
* Streak: a day counts when the daily goal is reached. Missing a day resets `current` to 0.
* Unit unlock: unit N+1 unlocks when ≥ 70 % of unit N's items are at box ≥ 2.
  The unit screen also offers "Unlock early".
* Unit stars: ★ all items introduced · ★★ all at box ≥ 2 · ★★★ all mastered.

## 8. Audio playback (`audio/player.js`)

* Exactly **one** `HTMLAudioElement` for everything. Changing `src` on `ended` keeps
  playback alive in the background on Android; creating new elements or using
  `setTimeout` for gaps does not (timers are throttled when the screen is off).
  Gaps are therefore real silent MP3 clips.
* Media Session: metadata (title = pinyin, artist = English, album = unit title),
  handlers `play`, `pause`, `nexttrack` (skip segment), `previoustrack` (replay segment).
* API (promise-based): `playClip(id, {slow})`, `playSequence(ids)`, `stop()`, plus a
  `Playlist` class for the commute mode with `onSegmentStart / onSegmentEnd / onFinish`.

## 9. Offline (`sw.js`)

* Cache `ting-shell-vN`: html, css, js, data JSON, manifest. Network-first for JSON and
  JS (so updates arrive), cache fallback offline.
* Cache `ting-audio-v1`: audio files, cache-first, filled on first play.
* Unit screen has "Download audio for offline": posts the unit's clip URLs to the service
  worker, which adds them to the audio cache.

## 10. Code conventions (all files)

* Every file starts with a **header block comment**: what the area is for, how it fits with
  the rest (which modules call it / which it calls), key concepts, public API.
* Long files are split with section banners: `// ===== Section: Distractor selection =====`.
* Every exported function has JSDoc (`@param`, `@returns`) and a sentence on *why* when the
  reason is not obvious. Explain non-obvious decisions inline with `// WHY:` comments.
* Python tools: module docstring with the same header content, docstrings on functions,
  `argparse` with `--help` text.
* Engine modules are pure: pass `now` (ms) and `rng` in. This makes them testable in Node.
* No external JS libraries, no CDN calls.

## 11. Git workflow

* One branch per small change: `docs/…`, `feat/…`, `content/…`, `audio/…`, `fix/…`, `test/…`.
* Each branch → pull request into `main` with a description of what changed and how it was tested.
* Commit messages: imperative summary line, blank line, body explaining why.
