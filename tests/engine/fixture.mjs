// Shared test fixture: a tiny 3-unit curriculum. Not a test file itself.
import { buildCurriculum } from "../../js/engine/curriculum.js";
import { defaultProgress } from "../../js/state/progress.js";

const mk = (unit, n, type, letter, english, alt) => ({
  id: `${unit}-${letter}${String(n).padStart(2, "0")}`, type,
  hanzi: `字${unit}${letter}${n}`, pinyin: `zi ${unit}${letter}${n}`, english, ...(alt ? { alt } : {}),
});

function unitFile(unit, words) {
  const items = [];
  words.forEach((w, i) => items.push(mk(unit, i + 1, "word", "w", w[0], w[1])));
  for (let i = 0; i < 3; i++) items.push(mk(unit, i + 1, "phrase", "p", `${unit} phrase ${i}`));
  for (let i = 0; i < 2; i++) items.push(mk(unit, i + 1, "sentence", "s", `${unit} sentence ${i}`));
  const dialogues = [{
    id: `${unit}-d01`, title: "Talk",
    lines: [{ speaker: "A", hanzi: "a", pinyin: "a", english: "a" }, { speaker: "B", hanzi: "b", pinyin: "b", english: "b" }],
    questions: [
      { id: `${unit}-d01-q1`, question: "Q1?", answer: "Yes", distractors: ["No", "Maybe", "Later", "yes"] },
      { id: `${unit}-d01-q2`, question: "Q2?", answer: "Two", distractors: ["One", "Three", "Four"] },
    ],
  }];
  return { id: unit, title: unit, items, dialogues };
}

export const unitsIndex = { version: 1, units: [
  { id: "u02", order: 2, title: "Two", file: "x" },
  { id: "u01", order: 1, title: "One", file: "x" }, // deliberately out of order
  { id: "u03", order: 3, title: "Three", file: "x" },
] };

export const unitFiles = {
  u01: unitFile("u01", [["hello", ["hi"]], ["goodbye"], ["thanks"], ["sorry"]]),
  u02: unitFile("u02", [["one"], ["two"], ["hi"], ["four"]]), // "hi" collides with u01 alt
  u03: unitFile("u03", [["red"], ["blue"], ["green"], ["black"]]),
};

export const curriculum = () => buildCurriculum(unitsIndex, unitFiles);

export const T0 = new Date(2026, 10, 17, 9, 0, 0).getTime(); // local time, so day keys are stable in any TZ
export const DAY = 86400000;
export const fresh = () => defaultProgress(T0);
