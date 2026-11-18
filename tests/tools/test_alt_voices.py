"""Tests for the quiz voice variants ``<item>.alt1..3`` of tools/generate_audio.py (no model, no ffmpeg)."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import generate_audio as ga  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "content"


class TwoVoices(ga.ZhEngine):
    name, model_id = "two", "two-v1"
    voices = ["a", "b"]
    dialogue_voices = {"A": "a", "B": "b"}


class OneVoice(TwoVoices):
    name, model_id = "one", "one-v1"
    voices = ["a"]


class AltVoiceTests(unittest.TestCase):
    def clips(self, engine=None):
        return {c.id: c for c in ga.enumerate_clips(FIXTURE, "cn", engine)}

    def test_kokoro_item_gets_the_other_three_voices_in_stable_order(self):
        clips = self.clips()
        items = [c for c in clips.values() if c.kind == "zh" and ".l" not in c.id and ".alt" not in c.id]
        self.assertTrue(items)
        for c in items:
            alts = [clips[f"{c.id}.alt{k}"] for k in (1, 2, 3)]
            self.assertNotIn(f"{c.id}.alt4", clips)
            self.assertEqual([a.voice for a in alts], [v for v in ga.ZH_VOICES if v != c.voice])
            self.assertNotIn(c.voice, [a.voice for a in alts])
            for a in alts:
                self.assertEqual((a.text, a.speed, a.kind, a.pinyin), (c.text, ga.NORMAL_SPEED, "zh", c.pinyin))
                self.assertEqual(a.rel_path, f"audio/zh/{c.id}_{a.id.split('.')[-1]}.mp3")

    def test_no_alts_for_dialogue_lines_and_no_slow_alts(self):
        ids = list(self.clips())
        self.assertFalse([i for i in ids if ".l" in i and ".alt" in i])
        self.assertFalse([i for i in ids if i.endswith(".slow") and ".alt" in i])
        self.assertFalse([i for i in ids if ".alt" in i and (i.endswith(".en") or i.startswith("sys."))])

    def test_engine_with_fewer_voices_yields_fewer_alts(self):
        two = self.clips(TwoVoices)
        for c in [c for c in two.values() if c.kind == "zh" and ".alt" not in c.id and ".l" not in c.id]:
            self.assertEqual(f"{c.id}.alt1" in two, True)
            self.assertNotIn(f"{c.id}.alt2", two)
            self.assertNotEqual(two[f"{c.id}.alt1"].voice, c.voice)
        self.assertFalse([i for i in self.clips(OneVoice) if ".alt" in i])

    def test_ids_unique_and_alt_cache_keys_differ_per_voice(self):
        clips = self.clips()
        d = {clips[f"u01-w01.alt{k}"].digest for k in (1, 2, 3)} | {clips["u01-w01"].digest}
        self.assertEqual(len(d), 4)


if __name__ == "__main__":
    unittest.main()
