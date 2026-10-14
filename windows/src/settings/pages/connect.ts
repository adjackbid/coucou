// Connecting the CLIs Coucou watches (Claude Code, Copilot CLI, Antigravity):
// their hooks, and starting a CLI through coucou-pty.

import { Bridge, type HookAgent, type HookStatus } from "../../core/bridge";
import { h, clear } from "../../views/dom";
import { settings, save } from "../store";
import { renderDiff, statusDot, toggle } from "../ui";

interface AgentCopy {
  agent: HookAgent;
  title: string;
  /** The file the hooks go into, as the row label. */
  file: string;
  installed: string;
  missing: string;
}

export const AGENT_COPY: AgentCopy[] = [
  {
    agent: "claude",
    title: "Claude Code",
    file: "settings.json",
    installed: "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.",
    missing: "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
  },
  {
    agent: "copilot",
    title: "Copilot CLI",
    file: "coucou.json",
    installed: "Coucou is hooked into your Copilot CLI sessions (the `copilot` command, or a wrapper such as `cg`). Steps, questions and replies show up on its pill.",
    missing: "Install the hooks to see your Copilot CLI sessions in the island. This writes one file of Coucou's own into your .copilot\\hooks folder and touches nothing else.",
  },
  {
    agent: "antigravity",
    title: "Antigravity",
    file: "hooks.json",
    installed: "Coucou is hooked into Antigravity (the agy CLI, the app and the IDE share this file). Prompts, tool steps and replies show up on the Antigravity pill. Permissions stay in Antigravity: Coucou hooks only the events that cannot change what the agent does.",
    missing: "Install the hooks to see your Antigravity sessions in the island. This adds one named entry, \"coucou\", to your global hooks.json and leaves every other hook as it is. It never answers a permission for you.",
  },
];

export function agentSection(copy: AgentCopy, status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: copy.title })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus(copy.agent);
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: copy.title }));
  };

  function draw() {
    body.append(
      h("div", { class: "hint", text: status.installed ? copy.installed : copy.missing }),
      h("div", { class: "row" },
        h("label", { text: copy.file }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    if (copy.agent === "copilot" && status.installed) {
      // Copilot 1.0.91 runs the PermissionRequest hook even under --yolo, so
      // a session meant to run unattended would stop at a card for every
      // tool. The switch rewrites Coucou's own hook file without that hook.
      body.append(h("div", { class: "row" },
        h("label", { text: "Ask before tools" }),
        toggle(settings.copilotPermissionCards, async (v) => {
          settings.copilotPermissionCards = v;
          await save();
          try {
            const preview = await Bridge.hooksPreview("copilot", true);
            if (preview) await Bridge.hooksApply("copilot", true, preview.fingerprint);
          } catch (err) {
            body.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
            return;
          }
          await rebuild();
        }),
        h("span", { class: "hint", text: "permission requests come to the island; off for --yolo sessions, which then run without a card per step" }),
      ));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(copy.agent, install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? `This is exactly what will change in your ${copy.file}. Your own hooks are left untouched.`
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(copy.agent, install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous file saved as ${backup}. Open a new ${copy.title} session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Terminal section (coucou-pty) ─────────────────────────────────────────────

/**
 * How to start a CLI so the island can type into its terminal. Shown, never
 * applied: the profile is the person's own file.
 */
export function terminalSection(hookPath: string): HTMLElement {
  const pty = hookPath.replace(/coucou-hook\.exe$/i, "coucou-pty.exe");
  const snippet = [
    "# Start the CLI through coucou-pty and the island can type into this terminal.",
    "# In a wrapper function such as cg, replace the last line:",
    "#     copilot --yolo @args",
    "# with:",
    `$pty = "${pty}"`,
    "if (Test-Path $pty) { & $pty -- copilot --yolo @args } else { copilot --yolo @args }",
  ].join("\n");
  const code = h("div", { class: "diff", text: snippet });
  const feedback = h("span", { class: "hint" });
  const copy = h("button", { text: "Copy" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      feedback.textContent = "Copied.";
    } catch {
      feedback.textContent = "Select the text above and copy it.";
    }
  });
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Typing into your own terminals" })),
    h("div", {
      class: "hint",
      text: "A CLI you start yourself in PowerShell can take instructions from the island too. Start it through coucou-pty: it looks and behaves the same, and its session in the island gets a text field that types into that terminal once the CLI is idle. Works with copilot, claude, or any other terminal CLI whose hooks are installed above.",
    }),
    code,
    h("div", { class: "row" }, copy, feedback),
  );
}
