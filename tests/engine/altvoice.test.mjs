// altvoice.test.mjs — quiz voices: alt selection (never primary, deterministic, fallback) and the clip fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { pickAltClip, altClipIds, ALT_COUNT } from "../../js/engine/altvoice.js";
import { resolveClipId } from "../../js/data/clips.js";
import { makeQuestion } from "../../js/engine/questions.js";
import { planListenSession } from "../../js/engine/session.js";
import { makeRng } from "../../js/engine/rng.js";
import { defaultProgress } from "../../js/state/progress.js";
import { curriculum } from "./fixture.mjs";
const loadFixtureCurriculum = async () => curriculum();

test("altClipIds lists .alt1 .. .altN", () => {
  assert.deepEqual(altClipIds("u01-w01"), ["u01-w01.alt1", "u01-w01.alt2", "u01-w01.alt3"]);
  assert.equal(ALT_COUNT, 3);
});

test("pickAltClip never returns the primary and covers every alt", () => {
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const id = pickAltClip("u01-w01", makeRng(seed));
    assert.notEqual(id, "u01-w01");
    assert.match(id, /^u01-w01\.alt[123]$/);
    seen.add(id);
  }
  assert.equal(seen.size, 3);
});

test("pickAltClip is deterministic for a seed", () => {
  for (let seed = 1; seed <= 10; seed++) assert.equal(pickAltClip("u02-s03", makeRng(seed)), pickAltClip("u02-s03", makeRng(seed)));
});

test("pickAltClip only picks alts present in the clip table; none -> primary", () => {
  const some = { "u01-w01": { src: "a" }, "u01-w01.alt2": { src: "b" } };
  for (let seed = 1; seed <= 20; seed++) assert.equal(pickAltClip("u01-w01", makeRng(seed), some), "u01-w01.alt2");
  const two = { "u01-w01.alt1": { src: "x" }, "u01-w01.alt3": { src: "y" } };
  const got = new Set(Array.from({ length: 40 }, (_, i) => pickAltClip("u01-w01", makeRng(i + 1), two)));
  assert.deepEqual([...got].sort(), ["u01-w01.alt1", "u01-w01.alt3"]);
  assert.equal(pickAltClip("u01-w01", makeRng(1), { "u01-w01": { src: "a" } }), "u01-w01", "engine with one voice: primary");
  assert.equal(pickAltClip("u01-w01", makeRng(1), {}), "u01-w01");
  assert.equal(pickAltClip("u01-w01", makeRng(1), { "u01-w01.alt1": { src: "" } }), "u01-w01", "empty src is not usable");
});

test("resolveClipId: a missing alt falls back to the primary, everything else is unchanged", () => {
  const clips = { "u01-w01": { src: "a" }, "u01-w01.alt1": { src: "b" } };
  assert.equal(resolveClipId("u01-w01.alt1", clips), "u01-w01.alt1");
  assert.equal(resolveClipId("u01-w01.alt2", clips), "u01-w01");
  assert.equal(resolveClipId("u01-w01.alt3", {}), "u01-w01");
  assert.equal(resolveClipId("u01-w01.alt2", null), "u01-w01");
  assert.equal(resolveClipId("u01-w01", clips), "u01-w01");
  assert.equal(resolveClipId("u01-w01.slow", clips), "u01-w01.slow");
  assert.equal(resolveClipId("u01-d01.l2", clips), "u01-d01.l2");
});

test("questions use alts of the clip table and the primary when the table has none", async () => {
  const cur = await loadFixtureCurriculum();
  const prog = defaultProgress(0);
  for (const qtype of ["listen-meaning", "true-false"]) {
    const q = makeQuestion(qtype, "u01-w01", cur, prog, makeRng(7), { "u01-w01.alt3": { src: "x" } });
    assert.equal(q.prompt.clip, "u01-w01.alt3", qtype);
    const plain = makeQuestion(qtype, "u01-w01", cur, prog, makeRng(7), { "u01-w01": { src: "x" } });
    assert.equal(plain.prompt.clip, "u01-w01", qtype + " fallback");
  }
  const m = makeQuestion("meaning-audio", "u01-w01", cur, prog, makeRng(7), {});
  assert.ok(m.options.every((o) => o.clip === o.itemId), "no alts anywhere: every option plays its primary");
});

test("a question keeps one prompt clip (replays use the same voice) and is seed-deterministic", async () => {
  const cur = await loadFixtureCurriculum();
  const a = makeQuestion("listen-meaning", "u01-w01", cur, defaultProgress(0), makeRng(5));
  const b = makeQuestion("listen-meaning", "u01-w01", cur, defaultProgress(0), makeRng(5));
  assert.deepEqual(a, b);
  assert.equal(typeof a.prompt.clip, "string");
});

test("commute self-test: alt voice for the prompt (only existing alts), primary for the final repeat", async () => {
  const cur = await loadFixtureCurriculum();
  const prog = defaultProgress(0);
  const dur = {};
  for (const id of cur.allClipIds()) if (!/\.alt\d$/.test(id)) dur[id] = 1;
  const withAlts = { ...dur };
  for (const it of cur.items.values()) withAlts[`${it.id}.alt1`] = 1.1;
  const plan = planListenSession({ curriculum: cur, progress: prog, now: 1e9, rng: makeRng(3), minutes: 8, durations: withAlts });
  const rev = plan.segments.filter((s) => s.kind === "review");
  assert.ok(rev.length);
  for (const s of rev) {
    const alt = s.clips.find((c) => /\.alt\d$/.test(c));
    assert.equal(alt, `${s.refId}.alt1`);
    assert.equal(s.clips.at(-1), s.refId);
  }
  const noAlts = planListenSession({ curriculum: cur, progress: prog, now: 1e9, rng: makeRng(3), minutes: 8, durations: dur });
  for (const s of noAlts.segments.filter((x) => x.kind === "review")) assert.ok(!s.clips.some((c) => /\.alt\d$/.test(c)), "no alt clips -> primary prompt");
});
