// Team & secretary: set up in the Teamwork window. This page only shows what
// they use and takes the person there — two windows editing one value would
// fight.

import { Bridge, IS_TAURI, type HistoryStats } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import { locationOf } from "../../core/state";
import { kindIcon, markName } from "../../views/agent-kind";
import { h } from "../../views/dom";
import type { Page } from "../nav";
import { todoList } from "../status";
import { refreshTeamAgents, save, settings, statusInput, teamAgents } from "../store";
import { card, errText, field, notice, pageHeader, row, toggle } from "../ui";

/** The chat model Agent Center was last set to, from the Teamwork window's storage (same origin). */
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

/** `18 KB`, `3.1 MB`. */
function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(bytes ? 1 : 0, Math.ceil(bytes / 1024))} KB`;
}

/**
 * 清除歷史紀錄: the teams' runs and what they cost, or the teams too. What
 * sets things up — Agent Pool, the agents, chat models, keys, prices, the
 * constitution — is never on the list (history.rs). Two clicks: pick, then
 * confirm.
 */
function historyCard(): HTMLElement {
  const body = h("div", { class: "stack" });
  let stats: HistoryStats | null = null;
  let scope: "runs" | "all" = "runs";
  let confirming = false;
  let busy = false;
  let said: { kind: "ok" | "err"; text: string } | null = null;

  const load = async () => {
    stats = await Bridge.historyStats();
    draw();
  };

  const option = (value: "runs" | "all", title: string, help: string) =>
    h(
      "button",
      {
        type: "button",
        class: `choice history-choice${scope === value ? " on" : ""}`,
        role: "radio",
        "aria-checked": String(scope === value),
        onclick: () => {
          scope = value;
          confirming = false;
          said = null;
          draw();
        },
      },
      h("span", { class: "radio" }),
      h("span", { class: "history-choice-text" }, h("b", { text: title }), h("span", { class: "hint", text: help })),
    );

  const draw = () => {
    const s = stats;
    const nothing = !!s && (scope === "runs" ? !s.runs : !s.teams && !s.deleted && !s.runs && !s.documents);
    body.replaceChildren(
      ...[
        h("p", {
          class: "hint",
          text: !IS_TAURI
            ? tr("目前有多少紀錄,在 App 裡才讀得到。", "How much there is can only be read in the app.")
            : !s
              ? tr("讀取中…", "Reading…")
              : trf("目前有 {teams} 個團隊、{runs} 份執行紀錄({runSize})、{docs} 份知識庫文件({docSize}){deleted}。", "Now: {teams} teams, {runs} run records ({runSize}), {docs} knowledge documents ({docSize}){deleted}.", {
                  teams: s.teams,
                  runs: s.runs,
                  runSize: sizeText(s.runBytes),
                  docs: s.documents,
                  docSize: sizeText(s.documentBytes),
                  deleted: s.deleted ? trf(",另有 {n} 個之前刪除的團隊檔", ", and {n} team files deleted before", { n: s.deleted }) : "",
                }),
        }),
        h(
          "div",
          { class: "choice-list", role: "radiogroup", "aria-label": tr("要清除什麼", "What to clear") },
          option("runs", tr("只清執行紀錄與花費", "Runs and costs only"), tr("團隊留著,之後可以再啟動;它們的訊息、任務進度,以及「成本與用量」裡的紀錄清空。", "The teams stay and can start again; their messages, task progress and the records in Cost & usage are cleared.")),
          option("all", tr("全部清掉", "Everything"), tr("連團隊本身也清掉:所有團隊(含已封存與之前刪除的)、執行紀錄與花費、知識庫文件,以及 Agent Center 的對話。", "The teams go too: every team (archived and earlier-deleted ones included), their runs and costs, their knowledge documents, and Agent Center's conversation.")),
        ),
        confirming
          ? h(
              "div",
              { class: "stack" },
              notice("warn", scope === "all" ? tr("確定要清掉所有團隊和它們的紀錄嗎?會移到資源回收筒。", "Clear every team and all their records? They go to the Recycle Bin.") : tr("確定要清掉所有團隊的執行紀錄與花費嗎?會移到資源回收筒。", "Clear every team's runs and costs? They go to the Recycle Bin.")),
              row(
                h("button", { type: "button", text: tr("取消", "Cancel"), disabled: busy, onclick: () => { confirming = false; draw(); } }),
                h("button", {
                  type: "button",
                  class: "danger",
                  text: busy ? tr("清除中…", "Clearing…") : tr("確定清除", "Clear"),
                  disabled: busy,
                  onclick: async () => {
                    busy = true;
                    draw();
                    try {
                      stats = await Bridge.historyClear(scope === "all");
                      said = { kind: "ok", text: scope === "all" ? tr("已清掉所有團隊和紀錄,移到資源回收筒了。", "Every team and its records are cleared: they are in the Recycle Bin.") : tr("已清掉執行紀錄與花費,移到資源回收筒了。團隊都還在。", "Runs and costs are cleared: they are in the Recycle Bin. The teams are all still there.") };
                    } catch (err) {
                      said = { kind: "err", text: errText(err) };
                    }
                    busy = false;
                    confirming = false;
                    draw();
                  },
                }),
              ),
            )
          : row(
              h("button", {
                type: "button",
                text: tr("清除…", "Clear…"),
                disabled: !IS_TAURI || !s || nothing,
                title: nothing ? tr("沒有可以清的紀錄", "Nothing to clear") : "",
                onclick: () => { confirming = true; said = null; draw(); },
              }),
            ),
        said ? notice(said.kind, said.text) : null,
      ].filter((x): x is HTMLElement => !!x),
    );
  };
  draw();
  void load();
  return card({
    anchor: "history",
    title: tr("清除歷史紀錄", "Clear history"),
    lead: tr(
      "清掉過去的團隊、執行紀錄和花費。Agent Pool、Agents、聊天模型、金鑰、價格表和憲法都不會動,團隊工作資料夾裡的檔案也不會動。清掉的東西會移到資源回收筒,按錯了還能從那裡救回來。執行中或暫停中的團隊要先停止。",
      "Clears past teams, their runs and what they cost. Agent Pool, the agents, chat models, keys, the price list and the constitution stay, and nothing in the teams' work folders is touched. What goes is moved to the Recycle Bin, so a mistake can be undone there. A running or paused team must be stopped first.",
    ),
    body: [body],
  });
}

export const teamPage: Page = {
  id: "team",
  icon: "team",
  name: () => tr("團隊與 Agent Center", "Team & Agent Center"),
  render(ctx) {
    const secretary = h("div", { class: "stack" });
    const source = h("div", { class: "stack" });
    const draw = () => {
      const noModel = todoList(statusInput()).some((t) => t.page === "chat");
      const sp = secretaryProvider();
      secretary.replaceChildren(...[
        field(tr("用的聊天模型", "Talks through"), h("span", { text: sp ? `${sp.name} (${sp.model || "—"})` : tr("在 Agent Center 的輸入列選的聊天模型", "the chat model picked in Agent Center's input bar") })),
        noModel
          ? h("div", { class: "stack" },
              notice("warn", tr("還沒有存好金鑰的聊天模型，Agent Center 沒辦法回答。", "No chat model with a key yet, so Agent Center cannot answer.")),
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
        h("p", { class: "field-help", text: tr("新團隊（Agent Center 開的、你在團隊設定新增的成員）只用 Teamwork「Agent Pool」裡的團隊 Agent；以前設定好、直接用 Agent Provider 的團隊照樣能啟動。", "New teams — Agent Center's, and members you add in Team setup — use only the team agents in Teamwork's Agent Pool; teams set up earlier that use an Agent Provider directly still start.") }),
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
        tr("團隊與 Agent Center", "Team & Agent Center"),
        tr("Teamwork 和 Agent Center 在 Teamwork 視窗裡設定。這一頁顯示它們用了什麼，並帶你過去。", "Teamwork and Agent Center are set up in the Teamwork window. This page shows what they use and takes you there."),
        () => tr(
          "Agent Center 是 Teamwork 裡替你組團隊的助理，它透過聊天模型說話（見「聊天模型」）。團隊成員用你在 Teamwork →「Agent Pool」裡定義的團隊 Agent 執行，每個團隊 Agent 都用「Agent Provider」頁的一個 Cloud Agent 或 Local Agent 執行。",
          "Agent Center is the assistant in Teamwork that sets up teams for you. It talks through a chat model (see Chat models). Team members run as the team agents you define in Teamwork → Agent Pool, each running on a Cloud Agent or a Local Agent from the Agent Provider page.",
        ),
      ),
      card({
        anchor: "secretary",
        title: "Agent Center",
        body: [secretary, row(h("button", { type: "button", text: tr("打開 Agent Center ↗", "Open Agent Center ↗"), onclick: () => openTeam("secretary") }))],
      }),
      card({
        anchor: "team-source",
        title: tr("團隊 Agent", "Team agents"),
        body: [source, row(h("button", { type: "button", text: "Agent Pool ↗", onclick: () => openTeam("agents") }))], // i18n-ok: a name, the same in both
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
      historyCard(),
    );
  },
};
