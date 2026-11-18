#!/usr/bin/env python3
"""build_sg_pinyin.py -- write data/pinyin-sg.json, the pinyin the app shows with the Singapore accent.

PURPOSE
    Singapore Mandarin uses full tones where Mainland Mandarin has neutral tones (谢谢 xièxiè,
    not xièxie). The Singapore audio set is rendered from that reading (tools/zh_lexicon.py,
    "Singapore tone mode"); this tool derives the matching on-screen pinyin with the SAME
    function (``zh_lexicon.convert_line``), so the audio and the text cannot diverge.
    ``generate_audio.py --accent sg`` refuses to build when the file is stale.

OUTPUT
    ``data/pinyin-sg.json``: ``{"<itemId>": "xièxiè", "<dialogueId>.l<N>": "..."}`` with ONLY the
    entries that differ from the content's pinyin (the app falls back to the content pinyin).

USAGE
    python3 tools/build_sg_pinyin.py [--content-root .] [--check]    # --check: exit 1 if stale
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import zh_lexicon  # noqa: E402


def _load(path: Path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def build(content_root: Path, problems: Optional[list[str]] = None) -> dict[str, str]:
    """``{id: Singapore pinyin}`` for every item and dialogue line whose pinyin changes."""
    valid = zh_lexicon.generic_syllables()
    out: dict[str, str] = {}
    index = _load(content_root / "data" / "units.json")
    for ref in sorted(index["units"], key=lambda u: u.get("order", 0)):
        unit = _load(content_root / ref["file"])
        entries = [(it["id"], it["hanzi"], it["pinyin"]) for it in unit.get("items", [])]
        for d in unit.get("dialogues", []):
            entries += [(f"{d['id']}.l{n}", ln["hanzi"], ln["pinyin"]) for n, ln in enumerate(d.get("lines", []), start=1)]
        for key, hanzi, pinyin in entries:
            conv = zh_lexicon.convert_line(hanzi, pinyin, valid, True, problems)
            if conv is None:
                if problems is not None:
                    problems.append(f"cannot align {key}: {hanzi!r} / {pinyin!r}")
                continue
            if conv[1] != pinyin:
                out[key] = conv[1]
    return out


def main(argv: Optional[list[str]] = None) -> int:
    """Write (or with ``--check`` verify) ``data/pinyin-sg.json``."""
    here = Path(__file__).resolve().parent.parent
    p = argparse.ArgumentParser(description="Build data/pinyin-sg.json (Singapore pinyin for display).")
    p.add_argument("--content-root", type=Path, default=here)
    p.add_argument("--check", action="store_true", help="do not write; exit 1 if the file is missing or stale")
    args = p.parse_args(argv)
    problems: list[str] = []
    data = build(args.content_root, problems)
    for msg in problems:
        print("problem:", msg)
    path = args.content_root / "data" / "pinyin-sg.json"
    text = json.dumps(data, ensure_ascii=False, indent=1, sort_keys=False) + "\n"
    if args.check:
        ok = path.exists() and path.read_text(encoding="utf-8") == text
        print("pinyin-sg.json is up to date" if ok else "pinyin-sg.json is missing or stale: run tools/build_sg_pinyin.py")
        return 0 if ok and not problems else 1
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path} ({len(data)} entries)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
