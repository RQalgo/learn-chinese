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
  data/loader.js           Fetches units index, unit files, both audio manifests → Curriculum object + raw manifests
  data/clips.js            PURE effectiveClips(cn, sg, accent): the clip table for the chosen Mandarin accent
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
    offline.js             Asks the service worker to cache a unit's clips ("Download audio for offline")
  ui/
    dom.js                 Small helpers: h() element builder, put(), clear(), formatters, modal, toast
    store.js               Shared mutable app state (curriculum, effective clips, progress) + commit()/updateSettings()
    home.js, units.js, unit.js, quiz.js, listen.js, stats.js, settings.js   One module per screen
data/
  units.json               Ordered index of units
  units/uNN-slug.json      One file per unit (items + dialogues)
audio/                     Mainland set (+ all English and sys.* clips)
  manifest.json            clipId → { src, dur }
  zh/ zh-slow/ en/ sys/    Generated MP3 files (committed)
audio-sg/                  Singapore set: Mandarin clips only (may be absent or partial)
  manifest.json            same format and clip ids; src paths relative to the site root
  zh/ zh-slow/             Generated MP3 files (committed)
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
  "clips": { "u01-w01": { "src": "audio/zh/u01-w01.mp3?v=39c3a36cac", "dur": 0.92 } } }
```

`src` carries a short content hash (`?v=`) so a regenerated clip gets a new URL and
bypasses the service worker's cache-first audio cache; unchanged clips keep their URL.

Clip IDs (the app only ever refers to clip IDs, never to file paths):

| Clip ID | Content | Voice |
|---|---|---|
| `<itemId>` | item hanzi, normal speed | Mandarin voice chosen per item (rotating) |
| `<itemId>.slow` | item hanzi, slow: word-by-word with gaps, at least 1.6x as long as the normal clip (1.45x for sentences) | same voice |
| `<itemId>.alt1` .. `.alt3` | item hanzi, normal speed, in each of the OTHER voices of the engine (quiz voices; words, phrases and sentences, not dialogue lines, no slow alts) | the engine's other voices, stable order (§5.2) |
| `<itemId>.en` | item `english` | English voice |
| `<dialogueId>.l<N>` | dialogue line N (1-based), normal speed | voice by speaker A/B |
| `<dialogueId>.l<N>.slow` | same, slow (at least 1.45x the normal clip) | voice by speaker |
| `<dialogueId>.l<N>.en` | English of line N | English voice |
| `<dialogueId>.q<N>.en` | dialogue question N read in English | English voice |
| `sys.silence.<ms>` | silence: 500, 1000, 1500, 2000, 3000 (1500 is used by the commute playlist, §7.4) | — |
| `sys.<name>` | fixed English prompts (see `docs/AUDIO.md`) | English voice |

### 5.2 Learning voice vs quiz voices

Each item has ONE primary voice (`<itemId>`, `.slow`) used for learning, and up to three alternative
voices (`<itemId>.alt1..3` = the item's normal-speed text in the other voices of the engine; for Kokoro
the three voices of `ZH_VOICES` other than the item's primary, in list order, so `alt1` is always the same
voice for a given item). An engine with fewer voices yields fewer alts (`ZhEngine.alt_voices`); an old audio
set has none. Dialogue lines keep their A/B speakers and have no alts; there are no slow alts.

* Learning (quiz intro, unit page ▶, commute "new word" segments, every 🐢 slow button) uses the primary voice.
* Quiz questions and the commute self-test prompt use an alt voice (§7.3, §7.4), so the learner cannot
  answer by recognising the speaker heard when the word was taught.
* Choosing is pure (`engine/altvoice.js`, `pickAltClip(itemId, rng, clips?)`: random, never the primary; if a
  clip table is given only alts present in it; none -> the primary). The ONE fallback for a missing alt is
  `resolveClipId(id, clips)` in `js/data/clips.js`, used by `audio/player.js`: `<id>.altK` not in the effective
  table plays `<id>`; "slow" of an alt id plays the primary's `.slow` clip.
* Alts exist per accent set like every Mandarin clip (the Singapore set may be partial; a missing alt falls
  back to the Mainland alt through `effectiveClips`, then to the primary).

UI contract: every ▶ button plays the NORMAL clip once and every 🐢 button the SLOW clip once. Only the
automatic playback of a new word in the quiz intro (and the lock-screen play key there) is "normal, then slow".
How slow clips are built: `docs/AUDIO.md`, "Slow clips".

If a clip is missing from the manifest, `player.js` falls back to
`speechSynthesis` (zh-CN or en-US) so new content still works before audio is
regenerated.

### 5.1 Two Mandarin accents

There are two audio sets with the **same clip IDs**:

| Set | Manifest | Contains |
|---|---|---|
| Mainland (`cn`) | `audio/manifest.json` | everything: Mandarin (`zh`, `zh-slow`) **and** all English (`.en`) and `sys.*` clips |
| Singapore (`sg`) | `audio-sg/manifest.json` | **only** Mandarin clips: item normal/slow, dialogue line normal/slow (`audio-sg/zh/`, `audio-sg/zh-slow/`) |

`audio-sg/manifest.json` has the manifest format above; its `src` paths are relative to the
**site root** (`audio-sg/zh/u01-w01.mp3?v=…`), not to the manifest. It may be missing (404) or
partial. The pure function `effectiveClips(cnManifest, sgManifest, accent)` in `js/data/clips.js`
builds the table the rest of the app uses:

* English and `sys.*` clips always come from `audio/manifest.json` (an SG entry for them is ignored).
* accent `cn`: the Mainland table as is.
* accent `sg`: a Mandarin clip uses its SG entry if it has one, otherwise falls back to the
  Mainland entry (a partial SG set therefore still plays everything). `dur` follows the chosen entry.
* If the SG manifest holds no Mandarin clip at all, the effective accent is `cn` and Settings
  disables the Singapore option ("Singapore voices coming soon").

`store.clips` / `store.durations` are this effective table, `store.accent` the accent really
in use, `store.sgAvailable` whether Singapore can be offered. Every consumer (player, commute
planner `durations`, "Download audio for offline") reads `store.*`, never a manifest directly.

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
              dailyGoalXp: 60, sfx: true,
              accent: "sg",         // Mandarin accent: "sg" | "cn"; see §5.1
              autoAdvance: true }   // UI-only; absent = true (read via ui/store.js getSetting)
}
```

`settings.accent` is `"sg"` (Singapore, default) or `"cn"` (Mainland). Old saves without it, and
invalid values, load as the default (`state/storage.js` merges `DEFAULT_SETTINGS`). It is the
*requested* accent: while no Singapore clips exist the effective accent (`store.accent`) is
`cn`, and the stored value is left alone so Singapore takes effect as soon as the set is published.
Changing it in Settings recomputes the clip table at once (`store.js` → `onClipsChange` →
`configurePlayer`), no reload.

Day keys use the **device's local date** (`YYYY-MM-DD`).

## 7. Learning engine

### 7.1 Spaced repetition (`engine/srs.js`)

Leitner boxes 0–6. `INTERVAL_DAYS = [0, 1, 2, 4, 8, 16, 32]`.

* New card: `{ box: 0, due: 0, introduced: false, seen: 0, correct: 0, wrong: 0, lastSeen: 0 }`.
* `introduce(card, now)` → `introduced: true`, `box` stays 0, `due = now`.
* `review(card, correct, now)`:
  * correct → `box = min(box + 1, 6)`, `due = now + INTERVAL_DAYS[box] days`, where `box` is the **new** box
    (so a first correct answer is due in 1 day). `seen`/`correct`/`wrong`/`lastSeen` are updated too.
  * wrong → `box = min(box, 1)`, `due = now` (so the session can re-ask it).
* `status(card)`: `new` (not introduced) · `learning` (box 0–2) · `familiar` (box 3–4) · `mastered` (box 5–6).

### 7.2 Quiz session (`engine/session.js → planQuizSession`)

Inputs: curriculum, progress, `now`, `rng`, length (`short` 10 / `normal` 20 / `long` 30 questions, or a number),
optional `unitId` to practise one unit only (an explicit `unitId` may name a locked unit).
Length counts **questions**; intro steps are extra. New items and dialogue questions are
reserved first, then reviews are trimmed to `min(70 %, length - new - dialogue)`, so a big
backlog cannot starve new material. Each new item's question is placed ≥ 2 steps after its
intro whenever the session has at least two steps to spread over.

1. **Reviews**: introduced cards with `due <= now`, most overdue first, up to 70 % of the length.
2. **New items**: next un-introduced items from the earliest unlocked unit that still has new
   items (in file order), capped by length: `short` 4, `normal` 8, `long` 10. Each new item gets an
   `intro` step, and later in the session (≥ 2 steps after its intro) a question.
3. **Dialogue**: if the current unit has a dialogue whose items are mostly introduced, add one
   dialogue step (1–2 questions).
4. **Fill**: if still short, add not-yet-due introduced cards with the lowest box.
5. **Second questions**: if the question count is *still* below `length` (typical for a new learner
   with nothing due), each new item of this session gets a second `listen-meaning` question, appended
   after the others so it is ≥ 3 steps after its first question. The body is built lazily, so the
   distractors and option order differ from the first time. The count never exceeds `length`; a brand-new
   learner therefore gets 8 intros + 16 questions in a `normal` session.
6. Wrong answers are re-queued 3–5 steps later, once per item per session (handled at run time
   by `ui/quiz.js` calling `requeue()`; only `question` steps are re-queued).

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

Voices: the audio of `listen-meaning` and `true-false` prompts and of every `meaning-audio` option is an
alt-voice clip `<id>.altK` (§5.2), drawn with `rng` (a fresh draw per option, so the three options of one
question usually sound different). It is stored in the question (`prompt.clip` / `options[i].clip`), so replaying
the question uses the same voice. The 🐢 button of a question plays the item's PRIMARY slow clip: the
voice the word was taught in, which makes it a hint rather than a second unknown speaker. The feedback panel's
Replay also plays the primary voice. `makeQuestion(..., clips)` takes the effective clip table so only alts that
exist are chosen.

Distractors: same `type` first, then nearest units (same unit = distance 0), introduced items
preferred within a rank; if fewer than the wanted number exist the question simply has fewer
options (and degrades to `true-false` when no distractor exists); never an item
whose `english` or `alt` matches the answer; no duplicate labels.

### 7.4 Commute / hands-free playlist (`planListenSession`)

Target length ≈ `minutes` (default 8). Built from clip IDs only, so it can run with the screen off:

* Section prompt `sys.newWords`, then per new item:
  `item.slow → silence.1000 → item.en → silence.500 → item → silence.1500 → item`
* New-item cap scales with the target: one per 40 s, at most 12 (8 min → 12).
* Section prompt `sys.review`, then per self-test item, in this order: due items; the new items
  just taught in this same playlist; not-due introduced items with the lowest box. If that pool is
  smaller than the remaining time it is cycled (reshuffled), up to 6 rounds:
  `sys.whatMeans`(first only) `item.altK → silence.3000 → item.en → silence.500 → item`
  (the question is spoken by an alt voice, the repeat after the English by the primary/learning voice;
  `altK` is drawn with `rng` among the alts present in `durations`, else the primary is used for both)
* Optional dialogue: `sys.dialogue`, each line `l<N> → silence.500 → l<N>.en`, then all lines again at normal speed.
* End with `sys.done`.

The planner aims for `estimatedSec` within ±20 % of the target for a brand-new learner and for a
learner with many due items (checked in `tests/engine/fill.test.mjs` against the real data).

Each segment = `{ kind: "new"|"review"|"dialogue"|"prompt", refId, clips: [clipId…] }`.
Between the two passes of a dialogue the playlist inserts `sys.again`. Duration is estimated
from the manifest `dur` values (optional `durations` map), else 1.2 s per clip (slow ×1.8; an alt clip counts like its primary) plus
silences; a dialogue is included only if it fits in 35 % of the target.
Completing a `new` segment calls `introduce`; review segments update `seen`/`lastSeen` only
(we cannot know if the listener understood). Listening seconds go to `daily.listenSec`.

### 7.5 Gamification (`state/progress.js`)

* XP: correct answer +10, dialogue question correct +15, wrong answer +2 (for trying),
  intro +2, commute segment +3. Combo: every 5 correct in a row +10 bonus (the caller passes the
  combo count *including* the current answer; multiples of 5 earn the bonus).
* Going from level `n` to `n + 1` needs `50 * n * (n + 1)` lifetime XP, i.e. level 1 starts at 0 XP,
  level 2 at 100, level 3 at 300, level 4 at 600 (level `L` starts at `50 * (L-1) * L`). Titles: 1 新手 Newcomer · 3 学生 Student ·
  6 听众 Listener · 10 行者 Traveller · 15 达人 Expert · 20 大师 Master.
* Daily goal: `settings.dailyGoalXp` (default 60).
* Streak: a day counts when the daily goal is reached. Missing a day resets `current` to 0:
  the UI shows `effectiveStreak()` (0 once `lastDay` is older than yesterday) and
  `finishSession()` stores the lapse; the next goal day then restarts at 1.
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
* The player only knows the effective clip table (§5.1); `configurePlayer({clips, curriculum})` is
  called at boot and again whenever the accent changes.
* API (promise-based): `playClip(id, {slow})`, `playSequence(ids)`, `stop()`, plus a
  `Playlist` class for the commute mode with `onSegmentStart / onSegmentEnd / onFinish`.

## 9. Offline (`sw.js`)

* Cache `ting-shell-vN`: html, css, js, data JSON, manifest. Network-first for JSON and
  JS (so updates arrive), cache fallback offline.
* Cache `ting-audio-v1`: audio files of **both** sets (`audio/` and `audio-sg/`), cache-first,
  filled on first play. `audio/manifest.json` and `audio-sg/manifest.json` are JSON, so they are
  network-first like the other JSON and are precached best-effort at install (`audio-sg/`
  usually 404s until generated; that must not fail the install).
* Unit screen has "Download audio for offline": posts the unit's clip URLs (from the
  effective table, so the current accent) to the service worker, which adds them to the audio
  cache. Switching accent later needs a new download for the other accent's clips.

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
