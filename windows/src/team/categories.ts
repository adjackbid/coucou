// The categories agents (Agent Pool) and skills (the Skill market) are
// grouped by: a few offered ones, and whatever else the person writes.

import { tr } from "../core/i18n";
import type { LibrarySkill } from "./types";

/** The categories offered before any is typed; the person may write any other. */
export function offeredCategories(): string[] {
  return [
    tr("專案管理", "Project management"),
    tr("規劃審查", "Planning & review"),
    tr("程式開發", "Coding"),
    tr("UI/UX 設計", "UI/UX design"),
    tr("文案製作", "Copywriting"),
    tr("文件簡報", "Documents & slides"),
    tr("研究分析", "Research"),
    tr("圖片影音", "Images & video"),
    tr("工具自動化", "Tools & automation"),
  ];
}

/** The categories in `used`, offered ones first in their order, then the rest by name. */
export function orderCategories(used: Iterable<string>): string[] {
  const set = new Set([...used].map((c) => c.trim()).filter(Boolean));
  const offered = offeredCategories().filter((c) => set.has(c));
  return [...offered, ...[...set].filter((c) => !offered.includes(c)).sort((a, b) => a.localeCompare(b))];
}

/** What a category with no name is called. */
export function noCategory(): string {
  return tr("未分類", "Uncategorized");
}

/**
 * Skills in groups: Agent Center's own first (its planning know-how, never
 * handed to a member), then the members' skills by category, the ones with
 * none last.
 */
export function skillGroups(list: readonly LibrarySkill[]): { title: string; key: string; items: LibrarySkill[] }[] {
  const out: { title: string; key: string; items: LibrarySkill[] }[] = [];
  const center = list.filter((s) => s.forCenter);
  if (center.length) out.push({ title: tr("Agent Center 自己讀(規劃用)", "Agent Center's own (planning)"), key: "center", items: center });
  const rest = list.filter((s) => !s.forCenter);
  for (const c of orderCategories(rest.map((s) => s.category))) out.push({ title: c, key: c, items: rest.filter((s) => s.category.trim() === c) });
  const none = rest.filter((s) => !s.category.trim());
  if (none.length) out.push({ title: noCategory(), key: "", items: none });
  return out;
}
