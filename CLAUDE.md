# Working on this repo

听 Tīng — a listening-only Mandarin trainer for an absolute beginner on an Android phone.

Read before changing anything:

* `docs/ARCHITECTURE.md` — the contract: layout, data schema, engine rules, code conventions, git workflow.
* `docs/CONTENT.md` — how lesson content is written (pinyin, English, lengths).
* `docs/AUDIO.md` — how audio clips are generated and verified.

Rules of thumb:

* Static site, vanilla JS ES modules, **relative URLs only** (served under `/learn-chinese/`).
* Engine modules (`js/engine/`, `js/state/progress.js`) are pure: `now` and `rng` are passed in.
* Every file has a header comment explaining its area; exported functions have JSDoc; non-obvious choices get `// WHY:` comments.
* One branch per small change; PR into `main`.
* Tests: `node --test tests/engine/*.test.mjs` (Node 22 does not accept a bare directory) and `python3 tools/validate_content.py`.
