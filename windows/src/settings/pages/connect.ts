// Connect agents: the hooks that let Coucou watch Claude Code, Copilot CLI and
// Antigravity sessions. Nothing is written before the person has seen the diff;
// the old file is backed up first.

import { Bridge, type HookAgent } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import { h, clear } from "../../views/dom";
import type { Page, PageCtx } from "../nav";
import { HOOK_AGENTS, HOOK_CLI, HOOK_NAME, agentLink, linkBadge, type LinkState } from "../status";
import { clis, hooks, refreshHook, save, settings } from "../store";
import { badge, card, disclosure, errText, notice, pageHeader, renderDiff, row, statusDot, toggle } from "../ui";

/** The words on an agent's badge. */
export function linkWords(state: LinkState): string {
  switch (state) {
    case "checking": return tr("檢查中…", "Checking…");
    case "relay": return tr("Relay 不見了", "Relay missing");
    case "unreadable": return tr("讀不到設定檔", "Can't read its file");
    case "update": return tr("需要更新", "Needs update");
    case "connected": return tr("已連結", "Connected");
    case "unconnected": return tr("未連結", "Not connected");
    case "nocli": return tr("尚未安裝 CLI", "CLI not installed");
  }
}

export function linkBadgeEl(state: LinkState): HTMLElement {
  return badge(linkBadge(state), linkWords(state));
}

function lead(agent: HookAgent): string {
  switch (agent) {
    case "claude":
      return tr(
        "Anthropic 的 coding agent。連結後，它的工具步驟、提問和權限請求會出現在瀏海島上，你可以直接在那裡批准或回答。",
        "Anthropic's coding agent. Once connected, its tool steps, questions and permission requests appear in the island, and you can approve or answer them there.",
      );
    case "copilot":
      return tr(
        "GitHub 的 coding agent（copilot 指令，或 cg 這類包裝）。連結後，它的步驟、提問和回覆會出現在瀏海島上。Coucou 只寫一個自己的檔案，其他東西都不動。",
        "GitHub's coding agent (the copilot command, or a wrapper such as cg). Once connected, its steps, questions and replies appear in the island. Coucou writes one file of its own and touches nothing else.",
      );
    case "antigravity":
      return tr(
        "Google 的 agent（agy CLI、App 和 IDE 共用同一個設定檔）。Coucou 只在旁邊看：它永遠不會替 Antigravity 回答權限。",
        "Google's agent (the agy CLI, the app and the IDE share one settings file). Coucou only watches: it never answers a permission for Antigravity.",
      );
  }
}

function fileName(agent: HookAgent): string {
  return agent === "claude" ? "settings.json" : agent === "copilot" ? "coucou.json" : "hooks.json";
}

/** One agent's card. `start` opens the preview right away ("connect" / "update" from a link). */
function agentCard(agent: HookAgent, ctx: PageCtx, start?: string): HTMLElement {
  const name = HOOK_NAME[agent];
  let busy = false; // a preview or a result is on screen: data changes must not redraw it
  let el = draw();

  ctx.onData(() => {
    if (busy) return;
    const next = draw();
    el.replaceWith(next);
    el = next;
  });

  function draw(): HTMLElement {
    const read = hooks[agent];
    const state = agentLink(read, clis, agent);
    const status = read?.status;
    const body: (Node | null)[] = [];

    if (state === "relay") {
      body.push(notice("warn", tr(
        "Coucou 的轉送程式 coucou-hook.exe 不在該在的地方，所以現在什麼都不能連結。請重新啟動 Coucou；如果還是一樣，用 cargo build -p coucou-hook 重新建置。",
        "Coucou's relay, coucou-hook.exe, is not where it should be, so nothing can be connected right now. Restart Coucou; if that does not help, build it with cargo build -p coucou-hook.",
      )));
    }
    if (state === "unreadable") {
      body.push(
        notice("err", read?.error ?? ""),
        h("p", { class: "hint", text: trf(
          "Coucou 不會覆寫讀不懂的檔案。請先修好你的 {file}（或把它移到別處），再回來連結。",
          "Coucou never overwrites a file it cannot read. Fix your {file} (or move it away) first, then come back to connect.",
          { file: fileName(agent) },
        ) }),
      );
    }
    // An entry an older Coucou wrote counts as not connected: say why.
    if (agent === "antigravity" && status && !status.installed && /^- /m.test(read?.diff ?? "")) {
      body.push(h("p", { class: "hint", text: tr(
        "你之前用舊版 Coucou 連結過 Antigravity。再連結一次，就會把舊的設定換成新的。",
        "You connected Antigravity with an older Coucou. Connect again to replace the old entry.",
      ) }));
    }

    if (agent === "copilot" && status?.installed) {
      // Copilot 1.0.91 runs the PermissionRequest hook even under --yolo, so a
      // session meant to run unattended would stop at a card for every tool.
      // The switch rewrites Coucou's own hook file without that hook.
      const feedback = h("div", {});
      body.push(h(
        "div",
        { class: "switch-row" },
        toggle(settings.copilotPermissionCards, async (v) => {
          settings.copilotPermissionCards = v;
          await save();
          try {
            const preview = await Bridge.hooksPreview("copilot", true);
            if (preview) await Bridge.hooksApply("copilot", true, preview.fingerprint);
          } catch (err) {
            clear(feedback);
            feedback.append(notice("err", errText(err)));
            return;
          }
          void refreshHook("copilot");
        }, tr("每次用工具前先問我", "Ask me before each tool")),
        h("div", {},
          h("div", { class: "switch-label", text: tr("每次用工具前，先在瀏海島上問我", "Ask me in the island before each tool runs") }),
          h("div", { class: "field-help", text: tr(
            "用 --yolo 啟動、想讓它自己跑完的工作階段，請關掉，否則每一步都會跳一張卡片。",
            "Turn off for sessions started with --yolo, so they run without a card for every step.",
          ) }),
        ),
      ), feedback);
    }

    const next = row();
    if (state === "update") next.append(h("button", { type: "button", class: "primary", text: tr("更新連結…", "Update hooks…"), onclick: () => preview(true) }));
    if (state === "unconnected") next.append(h("button", { type: "button", class: "primary", text: tr("連結…", "Connect…"), onclick: () => preview(true) }));
    if (state === "nocli") {
      next.append(
        h("button", { type: "button", class: "primary", text: trf("先安裝 {name} →", "Install {name} first →", { name }), onclick: () => ctx.go("install", `cli-${HOOK_CLI[agent]}`) }),
        h("button", { type: "button", class: "link", text: tr("仍要連結…", "Connect anyway…"), title: tr("CLI 裝在 Coucou 找不到的地方時用", "For a CLI installed where Coucou cannot find it"), onclick: () => preview(true) }),
      );
    }
    if (state === "checking") next.append(h("span", { class: "hint", text: tr("正在讀取設定檔…", "Reading its settings file…") }));
    if (next.childElementCount) body.push(next);

    return card({
      anchor: `agent-${agent}`,
      title: name,
      badge: linkBadgeEl(state),
      lead: lead(agent),
      body,
      details: status ? () => details(state) : null,
    });
  }

  function details(state: LinkState): Node {
    const status = hooks[agent]!.status!;
    const box = h("div", { class: "details-grid" },
      h("span", { class: "k", text: tr("設定檔", "Settings file") }), h("span", { class: "path", text: status.settingsPath }),
      h("span", { class: "k", text: "Relay" }), h("span", { class: "path-row" }, h("span", { class: "path", text: status.hookPath }), statusDot(status.hookReady)),
    );
    const actions = row();
    if (status.installed || state === "update") {
      actions.append(
        h("button", { type: "button", text: tr("重新安裝…", "Reinstall hooks…"), disabled: !status.hookReady, onclick: () => preview(true) }),
        h("button", { type: "button", class: "danger", text: tr("移除連結…", "Uninstall…"), onclick: () => preview(false) }),
      );
    }
    return h("div", {}, box, actions.childElementCount ? actions : null);
  }

  async function preview(install: boolean) {
    busy = true;
    const body = h("div", { class: "card-flow" });
    const shell = card({ anchor: `agent-${agent}`, title: name, badge: linkBadgeEl(agentLink(hooks[agent], clis, agent)), body: [body] });
    el.replaceWith(shell);
    el = shell;
    const back = () => {
      busy = false;
      const next = draw();
      el.replaceWith(next);
      el = next;
    };

    let plan;
    try {
      plan = await Bridge.hooksPreview(agent, install);
    } catch (err) {
      // An unreadable or invalid file stops here rather than being treated
      // as empty and written over.
      body.append(notice("err", errText(err)), row(h("button", { type: "button", text: tr("返回", "Back"), onclick: back })));
      return;
    }
    if (!plan) {
      body.append(notice("warn", tr("瀏覽器預覽不會讀寫檔案。", "The browser preview does not read or write files.")), row(h("button", { type: "button", text: tr("返回", "Back"), onclick: back })));
      return;
    }
    body.append(
      h("p", { class: "hint", text: install
        ? trf("下面就是 {file} 會改的地方。你自己的 hooks 都不會動。", "This is exactly what will change in your {file}. Your own hooks are left untouched.", { file: fileName(agent) })
        : tr("這只會移除 Coucou 自己的項目，你自己的 hooks 都不會動。", "This removes Coucou's entries only. Your own hooks are left untouched.") }),
      h("p", { class: "field-help", text: tr("+ 開頭的是新增的行，- 開頭的是移除的行，其他內容維持原樣。", "Lines with + are added, lines with - are removed. Everything else in the file stays as it is.") }),
      // Rust's "No change." is compared elsewhere, so it is translated here.
      plan.diff.trim() === "No change." // i18n-ok: Rust's own answer, compared
        ? h("p", { class: "hint", text: tr("檔案已經是最新的，不會改任何地方。", "The file is already up to date; nothing will change.") })
        : renderDiff(plan.diff),
      h("p", { class: "path", text: `${tr("備份", "Backup")} → ${plan.backup}` }),
    );
    const confirm = h("button", { type: "button", class: install ? "primary" : "danger", text: install ? tr("備份並寫入", "Back up and write") : tr("備份並移除", "Back up and remove") }) as HTMLButtonElement;
    const feedback = h("div", {});
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(agent, install, plan.fingerprint);
        clear(body);
        body.append(notice("ok", install
          ? trf("完成。原本的檔案存成 {backup}。開一個新的 {name} 工作階段，就會出現在瀏海島上。", "Done. The previous file was saved as {backup}. Start a new {name} session to see it in the island.", { backup, name })
          : trf("已移除。原本的檔案存成 {backup}。", "Removed. The previous file was saved as {backup}.", { backup })));
        window.setTimeout(() => {
          busy = false;
          void refreshHook(agent);
        }, 2600);
      } catch (err) {
        confirm.disabled = false;
        clear(feedback);
        feedback.append(notice("err", trf("寫不進去：{err}", "Could not write: {err}", { err: errText(err) })));
      }
    });
    body.append(row(confirm, h("button", { type: "button", text: tr("取消", "Cancel"), onclick: back })), feedback);
  }

  if (start === "connect" || start === "update") void preview(true);
  return el;
}

/**
 * How to start a CLI so the island can type into its terminal. Shown, never
 * applied: the PowerShell profile is the person's own file.
 */
function terminalHelp(): Node {
  const hookPath = hooks.claude?.status?.hookPath ?? hooks.copilot?.status?.hookPath ?? "";
  const pty = hookPath.replace(/coucou-hook\.exe$/i, "coucou-pty.exe") || "coucou-pty.exe";
  const snippet = [
    tr("# 透過 coucou-pty 啟動 CLI，瀏海島就能在這個終端機裡打字。", "# Start the CLI through coucou-pty and the island can type into this terminal."),
    tr("# 在 cg 這類包裝函式裡，把最後一行：", "# In a wrapper function such as cg, replace the last line:"),
    "#     copilot --yolo @args",
    tr("# 換成：", "# with:"),
    `$pty = "${pty}"`,
    "if (Test-Path $pty) { & $pty -- copilot --yolo @args } else { copilot --yolo @args }",
  ].join("\n");
  const feedback = h("span", { class: "hint" });
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "hint", text: tr(
      "你自己在 PowerShell 啟動的 CLI，也可以接收瀏海島送來的指令：透過 coucou-pty 啟動它，看起來和用起來都一樣，而它在瀏海島上的工作階段會多一個輸入框，等 CLI 閒下來時就把字打進那個終端機。copilot、claude 或任何已連結的終端機 CLI 都可以。",
      "A CLI you start yourself in PowerShell can take instructions from the island too. Start it through coucou-pty: it looks and behaves the same, and its session in the island gets a text field that types into that terminal once the CLI is idle. Works with copilot, claude, or any other terminal CLI that is connected above.",
    ) }),
    h("div", { class: "diff", text: snippet }),
    row(
      h("button", {
        type: "button",
        text: tr("複製", "Copy"),
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(snippet);
            feedback.textContent = tr("已複製。", "Copied.");
          } catch {
            feedback.textContent = tr("請選取上面的文字自己複製。", "Select the text above and copy it.");
          }
        },
      }),
      feedback,
    ),
  );
}

export const connectPage: Page = {
  id: "connect",
  icon: "connect",
  name: () => tr("連結 Agent", "Connect agents"),
  render(ctx) {
    return h(
      "div",
      { class: "page-body" },
      pageHeader(
        "connect",
        tr("連結 Agent", "Connect agents"),
        tr(
          "讓 Coucou 看見你的 Claude Code、Copilot CLI、Antigravity 工作階段，它們的提問和權限請求會出現在瀏海島上。",
          "Let Coucou watch your Claude Code, Copilot CLI and Antigravity sessions, so their questions and permission requests show up in the island.",
        ),
        () => h("div", { class: "stack" },
          h("p", { text: tr(
            "Coucou 會在每個工具自己的設定檔裡加一個小小的「hook」。agent 開始一個步驟、提問或需要你的許可時，hook 會通知 Coucou；Coucou 不會自己改變 agent 的行為。",
            "Coucou adds a small \"hook\" to each tool's own settings file. The hook tells Coucou whenever the agent starts a step, asks a question or needs your permission; Coucou never changes what the agent does on its own.",
          ) }),
          h("p", { text: tr(
            "寫入之前，你會先看到確切要改的內容，原本的檔案也會先備份。隨時都可以移除。",
            "Before anything is written you see exactly what changes, and the old file is backed up first. You can remove it any time.",
          ) }),
          h("p", { text: tr(
            "只要連結你有在用的工具。連結之後，開一個新的工作階段才會生效。",
            "Connect only the tools you use. After connecting, start a new session of that tool to pick the hook up.",
          ) }),
        ),
      ),
      ...HOOK_AGENTS.map((a) => agentCard(a, ctx, ctx.anchor === `agent-${a}` ? ctx.action : undefined)),
      disclosure(tr("進階：在你自己開的終端機裡打字", "Advanced: type into terminals you start yourself"), terminalHelp, false, "advanced page-fold"),
    );
  },
};
