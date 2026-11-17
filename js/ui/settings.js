/**
 * settings.js — Settings screen (#/settings).
 *
 * Purpose
 *   Let the learner choose how pinyin is shown, lesson length, daily goal,
 *   sound effects and auto-advance, and back up / restore / reset progress.
 *
 * How it fits
 *   Registered by main.js. Reads and writes settings through ui/store.js
 *   (updateSettings, setProgress). Uses state/storage.js (exportProgress,
 *   importProgress) and state/progress.js (defaultProgress, checkUnlocks,
 *   dayKey).
 *
 * Key concepts
 *   - Settings live inside the progress blob, so a backup carries them too.
 *   - Destructive actions use the in-page confirmModal: import asks once
 *     (it overwrites), reset asks twice.
 *   - Reset keeps the settings, so the learner's preferences survive.
 *
 * Public API
 *   render(root) -> void
 */

import { h, clear, segmented, confirmModal, toast } from "./dom.js";
import { store, updateSettings, getSetting, setProgress, APP_VERSION } from "./store.js";
import { exportProgress, importProgress } from "../state/storage.js";
import { defaultProgress, checkUnlocks, dayKey } from "../state/progress.js";

// ===== Section: Helpers =====

/** Download text as a file via a temporary object URL. */
function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: filename, style: { display: "none" } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A labelled on/off row. */
function toggleRow(id, label, desc, checked, onChange) {
  return h("div", { class: "card setting" },
    h("label", { class: "switch-row", for: id }, h("span", null, h("b", null, label), h("div", { class: "desc" }, desc)),
      h("input", { type: "checkbox", class: "switch", id, checked: checked || null, role: "switch", onchange: (e) => onChange(e.target.checked) })));
}

// ===== Section: Screen =====

/**
 * Render the settings screen.
 * @param {HTMLElement} root
 */
export function render(root) {
  const s = store.progress.settings;
  const redraw = () => { clear(root); render(root); };

  const fileInput = h("input", { type: "file", accept: "application/json,.json", id: "import-file", style: { display: "none" },
    onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      let imported;
      try { imported = importProgress(await file.text()); }
      catch (err) { toast(err.message, 5000); return; }
      const ok = await confirmModal({ title: "Replace your progress?", body: "This overwrites everything on this phone with the backup file.", confirmText: "Replace", danger: true });
      if (!ok) return;
      setProgress(checkUnlocks(imported, store.curriculum).progress);
      toast("Backup restored");
      redraw();
    } });

  root.append(h("div", { class: "page" },
    h("h1", { class: "page-title" }, "Settings"),

    h("div", { class: "card setting" }, h("b", null, "Pinyin"),
      segmented([{ value: "always", label: "Always" }, { value: "after", label: "After answering" }, { value: "never", label: "Never" }],
        s.pinyin, (v) => updateSettings({ pinyin: v }), "Show pinyin"),
      h("p", { class: "desc" }, "Always shows it while you listen. After answering hides it until you've chosen.")),

    h("div", { class: "card setting" }, h("b", null, "Lesson length"),
      segmented([{ value: "short", label: "Short 10" }, { value: "normal", label: "Normal 20" }, { value: "long", label: "Long 30" }],
        s.sessionLength, (v) => updateSettings({ sessionLength: v }), "Lesson length"),
      h("p", { class: "desc" }, "Number of questions per lesson.")),

    h("div", { class: "card setting" }, h("b", null, "Daily goal"),
      segmented([30, 60, 100, 150].map((n) => ({ value: n, label: `${n} XP` })), s.dailyGoalXp, (v) => updateSettings({ dailyGoalXp: Number(v) }), "Daily goal"),
      h("p", { class: "desc" }, "Reach it each day to grow your streak.")),

    toggleRow("sfx-toggle", "Sound effects", "Soft tones for right and wrong answers.", s.sfx !== false, (v) => updateSettings({ sfx: v })),
    toggleRow("auto-toggle", "Auto-advance", "Move on by itself after a correct answer.", getSetting("autoAdvance") !== false, (v) => updateSettings({ autoAdvance: v })),

    h("div", { class: "card setting" }, h("b", null, "Your data"),
      h("p", { class: "desc" }, "Progress is stored only on this phone. Export a backup now and then."),
      h("button", { type: "button", class: "btn block", id: "export-progress",
        onclick: () => { downloadText(`ting-progress-${dayKey(Date.now())}.json`, exportProgress(store.progress)); toast("Backup downloaded"); } }, "Export progress"),
      h("button", { type: "button", class: "btn block", id: "import-progress", onclick: () => fileInput.click() }, "Import progress"),
      fileInput,
      h("button", { type: "button", class: "btn danger block", id: "reset-progress", onclick: async () => {
        const first = await confirmModal({ title: "Reset all progress?", body: "Your words, XP, streak and history will be erased.", confirmText: "Continue", danger: true });
        if (!first) return;
        const second = await confirmModal({ title: "Really erase everything?", body: "This cannot be undone. Export a backup first if you might want it back.", confirmText: "Erase all", danger: true });
        if (!second) return;
        setProgress({ ...defaultProgress(Date.now()), settings: { ...store.progress.settings } });
        toast("Progress reset");
        redraw();
      } }, "Reset progress")),

    h("p", { class: "about" }, `听 Tīng · version ${APP_VERSION}`)));
}
