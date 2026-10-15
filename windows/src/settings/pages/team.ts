// Team & secretary: set up in the Teamwork window. This page only shows what
// they use and takes the person there — two windows editing one value would
// fight.

import { Bridge } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import { h } from "../../views/dom";
import type { Page } from "../nav";
import { todoList } from "../status";
import { refreshTeamAgents, save, settings, statusInput, teamAgents } from "../store";
import { card, field, notice, pageHeader, row, toggle } from "../ui";

/** The chat model the secretary was last set to, from the Teamwork window's storage (same origin). */
export function secretaryProvider(): { name: string; model: string } | null {
  let id: string | null = null;
  try {
    id = localStorage.getItem("coucou.secretary.provider");
  } catch {
    return null;
  }
  const p = settings.providers.find((x) => x.id === id) ?? settings.providers.find((x) => x.id === settings.activeProvider) ?? settings.providers[0];
  return p ? { name: p.name, model: p.model } : null;
}

/** Opens Teamwork on one of its pages. */
export function openTeam(page?: "secretary" | "agents") {
  void Bridge.openTeamPage(page ?? null);
}

export const teamPage: Page = {
  id: "team",
  icon: "team",
  name: () => tr("團隊與秘書", "Team & secretary"),
  render(ctx) {
    const secretary = h("div", { class: "stack" });
    const source = h("div", { class: "stack" });
    const draw = () => {
      const noModel = todoList(statusInput()).some((t) => t.page === "chat");
      const sp = secretaryProvider();
      secretary.replaceChildren(...[
        field(tr("用的聊天模型", "Talks through"), h("span", { text: sp ? `${sp.name} (${sp.model || "—"})` : tr("在秘書的輸入列選的聊天模型", "the chat model picked in the secretary's input bar") })),
        noModel
          ? h("div", { class: "stack" },
              notice("warn", tr("還沒有存好金鑰的聊天模型，秘書沒辦法回答。", "No chat model with a key yet, so the secretary cannot answer.")),
              row(h("button", { type: "button", class: "primary", text: tr("去新增 →", "Add one →"), onclick: () => ctx.go("chat") })))
          : null,
      ].filter((x): x is HTMLElement => !!x));
      const doc = teamAgents?.doc;
      if (!doc) {
        source.replaceChildren(h("p", { class: "hint", text: tr("讀取中…（Teamwork 的設定在 App 裡才讀得到）", "Reading… (Teamwork's settings are only there in the app)") }));
        return;
      }
      const native = settings.agents.length;
      const defined = doc?.agents.length ?? 0;
      const usesTeam = doc?.source === "team";
      source.replaceChildren(
        h("div", { class: "choice-list" },
          h("div", { class: usesTeam ? "choice" : "choice on" },
            h("span", { class: "radio" }),
            h("span", { text: tr("原生 Agent（「Agents」頁的那些）", "Native agents (from the Agents page)") }),
            h("span", { class: "grow" }),
            h("span", { class: "hint", text: trf("{n} 個可用", "{n} available", { n: native }) })),
          h("div", { class: usesTeam ? "choice on" : "choice" },
            h("span", { class: "radio" }),
            h("span", { text: tr("團隊 Agent（在 Teamwork 裡定義）", "Team agents (defined in Teamwork)") }),
            h("span", { class: "grow" }),
            h("span", { class: "hint", text: trf("已定義 {n} 個", "{n} defined", { n: defined }) })),
        ),
        h("p", { class: "field-help", text: tr("要改的話，到 Teamwork 的「Agent 設定」。", "To change it, go to Agent settings in Teamwork.") }),
      );
    };
    ctx.onData(draw);
    draw();
    void refreshTeamAgents();

    return h(
      "div",
      { class: "page-body" },
      pageHeader(
        "team",
        tr("團隊與秘書", "Team & secretary"),
        tr("Teamwork 和秘書在 Teamwork 視窗裡設定。這一頁顯示它們用了什麼，並帶你過去。", "Teamwork and the secretary are set up in the Teamwork window. This page shows what they use and takes you there."),
        () => tr(
          "秘書是 Teamwork 裡替你組團隊的助理，它透過聊天模型說話（見「聊天模型」）。團隊成員用 Agents 執行（見「Agents」），或用你在 Teamwork →「Agent 設定」裡定義的團隊 Agent。",
          "The secretary is the assistant in Teamwork that sets up teams for you. It talks through a chat model (see Chat models). Team members run as Agents (see Agents), or as team agents you define in Teamwork → Agent settings.",
        ),
      ),
      card({
        anchor: "secretary",
        title: tr("秘書", "Secretary"),
        body: [secretary, row(h("button", { type: "button", text: tr("打開秘書 ↗", "Open the secretary ↗"), onclick: () => openTeam("secretary") }))],
      }),
      card({
        anchor: "team-source",
        title: tr("新團隊用哪種 Agent", "New teams use"),
        body: [source, row(h("button", { type: "button", text: tr("Agent 設定 ↗", "Agent settings ↗"), onclick: () => openTeam("agents") }))],
      }),
      card({
        anchor: "teams",
        title: tr("團隊", "Teams"),
        lead: tr("每個團隊的目標、成員、知識庫和憲法，都在 Teamwork 裡設定。", "Each team's goal, members, knowledge and constitution are set up in Teamwork."),
        body: [row(h("button", { type: "button", class: "primary", text: tr("打開 Teamwork ↗", "Open Teamwork ↗"), onclick: () => openTeam() }))],
      }),
      card({
        anchor: "battle",
        title: tr("中二模式", "Battle mode"),
        lead: tr("把團隊的工作畫成討伐魔王的戰鬥。關掉時，Teamwork 的工作監控、團隊設定和公司設定都不會出現任何中二模式的東西。", "Shows the team's work as a raid on a boss. When off, nothing of it appears anywhere in Teamwork: not in the monitor, the team setup or the company settings."),
        body: [
          field(
            tr("顯示中二模式", "Show Battle mode"),
            toggle(settings.battleMode, (v) => { settings.battleMode = v; void save(); }, tr("顯示中二模式", "Show Battle mode")),
            tr("預設關閉。只影響畫面，不影響團隊的工作、權限或驗收。", "Off by default. Only the picture changes; the team's work, permissions and reviews stay the same."),
          ),
        ],
      }),
    );
  },
};
