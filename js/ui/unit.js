/**
 * unit.js — Unit detail (#/unit/:id).
 *
 * Purpose
 *   Browse one unit: stats, actions (practise, listen, download for offline,
 *   unlock early) and every item / dialogue with tap-to-hear buttons.
 *
 * How it fits
 *   Registered by main.js. Uses store.*, audio/player.js (playClip,
 *   playSequence, stop), audio/offline.js (downloadClips), state/progress.js
 *   (unitStats, unlockUnit), engine/srs.js (status). Links to #/quiz?unit= and
 *   #/listen?unit=.
 *
 * Key concepts
 *   - Items are grouped Words / Phrases / Sentences; a coloured dot shows the
 *     item's SRS status. Pinyin is always shown here (this is a reference
 *     screen, not a test).
 *   - The offline button sends this unit's clip URLs (only those present in the
 *     audio manifest) to the service worker.
 *
 * Public API
 *   render(root, ctx) -> dispose function
 */

import { h, clear, icon, stars, statusBar, confirmModal, toast, STATUS_LABEL } from "./dom.js";
import { store, setProgress } from "./store.js";
import { playClip, playSequence, stop } from "../audio/player.js";
import { downloadClips, offlineSupported } from "../audio/offline.js";
import { unitStats, unlockUnit } from "../state/progress.js";
import { status } from "../engine/srs.js";

// ===== Section: Pieces =====

const GROUPS = [["word", "Words"], ["phrase", "Phrases"], ["sentence", "Sentences"]];

/** One item row with a play button. */
function itemRow(item) {
  const st = status(store.progress.cards[item.id] || { introduced: false, box: 0 });
  return h("li", { class: "item" },
    h("button", { type: "button", class: "icon-btn accent", "aria-label": `Play ${item.english}`, onclick: () => playClip(item.id) }, icon("play", 22)),
    h("div", null, h("div", { class: "pinyin" }, item.pinyin), h("div", { class: "en" }, item.english), h("div", { class: "hanzi" }, item.hanzi)),
    h("span", { class: `dot ${st}`, role: "img", "aria-label": STATUS_LABEL[st] }));
}

/** One dialogue block: title, play-all button and an expandable transcript. */
function dialogueBlock(d) {
  const clips = (d.lines || []).flatMap((_, i) => [`${d.id}.l${i + 1}`, "sys.silence.500"]);
  return h("div", { class: "dlg" },
    h("div", { class: "dlg-head" },
      h("button", { type: "button", class: "icon-btn accent", "aria-label": `Play conversation: ${d.title}`, onclick: () => playSequence(clips) }, icon("play", 22)),
      h("div", null, h("b", null, d.title), h("div", { class: "muted", style: { fontSize: ".85rem" } }, `${(d.lines || []).length} lines`))),
    h("details", null, h("summary", null, "Show transcript"),
      h("ol", { class: "transcript" }, (d.lines || []).map((l) =>
        h("li", null, h("span", { class: "who" }, l.speaker),
          h("div", null, h("div", { class: "py" }, l.pinyin), h("div", { class: "en" }, l.english), h("div", { class: "hz hanzi" }, l.hanzi)))))));
}

// ===== Section: Screen =====

/**
 * Render the unit detail screen.
 * @param {HTMLElement} root
 * @param {{params: {id: string}}} ctx
 * @returns {() => void} dispose: stops audio.
 */
export function render(root, ctx) {
  const unit = store.curriculum.unit(ctx.params.id);
  const draw = () => {
    clear(root);
    if (!unit) {
      root.append(h("div", { class: "center-screen" }, h("h1", null, "Unit not found"), h("a", { class: "btn primary", href: "#/units" }, "Back to units")));
      return;
    }
    const { curriculum, progress } = store;
    const locked = !progress.unlocked.includes(unit.id);
    const s = unitStats(progress, curriculum, unit.id);

    // --- offline download button ---
    const clipUrls = curriculum.clipsForUnit(unit.id).filter((c) => store.clips[c]).map((c) => store.clips[c].src);
    const dlNote = h("p", { class: "muted", style: { fontSize: ".85rem" }, id: "dl-note" });
    const dlBtn = h("button", { type: "button", class: "btn", id: "download-audio" }, icon("download", 20), "Download audio for offline");
    if (!clipUrls.length) {
      dlBtn.disabled = true;
      dlNote.textContent = "Recorded audio isn't published yet. A built-in voice is used instead (it stops when the screen locks).";
    } else if (!offlineSupported()) {
      dlBtn.disabled = true;
      dlNote.textContent = "Offline downloads aren't supported in this browser.";
    }
    dlBtn.addEventListener("click", async () => {
      dlBtn.disabled = true;
      try {
        const r = await downloadClips(clipUrls, (done, total) => { dlBtn.replaceChildren(`Downloading ${done}/${total}…`); });
        dlBtn.replaceChildren(icon("check", 20), r.failed ? `Saved ${r.done - r.failed}/${r.total} clips` : "Saved for offline");
      } catch (e) {
        dlBtn.disabled = false;
        dlBtn.replaceChildren(icon("download", 20), "Download audio for offline");
        toast(e.message);
      }
    });

    const items = curriculum.itemsOfUnit(unit.id);
    const dialogues = curriculum.dialoguesOfUnit(unit.id);
    root.append(h("div", { class: "page" },
      h("a", { class: "back", href: "#/units" }, "‹ Units"),
      h("header", { class: "unit-head" },
        h("span", { class: "emoji", "aria-hidden": "true" }, unit.emoji || "📘"),
        h("div", null, h("h1", null, unit.title), h("p", { class: "muted" }, unit.description || ""))),
      h("section", { class: "card" }, h("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "10px" } },
        h("span", null, `${s.total - s.new} of ${s.total} items heard`), stars(s.stars)),
      statusBar(s, { legend: true })),
      h("div", { class: "btn-col" },
        h("a", { class: "btn primary", href: `#/quiz?unit=${unit.id}`, id: "practise-unit" }, "Practise this unit"),
        h("a", { class: "btn", href: `#/listen?unit=${unit.id}` }, "Listen to this unit"),
        dlBtn, dlNote,
        locked ? h("button", { type: "button", class: "btn ghost", id: "unlock-early", onclick: async () => {
          const ok = await confirmModal({ title: "Unlock this unit now?", body: "It normally opens once you know about 70% of the previous unit. You can start it early if you like.", confirmText: "Unlock" });
          if (ok) { setProgress(unlockUnit(store.progress, unit.id)); toast("Unit unlocked"); draw(); }
        } }, icon("lock", 18), "Unlock early") : null),
      GROUPS.map(([type, label]) => {
        const rows = items.filter((i) => i.type === type);
        return rows.length ? h("section", { class: "item-group" }, h("h2", null, label), h("ul", { class: "item-list" }, rows.map(itemRow))) : null;
      }),
      dialogues.length ? h("section", { class: "item-group" }, h("h2", null, "Conversations"), h("div", { class: "item-list" }, dialogues.map(dialogueBlock))) : null));
  };
  draw();
  return () => stop();
}
