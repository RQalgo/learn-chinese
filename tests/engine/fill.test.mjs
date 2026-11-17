// Tests for session filling: quiz second-questions / bigger new cap and listen self-test cycling.
// Run against the small fixture AND the real curriculum in data/.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCurriculum } from "../../js/engine/curriculum.js";
import { makeRng } from "../../js/engine/rng.js";
import { planQuizSession, planListenSession, planClipIds } from "../../js/engine/session.js";
import { defaultProgress } from "../../js/state/progress.js";
import { curriculum as fixtureCurriculum, T0, DAY } from "./fixture.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const idx = JSON.parse(fs.readFileSync(path.join(root, "data/units.json"), "utf8"));
const files = {};
for (const u of idx.units) files[u.id] = JSON.parse(fs.readFileSync(path.join(root, u.file), "utf8"));
const real = buildCurriculum(idx, files);
const fix = fixtureCurriculum();

const nQuestions = (p) => p.steps.filter((s) => s.kind === "question").length + p.steps.filter((s) => s.kind === "dialogue").reduce((n, s) => n + s.questionIds.length, 0);

/** Learner who has introduced the given units; every other card is due, the rest not due (half/half). */
function learner(cur, unitIds, now) {
  const p = defaultProgress(now);
  p.unlocked = cur.units.map((u) => u.id).slice(0, unitIds.length + 1);
  let i = 0;
  for (const u of unitIds) for (const id of cur.unit(u).itemIds) {
    p.cards[id] = { box: 1 + (i % 3), due: i % 2 ? now - DAY * (1 + (i % 5)) : now + DAY * 5, introduced: true, seen: 2, correct: 1, wrong: 1, lastSeen: now - 1e8 };
    i++;
  }
  return p;
}

for (const [name, cur] of [["fixture", fix], ["real", real]]) {
  test(`[${name}] quiz: new-item caps 4/8/10 by length`, () => {
    const base = defaultProgress(T0);
    for (const [len, cap] of [["short", 4], ["normal", 8], ["long", 10]]) {
      const p = planQuizSession({ curriculum: cur, progress: base, now: T0, rng: makeRng(1), length: len });
      const intros = p.steps.filter((s) => s.kind === "intro").length;
      assert.equal(intros, Math.min(cap, cur.unit("u01").itemIds.length), len);
    }
  });

  test(`[${name}] quiz: brand-new learner gets second questions, spaced >= 3, never above length`, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const p = planQuizSession({ curriculum: cur, progress: defaultProgress(T0), now: T0, rng: makeRng(seed), length: "normal" });
      assert.ok(nQuestions(p) <= 20);
      assert.equal(p.counts.second, p.counts.new, "every new item asked twice when room allows");
      assert.equal(nQuestions(p), p.counts.review + p.counts.new + p.counts.dialogue + p.counts.fill + p.counts.second);
      for (const s of p.steps.filter((x) => x.kind === "intro")) {
        const qs = p.steps.map((x, i) => (x.kind === "question" && x.itemId === s.itemId ? i : -1)).filter((i) => i >= 0);
        assert.equal(qs.length, 2, s.itemId);
        assert.ok(qs[1] - qs[0] >= 3, `gap ${qs[1] - qs[0]}`);
        assert.ok(qs[0] - p.steps.indexOf(s) >= 2, "first question >= 2 after intro");
      }
    }
  });

  test(`[${name}] quiz: no second questions once the session is already full`, () => {
    const prog = learner(cur, ["u01", "u02"], T0);
    for (const c of Object.values(prog.cards)) c.due = T0 - DAY; // everything due
    const p = planQuizSession({ curriculum: cur, progress: prog, now: T0, rng: makeRng(3), length: "normal" });
    assert.ok(nQuestions(p) <= 20);
    assert.equal(p.counts.second, 0);
  });

  test(`[${name}] quiz: not-due introduced cards fill before second questions`, () => {
    const prog = learner(cur, ["u01"], T0);
    for (const c of Object.values(prog.cards)) c.due = T0 + 9 * DAY; // none due
    const p = planQuizSession({ curriculum: cur, progress: prog, now: T0, rng: makeRng(3), length: "normal" });
    assert.ok(p.counts.fill > 0);
    assert.ok(nQuestions(p) <= 20);
  });

  test(`[${name}] listen: within +-20 % of target for a new learner and a busy learner`, () => {
    const cases = [defaultProgress(T0), learner(cur, ["u01", "u02", "u03"].filter((u) => cur.unit(u)), T0)];
    for (const prog of cases) {
      for (const minutes of [5, 8, 10]) {
        const p = planListenSession({ curriculum: cur, progress: prog, now: T0, rng: makeRng(2), minutes });
        if (name === "fixture") { assert.ok(p.estimatedSec <= p.targetSec); continue; } // 27 items cannot fill a long playlist
        const ratio = p.estimatedSec / p.targetSec;
        assert.ok(ratio >= 0.8 && ratio <= 1.2, `${minutes} min: ${p.estimatedSec.toFixed(0)}s (${ratio.toFixed(2)})`);
      }
    }
  });
}

test("[real] listen: new cap ~1 per 40 s (max 12), self-tests only use known items, valid clips", () => {
  const valid = new Set(real.allClipIds());
  const p = planListenSession({ curriculum: real, progress: defaultProgress(T0), now: T0, rng: makeRng(4), minutes: 8 });
  const news = p.segments.filter((s) => s.kind === "new").map((s) => s.refId);
  assert.equal(news.length, 12);
  assert.equal(planListenSession({ curriculum: real, progress: defaultProgress(T0), now: T0, rng: makeRng(4), minutes: 3 }).segments.filter((s) => s.kind === "new").length, 4);
  const tests = p.segments.filter((s) => s.kind === "review");
  assert.ok(tests.length > 0 && tests.every((s) => news.includes(s.refId)), "brand-new learner self-tests this playlist's words");
  assert.equal(tests[0].clips[0], "sys.whatMeans");
  assert.equal(tests.filter((s) => s.clips[0] === "sys.whatMeans").length, 1);
  assert.ok(planClipIds(p).every((c) => valid.has(c)));
});

test("[real] quiz: brand-new learner reaches 16 questions, step ids valid", () => {
  const p = planQuizSession({ curriculum: real, progress: defaultProgress(T0), now: T0, rng: makeRng(9), length: "normal" });
  assert.equal(nQuestions(p), 16);
  assert.ok(p.steps.filter((s) => s.itemId).every((s) => real.items.has(s.itemId)));
});
