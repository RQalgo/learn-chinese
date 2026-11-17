import test from "node:test";
import assert from "node:assert/strict";
import { makeRng, shuffle, pick, sample } from "../../js/engine/rng.js";
import { newCard, introduce, review, status, isDue, INTERVAL_DAYS, DAY_MS } from "../../js/engine/srs.js";

test("rng is deterministic and in [0,1)", () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 100; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
  assert.notEqual(makeRng(1)(), makeRng(2)());
});

test("shuffle/pick/sample", () => {
  const arr = [1, 2, 3, 4, 5, 6];
  const s = shuffle(arr, makeRng(1));
  assert.deepEqual([...s].sort(), arr);
  assert.deepEqual(arr, [1, 2, 3, 4, 5, 6], "input not mutated");
  assert.equal(pick([], makeRng(1)), undefined);
  assert.ok(arr.includes(pick(arr, makeRng(3))));
  const sm = sample(arr, 3, makeRng(5));
  assert.equal(new Set(sm).size, 3);
  assert.equal(sample(arr, 99, makeRng(5)).length, 6);
});

test("srs: new card and introduce", () => {
  const c = newCard();
  assert.deepEqual(c, { box: 0, due: 0, introduced: false, seen: 0, correct: 0, wrong: 0, lastSeen: 0 });
  const i = introduce(c, 1000);
  assert.equal(i.introduced, true); assert.equal(i.box, 0); assert.equal(i.due, 1000);
  assert.equal(c.introduced, false, "immutable");
});

test("srs: correct answers climb boxes with intervals, capped at 6", () => {
  let c = introduce(newCard(), 0);
  const now = 5000;
  for (let expected = 1; expected <= 6; expected++) {
    c = review(c, true, now);
    assert.equal(c.box, expected);
    assert.equal(c.due, now + INTERVAL_DAYS[expected] * DAY_MS);
  }
  c = review(c, true, now);
  assert.equal(c.box, 6);
  assert.equal(c.correct, 7); assert.equal(c.seen, 7); assert.equal(c.lastSeen, now);
});

test("srs: wrong answer drops to <= box 1 and is due now", () => {
  let c = { ...introduce(newCard(), 0), box: 5, due: 99999 };
  c = review(c, false, 777);
  assert.equal(c.box, 1); assert.equal(c.due, 777); assert.equal(c.wrong, 1);
  c = review({ ...c, box: 0 }, false, 800);
  assert.equal(c.box, 0);
});

test("srs: status buckets and isDue", () => {
  assert.equal(status(newCard()), "new");
  const base = introduce(newCard(), 0);
  const map = [[0, "learning"], [2, "learning"], [3, "familiar"], [4, "familiar"], [5, "mastered"], [6, "mastered"]];
  for (const [box, st] of map) assert.equal(status({ ...base, box }), st);
  assert.equal(isDue(newCard(), 10), false, "not introduced");
  assert.equal(isDue({ ...base, due: 10 }, 10), true);
  assert.equal(isDue({ ...base, due: 11 }, 10), false);
});
