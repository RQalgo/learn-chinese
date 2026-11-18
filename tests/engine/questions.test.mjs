import test from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../../js/engine/rng.js";
import { makeQuestion, makeDialogueQuestion, chooseQtype, pickDistractors } from "../../js/engine/questions.js";
import { newCard, introduce } from "../../js/engine/srs.js";
import { buildCurriculum } from "../../js/engine/curriculum.js";
import { curriculum, fresh } from "./fixture.mjs";

const cur = curriculum();
const norm = (s) => s.trim().toLowerCase();

test("distractors: never match answer english/alt, unique labels, prefer same type and unit", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const item = cur.items.get("u01-w01"); // english hello, alt hi; u02-w03 is "hi"
    const ds = pickDistractors(item, cur, fresh(), makeRng(seed), 3);
    assert.equal(ds.length, 3);
    const labels = ds.map((d) => norm(d.english));
    assert.equal(new Set(labels).size, 3);
    assert.ok(!labels.includes("hello") && !labels.includes("hi"), "no answer/alt match");
    assert.ok(ds.every((d) => d.type === "word" && d.unitId === "u01"), "same type + unit first");
  }
});

test("distractors fall back to other types / units when pool is small", () => {
  const ds = pickDistractors(cur.items.get("u01-s01"), cur, fresh(), makeRng(1), 3);
  assert.equal(ds.length, 3);
  assert.ok(ds.every((d) => d.type === "sentence"), "other sentences (any unit) before other types");
  const ds2 = pickDistractors(cur.items.get("u01-w01"), cur, fresh(), makeRng(1), 10);
  assert.ok(ds2.length > 3 && ds2.some((d) => d.unitId !== "u01"));
});

test("listen-meaning shape", () => {
  const q = makeQuestion("listen-meaning", "u01-w02", cur, fresh(), makeRng(3));
  assert.equal(q.qtype, "listen-meaning"); assert.equal(q.itemId, "u01-w02");
  assert.match(q.prompt.clip, /^u01-w02\.alt[123]$/, "quiz prompts use an alternative voice");
  assert.deepEqual(Object.keys(q.prompt), ["clip"]);
  assert.equal(q.options.length, 4);
  assert.equal(q.options[q.answerIndex].label, "goodbye");
  assert.equal(q.options[q.answerIndex].itemId, "u01-w02");
  assert.equal(new Set(q.options.map((o) => o.label)).size, 4);
});

test("meaning-audio shape: english prompt, 3 clips", () => {
  const q = makeQuestion("meaning-audio", "u01-w01", cur, fresh(), makeRng(4));
  assert.equal(q.prompt.text, "hello"); assert.equal(q.prompt.clip, undefined);
  assert.equal(q.options.length, 3);
  assert.ok(q.options.every((o) => o.clip && o.label && o.itemId));
  assert.match(q.options[q.answerIndex].clip, /^u01-w01\.alt[123]$/);
  assert.ok(q.options.every((o) => new RegExp(`^${o.itemId}\\.alt[123]$`).test(o.clip)), "every option is an alt-voice clip of its own item");
  assert.equal(new Set(q.options.map((o) => o.clip)).size, 3);
});

test("true-false shape: both outcomes occur and are consistent", () => {
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const q = makeQuestion("true-false", "u01-w01", cur, fresh(), makeRng(seed));
    assert.match(q.prompt.clip, /^u01-w01\.alt[123]$/);
    assert.equal(q.options.length, 2);
    assert.equal(q.answerIndex, q.isTrue ? 0 : 1);
    const shown = cur.items.get(q.shownItemId);
    assert.equal(q.prompt.text, shown.english);
    if (!q.isTrue) assert.ok(!["hello", "hi"].includes(norm(shown.english)));
    seen.add(q.isTrue);
  }
  assert.equal(seen.size, 2);
});

test("dialogue question: options from file, no duplicates of answer", () => {
  const q = makeDialogueQuestion("u01-d01-q1", cur, makeRng(2));
  assert.equal(q.qtype, "dialogue"); assert.equal(q.dialogueId, "u01-d01");
  assert.deepEqual(q.prompt.clips, ["u01-d01.l1", "u01-d01.l2"]);
  assert.equal(q.prompt.questionClip, "u01-d01.q1.en"); assert.equal(q.prompt.text, "Q1?");
  assert.equal(q.options[q.answerIndex].label, "Yes");
  assert.equal(q.options.length, 4, "'yes' distractor dropped as duplicate");
  assert.equal(new Set(q.options.map((o) => norm(o.label))).size, 4);
  assert.throws(() => makeDialogueQuestion("nope", cur, makeRng(1)));
});

test("tiny pool degrades gracefully", () => {
  const one = buildCurriculum({ units: [{ id: "u01", order: 1, title: "x" }] }, { u01: { id: "u01", items: [
    { id: "u01-w01", type: "word", hanzi: "a", pinyin: "a", english: "a" },
    { id: "u01-w02", type: "word", hanzi: "b", pinyin: "b", english: "b" }] } });
  const q = makeQuestion("listen-meaning", "u01-w01", one, null, makeRng(1));
  assert.equal(q.options.length, 2);
  const solo = buildCurriculum({ units: [{ id: "u01", order: 1, title: "x" }] }, { u01: { id: "u01", items: [
    { id: "u01-w01", type: "word", hanzi: "a", pinyin: "a", english: "a" }] } });
  const t = makeQuestion("meaning-audio", "u01-w01", solo, null, makeRng(1));
  assert.equal(t.qtype, "true-false"); assert.equal(t.isTrue, true); assert.equal(t.answerIndex, 0);
  assert.throws(() => makeQuestion("listen-meaning", "nope", one, null, makeRng(1)));
});

test("chooseQtype respects box and item type", () => {
  const word = cur.items.get("u01-w01"), sent = cur.items.get("u01-s01");
  const card = (box) => ({ ...introduce(newCard(), 0), box });
  for (let s = 1; s <= 100; s++) {
    assert.equal(chooseQtype(word, card(0), makeRng(s)), "listen-meaning");
    assert.notEqual(chooseQtype(word, card(1), makeRng(s)), "meaning-audio");
    assert.notEqual(chooseQtype(sent, card(4), makeRng(s)), "meaning-audio");
  }
  const kinds = new Set(Array.from({ length: 200 }, (_, s) => chooseQtype(word, card(3), makeRng(s + 1000))));
  assert.deepEqual([...kinds].sort(), ["listen-meaning", "meaning-audio", "true-false"]);
});
