// Overview: what is set up and what is left, each with the button that does it.
// It only shows; changes happen on the page each line points to.

import { tr, trf } from "../../core/i18n";
import { h } from "../../views/dom";
import type { Page, PageCtx } from "../nav";
import { HOOK_AGENTS, HOOK_NAME, agentLink, providerNeedsNoKey, providerKey, todoList, type Todo } from "../status";
import { clis, hooks, present, settings, statusInput, teamAgents } from "../store";
import { badge, card, pageHeader, row } from "../ui";
import { linkBadgeEl } from "./connect";
import { displayName } from "./island";
import { openTeam } from "./team";

/** One to-do as a sentence, and the button that deals with it. */
function todoLine(t: Todo, ctx: PageCtx): HTMLElement {
  const v = { name: t.name };
  let text = "";
  let button = "";
  let action: string | undefined;
  switch (t.kind) {
    case "relay":
      text = tr("Coucou 的轉送程式（coucou-hook.exe）不見了，所有 agent 都連不上。", "Coucou's relay (coucou-hook.exe) is missing, so no agent can be connected.");
      button = tr("怎麼修 →", "How to fix →");
      break;
    case "agent-unreadable":
      text = trf("讀不到 {name} 的設定檔。", "Can't read {name}'s settings file.", v);
      button = tr("看原因 →", "See why →");
      break;
    case "agent-update":
      text = trf("{name} 的連結需要更新。", "{name}'s hooks need an update.", v);
      button = tr("更新…", "Update…");
      action = "update";
      break;
    case "agent-unconnected":
      text = trf("{name} 已經安裝，但還沒連結。", "{name} is installed but not connected.", v);
      button = tr("連結…", "Connect…");
      action = "connect";
      break;
    case "chat-no-provider":
      text = tr("還沒有聊天模型。", "No chat model yet.");
      button = tr("新增 →", "Add one →");
      break;
    case "chat-no-key":
      text = trf("聊天模型「{name}」沒有 API 金鑰。", "Chat model “{name}” has no API key.", v);
      button = tr("加金鑰 →", "Add key →");
      break;
    case "chat-incomplete":
      text = trf("聊天模型「{name}」還缺端點或模型。", "Chat model “{name}” is missing its endpoint or model.", v);
      button = tr("補上 →", "Fill in →");
      break;
    case "agent-profile-no-key":
      text = trf("Agent「{name}」需要金鑰。", "Agent “{name}” needs a key.", v);
      button = tr("加金鑰 →", "Add key →");
      break;
    case "agent-profile-no-command":
      text = trf("Agent「{name}」沒有指令。", "Agent “{name}” has no command.", v);
      button = tr("補上 →", "Fill in →");
      break;
    case "hotkey":
      text = trf("快捷鍵 {name} 被別的程式佔走了。", "The shortcut {name} is taken by another program.", v);
      button = tr("換一個 →", "Change →");
      break;
  }
  return h(
    "div",
    { class: `todo-line ${t.level}` },
    h("i", { class: "dot" }),
    h("span", { class: "todo-text", text }),
    h("button", { type: "button", class: action ? "primary" : "", text: button, onclick: () => ctx.go(t.page, t.anchor, action) }),
  );
}

function summaryRow(label: string, value: Node | string, link?: { text: string; go: () => void }): HTMLElement {
  return h(
    "div",
    { class: "summary-row" },
    h("span", { class: "k", text: label }),
    typeof value === "string" ? h("span", { class: "v", text: value }) : value,
    h("span", { class: "grow" }),
    link ? h("button", { type: "button", class: "link", text: link.text, onclick: link.go }) : null,
  );
}

export const overviewPage: Page = {
  id: "overview",
  icon: "overview",
  name: () => tr("總覽", "Overview"),
  render(ctx) {
    const body = h("div", { class: "stack" });
    const draw = () => {
      const todos = todoList(statusInput());
      const left = todos.length;
      const top = left
        ? h(
            "section",
            { class: "card todo-box" },
            h("div", { class: "card-head" }, h("h2", { text: trf("還有 {n} 件事沒設定", "{n} things left to set up", { n: left }) })),
            ...todos.map((t) => todoLine(t, ctx)),
          )
        : h(
            "section",
            { class: "card all-set" },
            h("p", { text: tr("都設定好了。Coucou 會顯示你的工作階段，聊天也能回答你。", "You're all set. Coucou shows your sessions and can answer in the chat.") }),
          );
      const guide = row(h("span", { class: "grow" }), h("button", {
        type: "button",
        class: left ? "primary" : "",
        text: left ? tr("▶ 開始設定引導", "▶ Start the setup guide") : tr("再跑一次設定引導", "Run the setup guide again"),
        onclick: () => ctx.openGuide(),
      }));

      // Agents Coucou watches.
      const watched = card({
        anchor: "ov-connect",
        title: tr("Coucou 看著的 Agent", "Agents Coucou watches"),
        body: HOOK_AGENTS.map((a) => {
          const state = agentLink(hooks[a], clis, a);
          const link =
            state === "unconnected" ? { text: tr("連結…", "Connect…"), go: () => ctx.go("connect", `agent-${a}`, "connect") }
            : state === "update" ? { text: tr("更新…", "Update…"), go: () => ctx.go("connect", `agent-${a}`, "update") }
            : state === "nocli" ? { text: tr("安裝 →", "Install →"), go: () => ctx.go("connect", `agent-${a}`) }
            : { text: tr("查看 →", "View →"), go: () => ctx.go("connect", `agent-${a}`) };
          return summaryRow(HOOK_NAME[a], linkBadgeEl(state), link);
        }),
      });

      // Chat.
      const active = settings.providers.find((p) => p.id === settings.activeProvider);
      const chatAgent = settings.activeProvider.startsWith("agent:") ? settings.agents.find((a) => `agent:${a.id}` === settings.activeProvider) : null;
      const keyState = active
        ? providerNeedsNoKey(active) ? badge("off", tr("不需要金鑰", "No key needed"))
          : present[providerKey(active)] ? badge("ok", tr("金鑰已存", "Key saved")) : badge("todo", tr("沒有金鑰", "No key"))
        : null;
      const chat = card({
        anchor: "ov-chat",
        title: tr("聊天", "Chat"),
        body: [
          summaryRow(
            tr("使用中", "In use"),
            h("span", { class: "v" },
              chatAgent ? trf("Agent「{name}」", "Agent “{name}”", { name: chatAgent.name }) : active ? `${active.name} (${active.model || "—"})` : "—",
              " ", keyState),
            { text: tr("變更 →", "Change →"), go: () => ctx.go(chatAgent ? "agents" : "chat") },
          ),
        ],
      });

      // Agents Coucou can run.
      const names = settings.agents.map((a) => a.name);
      const agents = card({
        anchor: "ov-agents",
        title: tr("Coucou 能執行的 Agent", "Agents Coucou can run"),
        body: [summaryRow(trf("已設定 {n} 個", "{n} set up", { n: names.length }), names.join(", ") || "—", { text: tr("管理 →", "Manage →"), go: () => ctx.go("agents") })],
      });

      // Island.
      const island = card({
        anchor: "ov-island",
        title: tr("瀏海島", "Island"),
        body: [summaryRow(
          tr("目前", "Now"),
          [
            settings.hotkey ? trf("快捷鍵 {k}", "Shortcut {k}", { k: settings.hotkey }) : tr("沒有快捷鍵", "No shortcut"),
            displayName(settings.screen),
            settings.alwaysVisible ? tr("永遠顯示", "always visible") : trf("{s} 秒後隱藏", "hides after {s} s", { s: Math.round(settings.hideAfter || 60) }),
          ].join(" · "),
          { text: tr("變更 →", "Change →"), go: () => ctx.go("island") },
        )],
      });

      // Teamwork.
      const doc = teamAgents?.doc;
      const team = card({
        anchor: "ov-team",
        title: "Teamwork",
        body: [summaryRow(
          tr("新團隊用", "New teams use"),
          doc
            ? `${doc.source === "team" ? tr("團隊 Agent", "team agents") : tr("原生 Agent", "native agents")} · ${trf("已定義 {n} 個團隊 Agent", "{n} team agents defined", { n: doc.agents.length })}`
            : "—",
          { text: tr("打開 Teamwork ↗", "Open Teamwork ↗"), go: () => openTeam() },
        )],
      });

      body.replaceChildren(top, guide, watched, chat, agents, island, team);
    };
    ctx.onData(draw);
    draw();
    return h(
      "div",
      { class: "page-body" },
      pageHeader("overview", tr("總覽", "Overview"), tr("哪些已經設好、還差什麼。", "What's set up, and what's left to do.")),
      body,
    );
  },
};
