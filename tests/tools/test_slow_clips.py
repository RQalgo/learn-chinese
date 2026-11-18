"""Tests for the slow-clip strategy: word chunking (zh_lexicon.plan_chunks) and the plan/cache key
(generate_audio.plan_slow). No TTS model and no ffmpeg needed."""

import sys
import unittest
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import generate_audio as ga  # noqa: E402
import zh_lexicon as zl  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "content"
VALID = zl.generic_syllables()


def chunks(hanzi, pinyin):
    plan = zl.plan_chunks(hanzi, pinyin, VALID)
    return None if plan is None else [t for t, _ in plan]


class PlanChunksTests(unittest.TestCase):
    def test_cut_at_pinyin_word_boundaries_keeping_punctuation(self):
        self.assertEqual(chunks("谢谢，再见！", "Xièxie, zàijiàn!"), ["谢谢，", "再见！"])

    def test_single_word_stays_whole_so_neutral_tone_words_are_not_split(self):
        self.assertEqual(chunks("谢谢", "xièxie"), ["谢谢"])
        self.assertEqual(chunks("朋友", "péngyou"), ["朋友"])

    def test_sandhi_bu_stays_with_the_next_word(self):
        self.assertEqual(chunks("好久不见，你好吗？", "Hǎojiǔ bú jiàn, nǐ hǎo ma?"), ["好久", "不见，", "你好吗？"])

    def test_neutral_particle_stays_with_the_word_before(self):
        self.assertEqual(chunks("你呢？", "Nǐ ne?"), ["你呢？"])
        self.assertEqual(chunks("我的朋友。", "Wǒ de péngyou."), ["我的", "朋友。"])

    def test_two_third_tones_stay_together(self):
        self.assertEqual(chunks("你好", "nǐ hǎo"), ["你好"])

    def test_single_syllable_chunks_join_a_neighbour_in_the_same_clause(self):
        self.assertEqual(chunks("欢迎，请进！", "Huānyíng, qǐng jìn!"), ["欢迎，", "请进！"])
        self.assertEqual(chunks("对不起，我来晚了。", "Duìbuqǐ, wǒ lái wǎn le."), ["对不起，", "我来", "晚了。"])

    def test_list_of_single_syllables_is_one_chunk(self):
        self.assertEqual(chunks("一，二，三，四，五。", "Yī, èr, sān, sì, wǔ."), ["一，二，三，四，五。"])

    def test_chunks_always_rebuild_the_original_text(self):
        for hanzi, pinyin in [("对，这是七，很好！", "Duì, zhè shì qī, hěn hǎo!"), ("不对，是八，不是六。", "Bú duì, shì bā, bú shì liù.")]:
            self.assertEqual("".join(chunks(hanzi, pinyin)), hanzi)

    def test_unaligned_line_gives_none(self):
        self.assertIsNone(zl.plan_chunks("你好", "nǐ hǎo ma", VALID))

    def test_clause_end_flag_marks_punctuation(self):
        plan = zl.plan_chunks("谢谢，再见！", "Xièxie, zàijiàn!", VALID)
        self.assertEqual([e for _, e in plan], [True, True])
        plan = zl.plan_chunks("老师早上好", "lǎoshī zǎoshang hǎo", VALID)
        self.assertEqual(plan[-1][1], False)

    def test_all_content_aligns_and_no_lexicon_unit_is_split(self):
        # WHY: model-free half of the neutral-tone guarantee; every content line must chunk and rebuild.
        for c in ga.enumerate_clips(ROOT):
            if c.kind == "zh":
                plan = zl.plan_chunks(c.text, c.pinyin, VALID)
                self.assertIsNotNone(plan, c.id)
                self.assertEqual("".join(t for t, _ in plan), c.text, c.id)


class SlowPlanTests(unittest.TestCase):
    def setUp(self):
        self.clips = ga.plan_slow(ga.enumerate_clips(FIXTURE))
        self.slow = [c for c in self.clips if c.kind == "zh-slow"]

    def test_only_slow_clips_get_a_plan(self):
        self.assertTrue(self.slow)
        self.assertTrue(all(c.slow_plan and c.ref and c.ref.id + ".slow" == c.id for c in self.slow))
        self.assertTrue(all(not c.slow_plan for c in self.clips if c.kind != "zh-slow"))

    def test_gaps_between_chunks_but_none_after_the_last(self):
        for c in self.slow:
            self.assertEqual(c.slow_plan[-1][1], 0)
            self.assertTrue(all(g in (ga.SLOW_GAP_MS, ga.SLOW_CLAUSE_GAP_MS) for _, g in c.slow_plan[:-1]))

    def test_target_ratio_by_type(self):
        self.assertEqual(ga.slow_target_ratio("u01-w01.slow"), 1.6)
        self.assertEqual(ga.slow_target_ratio("u03-p12.slow"), 1.6)
        self.assertEqual(ga.slow_target_ratio("u01-s02.slow"), 1.45)
        self.assertEqual(ga.slow_target_ratio("u01-d01.l3.slow"), 1.45)

    def test_slow_key_contains_the_strategy_and_normal_keys_do_not_change(self):
        base = ga.enumerate_clips(FIXTURE)
        planned = ga.plan_slow(base)
        for a, b in zip(base, planned):
            if a.kind == "zh-slow":
                self.assertNotEqual(a.digest, b.digest)
            else:
                self.assertEqual(a.digest, b.digest, a.id)

    def test_strategy_version_and_normal_clip_change_the_slow_key_only(self):
        slow = self.slow[0]
        old, before = ga.SLOW_STRATEGY, slow.digest
        try:
            ga.SLOW_STRATEGY = "slow-test"
            self.assertNotEqual(before, slow.digest)
        finally:
            ga.SLOW_STRATEGY = old
        other_ref = replace(slow, ref=replace(slow.ref, voice="x"))
        self.assertNotEqual(slow.digest, other_ref.digest)

    def test_known_reference_duration_comes_from_an_up_to_date_cache_entry_only(self):
        base = ga.enumerate_clips(FIXTURE)
        ref = next(c for c in base if c.kind == "zh")
        fresh = ga.plan_slow(base, {ref.id: {"hash": ref.digest, "dur": 0.8}})
        stale = ga.plan_slow(base, {ref.id: {"hash": "old", "dur": 0.8}})
        pick = lambda cl: next(c for c in cl if c.id == ref.id + ".slow")
        self.assertEqual(pick(fresh).ref_dur, 0.8)
        self.assertEqual(pick(stale).ref_dur, 0.0)

    def test_atempo_chain_never_goes_below_0_7_per_pass(self):
        import re
        for tempo in (0.9, 0.7, 0.6, 0.45, 0.3):
            vals = [float(v) for v in re.findall(r"atempo=([\d.]+)", ga.atempo_chain(tempo))]
            self.assertTrue(all(v >= 0.7 - 1e-9 for v in vals), (tempo, vals))
            prod = 1.0
            for v in vals:
                prod *= v
            self.assertAlmostEqual(prod, tempo, places=3)


if __name__ == "__main__":
    unittest.main()
