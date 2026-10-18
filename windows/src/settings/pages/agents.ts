// Agents Agent Center starts and drives itself (ACP, Codex, Claude Code,
// Antigravity), and n8n workflows it calls through their webhook: picked in
// the chat bar, or built on by Teamwork's team agents. Each is a Cloud Agent
// or a Local Agent, and the page lists them that way (views/agent-kind.ts).

import { Bridge, onEvent, type AgentTestStage } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import { DEFAULT_AGENT, locationOf, type AgentLocation, type AgentProfile } from "../../core/state";
import { capsView, forgetCaps } from "../../views/caps";
import { h, clear } from "../../views/dom";
import { kindIcon, markHint, markName, markOf } from "../../views/agent-kind";
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

/** Starting points for "Add": a name, one line on what it is, and the profile it makes. */
function presets(): { title: string; hint: string; make: () => AgentProfile }[] {
  return [
    { title: "Copilot CLI", hint: tr("用你的 GitHub 登入", "With your GitHub login"), make: () => ({ ...DEFAULT_AGENT, id: "", env: {} }) }, // i18n-ok: a product name
    { title: "cg", hint: tr("llm-share 上的 Copilot CLI,glm-5.3-flash", "Copilot CLI on llm-share, glm-5.3-flash"), make: () => llmShare("cg", "glm-5.3-flash") }, // i18n-ok: a preset's name
    { title: "cg2", hint: tr("llm-share 上的 Copilot CLI,deepseek-v4.1-flash", "Copilot CLI on llm-share, deepseek-v4.1-flash"), make: () => llmShare("cg2", "deepseek-v4.1-flash") }, // i18n-ok: a preset's name
    {
      title: "Codex", // i18n-ok: a product name
      hint: tr("codex app-server,用你的 ChatGPT 登入", "codex app-server, with your ChatGPT login"),
      make: () => ({ id: "", name: "Codex", command: "codex", args: ["app-server"], env: {}, cwd: "", protocol: "codex" }),
    },
    {
      title: "Antigravity", // i18n-ok: a product name
      hint: tr("agy,用你的 Google 登入", "agy, with your Google login"),
      make: () => ({ id: "", name: "Antigravity", command: "agy", args: [], env: {}, cwd: "", protocol: "agy" }),
    },
    {
      title: "Claude Code", // i18n-ok: a product name
      hint: tr("用你的 Claude 登入", "With your Claude login"),
      make: () => ({ id: "", name: "Claude Code", command: "claude", args: [], env: {}, cwd: "", protocol: "claude" }),
    },
    {
      title: tr("Copilot CLI(BYOK)", "Copilot CLI (BYOK)"),
      hint: tr("接你自己的 OpenAI 相容端點與金鑰", "On your own OpenAI-compatible endpoint and key"),
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
    {
      title: tr("本機模型", "Local model"),
      hint: tr("Copilot CLI 接這台電腦上的 Ollama / LM Studio", "Copilot CLI on this PC's Ollama / LM Studio"),
      make: () => ({
        ...DEFAULT_AGENT, id: "", name: tr("本機模型", "Local model"), location: "local",
        env: {
          COPILOT_PROVIDER_TYPE: "openai",
          COPILOT_PROVIDER_BASE_URL: "http://localhost:11434/v1",
          COPILOT_MODEL: "",
        },
      }),
    },
    {
      title: tr("n8n 節點", "n8n node"),
      hint: tr("用 Webhook 呼叫一條 n8n 工作流程", "Calls an n8n workflow through its webhook"),
      make: () => ({ id: "", name: "n8n", command: "", args: [], env: {}, cwd: "", protocol: "n8n", location: "local", url: "", headerName: "", timeoutSecs: 0 }),
    },
    { title: tr("其他 ACP agent", "Other ACP agent"), hint: tr("自訂指令與參數", "Your own command and arguments"), make: () => ({ id: "", name: "Agent", command: "", args: [], env: {}, cwd: "" }) },
  ];
}

/**
 * The picker that "新增 Agent Provider" opens: every kind as a card, Cloud
 * first and Local after, one picked at a time; 新增 (or Enter, or a double
 * click) makes it, Esc or the backdrop closes.
 */
function pickPreset(onPick: (make: () => AgentProfile) => void) {
  const all = presets().map((p) => ({ ...p, where: locationOf(p.make()) }));
  let picked = -1;
  const cards: HTMLButtonElement[] = [];
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const confirm = () => {
    if (picked < 0) return;
    const make = all[picked].make;
    close();
    onPick(make);
  };
  const add = h("button", { type: "button", class: "primary", disabled: true, onclick: confirm, text: tr("新增", "Add") }) as HTMLButtonElement;
  const choose = (i: number) => {
    picked = i;
    cards.forEach((c, k) => {
      c.classList.toggle("on", k === i);
      c.setAttribute("aria-checked", String(k === i));
    });
    add.disabled = false;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && picked >= 0 && !(e.target as HTMLElement).closest("button:not(.preset-card)")) confirm();
  };
  const group = (where: AgentLocation) =>
    h("div", { class: "preset-group" },
      h("div", { class: `preset-group-head ${where}` }, kindIcon(where, 18), h("b", { text: markName(where) }), h("span", { class: "hint", text: markHint(where) })),
      h("div", { class: "preset-grid", role: "radiogroup", "aria-label": markName(where) },
        ...all.map((p, i) => (p.where === where ? (() => {
          const c = h("button", { type: "button", class: "preset-card", role: "radio", "aria-checked": "false", onclick: () => choose(i), ondblclick: confirm },
            h("i", { class: "preset-mark", "aria-hidden": "true" }),
            h("span", { class: "preset-text" }, h("b", { text: p.title }), h("small", { text: p.hint }))) as HTMLButtonElement;
          cards.push(c);
          return c;
        })() : null))));
  const overlay = h("div", { class: "guide preset-pick", role: "dialog", "aria-modal": "true", "aria-label": tr("新增 Agent Provider", "Add an Agent Provider"), onclick: (e: Event) => { if (e.target === overlay) close(); } },
    h("div", { class: "guide-panel preset-panel" },
      h("div", { class: "preset-head" },
        h("div", {}, h("h1", { text: tr("新增 Agent Provider", "Add an Agent Provider") }), h("p", { class: "hint", text: tr("選一種開始;新增後還能改名稱、模型與指令。", "Pick one to start from; name, model and command can be changed after.") })),
        h("button", { type: "button", class: "preset-close", "aria-label": tr("關閉", "Close"), onclick: close, text: "×" })),
      h("div", { class: "preset-body" }, group("cloud"), group("local")),
      h("div", { class: "preset-foot" },
        h("button", { type: "button", onclick: close, text: tr("取消", "Cancel") }),
        add)));
  document.body.append(overlay);
  document.addEventListener("keydown", onKey);
  requestAnimationFrame(() => cards[0]?.focus());
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
    case "n8n": return "n8n Webhook"; // i18n-ok: a product name
    default: return a.command.toLowerCase().includes("copilot") ? "Copilot CLI" : "ACP";
  }
}

/** The webhook's host, for the card's one-line summary. */
function hostOf(url: string | undefined): string {
  try {
    return url?.trim() ? new URL(url.trim()).host : "";
  } catch {
    return "";
  }
}

/** The section of one location: its mark, its name, how many, and what it means. */
function sectionHead(where: AgentLocation, count: number): HTMLElement {
  return h(
    "div",
    { class: `kind-section-head ${where}` },
    kindIcon(where, 22),
    h("h2", { text: markName(where) }),
    h("span", { class: "count", text: String(count) }),
    h("span", { class: "hint", text: markHint(where) }),
  );
}

/** Cloud Agent / Local Agent as two buttons; an n8n node is local and says so. */
/**
 * One ability as a chip: grey when the agent lacks it, coloured when it has it;
 * a click flips it. `auto` is what Coucou tells from the agent's kind; the
 * person's own setting is kept only while it differs, so an unchanged chip
 * follows the kind again.
 */
function abilityChip(name: string, set: boolean | null | undefined, auto: boolean | null, tone: "" | "image", help: string, onChange: (v: boolean | null) => void): HTMLElement {
  const has = set ?? auto ?? false;
  const own = set != null && set !== auto;
  const title = `${help}\n${has ? tr("有:點一下拿掉", "Has it: click to take it away") : tr("沒有:點一下加上", "Lacks it: click to give it")}${auto == null ? "" : own ? tr("(你改的;依種類判斷是", " (your setting; its kind says ") + (auto ? tr("有)", "yes)") : tr("沒有)", "no)")) : tr("(依種類判斷)", " (told from its kind)")}`;
  return h(
    "button",
    {
      type: "button",
      class: `ability-chip ${has ? "on" : "off"} ${tone}${own ? " own" : ""}`,
      "aria-pressed": String(has),
      title,
      onclick: () => {
        const next = !has;
        onChange(auto != null && next === auto ? null : next);
      },
    },
    h("span", { text: name }),
  );
}

function locationSwitch(a: AgentProfile, set: (v: AgentLocation) => void): HTMLElement {
  const now = locationOf(a);
  const fixed = a.protocol === "n8n";
  const item = (v: AgentLocation) =>
    h(
      "button",
      {
        type: "button",
        class: now === v ? "on" : "",
        "aria-pressed": String(now === v),
        disabled: fixed && v !== now,
        title: fixed && v !== now ? tr("n8n 節點固定是 Local Agent", "An n8n node is always a Local Agent") : markHint(v),
        onclick: () => {
          if (now !== v) set(v);
        },
      },
      kindIcon(v, 16),
      h("span", { text: markName(v) }),
    );
  return h("div", { class: "segmented kind-switch", role: "group", "aria-label": tr("類別", "Kind") }, item("cloud"), item("local"));
}

export const agentsPage: Page = {
  id: "agents",
  icon: "agents",
  name: () => "Agent Provider",
  render(ctx) {
    const list = h("div", { class: "stack" });
    let addAsked = ctx.action === "add";
    // Each visit asks afresh: the price list may have been fetched again in Teamwork.
    forgetCaps();

    function redraw() {
      clear(list);
      // Adding comes first: it is what a person opening this page most often came for.
      const openPicker = () =>
        pickPreset((make) => {
          const a = make();
          a.id = uniqueAgentId(a.name);
          settings.agents = [...settings.agents, a];
          void save();
          redraw();
          requestAnimationFrame(() => list.querySelector(`[data-anchor="agent-profile-${a.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
        });
      const add = h("button", { type: "button", class: "primary add-provider", onclick: openPicker, text: tr("＋ 新增 Agent Provider", "+ Add an Agent Provider") });
      list.append(h("div", { class: "add-row", "data-anchor": "agent-add" }, add, h("span", { class: "hint", text: tr("Copilot CLI、Codex、Claude Code、Antigravity、本機模型、n8n 節點…", "Copilot CLI, Codex, Claude Code, Antigravity, a local model, an n8n node…") })));
      // Agent Pool's "新增 Provider" lands here with the picker already open.
      if (addAsked) {
        addAsked = false;
        requestAnimationFrame(openPicker);
      }
      for (const where of ["cloud", "local"] as const) {
        const mine = settings.agents.filter((a) => locationOf(a) === where);
        list.append(sectionHead(where, mine.length));
        if (!mine.length) {
          list.append(h("p", { class: "kind-empty", text: where === "local" ? tr("還沒有 Local Agent:可以從上面新增本機模型的 Copilot 或 n8n 節點,或把一張卡片的類別改成 Local Agent。", "No Local Agent yet: add a Copilot on a local model or an n8n node above, or set a card's kind to Local Agent.") : tr("還沒有 Cloud Agent。", "No Cloud Agent yet.") }));
        }
        for (const a of mine) list.append(agentCard(a));
      }
    }

    function agentCard(a: AgentProfile): HTMLElement {
      const feedback = h("div", {});
      // Same reason as the chat models: every save echoes new objects back.
      const live = (): AgentProfile => settings.agents.find((x) => x.id === a.id) ?? a;
      const isNode = a.protocol === "n8n";
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
        if (isNode ? !live().url?.trim() : !live().command.trim()) badgeSlot.append(badge("todo", isNode ? tr("沒有網址", "No URL") : tr("沒有指令", "No command")));
      };
      syncBadge();

      const kind = field(tr("類別", "Kind"), locationSwitch(a, (v) => {
        live().location = v;
        void save();
        redraw();
      }), isNode ? tr("n8n 節點固定是 Local Agent。", "An n8n node is always a Local Agent.") : null);

      const protocol = h("select", { title: tr("Agent Center 用什麼方式跟它說話", "How Agent Center talks to it") }) as HTMLSelectElement;
      protocol.append(
        h("option", { value: "acp", text: "ACP" }),
        h("option", { value: "codex", text: "Codex app-server" }), // i18n-ok: a protocol name
        h("option", { value: "claude", text: "Claude Code (stream-json)" }), // i18n-ok: a protocol name
        h("option", { value: "agy", text: tr("Antigravity（agy 無介面模式）", "Antigravity (agy headless)") }),
        h("option", { value: "n8n", text: tr("n8n Webhook（Local Agent）", "n8n webhook (Local Agent)") }),
      );
      protocol.value = a.protocol ?? "acp";
      protocol.addEventListener("change", () => {
        const next = protocol.value as NonNullable<AgentProfile["protocol"]>;
        const crossed = (next === "n8n") !== isNode;
        live().protocol = next;
        if (next === "n8n") live().location = "local";
        void save();
        // The fields of a webhook are not a CLI's: the card is drawn again.
        if (crossed) redraw();
      });

      const keyField = h("input", {
        type: "password",
        placeholder: present[keyName] ? tr("••••••••••••（已存）", "••••••••••••  (stored)") : isNode ? tr("貼上 Header 的值", "paste the header's value") : tr("貼上 {secret} 代表的金鑰", "paste the key {secret} stands for"),
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
      const keyRow = field(
        tr("金鑰", "Key"),
        [keyField, keySave],
        isNode ? tr("放在驗證 Header 裡送出;存在 Windows 認證管理員,不會寫進設定檔。", "Sent in the auth header; kept in the Windows Credential Manager, never in the settings file.") : tr("環境變數裡的 {secret} 會換成這把金鑰。", "{secret} in the environment is replaced by this key."),
      );
      keyRow.style.display = agentNeedsKey(a) ? "" : "none";

      const test = h("button", { type: "button", text: tr("測試", "Test") }) as HTMLButtonElement;
      test.addEventListener("click", async () => {
        test.disabled = true;
        clear(feedback);
        const stage = h("p", { class: "hint", text: isNode ? tr("正在呼叫 Webhook…", "Calling the webhook…") : tr("1/2 正在啟動 agent 並握手…", "1/2 Starting the agent and shaking hands…") });
        feedback.append(stage);
        const id = live().id;
        const unlisten = await onEvent<AgentTestStage>("agent-test-stage", (s) => {
          if (s.id === id && s.stage === "sentence") stage.textContent = tr("2/2 握手完成，正在真的送一句話給它…", "2/2 Handshake done; sending it one real sentence…");
        });
        try {
          const reply = await Bridge.acpTest(live());
          clear(feedback);
          feedback.append(notice("ok", reply));
        } catch (err) {
          clear(feedback);
          feedback.append(notice("err", errText(err)));
        } finally {
          unlisten();
          test.disabled = false;
        }
      });

      // What it can do: price, context, vision and thinking come from the price
      // lists; making images, the web and code are chips the person can flip.
      const abilityRow = (x: AgentProfile): HTMLElement => {
        const fromKind = x.protocol !== "n8n";
        return h("div", { class: "ability-row" },
          capsView(x, { auto: true }),
          abilityChip(tr("生圖", "image gen"), x.imageGen, null, "image", tr("會產生圖片:它有產生圖片的工具時(例如 Antigravity)點亮,Agent Center 要做圖時才會挑它", "Makes images: light this when it has a tool for it (Antigravity, say); Agent Center picks it for pictures only then"), (v) => {
            live().imageGen = !!v;
            refreshCaps();
          }),
          abilityChip(tr("上網", "web"), x.web, fromKind, "", tr("能用自己的工具上網查資料、讀網頁", "Searches and reads the web with its own tools"), (v) => {
            live().web = v;
            refreshCaps();
          }),
          abilityChip("Code", x.code, fromKind, "", tr("能在自己的機器上執行指令和程式", "Runs commands and code on its machine"), (v) => { // i18n-ok: Code is the same in both
            live().code = v;
            refreshCaps();
          }),
        );
      };
      let abilitySlot = abilityRow(a);
      // Only this row changes: drawing the page again would take the person back to its top.
      const refreshCaps = () => {
        void save();
        const next = abilityRow(live());
        abilitySlot.replaceWith(next);
        abilitySlot = next;
      };
      const abilities = field(
        tr("能力", "Abilities"),
        abilitySlot,
        tr("價位、上下文、看圖和思考依價目表自動判斷。灰色代表沒有、彩色代表有,點一下就能改:生圖沒有清單會說,它有產生圖片的工具時(例如 Antigravity)請點亮;上網和 Code 預設依種類判斷(coding CLI 都會,n8n 不會),判斷錯了點一下改掉,Agent Center 會照你設的挑人。", "Price, context, vision and thinking come from the price list. Grey means it lacks the ability, colour means it has it, and a click flips it: no list says whether it makes images, so light that when it has a tool for it (Antigravity, say); web and code are told from its kind (every coding CLI has them, n8n does not), and a click fixes a wrong guess. Agent Center picks by what you set."),
      );
      const usedBy = (teamAgents?.doc.agents ?? []).filter((t) => t.base === a.id).map((t) => t.name);
      const title = h("div", { class: "title-icon" }, kindIcon(markOf(a), 18), h("h2", { text: a.name }));
      const meta = isNode ? `${protocolName(a)} · ${hostOf(a.url) || tr("還沒填網址", "no URL yet")}` : `${protocolName(a)} · ${a.model?.trim() || envModel(a) || tr("它自己的預設模型", "its own default model")}`;
      const body = isNode
        ? [kind, field(tr("說話方式", "Speaks"), protocol), ...nodeFields(a, live, keyRow, syncBadge), keyRow, row(test, h("span", { class: "hint", text: tr("送一個 kind: test 的請求給 Webhook;在聊天列選它,就能跟它說話", "sends the webhook a request with kind: test; pick it in the chat bar to talk to it") })), feedback]
        : [kind, field(tr("說話方式", "Speaks"), protocol), modelField(a, live, feedback), abilities, keyRow, row(test, h("span", { class: "hint", text: tr("測試會真的送它一句話（花一次很小的呼叫）；在聊天列選它，就能跟它說話", "the test really sends it one sentence (one tiny call); pick it in the chat bar to talk to it") })), feedback];
      return card({
        anchor: `agent-profile-${a.id}`,
        title,
        meta,
        badge: badgeSlot,
        body,
        advanced: () => (isNode ? nodeAdvanced(a, live) : advanced(a, live, keyRow, syncBadge)),
        advancedOpen: !isNode && !a.command.trim(),
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
        "Agent Provider",
        tr("Agent Center 實際用來做事的 agent，分成 Cloud Agent 與 Local Agent：在聊天列挑一個，或讓 Agent Pool 裡的 Agent 用它執行。", "The agents Agent Center actually works with, sorted into Cloud Agents and Local Agents: pick one in the chat bar, or have the agents in Agent Pool run on it."),
        () => tr(
          "跟「連結 Agent」不一樣（那是 Agent Center 在旁邊看你自己開的工作階段），這裡的 agent 是 Agent Center 自己執行的：透過 Agent Client Protocol（Copilot CLI）、Codex 的 app server、Claude Code 或 Antigravity，或呼叫 n8n 工作流程的 Webhook。Cloud Agent 在雲端服務上工作；Local Agent 在地端服務上工作，資料留在你的電腦或公司網路裡（例如本機模型、自架的 n8n）。它們做事時工具步驟會即時出現，需要許可的會在瀏海島上問你。Teamwork Agent Pool 裡的每個 Agent，都用這裡的一個 Provider 執行。",
          "Unlike \"Connect agents\" (Agent Center watches sessions you start yourself), these are agents Agent Center runs itself — over the Agent Client Protocol (Copilot CLI), Codex's app server, Claude Code or Antigravity — or n8n workflows it calls through their webhook. A Cloud Agent works on a cloud service; a Local Agent works on an on-premises service, and the work stays on your own machine or network (a local model, a self-hosted n8n). Their tool calls show up as they work, and anything that needs permission asks in the island. Every agent in Teamwork's Agent Pool runs on one of these providers.",
        ),
      ),
      list,
    );
  },
};

/** The model, with the agent's own list a click away. */
function modelField(a: AgentProfile, live: () => AgentProfile, feedback: HTMLElement): HTMLElement {
  // The model it runs unless a team member names another. The list is the
  // agent's own: asked with a handshake, so nothing is spent.
  const modelList = h("datalist", { id: `agent-models-${a.id}` }) as HTMLDataListElement;
  // This field wins over a COPILOT_MODEL in the environment (acp.rs `running_model`).
  const fromEnv = envModel(a);
  const model = h("input", {
    type: "text",
    value: a.model ?? "",
    placeholder: fromEnv ? trf("空白時用環境變數的 COPILOT_MODEL:{model}", "empty: COPILOT_MODEL from the environment, {model}", { model: fromEnv }) : tr("用它自己的預設", "its own default"),
    list: `agent-models-${a.id}`,
    spellcheck: "false",
    class: "grow-input",
  }) as HTMLInputElement;
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
  const overrides = fromEnv && a.model?.trim() && a.model.trim() !== fromEnv;
  return field(
    tr("模型", "Model"),
    [model, modelList, listModels],
    overrides ? trf("用這裡的模型;環境變數的 COPILOT_MODEL({model})只在這裡空白時才用。", "This model is used; COPILOT_MODEL in the environment ({model}) only when this is empty.", { model: fromEnv }) : null,
  );
}

/** A Copilot agent's COPILOT_MODEL, which stands in for an empty model field. */
function envModel(a: AgentProfile): string {
  const m = (a.protocol ?? "acp") === "acp" ? a.env?.COPILOT_MODEL?.trim() ?? "" : "";
  return m.includes("{") ? "" : m;
}

/** An n8n node's webhook and the header it checks. */
function nodeFields(a: AgentProfile, live: () => AgentProfile, keyRow: HTMLElement, syncBadge: () => void): HTMLElement[] {
  const url = h("input", { type: "text", inputmode: "url", value: a.url ?? "", placeholder: "https://n8n.example.lan/webhook/…", spellcheck: "false", class: "grow-input mono" }) as HTMLInputElement;
  url.addEventListener("change", () => { live().url = url.value.trim(); void save(); syncBadge(); });
  const header = h("input", { type: "text", value: a.headerName ?? "", placeholder: tr("例如 X-API-Key;留空表示不驗證", "e.g. X-API-Key; empty for none"), spellcheck: "false", class: "grow-input" }) as HTMLInputElement;
  header.addEventListener("change", () => {
    live().headerName = header.value.trim();
    keyRow.style.display = agentNeedsKey(live()) ? "" : "none";
    syncBadge();
    void save();
  });
  return [
    field(tr("Webhook 網址", "Webhook URL"), url, tr("n8n Webhook 節點的 Production URL(工作流程要設成 Active)。回應設成 When Last Node Finishes,或用 Respond to Webhook 節點;回覆可以是文字,或含 reply / output 的 JSON。", "The Production URL of the n8n Webhook node (the workflow must be Active). Set it to respond When Last Node Finishes, or use a Respond to Webhook node; the answer may be text, or JSON with reply / output.")),
    field(tr("驗證 Header", "Auth header"), header, tr("Webhook 節點用 Header Auth 時填它檢查的 Header 名稱,值在下面的金鑰。", "When the Webhook node uses Header Auth, the header it checks; its value is the key below.")),
  ];
}

/** An n8n node's name and how long a call may take. */
function nodeAdvanced(a: AgentProfile, live: () => AgentProfile): Node {
  const name = h("input", { type: "text", value: a.name, spellcheck: "false" }) as HTMLInputElement;
  name.addEventListener("change", () => { live().name = name.value.trim() || a.id; void save(); });
  const timeout = h("input", { type: "number", min: "5", max: "3600", step: "5", value: String(a.timeoutSecs || 300), class: "short" }) as HTMLInputElement;
  timeout.addEventListener("change", () => {
    const n = Math.round(Number(timeout.value));
    live().timeoutSecs = Number.isFinite(n) && n >= 5 ? Math.min(n, 3600) : 0;
    void save();
  });
  return h(
    "div",
    { class: "stack" },
    field(tr("名稱", "Name"), name),
    field(tr("逾時（秒）", "Timeout (s)"), timeout, tr("一次呼叫最多等這麼久;工作流程跑比較久就調高。", "How long one call may take; raise it for a slow workflow.")),
  );
}

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
