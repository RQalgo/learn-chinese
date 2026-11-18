#!/usr/bin/env python3
"""eval_voices.py -- rank the Kokoro Mandarin voices (ids 45-52) by ASR intelligibility.

PURPOSE
    Decides which voices go into ``ZH_VOICES`` / ``DIALOGUE_VOICES`` in
    generate_audio.py. Every voice speaks the same varied sentences (greetings,
    numbers, prices, times, questions, short words); each clip goes through the
    *same* post-processing and MP3 encoding as the real pipeline, is transcribed by
    the ASR model and scored with the CER from verify_audio.py. Lower CER = the
    voice is easier to understand (for the ASR, which is a proxy for a beginner).

HOW IT FITS
    Authoring-time helper, not used by the app. Reuses generate_audio (TTS +
    encoding) and verify_audio (ASR + CER). Results are recorded in docs/AUDIO.md
    ("Voice evaluation").

USAGE
    python3 tools/eval_voices.py --model-dir MODEL --asr-dir ASR [--slow] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_audio as ga  # noqa: E402
import verify_audio as va  # noqa: E402

VOICES = {45: ("zf_xiaobei", "F"), 46: ("zf_xiaoni", "F"), 47: ("zf_xiaoxiao", "F"), 48: ("zf_xiaoyi", "F"),
          49: ("zm_yunjian", "M"), 50: ("zm_yunxi", "M"), 51: ("zm_yunxia", "M"), 52: ("zm_yunyang", "M")}

# Written to resemble the real unit content: single words, phrases, numbers, prices, times, questions.
SENTENCES = [
    "你好", "谢谢", "对不起", "再见",
    "早上好！", "我叫小明。", "你叫什么名字？", "我是新加坡人。",
    "这个多少钱？", "三十五块。", "我要两杯咖啡。", "现在两点半。",
    "明天早上八点见。", "地铁站在哪里？", "你今天过得怎么样？",
]


def main() -> int:
    """Synthesize, transcribe and print the per-voice CER table."""
    here = Path(__file__).resolve().parent.parent
    p = argparse.ArgumentParser(description="Rank Kokoro Mandarin voices 45-52 by ASR CER.")
    p.add_argument("--model-dir", type=Path, default=here / "models" / ga.MODEL_NAME)
    p.add_argument("--asr-dir", type=Path, default=here / "models" / va.DEFAULT_ASR)
    p.add_argument("--slow", action="store_true", help="also evaluate speed 0.75")
    p.add_argument("--json", type=Path, help="write raw per-clip results here")
    args = p.parse_args()

    tts = ga.load_tts(args.model_dir, 2)
    asr = va.load_asr(args.asr_dir)
    speeds = [("normal", ga.NORMAL_SPEED)] + ([("slow", 0.75)] if args.slow else [])
    raw = []
    with tempfile.TemporaryDirectory(prefix="eval_voices_") as tmp:
        for vid in VOICES:
            t0 = time.time()
            for label, speed in speeds:
                paths = []
                for i, text in enumerate(SENTENCES):
                    out = Path(tmp) / f"{vid}_{label}_{i}.mp3"
                    samples, sr = ga.synthesize(tts, text, vid, speed)
                    ga.encode_speech(samples, sr, out)
                    paths.append(out)
                for text, hyp in zip(SENTENCES, va.transcribe(asr, paths)):
                    raw.append({"voice": vid, "speed": label, "ref": text, "hyp": hyp, "cer": va.cer(text, hyp)})
            print(f"voice {vid} done in {time.time() - t0:.0f}s", file=sys.stderr, flush=True)

    def mean(rows):
        """Mean CER of a list of result rows."""
        return sum(r["cer"] for r in rows) / len(rows)

    print(f"\n{'id':>3} {'name':<12} {'sex':<3} " + " ".join(f"{l + ' CER':>10} {'perfect':>8}" for l, _ in speeds))
    for vid, (name, sex) in VOICES.items():
        cells = []
        for label, _ in speeds:
            rows = [r for r in raw if r["voice"] == vid and r["speed"] == label]
            cells.append(f"{mean(rows):>10.3f} {sum(r['cer'] == 0 for r in rows):>5}/{len(rows)}")
        print(f"{vid:>3} {name:<12} {sex:<3} " + " ".join(cells))
    print("\nMisheard (normal speed):")
    for r in raw:
        if r["speed"] == "normal" and r["cer"] > 0:
            print(f"  voice {r['voice']}  CER {r['cer']:.2f}  {r['ref']} -> {r['hyp']}")
    if args.json:
        args.json.write_text(json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
