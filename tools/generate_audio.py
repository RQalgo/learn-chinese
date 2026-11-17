#!/usr/bin/env python3
"""generate_audio.py -- build every MP3 clip the app plays, offline.

PURPOSE
    The app (ARCHITECTURE sections 5 and 8) plays *pre-recorded MP3 clips* through a
    single <audio> element so that playback survives a locked Android screen. This
    tool turns the lesson content (data/units.json + data/units/*.json) and the fixed
    prompts in docs/AUDIO.md into those clips, plus ``audio/manifest.json``.

HOW IT FITS
    content JSON --(this tool)--> audio/{zh,zh-slow,en,sys}/*.mp3 + audio/manifest.json
                                       |
        tools/verify_audio.py  <-------+   (ASR round trip, reuses enumerate_clips())
        js/data/loader.js reads manifest.json; js/audio/player.js plays clip ids.

CLIP IDS AND FILE NAMES (ARCHITECTURE section 5)
    The app only knows clip ids. On disk the file name is the clip id with every
    "." replaced by "_" plus ".mp3", in a folder chosen by the clip kind:

        u01-w01            -> audio/zh/u01-w01.mp3          (Mandarin, normal)
        u01-w01.slow       -> audio/zh-slow/u01-w01_slow.mp3 (Mandarin, speed 0.75)
        u01-w01.en         -> audio/en/u01-w01_en.mp3
        u01-d01.l2         -> audio/zh/u01-d01_l2.mp3
        u01-d01.l2.slow    -> audio/zh-slow/u01-d01_l2_slow.mp3
        u01-d01.l2.en      -> audio/en/u01-d01_l2_en.mp3
        u01-d01.q1.en      -> audio/en/u01-d01_q1_en.mp3
        sys.welcome        -> audio/sys/sys_welcome.mp3
        sys.silence.500    -> audio/sys/sys_silence_500.mp3

    The manifest stores the *relative* path (``audio/zh/u01-w01.mp3``) so the app
    never has to know this rule.

USAGE
    python3 tools/generate_audio.py --model-dir models/kokoro-multi-lang-v1_0
    python3 tools/generate_audio.py --dry-run                # list what would be built
    python3 tools/generate_audio.py --only u03,sys --jobs 2  # unit ids / clip-id prefixes
    python3 tools/generate_audio.py --limit 5 --force        # rebuild 5 clips regardless of cache
    python3 tools/generate_audio.py --prune                  # also delete unreferenced mp3 files
    python3 tools/generate_audio.py --root /tmp/r --content-root tests/fixtures/content
    python3 tools/generate_audio.py --check-en               # only check English words; exit 1 on OOV

    Environment: AUDIO_MODEL_DIR can replace --model-dir. Needs ffmpeg/ffprobe on PATH.

ENGLISH TEXT (why it is not spoken verbatim)
    The Kokoro English front end looks every word up in ``lexicon-us-en.txt`` and
    silently SKIPS any word that is missing ("twenty minutes" -> "twenty"). So all
    English clip text (``.en`` clips and ``sys.*``) is normalised first (``/`` ->
    "or", parentheses -> commas, acronyms -> spelled letters), then every word is
    resolved: from the base lexicon, from the hand-written ``tools/lexicon-extra-en.txt``
    (Mandarin names, Singlish), or by *inflecting* a known stem (plural, possessive,
    -ed, -ing). The resolved extra entries are written to a temporary lexicon that is
    passed to sherpa-onnx after the base one. See docs/AUDIO.md, "English
    normalisation and the extra lexicon".

PIPELINE PER CLIP
    Kokoro (sherpa-onnx) -> float samples -> ffmpeg trims leading/trailing silence ->
    gain to a fixed RMS level with a peak ceiling -> ~120 ms silence added at both
    ends -> mono 24 kHz 40 kbps MP3. Silence clips come straight from ffmpeg.
"""

# ===== Section: Imports and constants ============================================

from __future__ import annotations

import argparse
import hashlib
import json
import math
import multiprocessing as mp
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zlib
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import zh_lexicon  # noqa: E402  (content-driven Mandarin lexicon)
from zh_lexicon import ZhLexicon  # noqa: E402

# WHY: bump when the post-processing chain or engine settings change; it is part of
# every clip's cache hash, so a bump regenerates everything exactly once.
PIPELINE_VERSION = "1"
MODEL_NAME = "kokoro-multi-lang-v1_0"        # English clips (.en, sys.*)
# WHY a second model: Kokoro v1.1-zh pronounces Mandarin clearly better than v1.0 but has
# no better English; English clips therefore stay on v1.0 and are never rebuilt.
ZH_MODEL_NAME = "kokoro-multi-lang-v1_1"     # Mandarin clips (zh, zh-slow)

# --- Voices ---
# Mandarin: Kokoro multi-lang v1.1 speaker ids 3-57 are female, 58-102 male (0-2 are English).
# WHY these four: two female + two male chosen by ASR screening (docs/AUDIO.md "Voice
# evaluation"). Changing this list changes which voice every item gets -> regenerates audio.
ZH_VOICES = [30, 4, 63, 75]  # F, F, M, M (v1.1 ids)
DIALOGUE_VOICES = {"A": 4, "B": 75}  # A = female, B = male (v1.1 ids)
EN_VOICE = 3  # af_heart, US English
SLOW_SPEED = 0.75
NORMAL_SPEED = 1.0

# --- Audio format ---
SAMPLE_RATE = 24000
MP3_BITRATE = "40k"
PAD_SECONDS = 0.12          # silence kept/added at both ends of speech clips
TARGET_RMS_DB = -21.0       # speech loudness target (dBFS RMS of the trimmed signal)
PEAK_CEILING = 0.89         # about -1 dBFS, applied with a limiter
MAX_GAIN_DB = 24.0          # never amplify near-silent garbage by more than this
SILENCE_MS = [500, 1000, 1500, 2000, 3000]

# Fixed English prompts (docs/AUDIO.md "Fixed English prompts").
SYS_PROMPTS = {
    "sys.welcome": "Let's start.",
    "sys.newWords": "New words.",
    "sys.review": "Review time. Listen, and think of the meaning.",
    "sys.whatMeans": "What does this mean?",
    "sys.dialogue": "Now, a short conversation.",
    "sys.again": "Once more, at normal speed.",
    "sys.done": "Well done. That's the end of this session.",
}

# WHY: the Kokoro English lexicon lacks these contractions; sherpa-onnx then silently
# *skips* the word ("That's the end" is spoken as "the end"). Spelling them out is
# audibly identical for a learner and never drops a word. Found by checking
# lexicon-us-en.txt; extend this map when generate_audio.py prints an OOV warning.
CONTRACTIONS = {"that's": "that is", "what's": "what is", "here's": "here is",
                "how's": "how is", "where's": "where is", "when's": "when is"}

# Hand-written English-lexicon entries (Mandarin names, Singlish, ...); see docs/AUDIO.md.
EXTRA_LEXICON_PATH = Path(__file__).resolve().parent / "lexicon-extra-en.txt"

AUDIO_SUBDIRS = ("zh", "zh-slow", "en", "sys")
CACHE_VERSION = 1
MANIFEST_VERSION = 1


# ===== Section: Clip model and enumeration ========================================

@dataclass(frozen=True)
class Clip:
    """One audio clip the app may ask for.

    ``kind`` is the output folder: zh | zh-slow | en | sys. ``text`` is what is
    spoken (``""`` for silence); ``silence_ms`` is set only for silence clips.
    """

    id: str
    kind: str
    text: str
    voice: int
    speed: float
    silence_ms: int = 0
    lex_sig: str = ""
    pinyin: str = ""   # Mandarin clips only: source of the content-driven lexicon (not hashed itself)

    @property
    def rel_path(self) -> str:
        """Manifest path, relative to the repo root (``audio/zh/u01-w01.mp3``)."""
        return f"audio/{self.kind}/{self.id.replace('.', '_')}.mp3"

    @property
    def digest(self) -> str:
        """Hash of everything that influences the output bytes (cache key).

        ``lex_sig`` fingerprints the extra-lexicon entries (hand-written or inflected)
        this clip's words use; it is appended only when non-empty.
        WHY: clips that use no extra entry keep the exact pre-existing key, so adding
        the extra lexicon rebuilds only the English clips it affects (never Chinese
        ones), and editing one entry rebuilds only clips containing that word.
        """
        # WHY: Mandarin clips carry the v1.1 model name so they rebuild exactly once when
        # moving off v1.0; English clips keep the old identity and so their old keys.
        model = ZH_MODEL_NAME if self.kind in ("zh", "zh-slow") else MODEL_NAME
        parts = [self.text, self.voice, self.speed, self.silence_ms, PIPELINE_VERSION, model]
        if self.lex_sig:
            parts.append(self.lex_sig)
        payload = json.dumps(parts, ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# ===== Section: English normalisation and extra lexicon ===========================

_PUNCT = ",.;:?!"  # sentence punctuation the sherpa-onnx tokenizer splits off words


def normalize_english(text: str) -> str:
    """Stage 1 (model-free): rewrite English text into plain speakable prose.

    Spells out contractions the lexicon lacks (CONTRACTIONS), turns ``/`` into "or",
    parentheses into comma pauses, drops characters the tokenizer cannot handle and
    collapses whitespace. Stage 2 (``EnglishLexicon.prepare``) then resolves each word.
    WHY two stages: enumerate_clips() is also used by verify_audio.py, which has no
    model; only word resolution needs the lexicon.
    """
    def fix(match: "re.Match[str]") -> str:
        word = match.group(0)
        repl = CONTRACTIONS.get(word.lower())
        if repl is None:
            return word
        return repl.capitalize() if word[0].isupper() else repl

    t = text.replace("\u2019", "'").replace("\u2018", "'")
    t = re.sub(r"[A-Za-z]+'[A-Za-z]+", fix, t)
    t = re.sub(r"\s*/\s*", " or ", t)               # "I / me" -> "I or me"
    t = re.sub(r"\s*\(\s*", ", ", t)                # "you (polite)" -> "you, polite"
    t = re.sub(r"\s*\)\s*(?=\S)", ", ", t)          # ")" followed by more text -> pause
    t = t.replace(")", "")
    t = re.sub(rf"([{_PUNCT}]),", r"\1", t)         # "old?, to" -> "old? to"
    # WHY: sherpa-onnx only splits words at whitespace, ",.;:?!" and "-"; any other
    # symbol stays glued to the word, which then misses the lexicon and is skipped.
    t = re.sub(rf"[^\w'\-{_PUNCT} ]", " ", t)
    t = re.sub(r"(?<![A-Za-z])'|'(?![A-Za-z])", " ", t)     # apostrophes outside words
    t = re.sub(r"(?<![A-Za-z0-9])-|-(?![A-Za-z0-9])", " ", t)  # hyphens outside words
    t = re.sub(r"\s+", " ", t)
    t = re.sub(rf"\s+([{_PUNCT}])", r"\1", t)
    return re.sub(rf"^[{_PUNCT}\s]+", "", t).strip()


def parse_lexicon(path: Path) -> dict[str, str]:
    """Read a ``word phone phone ...`` lexicon into ``{word: "phone phone ..."}``.

    Blank lines and ``#`` comment lines are skipped; the first entry of a word wins.
    """
    entries: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        word, _, phones = line.partition(" ")
        entries.setdefault(word, phones.strip())
    return entries


# Phone classes of the Kokoro English lexicon, used to pick suffix allomorphs.
_SIBILANT = {"s", "z", "\u0283", "\u0292", "\u02a7", "\u02a4"}
_VOICELESS = {"p", "t", "k", "f", "\u03b8", "s", "\u0283", "\u02a7"}
_ALVEOLAR_STOP = {"t", "d", "\u027e"}


def _suffix_s(phones: str) -> str:
    """Phones of plural / possessive / 3rd-person ``-s`` (``\u1d7b z`` / ``s`` / ``z``).

    Copies the lexicon's own convention: ``buses b \u02c8 \u028c s \u1d7b z``, ``cats ... t s``,
    ``cars ... \u0279 z``.
    """
    last = phones.split()[-1]
    if last in _SIBILANT:
        return "\u1d7b z"
    return "s" if last in _VOICELESS else "z"


def _suffix_ed(phones: str) -> str:
    """Phones of ``-ed`` (``\u1d7b d`` / ``t`` / ``d``), per ``needed``, ``worked``, ``played``."""
    last = phones.split()[-1]
    if last in _ALVEOLAR_STOP:
        return "\u1d7b d"
    return "t" if last in _VOICELESS else "d"


class EnglishLexicon:
    """Word -> phones lookup mirroring what sherpa-onnx will know, plus inflection.

    ``base`` is Kokoro's ``lexicon-us-en.txt``; ``manual`` is the hand-written
    ``tools/lexicon-extra-en.txt``. ``generated`` collects the entries inflected
    on demand (``minutes`` from ``minute``); write all non-base entries with
    ``write_extra`` and pass that file to sherpa-onnx after the base lexicon.
    """

    def __init__(self, base: dict[str, str], manual: dict[str, str]):
        self.base = base
        self.manual = manual
        self.generated: dict[str, str] = {}

    @classmethod
    def load(cls, model_dir: Path, extra_path: Path = EXTRA_LEXICON_PATH) -> "EnglishLexicon":
        """Load the model's English lexicon and the committed extra lexicon."""
        lex = model_dir / "lexicon-us-en.txt"
        if not lex.exists():
            raise SystemExit(f"error: no English lexicon at {lex} (see docs/AUDIO.md, 'How to run')")
        manual = parse_lexicon(extra_path) if extra_path.exists() else {}
        return cls(parse_lexicon(lex), manual)

    def phones(self, word: str) -> Optional[str]:
        """Phones for a lowercase word from manual, generated or base entries (or None)."""
        return self.manual.get(word) or self.generated.get(word) or self.base.get(word)

    def inflect(self, word: str) -> Optional[str]:
        """Build phones for an OOV inflected word from its stem, or return None.

        Handles possessive ``'s``, plural/3rd-person ``-s/-es/-ies``, past ``-ed/-d/-ied``
        and ``-ing`` (including doubled consonants and dropped ``e``). Suffix phones
        follow the base lexicon's own spelling (see ``_suffix_s`` / ``_suffix_ed``).
        """
        def stem_of(cands: list[str]) -> Optional[str]:
            for cand in cands:
                if len(cand) >= 2 and self.phones(cand):
                    return self.phones(cand)
            return None

        w = word
        if w.endswith("'s"):
            stem = stem_of([w[:-2]])
            return f"{stem} {_suffix_s(stem)}" if stem else None
        if w.endswith("s") and not w.endswith("ss"):
            cands = ([w[:-3] + "y"] if w.endswith("ies") else []) + \
                    ([w[:-2]] if w.endswith("es") else []) + [w[:-1]]
            stem = stem_of(cands)
            if stem:
                return f"{stem} {_suffix_s(stem)}"
        if w.endswith("ed"):
            cands = ([w[:-3] + "y"] if w.endswith("ied") else []) + [w[:-2], w[:-1]]
            if len(w) > 4 and w[-3] == w[-4]:
                cands.append(w[:-3])  # stopped -> stop
            stem = stem_of(cands)
            if stem:
                return f"{stem} {_suffix_ed(stem)}"
        if w.endswith("ing"):
            cands = [w[:-3], w[:-3] + "e"]
            if len(w) > 5 and w[-4] == w[-5]:
                cands.append(w[:-4])  # running -> run
            stem = stem_of(cands)
            if stem:
                return f"{stem} \u026a \u014b"
        return None

    def prepare(self, text: str) -> tuple[str, dict[str, str], list[str]]:
        """Stage 2: resolve every word of normalised ``text``.

        Returns ``(spoken text, extra entries used, unresolved words)``. Uppercase
        acronyms the lexicon lacks (``MRT``) become spaced letters (``M R T``); OOV
        inflections are generated; ``used`` holds every manual or generated entry the
        text relies on (basis of the clip's cache key); ``unresolved`` lists words
        still unknown, which sherpa-onnx would silently skip.
        """
        used: dict[str, str] = {}
        unresolved: list[str] = []

        def resolve(part: str) -> str:
            low = part.lower()
            if not low:
                return part
            if low in self.manual:
                used[low] = self.manual[low]
                return part
            if low in self.base:
                return part
            if part.isalpha() and part.isupper() and len(part) >= 2:
                letters = list(part)
                for letter in letters:
                    if not self.phones(letter.lower()):
                        unresolved.append(letter)
                return " ".join(letters)
            phones = self.generated.get(low) or self.inflect(low)
            if phones:
                self.generated[low] = phones
                used[low] = phones
                return part
            unresolved.append(low)
            return part

        def chunk(match: "re.Match[str]") -> str:
            return "-".join(resolve(p) for p in match.group(0).split("-"))

        spoken = re.sub(rf"[^\s{_PUNCT}]+", chunk, text)
        return spoken, used, unresolved

    def write_extra(self, path: Path) -> None:
        """Write manual + generated entries as a sherpa-onnx lexicon file (no comments)."""
        merged = {**self.generated, **self.manual}
        path.write_text("".join(f"{w} {p}\n" for w, p in sorted(merged.items())), encoding="utf-8")


def lex_signature(used: dict[str, str]) -> str:
    """Short stable fingerprint of the extra entries a clip uses ('' if none)."""
    if not used:
        return ""
    blob = "\n".join(f"{w} {p}" for w, p in sorted(used.items()))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


def resolve_english(clips: list[Clip], lex: EnglishLexicon) -> tuple[list[Clip], dict[str, list[str]]]:
    """Run stage 2 over every English clip.

    Returns ``(clips with final text + lex_sig, {unresolved word: [clip ids]})``.
    Non-English clips are returned untouched (same objects).
    """
    out: list[Clip] = []
    oov: dict[str, list[str]] = {}
    for c in clips:
        if c.kind in ("en", "sys") and c.text:
            spoken, used, bad = lex.prepare(c.text)
            for w in bad:
                oov.setdefault(w, []).append(c.id)
            c = replace(c, text=spoken, lex_sig=lex_signature(used))
        out.append(c)
    return out, oov


def item_voice(item_id: str) -> int:
    """Pick the Mandarin voice for an item, stable across runs and machines.

    WHY: zlib.crc32 rather than ``hash()`` -- Python randomises str hashes per
    process (PYTHONHASHSEED), which would silently reshuffle voices and
    invalidate the whole cache on every run.
    """
    return ZH_VOICES[zlib.crc32(item_id.encode("utf-8")) % len(ZH_VOICES)]


def load_json(path: Path):
    """Read a UTF-8 JSON file, raising a readable error that names the file."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"error: cannot read {path}: {exc}")


def enumerate_clips(content_root: Path) -> list[Clip]:
    """Return every clip the content requires, in a stable order.

    Covers ARCHITECTURE section 5: item normal/slow/en, dialogue line
    normal/slow/en, dialogue question en, plus all ``sys.*`` prompts and silences.
    Raises SystemExit on a duplicate clip id or malformed content.
    """
    clips: list[Clip] = []
    index = load_json(content_root / "data" / "units.json")
    for unit_ref in sorted(index["units"], key=lambda u: u.get("order", 0)):
        unit = load_json(content_root / unit_ref["file"])
        for item in unit.get("items", []):
            iid, voice = item["id"], item_voice(item["id"])
            clips.append(Clip(iid, "zh", item["hanzi"], voice, NORMAL_SPEED, pinyin=item["pinyin"]))
            clips.append(Clip(f"{iid}.slow", "zh-slow", item["hanzi"], voice, SLOW_SPEED, pinyin=item["pinyin"]))
            clips.append(Clip(f"{iid}.en", "en", normalize_english(item["english"]), EN_VOICE, NORMAL_SPEED))
        for dlg in unit.get("dialogues", []):
            did = dlg["id"]
            for n, line in enumerate(dlg.get("lines", []), start=1):
                voice = DIALOGUE_VOICES[line["speaker"]]
                clips.append(Clip(f"{did}.l{n}", "zh", line["hanzi"], voice, NORMAL_SPEED, pinyin=line["pinyin"]))
                clips.append(Clip(f"{did}.l{n}.slow", "zh-slow", line["hanzi"], voice, SLOW_SPEED, pinyin=line["pinyin"]))
                clips.append(Clip(f"{did}.l{n}.en", "en", normalize_english(line["english"]), EN_VOICE, NORMAL_SPEED))
            for n, q in enumerate(dlg.get("questions", []), start=1):
                clips.append(Clip(f"{did}.q{n}.en", "en", normalize_english(q["question"]), EN_VOICE, NORMAL_SPEED))
    for cid, text in SYS_PROMPTS.items():
        clips.append(Clip(cid, "sys", normalize_english(text), EN_VOICE, NORMAL_SPEED))
    for ms in SILENCE_MS:
        clips.append(Clip(f"sys.silence.{ms}", "sys", "", 0, 1.0, silence_ms=ms))

    seen: set[str] = set()
    for c in clips:
        if c.id in seen:
            raise SystemExit(f"error: duplicate clip id {c.id!r} in content")
        seen.add(c.id)
    return clips


def select_clips(clips: list[Clip], only: Optional[str]) -> list[Clip]:
    """Filter by ``--only``: comma-separated unit ids or clip-id prefixes.

    A unit id such as ``u03`` is simply a prefix of every clip id in that unit,
    so one prefix rule covers both forms.
    """
    if not only:
        return clips
    prefixes = tuple(p.strip() for p in only.split(",") if p.strip())
    return [c for c in clips if c.id.startswith(prefixes)]


# ===== Section: Cache and manifest ================================================

def load_cache(path: Path) -> dict:
    """Load ``audio/.cache.json`` -> ``{clipId: {"hash": ..., "dur": ...}}`` (empty if absent)."""
    if not path.exists():
        return {}
    data = load_json(path)
    return data.get("clips", {}) if data.get("version") == CACHE_VERSION else {}


def save_cache(path: Path, clips: dict) -> None:
    """Write the cache atomically (temp file + rename) so Ctrl-C cannot corrupt it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(
        json.dumps({"version": CACHE_VERSION, "clips": clips}, indent=1, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)


def audio_duration(path: Path) -> float:
    """Duration of an MP3 in seconds (2 decimals) via soundfile, ffprobe as fallback."""
    try:
        import soundfile as sf

        return round(float(sf.info(str(path)).duration), 2)
    except Exception:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return round(float(out), 2)


def write_manifest(root: Path, required: list[Clip], cache: dict) -> int:
    """Write ``audio/manifest.json`` listing each required clip that exists on disk.

    Returns the number of clips listed. ``generatedAt`` is only refreshed when the
    clip table actually changed.
    WHY: a timestamp that changes on every run would make every no-op run a git diff.
    """
    clips = {}
    for c in required:
        path = root / c.rel_path
        if not path.exists():
            continue
        entry = cache.get(c.id)
        dur = entry["dur"] if entry and "dur" in entry else audio_duration(path)
        clips[c.id] = {"src": c.rel_path, "dur": round(dur, 2)}

    mpath = root / "audio" / "manifest.json"
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if mpath.exists():
        try:
            old = json.loads(mpath.read_text(encoding="utf-8"))
            if old.get("clips") == clips:
                generated = old.get("generatedAt", generated)
        except ValueError:
            pass
    manifest = {"version": MANIFEST_VERSION, "generatedAt": generated, "clips": clips}
    mpath.parent.mkdir(parents=True, exist_ok=True)
    mpath.write_text(
        json.dumps(manifest, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return len(clips)


# ===== Section: TTS engine =========================================================

def load_tts(model_dir: Path, num_threads: int, extra_lexicon: Optional[Path] = None,
             zh_extra_lexicon: Optional[Path] = None):
    """Create the Kokoro ``OfflineTts`` object (slow: several seconds, ~350 MB model).

    WHY one model per process: the sherpa-onnx object is not shared across
    processes, and loading per clip would cost more than synthesis itself. With
    --jobs N each worker loads its own copy once and reuses it for all its clips.
    WHY the lexicon pair and rule FSTs: Kokoro multi-lang needs both lexicons to
    speak Mandarin and English, and the FSTs expand numbers/dates/phones in hanzi
    text; without them digits are skipped or misread.
    WHY ``extra_lexicon`` sits between the two: later lexicons override earlier ones
    (verified), so hand-written/inflected English entries win over the base English
    ones, and the Mandarin lexicon (hanzi keys) is unaffected.
    WHY ``zh_extra_lexicon`` comes LAST: for the Mandarin model the content-driven entries
    (tools/zh_lexicon.py) must override ``lexicon-zh.txt`` (verified: later file wins).
    The text is cut into words by longest match over the merged lexicons (sherpa-onnx
    >= 1.12.15 ignores ``dict_dir`` for Kokoro), so a new entry is automatically a token.
    """
    import sherpa_onnx

    d = str(model_dir)
    en_lex = f"{d}/lexicon-us-en.txt" + (f",{extra_lexicon}" if extra_lexicon else "")
    kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=f"{d}/model.onnx",
        voices=f"{d}/voices.bin",
        tokens=f"{d}/tokens.txt",
        data_dir=f"{d}/espeak-ng-data",
        dict_dir=f"{d}/dict",
        lexicon=f"{en_lex},{d}/lexicon-zh.txt" + (f",{zh_extra_lexicon}" if zh_extra_lexicon else ""),
    )
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro, num_threads=num_threads),
        rule_fsts=f"{d}/date-zh.fst,{d}/phone-zh.fst,{d}/number-zh.fst",
        max_num_sentences=1,
    )
    if not cfg.validate():
        raise SystemExit(f"error: invalid TTS config; is {model_dir} a complete Kokoro model dir?")
    return sherpa_onnx.OfflineTts(cfg)


def synthesize(tts, text: str, voice: int, speed: float):
    """Run TTS; return ``(float32 samples, sample_rate)``."""
    import numpy as np

    audio = tts.generate(text, sid=voice, speed=speed)
    return np.asarray(audio.samples, dtype=np.float32), audio.sample_rate


# ===== Section: ffmpeg post-processing =============================================

def run_ffmpeg(args: list[str]) -> None:
    """Run ffmpeg quietly; raise RuntimeError with its stderr on failure."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.strip()}")


# WHY the double silenceremove around areverse: silenceremove only trims the
# *start* reliably; reversing the stream lets the same filter trim the tail.
_TRIM = (
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0,"
    "areverse,"
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0,"
    "areverse"
)


def encode_speech(samples, sample_rate: int, out_path: Path) -> None:
    """Post-process synthesized speech into the final MP3.

    Steps: write temp WAV -> ffmpeg trim silence -> measure RMS in Python -> ffmpeg
    gain + limiter + pad + mono 24 kHz MP3 at 40 kbps.
    WHY manual gain instead of ffmpeg ``loudnorm``: loudnorm integrates over 400 ms+
    gating blocks and behaves erratically on 0.5-1 s clips such as single words.
    A fixed RMS target with a peak limiter gives even, predictable loudness.
    """
    import numpy as np
    import soundfile as sf

    with tempfile.TemporaryDirectory(prefix="gen_audio_") as tmp:
        raw, trimmed = Path(tmp) / "raw.wav", Path(tmp) / "trim.wav"
        sf.write(str(raw), samples, sample_rate, subtype="FLOAT")
        run_ffmpeg(["-i", str(raw), "-af", _TRIM, "-ac", "1", "-ar", str(SAMPLE_RATE),
                    "-c:a", "pcm_f32le", str(trimmed)])
        data, _ = sf.read(str(trimmed), dtype="float32")
        if data.size < SAMPLE_RATE // 50:
            raise RuntimeError("synthesis produced (almost) no audio")
        rms = float(np.sqrt(np.mean(np.square(data.astype(np.float64)))))
        gain_db = min(TARGET_RMS_DB - 20 * math.log10(max(rms, 1e-9)), MAX_GAIN_DB)
        pad_ms = int(PAD_SECONDS * 1000)
        chain = (
            f"volume={gain_db:.2f}dB,alimiter=limit={PEAK_CEILING}:level=disabled,"
            f"adelay={pad_ms}:all=1,apad=pad_dur={PAD_SECONDS}"
        )
        out_path.parent.mkdir(parents=True, exist_ok=True)
        run_ffmpeg(["-i", str(trimmed), "-af", chain, "-ac", "1", "-ar", str(SAMPLE_RATE),
                    "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, str(out_path)])


def encode_silence(ms: int, out_path: Path) -> None:
    """Create a silent MP3 of exactly ``ms`` milliseconds directly with ffmpeg.

    WHY real files: ARCHITECTURE section 8 -- gaps must be audio clips because
    ``setTimeout`` is throttled with the screen off, which would stall hands-free mode.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(["-f", "lavfi", "-i", f"anullsrc=r={SAMPLE_RATE}:cl=mono",
                "-t", f"{ms / 1000:.3f}", "-ac", "1", "-c:a", "libmp3lame",
                "-b:a", MP3_BITRATE, str(out_path)])


def build_clip(tts, clip: Clip, root: Path) -> float:
    """Generate one clip file under ``root``; return its duration in seconds."""
    out = root / clip.rel_path
    if clip.silence_ms:
        encode_silence(clip.silence_ms, out)
    else:
        samples, sr = synthesize(tts, clip.text, clip.voice, clip.speed)
        encode_speech(samples, sr, out)
    return audio_duration(out)


# ===== Section: Workers (multiprocessing) ==========================================

@dataclass(frozen=True)
class TtsPaths:
    """Where the two models and their generated extras live (picklable, sent to workers)."""

    en_dir: str
    zh_dir: str
    en_extra: str
    zh_extra: str
    threads: int


class TtsSet:
    """The two Kokoro models, each loaded the first time a clip needs it.

    WHY lazy: a run that only rebuilds Mandarin (or only English) clips never pays
    for (about 350 MB and several seconds) the other model.
    """

    def __init__(self, paths: TtsPaths):
        self.paths = paths
        self._tts: dict[str, object] = {}

    def for_clip(self, clip: Clip):
        """Return the loaded model for ``clip``: v1.1 for zh/zh-slow, v1.0 otherwise."""
        lang = "zh" if clip.kind in ("zh", "zh-slow") else "en"
        if lang not in self._tts:
            p = self.paths
            if lang == "zh":
                self._tts[lang] = load_tts(Path(p.zh_dir), p.threads, zh_extra_lexicon=Path(p.zh_extra))
            else:
                self._tts[lang] = load_tts(Path(p.en_dir), p.threads, Path(p.en_extra))
        return self._tts[lang]


_WORKER: dict = {}


def _worker_init(paths: TtsPaths) -> None:
    """Pool initializer: create this worker's private (lazy) model set."""
    _WORKER["tts"] = TtsSet(paths)


def _worker_run(job: tuple[Clip, str]) -> tuple[str, str, Optional[float], Optional[str], float]:
    """Pool task: build one clip. Returns (id, digest, dur|None, error|None, seconds)."""
    clip, root = job
    t0 = time.time()
    try:
        dur = build_clip(_WORKER["tts"].for_clip(clip), clip, Path(root))
        return clip.id, clip.digest, dur, None, time.time() - t0
    except Exception as exc:  # report per clip; keep the batch going
        return clip.id, clip.digest, None, str(exc), time.time() - t0


# ===== Section: Main ================================================================

def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    """Parse the command line (see the module docstring for examples)."""
    here = Path(__file__).resolve().parent.parent
    p = argparse.ArgumentParser(
        description="Generate all MP3 clips + audio/manifest.json from the lesson content.")
    p.add_argument("--root", type=Path, default=here, help="repo root; audio/ is written here (default: inferred)")
    p.add_argument("--content-root", type=Path, default=None,
                   help="folder containing data/units.json (default: --root; use tests/fixtures/content for tests)")
    p.add_argument("--model-dir", type=Path, default=None,
                   help="Kokoro model dir (default: $AUDIO_MODEL_DIR or <root>/models/kokoro-multi-lang-v1_0)")
    p.add_argument("--zh-model-dir", type=Path, default=None,
                   help="Kokoro v1.1 model dir for the Mandarin clips "
                        "(default: $AUDIO_ZH_MODEL_DIR or <root>/models/kokoro-multi-lang-v1_1)")
    p.add_argument("--only", help="comma-separated unit ids or clip-id prefixes, e.g. u01,sys")
    p.add_argument("--limit", type=int, help="build at most N clips (after cache filtering)")
    p.add_argument("--jobs", type=int, default=1, help="worker processes, one TTS model each (default 1)")
    p.add_argument("--force", action="store_true", help="rebuild even if the cache says unchanged")
    p.add_argument("--check-en", action="store_true",
                   help="only check that every English word is speakable (no OOV); exit 1 if not")
    p.add_argument("--dry-run", action="store_true", help="list clips that would be built and exit")
    p.add_argument("--prune", action="store_true", help="delete mp3 files no longer referenced by the content")
    args = p.parse_args(argv)
    args.root = args.root.resolve()
    args.content_root = (args.content_root or args.root).resolve()
    if args.model_dir is None:
        env = os.environ.get("AUDIO_MODEL_DIR")
        args.model_dir = Path(env) if env else args.root / "models" / MODEL_NAME
    if args.zh_model_dir is None:
        env = os.environ.get("AUDIO_ZH_MODEL_DIR")
        args.zh_model_dir = Path(env) if env else args.root / "models" / ZH_MODEL_NAME
    return args


def fmt_time(seconds: float) -> str:
    """Format seconds as ``m:ss``."""
    seconds = int(max(seconds, 0))
    return f"{seconds // 60}:{seconds % 60:02d}"


def prune_stale(root: Path, required: Iterable[Clip], cache: dict, do_delete: bool) -> int:
    """Find (and with ``do_delete`` remove) mp3 files not referenced by any required clip.

    Returns the count found. Cache entries for unknown clips are dropped when deleting.
    """
    keep = {root / c.rel_path for c in required}
    stale = []
    for sub in AUDIO_SUBDIRS:
        d = root / "audio" / sub
        if d.is_dir():
            stale += [f for f in sorted(d.glob("*.mp3")) if f not in keep]
    for f in stale:
        print(("prune: removing " if do_delete else "stale (use --prune to remove): ") + str(f.relative_to(root)))
        if do_delete:
            f.unlink()
    if do_delete:
        ids = {c.id for c in required}
        for cid in [k for k in cache if k not in ids]:
            del cache[cid]
    return len(stale)


def main(argv: Optional[list[str]] = None) -> int:
    """Entry point: enumerate, filter, build, then write cache and manifest."""
    args = parse_args(argv)
    lex = EnglishLexicon.load(args.model_dir)
    required, oov = resolve_english(enumerate_clips(args.content_root), lex)
    # WHY a hard stop: an OOV word is silently dropped from the audio, which is worse
    # than no clip. Add the word to tools/lexicon-extra-en.txt or fix the content.
    for word, ids in sorted(oov.items()):
        print(f"OOV: English word {word!r} is not speakable (in: {', '.join(ids[:4])}"
              f"{', ...' if len(ids) > 4 else ''})")
    if args.check_en:
        n_en = sum(1 for c in required if c.kind in ("en", "sys") and c.text)
        print(f"check-en: {n_en} English clips, {len(oov)} unresolved word(s), "
              f"{len(lex.generated)} inflected + {len(lex.manual)} hand-written extra entries")
        return 1 if oov else 0
    if oov:
        print("error: fix the OOV words above first (tools/lexicon-extra-en.txt); nothing was built")
        return 1
    extra_dir = tempfile.TemporaryDirectory(prefix="gen_audio_lex_")
    extra_lex = Path(extra_dir.name) / "lexicon-extra-en.txt"
    lex.write_extra(extra_lex)
    # Mandarin: content-driven lexicon (neutral tones, 不/一); needs only the zh model's text files.
    if not (args.zh_model_dir / "lexicon-zh.txt").exists():
        raise SystemExit(f"error: no Kokoro v1.1 model at {args.zh_model_dir} (--zh-model-dir; see docs/AUDIO.md)")
    zh_lex = ZhLexicon.build(args.zh_model_dir, zh_lexicon.content_lines(required))
    for msg in zh_lex.problems:
        print(f"zh-lexicon: {msg}")
    zh_extra = zh_lex.write_file(Path(extra_dir.name))
    required = [replace(c, lex_sig=zh_lex.signature(c.text, c.pinyin)) if c.kind in ("zh", "zh-slow") else c
                for c in required]
    print(f"zh-lexicon: {zh_lex.stats['entries']} entries ({zh_lex.stats['repaired']} repairs) "
          f"from {zh_lex.stats['lines']} lines ({zh_lex.stats['unaligned']} unaligned)")
    cache_path = args.root / "audio" / ".cache.json"
    cache = load_cache(cache_path)

    def up_to_date(c: Clip) -> bool:
        entry = cache.get(c.id)
        return bool(entry) and entry.get("hash") == c.digest and (args.root / c.rel_path).exists()

    selected = select_clips(required, args.only)
    todo = [c for c in selected if args.force or not up_to_date(c)]
    if args.limit is not None:
        todo = todo[: args.limit]
    print(f"{len(required)} clips required, {len(selected)} selected, {len(todo)} to build "
          f"({len(selected) - len(todo)} up to date or limited)")

    if args.dry_run:
        for c in todo:
            print(f"  {c.id:<22} {c.kind:<8} voice={c.voice:<3} speed={c.speed:<4} {c.text!r}")
        return 0

    if args.prune:
        prune_stale(args.root, required, cache, True)
    else:
        n = prune_stale(args.root, required, cache, False)
        if n:
            print(f"note: {n} stale file(s) on disk")

    failures: list[tuple[str, str]] = []
    if todo:
        if shutil.which("ffmpeg") is None:
            raise SystemExit("error: ffmpeg not found on PATH")
        # Silence needs no model; build it first so a --jobs>1 pool only sees speech.
        speech = []
        for c in todo:
            if c.silence_ms:
                dur = build_clip(None, c, args.root)
                cache[c.id] = {"hash": c.digest, "dur": dur}
            else:
                speech.append(c)
        total, done, t_start, busy = len(todo), len(todo) - len(speech), time.time(), 0.0
        for needed, kinds in ((args.model_dir, ("en", "sys")), (args.zh_model_dir, ("zh", "zh-slow"))):
            if any(c.kind in kinds for c in speech) and not (needed / "model.onnx").exists():
                raise SystemExit(f"error: no Kokoro model at {needed} (see docs/AUDIO.md, 'How to run')")
        paths = TtsPaths(str(args.model_dir), str(args.zh_model_dir), str(extra_lex), str(zh_extra), 1)

        def report(cid: str, err: Optional[str], secs: float) -> None:
            """Print one progress line with elapsed time and ETA."""
            nonlocal done, busy
            done += 1
            busy += secs
            elapsed = time.time() - t_start
            eta = elapsed / done * (total - done)
            print(f"[{done}/{total}] {cid}  {'FAILED: ' + err if err else f'{secs:.1f}s'}"
                  f"  elapsed {fmt_time(elapsed)}  ETA {fmt_time(eta)}", flush=True)

        try:
            if speech and args.jobs <= 1:
                tts = TtsSet(replace(paths, threads=os.cpu_count() or 2))
                for c in speech:
                    t0 = time.time()
                    try:
                        cache[c.id] = {"hash": c.digest, "dur": build_clip(tts.for_clip(c), c, args.root)}
                        report(c.id, None, time.time() - t0)
                    except Exception as exc:
                        failures.append((c.id, str(exc)))
                        report(c.id, str(exc), time.time() - t0)
                    if done % 20 == 0:
                        save_cache(cache_path, cache)
            elif speech:
                paths = replace(paths, threads=max(1, (os.cpu_count() or 2) // args.jobs))
                # WHY spawn: forking a process that has imported onnxruntime is fragile.
                ctx = mp.get_context("spawn")
                with ctx.Pool(args.jobs, _worker_init, (paths,)) as pool:
                    jobs = [(c, str(args.root)) for c in speech]
                    for cid, digest, dur, err, secs in pool.imap_unordered(_worker_run, jobs):
                        if err:
                            failures.append((cid, err))
                        else:
                            cache[cid] = {"hash": digest, "dur": dur}
                        report(cid, err, secs)
                        if done % 20 == 0:
                            save_cache(cache_path, cache)
        finally:
            # WHY in finally: keep progress made before an interrupt or crash.
            save_cache(cache_path, cache)
        if speech:
            print(f"speech clips: {len(speech)} built, {busy / len(speech):.2f}s mean wall time per clip per worker")

    # Drop cache entries whose file vanished so they are rebuilt next time.
    on_disk = {c.id for c in required if (args.root / c.rel_path).exists()}
    for cid in [k for k in cache if k in {c.id for c in required} and k not in on_disk]:
        del cache[cid]
    save_cache(cache_path, cache)
    n = write_manifest(args.root, required, cache)
    print(f"manifest: {n}/{len(required)} required clips on disk -> audio/manifest.json")
    if failures:
        print(f"{len(failures)} clip(s) FAILED:")
        for cid, err in failures:
            print(f"  {cid}: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
