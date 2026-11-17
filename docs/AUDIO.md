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
recorded in `tools/generate_audio.py` (`ZH_VOICES`) after an ASR intelligibility check.

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
