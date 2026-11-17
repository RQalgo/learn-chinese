#!/usr/bin/env python3
"""Content validator for the 听 Tīng lesson data.

PURPOSE
    Checks ``data/units.json`` and every unit file it references against the
    schema in ``docs/ARCHITECTURE.md`` section 4 and the writing rules in
    ``docs/CONTENT.md``, so mistakes are caught before audio is generated.

HOW IT FITS
    Authoring tool only (not shipped to the browser). Run it after editing
    content and before ``generate_audio.py``: the audio pipeline keys every clip
    by the IDs this tool guarantees are well-formed and unique.

CHECKS
    ERRORS   invalid JSON, missing/extra fields, wrong types, bad or duplicate
             IDs, unit id/title mismatch with the index, duplicate ``english``
             in a unit (also against other items' ``alt``), dialogue speakers
             not A/B, dialogue questions with < 3 distractors or the answer
             among the distractors, Latin letters / digits in ``hanzi``, tone
             digits in ``pinyin``.
    WARNINGS missing unit files (units are written incrementally), item counts
             other than 12/8/6 words/phrases/sentences and 2 dialogues,
             over-long sentences, pinyin syllable count != Han character count,
             and per-syllable disagreement with ``pypinyin`` (see the
             equivalence rules in ``compare_syllables``).

USAGE
    python3 tools/validate_content.py                 # human-readable summary
    python3 tools/validate_content.py --strict        # warnings fail the run
    python3 tools/validate_content.py --json          # machine-readable report
    python3 tools/validate_content.py --root /path/to/repo

    Exit status: 1 if there are errors (or warnings with --strict), else 0.

KEY CONCEPTS
    Issue   one finding (severity, code, location, message).
    Report  all issues plus per-unit statistics; ``validate()`` builds it.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pypinyin import Style, pinyin as _pypinyin
from pypinyin.pinyin_dict import pinyin_dict as _PYPINYIN_DICT

# ===== Section: Constants =====

ERROR = "error"
WARNING = "warning"

EXPECTED_COUNTS = {"word": 12, "phrase": 8, "sentence": 6}
EXPECTED_DIALOGUES = 2
MIN_DISTRACTORS = 3
HINT_MAX_CHARS = 80
SPEAKERS = ("A", "B")

# (last unit number of the range, max Han characters in a sentence / dialogue line)
LENGTH_LIMITS = ((8, 10), (16, 14), (24, 18))

TYPE_LETTER = {"word": "w", "phrase": "p", "sentence": "s"}

INDEX_FIELDS = {"id": str, "order": int, "title": str, "emoji": str,
                "description": str, "file": str}
UNIT_FIELDS = {"id": str, "title": str, "items": list, "dialogues": list}
ITEM_REQUIRED = {"id": str, "type": str, "hanzi": str, "pinyin": str, "english": str}
ITEM_OPTIONAL = {"alt": list, "hint": str}
DIALOGUE_FIELDS = {"id": str, "title": str, "lines": list, "questions": list}
LINE_FIELDS = {"speaker": str, "hanzi": str, "pinyin": str, "english": str}
QUESTION_FIELDS = {"id": str, "question": str, "answer": str, "distractors": list}

UNIT_ID_RE = re.compile(r"^u(\d{2})$")
ITEM_ID_RE = re.compile(r"^(u\d{2})-([wps])(\d{2})$")
DIALOGUE_ID_RE = re.compile(r"^(u\d{2})-d(\d{2})$")
QUESTION_ID_RE = re.compile(r"^(u\d{2}-d\d{2})-q(\d+)$")

# WHY: include CJK Extension A so rare characters still count as Han.
HAN_RE = re.compile(r"[㐀-䶿一-鿿]")
# WHY: full-width Latin/digits are just as unreadable to the TTS voice.
LATIN_OR_DIGIT_RE = re.compile(r"[A-Za-z0-9０-９Ａ-Ｚａ-ｚ]")

TONE_MARKS = {"̄": 1, "́": 2, "̌": 3, "̀": 4}
DIAERESIS = "̈"


# ===== Section: Issue and report model =====

@dataclass
class Issue:
    """One validation finding.

    Attributes:
        severity: ``ERROR`` or ``WARNING``.
        code: Short machine-friendly identifier, e.g. ``duplicate-english``.
        where: Human-readable location (unit/item id, or file path).
        message: What is wrong.
        extra: Optional structured details (given/suggested pinyin, ...).
    """

    severity: str
    code: str
    where: str
    message: str
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serialisable dict of this issue."""
        return {"severity": self.severity, "code": self.code,
                "where": self.where, "message": self.message, **self.extra}


@dataclass
class Report:
    """All findings plus per-unit statistics for one validation run."""

    issues: list[Issue] = field(default_factory=list)
    units: list[dict[str, Any]] = field(default_factory=list)

    def add(self, severity: str, code: str, where: str, message: str,
            **extra: Any) -> None:
        """Record a finding."""
        self.issues.append(Issue(severity, code, where, message, extra))

    def error(self, code: str, where: str, message: str, **extra: Any) -> None:
        """Record an ERROR finding."""
        self.add(ERROR, code, where, message, **extra)

    def warn(self, code: str, where: str, message: str, **extra: Any) -> None:
        """Record a WARNING finding."""
        self.add(WARNING, code, where, message, **extra)

    @property
    def errors(self) -> list[Issue]:
        """All findings with severity ERROR."""
        return [i for i in self.issues if i.severity == ERROR]

    @property
    def warnings(self) -> list[Issue]:
        """All findings with severity WARNING."""
        return [i for i in self.issues if i.severity == WARNING]

    def promote_warnings(self) -> None:
        """Turn every warning into an error (``--strict``)."""
        for issue in self.issues:
            issue.severity = ERROR

    def to_dict(self) -> dict[str, Any]:
        """Return the machine-readable report used by ``--json``."""
        return {"ok": not self.errors,
                "summary": {"errors": len(self.errors),
                            "warnings": len(self.warnings),
                            "units": len(self.units)},
                "errors": [i.to_dict() for i in self.errors],
                "warnings": [i.to_dict() for i in self.warnings],
                "units": self.units}


# ===== Section: Pinyin utilities =====

@dataclass
class Syllable:
    """One pinyin syllable in normalised form.

    Attributes:
        text: The syllable as written (tone mark included).
        base: Lower-case letters without tone mark, ü written as ``v``.
        tone: 1-4, or 0 for neutral / unmarked.
    """

    text: str
    base: str
    tone: int


def parse_syllable_text(text: str) -> tuple[str, int] | None:
    """Split a written syllable into (base, tone).

    Args:
        text: A syllable such as ``"hǎo"`` or ``"lǜ"``.

    Returns:
        ``(base, tone)`` or ``None`` if it carries two different tone marks.
    """
    base: list[str] = []
    tones: set[int] = set()
    for ch in unicodedata.normalize("NFD", text.lower()):
        if ch in TONE_MARKS:
            tones.add(TONE_MARKS[ch])
        elif ch == DIAERESIS:
            # WHY: ü is the only diaeresis letter in pinyin; compare it as 'v'
            # so "nü" (written) equals "nǚ" (pypinyin) irrespective of notation.
            if base and base[-1] == "u":
                base[-1] = "v"
        elif unicodedata.combining(ch):
            continue  # e.g. circumflex on ê
        else:
            base.append(ch)
    if len(tones) > 1:
        return None
    return "".join(base), (tones.pop() if tones else 0)


def _build_syllable_set() -> frozenset[str]:
    """Collect every toneless syllable pypinyin knows, as segmentation targets."""
    found: set[str] = set()
    for readings in _PYPINYIN_DICT.values():
        for reading in readings.split(","):
            parsed = parse_syllable_text(reading)
            if parsed and parsed[0]:
                found.add(parsed[0])
    return frozenset(found)


# WHY: derived from pypinyin itself so the stdlib+pypinyin-only constraint holds
# and the table can never drift from the reference reader used for comparison.
VALID_SYLLABLES = _build_syllable_set()


def segment_word(word: str) -> list[Syllable] | None:
    """Split one written pinyin word (no spaces) into syllables.

    Uses dynamic programming over the known syllable set. A lone trailing ``r``
    is an erhua suffix and becomes its own pseudo-syllable (see WHY below).

    Args:
        word: e.g. ``"péngyou"`` or ``"yìdiǎnr"``.

    Returns:
        The syllables, or ``None`` if the word cannot be segmented.
    """
    # Per-character (base, tone) so tone marks stay attached to their letters.
    chars: list[tuple[str, int, str]] = []
    for ch in word:
        parsed = parse_syllable_text(ch)
        if parsed is None or not parsed[0]:
            return None
        chars.append((parsed[0], parsed[1], ch))
    bases = "".join(c[0] for c in chars)
    # WHY: every written char contributes exactly one base letter, so indexes
    # into `bases` and `chars` coincide.
    n = len(chars)
    syll_cost = 10
    # WHY: erhua costs slightly more than a real syllable so "rén" is never
    # split as r+én, yet "diǎnr" can still end in a bare r.
    erhua_cost = 11
    best: list[tuple[int, list[int]] | None] = [None] * (n + 1)
    best[0] = (0, [])
    for i in range(n):
        if best[i] is None:
            continue
        for j in range(i + 1, min(n, i + 6) + 1):
            piece = bases[i:j]
            cost = None
            if piece in VALID_SYLLABLES:
                cost = syll_cost
            elif piece == "r" and i > 0:
                cost = erhua_cost
            if cost is None:
                continue
            marks = {c[1] for c in chars[i:j] if c[1]}
            if len(marks) > 1:
                continue
            total = best[i][0] + cost
            if best[j] is None or total < best[j][0]:
                best[j] = (total, best[i][1] + [j])
    if best[n] is None:
        return None
    result: list[Syllable] = []
    start = 0
    for end in best[n][1]:
        seg = chars[start:end]
        tone = next((c[1] for c in seg if c[1]), 0)
        result.append(Syllable("".join(c[2] for c in seg),
                               "".join(c[0] for c in seg), tone))
        start = end
    return result


def split_pinyin(text: str) -> tuple[list[Syllable], list[str]]:
    """Tokenise a pinyin string into syllables.

    Punctuation, digits and apostrophes act as word separators.

    Args:
        text: The ``pinyin`` field of an item or dialogue line.

    Returns:
        ``(syllables, unparsed_words)`` where unparsed words could not be
        segmented into known syllables (likely typos).
    """
    cleaned = "".join(ch if (ch.isalpha() or unicodedata.combining(ch)) else " "
                      for ch in unicodedata.normalize("NFC", text))
    syllables: list[Syllable] = []
    unparsed: list[str] = []
    for word in cleaned.split():
        segs = segment_word(word)
        if segs is None:
            unparsed.append(word)
        else:
            syllables.extend(segs)
    return syllables, unparsed


def han_chars(text: str) -> list[str]:
    """Return the Han characters of ``text`` in order (punctuation ignored)."""
    return HAN_RE.findall(text)


def expected_syllables(hanzi: str) -> list[Syllable]:
    """Ask pypinyin for one tone-marked syllable per Han character.

    Args:
        hanzi: Chinese text; non-Han characters are dropped.

    Returns:
        A list aligned one-to-one with ``han_chars(hanzi)``.
    """
    raw = _pypinyin(hanzi, style=Style.TONE, errors=lambda _s: [])
    out: list[Syllable] = []
    for item in raw:
        text = item[0]
        parsed = parse_syllable_text(text) or (text, 0)
        out.append(Syllable(text, parsed[0], parsed[1]))
    return out


def syllables_equivalent(given: Syllable, expected: Syllable, char: str,
                         next_expected_tone: int | None) -> bool:
    """Decide whether a written syllable matches pypinyin's, allowing the
    conventions documented in ``docs/CONTENT.md``.

    Args:
        given: Syllable from the content file.
        expected: pypinyin's syllable for the same character.
        char: The Han character (needed for the 不 / 一 rules).
        next_expected_tone: pypinyin's tone for the following character.

    Returns:
        True when the two should not be reported.
    """
    if char == "儿" and given.base == "r":
        return True  # erhua suffix merged into the previous syllable
    if given.base != expected.base:
        return False
    if given.tone == expected.tone:
        return True
    # WHY: neutral tone is written without a mark and pypinyin often keeps the
    # full tone (e.g. 2nd syllable of xièxie, V-不-V); never a content error.
    if given.tone == 0:
        return True
    # WHY: textbooks write the spoken tone of 不 (bú before a 4th tone). Accept
    # that, and also bù where pypinyin itself already applied the sandhi.
    if char == "不":
        if given.tone == 2 and expected.tone == 4 and next_expected_tone == 4:
            return True
        if given.tone == 4 and expected.tone == 2:
            return True
    # WHY: 一 is written yī / yí / yì depending on sandhi, and pypinyin applies
    # sandhi only sometimes, so any of the three is fine for 一.
    if char == "一" and given.tone in (1, 2, 4) and expected.tone in (1, 2, 4):
        return True
    # WHY: content writes 3rd tone in citation form, so "nǐ hǎo" must equal a
    # pypinyin that applied sandhi ("ní hǎo"). The reverse (content writing
    # sandhi) is intentionally NOT accepted: CONTENT.md forbids it.
    if expected.tone == 2 and given.tone == 3 and next_expected_tone == 3:
        return True
    return False


def compare_pinyin(hanzi: str, pinyin_text: str) -> dict[str, Any] | None:
    """Cross-check a ``pinyin`` string against ``hanzi``.

    Args:
        hanzi: The Chinese text.
        pinyin_text: The pinyin as written in the content file.

    Returns:
        ``None`` if everything agrees, otherwise a dict with ``kind``
        (``unparsed`` | ``count`` | ``mismatch``), ``message``, ``given`` and
        ``suggested`` (pypinyin's reading with spaces between syllables).
    """
    chars = han_chars(hanzi)
    expected = expected_syllables(hanzi)
    suggested = " ".join(s.text for s in expected)
    given, unparsed = split_pinyin(pinyin_text)
    if unparsed:
        return {"kind": "unparsed", "given": pinyin_text, "suggested": suggested,
                "message": "pinyin has unrecognised syllable(s): "
                           + ", ".join(unparsed)}
    if len(given) != len(chars) or len(expected) != len(chars):
        return {"kind": "count", "given": pinyin_text, "suggested": suggested,
                "message": f"{len(given)} pinyin syllable(s) for "
                           f"{len(chars)} Han character(s)"}
    diffs = []
    for idx, (g, e, ch) in enumerate(zip(given, expected, chars)):
        nxt = expected[idx + 1].tone if idx + 1 < len(expected) else None
        if not syllables_equivalent(g, e, ch, nxt):
            diffs.append(f"{ch} (#{idx + 1}): given '{g.text}', pypinyin '{e.text}'")
    if diffs:
        return {"kind": "mismatch", "given": pinyin_text, "suggested": suggested,
                "message": "pinyin differs from pypinyin: " + "; ".join(diffs)}
    return None


# ===== Section: Schema helpers =====

def check_fields(report: Report, obj: Any, required: dict[str, type],
                 optional: dict[str, type], where: str) -> bool:
    """Validate that ``obj`` is a dict with exactly the allowed fields/types.

    Args:
        report: Where to record findings.
        obj: The decoded JSON value.
        required: Field name -> expected type, all mandatory.
        optional: Field name -> expected type, may be absent.
        where: Location label for messages.

    Returns:
        True if ``obj`` is a dict whose required fields are all present
        (type errors are reported but do not stop later checks on other fields).
    """
    if not isinstance(obj, dict):
        report.error("wrong-type", where, f"expected an object, got {type(obj).__name__}")
        return False
    ok = True
    for name in required:
        if name not in obj:
            report.error("missing-field", where, f"missing required field '{name}'")
            ok = False
    for name in obj:
        if name not in required and name not in optional:
            report.error("extra-field", where, f"unexpected field '{name}'")
    for name, expected in {**required, **optional}.items():
        if name not in obj:
            continue
        value = obj[name]
        # WHY: bool is a subclass of int in Python but never a valid number here.
        if not isinstance(value, expected) or (expected is int and isinstance(value, bool)):
            report.error("wrong-type", where,
                         f"field '{name}' should be {expected.__name__}, "
                         f"got {type(value).__name__}")
            ok = False
        elif expected is str and not value.strip():
            report.error("empty-field", where, f"field '{name}' is empty")
            ok = False
    return ok


def load_json(report: Report, path: Path, label: str) -> Any | None:
    """Read and decode a JSON file, recording an error on failure.

    Returns:
        The decoded value, or ``None`` if unreadable/invalid.
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        report.error("invalid-json", label, f"invalid JSON: {exc.msg} "
                     f"(line {exc.lineno}, column {exc.colno})")
    except (OSError, UnicodeDecodeError) as exc:
        report.error("unreadable-file", label, f"cannot read file: {exc}")
    return None


# ===== Section: Item, dialogue and unit checks =====

class IdRegistry:
    """Tracks every ID seen across all units to catch duplicates."""

    def __init__(self) -> None:
        self.seen: dict[str, str] = {}

    def register(self, report: Report, id_: Any, where: str) -> None:
        """Record ``id_``; report an error if it was already used elsewhere."""
        if not isinstance(id_, str):
            return
        if id_ in self.seen:
            report.error("duplicate-id", where,
                         f"duplicate id '{id_}' (first used in {self.seen[id_]})")
        else:
            self.seen[id_] = where


def max_sentence_length(unit_id: str) -> int | None:
    """Return the Han-character limit for a unit id, or None if unparseable."""
    match = UNIT_ID_RE.match(unit_id)
    if not match:
        return None
    number = int(match.group(1))
    for last, limit in LENGTH_LIMITS:
        if number <= last:
            return limit
    return LENGTH_LIMITS[-1][1]


def check_text_fields(report: Report, hanzi: str, pinyin_text: str, where: str) -> None:
    """Apply the character-level ERROR rules shared by items and lines."""
    if LATIN_OR_DIGIT_RE.search(hanzi):
        report.error("latin-in-hanzi", where,
                     f"hanzi contains Latin letters or digits: {hanzi!r}")
    if re.search(r"[0-9０-９]", pinyin_text):
        report.error("tone-number", where,
                     f"pinyin contains digits (use tone marks): {pinyin_text!r}")


def check_pinyin(report: Report, hanzi: str, pinyin_text: str, where: str,
                 unit: str) -> None:
    """Run the pypinyin cross-check and record any WARNING."""
    result = compare_pinyin(hanzi, pinyin_text)
    if result is None:
        return
    code = {"unparsed": "pinyin-unrecognised", "count": "pinyin-count",
            "mismatch": "pinyin-mismatch"}[result["kind"]]
    report.warn(code, where, result["message"], unit=unit, hanzi=hanzi,
                given=result["given"], suggested=result["suggested"])


def check_items(report: Report, unit: dict, unit_id: str, ids: IdRegistry,
                where: str) -> dict[str, int]:
    """Validate ``items`` of one unit.

    Returns:
        Counts per item type (``word``/``phrase``/``sentence``).
    """
    counts = {"word": 0, "phrase": 0, "sentence": 0}
    items = unit.get("items")
    if not isinstance(items, list):
        return counts
    next_number = {"w": 1, "p": 1, "s": 1}
    valid_items: list[dict] = []
    limit = max_sentence_length(unit_id)
    for index, item in enumerate(items, start=1):
        label = (item.get("id") if isinstance(item, dict) and isinstance(item.get("id"), str)
                 else f"{where} items[{index}]")
        if not check_fields(report, item, ITEM_REQUIRED, ITEM_OPTIONAL, label):
            continue
        ids.register(report, item["id"], label)
        type_ = item["type"]
        if type_ not in TYPE_LETTER:
            report.error("bad-type", label,
                         f"type must be word, phrase or sentence, got {type_!r}")
        else:
            counts[type_] += 1
        _check_item_id(report, item, unit_id, label, next_number)
        if isinstance(item.get("alt"), list) and not all(isinstance(a, str) for a in item["alt"]):
            report.error("wrong-type", label, "'alt' must be a list of strings")
        if isinstance(item.get("hint"), str) and len(item["hint"]) > HINT_MAX_CHARS:
            report.warn("hint-too-long", label,
                        f"hint is {len(item['hint'])} chars (limit {HINT_MAX_CHARS})")
        check_text_fields(report, item["hanzi"], item["pinyin"], label)
        if type_ == "sentence" and limit is not None:
            length = len(han_chars(item["hanzi"]))
            if length > limit:
                report.warn("sentence-too-long", label,
                            f"sentence has {length} Han characters "
                            f"(limit {limit} for this unit): {item['hanzi']}")
        check_pinyin(report, item["hanzi"], item["pinyin"], label, unit_id)
        valid_items.append(item)
    _check_duplicate_english(report, valid_items)
    return counts


def _check_item_id(report: Report, item: dict, unit_id: str, label: str,
                   next_number: dict[str, int]) -> None:
    """Check id format, unit prefix, w/p/s letter vs type, and numbering."""
    match = ITEM_ID_RE.match(item["id"])
    if not match:
        report.error("bad-id", label,
                     f"item id {item['id']!r} must look like uNN-wNN / uNN-pNN / uNN-sNN")
        return
    prefix, letter, number = match.group(1), match.group(2), int(match.group(3))
    if prefix != unit_id:
        report.error("id-prefix", label,
                     f"item id prefix '{prefix}' does not match unit id '{unit_id}'")
    wanted = TYPE_LETTER.get(item["type"])
    if wanted and letter != wanted:
        report.error("id-type", label,
                     f"id letter '{letter}' does not match type '{item['type']}' "
                     f"(expected '{wanted}')")
    if number != next_number[letter]:
        report.error("id-sequence", label,
                     f"expected number {next_number[letter]:02d} for '{letter}' "
                     f"items, found {number:02d} (consecutive from 01)")
    next_number[letter] = number + 1


def _check_duplicate_english(report: Report, items: list[dict]) -> None:
    """Report items sharing ``english`` (case-insensitive) or clashing with
    another item's ``alt``."""
    by_english: dict[str, str] = {}
    alt_owner: dict[str, str] = {}
    for item in items:
        for alt in item.get("alt", []) if isinstance(item.get("alt"), list) else []:
            if isinstance(alt, str):
                alt_owner.setdefault(alt.strip().lower(), item["id"])
    for item in items:
        key = item["english"].strip().lower()
        if key in by_english:
            report.error("duplicate-english", item["id"],
                         f"english {item['english']!r} duplicates {by_english[key]}")
        else:
            by_english[key] = item["id"]
        owner = alt_owner.get(key)
        if owner and owner != item["id"]:
            report.error("duplicate-english", item["id"],
                         f"english {item['english']!r} is also an alt of {owner}")


def check_dialogues(report: Report, unit: dict, unit_id: str, ids: IdRegistry,
                    where: str) -> tuple[int, int, int]:
    """Validate ``dialogues`` of one unit.

    Returns:
        ``(dialogue_count, line_count, question_count)``.
    """
    dialogues = unit.get("dialogues")
    if not isinstance(dialogues, list):
        return 0, 0, 0
    limit = max_sentence_length(unit_id)
    n_lines = n_questions = 0
    for d_index, dialogue in enumerate(dialogues, start=1):
        label = (dialogue.get("id") if isinstance(dialogue, dict)
                 and isinstance(dialogue.get("id"), str)
                 else f"{where} dialogues[{d_index}]")
        if not check_fields(report, dialogue, DIALOGUE_FIELDS, {}, label):
            continue
        ids.register(report, dialogue["id"], label)
        match = DIALOGUE_ID_RE.match(dialogue["id"])
        if not match:
            report.error("bad-id", label,
                         f"dialogue id {dialogue['id']!r} must look like uNN-dNN")
        else:
            if match.group(1) != unit_id:
                report.error("id-prefix", label,
                             f"dialogue id prefix '{match.group(1)}' does not match "
                             f"unit id '{unit_id}'")
            if int(match.group(2)) != d_index:
                report.error("id-sequence", label,
                             f"expected number {d_index:02d}, found {match.group(2)} "
                             "(consecutive from 01)")
        for l_index, line in enumerate(dialogue["lines"], start=1):
            lwhere = f"{label}.l{l_index}"
            if not check_fields(report, line, LINE_FIELDS, {}, lwhere):
                continue
            n_lines += 1
            if line["speaker"] not in SPEAKERS:
                report.error("bad-speaker", lwhere,
                             f"speaker must be 'A' or 'B', got {line['speaker']!r}")
            check_text_fields(report, line["hanzi"], line["pinyin"], lwhere)
            if limit is not None and len(han_chars(line["hanzi"])) > limit:
                report.warn("sentence-too-long", lwhere,
                            f"line has {len(han_chars(line['hanzi']))} Han characters "
                            f"(limit {limit} for this unit): {line['hanzi']}")
            check_pinyin(report, line["hanzi"], line["pinyin"], lwhere, unit_id)
        n_questions += _check_questions(report, dialogue, ids, label)
    return len(dialogues), n_lines, n_questions


def _check_questions(report: Report, dialogue: dict, ids: IdRegistry,
                     label: str) -> int:
    """Validate the comprehension questions of one dialogue; return how many."""
    count = 0
    for q_index, question in enumerate(dialogue["questions"], start=1):
        qwhere = (question.get("id") if isinstance(question, dict)
                  and isinstance(question.get("id"), str) else f"{label} questions[{q_index}]")
        if not check_fields(report, question, QUESTION_FIELDS, {}, qwhere):
            continue
        count += 1
        ids.register(report, question["id"], qwhere)
        match = QUESTION_ID_RE.match(question["id"])
        if not match:
            report.error("bad-id", qwhere,
                         f"question id {question['id']!r} must look like uNN-dNN-qN")
        else:
            if match.group(1) != dialogue["id"]:
                report.error("id-prefix", qwhere,
                             f"question id prefix '{match.group(1)}' does not match "
                             f"dialogue id '{dialogue['id']}'")
            if int(match.group(2)) != q_index:
                report.error("id-sequence", qwhere,
                             f"expected q{q_index}, found q{match.group(2)} "
                             "(consecutive from 1)")
        distractors = question["distractors"]
        if not all(isinstance(d, str) for d in distractors):
            report.error("wrong-type", qwhere, "'distractors' must be a list of strings")
            continue
        if len(distractors) < MIN_DISTRACTORS:
            report.error("few-distractors", qwhere,
                         f"needs at least {MIN_DISTRACTORS} distractors, has {len(distractors)}")
        if question["answer"].strip().lower() in {d.strip().lower() for d in distractors}:
            report.error("answer-in-distractors", qwhere,
                         f"answer {question['answer']!r} also appears among the distractors")
    return count


def check_unit_file(report: Report, entry: dict, unit: Any, path_label: str,
                    ids: IdRegistry) -> None:
    """Validate one decoded unit file and record its statistics."""
    if not check_fields(report, unit, UNIT_FIELDS, {}, path_label):
        report.units.append({"id": entry.get("id"), "file": entry.get("file"),
                             "loaded": True, "valid": False})
        return
    unit_id = unit["id"]
    # WHY: the unit id was already registered from the index entry; registering
    # it again here would report every unit as a duplicate of itself.
    if not UNIT_ID_RE.match(unit_id):
        report.error("bad-id", path_label, f"unit id {unit_id!r} must look like uNN")
    if unit_id != entry["id"]:
        report.error("unit-mismatch", path_label,
                     f"unit id {unit_id!r} differs from index id {entry['id']!r}")
    if unit["title"] != entry["title"]:
        report.error("unit-mismatch", path_label,
                     f"unit title {unit['title']!r} differs from index title "
                     f"{entry['title']!r}")
    counts = check_items(report, unit, unit_id, ids, path_label)
    n_dialogues, n_lines, n_questions = check_dialogues(report, unit, unit_id, ids, path_label)
    for type_, want in EXPECTED_COUNTS.items():
        if counts[type_] != want:
            report.warn("item-count", unit_id,
                        f"{counts[type_]} {type_} item(s), expected {want}")
    if n_dialogues != EXPECTED_DIALOGUES:
        report.warn("item-count", unit_id,
                    f"{n_dialogues} dialogue(s), expected {EXPECTED_DIALOGUES}")
    report.units.append({"id": unit_id, "file": entry["file"], "loaded": True,
                         "words": counts["word"], "phrases": counts["phrase"],
                         "sentences": counts["sentence"], "dialogues": n_dialogues,
                         "lines": n_lines, "questions": n_questions})


# ===== Section: Whole-repository validation =====

def validate(root: Path) -> Report:
    """Validate ``data/units.json`` and every unit file under ``root``.

    Args:
        root: Repository root containing ``data/``.

    Returns:
        A ``Report`` with all findings (strict promotion is the caller's job).
    """
    report = Report()
    index_path = root / "data" / "units.json"
    index = load_json(report, index_path, "data/units.json") if index_path.exists() else None
    if not index_path.exists():
        report.error("missing-file", "data/units.json", "units index not found")
        return report
    if index is None:
        return report
    if not check_fields(report, index, {"version": int, "units": list}, {}, "data/units.json"):
        return report
    ids = IdRegistry()
    for position, entry in enumerate(index["units"], start=1):
        where = f"data/units.json units[{position}]"
        if not check_fields(report, entry, INDEX_FIELDS, {}, where):
            continue
        ids.register(report, entry["id"], "data/units.json")
        if not UNIT_ID_RE.match(entry["id"]):
            report.error("bad-id", where, f"unit id {entry['id']!r} must look like uNN")
        _load_unit(report, root, entry, ids)
    return report


def _load_unit(report: Report, root: Path, entry: dict, ids: IdRegistry) -> None:
    """Resolve, load and check the unit file referenced by an index entry."""
    rel = entry["file"]
    path = (root / rel).resolve()
    if not path.is_relative_to(root.resolve()):
        report.error("bad-path", rel, "unit file path escapes the repository root")
        return
    if not path.exists():
        # WHY: units are written incrementally, so a referenced-but-missing file
        # is expected mid-project and must not fail a normal run.
        report.warn("missing-unit-file", rel,
                    f"unit file for {entry['id']} not found (not written yet?)")
        report.units.append({"id": entry["id"], "file": rel, "loaded": False})
        return
    unit = load_json(report, path, rel)
    if unit is None:
        report.units.append({"id": entry["id"], "file": rel, "loaded": False})
        return
    check_unit_file(report, entry, unit, rel, ids)


# ===== Section: Output and command line =====

def print_report(report: Report, strict: bool) -> None:
    """Print the human-readable summary to stdout."""
    print("Per-unit item counts")
    print(f"  {'unit':<6}{'words':>6}{'phrases':>9}{'sentences':>11}"
          f"{'dialogues':>11}{'lines':>7}{'questions':>11}")
    for u in report.units:
        if u.get("loaded") and "words" in u:
            print(f"  {u['id']:<6}{u['words']:>6}{u['phrases']:>9}{u['sentences']:>11}"
                  f"{u['dialogues']:>11}{u['lines']:>7}{u['questions']:>11}")
        else:
            state = "not found / unreadable" if not u.get("loaded") else "invalid structure"
            print(f"  {str(u.get('id')):<6}{state}")
    for title, issues in (("ERRORS", report.errors), ("WARNINGS", report.warnings)):
        if issues:
            print(f"\n{title} ({len(issues)})")
            for issue in issues:
                print(f"  [{issue.code}] {issue.where}: {issue.message}")
                if issue.code == "pinyin-mismatch":
                    print(f"      hanzi: {issue.extra['hanzi']}   given: "
                          f"{issue.extra['given']}   pypinyin: {issue.extra['suggested']}")
    mode = " (strict: warnings count as errors)" if strict else ""
    print(f"\nSummary: {len(report.units)} unit(s), {len(report.errors)} error(s), "
          f"{len(report.warnings)} warning(s){mode}")
    print("RESULT: FAIL" if report.errors else "RESULT: OK")


def build_parser() -> argparse.ArgumentParser:
    """Create the command-line parser."""
    default_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description="Validate data/units.json and the unit files it references "
                    "(schema, IDs, duplicates, pinyin vs pypinyin).")
    parser.add_argument("--root", type=Path, default=default_root,
                        help="repository root (default: inferred from this script's "
                             "location)")
    parser.add_argument("--strict", action="store_true",
                        help="treat warnings as errors")
    parser.add_argument("--json", action="store_true", dest="as_json",
                        help="print a machine-readable JSON report instead of text")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Entry point.

    Returns:
        Process exit status: 1 on errors (or warnings with ``--strict``), else 0.
    """
    args = build_parser().parse_args(argv)
    report = validate(args.root)
    if args.strict:
        report.promote_warnings()
    if args.as_json:
        json.dump(report.to_dict(), sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print_report(report, args.strict)
    return 1 if report.errors else 0


if __name__ == "__main__":
    sys.exit(main())
