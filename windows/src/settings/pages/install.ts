// Installing the agent CLIs on this PC.

import { Bridge, IS_TAURI, type CliInfo } from "../../core/bridge";
import { h, clear } from "../../views/dom";

const SOURCE: Record<CliInfo["methods"][number]["source"], string> = {
  "built-in": "",
  confirmed: "✓ on the official page",
  updated: "updated from the official page",
  unconfirmed: "not seen on the official page — check the docs",
};

/**
 * Every agent CLI Coucou drives, whether it is installed, and the vendor's
 * install commands. A command runs only from its own button, in a PowerShell
 * window the person watches.
 */
export function cliSection(): HTMLElement {
  let list: CliInfo[] = [];
  let checking = true;
  let note = "";
  const body = h("div", { class: "cli-list" });
  const status = h("span", { class: "hint" });
  const recheck = h("button", { text: "Check again" });
  const official = h("button", { text: "Check official pages" });

  const draw = () => {
    clear(body);
    status.textContent = checking ? "Looking for installed CLIs…" : note;
    recheck.toggleAttribute("disabled", checking);
    for (const cli of list) {
      const installed = !!cli.found;
      const head = h(
        "div",
        { class: "cli-head" },
        h("i", { class: "dot", style: `background:${checking && !installed ? "#6b7079" : installed ? "#22c55e" : "#f4505e"}` }),
        h("b", { text: cli.name }),
        h("code", { class: "cli-exe", text: cli.command }),
        h("span", { class: "hint", title: cli.found ?? "", text: checking && !installed ? "checking…" : installed ? `installed${cli.version ? ` · ${cli.version}` : " (no version answer)"}` : "not installed" }),
        h("span", { class: "grow" }),
        h("button", { class: "link", onClick: () => void Bridge.openUrl(cli.docs) }, "Official docs ↗"),
      );
      const methods = cli.methods.map((m, i) => {
        const feedback = h("span", { class: "hint" });
        const copy = h("button", { text: "Copy" });
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(m.command);
            feedback.textContent = "Copied.";
          } catch {
            feedback.textContent = "Select the command and copy it.";
          }
        });
        const run = h("button", { class: installed ? "" : "primary", text: "Run in terminal" });
        run.addEventListener("click", async () => {
          try {
            await Bridge.cliRunInstall(cli.id, i);
            feedback.textContent = "Opened in PowerShell. When it finishes, click Check again.";
          } catch (err) {
            feedback.textContent = String(err instanceof Error ? err.message : err);
          }
        });
        return h(
          "div",
          { class: "cli-method" },
          h("span", { class: "cli-label", text: m.label }),
          h("code", { class: "cli-command", text: m.command }),
          copy,
          run,
          h("div", { class: "cli-note hint" }, m.note, SOURCE[m.source] ? h("span", { class: `cli-source ${m.source}`, text: ` · ${SOURCE[m.source]}` }) : null, " ", feedback),
        );
      });
      body.append(h("div", { class: `cli${installed ? " installed" : ""}` }, head, h("div", { class: "hint", text: cli.purpose }), ...methods));
    }
  };

  const look = async () => {
    checking = true;
    draw();
    list = (await Bridge.cliStatus()) ?? list;
    checking = false;
    const missing = list.filter((c) => !c.found).length;
    note = missing ? `${missing} not installed.` : "Everything is installed.";
    draw();
  };

  recheck.addEventListener("click", () => void look());
  official.addEventListener("click", async () => {
    official.setAttribute("disabled", "");
    status.textContent = "Reading the vendors' install pages…";
    try {
      const checked = await Bridge.cliCheckOfficial();
      list = checked.map((c) => ({ ...c, found: list.find((o) => o.id === c.id)?.found ?? null, version: list.find((o) => o.id === c.id)?.version ?? null }));
      const changed = checked.flatMap((c) => c.methods).filter((m) => m.source === "updated").length;
      note = changed ? `${changed} command(s) updated from the official pages.` : "The commands match the official pages.";
    } catch (err) {
      note = String(err instanceof Error ? err.message : err);
    }
    official.removeAttribute("disabled");
    draw();
  });

  void (async () => {
    list = (await Bridge.cliList()) ?? (IS_TAURI ? [] : DEMO_CLIS);
    draw();
    if (IS_TAURI) await look();
    else ((checking = false), draw());
  })();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Install CLIs" })),
    h("div", {
      class: "hint",
      text: "The agent CLIs Coucou works with, for setting up a new PC. Commands come from each vendor's install page. Nothing is installed until you click Run in terminal: the command then opens in its own PowerShell window, where you can watch it and answer its questions.",
    }),
    h("div", { class: "row" }, recheck, official, status),
    body,
  );
}

/** For the page in a plain browser (no app behind it). */
const DEMO_CLIS: CliInfo[] = [
  { id: "claude", name: "Claude Code", command: "claude", purpose: "Anthropic's coding agent.", docs: "https://code.claude.com/docs/en/setup", found: "C:\\Users\\you\\.local\\bin\\claude.exe", version: "2.1.211 (Claude Code)", methods: [{ label: "PowerShell", command: "irm https://claude.ai/install.ps1 | iex", note: "Recommended.", source: "confirmed" }, { label: "WinGet", command: "winget install Anthropic.ClaudeCode", note: "Does not update itself.", source: "built-in" }] },
  { id: "agy", name: "Antigravity CLI (agy)", command: "agy", purpose: "Google Antigravity's agent.", docs: "https://antigravity.google/docs/getting-started?tab=cli", found: null, version: null, methods: [{ label: "PowerShell", command: "irm https://antigravity.google/cli/install.ps1 | iex", note: "Official Windows installer.", source: "unconfirmed" }] },
];
