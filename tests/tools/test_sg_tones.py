"""Tests for the Singapore tone mode of tools/zh_lexicon.py and tools/build_sg_pinyin.py (no model needed)."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import build_sg_pinyin  # noqa: E402
import zh_lexicon as zl  # noqa: E402

VALID = zl.generic_syllables()


def sg(hanzi, pinyin):
    return zl.convert_line(hanzi, pinyin, VALID, True)[1]


class RenderTests(unittest.TestCase):
    def test_mark_placement(self):
        self.assertEqual(zl.mark_syllable("xie", 4), "xiè")
        self.assertEqual(zl.mark_syllable("hao", 3), "hǎo")
        self.assertEqual(zl.mark_syllable("liu", 2), "liú")     # last vowel of iu
        self.assertEqual(zl.mark_syllable("gui", 4), "guì")
        self.assertEqual(zl.mark_syllable("zhou", 1), "zhōu")   # ou: on the o
        self.assertEqual(zl.mark_syllable("nv", 3), "nǚ")
        self.assertEqual(zl.mark_syllable("shi", 5), "shi")

    def test_round_trip_is_identity_over_all_content(self):
        # WHY: render(parse(line)) == line proves the renderer; the Singapore text is then only the tone change.
        import generate_audio as ga
        lines = set(zl.content_lines(ga.enumerate_clips(ROOT)))
        self.assertGreater(len(lines), 800)
        for hanzi, pinyin in sorted(lines):
            self.assertEqual(zl.convert_line(hanzi, pinyin, VALID, False)[1], pinyin, hanzi)


class SingaporeToneTests(unittest.TestCase):
    def test_full_tones_replace_neutral(self):
        for hanzi, mainland, singapore in [
            ("谢谢", "xièxie", "xièxiè"), ("东西", "dōngxi", "dōngxī"), ("朋友", "péngyou", "péngyǒu"),
            ("喜欢", "xǐhuan", "xǐhuān"), ("先生", "xiānsheng", "xiānshēng"), ("衣服", "yīfu", "yīfú"),
            ("时候", "shíhou", "shíhòu"), ("漂亮", "piàoliang", "piàoliàng"), ("妈妈", "māma", "māmā"),
            ("地方", "dìfang", "dìfāng"), ("晚上", "wǎnshang", "wǎnshàng"), ("多少", "duōshao", "duōshǎo"),
        ]:
            self.assertEqual(sg(hanzi, mainland), singapore, hanzi)

    def test_polyphone_taken_from_word_context(self):
        # 衣服 fú (not fù), 地方 fāng, 东西 xī: derived from the word, not hard-coded per word
        self.assertEqual(zl.citation_tone("服", "fu", "衣服"), 2)
        self.assertEqual(zl.citation_tone("方", "fang", "地方"), 1)
        self.assertEqual(zl.citation_tone("西", "xi", "东西"), 1)

    def test_keep_neutral_particles_and_suffixes(self):
        for hanzi, pinyin in [
            ("孩子", "háizi"), ("我的", "wǒ de"), ("好吗", "hǎo ma"), ("你呢", "nǐ ne"), ("走吧", "zǒu ba"),
            ("好啊", "hǎo a"), ("好啦", "hǎo la"), ("好哦", "hǎo o"), ("我们", "wǒmen"), ("什么", "shénme"),
            ("怎么样", "zěnmeyàng"), ("来了", "lái le"), ("这个", "zhège"), ("哪个", "nǎge"),
            ("觉得", "juéde"), ("是不是", "shì bu shì"), ("看一看", "kàn yi kàn"), ("睡不着", "shuì bu zháo"),
        ]:
            self.assertEqual(sg(hanzi, pinyin), pinyin, hanzi)

    def test_bu_inside_a_word_gets_its_tone(self):
        self.assertEqual(sg("对不起", "duìbuqǐ"), "duìbùqǐ")
        self.assertEqual(sg("差不多", "chàbuduō"), "chàbùduō")

    def test_ge_after_a_number_is_full(self):
        self.assertEqual(sg("两个", "liǎng ge"), "liǎng gè")

    def test_tou_suffix_stays_but_initial_tou_does_not_change(self):
        self.assertEqual(sg("石头", "shítou"), "shítou")

    def test_capitals_punctuation_and_apostrophes_survive(self):
        self.assertEqual(sg("谢谢！", "Xièxie!"), "Xièxiè!")
        self.assertEqual(sg("女儿，谢谢。", "nǚ'ér, xièxie."), "nǚ'ér, xièxiè.")

    def test_unknown_character_stays_neutral_and_is_reported(self):
        problems = []
        words = zl.align_line("啊", "a", VALID)
        out = zl.sg_adjust(words, problems)   # 啊 is a keep-neutral particle: no change, no problem
        self.assertEqual(out[0].syls[0].tone, zl.NEUTRAL)
        self.assertEqual(problems, [])

    def test_zh_ch_sh_are_not_merged(self):
        self.assertEqual(sg("先生", "xiānsheng"), "xiānshēng")
        self.assertEqual(sg("时候", "shíhou"), "shíhòu")   # sh stays sh

    def test_sg_flag_marks_changed_syllables_only(self):
        words = zl.sg_adjust(zl.align_line("孩子谢谢", "háizi xièxie", VALID))
        self.assertEqual([s.sg_full for w in words for s in w.syls], [False, False, False, True])


class SingaporeLexiconTests(unittest.TestCase):
    def test_changed_word_becomes_a_unit_and_keep_neutral_is_unchanged(self):
        words = zl.sg_adjust(zl.align_line("谢谢", "xièxie", VALID))
        self.assertEqual([u.han for u in zl.candidate_units(words, {})], ["谢谢"])
        table = {"xie": ["ㄒ", "ㄝ"]}
        self.assertEqual(zl.unit_phones(zl.candidate_units(words, {})[0], table, None), "ㄒ ㄝ 4 ㄒ ㄝ 4")
        neutral = zl.align_line("孩子", "háizi", VALID)
        self.assertEqual(sorted(s.tone for s in zl.sg_adjust(neutral)[0].syls), [2, 5])

    def test_third_tone_sandhi_written_when_base_is_neutral(self):
        # 姐姐 jiějiě: base (3 5) must become (2 3)
        unit = zl.Unit("姐姐", (zl.Syl("jie", 3, False, False), zl.Syl("jie", 3, False, True)))
        self.assertEqual(zl.unit_phones(unit, {"jie": ["ㄐ", "ㄝ"]}, ["ㄐ", "ㄝ", "3", "ㄐ", "ㄝ", "5"]), "ㄐ ㄝ 2 ㄐ ㄝ 3")

    def test_repair_overrides_base_neutral_word_in_sg_only(self):
        base = {"先生": ["ㄒ", "言", "1", "ㄕ", "ㄥ", "5"]}
        words_cn = zl.align_line("先生", "xiānsheng", VALID)
        words_sg = zl.sg_adjust(words_cn)
        self.assertEqual(zl.repair_tokens("先生", words_cn, base), {})
        self.assertEqual(zl.repair_tokens("先生", words_sg, base, sg=True), {"先生": "ㄒ 言 1 ㄕ ㄥ 1"})

    def test_repair_overrides_base_neutral_even_if_content_wrote_full_tone(self):
        base = {"先生": ["ㄒ", "言", "1", "ㄕ", "ㄥ", "5"]}
        words = zl.align_line("先生", "xiānshēng", VALID)
        self.assertEqual(zl.repair_tokens("先生", words, base, sg=True), {"先生": "ㄒ 言 1 ㄕ ㄥ 1"})
        self.assertEqual(zl.repair_tokens("先生", words, base), {})

    def test_rules_fingerprint_is_stable_and_nonempty(self):
        self.assertEqual(zl.sg_rules_fingerprint(), zl.sg_rules_fingerprint())
        self.assertEqual(len(zl.sg_rules_fingerprint()), 12)


class BuildSgPinyinTests(unittest.TestCase):
    def test_only_differing_entries_and_dialogue_keys(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "data" / "units").mkdir(parents=True)
            (root / "data" / "units.json").write_text(json.dumps({"units": [{"id": "u01", "order": 1, "file": "data/units/u01.json"}]}))
            (root / "data" / "units" / "u01.json").write_text(json.dumps({
                "id": "u01", "items": [{"id": "u01-w01", "hanzi": "你好", "pinyin": "nǐ hǎo"},
                                        {"id": "u01-w02", "hanzi": "谢谢", "pinyin": "xièxie"}],
                "dialogues": [{"id": "u01-d01", "lines": [{"hanzi": "你好", "pinyin": "nǐ hǎo"},
                                                          {"hanzi": "谢谢你", "pinyin": "Xièxie nǐ"}]}]}, ensure_ascii=False))
            self.assertEqual(build_sg_pinyin.build(root), {"u01-w02": "xièxiè", "u01-d01.l2": "Xièxiè nǐ"})

    def test_committed_file_is_up_to_date(self):
        path = ROOT / "data" / "pinyin-sg.json"
        self.assertTrue(path.exists(), "run python3 tools/build_sg_pinyin.py")
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), build_sg_pinyin.build(ROOT))


if __name__ == "__main__":
    unittest.main()
