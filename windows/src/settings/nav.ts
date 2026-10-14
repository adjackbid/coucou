// The settings window's frame: a sidebar of pages on the left (with a badge
// for what is left on each), the page on the right.

import { h, clear } from "../views/dom";
import { lang, setLang, tr } from "../core/i18n";
import { IS_TAURI } from "../core/bridge";
import { icon, type IconKey } from "./icons";
import { pageBadges, todoList, type PageId } from "./status";
import { save, settings, statusInput, subscribe, version } from "./store";
import { flash } from "./ui";

export interface PageCtx {
  /** Opens another page, scrolled to a card; `action` asks that card to start something (e.g. "connect"). */
  go(page: PageId, anchor?: string, action?: string): void;
  /** Runs `fn` when what the window has read changes, while this page is shown. */
  onData(fn: () => void): void;
  /** Opens the setup guide. */
  openGuide(): void;
  /** What the link that opened this page asked for. */
  action?: string;
  anchor?: string;
}

export interface Page {
  id: PageId;
  icon: IconKey;
  name(): string;
  render(ctx: PageCtx): HTMLElement;
}

const PAGE_KEY = "coucou.settings.page";

export class Nav {
  private current: PageId = "overview";
  private drops: (() => void)[] = [];
  private side = h("nav", { class: "side" });
  private main = h("main", { class: "page" });
  private items = new Map<PageId, HTMLButtonElement>();

  constructor(
    root: HTMLElement,
    private pages: Page[],
    private guide: (nav: Nav) => void,
  ) {
    clear(root);
    root.append(h("div", { class: "frame" }, this.side, this.main));
    subscribe(() => this.badges());
  }

  /** The page to open at start: the overview while something is left, else the last one. */
  start() {
    const left = todoList(statusInput()).length;
    let last: string | null = null;
    try {
      last = localStorage.getItem(PAGE_KEY);
    } catch {
      /* no storage */
    }
    const known = this.pages.some((p) => p.id === last);
    this.go(left > 0 || !known ? "overview" : (last as PageId));
  }

  page(): PageId {
    return this.current;
  }

  go(id: PageId, anchor?: string, action?: string) {
    const page = this.pages.find((p) => p.id === id) ?? this.pages[0];
    this.current = page.id;
    try {
      localStorage.setItem(PAGE_KEY, page.id);
    } catch {
      /* no storage */
    }
    this.draw(anchor, action);
  }

  /** Draws everything again — after a language change. */
  redraw() {
    this.draw();
  }

  private draw(anchor?: string, action?: string) {
    for (const d of this.drops) d();
    this.drops = [];
    this.sidebar();
    const page = this.pages.find((p) => p.id === this.current)!;
    const ctx: PageCtx = {
      go: (p, a, act) => this.go(p, a, act),
      onData: (fn) => this.drops.push(subscribe(fn)),
      openGuide: () => this.guide(this),
      action,
      anchor,
    };
    clear(this.main);
    this.main.append(page.render(ctx));
    this.main.scrollTop = 0;
    if (anchor) {
      const target = this.main.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior });
        flash(target);
      }
    }
  }

  private sidebar() {
    clear(this.side);
    this.items.clear();
    this.side.setAttribute("aria-label", tr("設定分頁", "Settings pages"));
    this.side.append(
      h("div", { class: "brand" }, h("span", { class: "brand-name", text: "Coucou" }), h("span", { class: "version", text: version })),
    );
    const list = h("div", { class: "side-list", role: "tablist" });
    for (const p of this.pages) {
      const name = p.name();
      const b = h(
        "button",
        {
          type: "button",
          class: p.id === this.current ? "side-item on" : "side-item",
          role: "tab",
          "aria-selected": p.id === this.current,
          title: name,
          onclick: () => this.go(p.id),
        },
        icon(p.icon, 20),
        h("span", { class: "side-name", text: name }),
        h("span", { class: "side-badge" }),
      ) as HTMLButtonElement;
      this.items.set(p.id, b);
      list.append(b);
    }
    const guideName = tr("開始設定引導", "Setup guide");
    const langBox = h(
      "div",
      { class: "side-lang", role: "group", "aria-label": tr("語言", "Language"), title: tr("語言", "Language") },
      // In a narrow window only the globe is left: it switches to the other language.
      h("button", { type: "button", class: "lang-icon", title: lang() === "zh-TW" ? "English" : "中文", onclick: () => void chooseLanguage(lang() === "zh-TW" ? "en" : "zh-TW") }, icon("language", 18)),
      ...(["zh-TW", "en"] as const).map((l) =>
        h("button", {
          type: "button",
          class: lang() === l ? "on" : "",
          "aria-pressed": lang() === l,
          text: l === "zh-TW" ? "中文" : "EN",
          onclick: () => void chooseLanguage(l),
        }),
      ),
    );
    this.side.append(
      list,
      h("div", { class: "side-foot" },
        h("button", { type: "button", class: "side-item", title: guideName, onclick: () => this.guide(this) },
          icon("guide", 20), h("span", { class: "side-name", text: guideName })),
        langBox,
        h("p", { class: "side-note", text: tr("沒有遙測。只會連到你自己設定的服務。", "No telemetry. Only the services you set up are contacted.") }),
      ),
    );
    this.badges();
  }

  private badges() {
    const all = pageBadges(statusInput());
    for (const [id, el] of this.items) {
      const b = all[id];
      const slot = el.querySelector(".side-badge")!;
      clear(slot);
      slot.className = "side-badge";
      if (b.todo > 0) {
        slot.classList.add("todo");
        slot.textContent = String(b.todo);
        slot.setAttribute("aria-label", tr(`${b.todo} 件待處理`, `${b.todo} to do`));
      } else if (b.update) {
        slot.classList.add("update");
        slot.textContent = "!";
        slot.setAttribute("aria-label", tr("需要更新", "Needs update"));
      } else if (b.ok) {
        slot.classList.add("ok");
        slot.textContent = "✓";
        slot.setAttribute("aria-label", tr("已設定", "Set up"));
      }
    }
  }
}

/**
 * Sets the language. Rust saves it and tells every window (this one too) with
 * `lang-changed`; in a plain browser nobody would, so the page does it itself.
 */
export async function chooseLanguage(l: "zh-TW" | "en" | "system") {
  settings.language = l;
  await save();
  if (!IS_TAURI) setLang(l === "system" ? lang() : l);
}
