// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookAgent, type HookStatus } from "../core/bridge";
import { DEFAULT_AGENT, DEFAULT_PROVIDER, DEFAULT_SETTINGS, type AgentProfile, type Provider, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── CLI hook sections (Claude Code, Copilot CLI) ──────────────────────────────

interface AgentCopy {
  agent: HookAgent;
  title: string;
  /** The file the hooks go into, as the row label. */
  file: string;
  installed: string;
  missing: string;
}

const AGENT_COPY: AgentCopy[] = [
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

function agentSection(copy: AgentCopy, status: HookStatus): HTMLElement {
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
function terminalSection(hookPath: string): HTMLElement {
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

// ── Providers section ─────────────────────────────────────────────────────────

/** Credential Manager key of a provider; the default Claude entry also honours the pre-provider key. */
function providerKey(p: Provider): string {
  return `provider:${p.id}`;
}

function openaiPreset(name: string, baseUrl: string, model: string, extra: Partial<Provider> = {}): Provider {
  return {
    ...DEFAULT_PROVIDER, id: "", name, kind: "openai", baseUrl, model, wireApi: "chat", auth: "", headers: {}, capabilities: {},
    ...extra,
  };
}

/** Starting points for "Add provider". The id is filled in from the name. */
const PRESETS: { label: string; make: () => Provider }[] = [
  { label: "Claude (Anthropic)", make: () => ({ ...DEFAULT_PROVIDER, id: "", headers: {}, capabilities: {} }) },
  { label: "OpenAI", make: () => openaiPreset("OpenAI", "https://api.openai.com/v1", "gpt-5", { capabilities: { pdf: true } }) },
  { label: "OpenRouter", make: () => openaiPreset("OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-5") },
  { label: "Ollama (local)", make: () => openaiPreset("Ollama", "http://localhost:11434/v1", "qwen3:32b", { auth: "none" }) },
  { label: "LM Studio (local)", make: () => openaiPreset("LM Studio", "http://localhost:1234/v1", "local-model", { auth: "none" }) },
  { label: "Azure OpenAI", make: () => openaiPreset("Azure OpenAI", "https://<resource>.openai.azure.com/openai/v1", "gpt-5", { auth: "header:api-key" }) },
  { label: "OpenAI-compatible (custom)", make: () => openaiPreset("Custom", "", "") },
  { label: "Responses API (custom)", make: () => openaiPreset("Custom (Responses)", "", "", { wireApi: "responses" }) },
];

/** An id from the name — letters, digits, dashes — that no other provider has. */
function uniqueId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  let id = base;
  for (let n = 2; settings.providers.some((p) => p.id === id); n++) id = `${base}-${n}`;
  return id;
}

function providersSection(present: Record<string, boolean>): HTMLElement {
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Chat providers" })),
    h("div", {
      class: "hint",
      text: "Where the chat sends its questions: Claude, OpenAI, or anything that speaks the OpenAI shape — OpenRouter, Azure, a local Ollama or LM Studio, your own proxy. Keys are stored in the Windows Credential Manager, never on disk.",
    }),
    list,
  );

  function redraw() {
    clear(list);
    for (const p of settings.providers) list.append(providerCard(p));
    list.append(addRow());
  }

  function addRow(): HTMLElement {
    const preset = h("select", {}) as HTMLSelectElement;
    PRESETS.forEach((pr, i) => preset.append(h("option", { value: String(i), text: pr.label })));
    const add = h("button", { text: "Add provider" });
    add.addEventListener("click", () => {
      const p = PRESETS[Number(preset.value)].make();
      p.id = uniqueId(p.name);
      settings.providers = [...settings.providers, p];
      if (settings.providers.length === 1) settings.activeProvider = p.id;
      void save();
      redraw();
    });
    return h("div", { class: "row" }, h("label", { text: "New" }), preset, add);
  }

  function providerCard(p: Provider): HTMLElement {
    const card = h("div", { class: "provider" });
    const feedback = h("div", {});
    const isAnthropic = () => p.kind === "anthropic";
    // Every save makes Rust echo the settings back, and that echo replaces
    // `settings` — including its provider objects. Editing the `p` this card
    // was built with would then change a copy nobody saves (the endpoint and
    // model typed in looked saved, tested fine, and were blank on disk), so
    // every edit goes to whichever object currently carries this id.
    const live = (): Provider => settings.providers.find((x) => x.id === p.id) ?? p;

    // Which one the chat talks to — said in words too, because a filled-in
    // card that is not the one in use is the easiest thing to misread here.
    const use = h("input", { type: "radio", name: "active-provider", title: "Use this provider" }) as HTMLInputElement;
    const inUse = h("span", { class: "hint", text: settings.activeProvider === p.id ? "in use" : "" });
    use.checked = settings.activeProvider === p.id;
    use.addEventListener("change", () => {
      if (!use.checked) return;
      settings.activeProvider = p.id;
      void save();
      redraw();
    });

    const name = h("input", { type: "text", value: p.name, style: "width:160px", spellcheck: "false" }) as HTMLInputElement;
    name.addEventListener("change", () => { live().name = name.value.trim() || p.id; void save(); });

    const kind = h("select", {}) as HTMLSelectElement;
    kind.append(
      h("option", { value: "anthropic", text: "Anthropic Messages API" }),
      h("option", { value: "openai", text: "OpenAI-compatible" }),
    );
    kind.value = p.kind;
    kind.addEventListener("change", () => {
      live().kind = kind.value as Provider["kind"];
      void save();
      redraw();
    });

    const remove = h("button", { class: "danger", text: "Delete" });
    remove.addEventListener("click", async () => {
      settings.providers = settings.providers.filter((x) => x.id !== p.id);
      if (settings.activeProvider === p.id) settings.activeProvider = settings.providers[0]?.id ?? "";
      // The key belongs to this entry alone; leaving it behind would only orphan it.
      try { await Bridge.secretClear(providerKey(p)); } catch { /* nothing to remove */ }
      void save();
      redraw();
    });
    if (settings.providers.length <= 1) {
      remove.disabled = true;
      remove.title = "The chat needs at least one provider.";
    }

    const baseUrl = h("input", { type: "text", value: p.baseUrl, placeholder: "https://…", style: "flex:1 1 auto;min-width:0", spellcheck: "false" }) as HTMLInputElement;
    baseUrl.addEventListener("change", () => { live().baseUrl = baseUrl.value.trim(); void save(); });

    // Typed or picked: the input takes any id, and the datalist beside it is
    // filled from the endpoint's own /v1/models on request.
    const listId = `models-${p.id}`;
    const modelList = h("datalist", { id: listId });
    const model = h("input", { type: "text", value: p.model, placeholder: "model id", list: listId, style: "width:220px", spellcheck: "false" }) as HTMLInputElement;
    model.addEventListener("change", () => { live().model = model.value.trim(); void save(); });
    const listModels = h("button", { text: "List models", title: "Ask the endpoint which models it has" });
    listModels.addEventListener("click", async () => {
      listModels.disabled = true;
      clear(feedback);
      try {
        const ids = await Bridge.providerModels(live());
        clear(modelList);
        for (const id of ids) modelList.append(h("option", { value: id }));
        feedback.append(h("div", { class: "notice ok", text: `${ids.length} models — open the Model field's drop-down to pick one.` }));
        model.focus();
      } catch (err) {
        feedback.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
      } finally {
        listModels.disabled = false;
      }
    });

    const wire = h("select", {}) as HTMLSelectElement;
    wire.append(
      h("option", { value: "chat", text: "Chat Completions (/v1/chat/completions)" }),
      h("option", { value: "responses", text: "Responses (/v1/responses)" }),
    );
    wire.value = p.wireApi ?? "chat";
    wire.addEventListener("change", () => { live().wireApi = wire.value as Provider["wireApi"]; void save(); });

    // How the key travels. "header:<name>" is what Azure's api-key wants.
    const authMode = p.auth.startsWith("header:") ? "header" : (p.auth || (isAnthropic() ? "x-api-key" : "bearer"));
    const auth = h("select", {}) as HTMLSelectElement;
    auth.append(
      h("option", { value: "bearer", text: "Authorization: Bearer" }),
      h("option", { value: "x-api-key", text: "x-api-key header" }),
      h("option", { value: "header", text: "Custom header…" }),
      h("option", { value: "none", text: "No key" }),
    );
    auth.value = authMode;
    const headerName = h("input", { type: "text", value: p.auth.startsWith("header:") ? p.auth.slice(7) : "", placeholder: "header name", style: "width:150px", spellcheck: "false" }) as HTMLInputElement;
    const keyRow = h("div", { class: "row" });
    function applyAuth() {
      headerName.style.display = auth.value === "header" ? "" : "none";
      keyRow.style.display = auth.value === "none" ? "none" : "";
      live().auth = auth.value === "header" ? `header:${headerName.value.trim()}` : auth.value;
      void save();
    }
    auth.addEventListener("change", applyAuth);
    headerName.addEventListener("change", applyAuth);
    headerName.style.display = authMode === "header" ? "" : "none";

    // The key itself: written straight to the Credential Manager, read back only as "present".
    const keyName = providerKey(p);
    const keyField = h("input", { type: "password", placeholder: present[keyName] ? "••••••••••••  (stored)" : "paste the key", style: "flex:1 1 auto;min-width:0", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const keyDot = statusDot(present[keyName] ?? false);
    const keySave = h("button", { class: "primary", text: "Save key" });
    const keyClear = h("button", { class: "danger", text: "Remove" });
    keyClear.style.display = present[keyName] ? "" : "none";
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
        keyClear.style.display = "";
        feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      } catch (err) {
        feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
      }
    });
    keyClear.addEventListener("click", async () => {
      clear(feedback);
      try {
        await Bridge.secretClear(keyName);
        present[keyName] = false;
        keyField.placeholder = "paste the key";
        keyDot.style.background = "#f4505e";
        keyClear.style.display = "none";
      } catch (err) {
        feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
      }
    });
    keyRow.append(h("label", { text: "API key" }), keyField, keySave, keyClear, keyDot);
    keyRow.style.display = authMode === "none" ? "none" : "";

    // What the endpoint can take; "auto" is what the kind usually can.
    const caps = h("div", { class: "row" }, h("label", { text: "Accepts" }));
    const capFields: [keyof Provider["capabilities"], string][] = [["images", "images"], ["pdf", "PDFs"], ["webSearch", "web search"]];
    for (const [field, label] of capFields) {
      const sel = h("select", {}) as HTMLSelectElement;
      sel.append(h("option", { value: "auto", text: `${label}: auto` }), h("option", { value: "yes", text: `${label}: yes` }), h("option", { value: "no", text: `${label}: no` }));
      const current = p.capabilities?.[field];
      sel.value = current == null ? "auto" : current ? "yes" : "no";
      sel.addEventListener("change", () => {
        const target = live();
        target.capabilities = { ...(target.capabilities ?? {}), [field]: sel.value === "auto" ? null : sel.value === "yes" };
        void save();
      });
      caps.append(sel);
    }

    const test = h("button", { text: "Test connection" });
    test.addEventListener("click", async () => {
      test.disabled = true;
      clear(feedback);
      feedback.append(h("div", { class: "hint", text: "Asking the model for one word…" }));
      try {
        const reply = await Bridge.providerTest(live());
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
      h("div", { class: "row" }, use, name, kind, inUse, h("span", { class: "spacer" }), remove),
      h("div", { class: "row" }, h("label", { text: "Endpoint" }), baseUrl),
      h("div", { class: "row" }, h("label", { text: "Model" }), model, modelList, listModels, isAnthropic() ? null : wire),
      h("div", { class: "row" }, h("label", { text: "Auth" }), auth, headerName),
      keyRow,
      caps,
      h("div", { class: "row" }, test, h("span", { class: "path", text: p.id }), settings.activeProvider === p.id ? null : h("span", { class: "hint", text: "The chat uses the provider marked \"in use\"; select the circle to switch." })),
      feedback,
    );
    return card;
  }

  redraw();
  return section;
}

// ── Agents section (ACP) ──────────────────────────────────────────────────────

function agentKey(a: AgentProfile): string {
  return `agent:${a.id}`;
}

/** Starting points for "Add agent". */
const AGENT_PRESETS: { label: string; make: () => AgentProfile }[] = [
  { label: "Copilot CLI (GitHub login)", make: () => ({ ...DEFAULT_AGENT, id: "", env: {} }) },
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

function agentsSection(present: Record<string, boolean>): HTMLElement {
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Agents" })),
    h("div", {
      class: "hint",
      text: "Coding agents the island can start and drive itself, over the Agent Client Protocol: pick one in the chat bar and your question goes to it, its tool calls show up as it works, and anything it needs permission for asks on the island. Keys go in the Windows Credential Manager; write {secret} where a key belongs in the environment.",
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

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "3", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(3, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  // The second countdown: how long the small bar lingers before vanishing.
  const hideAfter = h("input", {
    type: "number", min: "3", max: "600", step: "1",
    value: String(Math.round(settings.hideAfter || 60)),
    style: "width:72px",
  }) as HTMLInputElement;
  hideAfter.addEventListener("change", () => {
    settings.hideAfter = Math.max(3, Math.min(600, Number(hideAfter.value) || 60));
    hideAfter.value = String(settings.hideAfter);
    void save();
  });

  // How many finished sessions may sit side by side as cards before the rest
  // go to the pills; the island widens by one card each.
  const cards = h("input", {
    type: "number", min: "1", max: "3", step: "1",
    value: String(settings.maxSessionCards || 2),
    style: "width:72px",
  }) as HTMLInputElement;
  cards.addEventListener("change", () => {
    settings.maxSessionCards = Math.max(1, Math.min(3, Number(cards.value) || 2));
    cards.value = String(settings.maxSessionCards);
    void save();
  });

  // Written as the global-shortcut plugin reads it: modifiers and a key joined
  // by "+", e.g. Ctrl+Shift+Space, Ctrl+Alt+F12. Empty turns it off.
  const hotkey = h("input", {
    type: "text",
    value: settings.hotkey,
    placeholder: "Ctrl+Shift+Space",
    spellcheck: "false",
    style: "width:180px",
  }) as HTMLInputElement;
  const hotkeyNote = h("div", {});
  // A key another program already owns registers nothing and says nothing on
  // its own; this is where it gets said.
  async function checkHotkey() {
    const error = await Bridge.hotkeyStatus();
    clear(hotkeyNote);
    if (error) hotkeyNote.append(h("div", { class: "notice warn", text: error }));
  }
  hotkey.addEventListener("change", async () => {
    settings.hotkey = hotkey.value.trim();
    await save();
    await checkHotkey();
  });
  void checkHotkey();

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Hide after" }),
      hideAfter,
      h("span", { class: "hint", text: "seconds the small bar stays once the mouse leaves" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Always visible" }),
      toggle(settings.alwaysVisible, (v) => { settings.alwaysVisible = v; void save(); }),
      h("span", { class: "hint", text: "the island never hides; closing it leaves the small bar" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Session cards" }),
      cards,
      h("span", { class: "hint", text: "sessions shown side by side (1–3); the rest become pills" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Shortcut" }),
      hotkey,
      h("span", { class: "hint", text: "opens and closes the island from anywhere" }),
    ),
    hotkeyNote,
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const statuses: HookStatus[] = [];
  for (const copy of AGENT_COPY) {
    statuses.push((await Bridge.hooksStatus(copy.agent)) ?? {
      installed: false, settingsPath: "", hookPath: "", hookReady: false,
    });
  }

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;
  for (const p of settings.providers) {
    let has = (await Bridge.secretPresent(providerKey(p))) ?? false;
    // The default Claude entry still honours the key saved before providers existed.
    if (!has && p.id === "anthropic") has = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    present[providerKey(p)] = has;
  }
  for (const a of settings.agents) present[agentKey(a)] = (await Bridge.secretPresent(agentKey(a))) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    ...AGENT_COPY.map((copy, i) => agentSection(copy, statuses[i])),
    terminalSection(statuses[0]?.hookPath ?? ""),
    providersSection(present),
    agentsSection(present),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
