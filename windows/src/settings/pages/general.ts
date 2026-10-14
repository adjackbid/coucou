// Sound, the island's behaviour and where it lives, the shortcut, startup.

import { Bridge, onEvent } from "../../core/bridge";
import type { Settings } from "../../core/state";
import { h, clear } from "../../views/dom";
import { settings, save, replaceSettings } from "../store";
import { toggle } from "../ui";

export function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "3", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(3, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  // The second countdown: how long the small bar lingers before vanishing.
  const hideAfter = h("input", {
    type: "number", min: "3", max: "600", step: "1",
    value: String(Math.round(settings.hideAfter || 60)),
    style: "width:72px",
  }) as HTMLInputElement;
  hideAfter.addEventListener("change", () => {
    settings.hideAfter = Math.max(3, Math.min(600, Number(hideAfter.value) || 60));
    hideAfter.value = String(settings.hideAfter);
    void save();
  });

  // How many finished sessions may sit side by side as cards before the rest
  // go to the pills; the island widens by one card each.
  const cards = h("input", {
    type: "number", min: "1", max: "3", step: "1",
    value: String(settings.maxSessionCards || 2),
    style: "width:72px",
  }) as HTMLInputElement;
  cards.addEventListener("change", () => {
    settings.maxSessionCards = Math.max(1, Math.min(3, Number(cards.value) || 2));
    cards.value = String(settings.maxSessionCards);
    void save();
  });

  // Written as the global-shortcut plugin reads it: modifiers and a key joined
  // by "+", e.g. Ctrl+Shift+Space, Ctrl+Alt+F12. Empty turns it off.
  const hotkey = h("input", {
    type: "text",
    value: settings.hotkey,
    placeholder: "Ctrl+Shift+Space",
    spellcheck: "false",
    style: "width:180px",
  }) as HTMLInputElement;
  const hotkeyNote = h("div", {});
  // A key another program already owns registers nothing and says nothing on
  // its own; this is where it gets said.
  async function checkHotkey() {
    const error = await Bridge.hotkeyStatus();
    clear(hotkeyNote);
    if (error) hotkeyNote.append(h("div", { class: "notice warn", text: error }));
  }
  hotkey.addEventListener("change", async () => {
    settings.hotkey = hotkey.value.trim();
    await save();
    await checkHotkey();
  });
  void checkHotkey();

  const screen = h("select", {}) as HTMLSelectElement;
  // "Where I put it" exists once the island has been dragged onto a display.
  function fillScreens() {
    screen.replaceChildren(
      h("option", { value: "primary", text: "Main display" }),
      h("option", { value: "cursor", text: "Display under the cursor" }),
    );
    if (settings.dock?.monitor) screen.append(h("option", { value: "docked", text: "Where I put it" }));
    screen.value = settings.screen;
  }
  fillScreens();
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    // Rust forgets the dragged-to display once another choice is made.
    if (settings.screen !== "docked") settings.dock = { ...settings.dock, monitor: "" };
    void save().then(fillScreens);
  });
  // A drag while this window is open changes where the island lives.
  void onEvent<Settings>("settings-changed", (s) => {
    if (s.screen !== screen.value || !!s.dock?.monitor !== !!screen.querySelector('[value="docked"]')) {
      replaceSettings({ ...settings, screen: s.screen, dock: s.dock });
      fillScreens();
    }
  });
  const resetPosition = h("button", {
    text: "Reset position",
    title: "Back to the top centre of the screen",
    onclick: () => void Bridge.resetDock(),
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Position" }),
      resetPosition,
      h("span", { class: "hint", text: "drag the island to move it to any edge of the screen" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Hide after" }),
      hideAfter,
      h("span", { class: "hint", text: "seconds the small bar stays once the mouse leaves" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Always visible" }),
      toggle(settings.alwaysVisible, (v) => { settings.alwaysVisible = v; void save(); }),
      h("span", { class: "hint", text: "the island never hides; closing it leaves the small bar" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Session cards" }),
      cards,
      h("span", { class: "hint", text: "sessions shown side by side (1–3); the rest become pills" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Shortcut" }),
      hotkey,
      h("span", { class: "hint", text: "opens and closes the island from anywhere" }),
    ),
    hotkeyNote,
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}
