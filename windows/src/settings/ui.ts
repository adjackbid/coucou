// The pieces every settings page is built from, so the pages look alike: a
// page header, cards with a status badge and one next step, folded details,
// labelled fields.

import { h } from "../views/dom";
import { tr } from "../core/i18n";
import type { Badge } from "./status";

export function toggle(on: boolean, onChange: (v: boolean) => void, label?: string): HTMLButtonElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on, "aria-label": label, type: "button" });
  el.addEventListener("click", () => {
    if (el.disabled) return;
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-pressed", String(next));
    onChange(next);
  });
  return el;
}

export function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

export function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

/** The words on a badge, by state; `custom` overrides them. */
export function badge(state: Badge, custom?: string): HTMLElement {
  const words: Record<Badge, string> = {
    ok: tr("已設定", "Set"),
    todo: tr("未設定", "Not set"),
    update: tr("需要更新", "Needs update"),
    missing: tr("未安裝", "Not installed"),
    off: tr("關閉", "Off"),
    checking: tr("檢查中…", "Checking…"),
  };
  return h("span", { class: `badge ${state}` }, h("i", {}), h("span", { text: custom ?? words[state] }));
}

/**
 * Page header: the title, one plain sentence of what the page is for, and a
 * "What is this?" fold. The fold starts open the first time a page is seen.
 */
export function pageHeader(id: string, title: string, subtitle: string, what?: () => Node | string): HTMLElement {
  const head = h("header", { class: "page-head" }, h("h1", { text: title }), h("p", { class: "subtitle", text: subtitle }));
  if (what) head.append(disclosure(tr("這是什麼？", "What is this?"), what, firstVisit(id), "what"));
  return head;
}

const SEEN_KEY = "coucou.settings.seen";

/** True the first time this page is opened (then remembered). */
function firstVisit(id: string): boolean {
  try {
    const seen: string[] = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    if (seen.includes(id)) return false;
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, id]));
    return true;
  } catch {
    return false;
  }
}

/** A fold: a native <details>, so it opens from the keyboard too. Content is built when first opened. */
export function disclosure(label: string, content: () => Node | string, open = false, kind = ""): HTMLDetailsElement {
  const el = h("details", { class: `fold ${kind}`.trim() }) as HTMLDetailsElement;
  const body = h("div", { class: "fold-body" });
  el.append(h("summary", { text: label }), body);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    const c = content();
    if (typeof c === "string") body.append(h("p", { class: "hint", text: c }));
    else body.append(c);
  };
  el.addEventListener("toggle", () => el.open && build());
  if (open) {
    el.open = true;
    build();
  }
  return el;
}

export interface CardParts {
  /** `data-anchor`, for links from the overview and other windows. */
  anchor: string;
  title: string | Node;
  /** Short text beside the title (e.g. "Copilot CLI · glm-5.3-flash"). */
  meta?: string;
  badge?: HTMLElement | null;
  /** One or two plain sentences: what this is, what connecting it does. */
  lead?: string | Node | null;
  /** The body: controls, the next step. */
  body?: (Node | null | false)[];
  /** Folded at the bottom: paths, ids, secondary buttons. */
  details?: (() => Node) | null;
  /** Folded too: the settings most people never touch. */
  advanced?: (() => Node) | null;
  advancedOpen?: boolean;
}

export function card(p: CardParts): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    typeof p.title === "string" ? h("h2", { text: p.title }) : p.title,
    p.meta ? h("span", { class: "card-meta", text: p.meta }) : null,
    h("span", { class: "grow" }),
    p.badge ?? null,
  );
  const el = h("section", { class: "card", "data-anchor": p.anchor }, head);
  if (p.lead) el.append(typeof p.lead === "string" ? h("p", { class: "lead", text: p.lead }) : p.lead);
  for (const b of p.body ?? []) if (b) el.append(b);
  if (p.advanced) el.append(disclosure(tr("進階", "Advanced"), p.advanced, p.advancedOpen ?? false, "advanced"));
  if (p.details) el.append(disclosure(tr("詳細資訊", "Details"), p.details, false, "details"));
  return el;
}

/** One labelled row; help goes on the line below, never beside the control. */
export function field(label: string, control: Node | (Node | null)[], help?: string | Node | null): HTMLElement {
  const controls = Array.isArray(control) ? control : [control];
  return h(
    "div",
    { class: "field" },
    h("label", { text: label }),
    h("div", { class: "field-controls" }, ...controls),
    help ? h("div", { class: "field-help" }, help) : null,
  );
}

/** A group of fields under a small heading. */
export function group(title: string, ...children: (Node | null)[]): HTMLElement {
  return h("div", { class: "group" }, h("h3", { text: title }), ...children);
}

export function row(...children: (Node | string | null | false)[]): HTMLElement {
  return h("div", { class: "row" }, ...children);
}

export function notice(kind: "ok" | "warn" | "err", text: string): HTMLElement {
  return h("div", { class: `notice ${kind}`, role: kind === "err" ? "alert" : "status", text });
}

/** An error as a person reads it: without the "Error:" a thrown string starts with. */
export function errText(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, "");
}

/** A short highlight on the card a link pointed at. */
export function flash(el: Element) {
  el.classList.remove("flash");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 1400);
}
