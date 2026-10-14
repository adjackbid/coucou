// Chat models: where the island's chat (and the secretary) sends its
// questions. Keys go to the Windows Credential Manager, never to disk.

import { Bridge } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import { DEFAULT_PROVIDER, type Provider } from "../../core/state";
import { h, clear } from "../../views/dom";
import type { Page } from "../nav";
import { providerKey, providerNeedsNoKey } from "../status";
import { present, save, setPresent, settings } from "../store";
import { badge, card, errText, field, notice, pageHeader, row } from "../ui";

export { providerKey };

function openaiPreset(name: string, baseUrl: string, model: string, extra: Partial<Provider> = {}): Provider {
  return {
    ...DEFAULT_PROVIDER, id: "", name, kind: "openai", baseUrl, model, wireApi: "chat", auth: "", headers: {}, capabilities: {},
    ...extra,
  };
}

/** Starting points for "Add". The id is filled in from the name. */
function presets(): { label: string; make: () => Provider }[] {
  return [
    { label: "Claude (Anthropic)", make: () => ({ ...DEFAULT_PROVIDER, id: "", headers: {}, capabilities: {} }) }, // i18n-ok: a protocol name
    { label: "OpenAI", make: () => openaiPreset("OpenAI", "https://api.openai.com/v1", "gpt-5", { capabilities: { pdf: true } }) },
    { label: "OpenRouter", make: () => openaiPreset("OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-5") },
    { label: tr("Ollama（本機）", "Ollama (local)"), make: () => openaiPreset("Ollama", "http://localhost:11434/v1", "qwen3:32b", { auth: "none" }) },
    { label: tr("LM Studio（本機）", "LM Studio (local)"), make: () => openaiPreset("LM Studio", "http://localhost:1234/v1", "local-model", { auth: "none" }) },
    { label: "Azure OpenAI", make: () => openaiPreset("Azure OpenAI", "https://<resource>.openai.azure.com/openai/v1", "gpt-5", { auth: "header:api-key" }) },
    { label: tr("OpenAI 相容（自訂）", "OpenAI-compatible (custom)"), make: () => openaiPreset(tr("自訂", "Custom"), "", "") },
    { label: tr("Responses API（自訂）", "Responses API (custom)"), make: () => openaiPreset(tr("自訂（Responses）", "Custom (Responses)"), "", "", { wireApi: "responses" }) },
  ];
}

/** An id from the name — letters, digits, dashes — that no other provider has. */
function uniqueId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  let id = base;
  for (let n = 2; settings.providers.some((p) => p.id === id); n++) id = `${base}-${n}`;
  return id;
}

function keyBadge(p: Provider): HTMLElement {
  if (providerNeedsNoKey(p)) return badge("off", tr("不需要金鑰", "No key needed"));
  return present[providerKey(p)] ? badge("ok", tr("金鑰已存", "Key saved")) : badge("todo", tr("沒有金鑰", "No key"));
}

export const chatPage: Page = {
  id: "chat",
  icon: "chat",
  name: () => tr("聊天模型", "Chat models"),
  render() {
    const list = h("div", { class: "stack" });
    const top = h("div", {});

    function redraw() {
      clear(list);
      clear(top);
      const agent = settings.activeProvider.startsWith("agent:")
        ? settings.agents.find((a) => `agent:${a.id}` === settings.activeProvider)
        : null;
      if (agent) {
        top.append(notice("warn", trf(
          "聊天列現在是跟 Agent「{name}」說話；秘書仍然用下面標「使用中」的聊天模型，沒有的話用第一個。",
          "The chat bar talks to the agent “{name}” right now; the secretary still uses the chat model below (the first one when none is in use).",
          { name: agent.name },
        )));
      }
      for (const p of settings.providers) list.append(providerCard(p));
      list.append(addRow());
    }

    function addRow(): HTMLElement {
      const all = presets();
      const preset = h("select", { title: tr("從哪一種開始", "Start from") }) as HTMLSelectElement;
      all.forEach((pr, i) => preset.append(h("option", { value: String(i), text: pr.label })));
      const add = h("button", { type: "button", text: tr("新增", "Add") });
      add.addEventListener("click", () => {
        const p = all[Number(preset.value)].make();
        p.id = uniqueId(p.name);
        settings.providers = [...settings.providers, p];
        if (settings.providers.length === 1) settings.activeProvider = p.id;
        void save();
        redraw();
      });
      return h("div", { class: "add-row", "data-anchor": "chat-add" }, h("span", { class: "add-label", text: tr("新增聊天模型", "Add a chat model") }), preset, add);
    }

    function providerCard(p: Provider): HTMLElement {
      const feedback = h("div", {});
      const isAnthropic = () => live().kind === "anthropic";
      // Every save makes Rust echo the settings back, and that echo replaces
      // `settings` — including its provider objects. Editing the `p` this card
      // was built with would then change a copy nobody saves (the endpoint and
      // model typed in looked saved, tested fine, and were blank on disk), so
      // every edit goes to whichever object currently carries this id.
      const live = (): Provider => settings.providers.find((x) => x.id === p.id) ?? p;
      const inUse = settings.activeProvider === p.id;
      let keyB = keyBadge(p);
      const badges = h("span", { class: "badges" }, inUse ? badge("ok", tr("使用中", "In use")) : null, keyB);
      const refreshKeyBadge = () => {
        const next = keyBadge(live());
        keyB.replaceWith(next);
        keyB = next;
      };

      // Model: typed, or picked from the endpoint's own /v1/models.
      const listId = `models-${p.id}`;
      const modelList = h("datalist", { id: listId });
      const model = h("input", { type: "text", value: p.model, placeholder: tr("模型 id", "model id"), list: listId, spellcheck: "false", class: "grow-input" }) as HTMLInputElement;
      model.addEventListener("change", () => { live().model = model.value.trim(); void save(); });
      const listModels = h("button", { type: "button", text: tr("列出模型", "List models"), title: tr("問這個端點有哪些模型", "Ask the endpoint which models it has") }) as HTMLButtonElement;
      listModels.addEventListener("click", async () => {
        listModels.disabled = true;
        clear(feedback);
        try {
          const ids = await Bridge.providerModels(live());
          clear(modelList);
          for (const id of ids) modelList.append(h("option", { value: id }));
          feedback.append(notice("ok", trf("找到 {n} 個模型，打開「模型」欄的下拉選一個。", "{n} models — open the Model field's drop-down to pick one.", { n: ids.length })));
          model.focus();
        } catch (err) {
          feedback.append(notice("err", errText(err)));
        } finally {
          listModels.disabled = false;
        }
      });

      // The key: straight to the Credential Manager, read back only as "present".
      const keyName = providerKey(p);
      const stored = () => present[keyName] ?? false;
      const keyField = h("input", {
        type: "password",
        placeholder: stored() ? tr("••••••••••••（已存）", "••••••••••••  (stored)") : tr("貼上金鑰", "paste the key"),
        autocomplete: "off",
        spellcheck: "false",
        class: "grow-input",
      }) as HTMLInputElement;
      const keySave = h("button", { type: "button", class: "primary", text: tr("儲存金鑰", "Save key") });
      const keyClear = h("button", { type: "button", class: "danger", text: tr("移除", "Remove") });
      keyClear.style.display = stored() ? "" : "none";
      keySave.addEventListener("click", async () => {
        const value = keyField.value.trim();
        if (!value) return;
        clear(feedback);
        try {
          await Bridge.secretSet(keyName, value);
          setPresent(keyName, true);
          keyField.value = "";
          keyField.placeholder = tr("••••••••••••（已存）", "••••••••••••  (stored)");
          keyClear.style.display = "";
          refreshKeyBadge();
          feedback.append(notice("ok", tr("已儲存。它不會寫進硬碟。", "Saved. It never touches disk.")));
        } catch (err) {
          feedback.append(notice("err", trf("存不進去：{err}", "Could not save: {err}", { err: errText(err) })));
        }
      });
      keyClear.addEventListener("click", async () => {
        clear(feedback);
        try {
          await Bridge.secretClear(keyName);
          setPresent(keyName, false);
          keyField.placeholder = tr("貼上金鑰", "paste the key");
          keyClear.style.display = "none";
          refreshKeyBadge();
        } catch (err) {
          feedback.append(notice("err", trf("移除不了：{err}", "Could not remove: {err}", { err: errText(err) })));
        }
      });
      const keyRow = field(tr("API 金鑰", "API key"), [keyField, keySave, keyClear]);
      keyRow.style.display = providerNeedsNoKey(p) ? "none" : "";

      const test = h("button", { type: "button", text: tr("測試連線", "Test connection") }) as HTMLButtonElement;
      test.addEventListener("click", async () => {
        test.disabled = true;
        clear(feedback);
        feedback.append(h("p", { class: "hint", text: tr("正在請模型回一個字…", "Asking the model for one word…") }));
        try {
          const reply = await Bridge.providerTest(live());
          clear(feedback);
          feedback.append(notice("ok", reply));
        } catch (err) {
          clear(feedback);
          feedback.append(notice("err", errText(err)));
        } finally {
          test.disabled = false;
        }
      });

      const use = inUse
        ? null
        : h("button", {
            type: "button",
            class: "primary",
            text: tr("改用這個", "Use this one"),
            onclick: () => {
              settings.activeProvider = p.id;
              void save();
              redraw();
            },
          });

      const incomplete = !isAnthropic() && !p.baseUrl.trim();
      return card({
        anchor: `provider-${p.id}`,
        title: p.name,
        meta: p.model || undefined,
        badge: badges,
        body: [
          use ? row(use) : null,
          field(tr("模型", "Model"), [model, modelList, listModels]),
          keyRow,
          row(test),
          feedback,
        ],
        advanced: () => advanced(p, live, keyRow, redraw),
        advancedOpen: incomplete,
        details: () => h("div", { class: "stack" },
          h("div", { class: "details-grid" }, h("span", { class: "k", text: "id" }), h("span", { class: "path", text: p.id })),
          row(deleteButton(p, redraw)),
        ),
      });
    }

    redraw();
    return h(
      "div",
      { class: "page-body" },
      pageHeader(
        "chat",
        tr("聊天模型", "Chat models"),
        tr("你在瀏海島聊天時回答你的 AI，秘書也用它。至少要有一個存好金鑰。", "The AI that answers when you type in the island's chat, and that the secretary uses. You need at least one with a key."),
        () => h("div", { class: "stack" },
          h("p", { text: tr(
            "Claude、OpenAI，或任何說 OpenAI 格式的服務（OpenRouter、Azure、本機的 Ollama 或 LM Studio、你自己的 proxy）。標著「使用中」的那個負責回答聊天。金鑰存在 Windows 認證管理員，絕不寫進硬碟。",
            "Claude, OpenAI, or anything that speaks the OpenAI format (OpenRouter, Azure, a local Ollama or LM Studio, your own proxy). The one marked \"In use\" answers the chat. Keys are stored in the Windows Credential Manager, never on disk.",
          ) }),
          h("p", { text: tr(
            "和「Agents」不一樣：聊天模型只會說話；Agent 還能在你的資料夾裡做事。",
            "Not the same as Agents: a chat model only talks; an agent can also work in your folders.",
          ) }),
        ),
      ),
      top,
      list,
    );
  },
};

function deleteButton(p: Provider, redraw: () => void): HTMLElement {
  const remove = h("button", { type: "button", class: "danger", text: tr("刪除", "Delete") }) as HTMLButtonElement;
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
    remove.title = tr("聊天至少需要一個聊天模型。", "The chat needs at least one chat model.");
  }
  return remove;
}

/** Endpoint, request format, how the key is sent, what it accepts. */
function advanced(p: Provider, live: () => Provider, keyRow: HTMLElement, redraw: () => void): Node {
  const name = h("input", { type: "text", value: p.name, spellcheck: "false" }) as HTMLInputElement;
  name.addEventListener("change", () => { live().name = name.value.trim() || p.id; void save(); });

  const kind = h("select", {}) as HTMLSelectElement;
  kind.append(
    h("option", { value: "anthropic", text: "Anthropic Messages API" }), // i18n-ok: a protocol name
    h("option", { value: "openai", text: tr("OpenAI 相容", "OpenAI-compatible") }),
  );
  kind.value = p.kind;
  kind.addEventListener("change", () => {
    live().kind = kind.value as Provider["kind"];
    void save();
    redraw();
  });

  const baseUrl = h("input", { type: "text", value: p.baseUrl, placeholder: "https://…", spellcheck: "false", class: "grow-input" }) as HTMLInputElement;
  baseUrl.addEventListener("change", () => { live().baseUrl = baseUrl.value.trim(); void save(); });

  const wire = h("select", {}) as HTMLSelectElement;
  wire.append(
    h("option", { value: "chat", text: "Chat Completions (/v1/chat/completions)" }), // i18n-ok: a protocol name
    h("option", { value: "responses", text: "Responses (/v1/responses)" }), // i18n-ok: a protocol name
  );
  wire.value = p.wireApi ?? "chat";
  wire.addEventListener("change", () => { live().wireApi = wire.value as Provider["wireApi"]; void save(); });

  // How the key travels. "header:<name>" is what Azure's api-key wants.
  const authMode = p.auth.startsWith("header:") ? "header" : (p.auth || (p.kind === "anthropic" ? "x-api-key" : "bearer"));
  const auth = h("select", {}) as HTMLSelectElement;
  auth.append(
    h("option", { value: "bearer", text: "Authorization: Bearer" }), // i18n-ok: a protocol name
    h("option", { value: "x-api-key", text: tr("x-api-key 標頭", "x-api-key header") }),
    h("option", { value: "header", text: tr("自訂標頭…", "Custom header…") }),
    h("option", { value: "none", text: tr("不用金鑰", "No key") }),
  );
  auth.value = authMode;
  const headerName = h("input", { type: "text", value: p.auth.startsWith("header:") ? p.auth.slice(7) : "", placeholder: tr("標頭名稱", "header name"), spellcheck: "false" }) as HTMLInputElement;
  const applyAuth = () => {
    headerName.style.display = auth.value === "header" ? "" : "none";
    keyRow.style.display = auth.value === "none" ? "none" : "";
    live().auth = auth.value === "header" ? `header:${headerName.value.trim()}` : auth.value;
    void save();
  };
  auth.addEventListener("change", applyAuth);
  headerName.addEventListener("change", applyAuth);
  headerName.style.display = authMode === "header" ? "" : "none";

  // What the endpoint can take; "auto" is what the kind usually can.
  const caps: HTMLElement[] = [];
  const capFields: [keyof Provider["capabilities"], string][] = [
    ["images", tr("圖片", "images")],
    ["pdf", "PDF"],
    ["webSearch", tr("網路搜尋", "web search")],
  ];
  for (const [f, label] of capFields) {
    const sel = h("select", {}) as HTMLSelectElement;
    sel.append(
      h("option", { value: "auto", text: trf("{x}：自動", "{x}: auto", { x: label }) }),
      h("option", { value: "yes", text: trf("{x}：可以", "{x}: yes", { x: label }) }),
      h("option", { value: "no", text: trf("{x}：不行", "{x}: no", { x: label }) }),
    );
    const current = p.capabilities?.[f];
    sel.value = current == null ? "auto" : current ? "yes" : "no";
    sel.addEventListener("change", () => {
      const target = live();
      target.capabilities = { ...(target.capabilities ?? {}), [f]: sel.value === "auto" ? null : sel.value === "yes" };
      void save();
    });
    caps.push(sel);
  }

  const incomplete = p.kind !== "anthropic" && !p.baseUrl.trim();
  return h(
    "div",
    { class: "stack" },
    incomplete ? notice("err", tr("需要填端點網址。", "Needs an endpoint.")) : null,
    field(tr("名稱", "Name"), name),
    field(tr("類型", "Kind"), kind),
    field(tr("端點", "Endpoint"), baseUrl),
    p.kind === "anthropic" ? null : field(tr("請求格式", "Request format"), wire),
    field(tr("金鑰怎麼送", "How the key is sent"), [auth, headerName]),
    field(tr("可以接受", "Accepts"), caps),
  );
}
