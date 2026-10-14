// Agents Coucou starts and drives itself (ACP, Codex, Claude Code,
// Antigravity): picked in the chat bar, or run as Teamwork members.

import { Bridge } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import { DEFAULT_AGENT, type AgentProfile } from "../../core/state";
import { h, clear } from "../../views/dom";
import type { Page } from "../nav";
import { agentKey, agentNeedsKey } from "../status";
import { present, save, setPresent, settings, teamAgents } from "../store";
import { badge, card, errText, field, notice, pageHeader, row } from "../ui";

export { agentKey };

/** Copilot CLI on the llm-share endpoint, the way the `cg` PowerShell function starts it. */
function llmShare(name: string, model: string): AgentProfile {
  return {
    ...DEFAULT_AGENT,
    id: "",
    name,
    protocol: "acp",
    env: {
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_WIRE_API: "responses",
      COPILOT_PROVIDER_BASE_URL: "https://llm-share.duotify.com/v1",
      COPILOT_PROVIDER_API_KEY: "{secret}",
      COPILOT_MODEL: model,
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "999424",
      COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "131072",
    },
  };
}

/** Starting points for "Add". */
function presets(): { label: string; make: () => AgentProfile }[] {
  return [
    { label: tr("Copilot CLI（GitHub 登入）", "Copilot CLI (GitHub login)"), make: () => ({ ...DEFAULT_AGENT, id: "", env: {} }) },
    { label: tr("cg · llm-share 上的 Copilot CLI，glm-5.3-flash", "cg · Copilot CLI on llm-share, glm-5.3-flash"), make: () => llmShare("cg", "glm-5.3-flash") },
    { label: tr("cg2 · llm-share 上的 Copilot CLI，deepseek-v4.1-flash", "cg2 · Copilot CLI on llm-share, deepseek-v4.1-flash"), make: () => llmShare("cg2", "deepseek-v4.1-flash") },
    {
      label: tr("Codex（codex app-server，ChatGPT 登入）", "Codex (codex app-server, ChatGPT login)"),
      make: () => ({ id: "", name: "Codex", command: "codex", args: ["app-server"], env: {}, cwd: "", protocol: "codex" }),
    },
    {
      label: tr("Antigravity（agy，你的 Google 登入）", "Antigravity (agy, your Google login)"),
      make: () => ({ id: "", name: "Antigravity", command: "agy", args: [], env: {}, cwd: "", protocol: "agy" }),
    },
    {
      label: tr("Claude Code（你的 Claude 登入）", "Claude Code (your Claude login)"),
      make: () => ({ id: "", name: "Claude Code", command: "claude", args: [], env: {}, cwd: "", protocol: "claude" }),
    },
    {
      label: tr("Copilot CLI 用你自己的端點（BYOK）", "Copilot CLI with your own endpoint (BYOK)"),
      make: () => ({
        ...DEFAULT_AGENT, id: "", name: "Copilot (BYOK)",
        env: {
          COPILOT_PROVIDER_TYPE: "openai",
          COPILOT_PROVIDER_WIRE_API: "responses",
          COPILOT_PROVIDER_BASE_URL: "https://…/v1",
          COPILOT_PROVIDER_API_KEY: "{secret}",
          COPILOT_MODEL: "",
        },
      }),
    },
    { label: tr("其他 ACP agent（自訂）", "Other ACP agent (custom)"), make: () => ({ id: "", name: "Agent", command: "", args: [], env: {}, cwd: "" }) },
  ];
}

function uniqueAgentId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  let id = base;
  for (let n = 2; settings.agents.some((a) => a.id === id); n++) id = `${base}-${n}`;
  return id;
}

function protocolName(a: AgentProfile): string {
  switch (a.protocol ?? "acp") {
    case "codex": return "Codex";
    case "claude": return "Claude Code";
    case "agy": return "Antigravity";
    default: return a.command.toLowerCase().includes("copilot") ? "Copilot CLI" : "ACP";
  }
}

export const agentsPage: Page = {
  id: "agents",
  icon: "agents",
  name: () => "Agents",
  render() {
    const list = h("div", { class: "stack" });

    function redraw() {
      clear(list);
      for (const a of settings.agents) list.append(agentCard(a));
      const all = presets();
      const preset = h("select", { title: tr("從哪一種開始", "Start from") }) as HTMLSelectElement;
      all.forEach((pr, i) => preset.append(h("option", { value: String(i), text: pr.label })));
      const add = h("button", { type: "button", text: tr("新增", "Add") });
      add.addEventListener("click", () => {
        const a = all[Number(preset.value)].make();
        a.id = uniqueAgentId(a.name);
        settings.agents = [...settings.agents, a];
        void save();
        redraw();
      });
      list.append(h("div", { class: "add-row" }, h("span", { class: "add-label", text: tr("新增 Agent", "Add an agent") }), preset, add));
    }

    function agentCard(a: AgentProfile): HTMLElement {
      const feedback = h("div", {});
      // Same reason as the chat models: every save echoes new objects back.
      const live = (): AgentProfile => settings.agents.find((x) => x.id === a.id) ?? a;
      const keyName = agentKey(a);
      const keyBadge = () => {
        if (!agentNeedsKey(live())) return null;
        return present[keyName] ? badge("ok", tr("金鑰已存", "Key saved")) : badge("todo", tr("需要金鑰", "Needs a key"));
      };
      const badgeSlot = h("span", { class: "badges" });
      const syncBadge = () => {
        clear(badgeSlot);
        const b = keyBadge();
        if (b) badgeSlot.append(b);
        if (!live().command.trim()) badgeSlot.append(badge("todo", tr("沒有指令", "No command")));
      };
      syncBadge();

      const protocol = h("select", { title: tr("Coucou 用什麼方式跟它說話", "How Coucou talks to it") }) as HTMLSelectElement;
      protocol.append(
        h("option", { value: "acp", text: "ACP" }),
        h("option", { value: "codex", text: "Codex app-server" }), // i18n-ok: a protocol name
        h("option", { value: "claude", text: "Claude Code (stream-json)" }), // i18n-ok: a protocol name
        h("option", { value: "agy", text: tr("Antigravity（agy 無介面模式）", "Antigravity (agy headless)") }),
      );
      protocol.value = a.protocol ?? "acp";
      protocol.addEventListener("change", () => { live().protocol = protocol.value as AgentProfile["protocol"]; void save(); });

      // The model it runs unless a team member names another. The list is the
      // agent's own: asked with a handshake, so nothing is spent.
      const modelList = h("datalist", { id: `agent-models-${a.id}` }) as HTMLDataListElement;
      const model = h("input", { type: "text", value: a.model ?? "", placeholder: tr("用它自己的預設", "its own default"), list: `agent-models-${a.id}`, spellcheck: "false", class: "grow-input" }) as HTMLInputElement;
      model.addEventListener("change", () => { live().model = model.value.trim(); void save(); });
      const listModels = h("button", { type: "button", text: tr("列出模型", "List models") }) as HTMLButtonElement;
      listModels.addEventListener("click", async () => {
        listModels.disabled = true;
        clear(feedback);
        try {
          const found = await Bridge.agentModels(live());
          clear(modelList);
          for (const m of found) modelList.append(h("option", { value: m.id, text: m.label }));
          feedback.append(notice("ok", trf("找到 {n} 個模型，在「模型」欄選一個。", "{n} models — pick one in the Model field.", { n: found.length })));
        } catch (err) {
          feedback.append(notice("err", errText(err)));
        } finally {
          listModels.disabled = false;
        }
      });

      const keyField = h("input", {
        type: "password",
        placeholder: present[keyName] ? tr("••••••••••••（已存）", "••••••••••••  (stored)") : tr("貼上 {secret} 代表的金鑰", "paste the key {secret} stands for"),
        autocomplete: "off",
        spellcheck: "false",
        class: "grow-input",
      }) as HTMLInputElement;
      const keySave = h("button", { type: "button", class: "primary", text: tr("儲存金鑰", "Save key") });
      keySave.addEventListener("click", async () => {
        const value = keyField.value.trim();
        if (!value) return;
        clear(feedback);
        try {
          await Bridge.secretSet(keyName, value);
          setPresent(keyName, true);
          keyField.value = "";
          keyField.placeholder = tr("••••••••••••（已存）", "••••••••••••  (stored)");
          syncBadge();
        } catch (err) {
          feedback.append(notice("err", trf("存不進去：{err}", "Could not save: {err}", { err: errText(err) })));
        }
      });
      const keyRow = field(tr("金鑰", "Key"), [keyField, keySave], tr("環境變數裡的 {secret} 會換成這把金鑰。", "{secret} in the environment is replaced by this key."));
      keyRow.style.display = agentNeedsKey(a) ? "" : "none";

      const test = h("button", { type: "button", text: tr("測試", "Test") }) as HTMLButtonElement;
      test.addEventListener("click", async () => {
        test.disabled = true;
        clear(feedback);
        feedback.append(h("p", { class: "hint", text: tr("正在啟動 agent 並握手…", "Starting the agent and shaking hands…") }));
        try {
          const reply = await Bridge.acpTest(live());
          clear(feedback);
          feedback.append(notice("ok", reply));
        } catch (err) {
          clear(feedback);
          feedback.append(notice("err", errText(err)));
        } finally {
          test.disabled = false;
        }
      });

      const usedBy = (teamAgents?.doc.agents ?? []).filter((t) => t.base === a.id).map((t) => t.name);
      return card({
        anchor: `agent-profile-${a.id}`,
        title: a.name,
        meta: `${protocolName(a)} · ${a.model || tr("它自己的預設模型", "its own default model")}`,
        badge: badgeSlot,
        body: [
          field(tr("說話方式", "Speaks"), protocol),
          field(tr("模型", "Model"), [model, modelList, listModels]),
          keyRow,
          row(test, h("span", { class: "hint", text: tr("在聊天列選它，就能跟它說話", "pick it in the chat bar to talk to it") })),
          feedback,
        ],
        advanced: () => advanced(a, live, keyRow, syncBadge),
        advancedOpen: !a.command.trim(),
        details: () => h("div", { class: "stack" },
          h("div", { class: "details-grid" },
            h("span", { class: "k", text: "id" }), h("span", { class: "path", text: a.id }),
            usedBy.length ? h("span", { class: "k", text: tr("團隊 Agent", "Team agents") }) : null,
            usedBy.length ? h("span", { text: usedBy.join(", ") }) : null,
          ),
          row(deleteButton(a, redraw)),
        ),
      });
    }

    redraw();
    return h(
      "div",
      { class: "page-body" },
      pageHeader(
        "agents",
        "Agents",
        tr("Coucou 會替你啟動、操作的 coding agent：在聊天列挑一個，或當 Teamwork 的成員。", "Coding agents Coucou starts and drives for you: pick one in the chat bar, or use it as a Teamwork member."),
        () => tr(
          "跟「連結 Agent」不一樣（那是 Coucou 在旁邊看你自己開的工作階段），這裡的 agent 是 Coucou 自己執行的：透過 Agent Client Protocol（Copilot CLI）、Codex 的 app server、Claude Code 或 Antigravity。它們做事時工具步驟會即時出現，需要許可的會在瀏海島上問你。Teamwork 的成員就是用這些 agent 跑的。",
          "Unlike \"Connect agents\" (Coucou watches sessions you start yourself), these are agents Coucou runs itself — over the Agent Client Protocol (Copilot CLI), Codex's app server, Claude Code or Antigravity. Their tool calls show up as they work, and anything that needs permission asks in the island. Teamwork members run as one of these.",
        ),
      ),
      list,
    );
  },
};

function deleteButton(a: AgentProfile, redraw: () => void): HTMLElement {
  return h("button", {
    type: "button",
    class: "danger",
    text: tr("刪除", "Delete"),
    onclick: async () => {
      settings.agents = settings.agents.filter((x) => x.id !== a.id);
      if (settings.activeProvider === agentKey(a)) settings.activeProvider = settings.providers[0]?.id ?? "";
      try { await Bridge.secretClear(agentKey(a)); } catch { /* nothing stored */ }
      void save();
      redraw();
    },
  });
}

/** Command, arguments, folder, environment. */
function advanced(a: AgentProfile, live: () => AgentProfile, keyRow: HTMLElement, syncBadge: () => void): Node {
  const name = h("input", { type: "text", value: a.name, spellcheck: "false" }) as HTMLInputElement;
  name.addEventListener("change", () => { live().name = name.value.trim() || a.id; void save(); });
  const command = h("input", { type: "text", value: a.command, placeholder: "copilot", spellcheck: "false" }) as HTMLInputElement;
  command.addEventListener("change", () => { live().command = command.value.trim(); void save(); syncBadge(); });
  const args = h("input", { type: "text", value: a.args.join(" "), placeholder: "--acp --stdio", spellcheck: "false", class: "grow-input" }) as HTMLInputElement;
  args.addEventListener("change", () => { live().args = args.value.split(/\s+/).filter(Boolean); void save(); });
  const cwd = h("input", { type: "text", value: a.cwd, placeholder: tr("使用者資料夾", "home folder"), spellcheck: "false", class: "grow-input" }) as HTMLInputElement;
  cwd.addEventListener("change", () => { live().cwd = cwd.value.trim(); void save(); });

  // One KEY=VALUE per line; {secret} stands for the key saved above.
  const env = h("textarea", {
    rows: "4",
    spellcheck: "false",
    class: "env",
    placeholder: "COPILOT_PROVIDER_BASE_URL=https://…/v1\nCOPILOT_PROVIDER_API_KEY={secret}",
  }) as HTMLTextAreaElement;
  env.value = Object.entries(a.env).map(([k, v]) => `${k}=${v}`).join("\n");
  env.addEventListener("change", () => {
    const next: Record<string, string> = {};
    for (const line of env.value.split("\n")) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      next[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    live().env = next;
    keyRow.style.display = agentNeedsKey(live()) ? "" : "none";
    syncBadge();
    void save();
  });

  return h(
    "div",
    { class: "stack" },
    field(tr("名稱", "Name"), name),
    field(tr("指令", "Command"), [command, args]),
    field(tr("資料夾", "Folder"), cwd),
    field(tr("環境變數", "Environment"), env, tr("一行一個 KEY=VALUE；金鑰的位置寫 {secret}。", "One KEY=VALUE per line; write {secret} where the key belongs.")),
  );
}
