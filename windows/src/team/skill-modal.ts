// The skill picker over the whole window (Agent Center's ⚙ → Skills): the
// market as cards like a skills directory, a search box, select all / none
// for each column, and on every card who gets it. A change applies at once.

import { Bridge, IS_TAURI } from "../core/bridge";
import { tr, trf } from "../core/i18n";
import { h } from "../views/dom";
import { centerReads, loadSkillLibrary, membersGet, setCenterReads, setMembersGet, skillLibrary } from "./secretary";
import type { LibrarySkill } from "./types";
import { noCategory, orderCategories, skillGroups } from "./categories";

let open: { el: HTMLElement; redraw: () => void } | null = null;

/** One check on every card: what it means, who has it, and who may not. */
export interface SkillColumn {
  label: string;
  get: (s: LibrarySkill) => boolean;
  set: (s: LibrarySkill, on: boolean) => void;
  /** Why this card's check is greyed out, or nothing. */
  off?: (s: LibrarySkill) => string;
}

export interface SkillPicker {
  title: string;
  hint: string;
  columns: SkillColumn[];
  /** Which skills to list; the whole market when absent. */
  only?: (s: LibrarySkill) => boolean;
  /** The line at the foot, from the skills listed. */
  summary: (all: LibrarySkill[]) => string;
  /** After every change and on close, so the page behind follows. */
  onChange: () => void;
}

/** "owner/repo" of a GitHub URL; any other URL without its scheme. */
function repoName(url: string): string {
  const m = /github\.com\/([^/]+\/[^/#?]+)/i.exec(url);
  return m ? m[1].replace(/\.git$/, "") : url.replace(/^https?:\/\//i, "");
}

export function closeSkillModal() {
  open?.el.remove();
  open = null;
}

/** The library was listed again (the market changed): the open picker follows. */
export function redrawSkillModal() {
  open?.redraw();
}

/** Agent Center's picker (its ⚙ → Skills): who gets each skill. */
export function openSkillModal(onChange: () => void) {
  openSkillPicker({
    title: tr("挑選 Skill", "Pick skills"),
    hint: tr("「可派給成員」的,Agent Center 擬團隊時可以指定給組長或成員,成員開工時拿到全文;「Agent Center 讀」的接在它的系統提示後面,只影響它怎麼規劃。全選、全不選只作用在目前列出的。", "Members may get it: Agent Center can give it to the leader or a member when it proposes a team, and they get its text as they start. Agent Center reads it: it goes after its system prompt and only shapes its planning. All and None act on the cards listed now."),
    columns: [
      { label: tr("可派給成員", "Members may get it"), get: membersGet, set: setMembersGet, off: (s) => (s.forCenter ? tr("front matter 寫了 for: agent-center,是 Agent Center 自己的,不派給成員", "Its front matter says for: agent-center: Agent Center's own, never handed to a member") : "") },
      { label: tr("Agent Center 讀", "Agent Center reads it"), get: centerReads, set: setCenterReads },
    ],
    summary: (all) => trf("{m} 份可派給成員 · {c} 份 Agent Center 讀 · 共 {n} 份", "{m} members may get · {c} Agent Center reads · {n} in all", { m: all.filter(membersGet).length, c: all.filter(centerReads).length, n: all.length }),
    onChange,
  });
}

/**
 * A member's picker (team setup, Agent Pool): which market skills this one
 * gets. `current` is read each time, `set` gets the whole new list.
 */
export function openMemberSkillPicker(who: string, current: () => readonly string[], set: (next: string[]) => void, onChange: () => void) {
  const has = (s: LibrarySkill) => current().some((c) => c.toLowerCase() === s.name.toLowerCase());
  openSkillPicker({
    title: who ? trf("給「{who}」的 Skill", "Skills for “{who}”", { who }) : tr("挑選 Skill", "Pick skills"),
    hint: tr("勾起來的,這位成員開工時會拿到全文。只列市集裡可派給成員的;要新增或改內容到「管理 Skill 市集」。", "A ticked skill goes to this member in full as it starts. Only the market's member skills are listed; to add or change one, go to Manage the skill market."),
    columns: [{
      label: tr("給這位成員", "This member gets it"),
      get: has,
      set: (s, on) => set(on ? (has(s) ? [...current()] : [...current(), s.name]) : current().filter((c) => c.toLowerCase() !== s.name.toLowerCase())),
    }],
    only: (s) => !s.forCenter,
    summary: (all) => trf("已勾 {m} 份,市集有 {n} 份可派給成員", "{m} ticked of {n} member skills in the market", { m: all.filter(has).length, n: all.length }),
    onChange,
  });
}

/** The picker over the whole window, laid out by `p`. */
export function openSkillPicker(p: SkillPicker) {
  closeSkillModal();
  const onChange = p.onChange;
  let query = "";
  const el = h("div", { class: "sec-pick-overlay", role: "dialog", "aria-modal": "true", "aria-label": p.title });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    el.remove();
    document.removeEventListener("keydown", onKey);
    if (open?.el === el) open = null;
    onChange();
  };
  const grid = h("div", { class: "skill-grid" });
  const summary = h("span", { class: "hint skill-modal-summary" });
  /** The category the cards are narrowed to: null for all, "" for the ones with none. */
  let cat: string | null = null;
  const catRow = h("div", { class: "skill-modal-cats", role: "group", "aria-label": tr("依分類篩選", "Filter by category") });
  const changed = () => {
    cards();
    onChange();
  };
  /** The skills this picker is about that match the search. */
  const pool = (): LibrarySkill[] => {
    const q = query.trim().toLowerCase();
    return (skillLibrary() ?? []).filter((s) => (!p.only || p.only(s)) && (!q || [s.name, s.description, s.role, s.source, s.category].some((t) => t.toLowerCase().includes(q))));
  };
  /** The cards on screen: the pool, narrowed to the chosen category. */
  const shownNow = (): LibrarySkill[] => pool().filter((s) => cat === null || s.category.trim() === cat);
  const card = (s: LibrarySkill): HTMLElement =>
    h("div", { class: `skill-card${p.columns.some((c) => c.get(s)) ? " on" : ""}` },
      h("div", { class: "skill-card-top" },
        h("span", { class: "skill-card-repo", title: s.source || s.path, text: s.source ? repoName(s.source) : tr("本機", "Local") }),
        h("span", { class: `skill-card-cat${s.forCenter ? " center" : ""}`, text: s.forCenter ? tr("Agent Center", "Agent Center") : s.category.trim() || noCategory() }), // i18n-ok: the same in both
        s.stars ? h("span", { class: "skill-card-stars", title: s.starsAt ? trf("GitHub 星數,{date}", "GitHub stars, {date}", { date: s.starsAt }) : tr("GitHub 星數", "GitHub stars"), text: `★ ${s.stars}` }) : null,
        s.source ? h("button", { type: "button", class: "skill-card-open", title: s.source, "aria-label": tr("在 GitHub 打開", "Open on GitHub"), onClick: () => void Bridge.openUrl(s.source) }, "→") : null),
      h("div", { class: "skill-card-name" }, h("b", { text: s.name }), s.role ? h("span", { class: "skill-card-role", text: s.role }) : null),
      h("p", { class: "skill-card-desc", title: s.description || s.path, text: s.description || tr("(沒有說明)", "(No description)") }),
      h("div", { class: "skill-card-checks" },
        ...p.columns.map((c) => {
          const why = c.off?.(s) ?? "";
          return h("label", { class: "side-pop-check", title: why },
            h("input", { type: "checkbox", checked: c.get(s), disabled: !!why, onChange: (e: Event) => { c.set(s, (e.target as HTMLInputElement).checked); changed(); } }),
            h("span", { text: c.label }));
        })));
  const cards = () => {
    const lib = skillLibrary();
    const shown = shownNow();
    grid.replaceChildren(
      ...(lib === null
        ? [h("p", { class: "hint", text: tr("讀取中…", "Loading…") })]
        : !lib.length
          ? [h("p", { class: "hint", text: tr("市集還是空的:到「管理 Skill 市集」寫一份,或把其他地方的加進來。", "The market is empty: write one under Manage the skill market, or bring one in from elsewhere.") })]
          : !shown.length
            ? [h("p", { class: "hint", text: tr("沒有符合的 skill。", "No skill matches.") })]
            : skillGroups(shown).flatMap((g) => [
                h("h3", { class: "skill-group-head", text: trf("{title}({n})", "{title} ({n})", { title: g.title, n: g.items.length }) }),
                ...g.items.map(card),
              ])));
    // The chips: every category in the pool, with how many; the chosen one lit.
    const all = pool();
    const chip = (label: string, value: string | null, n: number) =>
      h("button", { type: "button", class: `skill-cat-chip${cat === value ? " on" : ""}`, "aria-pressed": String(cat === value), onClick: () => { cat = cat === value ? null : value; cards(); } }, `${label} ${n}`);
    const members = all.filter((s) => !s.forCenter);
    const none = members.filter((s) => !s.category.trim()).length;
    catRow.replaceChildren(
      chip(tr("全部", "All"), null, all.length),
      ...orderCategories(members.map((s) => s.category)).map((c) => chip(c, c, members.filter((s) => s.category.trim() === c).length)),
      ...(none ? [chip(noCategory(), "", none)] : []),
    );
    summary.textContent = p.summary((lib ?? []).filter((s) => !p.only || p.only(s)));
  };
  const allOf = (c: SkillColumn, on: boolean) => {
    for (const s of shownNow()) if (!c.off?.(s)) c.set(s, on);
    changed();
  };
  const search = h("input", {
    type: "search", class: "skill-modal-search", value: query, spellcheck: "false",
    placeholder: tr("搜尋名稱、說明、角色或來源…", "Search by name, description, role or source…"),
    "aria-label": tr("搜尋 skill", "Search skills"),
    onInput: (e: Event) => { query = (e.target as HTMLInputElement).value; cards(); },
  });
  const column = (c: SkillColumn) =>
    h("div", { class: "skill-modal-col" },
      h("span", { class: "hint", text: p.columns.length > 1 ? `${c.label}:` : "" }),
      h("button", { type: "button", class: "link", onClick: () => allOf(c, true) }, tr("全選", "All")),
      h("button", { type: "button", class: "link", onClick: () => allOf(c, false) }, tr("全不選", "None")));
  el.replaceChildren(
    h("div", { class: "sec-pick-modal skill-modal" },
      h("div", { class: "sec-pick-modal-head" },
        h("div", {}, h("h2", { text: p.title }), h("p", { class: "hint", text: p.hint })),
        h("button", { type: "button", class: "sec-pick-close", "aria-label": tr("關閉", "Close"), onClick: close }, "✕")),
      h("div", { class: "skill-modal-tools" },
        search,
        ...p.columns.map(column)),
      catRow,
      h("div", { class: "skill-modal-body" }, grid),
      h("div", { class: "sec-pick-modal-foot" },
        summary,
        h("span", { style: "flex:1" }),
        h("button", { class: "btn plain", type: "button", onClick: () => void Bridge.openSettingsPage("skills") }, tr("管理 Skill 市集", "Manage the skill market")),
        IS_TAURI ? h("button", { class: "btn plain", type: "button", onClick: () => void Bridge.teamOpenSkills() }, tr("開啟資料夾", "Open the folder")) : null,
        h("button", { class: "btn plain", type: "button", onClick: () => loadSkillLibrary(() => { cards(); onChange(); }) }, tr("重新整理", "Refresh")),
        h("button", { class: "btn primary", type: "button", onClick: close }, tr("完成", "Done")))));
  el.addEventListener("click", (e) => { if (e.target === el) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(el);
  open = { el, redraw: cards };
  cards();
  if (skillLibrary() === null) loadSkillLibrary(() => { cards(); onChange(); });
  search.focus();
}
