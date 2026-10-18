// Install CLIs: every agent CLI Coucou works with, whether it is installed,
// and the vendor's install commands. A command runs only from its own button,
// in a PowerShell window the person watches.

import { Bridge, type CliInfo } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import { h } from "../../views/dom";
import type { Page, PageCtx } from "../nav";
import { agentLink, HOOK_AGENTS, HOOK_CLI } from "../status";
import { clis, clisChecking, hooks, refreshClis, setClis } from "../store";
import { badge, card, disclosure, errText, pageHeader, row } from "../ui";

const HELPERS = new Set(["node", "git"]);

function sourceWords(source: CliInfo["methods"][number]["source"]): string {
  switch (source) {
    case "built-in": return "";
    case "confirmed": return tr("✓ 官方頁面上有這條", "✓ on the official page");
    case "updated": return tr("已依官方頁面更新", "updated from the official page");
    case "unconfirmed": return tr("官方頁面上沒看到，請查看文件", "not seen on the official page — check the docs");
  }
}

function method(cli: CliInfo, m: CliInfo["methods"][number], i: number, primary: boolean): HTMLElement {
  const feedback = h("span", { class: "hint" });
  const copy = h("button", {
    type: "button",
    text: tr("複製", "Copy"),
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(m.command);
        feedback.textContent = tr("已複製。", "Copied.");
      } catch {
        feedback.textContent = tr("請選取指令自己複製。", "Select the command and copy it.");
      }
    },
  });
  const run = h("button", {
    type: "button",
    class: primary ? "primary" : "",
    text: tr("在終端機執行", "Run in terminal"),
    onclick: async () => {
      try {
        await Bridge.cliRunInstall(cli.id, i);
        feedback.textContent = tr("已在 PowerShell 打開。跑完後按「重新檢查」。", "Opened in PowerShell. When it finishes, click Check again.");
      } catch (err) {
        feedback.textContent = errText(err);
      }
    },
  });
  const src = sourceWords(m.source);
  return h(
    "div",
    { class: "cli-method" },
    h("span", { class: "cli-label", text: m.label }),
    h("code", { class: "cli-command", text: m.command }),
    copy,
    run,
    h("div", { class: "cli-note hint" }, m.note, src ? h("span", { class: `cli-source ${m.source}`, text: ` · ${src}` }) : null, " ", feedback),
  );
}

/** "Coucou: connected" for the three CLIs Coucou can watch; where else it is used for Codex. */
function usedBy(cli: CliInfo, ctx: PageCtx): HTMLElement | null {
  const agent = HOOK_AGENTS.find((a) => HOOK_CLI[a] === cli.id);
  if (agent) {
    const state = agentLink(hooks[agent], clis, agent);
    if (state === "connected" || state === "update") return h("span", { class: "used ok", text: tr("Agent Center：已連結 ✓", "Agent Center: connected ✓") });
    if (!cli.found) return null;
    return h("button", { type: "button", class: "link", text: tr("Agent Center：未連結，去連結 →", "Agent Center: not connected — Connect →"), onclick: () => ctx.go("connect", `agent-${agent}`, "connect") });
  }
  if (cli.id === "codex") {
    return h("button", { type: "button", class: "link", text: tr("Agent Center 可以驅動它：Agent Provider →", "Agent Center can run it: Agent Provider →"), onclick: () => ctx.go("agents") });
  }
  return null;
}

function cliCard(cli: CliInfo, ctx: PageCtx): HTMLElement {
  const installed = !!cli.found;
  const checking = clisChecking && !installed;
  const state = checking ? "checking" : installed ? "ok" : "missing";
  const words = checking
    ? tr("檢查中…", "Checking…")
    : installed
      ? cli.version ? trf("已安裝 · {v}", "Installed · {v}", { v: cli.version }) : tr("已安裝（沒有回報版本）", "Installed (no version answer)")
      : tr("未安裝", "Not installed");
  const methods = cli.methods.map((m, i) => method(cli, m, i, !installed && i === 0));
  const body: Node[] = [];
  if (installed || checking) {
    body.push(disclosure(tr("安裝指令", "Install commands"), () => h("div", { class: "stack" }, ...methods), false, "commands"));
  } else {
    body.push(methods[0]);
    if (methods.length > 1) body.push(disclosure(tr("其他安裝方式", "Other ways to install"), () => h("div", { class: "stack" }, ...methods.slice(1)), false, "commands"));
  }
  const b = badge(state, words);
  if (cli.found) b.title = cli.found;
  return card({
    anchor: `cli-${cli.id}`,
    title: h("div", { class: "cli-title" }, h("h2", { text: cli.name }), h("code", { class: "cli-exe", text: cli.command })),
    badge: b,
    lead: h("div", { class: "lead-row" },
      h("p", { class: "lead", text: cli.purpose }),
      h("span", { class: "grow" }),
      usedBy(cli, ctx),
      h("button", { type: "button", class: "link", text: tr("官方文件 ↗", "Official docs ↗"), onclick: () => void Bridge.openUrl(cli.docs) }),
    ),
    body,
  });
}

export const installPage: Page = {
  id: "install",
  icon: "install",
  name: () => tr("安裝 CLI", "Install CLIs"),
  render(ctx) {
    const list = h("div", { class: "stack" });
    const helpers = h("div", { class: "stack" });
    const summary = h("span", { class: "hint" });
    const recheck = h("button", { type: "button", text: tr("重新檢查", "Check again"), onclick: () => void refreshClis() }) as HTMLButtonElement;
    const officialNote = h("span", { class: "hint" });
    const official = h("button", { type: "button", text: tr("檢查官方頁面", "Check official pages") }) as HTMLButtonElement;
    official.addEventListener("click", async () => {
      official.disabled = true;
      officialNote.textContent = tr("正在讀取各家的安裝頁面…", "Reading the vendors' install pages…");
      try {
        const checked = await Bridge.cliCheckOfficial();
        const before = clis ?? [];
        setClis(checked.map((c) => ({ ...c, found: before.find((o) => o.id === c.id)?.found ?? null, version: before.find((o) => o.id === c.id)?.version ?? null })));
        const n = checked.flatMap((c) => c.methods).filter((m) => m.source === "updated").length;
        officialNote.textContent = n
          ? trf("有 {n} 條指令依官方頁面更新了。", "{n} command(s) updated from the official pages.", { n })
          : tr("指令和官方頁面一致。", "The commands match the official pages.");
      } catch (err) {
        officialNote.textContent = errText(err);
      }
      official.disabled = false;
    });

    // Redrawn only when what it shows changed: a redraw shuts the open folds.
    let shown = "";
    const draw = () => {
      const key = JSON.stringify([clis, clisChecking, HOOK_AGENTS.map((a) => agentLink(hooks[a], clis, a))]);
      if (key === shown) return;
      shown = key;
      list.replaceChildren();
      helpers.replaceChildren();
      const all = clis ?? [];
      for (const cli of all) (HELPERS.has(cli.id) ? helpers : list).append(cliCard(cli, ctx));
      const agents = all.filter((c) => !HELPERS.has(c.id));
      const have = agents.filter((c) => c.found).length;
      recheck.disabled = clisChecking;
      summary.textContent = clisChecking
        ? tr("正在找已安裝的 CLI…", "Looking for installed CLIs…")
        : trf("{have} / {all} 個已安裝。", "{have} of {all} installed.", { have, all: agents.length });
    };
    ctx.onData(draw);
    draw();
    if (!clis && !clisChecking) void refreshClis();

    return h(
      "div",
      { class: "page-body" },
      pageHeader(
        "install",
        tr("安裝 CLI", "Install CLIs"),
        tr("在這台電腦上安裝 agent 的命令列工具。只要裝你會用的就好。", "Install the agent command-line tools on this PC. You only need the ones you use."),
        () => tr(
          "每條指令都來自各家自己的安裝頁面。按下「在終端機執行」之前什麼都不會執行；按下後會開一個自己的 PowerShell 視窗，你看得到過程，也能回答它的問題。跑完後按「重新檢查」。",
          "Each command comes from the vendor's own install page. Nothing runs until you click \"Run in terminal\": it then opens in its own PowerShell window, where you can watch it and answer its questions. When it finishes, click Check again.",
        ),
      ),
      row(recheck, summary),
      list,
      h("h3", { class: "section-title", text: tr("輔助工具（有些安裝方式需要）", "Helpers (needed by some installers)") }),
      helpers,
      disclosure(tr("對照官方頁面檢查指令", "Check the commands against the official pages"), () => h("div", { class: "stack" },
        h("p", { class: "hint", text: tr(
          "讀取各家的安裝頁面（這一頁只有這時候會連網），逐條標示官方頁面上有沒有這條指令。",
          "Reads each vendor's install page (the only time this page goes online) and marks every command as confirmed or not seen.",
        ) }),
        row(official, officialNote),
      ), false, "page-fold"),
    );
  },
};
