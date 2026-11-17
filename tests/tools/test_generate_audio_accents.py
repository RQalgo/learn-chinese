"""Tests for the accent / engine plumbing of tools/generate_audio.py (no model, no ffmpeg needed)."""

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import generate_audio as ga  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "content"


class OtherEngine(ga.ZhEngine):
    """A stand-in second engine (what a CosyVoice class would look like to the pipeline)."""

    name = "other"
    model_id = "other-model-v1"
    voices = ["spk-a", "spk-b"]
    dialogue_voices = {"A": "spk-a", "B": "spk-b"}


class AccentEnumerationTests(unittest.TestCase):
    def test_cn_has_everything_in_audio(self):
        clips = ga.enumerate_clips(FIXTURE)
        self.assertEqual({c.kind for c in clips}, {"zh", "zh-slow", "en", "sys"})
        self.assertTrue(all(c.rel_path.startswith("audio/") for c in clips))

    def test_sg_is_mandarin_only_under_audio_sg_with_same_ids(self):
        cn = {c.id for c in ga.enumerate_clips(FIXTURE) if c.kind in ("zh", "zh-slow")}
        sg = ga.enumerate_clips(FIXTURE, "sg")
        self.assertEqual({c.id for c in sg}, cn)
        self.assertTrue(all(c.rel_path.startswith("audio-sg/") and c.kind in ("zh", "zh-slow") for c in sg))
        self.assertIn("audio-sg/zh-slow/", next(c for c in sg if c.id.endswith(".slow")).rel_path)

    def test_engine_supplies_voices(self):
        sg = ga.enumerate_clips(FIXTURE, "sg", OtherEngine)
        self.assertTrue({c.voice for c in sg} <= {"spk-a", "spk-b"})


class CacheKeyTests(unittest.TestCase):
    def test_kokoro_key_is_unchanged_legacy_key(self):
        # WHY: the pre-engine formula; if this fails every existing Mandarin clip would rebuild.
        c = next(c for c in ga.enumerate_clips(FIXTURE) if c.kind == "zh")
        parts = [c.text, c.voice, c.speed, c.silence_ms, ga.PIPELINE_VERSION, ga.ZH_MODEL_NAME]
        if c.lex_sig:
            parts.append(c.lex_sig)
        legacy = hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
        self.assertEqual(c.digest, legacy)

    def test_engine_is_part_of_the_key(self):
        a = ga.enumerate_clips(FIXTURE, "sg")[0]
        b = ga.enumerate_clips(FIXTURE, "sg", OtherEngine)[0]
        self.assertNotEqual(a.digest, b.digest)
        self.assertEqual(OtherEngine.cache_id(), "other:other-model-v1")

    def test_english_keys_do_not_depend_on_engine(self):
        en = lambda eng: next(c for c in ga.enumerate_clips(FIXTURE, "cn", eng) if c.kind == "en")
        self.assertEqual(en(ga.KokoroZhEngine).digest, en(OtherEngine).digest)


class ManifestTests(unittest.TestCase):
    def test_sg_manifest_uses_site_root_relative_src(self):
        sg = ga.enumerate_clips(FIXTURE, "sg")[:1]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            f = root / sg[0].rel_path
            f.parent.mkdir(parents=True)
            f.write_bytes(b"x")
            n = ga.write_manifest(root, sg, {sg[0].id: {"hash": "h", "dur": 1.234}}, "audio-sg")
            data = json.loads((root / "audio-sg" / "manifest.json").read_text())
        self.assertEqual(n, 1)
        self.assertTrue(data["clips"][sg[0].id]["src"].startswith("audio-sg/zh/"))
        self.assertIn("?v=", data["clips"][sg[0].id]["src"])
        self.assertEqual(data["clips"][sg[0].id]["dur"], 1.23)


if __name__ == "__main__":
    unittest.main()
