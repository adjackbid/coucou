// The setup guide: five steps over the settings window — language, connecting
// agents, a chat model, Teamwork, the island's basics. Every step uses the
// same cards as the pages (hooks still show their diff before writing), every
// step can be skipped, and the whole guide can wait for later.

import { tr, trf } from "../core/i18n";
import { h, clear } from "../views/dom";
import type { Nav, PageCtx } from "./nav";
import { HOOK_AGENTS, agentLink, todoList } from "./status";
import { clis, hooks, save, settings, statusInput, subscribe } from "./store";
import { connectPage } from "./pages/connect";
import { chatPage } from "./pages/chat";
import { islandPage } from "./pages/island";
import { languagePicker } from "./pages/general";
import { teamPage } from "./pages/team";
import { icon } from "./icons";
import { card, field, notice, toggle } from "./ui";

export const GUIDE_KEY = "coucou.settings.guide";

export function guideFlag(): string | null {
  try {
    return localStorage.getItem(GUIDE_KEY);
  } catch {
    return null;
  }
}

function setFlag(v: "done" | "later") {
  try {
    localStorage.setItem(GUIDE_KEY, v);
  } catch {
    /* no storage: the guide may open again next time, which is harmless */
  }
}

type StepId = "welcome" | "connect" | "chat" | "team" | "island" | "done";

const STEPS: StepId[] = ["welcome", "connect", "chat", "team", "island", "done"];

function stepName(s: StepId): string {
  switch (s) {
    case "welcome": return tr("歡迎", "Welcome");
    case "connect": return tr("連結", "Connect");
    case "chat": return tr("聊天", "Chat");
    case "team": return "Teamwork";
    case "island": return tr("瀏海島", "Island");
    case "done": return tr("完成", "Done");
  }
}

let open: { close(): void; redraw(): void } | null = null;

/** Redraws the open guide (after a language change). */
export function redrawGuide() {
  open?.redraw();
}

export function openGuide(nav: Nav, root: HTMLElement) {
  open?.close();
  let step: StepId = "welcome";
  const skipped = new Set<StepId>();
  let drops: (() => void)[] = [];
  const overlay = h("div", { class: "guide", role: "dialog", "aria-modal": "true" });
  root.append(overlay);

  const close = (flag: "done" | "later" | null) => {
    for (const d of drops) d();
    drops = [];
    overlay.remove();
    open = null;
    if (flag) setFlag(flag);
  };

  const ctx: PageCtx = {
    // A link out of a step leaves the guide for that page; it can be opened again.
    go: (page, anchor, action) => {
      close(null);
      nav.go(page, anchor, action);
    },
    onData: (fn) => drops.push(subscribe(fn)),
    openGuide: () => {},
  };

  const connected = () => HOOK_AGENTS.some((a) => agentLink(hooks[a], clis, a) === "connected");
  const chatReady = () => !todoList(statusInput()).some((t) => t.page === "chat");

  function content(): Node {
    switch (step) {
      case "welcome":
        return h("div", { class: "stack guide-welcome" },
          h("div", { class: "title-icon" }, icon("language", 22), h("h3", { text: tr("語言", "Language") })),
          languagePicker(ctx.onData),
          h("h2", { text: tr("嗨，我是 Mochi。", "Hi, I'm Mochi.") }),
          h("p", { text: tr("我住在螢幕上方的瀏海島裡。", "I live in the island at the top of your screen.") }),
          h("p", { text: tr(
            "你的 agent 在做什麼，我都會顯示出來；它們需要你批准或回答時，直接在我這裡按就好。",
            "I show what your agents are doing, and when they need your approval or an answer, you give it right there.",
          ) }),
          h("p", { text: tr("接下來 4 步，每一步都可以略過。", "Four steps follow, and you can skip any of them.") }),
        );
      case "connect": {
        const page = connectPage.render(ctx);
        return h("div", { class: "stack" },
          h("p", { class: "lead", text: tr(
            "連結你有在用的工具，它們的工作階段就會出現在瀏海島上。寫入之前會先給你看要改的內容。",
            "Connect the tools you use and their sessions appear in the island. You see what changes before anything is written.",
          ) }),
          page,
        );
      }
      case "chat":
        return h("div", { class: "stack" },
          h("p", { class: "lead", text: tr("聊天和秘書需要一個 AI 模型。", "The chat and the secretary need one AI model.") }),
          chatPage.render(ctx),
        );
      case "team":
        return h("div", { class: "stack" },
          h("p", { class: "lead", text: tr(
            "Teamwork 讓好幾個 agent 組成團隊一起做一件事，秘書會幫你組。這一步不用設定任何東西，想看看的話就打開 Teamwork。",
            "Teamwork lets several agents work on one thing as a team, and the secretary sets the team up for you. Nothing to set here; open Teamwork if you want a look.",
          ) }),
          teamPage.render(ctx),
        );
      case "island":
        return h("div", { class: "stack" },
          h("p", { class: "lead", text: tr("最常改的三樣：快捷鍵、放在哪個螢幕、開機時要不要啟動。", "The three most changed: the shortcut, which display, and starting with Windows.") }),
          islandPage.render(ctx),
          card({
            anchor: "startup",
            title: tr("開機時啟動", "Launch at startup"),
            body: [field(tr("開機時啟動", "Launch at startup"), toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }, tr("開機時啟動", "Launch at startup")))],
          }),
        );
      case "done": {
        const left = todoList(statusInput()).length;
        const n = HOOK_AGENTS.filter((a) => agentLink(hooks[a], clis, a) === "connected").length;
        return h("div", { class: "stack guide-done" },
          h("h2", { text: tr("好了！", "All done!") }),
          h("ul", {},
            h("li", { text: trf("已連結 {n} 個 agent。", "{n} agent(s) connected.", { n }) }),
            h("li", { text: chatReady() ? tr("聊天模型已經可以用了。", "A chat model is ready.") : tr("聊天模型還沒設好。", "No chat model is ready yet.") }),
            left ? h("li", { text: trf("還有 {n} 件事沒設定，總覽頁都列出來了。", "{n} thing(s) still left — the Overview lists them.", { n: left }) }) : null,
            skipped.size ? h("li", { text: trf("略過了：{s}", "Skipped: {s}", { s: [...skipped].map(stepName).join(", ") }) }) : null,
          ),
          n ? notice("ok", tr("開一個新的 Claude Code（或 Copilot、Antigravity）工作階段，就會在瀏海島上看到它。", "Start a new Claude Code (or Copilot, Antigravity) session to see it in the island.")) : null,
        );
      }
    }
  }

  function draw() {
    for (const d of drops) d();
    drops = [];
    clear(overlay);
    const i = STEPS.indexOf(step);
    const bar = h("ol", { class: "guide-steps" }, ...STEPS.map((s, j) =>
      h("li", { class: j < i ? "past" : j === i ? "now" : "" }, h("span", { class: "n", text: s === "done" ? "✓" : String(j + 1) }), h("span", { text: stepName(s) }))));
    const back = h("button", { type: "button", text: tr("上一步", "Back"), disabled: i === 0, onclick: () => go(STEPS[i - 1]) });
    const skip = h("button", { type: "button", class: "link", text: tr("略過這一步", "Skip this step"), onclick: () => { skipped.add(step); go(STEPS[i + 1]); } });
    const next = h("button", { type: "button", text: step === "done" ? tr("到總覽", "Go to Overview") : tr("下一步 →", "Next →") }) as HTMLButtonElement;
    const ready = () => (step === "connect" ? connected() : step === "chat" ? chatReady() : true);
    const syncNext = () => next.classList.toggle("primary", ready());
    syncNext();
    next.addEventListener("click", () => {
      if (step === "done") {
        close("done");
        nav.go("overview");
        return;
      }
      skipped.delete(step);
      go(STEPS[i + 1]);
    });
    const body = h("div", { class: "guide-body" }, content());
    overlay.append(
      h("div", { class: "guide-panel" },
        h("header", { class: "guide-head" },
          icon("guide", 22),
          h("h1", { text: tr("設定 Agent Center", "Set up Agent Center") }),
          h("span", { class: "grow" }),
          step === "done" ? null : h("button", { type: "button", class: "link", text: tr("稍後再說 ✕", "Later ✕"), onclick: () => close("later") }),
        ),
        bar,
        body,
        h("footer", { class: "guide-foot" }, back, h("span", { class: "grow" }), step === "done" || step === "welcome" ? null : skip, next),
      ),
    );
    drops.push(subscribe(syncNext));
  }

  function go(s: StepId | undefined) {
    if (!s) return;
    step = s;
    draw();
  }

  open = { close: () => close(null), redraw: draw };
  draw();
}
