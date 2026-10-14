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
import { kbSaid, sizeText } from "./knowledge";
import type { SecretaryProposal, SecretaryReply, SecretaryStep, SecretaryUpload } from "./types";

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
  /** The files attached to what the person asked. */
  files?: SecretaryUpload[];
  /** Files attached to the question this answers that no card of it uses. */
  unused?: SecretaryUpload[];
}

/** Files going with the next request. */
let pending: SecretaryUpload[] = [];
/** Attached files that look like they hold a key, waiting for the person's word. */
let heldKey: SecretaryUpload[] = [];
/** What went wrong attaching files, until the next attachment. */
let uploadProblems: string[] = [];

/** The files of `sent` that none of the answer's cards puts anywhere. */
export function unusedUploads(sent: SecretaryUpload[], proposals: SecretaryProposal[]): SecretaryUpload[] {
  return sent.filter((f) => !proposals.some((p) => p.uses?.includes(f.id)));
}

/** A file attached in the browser preview, where nothing is kept. */
function demoUpload(name: string, bytes: number): SecretaryUpload {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const kind = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? "image" : ["md", "txt", "json", "csv"].includes(ext) ? "text" : "file";
  return { id: `u${Math.random().toString(16).slice(2, 6)}`, name, kind, bytes, keyLike: /env|secret|key/i.test(name) ? { line: 1, sample: "sk-pr…" } : null, force: false };
}

async function attachAll(host: SecretaryHost, add: (() => Promise<SecretaryUpload>)[]) {
  uploadProblems = [];
  for (const one of add) {
    try {
      const got = await one();
      if (got.keyLike && !got.force) heldKey.push(got);
      else pending.push(got);
    } catch (err) {
      uploadProblems.push(kbSaid(String(err instanceof Error ? err.message : err)));
    }
  }
  host.render();
}

/** Files dropped on the window while the secretary's page is open, or picked. */
export function secretaryAttachPaths(paths: string[], host: SecretaryHost) {
  return attachAll(
    host,
    paths.map((path) => () => (IS_TAURI ? Bridge.secretaryUploadPath(path) : Promise.resolve(demoUpload(path.split(/[\\/]/).pop() || path, 2048)))),
  );
}

function attachFiles(files: File[], host: SecretaryHost) {
  return attachAll(
    host,
    files.map((file) => async () => {
      const name = file.name || `貼上的圖片-${Date.now()}.png`;
      return IS_TAURI ? Bridge.secretaryUploadBytes(name, await file.arrayBuffer()) : demoUpload(name, file.size);
    }),
  );
}

function pickFiles(host: SecretaryHost) {
  if (!IS_TAURI) return void secretaryAttachPaths(["D:\\Docs\\品牌指南.md", "D:\\Docs\\首頁草圖.png"], host);
  Bridge.pickFiles("附加檔案給秘書")
    .then((paths) => (paths.length ? secretaryAttachPaths(paths, host) : undefined))
    .catch((err) => {
      uploadProblems = [String(err instanceof Error ? err.message : err)];
      host.render();
    });
}

function dropUpload(id: string) {
  pending = pending.filter((f) => f.id !== id);
  heldKey = heldKey.filter((f) => f.id !== id);
  if (IS_TAURI) void Bridge.secretaryUploadRemove(id);
}

async function keepKeyed(host: SecretaryHost, f: SecretaryUpload) {
  heldKey = heldKey.filter((x) => x !== f);
  try {
    pending.push(IS_TAURI ? await Bridge.secretaryUploadForce(f.id) : { ...f, force: true });
  } catch (err) {
    uploadProblems = [String(err instanceof Error ? err.message : err)];
  }
  host.render();
}

const KIND_ICON: Record<SecretaryUpload["kind"], string> = { text: "📄", image: "🖼", file: "📎" };

/** A file chip: on the way (with ✕), or sent with a question. */
function fileChip(f: SecretaryUpload, remove?: () => void): HTMLElement {
  return h(
    "span",
    { class: "attachment sec-file", title: `${f.name} · ${sizeText(f.bytes)}${f.keyLike ? " · 疑似含金鑰" : ""}` },
    h("span", { "aria-hidden": "true", text: KIND_ICON[f.kind] }),
    h("span", { class: "attachment-name", text: f.name }),
    f.keyLike ? h("span", { class: "sec-file-key", text: "⚠" }) : null,
    remove ? h("button", { type: "button", class: "attachment-x", "aria-label": `移除 ${f.name}`, onClick: remove }, "×") : null,
  );
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
/** Proposals waiting on "the folder does not exist, create it?": id → folder. */
const askFolder = new Map<string, string>();

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
  await ask({ render, reload: async () => {}, openTeam: () => {} }, text, false);
  const last = entries[entries.length - 1];
  return last?.who === "error" ? `沒有成功:${last.text}` : (last?.text ?? "");
}

async function ask(host: SecretaryHost, text: string, withFiles = true) {
  const words = text.trim();
  if (!words || waiting) return;
  const files = withFiles ? pending : [];
  if (withFiles) pending = [];
  entries.push({ who: "you", text: words, files });
  draft = "";
  waiting = true;
  live = [];
  stick = true;
  host.render();
  try {
    const reply: SecretaryReply = IS_TAURI
      ? await Bridge.secretaryAsk(words, provider || null, tz(), name, files.map((f) => f.id))
      : await (await import("./demo")).demoSecretary(words);
    const unused = unusedUploads(files, reply.proposals);
    entries.push({ who: "secretary", text: reply.text, steps: reply.steps, proposals: reply.proposals, unused: unused.length ? unused : undefined });
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

/**
 * 確認 on a card. When the team's work folder is not there yet, the person is
 * asked first; it is created only on their 建立 (`createFolder`).
 */
async function confirm(host: SecretaryHost, p: SecretaryProposal, createFolder = false) {
  askFolder.delete(p.id);
  if (!createFolder && (p.kind === "team" || p.kind === "action")) {
    const missing = IS_TAURI ? await Bridge.secretaryMissingFolder(p.id) : (/工作資料夾:(.+?)\(還不存在/.exec(p.lines.join("\n"))?.[1] ?? null);
    if (missing) {
      askFolder.set(p.id, missing);
      host.render();
      return;
    }
  }
  doing.add(p.id);
  host.render();
  try {
    const done = IS_TAURI ? await Bridge.secretaryConfirm(p.id, tz(), createFolder) : { ...p, state: "done" as const, outcome: "(瀏覽器預覽,沒有真的執行)" };
    replace(done);
    if (p.kind === "team") await host.reload();
  } catch (err) {
    replace({ ...p, state: "failed", outcome: String(err instanceof Error ? err.message : err) });
  }
  doing.delete(p.id);
  host.render();
}

/** 取消 on "create the folder?": nothing is created, the team is not opened, and the card is cancelled. */
async function keepOut(host: SecretaryHost, p: SecretaryProposal) {
  askFolder.delete(p.id);
  await decline(host, p, "沒有建立資料夾,團隊也沒有開");
}

async function decline(host: SecretaryHost, p: SecretaryProposal, why = "") {
  const done = IS_TAURI ? await Bridge.secretaryDecline(p.id) : { ...p, state: "declined" as const };
  replace({ ...(done ?? { ...p, state: "declined" as const }), outcome: why });
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
  const folder = p.state === "open" ? askFolder.get(p.id) : undefined;
  const state = folder
    ? h(
        "div",
        { class: "sec-card-ask" },
        h("p", {}, "資料夾 ", h("code", { text: folder }), " 不存在,要建立它嗎?"),
        h(
          "div",
          { class: "sec-card-actions" },
          h("button", { class: "btn primary", type: "button", onClick: () => void confirm(host, p, true) }, "建立"),
          h("button", { class: "btn plain", type: "button", onClick: () => void keepOut(host, p) }, "取消"),
          h("span", { class: "hint", text: p.kind === "team" ? "建立資料夾後才會開這個團隊" : "建立資料夾後才會啟動" }),
        ),
      )
    :
    p.state === "done"
      ? h("div", { class: "sec-card-state done" }, h("span", { text: `✓ 已完成${p.outcome ? `:${p.outcome}` : ""}` }))
      : p.state === "declined"
        ? h("div", { class: "sec-card-state", text: p.outcome ? `已取消:${p.outcome}` : "已取消" })
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
    if (e.who === "you")
      list.append(
        h(
          "div",
          { class: "sec-row you" },
          h("div", { class: "sec-bubble you" }, h("span", { text: e.text }), e.files?.length ? h("div", { class: "attachments sec-files" }, ...e.files.map((f) => fileChip(f))) : null),
        ),
      );
    else if (e.who === "error") list.append(h("div", { class: "sec-row" }, h("div", { class: "problem", text: e.text })));
    else
      list.append(
        h(
          "div",
          { class: "sec-row" },
          h(
            "div",
            { class: "sec-bubble" },
            steps(e.steps ?? [], false),
            words(e.text),
            ...(e.proposals ?? []).map((p) => card(host, p)),
            e.unused?.length
              ? h(
                  "div",
                  { class: "sec-unused" },
                  h("span", { class: "hint", text: `附加的 ${e.unused.length} 個檔案還沒放進任何團隊` }),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "link",
                      onClick: () => {
                        pending = [...pending, ...e.unused!.filter((f) => !pending.some((x) => x.id === f.id))];
                        e.unused = undefined;
                        host.render();
                      },
                    },
                    "放回輸入列",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "link quiet-danger",
                      onClick: () => {
                        for (const f of e.unused ?? []) dropUpload(f.id);
                        e.unused = undefined;
                        host.render();
                      },
                    },
                    "丟掉",
                  ),
                )
              : null,
          ),
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
  // A pasted picture (or file) goes with the request.
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void attachFiles(files, host);
  });
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
      uploadProblems.length ? h("div", { class: "problem", role: "alert" }, ...uploadProblems.map((p) => h("div", { text: p }))) : null,
      ...heldKey.map((f) =>
        h(
          "div",
          { class: "kb-held", role: "alert" },
          h("p", {}, h("b", { text: f.name }), ` 第 ${f.keyLike?.line ?? "?"} 行看起來有金鑰(${f.keyLike?.sample ?? ""})。放進知識庫後,看得到它的成員都會讀到,並送到它們的模型服務。`),
          h(
            "div",
            { class: "row end" },
            h("button", { type: "button", class: "btn plain", onClick: () => (dropUpload(f.id), host.render()) }, "取消"),
            h("button", { type: "button", class: "btn danger", onClick: () => void keepKeyed(host, f) }, "仍要加入"),
          ),
        ),
      ),
      pending.length ? h("div", { class: "attachments sec-files" }, ...pending.map((f) => fileChip(f, () => (dropUpload(f.id), host.render())))) : null,
      input,
      h(
        "div",
        { class: "sec-composer-row" },
        choices.length
          ? dropdown({ value: provider, choices, className: "sec-model", title: "秘書用哪個聊天模型(設定 → Chat providers)", onChange: (v) => ((provider = v), store("coucou.secretary.provider", v), host.render()) })
          : h("span", { class: "hint", text: providers ? "還沒有聊天模型:到「設定 → Chat providers」新增一個" : "" }),
        h("button", { class: "link sec-attach", type: "button", title: "附加檔案(也可以拖進視窗或貼上圖片):要放進團隊知識庫的設計稿、規格、圖片…", disabled: waiting, onClick: () => pickFiles(host) }, "📎 附加檔案"),
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
                  pending = [];
                  heldKey = [];
                  uploadProblems = [];
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
