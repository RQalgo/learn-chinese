#!/usr/bin/env python3
"""zh_lexicon.py -- content-driven Mandarin lexicon for Kokoro v1.1-zh (neutral tones, 不/一).

PURPOSE
    Kokoro's Mandarin front end reads words from ``lexicon-zh.txt`` (word -> phones with
    a tone digit per syllable). Many everyday words with a neutral tone are missing
    (谢谢, 东西, 朋友, 喜欢, 先生, 妈妈 ...), so they are spoken with full tones, which
    is wrong for a listening course. The model's own 不/一 sandhi also depends on the
    word being in the lexicon. The lesson content already carries the *right* reading:
    docs/CONTENT.md requires neutral tones unmarked (``xièxie``) and the spoken tone of
    不/一 (``bú shì``, ``yí gè``). This module turns that pinyin into extra lexicon entries.

HOW IT FITS
    generate_audio.py calls ``ZhLexicon.build`` with the model's lexicon, writes the entries
    with ``write_file`` and passes the file to sherpa-onnx as an additional lexicon, LAST in
    the ``lexicon=`` list so it overrides the base entries. ``signature`` gives each clip a
    cache fingerprint of the entries it relies on.

LEXICON FORMAT (Kokoro v1.1-zh ``lexicon-zh.txt``)
    ``<word> <phone> <phone> ... `` where every syllable is an *initial token*, a *final
    token* and a *tone digit* (1-4, 5 = neutral): ``你好 ㄋ ㄧ 2 ㄏ ㄠ 3``. Finals are
    bopomofo or a few stand-ins (言 = ian, 中 = ong ...). Erhua puts the token ``R``
    before the digit: ``哪儿 ㄋ ㄚ R 3``. Tone digits are *post-sandhi*, e.g. 你好 is 2 3.
    We do not hard-code the token inventory: the toneless-pinyin -> tokens table is
    learned from the model's single-character entries (majority vote over pypinyin's
    reading of each character), so it always matches the model in use.

SEGMENTATION (why entries are checked in context)
    sherpa-onnx (>= 1.12.15) ignores ``dict_dir`` for Kokoro: it cuts the text by *longest
    match over the merged lexicons* (verified by ablation: an entry is used whenever it is
    the longest known word at its position, whether or not jieba's dictionary knows it). An entry
    therefore needs no dictionary change, but a longer base word can swallow it
    (``等一下`` hides ``一下``). ``repair_tokens`` simulates the cut over base + our entries
    and, where the token actually spoken has a wrong neutral/不/一 tone, adds an entry for
    that whole token (e.g. ``早上好``), so every such syllable is checked in context.

ALIGNMENT
    Pinyin words are separated by spaces; a word has one syllable per Han character
    (erhua ``r`` = 儿 is a suffix of the preceding syllable). Syllables are found by
    matching the valid toneless syllables learned above (backtracking, apostrophes
    split). Lines that cannot be aligned are reported, never guessed.

WHICH UNITS GET AN ENTRY
    * a multi-syllable pinyin word containing a neutral syllable or a 不/一 whose written
      tone is not the citation tone (bú, yí, yì);
    * a standalone 不/一 sandhi form (``bú shì``, ``yí gè``): unit = 不/一 + the next
      pinyin word (up to 3 syllables, else its first syllable), because a one-character
      entry would override every 不/一 in the course;
    * a standalone neutral syllable (``de``, ``ma``) whose character is not neutral in
      the base lexicon: unit = previous pinyin word + it.
    An entry is written when the base lexicon lacks the word or its tones differ from
    ours. Third-tone sandhi differences are ignored (we write citation tones and the
    model's lexicon has sandhi baked in). Finally the repair pass above runs.

USAGE
    python3 tools/zh_lexicon.py --zh-model-dir models/kokoro-multi-lang-v1_1 [--list]
    prints the statistics (and with --list every entry) for the committed content.
"""

# ===== Section: Imports and constants ===============================================

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

_HAN = re.compile(r"[一-鿿]")
_MARKS = {"̄": 1, "́": 2, "̌": 3, "̀": 4}
BASE_TONE = {"不": 4, "一": 1}   # citation tones of the two sandhi characters
NEUTRAL = 5
MAX_NEXT_SYLLABLES = 3           # longest "next word" glued to a standalone 不/一
_PIECE_PUNCT = ".,?!;:\"\u201c\u201d()"


# ===== Section: Reading the model files ==============================================

def read_lexicon(path: Path) -> dict[str, list[str]]:
    """Read ``lexicon-zh.txt`` -> ``{word: [token, ...]}`` (first entry of a word wins)."""
    out: dict[str, list[str]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        word, _, rest = line.partition(" ")
        if word and rest:
            out.setdefault(word, rest.split())
    return out


def learn_syllable_table(lexicon: dict[str, list[str]]) -> dict[str, list[str]]:
    """Learn ``{toneless pinyin (ü as v): [initial, final tokens]}`` from the model.

    Uses every single-Han-character entry: pypinyin gives the character's usual reading,
    the lexicon gives its tokens; the most frequent tokens per reading win. (Measured on
    v1.1: 408 syllables, only ``di`` and ``die`` have a single outlier.)
    """
    from pypinyin import Style, pinyin

    votes: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for word, toks in lexicon.items():
        if len(word) != 1 or not _HAN.match(word) or not toks[-1].isdigit():
            continue
        reading = pinyin(word, style=Style.NORMAL, heteronym=False)[0][0]
        votes[reading][" ".join(toks[:-1])] += 1
    table = {py: c.most_common(1)[0][0].split() for py, c in votes.items()}
    # WHY: pypinyin spells 谁 "shui" but the content (and Mandarin) writes shéi, which no
    # single-character entry carries; compose it from "shi" (initial) and "ei" (final).
    if "shei" not in table and "shi" in table and "ei" in table:
        table["shei"] = [table["shi"][0]] + table["ei"][-1:]
    return table


# ===== Section: Pinyin parsing and alignment ========================================

@dataclass(frozen=True)
class Syl:
    """One syllable: toneless ``letters`` (ü -> v), ``tone`` 1-5 (5 = neutral), erhua flag."""

    letters: str
    tone: int
    erhua: bool = False


@dataclass(frozen=True)
class PyWord:
    """A space-separated pinyin word aligned with its hanzi.

    ``han`` has one char per syllable plus one per erhua; ``end`` is True when
    punctuation follows the word (a clause boundary).
    """

    han: str
    syls: tuple
    end: bool


def _plain_and_tones(text: str) -> tuple[str, list[int]]:
    """Strip tone marks: returns lowercase letters (ü -> v) and the tone at each index (0 = none)."""
    plain: list[str] = []
    tones: list[int] = []
    for ch in unicodedata.normalize("NFD", text):
        if ch in _MARKS:
            if tones:
                tones[-1] = _MARKS[ch]
        elif ch == "̈":                     # diaeresis: u -> ü, written v
            if plain and plain[-1] == "u":
                plain[-1] = "v"
        elif unicodedata.combining(ch):
            continue
        else:
            plain.append(ch.lower())
            tones.append(0)
    return "".join(plain), tones


def segment_word(plain: str, tones: list[int], valid: set[str]) -> Optional[list[Syl]]:
    """Split one apostrophe-free pinyin word into syllables, or None if impossible.

    Backtracking over valid toneless syllables (longest first); a trailing ``r`` that
    is not part of a valid syllable is erhua on the syllable before it. WHY a table
    instead of a regex: ``ng`` vs ``n+g`` (``rénguó``) and ``ér`` vs erhua cannot be
    told apart without knowing which syllables exist. Among several cuts the one with
    the fewest hanzi wins (``ér`` = one syllable, not ``e`` + erhua).
    """
    n = len(plain)
    best: dict[int, Optional[tuple[int, list[Syl]]]] = {}

    def solve(i: int) -> Optional[tuple[int, list[Syl]]]:
        if i == n:
            return 0, []
        if i in best:
            return best[i]
        options: list[tuple[int, list[Syl]]] = []
        for j in range(min(n, i + 6), i, -1):
            piece = plain[i:j]
            if piece in valid:
                rest = solve(j)
                if rest is not None:
                    tone = next((t for t in tones[i:j] if t), NEUTRAL)
                    options.append((rest[0] + 1, [Syl(piece, tone)] + rest[1]))
        if plain[i:] == "r" and i > 0:           # erhua: handled by the caller (needs the previous syllable)
            options.append((1, [Syl("r", 0)]))
        result = min(options, key=lambda o: o[0]) if options else None
        best[i] = result
        return result

    res = solve(0)
    if res is None:
        return None
    syls: list[Syl] = []
    for s in res[1]:
        if s.letters == "r" and s.tone == 0:
            if not syls:
                return None
            prev = syls[-1]
            syls[-1] = Syl(prev.letters, prev.tone, True)
        else:
            syls.append(s)
    return syls


def align_line(hanzi: str, pinyin: str, valid: set[str]) -> Optional[list[PyWord]]:
    """Align a hanzi line with its pinyin line into ``PyWord``s, or None if they disagree.

    Handles capitals, apostrophes (syllable breaks), sentence punctuation (clause ends)
    and erhua (the 儿 char must be present). Returns None when the number of Han
    characters differs from the number of syllables + erhua or a word cannot be parsed.
    """
    chars = _HAN.findall(hanzi)
    words: list[PyWord] = []
    pos = 0
    for token in pinyin.split():
        end = bool(token) and token[-1] in _PIECE_PUNCT
        core = token.strip(_PIECE_PUNCT)
        syls: list[Syl] = []
        for part in core.split("'"):
            if not part:
                continue
            plain, tones = _plain_and_tones(part)
            got = segment_word(plain, tones, valid)
            if got is None:
                return None
            syls += got
        if not syls:
            continue
        need = sum(2 if s.erhua else 1 for s in syls)
        han = "".join(chars[pos:pos + need])
        pos += need
        if len(han) != need or any(s.erhua and han[i] != "儿" for s, i in _erhua_positions(syls)):
            return None
        words.append(PyWord(han, tuple(syls), end))
    return words if pos == len(chars) else None


def _erhua_positions(syls: Iterable[Syl]) -> list[tuple[Syl, int]]:
    """For each erhua syllable, the index of its 儿 within the word's hanzi."""
    out, idx = [], 0
    for s in syls:
        idx += 1
        if s.erhua:
            out.append((s, idx))
            idx += 1
    return out


# ===== Section: Word chunks for slow audio ===========================================

def generic_syllables() -> set[str]:
    """Toneless pinyin syllables (ü as v) from pypinyin alone: an engine-agnostic ``valid`` set.

    WHY: ``learn_syllable_table`` needs Kokoro's lexicon, but the slow-audio chunker (below) is part
    of the shared pipeline and must work for any Mandarin engine. Interjection-only strings
    (``m``, ``ng``, ``hm``, ``hng``, ``ê``) are dropped: as "syllables" they only make cuts ambiguous.
    """
    from pypinyin import Style, pinyin

    out: set[str] = set()
    for cp in range(0x4E00, 0x9FA6):
        for reading in pinyin(chr(cp), style=Style.NORMAL, heteronym=True):
            for syl in reading:
                syl = syl.replace("ü", "v")
                if syl.isascii() and syl.isalpha():
                    out.add(syl)
    return out - {"m", "ng", "hm", "hng", "e\u0302"}


def _is_sandhi_bu_yi(word: PyWord) -> bool:
    """True for a standalone 不/一 written with a sandhi tone (bú, yí, yì)."""
    return word.han in BASE_TONE and word.syls[0].tone != BASE_TONE[word.han]


def plan_chunks(hanzi: str, pinyin: str, valid: set[str]) -> Optional[list[tuple[str, bool]]]:
    """Cut a content line into chunks at pinyin word boundaries: ``[(hanzi chunk, clause_end)]``.

    Used by the slow audio (docs/AUDIO.md "Slow clips"): every pinyin word is synthesised on
    its own, so a learner hears each word distinctly. A chunk keeps the punctuation that follows
    its words (so a final ``？`` still shapes the intonation); ``clause_end`` is True when the
    chunk ends in punctuation (a longer pause follows). Returns None if hanzi and pinyin do not align.

    WHY some boundaries are NOT cut (the model would otherwise read the pieces wrongly in isolation):
      * after a sandhi 不/一 (``bú shì``: 不 alone would be read bù, see the lexicon entries above);
      * before a standalone neutral syllable (``de``, ``ma``, ``le``): it belongs to the word before;
      * between two third tones (``nǐ hǎo``): the third-tone sandhi (2-3) happens only in context.
    Single-word items therefore normally come back as one chunk.
    """
    words = align_line(hanzi, pinyin, valid)
    if not words:
        return None
    han_at = [i for i, ch in enumerate(hanzi) if _HAN.match(ch)]
    chunks: list[list] = []          # [text, clause_end, syllables]
    pos = 0
    for k, w in enumerate(words):
        first = han_at[pos]
        pos += len(w.han)
        stop = han_at[pos] if pos < len(han_at) else len(hanzi)
        text = hanzi[(0 if k == 0 else first):stop]
        if k:
            prev = words[k - 1]
            glue = not prev.end and (
                _is_sandhi_bu_yi(prev)
                or (len(w.syls) == 1 and w.syls[0].tone == NEUTRAL and not w.syls[0].erhua)
                or (prev.syls[-1].tone == 3 and w.syls[0].tone == 3))
            if glue:
                chunks[-1][0] += text
                chunks[-1][1] = w.end
                chunks[-1][2] += len(w.syls)
                continue
        chunks.append([text, w.end, len(w.syls)])
    # WHY a minimum of two syllables inside a clause: Kokoro (like the ASR check) is unreliable on a
    # lone syllable synthesised by itself (``请``, ``进``, ``我`` come out garbled or as another word),
    # so a one-syllable chunk joins its neighbour in the same clause (forward, else backward).
    # One-syllable chunks that are a whole clause (``Yī, èr, sān``) stay alone.
    merged: list[list] = []
    i = 0
    while i < len(chunks):
        text, end, n = chunks[i]
        if n < 2 and not end and i + 1 < len(chunks):
            nxt = chunks[i + 1]
            chunks[i + 1] = [text + nxt[0], nxt[1], n + nxt[2]]
        elif n < 2 and merged and not merged[-1][1]:
            merged[-1] = [merged[-1][0] + text, end, merged[-1][2] + n]
        else:
            merged.append([text, end, n])
        i += 1
    if len(merged) > 1 and all(n < 2 for _, _, n in merged):
        # WHY: a list of single syllables (``Yī, èr, sān, sì, wǔ``): lone-syllable synthesis fails
        # (measured), and the commas already give the engine its pauses, so synthesise it whole.
        return [(hanzi, merged[-1][1])]
    return [(t, e) for t, e, _ in merged]


# ===== Section: Units and entries ====================================================

@dataclass(frozen=True)
class Unit:
    """A lexicon unit: hanzi string and its syllables (our tones)."""

    han: str
    syls: tuple


def group_tones(toks: list[str]) -> list[int]:
    """Tone digits of a lexicon entry's tokens, one per syllable."""
    return [int(t) for t in toks if t.isdigit()]


def candidate_units(words: list[PyWord], lexicon: dict[str, list[str]]) -> list[Unit]:
    """Pick the units of one line that need an entry (see the module docstring)."""
    units: list[Unit] = []

    def sandhi_char(han: str, syl_index: int, syl: Syl) -> bool:
        ch = han[syl_index]
        return ch in BASE_TONE and syl.tone not in (BASE_TONE[ch], NEUTRAL) and not syl.erhua

    def han_index(w: PyWord, k: int) -> int:
        return k + sum(1 for s in w.syls[:k] if s.erhua)

    for wi, w in enumerate(words):
        n = len(w.syls)
        has_neutral = any(s.tone == NEUTRAL for s in w.syls)
        sandhi = [k for k, s in enumerate(w.syls) if sandhi_char(w.han, han_index(w, k), s)]
        if n >= 2 and (has_neutral or sandhi):
            if sandhi and sandhi[-1] == n - 1 and not w.end and wi + 1 < len(words):
                units.append(_join(w, words[wi + 1]))
            else:
                units.append(Unit(w.han, w.syls))
        elif n == 1 and sandhi and not w.end and wi + 1 < len(words):
            units.append(_join(w, words[wi + 1]))
        elif n == 1 and w.syls[0].tone == NEUTRAL and wi > 0 and not words[wi - 1].end:
            base = lexicon.get(w.han)
            if base is None or group_tones(base)[-1:] != [NEUTRAL]:
                unit = _join(words[wi - 1], w)
                if w.han in BASE_TONE and not w.end and wi + 1 < len(words):
                    # WHY: neutral 不/一 sits in A-not-A / reduplication (shì bu shì, kàn yi kàn);
                    # the whole pattern is one unit so the segmenter cannot split it.
                    unit = _join_unit(unit, words[wi + 1])
                units.append(unit)
    return units


def _join_unit(a: Unit, b: PyWord) -> Unit:
    """Append pinyin word ``b`` (cut to 1 syllable if long) to an existing unit."""
    cut = b.syls if len(b.syls) <= MAX_NEXT_SYLLABLES else b.syls[:1]
    return Unit(a.han + b.han[:sum(2 if s.erhua else 1 for s in cut)], a.syls + tuple(cut))


def _join(a: PyWord, b: PyWord) -> Unit:
    """Concatenate two pinyin words; a long second word is cut to its first syllable."""
    if len(b.syls) > MAX_NEXT_SYLLABLES:
        first = b.syls[0]
        return Unit(a.han + b.han[0], a.syls + (Syl(first.letters, first.tone, False),))
    return Unit(a.han + b.han, a.syls + b.syls)


def unit_phones(unit: Unit, table: dict[str, list[str]], base: Optional[list[str]]) -> Optional[str]:
    """Phones of a unit with OUR tones, or None if a syllable is unknown to the table.

    Third-tone sandhi: when the base entry (same syllable count) has tone 2 where we
    have 3, or, without a base entry, a 3 precedes another 3 inside the unit, the
    sandhi tone 2 is written (the lexicon stores post-sandhi tones).
    """
    base_tones = group_tones(base) if base else []
    use_base = len(base_tones) == len(unit.syls)
    toks: list[str] = []
    for k, s in enumerate(unit.syls):
        if s.letters not in table:
            return None
        tone = s.tone
        if tone == 3:
            if use_base:
                tone = 2 if base_tones[k] == 2 else 3
            elif k + 1 < len(unit.syls) and unit.syls[k + 1].tone == 3:
                tone = 2
        toks += table[s.letters] + (["R"] if s.erhua else []) + [str(tone)]
    return " ".join(toks)


def differs(unit_phones_str: str, base: Optional[list[str]]) -> bool:
    """True when the base lexicon lacks the word or its tones/phones differ from ours."""
    return base is None or unit_phones_str.split() != base


# ===== Section: Segmentation check and repair ========================================

MAX_WORD = 12  # longest lexicon word tried by the segmentation model


def segment_runs(hanzi: str, words: set[str]) -> list[str]:
    """Forward-longest-match segmentation of the Han runs of ``hanzi`` (our model of sherpa's cut).

    WHY a model of the segmenter: in sherpa-onnx >= 1.12.15 ``dict_dir`` is ignored for Kokoro
    and the text is cut by matching words of the merged lexicons, longest first (verified: an
    extra entry ``一下`` is NOT used inside 请等一下 because ``等一下`` is a longer known word,
    while 不去 / 谢谢 entries are always used). Knowing the cut tells us which entry really
    speaks each syllable.
    """
    out: list[str] = []
    for run in re.findall(r"[\u4e00-\u9fff]+", hanzi):
        i = 0
        while i < len(run):
            for j in range(min(len(run), i + MAX_WORD), i, -1):
                if run[i:j] in words or j == i + 1:
                    out.append(run[i:j])
                    i = j
                    break
    return out


def line_expectations(words: list[PyWord]) -> list[Optional[tuple[int, bool]]]:
    """Per Han character of a line: ``(our tone, must_match)`` or None for erhua 儿.

    ``must_match`` marks the syllables this module is responsible for: neutral tones and
    不/一 spoken in a sandhi (non-citation) tone.
    """
    out: list[Optional[tuple[int, bool]]] = []
    for w in words:
        k = 0
        for s in w.syls:
            ch = w.han[k]
            out.append((s.tone, s.tone == NEUTRAL or (ch in BASE_TONE and s.tone != BASE_TONE[ch])))
            k += 1
            if s.erhua:
                out.append(None)
                k += 1
    return out


def repair_tokens(hanzi: str, words: list[PyWord], merged: dict[str, list[str]]) -> dict[str, str]:
    """Entries needed so that every ``must_match`` syllable of this line is spoken with our tone.

    Segments the line with ``merged`` (base + our entries); for a token whose tone at a
    ``must_match`` position differs from ours, returns an entry for that whole token (other
    syllables keep the lexicon's tones). Tokens containing erhua are left alone.
    """
    expect = line_expectations(words)
    fixes: dict[str, str] = {}
    pos = 0
    for tok in segment_runs(hanzi, set(merged)):
        n = len(tok)
        entry = merged.get(tok)
        if entry is not None and len(group_tones(entry)) == n and "R" not in entry:
            tones = group_tones(entry)
            want = expect[pos:pos + n]
            wrong = all(w is not None for w in want) and any(
                w[1] and w[0] != t for w, t in zip(want, tones))
            if wrong:
                new, k = [], 0
                for t in entry:
                    if t.isdigit():
                        tone, must = want[k]
                        new.append(str(tone if must else t))
                        k += 1
                    else:
                        new.append(t)
                fixes[tok] = " ".join(new)
        pos += n
    return fixes


# ===== Section: The lexicon object ===================================================

class ZhLexicon:
    """Extra Mandarin lexicon derived from the lesson content.

    ``entries`` maps hanzi -> phones (written to the extra lexicon); ``line_units`` maps a
    content line key (hanzi + tab + pinyin) to the entry words its text relies on;
    ``problems`` collects alignment failures and conflicting readings (printed by the caller).
    """

    def __init__(self) -> None:
        self.entries: dict[str, str] = {}
        self.line_units: dict[str, list[str]] = {}
        self.problems: list[str] = []
        self.stats: collections.Counter = collections.Counter()

    @classmethod
    def build(cls, zh_model_dir: Path, lines: Iterable[tuple[str, str]]) -> "ZhLexicon":
        """Build from ``(hanzi, pinyin)`` pairs of all content lines (duplicates are fine)."""
        lines = sorted(set(lines))
        lexicon = read_lexicon(zh_model_dir / "lexicon-zh.txt")
        table = learn_syllable_table(lexicon)
        self = cls()
        valid = set(table)
        candidates: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
        for hanzi, pinyin in lines:
            words = align_line(hanzi, pinyin, valid)
            self.stats["lines"] += 1
            if words is None:
                self.stats["unaligned"] += 1
                self.problems.append(f"cannot align {hanzi!r} with {pinyin!r}")
                continue
            used: list[str] = []
            for unit in candidate_units(words, lexicon):
                base = lexicon.get(unit.han)
                phones = unit_phones(unit, table, base)
                if phones is None:
                    self.problems.append(f"unknown syllable in {unit.han!r} ({hanzi!r})")
                    continue
                used.append(unit.han)
                candidates[unit.han][phones] += 1
            self.line_units[hanzi + "\t" + pinyin] = used
        for han, counter in sorted(candidates.items()):
            if len(counter) > 1:
                # WHY majority + warning: one hanzi string has one lexicon entry, but the
                # content reads it two ways (e.g. 一点 as yī diǎn "1 o'clock" and yì diǎn).
                self.problems.append(f"conflicting readings of {han!r}: {dict(counter)}; using the most frequent")
            phones = counter.most_common(1)[0][0]
            if differs(phones, lexicon.get(han)):
                self.entries[han] = phones
        # Repair pass: a longer known word can swallow one of our units (等一下 hides 一下).
        merged = {**lexicon, **{w: p.split() for w, p in self.entries.items()}}
        for _round in range(2):
            fixes: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
            for hanzi, pinyin in lines:
                words = align_line(hanzi, pinyin, valid)
                if words is None:
                    continue
                for tok, phones in repair_tokens(hanzi, words, merged).items():
                    fixes[tok][phones] += 1
                    self.line_units.setdefault(hanzi + "\t" + pinyin, []).append(tok)
            for tok, counter in sorted(fixes.items()):
                if len(counter) > 1:
                    self.problems.append(f"conflicting readings of {tok!r} (repair): {dict(counter)}")
                self.entries[tok] = counter.most_common(1)[0][0]
                merged[tok] = self.entries[tok].split()
                self.stats["repaired"] += 1
        self.stats["entries"] = len(self.entries)
        self.stats["units"] = len(candidates)
        self._base = lexicon
        return self

    def signature(self, hanzi: str, pinyin: str) -> str:
        """Short fingerprint of the entries one clip relies on ('' if none)."""
        parts = []
        for han in sorted(set(self.line_units.get(hanzi + "\t" + pinyin, []))):
            parts.append(f"{han} {self.entries.get(han, '=')}")
        if not parts:
            return ""
        return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:12]

    def write_file(self, out_dir: Path) -> Path:
        """Write ``lexicon-extra-zh.txt`` (one ``word phones`` line per entry) and return its path."""
        out_dir.mkdir(parents=True, exist_ok=True)
        lex = out_dir / "lexicon-extra-zh.txt"
        lex.write_text("".join(f"{w} {p}\n" for w, p in sorted(self.entries.items())), encoding="utf-8")
        return lex


def content_lines(clips) -> list[tuple[str, str]]:
    """``(hanzi, pinyin)`` of every Mandarin clip that has pinyin (duplicates removed by the caller)."""
    return [(c.text, c.pinyin) for c in clips if c.kind == "zh" and c.pinyin]


# ===== Section: Command line (statistics) =============================================

def main(argv: Optional[list[str]] = None) -> int:
    """Print statistics (and with ``--list`` every entry) for the committed content."""
    here = Path(__file__).resolve().parent
    sys.path.insert(0, str(here))
    import generate_audio as ga

    p = argparse.ArgumentParser(description="Inspect the content-driven Mandarin lexicon.")
    p.add_argument("--zh-model-dir", type=Path, default=Path(os.environ.get(
        "AUDIO_ZH_MODEL_DIR", here.parent / "models" / ga.ZH_MODEL_NAME)))
    p.add_argument("--content-root", type=Path, default=here.parent)
    p.add_argument("--list", action="store_true", help="print every entry")
    args = p.parse_args(argv)
    clips = ga.enumerate_clips(args.content_root)
    lex = ZhLexicon.build(args.zh_model_dir, content_lines(clips))
    print(json.dumps(dict(lex.stats)))
    for msg in lex.problems:
        print("problem:", msg)
    if args.list:
        for han, ph in sorted(lex.entries.items()):
            print(f"{han} {ph}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
