// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import { DEFAULT_PROVIDER, DEFAULT_SETTINGS, type Provider, type Settings } from "../core/state";
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

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
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
      preview = await Bridge.hooksPreview(install);
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
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
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
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
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

    // Which one the chat talks to.
    const use = h("input", { type: "radio", name: "active-provider", title: "Use this provider" }) as HTMLInputElement;
    use.checked = settings.activeProvider === p.id;
    use.addEventListener("change", () => {
      if (!use.checked) return;
      settings.activeProvider = p.id;
      void save();
    });

    const name = h("input", { type: "text", value: p.name, style: "width:160px", spellcheck: "false" }) as HTMLInputElement;
    name.addEventListener("change", () => { p.name = name.value.trim() || p.id; void save(); });

    const kind = h("select", {}) as HTMLSelectElement;
    kind.append(
      h("option", { value: "anthropic", text: "Anthropic Messages API" }),
      h("option", { value: "openai", text: "OpenAI-compatible" }),
    );
    kind.value = p.kind;
    kind.addEventListener("change", () => {
      p.kind = kind.value as Provider["kind"];
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
    baseUrl.addEventListener("change", () => { p.baseUrl = baseUrl.value.trim(); void save(); });

    const model = h("input", { type: "text", value: p.model, placeholder: "model id", style: "width:220px", spellcheck: "false" }) as HTMLInputElement;
    model.addEventListener("change", () => { p.model = model.value.trim(); void save(); });

    const wire = h("select", {}) as HTMLSelectElement;
    wire.append(
      h("option", { value: "chat", text: "Chat Completions (/v1/chat/completions)" }),
      h("option", { value: "responses", text: "Responses (/v1/responses)" }),
    );
    wire.value = p.wireApi ?? "chat";
    wire.addEventListener("change", () => { p.wireApi = wire.value as Provider["wireApi"]; void save(); });

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
      p.auth = auth.value === "header" ? `header:${headerName.value.trim()}` : auth.value;
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
        p.capabilities = { ...(p.capabilities ?? {}), [field]: sel.value === "auto" ? null : sel.value === "yes" };
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
        const reply = await Bridge.providerTest(p);
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
      h("div", { class: "row" }, use, name, kind, h("span", { class: "spacer" }), remove),
      h("div", { class: "row" }, h("label", { text: "Endpoint" }), baseUrl),
      h("div", { class: "row" }, h("label", { text: "Model" }), model, isAnthropic() ? null : wire),
      h("div", { class: "row" }, h("label", { text: "Auth" }), auth, headerName),
      keyRow,
      caps,
      h("div", { class: "row" }, test, h("span", { class: "path", text: p.id })),
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
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

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

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    providersSection(present),
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
