// Island: where it lives, when it hides, the shortcut that opens it.

import { Bridge } from "../../core/bridge";
import { tr } from "../../core/i18n";
import type { Settings } from "../../core/state";
import { h, clear } from "../../views/dom";
import type { Page } from "../nav";
import { hotkeyError, refreshHotkey, save, settings } from "../store";
import { card, disclosure, field, group, notice, pageHeader, toggle } from "../ui";

function seconds(value: number, min: number, max: number, fallback: number, onChange: (v: number) => void): HTMLInputElement {
  const input = h("input", { type: "number", min: String(min), max: String(max), step: "1", value: String(Math.round(value || fallback)), class: "num" }) as HTMLInputElement;
  input.addEventListener("change", () => {
    const v = Math.max(min, Math.min(max, Number(input.value) || fallback));
    input.value = String(v);
    onChange(v);
  });
  return input;
}

/** "Main display" and the like, for the overview too. */
export function displayName(screen: Settings["screen"]): string {
  return screen === "cursor" ? tr("游標所在的螢幕", "Display under the cursor")
    : screen === "docked" ? tr("我拖過去的位置", "Where I put it")
    : tr("主螢幕", "Main display");
}

export const islandPage: Page = {
  id: "island",
  icon: "island",
  name: () => tr("瀏海島", "Island"),
  render(ctx) {
    // ── Position ──
    const screen = h("select", {}) as HTMLSelectElement;
    // "Where I put it" exists once the island has been dragged onto a display.
    const fillScreens = () => {
      screen.replaceChildren(
        h("option", { value: "primary", text: displayName("primary") }),
        h("option", { value: "cursor", text: displayName("cursor") }),
      );
      if (settings.dock?.monitor) screen.append(h("option", { value: "docked", text: displayName("docked") }));
      screen.value = settings.screen;
    };
    fillScreens();
    screen.addEventListener("change", () => {
      settings.screen = screen.value as Settings["screen"];
      // Rust forgets the dragged-to display once another choice is made.
      if (settings.screen !== "docked") settings.dock = { ...settings.dock, monitor: "" };
      void save().then(fillScreens);
    });
    // A drag while this window is open changes where the island lives.
    ctx.onData(() => {
      if (settings.screen !== screen.value || !!settings.dock?.monitor !== !!screen.querySelector('[value="docked"]')) fillScreens();
    });
    const reset = h("button", { type: "button", text: tr("回到預設位置", "Reset position"), onclick: () => void Bridge.resetDock() });

    // ── When it hides ──
    const autoClose = seconds(settings.autoCloseInterval, 3, 120, 15, (v) => { settings.autoCloseInterval = v; void save(); });
    const hideAfter = seconds(settings.hideAfter || 60, 3, 600, 60, (v) => { settings.hideAfter = v; void save(); });
    const hideRow = field(tr("然後隱藏", "Then hide after"), [hideAfter, h("span", { class: "unit", text: tr("秒", "s") })], tr("小橫條在滑鼠離開後還會留這麼久。", "How long the small bar stays once the mouse leaves."));
    const syncAlways = () => {
      hideAfter.disabled = settings.alwaysVisible;
      hideRow.classList.toggle("dimmed", settings.alwaysVisible);
      hideRow.title = settings.alwaysVisible ? tr("「永遠顯示」打開時不會用到", "Not used while Always visible is on") : "";
    };
    syncAlways();

    // ── Shortcut ── Written as the global-shortcut plugin reads it: modifiers
    // and a key joined by "+", e.g. Ctrl+Shift+Space. Empty turns it off.
    const hotkey = h("input", { type: "text", value: settings.hotkey, placeholder: "Ctrl+Shift+Space", spellcheck: "false" }) as HTMLInputElement;
    const hotkeyNote = h("div", {});
    // A key another program already owns registers nothing and says nothing
    // on its own; this is where it gets said.
    const drawHotkey = () => {
      clear(hotkeyNote);
      if (hotkeyError) hotkeyNote.append(notice("warn", hotkeyError));
    };
    drawHotkey();
    ctx.onData(drawHotkey);
    hotkey.addEventListener("change", async () => {
      settings.hotkey = hotkey.value.trim();
      await save();
      await refreshHotkey();
    });

    // ── Advanced ──
    const cards = h("input", { type: "number", min: "1", max: "3", step: "1", value: String(settings.maxSessionCards || 2), class: "num" }) as HTMLInputElement;
    cards.addEventListener("change", () => {
      settings.maxSessionCards = Math.max(1, Math.min(3, Number(cards.value) || 2));
      cards.value = String(settings.maxSessionCards);
      void save();
    });

    return h(
      "div",
      { class: "page-body" },
      pageHeader(
        "island",
        tr("瀏海島", "Island"),
        tr("瀏海島放在哪、什麼時候收起來，以及打開它的快捷鍵。", "Where the island sits, when it hides, and the shortcut that opens it."),
      ),
      card({
        anchor: "position",
        title: tr("位置", "Position"),
        body: [
          field(tr("螢幕", "Display"), screen, tr("也可以直接把瀏海島拖到螢幕的任何一邊。", "Or drag the island to any edge of the screen.")),
          field(tr("重設", "Reset"), reset, tr("回到螢幕上方正中央。", "Back to the top centre.")),
        ],
      }),
      card({
        anchor: "hiding",
        title: tr("什麼時候收起來", "When it hides"),
        body: [
          field(tr("收合", "Close after"), [autoClose, h("span", { class: "unit", text: tr("秒", "s") })], tr("滑鼠離開展開的瀏海島之後。", "After the mouse leaves the open island.")),
          hideRow,
          field(tr("永遠顯示", "Always visible"), toggle(settings.alwaysVisible, (v) => { settings.alwaysVisible = v; void save(); syncAlways(); }, tr("永遠顯示", "Always visible")),
            tr("瀏海島永遠不隱藏；關掉它時會留下小橫條。", "The island never hides; closing it leaves the small bar.")),
        ],
      }),
      card({
        anchor: "hotkey",
        title: tr("快捷鍵", "Shortcut"),
        body: [
          field(tr("打開／關閉", "Open / close"), hotkey, tr("在任何地方按下都能打開或關閉瀏海島。留空就關掉。", "Opens and closes the island from anywhere. Leave it empty to turn it off.")),
          hotkeyNote,
        ],
      }),
      disclosure(tr("進階", "Advanced"), () => group(
        tr("工作階段卡片", "Session cards"),
        field(tr("並排顯示", "Side by side"), cards, tr("並排顯示的工作階段數（1–3），其餘的變成膠囊。", "Sessions shown side by side (1–3); the rest become pills.")),
      ), false, "advanced page-fold"),
    );
  },
};
