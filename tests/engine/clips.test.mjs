// clips.test.mjs — effective clip table per Mandarin accent (js/data/clips.js).
import test from "node:test";
import assert from "node:assert/strict";
import { effectiveClips, isMandarinClip, manifestClips } from "../../js/data/clips.js";

const cn = { version: 1, clips: {
  "u01-w01": { src: "audio/zh/u01-w01.mp3?v=a", dur: 1 },
  "u01-w01.slow": { src: "audio/zh-slow/u01-w01_slow.mp3?v=a", dur: 1.5 },
  "u01-w01.en": { src: "audio/en/u01-w01_en.mp3?v=a", dur: 0.8 },
  "u01-d01.l1": { src: "audio/zh/u01-d01_l1.mp3?v=a", dur: 2 },
  "sys.welcome": { src: "audio/sys/sys_welcome.mp3?v=a", dur: 1.1 },
  "sys.silence.500": { src: "audio/sys/sys_silence_500.mp3?v=a", dur: 0.5 },
} };
const sg = { version: 1, clips: {
  "u01-w01": { src: "audio-sg/zh/u01-w01.mp3?v=b", dur: 1.2 },
  "u01-w01.slow": { src: "audio-sg/zh-slow/u01-w01_slow.mp3?v=b", dur: 1.9 },
  // WHY: the SG set must never override English / sys clips, even if one slipped in.
  "u01-w01.en": { src: "audio-sg/en/x.mp3", dur: 9 },
  "sys.welcome": { src: "audio-sg/sys/x.mp3", dur: 9 },
} };

test("isMandarinClip separates Mandarin from English and sys", () => {
  for (const id of ["u01-w01", "u01-w01.slow", "u01-d01.l2", "u01-d01.l2.slow"]) assert.equal(isMandarinClip(id), true, id);
  for (const id of ["u01-w01.en", "u01-d01.l2.en", "u01-d01.q1.en", "sys.welcome", "sys.silence.500"]) assert.equal(isMandarinClip(id), false, id);
});

test("cn accent returns the Mainland table unchanged", () => {
  const r = effectiveClips(cn, sg, "cn");
  assert.equal(r.accent, "cn"); assert.equal(r.sgAvailable, true);
  assert.deepEqual(r.clips, cn.clips);
  assert.equal(r.durations["u01-w01"], 1);
});

test("sg accent prefers SG Mandarin entries and falls back to Mainland", () => {
  const r = effectiveClips(cn, sg, "sg");
  assert.equal(r.accent, "sg");
  assert.equal(r.clips["u01-w01"].src, "audio-sg/zh/u01-w01.mp3?v=b");
  assert.equal(r.clips["u01-w01.slow"].src, "audio-sg/zh-slow/u01-w01_slow.mp3?v=b");
  assert.equal(r.clips["u01-d01.l1"].src, "audio/zh/u01-d01_l1.mp3?v=a", "uncovered Mandarin clip falls back");
  assert.equal(r.clips["u01-w01.en"].src, "audio/en/u01-w01_en.mp3?v=a", "English always Mainland-set");
  assert.equal(r.clips["sys.welcome"].src, "audio/sys/sys_welcome.mp3?v=a");
  assert.equal(r.durations["u01-w01"], 1.2, "durations follow the effective clip");
  assert.equal(r.durations["u01-d01.l1"], 2);
});

test("missing or empty SG manifest forces cn and reports sgAvailable=false", () => {
  for (const m of [null, undefined, {}, { clips: {} }, { clips: { "u01-w01.en": { src: "x.mp3" } } }, { clips: { "u01-w01": {} } }, "junk"]) {
    const r = effectiveClips(cn, m, "sg");
    assert.equal(r.accent, "cn"); assert.equal(r.sgAvailable, false);
    assert.deepEqual(r.clips, cn.clips);
  }
});

test("missing Mainland manifest still works and does not mutate inputs", () => {
  const before = JSON.stringify([cn, sg]);
  const r = effectiveClips(null, sg, "sg");
  assert.deepEqual(Object.keys(r.clips).sort(), ["u01-w01", "u01-w01.slow"]);
  r.clips["u01-w01"] = null;
  assert.equal(JSON.stringify([cn, sg]), before);
  assert.deepEqual(effectiveClips(null, null, "sg").clips, {});
  assert.deepEqual(manifestClips(undefined), {});
});
