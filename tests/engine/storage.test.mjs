import test from "node:test";
import assert from "node:assert/strict";
import { loadProgress, saveProgress, exportProgress, importProgress, migrate, validateProgress, STORAGE_KEY } from "../../js/state/storage.js";
import { applyAnswer, DEFAULT_SETTINGS } from "../../js/state/progress.js";
import { fresh, T0 } from "./fixture.mjs";

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), _m: m };
}

test("load from empty storage returns a fresh blob", () => {
  const p = loadProgress(fakeStorage(), T0);
  assert.equal(p.createdAt, T0); assert.equal(p.version, 1);
  assert.equal(loadProgress(null, T0).createdAt, T0);
});

test("save/load round trip uses key tingProgress.v1", () => {
  const st = fakeStorage();
  const p = applyAnswer(fresh(), { itemId: "u01-w01", correct: true, now: T0 }).progress;
  assert.equal(saveProgress(p, st), true);
  assert.ok(st._m.has("tingProgress.v1")); assert.equal(STORAGE_KEY, "tingProgress.v1");
  assert.deepEqual(loadProgress(st, 0), p);
});

test("save reports failure instead of throwing", () => {
  const st = { setItem() { throw new Error("quota"); } };
  assert.equal(saveProgress(fresh(), st), false);
});

test("export/import round trip", () => {
  const p = applyAnswer(fresh(), { itemId: "u01-w01", correct: true, now: T0 }).progress;
  assert.deepEqual(importProgress(exportProgress(p)), p);
});

test("import validation gives helpful errors", () => {
  assert.throws(() => importProgress("not json"), /not valid JSON/);
  assert.throws(() => importProgress("[]"), /JSON object/);
  assert.throws(() => importProgress("{}"), /version/);
  assert.throws(() => importProgress(JSON.stringify({ ...fresh(), version: 99 })), /Update the app/);
  assert.throws(() => importProgress(JSON.stringify({ ...fresh(), xp: -5 })), /xp/);
  assert.throws(() => importProgress(JSON.stringify({ ...fresh(), cards: { a: { box: 9, due: 0, introduced: true, seen: 0, correct: 0, wrong: 0, lastSeen: 0 } } })), /box/);
  assert.throws(() => importProgress(JSON.stringify({ ...fresh(), daily: { today: {} } })), /daily/);
});

test("migrate fills missing sections and does not mutate input", () => {
  const input = { version: 1, createdAt: 5, xp: 10, cards: {} };
  const out = migrate(input);
  assert.deepEqual(out.unlocked, ["u01"]); assert.equal(out.settings.dailyGoalXp, 60);
  assert.deepEqual(out.streak, { current: 0, best: 0, lastDay: null });
  assert.deepEqual(input, { version: 1, createdAt: 5, xp: 10, cards: {} });
  assert.deepEqual(validateProgress(out), []);
  assert.throws(() => migrate(null));
  assert.throws(() => migrate({ version: "1" }));
});

test("corrupt stored data is kept aside and a fresh blob returned", () => {
  const st = fakeStorage({ [STORAGE_KEY]: "{broken" });
  const p = loadProgress(st, T0);
  assert.equal(p.xp, 0);
  assert.equal(st.getItem(`${STORAGE_KEY}.corrupt`), "{broken");
});

test("accent setting defaults to sg and survives old saves, junk and round trips", () => {
  assert.equal(DEFAULT_SETTINGS.accent, "sg");
  assert.equal(fresh().settings.accent, "sg");
  // old save without the key (settings written before accent existed)
  const { accent, ...oldSettings } = fresh().settings;
  const old = migrate({ ...fresh(), settings: oldSettings });
  assert.equal(old.settings.accent, "sg"); assert.deepEqual(validateProgress(old), []);
  // saved choice is kept; junk is repaired to the default
  assert.equal(migrate({ ...fresh(), settings: { ...fresh().settings, accent: "cn" } }).settings.accent, "cn");
  assert.equal(migrate({ ...fresh(), settings: { ...fresh().settings, accent: "xx" } }).settings.accent, "sg");
  // storage round trip through loadProgress
  const st = fakeStorage();
  saveProgress({ ...fresh(), settings: { ...fresh().settings, accent: "cn" } }, st);
  assert.equal(loadProgress(st, 0).settings.accent, "cn");
  const legacy = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ ...fresh(), settings: oldSettings }) });
  assert.equal(loadProgress(legacy, 0).settings.accent, "sg");
});
