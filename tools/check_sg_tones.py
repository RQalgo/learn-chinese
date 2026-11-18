#!/usr/bin/env python3
"""check_sg_tones.py -- ablation proof that the Singapore tone mode changes the audio where it should.

PURPOSE
    Renders some words with the Mainland lexicon (neutral tones) and the Singapore lexicon (full
    tones). Words whose second syllable must become a full tone (谢谢 东西 朋友 先生 ...) must
    DIFFER; words that stay neutral in both (孩子 我的 好吗) must NOT.
    WHY statistics and not a sample-by-sample comparison: Kokoro in sherpa-onnx is not
    deterministic (two renders of the same text differ in length by ~0.3 %), so each word is
    rendered ``--runs`` times per lexicon and the second syllable is described by its median F0
    (semitones) and its energy relative to the first syllable. A word "differs" when the
    cn and sg means of either measure are further apart than 3 pooled standard deviations (and
    than a small floor); the numbers are printed.

USAGE
    python3 tools/check_sg_tones.py --zh-model-dir /path/to/kokoro-multi-lang-v1_1 [--voices 30,63]
    Exit code 1 when an expectation fails. Needs the model; not part of the unit tests.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_audio as ga  # noqa: E402
import zh_lexicon  # noqa: E402

MUST_DIFFER = ["谢谢", "东西", "朋友", "先生", "衣服", "妈妈", "喜欢", "漂亮"]
MUST_MATCH = ["孩子", "我的", "好吗"]


def main(argv=None) -> int:
    here = Path(__file__).resolve().parent.parent
    p = argparse.ArgumentParser(description="Ablation check of the Singapore tone mode.")
    p.add_argument("--zh-model-dir", type=Path, default=here / "models" / ga.ZH_MODEL_NAME)
    p.add_argument("--content-root", type=Path, default=here)
    p.add_argument("--voices", default="30,63", help="comma-separated Kokoro v1.1 speaker ids")
    p.add_argument("--runs", type=int, default=6, help="renders per word, voice and lexicon (default 6)")
    args = p.parse_args(argv)
    import numpy as np

    lines = zh_lexicon.content_lines(ga.enumerate_clips(args.content_root))
    tts = {}
    tmp = tempfile.TemporaryDirectory(prefix="sg_tones_")
    for name, sg in (("cn", False), ("sg", True)):
        lex = zh_lexicon.ZhLexicon.build(args.zh_model_dir, lines, sg=sg)
        d = Path(tmp.name) / name
        tts[name] = ga.load_tts(args.zh_model_dir, 1, zh_extra_lexicon=lex.write_file(d))
    import librosa

    def measure(x):
        """(second-half median F0 in semitones re 100 Hz, second/first half RMS) of the voiced part."""
        f0 = librosa.yin(x, fmin=70, fmax=450, sr=ga.SAMPLE_RATE, frame_length=1024, hop_length=256)
        rms = librosa.feature.rms(y=x, frame_length=1024, hop_length=256)[0][: len(f0)]
        voiced = np.where(rms > 0.2 * rms.max())[0]
        mid = voiced[0] + (voiced[-1] - voiced[0]) // 2
        second = [i for i in voiced if i >= mid]
        return (float(12 * np.log2(np.median(f0[second]) / 100.0)),
                float(np.sqrt(np.mean(rms[second] ** 2) / max(1e-9, np.mean(rms[[i for i in voiced if i < mid]] ** 2)))))

    bad = 0
    print(f"{'word':<5}{'voice':>6}  {'result':<10}{'F0 2nd syl (st) cn -> sg':>28}{'energy 2nd/1st cn -> sg':>28}")
    for word in MUST_DIFFER + MUST_MATCH:
        for voice in (int(v) for v in args.voices.split(",")):
            m = {k: np.array([measure(ga.synthesize(tts[k], word, voice, 1.0)[0]) for _ in range(args.runs)]) for k in ("cn", "sg")}
            floor = np.array([0.5, 0.06])   # semitones, energy ratio: ignore differences smaller than this
            sd = np.sqrt((m["cn"].std(axis=0) ** 2 + m["sg"].std(axis=0) ** 2) / 2)
            delta = np.abs(m["cn"].mean(axis=0) - m["sg"].mean(axis=0))
            differs = bool(np.any((delta > 3 * sd) & (delta > floor)))
            ok = (not differs) if word in MUST_MATCH else differs
            bad += not ok
            f = lambda k, c: f"{m[k][:, c].mean():6.2f}+-{m[k][:, c].std():.2f}"
            print(f"{word:<5}{voice:>6}  {'DIFFERS' if differs else 'same':<10}{f('cn', 0)} -> {f('sg', 0)}   {f('cn', 1)} -> {f('sg', 1)}" + ("" if ok else "   <-- UNEXPECTED"))
    print("ablation OK" if not bad else f"{bad} unexpected result(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
