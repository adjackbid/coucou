// 秘書: the person calls on Coucou's secretary when they need it — to hear how
// the teams are doing, what waits for them, what it cost, or to have a team
// set up or told something. The secretary (secretary.rs) reads Coucou's
// records freely; what it prepares comes back as cards, and only a click on
// a card's button makes it happen.
//
// The conversation lives in the app for as long as it runs; this page keeps
// what it shows, and is drawn inside the Teamwork window by main.ts.

import "./secretary.css";
import { Bridge, IS_TAURI } from "../core/bridge";
import { h } from "../views/dom";
import { dropdown, editableText } from "./ui";
import type { SecretaryProposal, SecretaryReply, SecretaryStep } from "./types";

export interface SecretaryHost {
  render(): void;
  /** The team files changed (a team was created): read them again. */
  reload(): Promise<void>;
  /** Shows a team by its id. */
  openTeam(id: string): void;
}

interface Entry {
  who: "you" | "secretary" | "error";
  text: string;
  steps?: SecretaryStep[];
  proposals?: SecretaryProposal[];
}

const SUGGESTIONS = ["各團隊現在狀況如何?", "有什麼在等我處理?", "這週花了多少錢?", "幫我開一個新團隊…"];
const tz = () => -new Date().getTimezoneOffset();

let entries: Entry[] = [];
let live: SecretaryStep[] = [];
let waiting = false;
let draft = "";
/** Scroll the conversation to its end after the next drawing. */
let stick = false;
/** (id, name, model) of each chat provider; null until asked. */
let providers: [string, string, string][] | null = null;
let provider = stored("coucou.secretary.provider") ?? "";
/** What the person calls the secretary; "秘書" until they name it. */
let name = stored("coucou.secretary.name")?.trim() || "秘書";

export function secretaryName(): string {
  return name;
}

export function setSecretaryName(v: string) {
  name = v.trim() || "秘書";
  store("coucou.secretary.name", name);
}
/** Proposals being carried out right now. */
const doing = new Set<string>();

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* kept until the window closes */
  }
}

/** A step the secretary took, as it happens (`secretary-step`). */
export function onStep(step: SecretaryStep, host: SecretaryHost) {
  if (!waiting) return;
  live.push(step);
  stick = true;
  host.render();
}

async function ensureProviders(host: SecretaryHost) {
  if (providers) return;
  providers = IS_TAURI ? ((await Bridge.secretaryProviders()) ?? []) : [["custom", "Custom", "deepseek-v4-flash"]];
  if (!providers.some((p) => p[0] === provider)) provider = providers[0]?.[0] ?? "";
  host.render();
}

/**
 * Asks the secretary from another page (成本分析): the exchange joins the
 * conversation, and the answer — or why there is none — comes back as words.
 */
export async function consult(text: string, render: () => void): Promise<string> {
  if (waiting) return "秘書還在處理上一件事,稍等一下再試。";
  if (!providers) await ensureProviders({ render, reload: async () => {}, openTeam: () => {} });
  await ask({ render, reload: async () => {}, openTeam: () => {} }, text);
  const last = entries[entries.length - 1];
  return last?.who === "error" ? `沒有成功:${last.text}` : (last?.text ?? "");
}

async function ask(host: SecretaryHost, text: string) {
  const words = text.trim();
  if (!words || waiting) return;
  entries.push({ who: "you", text: words });
  draft = "";
  waiting = true;
  live = [];
  stick = true;
  host.render();
  try {
    const reply: SecretaryReply = IS_TAURI ? await Bridge.secretaryAsk(words, provider || null, tz(), name) : await (await import("./demo")).demoSecretary(words);
    entries.push({ who: "secretary", text: reply.text, steps: reply.steps, proposals: reply.proposals });
  } catch (err) {
    entries.push({ who: "error", text: String(err instanceof Error ? err.message : err) });
  }
  waiting = false;
  live = [];
  stick = true;
  host.render();
}

function replace(updated: SecretaryProposal) {
  for (const e of entries) {
    const i = e.proposals?.findIndex((p) => p.id === updated.id) ?? -1;
    if (i >= 0) e.proposals![i] = updated;
  }
}

async function confirm(host: SecretaryHost, p: SecretaryProposal) {
  doing.add(p.id);
  host.render();
  try {
    const done = IS_TAURI ? await Bridge.secretaryConfirm(p.id, tz()) : { ...p, state: "done" as const, outcome: "(瀏覽器預覽,沒有真的執行)" };
    replace(done);
    if (p.kind === "team") await host.reload();
  } catch (err) {
    replace({ ...p, state: "failed", outcome: String(err instanceof Error ? err.message : err) });
  }
  doing.delete(p.id);
  host.render();
}

async function decline(host: SecretaryHost, p: SecretaryProposal) {
  const done = IS_TAURI ? await Bridge.secretaryDecline(p.id) : { ...p, state: "declined" as const };
  replace(done ?? { ...p, state: "declined" });
  host.render();
}

/** The secretary's words: line breaks, **bold**, `code` and "- " lists, nothing else. */
function words(text: string): HTMLElement {
  const box = h("div", { class: "sec-words" });
  let list: HTMLElement | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      list = null;
      box.append(inline(h("h4"), heading[1]));
      continue;
    }
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      if (!list) box.append((list = h("ul")));
      list.append(inline(h("li"), item[1]));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    box.append(inline(h("p"), line));
  }
  return box;
}

function inline(el: HTMLElement, text: string): HTMLElement {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) el.append(h("b", { text: part.slice(2, -2) }));
    else if (part.startsWith("`") && part.endsWith("`")) el.append(h("code", { text: part.slice(1, -1) }));
    else el.append(part);
  }
  return el;
}

function steps(list: SecretaryStep[], running: boolean): HTMLElement | null {
  if (!list.length && !running) return null;
  return h(
    "div",
    { class: "sec-steps" },
    ...list.map((s, i) => h("span", { class: `sec-step${running && i === list.length - 1 ? " now" : ""}` }, h("i", { "aria-hidden": "true", text: running && i === list.length - 1 ? "" : "✓" }), s.label)),
  );
}

function card(host: SecretaryHost, p: SecretaryProposal): HTMLElement {
  const busy = doing.has(p.id);
  const state =
    p.state === "done"
      ? h("div", { class: "sec-card-state done" }, h("span", { text: `✓ 已完成${p.outcome ? `:${p.outcome}` : ""}` }))
      : p.state === "declined"
        ? h("div", { class: "sec-card-state", text: "已取消" })
        : p.state === "failed"
          ? h("div", { class: "sec-card-state failed", text: `沒有成功:${p.outcome}` })
          : h(
              "div",
              { class: "sec-card-actions" },
              h("button", { class: "btn primary", type: "button", disabled: busy, onClick: () => void confirm(host, p) }, busy ? "處理中…" : p.confirm),
              h("button", { class: "btn plain", type: "button", disabled: busy, onClick: () => void decline(host, p) }, "不用了"),
              h("span", { class: "hint", text: "按下才會執行" }),
            );
  const team = p.state === "done" ? /\(id ([A-Za-z0-9_-]+)\)/.exec(p.outcome)?.[1] : undefined;
  return h(
    "div",
    { class: `sec-card ${p.state}` },
    h("div", { class: "sec-card-head" }, h("span", { class: "sec-card-kind", text: p.kind === "team" ? "新團隊" : p.kind === "instruction" ? "指令" : "操作" }), h("b", { text: p.title })),
    h("ul", { class: "sec-card-lines" }, ...p.lines.map((l) => h("li", { text: l }))),
    state,
    team ? h("button", { class: "link", type: "button", onClick: () => host.openTeam(team) }, "打開這個團隊 →") : null,
  );
}

/** `?view=secretary&ask=…` in a browser asks once, to look at a conversation. */
let asked = false;

/** The page's title: the secretary's name, changed by clicking it. */
export function secretaryTitle(host: SecretaryHost): HTMLElement {
  return editableText("secretary", name, {
    tag: "b",
    className: "sec-title",
    label: "秘書的名字",
    fallback: "秘書",
    maxLength: 20,
    onSave: (v) => {
      name = v;
      store("coucou.secretary.name", name);
    },
    render: () => host.render(),
  });
}

export function secretaryPage(host: SecretaryHost): HTMLElement {
  void ensureProviders(host);
  if (import.meta.env.DEV && !IS_TAURI && !asked && typeof location !== "undefined") {
    asked = true;
    for (const q of new URLSearchParams(location.search).getAll("ask")) setTimeout(() => void ask(host, q), 0);
  }
  const list = h("div", { class: "scroll sec-list" });
  if (!entries.length) {
    list.append(
      h(
        "div",
        { class: "sec-hello" },
        h("h2", { text: `我是${name},需要什麼跟我說` }),
        h("p", { class: "dim", text: "我會查 Coucou 的紀錄回答你:各團隊進度、誰卡住、誰在等你、花了多少錢。也可以請我開新團隊、給團隊下指令、暫停或封存團隊——我先擬好,你按確認才會執行。" }),
        h("div", { class: "sec-suggest" }, ...SUGGESTIONS.map((s) => h("button", { class: "chip pick", type: "button", onClick: () => (s.endsWith("…") ? ((draft = s.replace("…", ":")), host.render()) : void ask(host, s)) }, s))),
      ),
    );
  }
  for (const e of entries) {
    if (e.who === "you") list.append(h("div", { class: "sec-row you" }, h("div", { class: "sec-bubble you", text: e.text })));
    else if (e.who === "error") list.append(h("div", { class: "sec-row" }, h("div", { class: "problem", text: e.text })));
    else
      list.append(
        h(
          "div",
          { class: "sec-row" },
          h("div", { class: "sec-bubble" }, steps(e.steps ?? [], false), words(e.text), ...(e.proposals ?? []).map((p) => card(host, p))),
        ),
      );
  }
  if (waiting) list.append(h("div", { class: "sec-row" }, h("div", { class: "sec-bubble thinking" }, steps(live, true), h("span", { class: "sec-dots", "aria-label": "處理中" }, h("i"), h("i"), h("i")))));
  if (stick) {
    stick = false;
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  }

  const input = h("textarea", { class: "field sec-input", rows: "2", "data-key": "secretary-input", placeholder: "例如:各團隊現在怎麼樣?/幫我開一個做官網的團隊,資料夾 D:\\Code\\site", spellcheck: "false" }) as HTMLTextAreaElement;
  input.value = draft;
  input.addEventListener("input", () => (draft = input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void ask(host, input.value);
    }
  });
  const choices = (providers ?? []).map(([id, name, model]) => ({ value: id, label: `${name} · ${model}`, hint: "秘書用這個聊天模型思考" }));
  return h(
    "div",
    { class: "secretary" },
    list,
    h(
      "div",
      { class: "sec-composer" },
      input,
      h(
        "div",
        { class: "sec-composer-row" },
        choices.length
          ? dropdown({ value: provider, choices, className: "sec-model", title: "秘書用哪個聊天模型(設定 → Chat providers)", onChange: (v) => ((provider = v), store("coucou.secretary.provider", v), host.render()) })
          : h("span", { class: "hint", text: providers ? "還沒有聊天模型:到「設定 → Chat providers」新增一個" : "" }),
        h("span", { class: "grow" }),
        entries.length
          ? h(
              "button",
              {
                class: "link",
                type: "button",
                disabled: waiting,
                onClick: () => {
                  entries = [];
                  void Bridge.secretaryReset();
                  host.render();
                },
              },
              "新對話",
            )
          : null,
        h("button", { class: "btn primary", type: "button", disabled: waiting || !choices.length, onClick: () => void ask(host, input.value) }, waiting ? "處理中…" : "送出"),
      ),
    ),
  );
}
