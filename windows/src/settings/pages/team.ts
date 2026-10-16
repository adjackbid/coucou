// Team & secretary: set up in the Teamwork window. This page only shows what
// they use and takes the person there — two windows editing one value would
// fight.

import { Bridge } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import { locationOf } from "../../core/state";
import { kindIcon, markName } from "../../views/agent-kind";
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
      // A team agent is a Cloud or a Local Agent as its base is.
      const count = { cloud: 0, local: 0 };
      for (const t of doc.agents) {
        const base = settings.agents.find((n) => n.id === t.base);
        if (base) count[locationOf(base)]++;
      }
      const line = (where: "cloud" | "local") =>
        h("div", { class: "choice on" },
          kindIcon(where, 18),
          h("span", { text: markName(where) }),
          h("span", { class: "grow" }),
          h("span", { class: "hint", text: trf("{n} 個團隊 Agent", "{n} team agents", { n: count[where] }) }));
      source.replaceChildren(
        h("div", { class: "choice-list" }, line("cloud"), line("local")),
        h("p", { class: "field-help", text: tr("新團隊（秘書開的、你在團隊設定新增的成員）只用 Teamwork「Agent 設定」裡的團隊 Agent；以前設定好、用原生 Agent 的團隊照樣能啟動。", "New teams — the secretary's, and members you add in Team setup — use only the team agents in Teamwork's Agent settings; teams set up earlier with native agents still start.") }),
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
          "秘書是 Teamwork 裡替你組團隊的助理，它透過聊天模型說話（見「聊天模型」）。團隊成員用你在 Teamwork →「Agent 設定」裡定義的團隊 Agent 執行，每個團隊 Agent 都以「Agents」頁的一個 Cloud Agent 或 Local Agent 為基底。",
          "The secretary is the assistant in Teamwork that sets up teams for you. It talks through a chat model (see Chat models). Team members run as the team agents you define in Teamwork → Agent settings, each built on a Cloud Agent or a Local Agent from the Agents page.",
        ),
      ),
      card({
        anchor: "secretary",
        title: tr("秘書", "Secretary"),
        body: [secretary, row(h("button", { type: "button", text: tr("打開秘書 ↗", "Open the secretary ↗"), onclick: () => openTeam("secretary") }))],
      }),
      card({
        anchor: "team-source",
        title: tr("團隊 Agent", "Team agents"),
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
        title: tr("戰鬥模式", "Battle mode"),
        lead: tr("把團隊的工作畫成討伐魔王的戰鬥。關掉時，Teamwork 的工作監控、團隊設定和公司設定都不會出現任何戰鬥模式的東西。", "Shows the team's work as a raid on a boss. When off, nothing of it appears anywhere in Teamwork: not in the monitor, the team setup or the company settings."),
        body: [
          field(
            tr("顯示戰鬥模式", "Show Battle mode"),
            toggle(settings.battleMode, (v) => { settings.battleMode = v; void save(); }, tr("顯示戰鬥模式", "Show Battle mode")),
            tr("預設關閉。只影響畫面，不影響團隊的工作、權限或驗收。", "Off by default. Only the picture changes; the team's work, permissions and reviews stay the same."),
          ),
        ],
      }),
    );
  },
};
