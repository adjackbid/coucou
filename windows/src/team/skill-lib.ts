// Agent Center's skill library (the Skill market in Settings), as Rust last
// listed it, shared by Agent Center, Agent Pool and the team setup; and the
// row of chips they all pick skills with.

import { Bridge, IS_TAURI } from "../core/bridge";
import { tr } from "../core/i18n";
import { h } from "../views/dom";
import type { LibrarySkill } from "./types";

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
 * The market's member skills as chips, lit when in `current`; a click puts
 * one in or takes it out. A name in `current` the market does not have
 * (a path, or a skill since removed) is a dashed chip a click takes out.
 * A link opens the market in Settings.
 */
export function skillChips(current: readonly string[], set: (next: string[]) => void, then: () => void): HTMLElement {
  const lib = memberSkills(then);
  const has = (name: string) => current.some((c) => c.toLowerCase() === name.toLowerCase());
  const chips: HTMLElement[] = [];
  for (const s of lib ?? []) {
    const on = has(s.name);
    chips.push(h("button", {
      type: "button", class: `skill-chip${on ? " on" : ""}`, "aria-pressed": String(on), title: [s.role, s.description, s.source, s.stars ? `★ ${s.stars}` : ""].filter(Boolean).join("\n") || s.path,
      onClick: () => {
        set(on ? current.filter((c) => c.toLowerCase() !== s.name.toLowerCase()) : [...current, s.name]);
        then();
      },
    }, s.name));
  }
  for (const c of current) {
    if (lib?.some((s) => s.name.toLowerCase() === c.toLowerCase())) continue;
    chips.push(h("button", {
      type: "button", class: "skill-chip on stray", title: tr("不在市集裡(路徑或已移除的 skill);按一下拿掉", "Not in the market (a path, or a skill since removed); click to take it out"), // i18n-ok: CSS class names
      onClick: () => {
        set(current.filter((x) => x !== c));
        then();
      },
    }, c));
  }
  return h("div", { class: "skill-chips" },
    ...chips,
    lib === null ? h("span", { class: "hint", text: tr("讀取市集中…", "Loading the market…") }) : null,
    lib && !lib.length && !chips.length ? h("span", { class: "hint", text: tr("市集裡還沒有給成員的 skill。", "No member skills in the market yet.") }) : null,
    h("button", { type: "button", class: "link", onClick: () => void Bridge.openSettingsPage("skills") }, tr("管理 Skill 市集 →", "Manage the skill market →")));
}
