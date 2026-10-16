// General: the language, sound, starting with Windows, and about Coucou.

import { tr } from "../../core/i18n";
import type { Settings } from "../../core/state";
import { h } from "../../views/dom";
import type { Page } from "../nav";
import { chooseLanguage } from "../nav";
import { save, settings, version } from "../store";
import { card, field, pageHeader, row, toggle } from "../ui";
import { icon } from "../icons";

/**
 * Three buttons: 中文, English, follow Windows. Saving tells every window; a
 * choice that keeps the same language (Follow Windows on a Chinese Windows
 * after 中文) redraws only this.
 */
export function languagePicker(onData: (fn: () => void) => void): HTMLElement {
  const box = h("div", { class: "segmented", role: "radiogroup", "aria-label": tr("語言", "Language") });
  onData(() => {
    for (const b of box.querySelectorAll<HTMLButtonElement>("button")) {
      const on = b.dataset.value === settings.language;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  });
  const choices: [Settings["language"], string][] = [
    ["zh-TW", "中文"],
    ["en", "English"],
    ["system", tr("跟著 Windows", "Follow Windows")],
  ];
  for (const [value, label] of choices) {
    box.append(h("button", {
      type: "button",
      role: "radio",
      class: settings.language === value ? "on" : "",
      "data-value": value,
      "aria-checked": settings.language === value,
      text: label,
      onclick: () => void chooseLanguage(value),
    }));
  }
  return box;
}

/** 深色 / 淺色: the settings window and Teamwork change right away; the island stays dark. */
function themePicker(onData: (fn: () => void) => void): HTMLElement {
  const box = h("div", { class: "segmented", role: "radiogroup", "aria-label": tr("外觀", "Appearance") });
  const choices: [Settings["theme"], string][] = [
    ["dark", tr("深色", "Dark")],
    ["light", tr("淺色", "Light")],
  ];
  for (const [value, label] of choices) {
    box.append(h("button", {
      type: "button",
      role: "radio",
      "data-value": value,
      text: label,
      onclick: () => {
        settings.theme = value;
        void save();
      },
    }));
  }
  const mark = () => {
    for (const b of box.querySelectorAll<HTMLButtonElement>("button")) {
      const on = b.dataset.value === (settings.theme === "light" ? "light" : "dark");
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  onData(mark);
  mark();
  return box;
}

export const generalPage: Page = {
  id: "general",
  icon: "general",
  name: () => tr("一般", "General"),
  render(ctx) {
    const volume = h("input", { type: "range", min: "0", max: "0.2", step: "0.005", value: String(settings.soundVolume), "aria-label": tr("音量", "Volume") }) as HTMLInputElement;
    volume.addEventListener("input", () => {
      settings.soundVolume = Number(volume.value);
      void save();
    });
    return h(
      "div",
      { class: "page-body" },
      pageHeader("general", tr("一般", "General"), tr("語言、外觀、音效、開機啟動，以及關於 Agent Center。", "Language, appearance, sound, startup, and about Agent Center.")),
      card({
        anchor: "language",
        title: h("div", { class: "title-icon" }, icon("language", 20), h("h2", { text: tr("語言", "Language") })),
        body: [
          languagePicker(ctx.onData),
          h("p", { class: "field-help", text: tr("所有視窗會立刻換成這個語言。", "Every window changes right away.") }),
        ],
      }),
      card({
        anchor: "appearance",
        title: tr("外觀", "Appearance"),
        body: [
          themePicker(ctx.onData),
          h("p", { class: "field-help", text: tr("設定視窗和 Teamwork 會立刻換成這個外觀。瀏海島維持深色。", "The settings window and Teamwork change right away. The island stays dark.") }),
        ],
      }),
      card({
        anchor: "general",
        title: tr("音效與啟動", "Sound and startup"),
        body: [
          field(tr("音效", "Sound"), [toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }, tr("音效", "Sound")), volume]),
          field(tr("開機時啟動", "Launch at startup"), toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }, tr("開機時啟動", "Launch at startup"))),
        ],
      }),
      card({
        anchor: "guide",
        title: h("div", { class: "title-icon" }, icon("guide", 20), h("h2", { text: tr("開始設定引導", "Setup guide") })),
        lead: tr("一步一步帶你連結 agent、選聊天模型、設好瀏海島。", "Walks you through connecting your agents, picking a chat model and setting up the island."),
        body: [row(h("button", { type: "button", text: tr("重新開始引導", "Run the setup guide again"), onclick: () => ctx.openGuide() }))],
      }),
      card({
        anchor: "about",
        title: tr("關於", "About"),
        body: [
          h("p", {}, h("b", { text: "Agent Center" }), " ", h("span", { class: "hint", text: version })),
          h("p", { class: "hint", text: tr("沒有遙測。網路請求只會送到你自己設定的服務。", "No telemetry. Network requests only go to the services you set up yourself.") }),
        ],
      }),
    );
  },
};
