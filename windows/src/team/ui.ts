// The Teamwork window's own pickers, in its glass: a dropdown for choosing
// one of a few things (who an instruction goes to, which agent a member
// runs), and suggestions under a text field (the models an agent offers).
// Windows draws a native <select> and <datalist> as a white system list;
// these are drawn by the page, like everything else in the window.
//
// One menu is open at a time. While it is open the page is not drawn again
// (see `menuOpen`), so the field it hangs from stays where it is.

import "./ui.css";
import { h } from "../views/dom";

export interface Choice {
  value: string;
  label: string;
  /** A second, dimmer line: what the choice is. */
  hint?: string;
}

interface Open {
  menu: HTMLElement;
  anchor: HTMLElement;
  close: () => void;
}

let open: Open | null = null;
let closed: (() => void) | null = null;

/** Whether a menu is open: drawing the page again would pull it from under the pointer. */
export const menuOpen = () => open !== null && open.anchor.isConnected;

/** Called once the open menu has closed — to draw what waited for it. */
export function onMenuClosed(fn: () => void) {
  closed = fn;
}

export function closeMenu() {
  if (!open) return;
  const was = open;
  open = null;
  was.close();
  closed?.();
}

const CHEVRON =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

/**
 * A list of choices under (or above, near the bottom of the window) an
 * element. `keepFocus`: the anchor is a text field still being typed in.
 */
function popover(anchor: HTMLElement, choices: Choice[], current: string, pick: (value: string) => void, keepFocus = false, empty = "") {
  closeMenu();
  const menu = h("div", { class: "menu", role: "listbox" });
  let active = Math.max(0, choices.findIndex((c) => c.value === current));
  const items: HTMLElement[] = [];
  const choose = (i: number) => {
    const c = choices[i];
    closeMenu();
    if (c) pick(c.value);
  };
  const mark = () => items.forEach((el, i) => el.classList.toggle("active", i === active));
  choices.forEach((c, i) => {
    const el = h(
      "button",
      { type: "button", class: `menu-item${c.value === current ? " on" : ""}`, role: "option", tabindex: "-1" },
      h("span", { class: "menu-label", text: c.label }),
      c.hint ? h("span", { class: "menu-hint", text: c.hint }) : null,
    );
    // Picking must not take the focus from a field being typed in.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => choose(i));
    el.addEventListener("mouseenter", () => {
      active = i;
      mark();
    });
    items.push(el);
    menu.append(el);
  });
  if (!choices.length) menu.append(h("div", { class: "menu-empty", text: empty || "沒有可選的項目" }));
  mark();
  document.body.append(menu);

  // Below the anchor, or above it when the window ends first.
  const r = anchor.getBoundingClientRect();
  menu.style.minWidth = `${Math.round(r.width)}px`;
  const height = menu.offsetHeight;
  const below = window.innerHeight - r.bottom - 8;
  const top = below >= Math.min(height, 240) || below >= r.top ? r.bottom + 6 : r.top - 6 - Math.min(height, r.top - 12);
  menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxHeight = `${Math.round(Math.max(120, top > r.top ? below : r.top - 12))}px`;
  items[active]?.scrollIntoView({ block: "nearest" });

  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % Math.max(1, choices.length);
      mark();
      items[active]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && choices.length) {
      e.preventDefault();
      e.stopPropagation();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    } else if (e.key === "Tab") {
      closeMenu();
    }
  };
  const outside = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !anchor.contains(t)) closeMenu();
  };
  const away = () => closeMenu();
  document.addEventListener("keydown", key, true);
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("resize", away);
  window.addEventListener("blur", away);
  anchor.closest(".scroll")?.addEventListener("scroll", away, { once: true });
  anchor.classList.add("menu-open");
  if (!keepFocus) menu.focus();

  open = {
    menu,
    anchor,
    close: () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("mousedown", outside, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
      anchor.classList.remove("menu-open");
      menu.remove();
    },
  };
}

/** A button that opens a list of choices: the window's own <select>. */
export function dropdown(opts: { value: string; choices: Choice[]; onChange: (value: string) => void; title?: string; className?: string; placeholder?: string }): HTMLButtonElement {
  const label = h("span", { class: "dropdown-label" });
  const current = opts.choices.find((c) => c.value === opts.value);
  label.textContent = current?.label ?? opts.placeholder ?? "選擇…";
  if (!current) label.classList.add("placeholder");
  const button = h(
    "button",
    { type: "button", class: `field dropdown ${opts.className ?? ""}`, title: opts.title ?? "", "aria-haspopup": "listbox" },
    label,
    h("span", { class: "dropdown-chevron", html: CHEVRON }),
  ) as HTMLButtonElement;
  const show = () => {
    if (open?.anchor === button) return closeMenu();
    popover(button, opts.choices, opts.value, (v) => {
      if (v !== opts.value) opts.onChange(v);
    });
  };
  button.addEventListener("click", show);
  button.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === " ") && !open) {
      e.preventDefault();
      show();
    }
  });
  return button;
}

/**
 * Suggestions under a text field, filtered by what is typed: the window's
 * own <datalist>. `choices` may say why there are none (a string), and the
 * field can be told its list changed with `refreshSuggestions`.
 */
export function suggest(input: HTMLInputElement, choices: () => Choice[] | string) {
  const show = () => {
    const all = choices();
    const typed = input.value.trim().toLowerCase();
    const list = Array.isArray(all) ? all.filter((c) => !typed || c.value.toLowerCase().includes(typed) || c.label.toLowerCase().includes(typed)) : [];
    popover(
      input,
      list,
      input.value.trim(),
      (v) => {
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      true,
      typeof all === "string" ? all : "沒有符合的模型",
    );
  };
  input.addEventListener("focus", show);
  input.addEventListener("input", () => {
    if (open?.anchor === input || document.activeElement === input) show();
  });
  input.addEventListener("refresh-suggestions", () => {
    if (document.activeElement === input) show();
  });
  input.addEventListener("blur", () => {
    if (open?.anchor === input) closeMenu();
  });
}

export function refreshSuggestions(input: HTMLElement) {
  input.dispatchEvent(new Event("refresh-suggestions"));
}

/**
 * Dresses every native <select> and every <input list> under `root`, now and
 * as they are added, in the window's own picker — for a page built around
 * native fields (Settings). The <select> stays, hidden: its value and its
 * "change" event are what the page already reads.
 */
export function glassify(root: HTMLElement) {
  const dress = () => {
    for (const sel of root.querySelectorAll<HTMLSelectElement>("select:not([data-glass])")) skinSelect(sel);
    for (const input of root.querySelectorAll<HTMLInputElement>("input[list]:not([data-glass])")) skinList(input);
  };
  dress();
  new MutationObserver(dress).observe(root, { childList: true, subtree: true });
}

function skinSelect(sel: HTMLSelectElement) {
  sel.dataset.glass = "1";
  const label = h("span", { class: "dropdown-label" });
  const button = h(
    "button",
    { type: "button", class: "dropdown skinned", title: sel.title, "aria-haspopup": "listbox" },
    label,
    h("span", { class: "dropdown-chevron", html: CHEVRON }),
  ) as HTMLButtonElement;
  const sync = () => {
    label.textContent = sel.selectedOptions[0]?.textContent ?? "";
    button.disabled = sel.disabled;
    if (sel.style.width) button.style.width = sel.style.width;
  };
  sel.style.display = "none";
  sel.after(button);
  // The page may fill or set it after it was dressed.
  queueMicrotask(sync);
  sel.addEventListener("change", sync);
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true });
  button.addEventListener("click", () => {
    if (open?.anchor === button) return closeMenu();
    sync();
    const choices = [...sel.options].filter((o) => !o.disabled).map((o) => ({ value: o.value, label: o.textContent ?? o.value }));
    popover(button, choices, sel.value, (v) => {
      if (v === sel.value) return;
      sel.value = v;
      sync();
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}

function skinList(input: HTMLInputElement) {
  input.dataset.glass = "1";
  const id = input.getAttribute("list") ?? "";
  // No native popup: the suggestions come from the same <datalist>.
  input.removeAttribute("list");
  input.setAttribute("autocomplete", "off");
  suggest(input, () => {
    const list = document.getElementById(id);
    const options = list ? [...list.querySelectorAll("option")] : [];
    return options.map((o) => ({ value: o.value, label: o.value, hint: o.textContent && o.textContent !== o.value ? o.textContent : undefined }));
  });
  // A list filled later (List models) shows at once if the field is in use.
  const list = document.getElementById(id);
  if (list) new MutationObserver(() => refreshSuggestions(input)).observe(list, { childList: true });
}

// ── A name changed where it stands ────────────────────────────────────────────

/** What is being typed into each name, by its key, while it is being changed. */
const naming = new Map<string, string>();

/**
 * A name that is changed by clicking it: no button, the words themselves are
 * the way in. Enter (or clicking elsewhere) keeps the change, Esc leaves it;
 * an empty name goes back to `fallback`. The page may be drawn again while
 * someone types: what is typed is kept here, under `key`.
 */
export function editableText(
  key: string,
  value: string,
  opts: { tag?: "h1" | "b" | "span"; className?: string; label: string; fallback: string; maxLength?: number; onSave: (value: string) => void; render: () => void },
): HTMLElement {
  const draft = naming.get(key);
  if (draft !== undefined) {
    const input = h("input", {
      class: `inline-edit ${opts.className ?? ""}`,
      type: "text",
      value: draft,
      maxlength: String(opts.maxLength ?? 30),
      "data-key": `name:${key}`,
      "aria-label": opts.label,
      spellcheck: "false",
    }) as HTMLInputElement;
    const done = (keep: boolean) => {
      if (!naming.has(key)) return;
      naming.delete(key);
      if (keep) opts.onSave(input.value.trim() || opts.fallback);
      opts.render();
    };
    input.addEventListener("input", () => naming.set(key, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) done(true);
      else if (e.key === "Escape") done(false);
    });
    // Taken away by the page being drawn again is not leaving it.
    input.addEventListener("blur", () => input.isConnected && done(true));
    setTimeout(() => {
      if (input.isConnected && document.activeElement !== input) {
        input.focus();
        input.select();
      }
    }, 0);
    return input;
  }
  const el: HTMLElement = h(opts.tag ?? "span", { class: `editable ${opts.className ?? ""}`, tabindex: "0", title: `點一下修改${opts.label}`, text: value });
  const start = () => {
    naming.set(key, value);
    opts.render();
  };
  el.addEventListener("click", start);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") start();
  });
  return el;
}
