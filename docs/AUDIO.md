# Audio pipeline

All speech is generated offline and committed as MP3, because the app must keep
playing on Android with the screen off (Chrome's built-in `speechSynthesis`
stops when the screen locks).

## Engine

* `sherpa-onnx` (pip) with the **Kokoro multi-lang v1.0** model
  (`kokoro-multi-lang-v1_0`, Apache-2.0), from
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2`.
* The model is **not** committed (≈ 350 MB). `tools/generate_audio.py --model-dir` points at it.
* ~1 s of CPU per 1 s of audio on 2 cores, so generation is **incremental**: each clip's
  inputs (text, voice, speed, engine version) are hashed into `audio/.cache.json`;
  unchanged clips are skipped.

## Voices (Kokoro speaker IDs)

| Use | Speaker IDs |
|---|---|
| Mandarin items | rotate over the chosen Mandarin voices, picked deterministically from a hash of the item ID so an item always has the same voice |
| Dialogue speaker A / B | one female, one male Mandarin voice |
| English | one clear US English voice (`af_heart`, id 3) |

Kokoro v1.0 Mandarin voices are ids 45–52 (`zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`,
`zf_xiaoyi`, `zm_yunjian`, `zm_yunxi`, `zm_yunxia`, `zm_yunyang`). The final choice is
recorded in `tools/generate_audio.py` (`ZH_VOICES`, `DIALOGUE_VOICES`) after an ASR
intelligibility check (see **Voice evaluation** below).

## Speeds

* normal: speed 1.0 for Mandarin and English.
* slow (`.slow` clips): Mandarin at speed 0.75.

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

## Verification

`tools/verify_audio.py` transcribes every Mandarin clip with a sherpa-onnx Mandarin
ASR model and computes the character error rate (CER) against the hanzi (punctuation
stripped). Output: `audio/verify-report.json` and a summary table. Clips with CER > 0.34
are listed for a human (or re-generation with another voice). ASR is not perfect on
1–2 character words, so short words are judged leniently.

## Voice evaluation

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
pip install sherpa-onnx soundfile numpy scipy opencc-python-reimplemented
mkdir -p models && cd models
BASE=https://github.com/k2-fsa/sherpa-onnx/releases/download
# TTS (about 350 MB unpacked, NOT committed; `models/` is git-ignored)
curl -SL $BASE/tts-models/kokoro-multi-lang-v1_0.tar.bz2 | tar xj
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

`--model-dir` (or `$AUDIO_MODEL_DIR`) defaults to `models/kokoro-multi-lang-v1_0`. Commit
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
* Contractions the Kokoro English lexicon lacks (`that's`, `what's`...) are spelled out
  (`that is`) because sherpa-onnx silently drops unknown words. A warning is printed for
  any other unknown English word.
* Speed: about 1 s wall time per clip on 2 cores (single process using both cores), about
  1.5 CPU-seconds per clip. `--jobs 2` (two single-thread workers, each with its own model)
  is slightly faster (about 0.8 s per clip) at the cost of 2x model memory.

Verify:

```bash
python3 tools/verify_audio.py                      # normal-speed Mandarin clips
python3 tools/verify_audio.py --include-slow       # also the 0.75x clips
python3 tools/verify_audio.py --only u05 --threshold 0.25
```

Writes `audio/verify-report.json` (per clip: reference, transcript, CER, flag) and prints a
per-voice summary and the 30 worst clips. A clip is flagged when CER > 0.34 (for 1-2
character texts only CER >= 1.0). Before comparing, punctuation is dropped, text is
converted to simplified, digits become hanzi numerals and `两` is treated as `二`. A flagged
clip is a prompt to listen to it: typical ASR false alarms are a filler particle appended
after the clip (`谢谢 -> 谢谢啊`); real problems are wrong characters. To fix a real one,
change the item text slightly (add a measure word, use a longer phrase) or, for a single
item, rewrite the wording; there is no per-item voice override.
