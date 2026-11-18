# Audio pipeline

All speech is generated offline and committed as MP3, because the app must keep
playing on Android with the screen off (Chrome's built-in `speechSynthesis`
stops when the screen locks).

## Engine

`sherpa-onnx` (pip) with **two** Kokoro multi-lang models (both Apache-2.0, not committed,
about 350 MB each; `tools/generate_audio.py` loads each only when a clip needs it, so a
`--jobs 2` run may hold both in every worker, about 1 GB in total):

| Model | Used for | Directory option |
|---|---|---|
| `kokoro-multi-lang-v1_0` | all English clips (`.en`, `sys.*`) | `--model-dir` / `$AUDIO_MODEL_DIR` |
| `kokoro-multi-lang-v1_1` | all Mandarin clips (items and dialogue lines, normal and slow) | `--zh-model-dir` / `$AUDIO_ZH_MODEL_DIR` |

Downloads: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2`
and `.../kokoro-multi-lang-v1_1.tar.bz2` (see **How to run**). WHY two: v1.1-zh pronounces
Mandarin clearly better than v1.0 (ASR CER below), but its English is no better, so the
English clips were left exactly as they were.

* ~1 s of CPU per 1 s of audio on 2 cores, so generation is **incremental**: each clip's
  inputs (text, voice, speed, engine version, model name, lexicon fingerprint) are hashed
  into `audio/.cache.json`; unchanged clips are skipped. Mandarin clips hash the v1.1
  model name, English clips still hash the v1.0 name (so they never rebuilt on the switch).

## Accents and Mandarin engines

The app has two Mandarin accents (ARCHITECTURE section 5.1). `tools/generate_audio.py --accent`
selects the set to build:

| `--accent` | Output | Clips | Cache / manifest |
|---|---|---|---|
| `cn` (default) | `audio/{zh,zh-slow,en,sys}/` | Mandarin + English + `sys.*` (the **Mainland** set) | `audio/.cache.json`, `audio/manifest.json` |
| `sg` | `audio-sg/{zh,zh-slow}/` | Mandarin only, same clip ids (the **Singapore** set) | `audio-sg/.cache.json`, `audio-sg/manifest.json` |

`sg` never loads the English lexicon or model and skips `.en` and `sys.*` clips (the app plays
those from `audio/`). Clips missing from `audio-sg/` fall back to `audio/` in the app, so the
set can be generated partially or by unit (`--only u01`).

Mandarin synthesis is behind a small interface, `ZhEngine`, chosen by `--zh-engine`
(default `kokoro`, the existing Kokoro v1.1 implementation, registered in `ZH_ENGINES`):

```python
class ZhEngine:
    name: str                 # "kokoro" (the --zh-engine value)
    model_id: str             # "kokoro-multi-lang-v1_1"
    voices: list              # voice ids rotated over items (stable per item id)
    dialogue_voices: dict     # {"A": voice, "B": voice}
    def __init__(self, model_dir, extra_lexicon="", threads=1)   # model loads lazily
    @classmethod cache_id() -> str          # hashed into every Mandarin clip key
    @classmethod check_model(model_dir)     # SystemExit if unusable
    @classmethod prepare(clips, model_dir, workdir) -> (clips, extra_lexicon_path)
    def synth(self, text, voice, speed) -> (float32 samples, sample_rate)
```

Everything after `synth` (trim, loudness to a fixed RMS, padding, 24 kHz mono 40 kbps MP3,
manifest) is shared, so engines end up equally loud and in the same format. The engine's
`cache_id()` (`name:model_id`) is part of the clip hash; Kokoro keeps the bare model name so
all existing keys are unchanged (`--accent cn` reports 0 clips to build). The Singapore engine
(a CosyVoice-based model) is meant to be one more `ZhEngine` subclass plus a `ZH_ENGINES` entry;
nothing else in the pipeline changes. Note that `--accent sg --zh-engine kokoro` just
re-renders the Mainland voices into `audio-sg/` (useful for testing the plumbing only).

## Voices (Kokoro speaker IDs)

| Use | Speaker IDs |
|---|---|
| Mandarin items | rotate over `ZH_VOICES = [30, 4, 63, 75]` (F, F, M, M; v1.1 ids), picked deterministically from a hash of the item ID so an item always has the same voice |
| Dialogue speaker A / B | `DIALOGUE_VOICES = {"A": 4, "B": 75}` (female, male) |
| English (v1.0) | one clear US English voice (`af_heart`, id 3) |

Kokoro v1.1 speakers: 0-2 English, **3-57 female Mandarin, 58-102 male Mandarin** (24 kHz).
The four voices were screened with the ASR round trip (see **Verification**); none of them
is clearly worse than the others on comparable clips (table below), so none was swapped.
The former v1.0 voices (ids 45-52) are no longer used.

## Speeds

* normal: speed 1.0 for Mandarin and English.
* slow (`.slow` clips): see **Slow clips** below (engine speed 1.0, per-word chunks, time-stretch).

## Slow clips

Problem: the first recipe (engine speed 0.75) made `.slow` clips only 1.2-1.4x as long as the
normal ones (u01-w01: 0.77 s vs 0.95 s), which is not audibly slower, especially for short words.
Now a slow clip is built by the shared pipeline (`plan_slow` / `build_slow_clip` in
`tools/generate_audio.py`, so any `ZhEngine` gets it) as follows:

1. **Chunks.** The line is cut at its pinyin word boundaries (`zh_lexicon.plan_chunks`; hanzi and
   pinyin are aligned there). Each chunk keeps the punctuation after it, is synthesised separately
   at engine speed `SLOW_SPEED = 1.0`, trimmed, and joined with a 180 ms gap (350 ms after a chunk
   that ends in punctuation). Boundaries that are NOT cut: after a sandhi 不/一 (`bú shì`), before a
   standalone neutral syllable (`de`, `ma`, `le`), between two third tones (`nǐ hǎo`), and a
   one-syllable chunk joins its neighbour in the same clause (lone syllables synthesise badly); a line
   made only of single syllables (`Yī, èr, sān`) is one chunk. So neutral-tone words and the units of
   the content lexicon (zh_lexicon) are never split (checked over all content: 0 of 421 units cut),
   and the extra lexicon applies to every chunk. Most single words are one chunk.
2. **Stretch.** If the joined clip is shorter than `target x normal clip x 1.03`, the chunks (not the
   gaps) are time-stretched with ffmpeg `rubberband` (formant preserving; `atempo` in passes of >= 0.7 if
   the filter is missing). Targets, on the final MP3 durations: **1.6x** for words and phrases
   (`-wNN`, `-pNN`), **1.45x** for sentences and dialogue lines. The MP3 is measured afterwards and
   stretched a bit more (max 3 rounds, else the clip FAILS) if it is still short. The normal clip's
   duration comes from `.cache.json` (when its entry is up to date) or is measured.
3. **Cache key.** `SLOW_STRATEGY` ("slow-v2"), the chunk plan, the target ratio and the normal clip's
   key are hashed into `.slow` clips only; bump `SLOW_STRATEGY` to rebuild just the slow clips.

Why engine speed 1.0 and not 0.7 (the first idea): ASR round trips of isolated chunks showed that Kokoro v1.1
below about 0.85 prepends a spurious syllable to short chunks (`老师` -> `你老实的`, `来` -> `直来`, `对不起` ->
`团对不齐`; clean at 1.0), and chunked sentences scored mean CER 0.82 at 0.7, 0.69 at 0.75, 0.36 at 0.85 and
0.23-0.17 at 1.0 (10 sentences; whole lines at 1.0 + rubberband: 0.02). Slowness therefore comes from
the gaps and the stretch, not from the engine.

## Output format

* Mono, 24 kHz, MP3 ~40 kbps (ffmpeg `-ac 1 -ar 24000 -b:a 40k`).
* Loudness normalised (ffmpeg `loudnorm` or simple peak normalisation) so clips are even.
* ~120 ms of silence trimmed/padded consistently at both ends.

## Fixed English prompts (`sys.*`)

| Clip ID | Text |
|---|---|
| `sys.welcome` | Let's start. |
| `sys.newWords` | New words. |
| `sys.review` | Review time. Listen, and think of the meaning. |
| `sys.whatMeans` | What does this mean? |
| `sys.dialogue` | Now, a short conversation. |
| `sys.again` | Once more, at normal speed. |
| `sys.done` | Well done. That's the end of this session. |
| `sys.silence.500` / `1000` / `1500` / `2000` / `3000` | silence of that many milliseconds |

## English normalisation and the extra lexicon

Kokoro speaks English only from `lexicon-us-en.txt` (`word phone phone ...`). sherpa-onnx
splits text at whitespace, `, . ; : ? !` and `-`, lowercases, and **silently skips** any
word not in the lexicon (log line `OOV word skipped`), so "twenty minutes" was spoken as
"twenty". A clip whose words are all unknown fails outright. Every English clip (`.en`,
`sys.*`) therefore goes through two stages in `tools/generate_audio.py`:

1. `normalize_english(text)` (no model needed): contractions the lexicon lacks are spelled
   out (`that's` -> `that is`), `/` -> ` or `, parentheses -> comma pauses
   (`you (polite)` -> `you, polite`), characters the tokenizer cannot handle are dropped,
   spaces are collapsed.
2. `EnglishLexicon.prepare(text)`, per word: in the base lexicon or hand-written extra
   lexicon -> keep; all-caps acronym not in the lexicon -> spelled letters (`MRT` ->
   `M R T`, single letters exist in the lexicon); otherwise inflect a known stem:
   possessive `'s`, plural `-s/-es/-ies`, `-ed/-d/-ied`, `-ing`. Suffix phones copy the
   base lexicon's convention: `s` after voiceless, `z` after voiced, `ᵻ z` after a sibilant
   (`buses b ˈ ʌ s ᵻ z`); `-ed` is `t` / `d` / `ᵻ d` (after `t`, `d`) (`worked`, `played`,
   `needed`); `-ing` is `ɪ ŋ`.

`tools/lexicon-extra-en.txt` holds hand-written entries (same format) for Mandarin names
and Singlish that no rule can derive: `Wang`, `Xiao`, `Xiaoming`, `Xiaomei`, `Daming`, `Lin`,
`Hua`, `Doudou`, `aircon`, `kaya`, spelt with English phones (e.g. Xiao ~ "shyow"). `#` comment
lines are allowed; the tool strips them. At run time the extra entries plus the inflected
ones are written to a temporary lexicon passed to sherpa-onnx as
`lexicon-us-en.txt,<extra>,lexicon-zh.txt`. Verified: later files override earlier ones, so
extra entries win over the base lexicon.

Checks: before building, the tool reports any word still unresolved (`OOV: ...`) and
refuses to build. `python3 tools/generate_audio.py --check-en` runs only this check over all
English clips and exits 1 if anything is unresolved (currently 0). To fix one, add a line to
`tools/lexicon-extra-en.txt` or reword the content. Do not put digits in English text:
number FSTs would read them in Mandarin.

Cache: an English clip's key holds its **normalised** text plus a fingerprint of the extra
entries (hand-written or inflected) its own words use. Clips without such a word keep their
old key, so only affected clips rebuild when normalisation rules or an extra entry change;
Chinese clips are never affected and `PIPELINE_VERSION` was not bumped.

## Mandarin lexicon: neutral tones and 不/一 (`tools/zh_lexicon.py`)

Problem: `lexicon-zh.txt` of every Kokoro model lacks many common neutral-tone words
(谢谢, 东西, 朋友, 喜欢, 先生, 妈妈 ...), which were therefore spoken with full tones, and the
不/一 tone depends on the word being known. The content already has the correct reading
(docs/CONTENT.md: neutral tone unmarked, written 不/一 sandhi tones), so the tool derives
extra entries from it at every run.

* **Lexicon format** (v1.1): `word` followed by, per syllable, an initial token, a final
  token and a tone digit (1-4, 5 = neutral): `你好 ㄋ ㄧ 2 ㄏ ㄠ 3`, `孩子 ㄏ ㄞ 2 ㄗ ㄭ 5`,
  erhua adds `R` before the digit (`哪儿 ㄋ ㄚ R 3`). Tones are post-sandhi (你好 is 2 3).
  The pinyin -> tokens table is learned from the model's single-character entries with
  pypinyin (408 syllables), never hard-coded.
* **Alignment**: each item/dialogue line's hanzi is aligned with its pinyin (one syllable
  per Han character, `r` = 儿, apostrophes, capitals and punctuation handled; lines that do
  not align are reported).
* **Units that get an entry** (see the module docstring): multi-syllable pinyin words with a
  neutral syllable or a sandhi 不/一; a standalone `bú`/`yí`/`yì` together with the next word
  (`不去`, `一个`; a one-character entry would change every 不/一); a standalone neutral
  syllable the lexicon does not know as neutral, with its neighbours (`对不对`). An entry is
  written only if the base lexicon lacks the word or its tones differ from ours; third-tone
  sandhi differences are ignored (we write citation tones).
* **Segmentation**: sherpa-onnx >= 1.12.15 ignores `dict_dir` for Kokoro (it logs this) and
  cuts the text by **longest match over the merged lexicons**, so a new entry is
  automatically a token and no jieba change is needed (verified: adding the entries to a
  jieba user dictionary changed no waveform). A longer base word can swallow a unit
  (`等一下` hides `一下`; its base tones are right, so nothing to do) or contradict our
  tones (`早上好` has a non-neutral 上): `repair_tokens` simulates the cut and adds an entry
  for such a whole token with our tones.
* **Precedence**: the extra file is the **last** file of the `lexicon=` list; later files
  override earlier ones (verified, as for English). The file is regenerated into a temp
  directory at each run (49 entries for the current content).
* **Cache**: a Mandarin clip's key contains a fingerprint of the entries its own line relies
  on, so editing the pinyin of one word rebuilds only the clips that use it.
* **Proof it takes effect** (voices 30 / 63; before -> after; second-syllable energy relative to
  the first, and F0 in Hz): 谢谢 0.70 -> 0.62, F0 212 -> 183 / 0.70 -> 0.49, 107 -> 88;
  东西 0.43 -> 0.32 (F0 124 -> 95, voice 63); 妈妈 0.67 -> 0.48; 先生 0.63 -> 0.44. Ablating
  each of the 48 entries of the first version (one at a time, audio compared sample by
  sample) changed the audio for 47; the remaining one (一下 inside 等一下) is the longer-word
  case above.

## Verification

`tools/verify_audio.py` transcribes every Mandarin clip with a sherpa-onnx Mandarin
ASR model and computes the character error rate (CER) against the hanzi (punctuation
stripped). Output: `audio/verify-report.json` and a summary table. Clips with CER > 0.34
are listed for a human (or re-generation with another voice). ASR is not perfect on
1–2 character words, so short words are judged leniently.

## Voice evaluation (historical: Kokoro v1.0 voices)

This section records the original v1.0 voice choice (`ZH_VOICES = [47, 48, 50, 52]`), which has been
replaced by the v1.1 voices above; `tools/eval_voices.py` still evaluates v1.0 voices 45-52.

`tools/eval_voices.py` makes every Mandarin voice (45-52) speak the same 15 sentences
(single words, greetings, numbers, prices, times, questions), runs them through the
exact production post-processing and MP3 encoding, transcribes them with the ASR model
(`sherpa-onnx-paraformer-zh-small-2024-03-09`) and scores the CER. 15 sentences x 2
speeds x 8 voices; results of 2026-11-17:

| ID | Voice | Sex | CER normal | exact (normal) | CER slow (0.75) | exact (slow) | Mean of both |
|---|---|---|---|---|---|---|---|
| 45 | zf_xiaobei | F | 0.122 | 9/15 | 0.419 | 0/15 | 0.271 |
| 46 | zf_xiaoni | F | 0.303 | 6/15 | 0.705 | 0/15 | 0.504 |
| 47 | zf_xiaoxiao | F | 0.077 | 11/15 | 0.308 | 0/15 | 0.193 |
| 48 | zf_xiaoyi | F | 0.055 | 11/15 | 0.407 | 4/15 | 0.231 |
| 49 | zm_yunjian | M | 0.068 | 10/15 | 0.252 | 3/15 | 0.160 |
| 50 | zm_yunxi | M | 0.068 | 11/15 | 0.206 | 5/15 | 0.137 |
| 51 | zm_yunxia | M | 0.061 | 11/15 | 0.343 | 1/15 | 0.202 |
| 52 | zm_yunyang | M | 0.055 | 11/15 | 0.253 | 6/15 | 0.154 |

How to read it: much of the residual CER is the ASR appending a filler particle
(`谢谢 -> 谢谢啊`, `这个多少钱 -> 这个多少钱嗯`) after the padded silence, which is a model
artefact, not a pronunciation error. Genuine errors are mostly voice 46 (`早上好 ->
造上 how`, `我是新加坡人 -> 沃斯心假迫人`) and voice 45 (`早上好 -> 早上好运`). Slow
clips score worse for every voice because the small ASR model is trained on normal speech.

**Choice**

* `ZH_VOICES = [47, 48, 50, 52]` (two female, two male): best normal-speed scores, no real
  mispronunciations. 49 and 51 are as good for normal speed but 47/48 were needed for a
  female/male balance. 45 and 46 are excluded.
* `DIALOGUE_VOICES = {"A": 47, "B": 50}`: best female (47, `zf_xiaoxiao`, best mean of the
  female voices; 48 is marginally better at normal speed only) and best male (50, `zm_yunxi`,
  best at slow speed and overall).
* English: `af_heart`, id 3 (not evaluated; no English ASR step).

Re-run after a model or pipeline change:
`python3 tools/eval_voices.py --model-dir models/kokoro-multi-lang-v1_0 --asr-dir models/sherpa-onnx-paraformer-zh-small-2024-03-09 --slow`

## How to run

Dependencies (Python 3.10+, ffmpeg and ffprobe on `PATH`):

```bash
pip install sherpa-onnx soundfile numpy scipy opencc-python-reimplemented pypinyin
mkdir -p models && cd models
BASE=https://github.com/k2-fsa/sherpa-onnx/releases/download
# TTS (about 350 MB unpacked, NOT committed; `models/` is git-ignored)
curl -SL $BASE/tts-models/kokoro-multi-lang-v1_0.tar.bz2 | tar xj   # English clips
curl -SL $BASE/tts-models/kokoro-multi-lang-v1_1.tar.bz2 | tar xj   # Mandarin clips
# ASR for verification (about 80 MB download)
curl -SL $BASE/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2 | tar xj
cd ..
```

Generate (incremental; run from the repo root):

```bash
python3 tools/generate_audio.py --dry-run                      # what would be built
python3 tools/generate_audio.py                                # build missing/changed clips
python3 tools/generate_audio.py --only u03,sys --jobs 2        # unit ids or clip-id prefixes
python3 tools/generate_audio.py --limit 10                     # smoke test: build 10 clips
python3 tools/generate_audio.py --force --only u01-w01         # rebuild regardless of cache
python3 tools/generate_audio.py --prune                        # delete mp3 files no longer in content
python3 tools/generate_audio.py --root /tmp/r --content-root tests/fixtures/content   # fixture test
```

Singapore set (Mandarin only; needs only `--zh-model-dir`, or the model dir of the chosen engine):

```bash
python3 tools/generate_audio.py --accent sg --zh-engine <engine> --dry-run   # what would be built
python3 tools/generate_audio.py --accent sg --zh-engine <engine> --jobs 2    # build/update audio-sg/
```

Commit `audio-sg/**/*.mp3`, `audio-sg/manifest.json` and `audio-sg/.cache.json` together
(the app picks the set up automatically; Singapore is the default accent once it has clips).

`--model-dir` (or `$AUDIO_MODEL_DIR`, English) defaults to `models/kokoro-multi-lang-v1_0`;
`--zh-model-dir` (or `$AUDIO_ZH_MODEL_DIR`, Mandarin) to `models/kokoro-multi-lang-v1_1`. Commit
`audio/**/*.mp3`, `audio/manifest.json` and `audio/.cache.json` together.

How it behaves:

* `audio/.cache.json` stores `{clipId: {hash, dur}}`. The hash covers text, voice, speed,
  `PIPELINE_VERSION` and the model name, so editing a word regenerates only that clip, and
  bumping `PIPELINE_VERSION` (after changing post-processing) regenerates everything.
* File name = clip id with `.` replaced by `_`, e.g. `u01-w01.slow` ->
  `audio/zh-slow/u01-w01_slow.mp3`; the manifest holds the relative path so the app never
  needs this rule.
* `audio/manifest.json` lists every required clip present on disk. `generatedAt` only
  changes when the clip table changes, so a no-op run leaves no git diff.
* English text is normalised and every word resolved before synthesis; see
  **English normalisation and the extra lexicon** below. `--check-en` runs only that check.
* Speed: about 1 s wall time per clip on 2 cores (single process using both cores), about
  1.5 CPU-seconds per clip. `--jobs 2` (two single-thread workers, each with its own model)
  is slightly faster (about 0.8 s per clip) at the cost of 2x model memory.

Verify:

```bash
python3 tools/verify_audio.py                      # normal-speed Mandarin clips
python3 tools/verify_audio.py --include-slow       # also the slow clips
python3 tools/verify_audio.py --only u05 --threshold 0.25
```

Add `--carrier` for the second test of short clips (<= 4 Han characters): the clip is repeated
as `0.5 s silence + clip + 0.5 s silence + clip` and counts as heard if the reference occurs
in the transcript; "flagged after carrier" = flagged standalone AND failed the carrier test.
Writes `audio/verify-report.json` (per clip: reference, transcript, CER, flag) and prints a
per-voice summary and the 30 worst clips. A clip is flagged when CER > 0.34 (for 1-2
character texts only CER >= 1.0). Before comparing, punctuation is dropped, text is
converted to simplified, digits become hanzi numerals and `两` is treated as `二`. A flagged
clip is a prompt to listen to it: typical ASR false alarms are a filler particle appended
after the clip (`谢谢 -> 谢谢啊`); real problems are wrong characters. To fix a real one,
change the item text slightly (add a measure word, use a longer phrase) or, for a single
item, rewrite the wording; there is no per-item voice override.

### Results: v1.0 vs v1.1-zh + content lexicon (2026-11-17)

All 911 normal-speed Mandarin clips, ASR `sherpa-onnx-paraformer-zh-small-2024-03-09`,
`python3 tools/verify_audio.py --carrier`:

| | v1.0 (old voices) | v1.1-zh (voices 30, 4, 63, 75) |
|---|---|---|
| mean CER | 0.248 | **0.233** |
| flagged (CER > 0.34; 1-2 chars: CER >= 1) | 165 / 911 | **122 / 911** |
| short clips heard in the carrier test | 304 / 528 | **327 / 528** |
| flagged after carrier | 152 | **114** |
| clips of >= 3 characters flagged | - | 8 / 569 |

Per voice (v1.1; IDs: 4 and 75 also speak the dialogues, which are long and score well,
so compare the "items only" column):

| Voice | Clips | Mean CER | Items only | Flagged | Flagged after carrier |
|---|---|---|---|---|---|
| 30 (F) | 150 | 0.290 | 0.290 | 25 | 23 |
| 4 (F) | 302 | 0.216 | 0.398 | 35 | 34 |
| 63 (M) | 168 | 0.276 | 0.276 | 28 | 27 |
| 75 (M) | 291 | 0.195 | 0.332 | 34 | 30 |

For references of >= 3 characters the voices are within noise (0.036 / 0.049 / 0.037 / 0.033).
The remaining flags are almost all single syllables (`走 -> though`, `猫 -> no`): the ASR
model answers isolated one-syllable clips with an English word or a homophone, and the
carrier does not cure that. Real candidates to listen to: `星期一`, `星期几？`, `星期天`
(always misheard; the same word is fine inside sentences), `发烧吗？`, `下大雨`.
