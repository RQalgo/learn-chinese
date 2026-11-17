"""Tests for tools/zh_lexicon.py: pinyin alignment and unit selection (no model needed)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import zh_lexicon as zl  # noqa: E402

VALID = {"xie", "ni", "hao", "bu", "shi", "yi", "ge", "dian", "er", "nv", "xi", "an", "ren", "guo", "xiang", "gang",
         "ma", "de", "pen", "you", "shei", "tian", "diao"}


def align(h, p):
    return zl.align_line(h, p, VALID)


class AlignTests(unittest.TestCase):
    def test_neutral_and_tones(self):
        words = align("谢谢！", "Xièxie!")
        self.assertEqual([s.tone for s in words[0].syls], [4, 5])
        self.assertTrue(words[0].end)

    def test_erhua_consumes_er_character(self):
        words = align("一点儿", "yìdiǎnr")
        self.assertEqual(words[0].han, "一点儿")
        self.assertTrue(words[0].syls[1].erhua)

    def test_er_syllable_is_not_erhua(self):
        words = align("女儿", "nǚ'ér")
        self.assertFalse(any(s.erhua for s in words[0].syls))

    def test_ng_vs_n_g(self):
        words = align("人国", "rénguó")
        self.assertEqual([s.letters for s in words[0].syls], ["ren", "guo"])

    def test_mismatch_returns_none(self):
        self.assertIsNone(align("你好吗", "nǐ hǎo"))


class UnitTests(unittest.TestCase):
    def test_sandhi_not_joined_across_clause(self):
        words = align("不，是", "bù, shì")
        self.assertEqual(zl.candidate_units(words, {}), [])

    def test_bu_joins_next_word(self):
        words = align("不是", "bú shì")
        self.assertEqual([u.han for u in zl.candidate_units(words, {})], ["不是"])

    def test_neutral_word(self):
        words = align("谢谢", "xièxie")
        self.assertEqual([u.han for u in zl.candidate_units(words, {})], ["谢谢"])

    def test_segmenter_is_longest_match(self):
        self.assertEqual(zl.segment_runs("请等一下。", {"等一下", "一下"}), ["请", "等一下"])


if __name__ == "__main__":
    unittest.main()
