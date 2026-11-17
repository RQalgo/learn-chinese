import test from "node:test";
import assert from "node:assert/strict";
import { buildCurriculum } from "../../js/engine/curriculum.js";
import { curriculum, unitsIndex, unitFiles } from "./fixture.mjs";

test("units ordered; items augmented; maps filled", () => {
  const c = curriculum();
  assert.deepEqual(c.units.map((u) => u.id), ["u01", "u02", "u03"]);
  const it = c.items.get("u02-w02");
  assert.equal(it.unitId, "u02"); assert.equal(it.unitOrder, 2); assert.equal(it.index, 1);
  assert.equal(c.items.size, 3 * 9);
  assert.equal(c.itemsOfUnit("u01").length, 9);
  assert.equal(c.dialoguesOfUnit("u03")[0].id, "u03-d01");
  assert.equal(c.questions.get("u01-d01-q2").dialogueId, "u01-d01");
  assert.equal(unitFiles.u01.items[0].unitId, undefined, "source not mutated");
});

test("unitOf resolves item, dialogue, question and clip ids", () => {
  const c = curriculum();
  for (const id of ["u02-w01", "u02-d01", "u02-d01-q1", "u02-w01.slow", "u02-d01.l1.en", "u02-d01.q2.en"]) {
    assert.equal(c.unitOf(id).id, "u02", id);
  }
  assert.equal(c.unitOf("zzz"), undefined);
});

test("clipsForUnit lists item, dialogue and question clips per §5", () => {
  const clips = curriculum().clipsForUnit("u01");
  for (const id of ["u01-w01", "u01-w01.slow", "u01-w01.en", "u01-d01.l1", "u01-d01.l2.slow", "u01-d01.l2.en", "u01-d01.q1.en", "u01-d01.q2.en", "sys.silence.1500", "sys.done"]) {
    assert.ok(clips.includes(id), id);
  }
  assert.equal(new Set(clips).size, clips.length, "no duplicates");
  assert.ok(!clips.some((c) => c.startsWith("u02")));
});

test("missing unit files are tolerated", () => {
  const c = buildCurriculum(unitsIndex, { u01: unitFiles.u01 });
  assert.equal(c.unit("u02").available, false);
  assert.equal(c.itemsOfUnit("u02").length, 0);
  assert.equal(c.unit("u01").available, true);
  assert.deepEqual(c.clipsForUnit("u02").filter((x) => !x.startsWith("sys.")), []);
  assert.equal(buildCurriculum({ units: [] }, undefined).units.length, 0);
  // array and Map forms
  assert.equal(buildCurriculum(unitsIndex, Object.values(unitFiles)).items.size, 27);
  assert.equal(buildCurriculum(unitsIndex, new Map(Object.entries(unitFiles))).items.size, 27);
});
