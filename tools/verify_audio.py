#!/usr/bin/env python3
"""verify_audio.py -- ASR round-trip check of the generated Mandarin clips.

PURPOSE
    A TTS voice can mispronounce a word (wrong tone, polyphonic character, dropped
    syllable). For a listening-only learning app that is a content bug. This tool
    transcribes each generated Mandarin clip with a sherpa-onnx Mandarin ASR model
    and compares the transcript with the source hanzi: the character error rate
    (CER) is the edit distance divided by the length of the reference.

HOW IT FITS
    Reads audio/manifest.json + the content (via generate_audio.enumerate_clips, so
    the reference texts are exactly what was synthesized) and writes
    audio/verify-report.json. generate_audio.py's voices are chosen with it too
    (tools/eval_voices.py reuses ``load_asr`` / ``transcribe`` / ``cer``).

USAGE
    python3 tools/verify_audio.py --asr-dir models/sherpa-onnx-paraformer-zh-small-2024-03-09
    python3 tools/verify_audio.py --only u01 --threshold 0.25
    python3 tools/verify_audio.py --include-slow      # also check the slow clips
    python3 tools/verify_audio.py --carrier           # second, fairer test for short clips

    --carrier: the ASR model is unreliable on one or two isolated syllables (it hears a
    filler or a homophone). For references of at most 4 Han characters the clip is also
    transcribed as ``0.5 s silence + clip + 0.5 s silence + clip`` and counts as heard
    when the reference occurs as a substring of that transcript. Both metrics are
    reported; a short clip is "flagged after carrier" only when it fails both.

    Clips are flagged when CER > threshold (default 0.34). For references of 1-2
    characters only CER >= 1.0 (nothing recognised correctly) is flagged, because one
    wrong character is already 50-100 % CER and ASR is unreliable on tiny inputs.
    Exit status is 0 even with flagged clips (a human decides); 1 on setup errors.

TEXT NORMALISATION BEFORE COMPARING
    * punctuation, spaces and symbols removed (only letters and digits kept);
    * traditional -> simplified (OpenCC, if installed) -- some ASR models emit it;
    * digits -> hanzi numerals (ASR often writes 3点 for 三点);
    * 两 -> 二 on both sides: 两点 is correct Mandarin, but ASR may write either 两 or 二 (and 2),
      so both are treated as the same character.
"""

# ===== Section: Imports and constants ===============================================

from __future__ import annotations

import argparse
import json
import sys
import time
import unicodedata
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_audio as ga  # noqa: E402  (shared clip enumeration)

DEFAULT_ASR = "sherpa-onnx-paraformer-zh-small-2024-03-09"
DEFAULT_THRESHOLD = 0.34
SHORT_LEN = 2  # references this short are only flagged at CER >= 1.0
_DIGITS = "零一二三四五六七八九"


# ===== Section: Text normalisation and CER ==========================================

def int_to_hanzi(n: int) -> str:
    """Spell a non-negative integer in hanzi (``35`` -> 三十五, ``100`` -> 一百).

    Handles 0-9999 properly; larger numbers fall back to digit-by-digit.
    """
    if n < 10:
        return _DIGITS[n]
    if n >= 10000:
        return "".join(_DIGITS[int(d)] for d in str(n))
    out, zero_pending = "", False
    for value, unit in ((1000, "千"), (100, "百"), (10, "十"), (1, "")):
        digit, n = divmod(n, value)
        if digit == 0:
            zero_pending = bool(out)
            continue
        if zero_pending:
            out += "零"
            zero_pending = False
        # 10-19 are "十X", not "一十X"
        out += ("" if (digit == 1 and value == 10 and not out) else _DIGITS[digit]) + unit
    return out


def digits_to_hanzi(text: str) -> str:
    """Replace each run of ASCII digits in ``text`` with its hanzi reading."""
    out, run = [], ""
    for ch in text + "\0":
        if ch.isascii() and ch.isdigit():
            run += ch
            continue
        if run:
            # WHY: leading zero (phone numbers, "007") reads digit by digit.
            out.append("".join(_DIGITS[int(d)] for d in run) if run[0] == "0" and len(run) > 1
                       else int_to_hanzi(int(run)))
            run = ""
        out.append(ch)
    return "".join(out).rstrip("\0")


_T2S = None


def to_simplified(text: str) -> str:
    """Convert traditional to simplified with OpenCC when available (no-op otherwise)."""
    global _T2S
    if _T2S is None:
        try:
            from opencc import OpenCC

            try:
                _T2S = OpenCC("t2s").convert
            except Exception:
                _T2S = OpenCC("t2s.json").convert
        except Exception:
            _T2S = lambda s: s  # noqa: E731
    return _T2S(text)


def normalise(text: str) -> str:
    """Normalise ASR output or reference text for CER (see module docstring)."""
    text = to_simplified(unicodedata.normalize("NFKC", text))
    text = digits_to_hanzi(text)
    text = text.replace("两", "二").lower()
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in ("L", "N"))


def edit_distance(a: str, b: str) -> int:
    """Levenshtein distance between two strings (single-row dynamic programming)."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(ref: str, hyp: str) -> float:
    """Character error rate of ``hyp`` against ``ref`` after normalisation (can exceed 1.0)."""
    r, h = normalise(ref), normalise(hyp)
    if not r:
        return 0.0 if not h else 1.0
    return edit_distance(r, h) / len(r)


def is_flagged(ref: str, value: float, threshold: float) -> bool:
    """Apply the flag rule: CER > threshold, but only CER >= 1.0 for 1-2 character refs."""
    if len(normalise(ref)) <= SHORT_LEN:
        return value >= 1.0
    return value > threshold


# ===== Section: ASR ================================================================

def load_asr(asr_dir: Path, num_threads: int = 2):
    """Create an offline Paraformer recognizer from a sherpa-onnx model directory.

    Supports Paraformer (``model.int8.onnx`` / ``model.onnx``) and SenseVoice
    (``model.int8.onnx`` plus the SenseVoice marker in the folder name).
    """
    import sherpa_onnx

    model = next((asr_dir / n for n in ("model.int8.onnx", "model.onnx") if (asr_dir / n).exists()), None)
    if model is None or not (asr_dir / "tokens.txt").exists():
        raise SystemExit(f"error: no ASR model in {asr_dir} (see docs/AUDIO.md, 'How to run')")
    if "sense-voice" in asr_dir.name.lower():
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model), tokens=str(asr_dir / "tokens.txt"), num_threads=num_threads,
            use_itn=True, language="zh")
    return sherpa_onnx.OfflineRecognizer.from_paraformer(
        paraformer=str(model), tokens=str(asr_dir / "tokens.txt"), num_threads=num_threads)


def read_audio(path: Path):
    """Read an MP3/WAV as mono float32 -> ``(samples, sample_rate)``."""
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = np.ascontiguousarray(data.mean(axis=1))
    if sr == 24000:
        # WHY: resample here (24k -> 16k, the ASR rate) so sherpa-onnx does not print
        # a "Creating a resampler" block for every single clip.
        try:
            from scipy.signal import resample_poly

            return np.ascontiguousarray(resample_poly(mono, 2, 3), dtype=np.float32), 16000
        except ImportError:
            pass
    return mono, sr


CARRIER_MAX_HAN = 4       # --carrier applies to references up to this many characters
CARRIER_GAP_S = 0.5       # silence before, between and after the two copies


def carrier_audio(samples, sr: int):
    """Build ``silence + clip + silence + clip`` (the clip twice, 0.5 s apart) for the carrier test."""
    import numpy as np

    gap = np.zeros(int(CARRIER_GAP_S * sr), dtype=np.float32)
    return np.concatenate([gap, samples, gap, samples, gap])


def transcribe(recognizer, paths: list[Path], batch: int = 8, carrier: bool = False) -> list[str]:
    """Transcribe audio files; returns one transcript per path (same order).

    With ``carrier`` each file is transcribed as ``carrier_audio`` of itself.
    """
    results: list[str] = []
    for i in range(0, len(paths), batch):
        streams = []
        for p in paths[i:i + batch]:
            samples, sr = read_audio(p)
            if carrier:
                samples = carrier_audio(samples, sr)
            s = recognizer.create_stream()
            s.accept_waveform(sr, samples)
            streams.append(s)
        recognizer.decode_streams(streams)
        results += [s.result.text for s in streams]
    return results


# ===== Section: Main ================================================================

def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    """Parse the command line (see the module docstring for examples)."""
    here = Path(__file__).resolve().parent.parent
    p = argparse.ArgumentParser(description="ASR round-trip check of generated Mandarin clips.")
    p.add_argument("--root", type=Path, default=here, help="repo root holding audio/ (default: inferred)")
    p.add_argument("--content-root", type=Path, default=None, help="folder with data/units.json (default: --root)")
    p.add_argument("--asr-dir", type=Path, default=None,
                   help=f"ASR model dir (default: $ASR_MODEL_DIR or <root>/models/{DEFAULT_ASR})")
    p.add_argument("--only", help="comma-separated unit ids or clip-id prefixes")
    p.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD, help="flag CER above this (default 0.34)")
    p.add_argument("--include-slow", action="store_true", help="also check the .slow clips")
    p.add_argument("--carrier", action="store_true",
                   help=f"also test clips of <= {CARRIER_MAX_HAN} Han characters twice in a row (see module docstring)")
    p.add_argument("--worst", type=int, default=30, help="how many worst clips to print (default 30)")
    args = p.parse_args(argv)
    args.root = args.root.resolve()
    args.content_root = (args.content_root or args.root).resolve()
    if args.asr_dir is None:
        import os
        env = os.environ.get("ASR_MODEL_DIR")
        args.asr_dir = Path(env) if env else args.root / "models" / DEFAULT_ASR
    return args


def main(argv: Optional[list[str]] = None) -> int:
    """Entry point: transcribe, score, write the report, print the summary."""
    args = parse_args(argv)
    kinds = {"zh", "zh-slow"} if args.include_slow else {"zh"}
    clips = [c for c in ga.select_clips(ga.enumerate_clips(args.content_root), args.only)
             if c.kind in kinds and (args.root / c.rel_path).exists()]
    if not clips:
        print("no generated Mandarin clips found to verify (run generate_audio.py first)")
        return 1
    recognizer = load_asr(args.asr_dir)
    t0 = time.time()
    hyps = transcribe(recognizer, [args.root / c.rel_path for c in clips])

    short = [c for c in clips if args.carrier and len(normalise(c.text)) <= CARRIER_MAX_HAN]
    car_hyp = dict(zip([c.id for c in short], transcribe(recognizer, [args.root / c.rel_path for c in short],
                                                        carrier=True)))
    rows = []
    for c, hyp in zip(clips, hyps):
        value = cer(c.text, hyp)
        ch = car_hyp.get(c.id)
        rows.append({"carrier_hyp": ch, "carrier_ok": None if ch is None else normalise(c.text) in normalise(ch),
                     "id": c.id, "voice": c.voice, "slow": c.kind == "zh-slow", "ref": c.text,
                     "ref_norm": normalise(c.text), "hyp": hyp, "hyp_norm": normalise(hyp),
                     "cer": round(value, 3), "flagged": is_flagged(c.text, value, args.threshold)})
    for r in rows:
        # WHY: a short clip is only a real suspect if it also fails the carrier test.
        r["flagged_after_carrier"] = r["flagged"] and r["carrier_ok"] is not True
    flagged = [r for r in rows if r["flagged"]]
    mean = sum(r["cer"] for r in rows) / len(rows)
    flagged_after = sum(1 for r in rows if r["flagged_after_carrier"])
    report = {
        "asr_model": args.asr_dir.name, "threshold": args.threshold, "short_ref_rule": "len<=2: flag only CER>=1.0",
        "summary": {"checked": len(rows), "flagged": len(flagged), "mean_cer": round(mean, 4),
                    "carrier_checked": len(short), "carrier_ok": sum(1 for r in rows if r["carrier_ok"]),
                    "flagged_after_carrier": flagged_after},
        "clips": {r["id"]: r for r in sorted(rows, key=lambda r: r["id"])},
    }
    out = args.root / "audio" / "verify-report.json"
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")

    print(f"ASR {args.asr_dir.name}: {len(rows)} clips in {time.time() - t0:.1f}s, "
          f"mean CER {mean:.3f}, flagged {len(flagged)} (threshold {args.threshold})")
    if args.carrier:
        n_ok = sum(1 for r in rows if r["carrier_ok"])
        print(f"carrier test: {n_ok}/{len(short)} short clips (<= {CARRIER_MAX_HAN} chars) heard correctly in "
              f"'clip, pause, clip'; flagged after carrier {flagged_after}/{len(flagged)}")
    print(f"{'voice':>5}  {'clips':>5}  {'mean CER':>8}  {'flagged':>7}" + ("  carrier ok  flagged-after" if args.carrier else ""))
    for v in sorted({r["voice"] for r in rows}):
        sub = [r for r in rows if r["voice"] == v]
        print(f"{v:>5}  {len(sub):>5}  {sum(r['cer'] for r in sub) / len(sub):>8.3f}  "
              f"{sum(r['flagged'] for r in sub):>7}"
              + (f"  {sum(1 for r in sub if r['carrier_ok'])}/{sum(1 for r in sub if r['carrier_ok'] is not None):<9}"
                 f"  {sum(1 for r in sub if r['flagged_after_carrier']):>5}" if args.carrier else ""))
    print(f"\nWorst {min(args.worst, len(rows))} clips:")
    print(f"{'clip':<20} {'CER':>5}  {'flag':<4} {'reference':<20} heard")
    for r in sorted(rows, key=lambda r: (-r["cer"], r["id"]))[: args.worst]:
        print(f"{r['id']:<20} {r['cer']:>5.2f}  {('*' if r['flagged_after_carrier'] else 'c' if r['flagged'] else '') if args.carrier else ('*' if r['flagged'] else ''):<4} {r['ref']:<20} {r['hyp']}")
    print(f"\nreport: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
