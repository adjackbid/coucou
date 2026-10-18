// Agent Center's skill library (the Skill market in Settings), as Rust last
// listed it, shared by Agent Center, Agent Pool and the team setup; and the
// row of chips they all pick skills with.

import { Bridge, IS_TAURI } from "../core/bridge";
import { tr } from "../core/i18n";
import { h } from "../views/dom";
import type { LibrarySkill } from "./types";
import { openMemberSkillPicker } from "./skill-modal";

let library: LibrarySkill[] | null = null;
let asked = false;

/** The library, or null before the first look. */
export function skillLibrary(): LibrarySkill[] | null {
  return library;
}

/** Asks Rust for the library again; `then` runs when it answers. */
export function loadSkillLibrary(then: () => void) {
  asked = true;
  if (!IS_TAURI) {
    library = [];
    then();
    return;
  }
  void Bridge.teamSkillLibrary().then((got) => {
    library = got ?? [];
    then();
  });
}

/** The skills a member may be given: the library without Agent Center's own. Asks once if never listed. */
export function memberSkills(then: () => void): LibrarySkill[] | null {
  if (!library && !asked) loadSkillLibrary(then);
  return library ? library.filter((s) => !s.forCenter) : null;
}

/**
 * A member's skills as chips: only the ones it has, each a click takes out,
 * and ＋ opens the picker over the window (skill-modal.ts) to add from the
 * market. A name the market does not have (a path, or a skill since
 * removed) is a dashed chip. A link opens the market in Settings.
 */
export function skillChips(current: readonly string[], set: (next: string[]) => void, then: () => void, who = ""): HTMLElement {
  const lib = memberSkills(then);
  const inMarket = (name: string) => lib?.some((s) => s.name.toLowerCase() === name.toLowerCase());
  const chips: HTMLElement[] = current.map((c) =>
    h("button", {
      type: "button", class: `skill-chip on${inMarket(c) ? "" : " stray"}`, // i18n-ok: CSS class names
      title: inMarket(c)
        ? [...(lib ?? []).filter((s) => s.name.toLowerCase() === c.toLowerCase()).flatMap((s) => [[s.category, s.role].filter(Boolean).join(" · "), s.description, s.source, s.stars ? `★ ${s.stars}` : ""]), tr("按一下拿掉", "Click to take it out")].filter(Boolean).join("\n")
        : tr("不在市集裡(路徑或已移除的 skill);按一下拿掉", "Not in the market (a path, or a skill since removed); click to take it out"),
      onClick: () => {
        set(current.filter((x) => x !== c));
        then();
      },
    }, c));
  let latest = [...current];
  return h("div", { class: "skill-chips" },
    ...chips,
    h("button", {
      type: "button", class: "skill-chip add", title: tr("從市集挑 skill", "Pick skills from the market"), // i18n-ok: CSS class names
      onClick: () => openMemberSkillPicker(who, () => latest, (next) => { latest = next; set(next); }, then),
    }, current.length ? "＋" : tr("＋ 挑選 Skill", "＋ Pick skills")), // i18n-ok: symbol, not text
    lib === null ? h("span", { class: "hint", text: tr("讀取市集中…", "Loading the market…") }) : null,
    h("button", { type: "button", class: "link", onClick: () => void Bridge.openSettingsPage("skills") }, tr("管理 Skill 市集 →", "Manage the skill market →")));
}
