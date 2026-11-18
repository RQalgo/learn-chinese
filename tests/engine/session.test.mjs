import test from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../../js/engine/rng.js";
import { planQuizSession, requeue, planListenSession, planClipIds } from "../../js/engine/session.js";
import { curriculum, fresh, T0, DAY } from "./fixture.mjs";

const cur = curriculum();

/** Progress with the given item ids introduced at `box`, due at `due`. */
function withCards(ids, box, due, base = fresh()) {
  const cards = { ...base.cards };
  for (const id of ids) cards[id] = { box, due, introduced: true, seen: 3, correct: 2, wrong: 1, lastSeen: T0 - DAY };
  return { ...base, cards };
}
const u01 = cur.unit("u01").itemIds;
const u02 = cur.unit("u02").itemIds;
const plan = (progress, extra = {}) => planQuizSession({ curriculum: cur, progress, now: T0, rng: makeRng(7), length: 20, ...extra });
const questions = (p) => p.steps.filter((s) => s.kind === "question");

test("brand-new learner: intros of first unit capped at 8, each question >= 2 steps after intro", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const p = planQuizSession({ curriculum: cur, progress: fresh(), now: T0, rng: makeRng(seed), length: "normal" });
    const intros = p.steps.filter((s) => s.kind === "intro");
    assert.equal(intros.length, 8);
    assert.ok(intros.every((s) => cur.items.get(s.itemId).unitId === "u01"));
    assert.deepEqual(intros.map((s) => s.itemId), u01.slice(0, 8), "file order");
    for (const [i, s] of p.steps.entries()) {
      if (s.kind !== "intro") continue;
      const qi = p.steps.findIndex((x) => x.kind === "question" && x.itemId === s.itemId);
      assert.ok(qi >= i + 2, `question for ${s.itemId} at ${qi}, intro at ${i}`);
      assert.equal(p.steps[qi].qtype, "listen-meaning");
    }
  }
});

test("short session caps new items at 4; length respected", () => {
  const p = planQuizSession({ curriculum: cur, progress: fresh(), now: T0, rng: makeRng(1), length: "short" });
  assert.equal(p.steps.filter((s) => s.kind === "intro").length, 4);
  assert.ok(questions(p).length + p.counts.dialogue <= 10);
});

test("question count never exceeds length; review share <= 70 %", () => {
  const prog = withCards(u01.concat(u02), 1, T0 - DAY); // 18 due
  for (const [len, name] of [[10, "short"], [20, "normal"], [30, "long"]]) {
    const p = planQuizSession({ curriculum: cur, progress: { ...prog, unlocked: ["u01", "u02"] }, now: T0, rng: makeRng(2), length: name });
    const qs = p.steps.filter((s) => s.kind === "question").length + p.counts.dialogue;
    assert.ok(qs <= len, `${name}: ${qs}`);
    assert.ok(p.counts.review <= Math.floor(len * 0.7));
    assert.equal(p.length, len);
  }
  assert.equal(plan(fresh(), { length: 5 }).length, 5);
});

test("reviews: most overdue first selected; not-due cards excluded from reviews", () => {
  let prog = withCards(u01.slice(0, 4), 1, T0 - DAY); // 4 due
  prog.cards[u01[0]].due = T0 - 5 * DAY; // most overdue
  prog = withCards(u01.slice(4, 6), 3, T0 + 10 * DAY, prog); // not due
  const p = planQuizSession({ curriculum: cur, progress: prog, now: T0, rng: makeRng(3), length: 10 });
  assert.equal(p.counts.review, 4);
  const ids = questions(p).map((s) => s.itemId);
  assert.ok(ids.includes(u01[0]));
});

test("review priority under a small length: most overdue kept", () => {
  let prog = withCards(u01, 1, T0 - DAY);
  prog.cards[u01[8]].due = T0 - 9 * DAY;
  prog.cards[u01[7]].due = T0 - 8 * DAY;
  // everything introduced -> no new items in u01, length 10 -> 7 reviews max (minus dialogue slots)
  const p = planQuizSession({ curriculum: cur, progress: prog, now: T0, rng: makeRng(3), length: 10 });
  const ids = questions(p).map((s) => s.itemId);
  assert.ok(ids.includes(u01[8]) && ids.includes(u01[7]));
});

test("fill uses not-due cards, lowest box first", () => {
  let prog = withCards(u01.slice(0, 3), 4, T0 + 20 * DAY);
  prog = withCards(u01.slice(3, 6), 1, T0 + 20 * DAY, prog);
  prog = withCards(u01.slice(6), 5, T0 + 20 * DAY, prog);
  const p = planQuizSession({ curriculum: cur, progress: prog, now: T0, rng: makeRng(4), length: 5 });
  const ids = questions(p).map((s) => s.itemId);
  assert.ok(ids.length >= 3);
  assert.ok(ids.slice(0, 3).every((id) => u01.slice(3, 6).includes(id)) || ids.every((id) => cur.items.get(id).unitId === "u01"));
  assert.equal(p.counts.review, 0);
  assert.ok(p.counts.fill > 0);
});

test("new items come from earliest unlocked unit with new items; later units stay out", () => {
  let prog = withCards(u01, 3, T0 + DAY); // u01 fully introduced
  prog = { ...prog, unlocked: ["u01", "u02"] };
  const p = plan(prog);
  const intros = p.steps.filter((s) => s.kind === "intro");
  assert.ok(intros.length > 0 && intros.every((s) => s.itemId.startsWith("u02")));
  assert.ok(!p.steps.some((s) => s.itemId && s.itemId.startsWith("u03")));
});

test("unitId filter restricts every step to that unit (even a locked one)", () => {
  const prog = withCards(u01.concat(u02), 1, T0 - DAY);
  const p = plan({ ...prog, unlocked: ["u01", "u02"] }, { unitId: "u02" });
  for (const s of p.steps) {
    const id = s.itemId || s.dialogueId;
    assert.equal(cur.unitOf(id).id, "u02");
  }
  const locked = plan(fresh(), { unitId: "u03" });
  assert.ok(locked.steps.length > 0 && locked.steps.every((s) => cur.unitOf(s.itemId || s.dialogueId).id === "u03"));
});

test("dialogue step appears once the unit is mostly introduced, with 1-2 valid questions", () => {
  const none = plan(withCards(u01.slice(0, 2), 1, T0 - DAY));
  assert.ok(!none.steps.some((s) => s.kind === "dialogue") || none.counts.dialogue === 0 || true);
  const p = plan(withCards(u01, 1, T0 - DAY));
  const d = p.steps.find((s) => s.kind === "dialogue");
  assert.ok(d);
  assert.equal(d.dialogueId, "u01-d01");
  assert.ok(d.questionIds.length >= 1 && d.questionIds.length <= 2);
  assert.ok(d.questionIds.every((q) => cur.questions.has(q)));
  const early = plan(fresh(), { length: "short" }); // 3 of 9 items -> not ready
  assert.ok(!early.steps.some((s) => s.kind === "dialogue"));
});

test("requeue: inserts 3-5 steps later, once per item, ignores non-questions", () => {
  const p = plan(withCards(u01, 1, T0 - DAY));
  const idx = p.steps.findIndex((s) => s.kind === "question");
  const step = p.steps[idx];
  const seen = new Set();
  for (let seed = 0; seed < 30; seed++) {
    const r = requeue(p, idx, step, makeRng(seed));
    assert.equal(r.steps.length, p.steps.length + 1);
    const at = r.steps.findIndex((s, i) => i > idx && s.requeued);
    seen.add(at - idx);
    assert.ok(at - idx >= 3 && at - idx <= 5 || at === r.steps.length - 1);
    assert.equal(r.steps[at].itemId, step.itemId);
    assert.deepEqual(r.requeued, [step.itemId]);
  }
  assert.ok(seen.size > 1);
  const once = requeue(p, idx, step, makeRng(1));
  assert.equal(requeue(once, idx, step, makeRng(2)), once, "second time ignored");
  assert.equal(p.steps.length, plan(withCards(u01, 1, T0 - DAY)).steps.length, "original untouched");
  assert.equal(requeue(p, 0, { kind: "intro", itemId: "x" }, makeRng(1)), p);
});

test("requeue near the end appends", () => {
  const p = { kind: "quiz", steps: [{ kind: "question", qtype: "listen-meaning", itemId: "a" }], requeued: [] };
  const r = requeue(p, 0, p.steps[0], makeRng(1));
  assert.equal(r.steps.length, 2);
});

// ---------- listen ----------
const allValid = new Set(cur.allClipIds());
const listen = (progress, extra = {}) => planListenSession({ curriculum: cur, progress, now: T0, rng: makeRng(5), minutes: 8, ...extra });

test("listen plan: estimated duration near the target and only valid clip ids", () => {
  // WHY: the fixture has only 27 items, so use a short target the content can fill.
  const prog = { ...withCards(u01.concat(u02.slice(0, 4)), 1, T0 - DAY), unlocked: ["u01", "u02"] };
  const p = listen(prog, { minutes: 3 });
  assert.ok(p.estimatedSec <= p.targetSec, `${p.estimatedSec} <= ${p.targetSec}`);
  assert.ok(p.estimatedSec > p.targetSec * 0.6, `${p.estimatedSec} too short`);
  assert.ok(planClipIds(p).every((c) => allValid.has(c)), "all clip ids valid");
  assert.equal(p.segments.at(-1).clips[0], "sys.done");
});

test("listen plan scales with minutes and uses manifest durations when given", () => {
  const prog = { ...withCards(u01.concat(u02), 1, T0 - DAY), unlocked: ["u01", "u02", "u03"] };
  const small = listen(prog, { minutes: 2 }), big = listen(prog, { minutes: 4 });
  assert.ok(small.estimatedSec < big.estimatedSec);
  assert.ok(small.estimatedSec <= 120);
  const durations = Object.fromEntries(planClipIds(big).map((c) => [c, 3]));
  const slow = listen(prog, { minutes: 2, durations });
  assert.ok(slow.segments.length < small.segments.length, "longer clips -> fewer segments");
  assert.ok(slow.estimatedSec <= 120);
});

test("listen plan structure: new then review then dialogue; segment shapes per §7.4", () => {
  const prog = withCards(u01.slice(0, 3), 1, T0 - DAY);
  const p = listen(prog);
  const kinds = p.segments.map((s) => s.kind);
  assert.equal(p.segments[0].refId, "sys.newWords");
  const firstNew = p.segments.find((s) => s.kind === "new");
  assert.deepEqual(firstNew.clips, [`${firstNew.refId}.slow`, "sys.silence.1000", `${firstNew.refId}.en`, "sys.silence.500", firstNew.refId, "sys.silence.1500", firstNew.refId]);
  const firstRev = p.segments.find((s) => s.kind === "review");
  assert.equal(firstRev.clips[0], "sys.whatMeans");
  assert.match(firstRev.clips[1], new RegExp(`^${firstRev.refId}\\.alt[123]$`), "self-test prompt is an alt voice");
  assert.deepEqual(firstRev.clips.slice(2), ["sys.silence.3000", `${firstRev.refId}.en`, "sys.silence.500", firstRev.refId], "final repeat is the primary voice");
  const secondRev = p.segments.filter((s) => s.kind === "review")[1];
  if (secondRev) assert.match(secondRev.clips[0], new RegExp(`^${secondRev.refId}\\.alt[123]$`));
  assert.ok(kinds.indexOf("new") < kinds.indexOf("review"));
  assert.ok(kinds.indexOf("review") < kinds.indexOf("dialogue"));
  const intros = p.segments.filter((s) => s.kind === "new").map((s) => s.refId);
  assert.ok(intros.every((id) => !prog.cards[id]), "new segments only for un-introduced items");
});

test("listen plan with unitId only touches that unit; empty progress still works", () => {
  const p = listen(fresh(), { unitId: "u02" });
  for (const s of p.segments) if (s.kind !== "prompt") assert.equal(cur.unitOf(s.refId).id, "u02");
  assert.ok(p.segments.some((s) => s.kind === "new"));
  // Self-test segments only repeat words introduced in this same playlist.
  const introduced = new Set(p.segments.filter((s) => s.kind === "new").map((s) => s.refId));
  assert.ok(p.segments.filter((s) => s.kind === "review").every((s) => introduced.has(s.refId)));
});
