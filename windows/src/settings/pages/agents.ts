// Agents Coucou starts and drives itself (ACP, Codex, Claude Code, Antigravity).

import { Bridge } from "../../core/bridge";
import { DEFAULT_AGENT, type AgentProfile } from "../../core/state";
import { h, clear } from "../../views/dom";
import { settings, save } from "../store";
import { statusDot } from "../ui";

export function agentKey(a: AgentProfile): string {
  return `agent:${a.id}`;
}

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

/** Starting points for "Add agent". */
const AGENT_PRESETS: { label: string; make: () => AgentProfile }[] = [
  { label: "Copilot CLI (GitHub login)", make: () => ({ ...DEFAULT_AGENT, id: "", env: {} }) },
  { label: "cg · Copilot CLI on llm-share, glm-5.3-flash", make: () => llmShare("cg", "glm-5.3-flash") },
  { label: "cg2 · Copilot CLI on llm-share, deepseek-v4.1-flash", make: () => llmShare("cg2", "deepseek-v4.1-flash") },
  {
    label: "Codex (codex app-server, ChatGPT login)",
    make: () => ({ id: "", name: "Codex", command: "codex", args: ["app-server"], env: {}, cwd: "", protocol: "codex" }),
  },
  {
    label: "Antigravity (agy, your Google login)",
    make: () => ({ id: "", name: "Antigravity", command: "agy", args: [], env: {}, cwd: "", protocol: "agy" }),
  },
  {
    label: "Claude Code (your Claude login)",
    make: () => ({ id: "", name: "Claude Code", command: "claude", args: [], env: {}, cwd: "", protocol: "claude" }),
  },
  {
    label: "Copilot CLI with your own endpoint (BYOK)",
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
  { label: "Other ACP agent (custom)", make: () => ({ id: "", name: "Agent", command: "", args: [], env: {}, cwd: "" }) },
];

function uniqueAgentId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  let id = base;
  for (let n = 2; settings.agents.some((a) => a.id === id); n++) id = `${base}-${n}`;
  return id;
}

export function agentsSection(present: Record<string, boolean>): HTMLElement {
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Agents" })),
    h("div", {
      class: "hint",
      text: "Coding agents the island can start and drive itself — over the Agent Client Protocol (Copilot CLI, with GitHub or your own endpoint), Codex's app server, Claude Code's stream-json, or Antigravity's headless mode. Pick one in the chat bar and your question goes to it; in Teamwork, members run as one of these. Its tool calls show up as it works, and anything it needs permission for asks on the island. Keys go in the Windows Credential Manager; write {secret} where a key belongs in the environment.",
    }),
    list,
  );

  function redraw() {
    clear(list);
    for (const a of settings.agents) list.append(agentCard(a));
    const preset = h("select", {}) as HTMLSelectElement;
    AGENT_PRESETS.forEach((pr, i) => preset.append(h("option", { value: String(i), text: pr.label })));
    const add = h("button", { text: "Add agent" });
    add.addEventListener("click", () => {
      const a = AGENT_PRESETS[Number(preset.value)].make();
      a.id = uniqueAgentId(a.name);
      settings.agents = [...settings.agents, a];
      void save();
      redraw();
    });
    list.append(h("div", { class: "row" }, h("label", { text: "New" }), preset, add));
  }

  function agentCard(a: AgentProfile): HTMLElement {
    const card = h("div", { class: "provider" });
    const feedback = h("div", {});
    // Same reason as the providers: every save echoes new objects back.
    const live = (): AgentProfile => settings.agents.find((x) => x.id === a.id) ?? a;

    const name = h("input", { type: "text", value: a.name, style: "width:180px", spellcheck: "false" }) as HTMLInputElement;
    name.addEventListener("change", () => { live().name = name.value.trim() || a.id; void save(); });
    const remove = h("button", { class: "danger", text: "Delete" });
    remove.addEventListener("click", async () => {
      settings.agents = settings.agents.filter((x) => x.id !== a.id);
      if (settings.activeProvider === agentKey(a)) settings.activeProvider = settings.providers[0]?.id ?? "";
      try { await Bridge.secretClear(agentKey(a)); } catch { /* nothing stored */ }
      void save();
      redraw();
    });

    const protocol = h("select", { title: "How Coucou talks to it" }) as HTMLSelectElement;
    protocol.append(
      h("option", { value: "acp", text: "ACP" }),
      h("option", { value: "codex", text: "Codex app-server" }),
      h("option", { value: "claude", text: "Claude Code (stream-json)" }),
      h("option", { value: "agy", text: "Antigravity (agy headless)" }),
    );
    protocol.value = a.protocol ?? "acp";
    protocol.addEventListener("change", () => { live().protocol = protocol.value as AgentProfile["protocol"]; void save(); });
    // The model it runs unless a team member names another. The list is the
    // agent's own: asked with a handshake, so nothing is spent.
    const modelList = h("datalist", { id: `models-${a.id}` }) as HTMLDataListElement;
    const model = h("input", { type: "text", value: a.model ?? "", placeholder: "its own default", list: `models-${a.id}`, style: "width:240px", spellcheck: "false" }) as HTMLInputElement;
    model.addEventListener("change", () => { live().model = model.value.trim(); void save(); });
    const listModels = h("button", { text: "List models" });
    listModels.addEventListener("click", async () => {
      listModels.disabled = true;
      clear(feedback);
      try {
        const found = await Bridge.agentModels(live());
        clear(modelList);
        for (const m of found) modelList.append(h("option", { value: m.id, text: m.label }));
        feedback.append(h("div", { class: "notice ok", text: `${found.length} models — pick one in the Model field.` }));
      } catch (err) {
        feedback.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
      } finally {
        listModels.disabled = false;
      }
    });
    card.append(modelList);
    const command = h("input", { type: "text", value: a.command, placeholder: "copilot", style: "width:220px", spellcheck: "false" }) as HTMLInputElement;
    command.addEventListener("change", () => { live().command = command.value.trim(); void save(); });
    const args = h("input", { type: "text", value: a.args.join(" "), placeholder: "--acp --stdio", style: "flex:1 1 auto;min-width:0", spellcheck: "false" }) as HTMLInputElement;
    args.addEventListener("change", () => { live().args = args.value.split(/\s+/).filter(Boolean); void save(); });
    const cwd = h("input", { type: "text", value: a.cwd, placeholder: "home folder", style: "flex:1 1 auto;min-width:0", spellcheck: "false" }) as HTMLInputElement;
    cwd.addEventListener("change", () => { live().cwd = cwd.value.trim(); void save(); });

    // One KEY=VALUE per line; {secret} stands for the key saved below.
    const env = h("textarea", {
      rows: "4", spellcheck: "false", style: "flex:1 1 auto;min-width:0;font:11.5px var(--mono)",
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
      void save();
    });

    const keyName = agentKey(a);
    const keyField = h("input", { type: "password", placeholder: present[keyName] ? "••••••••••••  (stored)" : "paste the key {secret} stands for", style: "flex:1 1 auto;min-width:0", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const keyDot = statusDot(present[keyName] ?? false);
    const keySave = h("button", { class: "primary", text: "Save key" });
    keySave.addEventListener("click", async () => {
      const value = keyField.value.trim();
      if (!value) return;
      clear(feedback);
      try {
        await Bridge.secretSet(keyName, value);
        present[keyName] = true;
        keyField.value = "";
        keyField.placeholder = "••••••••••••  (stored)";
        keyDot.style.background = "#22c55e";
      } catch (err) {
        feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
      }
    });

    const test = h("button", { text: "Test" });
    test.addEventListener("click", async () => {
      test.disabled = true;
      clear(feedback);
      feedback.append(h("div", { class: "hint", text: "Starting the agent and shaking hands…" }));
      try {
        const reply = await Bridge.acpTest(live());
        clear(feedback);
        feedback.append(h("div", { class: "notice ok", text: reply }));
      } catch (err) {
        clear(feedback);
        feedback.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
      } finally {
        test.disabled = false;
      }
    });

    card.append(
      h("div", { class: "row" }, name, h("span", { class: "spacer" }), remove),
      h("div", { class: "row" }, h("label", { text: "Speaks" }), protocol),
      h("div", { class: "row" }, h("label", { text: "Model" }), model, listModels),
      h("div", { class: "row" }, h("label", { text: "Command" }), command, args),
      h("div", { class: "row" }, h("label", { text: "Folder" }), cwd),
      h("div", { class: "row", style: "align-items:flex-start" }, h("label", { text: "Environment" }), env),
      h("div", { class: "row" }, h("label", { text: "Key" }), keyField, keySave, keyDot),
      h("div", { class: "row" }, test, h("span", { class: "path", text: a.id }), h("span", { class: "hint", text: "pick it in the chat bar to talk to it" })),
      feedback,
    );
    return card;
  }

  redraw();
  return section;
}
