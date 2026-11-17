"""Unit tests for tools/validate_content.py.

PURPOSE
    Pin down the validator's behaviour with small fixture content written to a
    temporary directory: a valid unit passes, structural problems are errors,
    and pinyin conventions (sandhi, neutral tone) are accepted while a genuine
    wrong tone is reported.

USAGE
    python3 -m unittest tests/tools/test_validate_content.py
    (or: python3 -m unittest discover -s tests/tools)
"""

import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import validate_content as vc  # noqa: E402

# ===== Section: Fixtures =====

INDEX = {"version": 1, "units": [
    {"id": "u01", "order": 1, "title": "Greetings", "emoji": "x",
     "description": "d", "file": "data/units/u01-greetings.json"}]}

UNIT = {
    "id": "u01", "title": "Greetings",
    "items": [
        {"id": "u01-w01", "type": "word", "hanzi": "你好", "pinyin": "nǐ hǎo",
         "english": "hello", "alt": ["hi"]},
        {"id": "u01-w02", "type": "word", "hanzi": "谢谢", "pinyin": "xièxie",
         "english": "thanks"},
        {"id": "u01-p01", "type": "phrase", "hanzi": "不客气", "pinyin": "bú kèqi",
         "english": "you're welcome"},
        {"id": "u01-s01", "type": "sentence", "hanzi": "我是一个学生。",
         "pinyin": "Wǒ shì yí gè xuésheng.", "english": "I am a student."},
        {"id": "u01-s02", "type": "sentence", "hanzi": "你在哪儿？",
         "pinyin": "Nǐ zài nǎr?", "english": "Where are you?"},
    ],
    "dialogues": [
        {"id": "u01-d01", "title": "Hi",
         "lines": [
             {"speaker": "A", "hanzi": "你好！", "pinyin": "Nǐ hǎo!", "english": "Hello!"},
             {"speaker": "B", "hanzi": "你好！", "pinyin": "Nǐ hǎo!", "english": "Hello!"}],
         "questions": [
             {"id": "u01-d01-q1", "question": "What do they say?", "answer": "Hello",
              "distractors": ["Goodbye", "Sorry", "Thanks"]}]},
    ],
}


class ContentTestCase(unittest.TestCase):
    """Base class: builds a temp repo and runs the validator on it."""

    def run_validator(self, unit=None, index=None) -> vc.Report:
        """Write the fixtures (optionally modified) to a temp dir and validate."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "units").mkdir(parents=True)
            (root / "data" / "units.json").write_text(
                json.dumps(index or INDEX), encoding="utf-8")
            (root / "data" / "units" / "u01-greetings.json").write_text(
                json.dumps(unit or UNIT, ensure_ascii=False), encoding="utf-8")
            return vc.validate(root)

    def mutated(self, fn) -> dict:
        """Return a deep copy of UNIT after applying ``fn`` to it."""
        unit = copy.deepcopy(UNIT)
        fn(unit)
        return unit

    def codes(self, report: vc.Report, severity: str) -> list[str]:
        """Codes of all findings with the given severity."""
        return [i.code for i in report.issues if i.severity == severity]


# ===== Section: Tests =====

class ValidUnit(ContentTestCase):
    """A well-formed unit produces no errors and no pinyin warnings."""

    def test_valid_unit_passes(self):
        report = self.run_validator()
        self.assertEqual(report.errors, [])
        pinyin_warnings = [c for c in self.codes(report, vc.WARNING)
                           if c.startswith("pinyin")]
        self.assertEqual(pinyin_warnings, [])

    def test_missing_unit_file_is_warning_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data").mkdir()
            (root / "data" / "units.json").write_text(json.dumps(INDEX))
            report = vc.validate(root)
        self.assertEqual(report.errors, [])
        self.assertIn("missing-unit-file", self.codes(report, vc.WARNING))


class StructuralErrors(ContentTestCase):
    """Schema, ID and duplicate checks are errors."""

    def test_duplicate_english_errors(self):
        unit = self.mutated(lambda u: u["items"][1].update(english="Hello"))
        self.assertIn("duplicate-english", self.codes(self.run_validator(unit), vc.ERROR))

    def test_english_clashing_with_alt_errors(self):
        unit = self.mutated(lambda u: u["items"][1].update(english="hi"))
        self.assertIn("duplicate-english", self.codes(self.run_validator(unit), vc.ERROR))

    def test_bad_id_errors(self):
        unit = self.mutated(lambda u: u["items"][0].update(id="u02-w01"))
        self.assertIn("id-prefix", self.codes(self.run_validator(unit), vc.ERROR))

    def test_id_letter_type_mismatch_errors(self):
        unit = self.mutated(lambda u: u["items"][0].update(type="phrase"))
        self.assertIn("id-type", self.codes(self.run_validator(unit), vc.ERROR))

    def test_non_consecutive_id_errors(self):
        unit = self.mutated(lambda u: u["items"][1].update(id="u01-w03"))
        self.assertIn("id-sequence", self.codes(self.run_validator(unit), vc.ERROR))

    def test_duplicate_id_errors(self):
        unit = self.mutated(lambda u: u["items"][1].update(id="u01-w01"))
        self.assertIn("duplicate-id", self.codes(self.run_validator(unit), vc.ERROR))

    def test_digits_in_hanzi_error(self):
        unit = self.mutated(lambda u: u["items"][0].update(hanzi="你好3"))
        self.assertIn("latin-in-hanzi", self.codes(self.run_validator(unit), vc.ERROR))

    def test_tone_digits_in_pinyin_error(self):
        unit = self.mutated(lambda u: u["items"][0].update(pinyin="ni3 hao3"))
        self.assertIn("tone-number", self.codes(self.run_validator(unit), vc.ERROR))

    def test_extra_and_missing_fields_error(self):
        def edit(u):
            u["items"][0]["bogus"] = 1
            del u["items"][1]["english"]
        codes = self.codes(self.run_validator(self.mutated(edit)), vc.ERROR)
        self.assertIn("extra-field", codes)
        self.assertIn("missing-field", codes)

    def test_bad_speaker_errors(self):
        unit = self.mutated(lambda u: u["dialogues"][0]["lines"][0].update(speaker="C"))
        self.assertIn("bad-speaker", self.codes(self.run_validator(unit), vc.ERROR))

    def test_too_few_distractors_and_answer_in_distractors(self):
        def edit(u):
            q = u["dialogues"][0]["questions"][0]
            q["distractors"] = ["hello", "Sorry"]
        codes = self.codes(self.run_validator(self.mutated(edit)), vc.ERROR)
        self.assertIn("few-distractors", codes)
        self.assertIn("answer-in-distractors", codes)

    def test_title_mismatch_with_index_errors(self):
        unit = self.mutated(lambda u: u.update(title="Hello"))
        self.assertIn("unit-mismatch", self.codes(self.run_validator(unit), vc.ERROR))


class PinyinChecks(ContentTestCase):
    """pypinyin cross-check: conventions accepted, genuine errors warned."""

    def pinyin_warnings(self, hanzi: str, pinyin_text: str) -> list[vc.Issue]:
        """Run a single-item unit and return its pinyin warnings."""
        def edit(u):
            u["items"][0].update(hanzi=hanzi, pinyin=pinyin_text)
        report = self.run_validator(self.mutated(edit))
        return [i for i in report.warnings
                if i.code.startswith("pinyin") and i.where == "u01-w01"]

    def test_bu_sandhi_not_warned(self):
        self.assertEqual(self.pinyin_warnings("不是", "bú shì"), [])
        self.assertEqual(self.pinyin_warnings("不是", "bù shì"), [])

    def test_yi_sandhi_not_warned(self):
        self.assertEqual(self.pinyin_warnings("一个", "yí gè"), [])
        self.assertEqual(self.pinyin_warnings("一起", "yì qǐ"), [])

    def test_neutral_tone_not_warned(self):
        self.assertEqual(self.pinyin_warnings("朋友", "péngyou"), [])
        self.assertEqual(self.pinyin_warnings("爸爸", "bàba"), [])

    def test_erhua_not_warned(self):
        self.assertEqual(self.pinyin_warnings("一点儿", "yìdiǎnr"), [])
        self.assertEqual(self.pinyin_warnings("哪儿", "nǎr"), [])

    def test_third_tone_citation_form_not_warned(self):
        self.assertEqual(self.pinyin_warnings("你好", "nǐ hǎo"), [])

    def test_wrong_tone_is_warned(self):
        found = self.pinyin_warnings("你好", "nǐ hāo")
        self.assertEqual([i.code for i in found], ["pinyin-mismatch"])
        self.assertEqual(found[0].extra["given"], "nǐ hāo")
        self.assertIn("hǎo", found[0].message)

    def test_written_third_tone_sandhi_is_warned(self):
        self.assertEqual([i.code for i in self.pinyin_warnings("你好", "ní hǎo")],
                         ["pinyin-mismatch"])

    def test_syllable_count_mismatch_is_warned(self):
        self.assertEqual([i.code for i in self.pinyin_warnings("你好", "nǐ")],
                         ["pinyin-count"])

    def test_dialogue_lines_are_checked(self):
        unit = self.mutated(lambda u: u["dialogues"][0]["lines"][0].update(pinyin="Nǐ hāo!"))
        report = self.run_validator(unit)
        self.assertIn("pinyin-mismatch", self.codes(report, vc.WARNING))


class CommandLine(ContentTestCase):
    """Exit codes and flags of the CLI entry point."""

    def write_repo(self, tmp: str, unit: dict) -> None:
        """Create a temp repo containing ``unit``."""
        root = Path(tmp)
        (root / "data" / "units").mkdir(parents=True)
        (root / "data" / "units.json").write_text(json.dumps(INDEX))
        (root / "data" / "units" / "u01-greetings.json").write_text(
            json.dumps(unit, ensure_ascii=False))

    def run_main(self, *argv: str) -> int:
        """Run ``main`` with stdout captured, returning the exit status."""
        with contextlib.redirect_stdout(io.StringIO()):
            return vc.main(list(argv))

    def test_exit_codes_and_strict(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write_repo(tmp, UNIT)
            # Valid unit still has count warnings: ok normally, failing in strict.
            self.assertEqual(self.run_main("--root", tmp, "--json"), 0)
            self.assertEqual(self.run_main("--root", tmp, "--json", "--strict"), 1)
        with tempfile.TemporaryDirectory() as tmp:
            bad = self.mutated(lambda u: u["items"][0].update(hanzi="你好3"))
            self.write_repo(tmp, bad)
            self.assertEqual(self.run_main("--root", tmp, "--json"), 1)

    def test_invalid_json_is_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write_repo(tmp, UNIT)
            (Path(tmp) / "data" / "units" / "u01-greetings.json").write_text("{nope")
            report = vc.validate(Path(tmp))
        self.assertIn("invalid-json", self.codes(report, vc.ERROR))


if __name__ == "__main__":
    unittest.main()
