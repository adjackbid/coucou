// Chat providers: where the island's chat (and the secretary) sends its questions.

import { Bridge } from "../../core/bridge";
import { DEFAULT_PROVIDER, type Provider } from "../../core/state";
import { h, clear } from "../../views/dom";
import { settings, save } from "../store";
import { statusDot } from "../ui";

/** Credential Manager key of a provider; the default Claude entry also honours the pre-provider key. */
export function providerKey(p: Provider): string {
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

export function providersSection(present: Record<string, boolean>): HTMLElement {
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
