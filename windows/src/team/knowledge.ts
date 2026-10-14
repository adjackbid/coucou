// 知識庫: the documents the person gives a team — design notes, specs,
// pictures — and who in it may read each one. Every document starts as the
// leader's alone; the person opens one to the whole team here, or asks the
// leader to (team::knowledge, knowledge_share).
//
// Changes are written at once (no Save): the panel asks the backend and
// draws what comes back. Files come from the file dialog, from being dropped
// on the window while the setup tab is open, or pasted while the panel has
// the focus. In the browser preview the documents are a demo list in memory.

import "./knowledge.css";
import { Bridge, IS_TAURI } from "../core/bridge";
import { h } from "../views/dom";
import type { KnowledgeAdded, KnowledgeDoc, KnowledgeView, KnowledgeVisibility } from "./types";

export interface KnowledgeHost {
  render: () => void;
}

/** Each team's list as last read, or why it could not be read. */
const views = new Map<string, KnowledgeView | string>();
/** Lists being read, so a render does not ask twice. */
const loading = new Set<string>();
/** What went wrong with the last files, shown until the next action. */
let problems: { team: string; lines: string[] } | null = null;
/** Files that look like they hold a key, waiting for the person to say yes or no. */
let held: Held[] = [];
/** The document whose 移除 was pressed once. */
let removing: string | null = null;
/** The document whose ⋯ menu is open. */
let menuFor: string | null = null;
/** The note being written, and what is typed in it so far. */
let noting: { id: string; text: string } | null = null;
/** Files are over the window, on their way here. */
let dragging = false;
/** Thumbnails of pictures, by team, document and size (a new import is a new picture). */
const thumbs = new Map<string, Promise<string | null>>();

interface Held {
  team: string;
  name: string;
  line: number;
  sample: string;
  again: () => Promise<KnowledgeAdded>;
}

// ── Words ─────────────────────────────────────────────────────────────────────

/** `18 KB`, `3.1 MB`, as the backend writes them for members. */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/** `3 份 · 1.2 MB / 200 MB` */
export function usageLine(view: KnowledgeView): string {
  return `${view.docs.length} 份 · ${sizeText(view.bytes)} / ${Math.round(view.limits.maxBytes / 1024 / 1024)} MB`;
}

/** What a member gets of a document of this kind, in a few words. */
export function kindHint(doc: KnowledgeDoc): string {
  if (doc.program) return "程式或腳本:只保存,不會執行;成員拿到檔案路徑";
  if (doc.kind === "file") return "Coucou 不讀內容,成員拿到檔案路徑;沒有檢查是否含金鑰";
  if (doc.kind === "image") return "圖片";
  return "文字";
}

/** The backend's sentences about documents, in the window's language. */
export function kbSaid(text: string): string {
  const t = text.replace(/^Error:\s*/, "");
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^(.+) is larger than (\d+) MB\.$/, (m) => `${m[1]}:超過 ${m[2]} MB`],
    [/^A team keeps at most (\d+) documents\. Remove one first\.$/, (m) => `一個團隊最多 ${m[1]} 份文件,請先移除一些`],
    [/^(.+) is already in the knowledge base, as (.+)\.$/, (m) => `${m[1]}:已經在知識庫裡了(${m[2]})`],
    [/^The knowledge base would be larger than (\d+) MB(?: \(it holds (\d+) MB\))?\.$/, (m) => `知識庫會超過 ${m[1]} MB${m[2] ? `(目前 ${m[2]} MB)` : ""}`],
    [/^The original is no longer at (.*)\.$/, (m) => `原檔已不在 ${m[1]}`],
    [/^(.+) is no longer in the knowledge folder\.$/, (m) => `${m[1]} 的檔案不見了`],
    [/^There is no such document\.$/, () => "沒有這份文件"],
    [/^There is no such team\.$/, () => "請先建立團隊"],
    [/^Could not read (.+?): (.+)$/, (m) => `讀不到 ${m[1]}:${m[2]}`],
    [/^(.+) is not a file\.$/, (m) => `${m[1]} 不是檔案`],
    [/^Coucou does not open programs, scripts or shortcuts\. Show it in Explorer instead\.$/, () => "Coucou 不開啟程式、腳本或捷徑;請改用「在檔案總管中顯示」"],
    [/^This kind of file has no preview: open it instead\.$/, () => "這種檔案沒有預覽,請用「開啟」"],
  ];
  for (const [pattern, to] of rules) {
    const m = t.match(pattern);
    if (m) return to(m);
  }
  return t;
}

const message = (err: unknown) => kbSaid(String(err instanceof Error ? err.message : err));

/** Where a file dropped on the Teamwork window goes, by what the window shows. */
export function dropTarget(place: string, tab: string): "knowledge" | "attachment" | "secretary" | null {
  if (place === "secretary") return "secretary";
  if (place !== "team") return null;
  if (tab === "setup") return "knowledge";
  if (tab === "monitor") return "attachment";
  return null;
}

// ── The demo list (browser preview) ───────────────────────────────────────────

const LIMITS: KnowledgeView["limits"] = { maxDocs: 50, maxBytes: 200 * 1024 * 1024, maxText: 2 * 1024 * 1024, maxImage: 5 * 1024 * 1024, maxFile: 20 * 1024 * 1024 };
const demo = new Map<string, KnowledgeDoc[]>();

function demoDocs(team: string): KnowledgeDoc[] {
  let docs = demo.get(team);
  if (!docs) {
    const doc = (id: string, name: string, kind: KnowledgeDoc["kind"], bytes: number, visibility: KnowledgeVisibility, note = ""): KnowledgeDoc => ({
      id, name, kind, bytes, visibility, addedAt: Date.now(), source: `D:\\Docs\\${name}`, note, missing: false, sourceExists: true, program: false,
    });
    docs = [
      doc("k7f3a", "品牌指南.md", "text", 18_234, "shared"),
      doc("k91c0", "首頁草圖.png", "image", 820_000, "shared", "首頁三欄版型,左邊是分類"),
      doc("k2b44", "報價與底線.md", "text", 2_210, "leader"),
      doc("k5d10", "後台規格.pdf", "file", 3_200_000, "leader"),
    ];
    demo.set(team, docs);
  }
  return docs;
}

function demoView(team: string): KnowledgeView {
  const docs = demoDocs(team);
  return { docs: docs.map((d) => ({ ...d })), bytes: docs.reduce((n, d) => n + d.bytes, 0), limits: LIMITS };
}

function demoAdd(team: string, name: string, bytes: number): KnowledgeAdded {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const kind: KnowledgeDoc["kind"] = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? "image" : ["md", "txt", "json", "csv", "yaml", "yml"].includes(ext) ? "text" : "file";
  const doc: KnowledgeDoc = { id: `k${Math.random().toString(16).slice(2, 6)}`, name, kind, bytes, visibility: "leader", addedAt: Date.now(), source: "", note: "", missing: false, sourceExists: false, program: /\.(exe|bat|cmd|ps1|lnk)$/i.test(name) };
  demoDocs(team).push(doc);
  return { doc, keyLike: null };
}

// ── Talking to the backend ────────────────────────────────────────────────────

function load(team: string, host: KnowledgeHost) {
  if (!IS_TAURI) {
    views.set(team, demoView(team));
    return;
  }
  if (loading.has(team)) return;
  loading.add(team);
  Bridge.teamKnowledgeList(team)
    .then((v) => views.set(team, v))
    .catch((err) => views.set(team, message(err)))
    .finally(() => {
      loading.delete(team);
      host.render();
    });
}

/** The backend says the list changed (an edit here, the leader sharing, the secretary adding). */
export function knowledgeChanged(team: string, host: KnowledgeHost) {
  views.delete(team);
  load(team, host);
  if (!IS_TAURI) host.render();
}

/** Adds files one by one: each goes in or says why not; one that looks like it holds a key waits for a yes. */
async function addAll(team: string, host: KnowledgeHost, items: { name: string; add: (force: boolean) => Promise<KnowledgeAdded> }[]) {
  problems = null;
  removing = null;
  const lines: string[] = [];
  for (const item of items) {
    try {
      const got = await item.add(false);
      if (got.keyLike) held.push({ team, name: item.name, line: got.keyLike.line, sample: got.keyLike.sample, again: () => item.add(true) });
    } catch (err) {
      lines.push(message(err));
    }
  }
  if (lines.length) problems = { team, lines };
  knowledgeChanged(team, host);
  host.render();
}

/** Files by their paths (the dialog, a drop). */
export function addPaths(team: string, paths: string[], host: KnowledgeHost) {
  return addAll(
    team,
    host,
    paths.map((path) => ({
      name: path.split(/[\\/]/).pop() || path,
      add: (force: boolean) => (IS_TAURI ? Bridge.teamKnowledgeAddPath(team, path, force) : Promise.resolve(demoAdd(team, path.split(/[\\/]/).pop() || path, 1024))),
    })),
  );
}

/** Files by their bytes (a paste). */
export function addFiles(team: string, files: File[], host: KnowledgeHost) {
  return addAll(
    team,
    host,
    files.map((file) => {
      const name = file.name || `貼上的圖片-${stamp()}.png`;
      return {
        name,
        add: async (force: boolean) => (IS_TAURI ? Bridge.teamKnowledgeAddBytes(team, name, await file.arrayBuffer(), force) : demoAdd(team, name, file.size)),
      };
    }),
  );
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Files are over the window (or no longer). */
export function setDragging(on: boolean, host: KnowledgeHost) {
  if (dragging === on) return;
  dragging = on;
  host.render();
}

async function act(team: string, host: KnowledgeHost, what: () => Promise<unknown>) {
  problems = null;
  try {
    await what();
  } catch (err) {
    problems = { team, lines: [message(err)] };
  }
  knowledgeChanged(team, host);
  host.render();
}

function setVisibility(team: string, doc: KnowledgeDoc, visibility: KnowledgeVisibility, host: KnowledgeHost) {
  if (doc.visibility === visibility) return;
  if (!IS_TAURI) {
    const d = demoDocs(team).find((x) => x.id === doc.id);
    if (d) d.visibility = visibility;
    return knowledgeChanged(team, host);
  }
  void act(team, host, () => Bridge.teamKnowledgeUpdate(team, doc.id, visibility, null));
}

function saveNote(team: string, doc: KnowledgeDoc, text: string, host: KnowledgeHost) {
  noting = null;
  if (text.trim() === doc.note) return host.render();
  if (!IS_TAURI) {
    const d = demoDocs(team).find((x) => x.id === doc.id);
    if (d) d.note = text.trim();
    return knowledgeChanged(team, host);
  }
  void act(team, host, () => Bridge.teamKnowledgeUpdate(team, doc.id, null, text));
}

function remove(team: string, doc: KnowledgeDoc, host: KnowledgeHost) {
  removing = null;
  menuFor = null;
  if (!IS_TAURI) {
    demo.set(team, demoDocs(team).filter((x) => x.id !== doc.id));
    return knowledgeChanged(team, host);
  }
  void act(team, host, () => Bridge.teamKnowledgeRemove(team, doc.id));
}

function reimport(team: string, doc: KnowledgeDoc, host: KnowledgeHost) {
  menuFor = null;
  if (!IS_TAURI) return host.render();
  void act(team, host, async () => {
    const got = await Bridge.teamKnowledgeReimport(team, doc.id, false);
    if (got.keyLike) held.push({ team, name: doc.name, line: got.keyLike.line, sample: got.keyLike.sample, again: () => Bridge.teamKnowledgeReimport(team, doc.id, true) });
  });
}

function pick(team: string, host: KnowledgeHost) {
  if (!IS_TAURI) {
    void addPaths(team, ["D:\\Docs\\新的設計稿.md"], host);
    return;
  }
  Bridge.pickFiles("加入知識庫文件")
    .then((paths) => (paths.length ? addPaths(team, paths, host) : undefined))
    .catch((err) => {
      problems = { team, lines: [message(err)] };
      host.render();
    });
}

// ── Pictures and previews ─────────────────────────────────────────────────────

function thumb(team: string, doc: KnowledgeDoc): HTMLElement {
  const img = h("img", { class: "kb-thumb", alt: "", draggable: "false" }) as HTMLImageElement;
  if (!IS_TAURI) return h("span", { class: "kb-icon pic", "aria-hidden": "true", text: "🖼" });
  const key = `${team}|${doc.id}|${doc.bytes}`;
  let url = thumbs.get(key);
  if (!url) {
    url = Bridge.teamKnowledgePreview(team, doc.id)
      .then((bytes) => URL.createObjectURL(new Blob([bytes])))
      .catch(() => null);
    thumbs.set(key, url);
  }
  void url.then((u) => {
    if (u) img.src = u;
  });
  return h("span", { class: "kb-icon pic" }, img);
}

/** The document large: its text, or the picture, over the window. */
function preview(team: string, doc: KnowledgeDoc) {
  const problem = h("p", { class: "lightbox-problem" });
  const stage = h("div", { class: "lightbox-stage kb-stage", onClick: (e: Event) => e.stopPropagation() });
  let url: string | null = null;
  const close = () => {
    document.removeEventListener("keydown", keys, true);
    box.remove();
    if (url) URL.revokeObjectURL(url);
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const run = (what: () => Promise<unknown>) => (e: Event) => {
    e.stopPropagation();
    what().catch((err) => (problem.textContent = message(err)));
  };
  const box = h(
    "div",
    { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": doc.name, onClick: () => close() },
    stage,
    h(
      "div",
      { class: "lightbox-bar", onClick: (e: Event) => e.stopPropagation() },
      h("div", { class: "lightbox-title" }, h("b", { class: "lightbox-name", text: doc.name }), h("span", { class: "lightbox-count", text: sizeText(doc.bytes) })),
      problem,
      h(
        "div",
        { class: "lightbox-actions" },
        doc.program ? null : h("button", { type: "button", class: "btn plain", onClick: run(() => (IS_TAURI ? Bridge.teamKnowledgeOpen(team, doc.id) : Promise.resolve())) }, "用預設程式開啟"),
        h("button", { type: "button", class: "btn plain", onClick: run(() => (IS_TAURI ? Bridge.teamKnowledgeReveal(team, doc.id) : Promise.resolve())) }, "在檔案總管中顯示"),
        h("button", { type: "button", class: "btn plain", onClick: () => close() }, "關閉"),
      ),
    ),
  );
  document.addEventListener("keydown", keys, true);
  document.body.append(box);

  const MAX_TEXT = 200 * 1024;
  if (!IS_TAURI) {
    stage.append(doc.kind === "image" ? h("p", { class: "dim", text: "(瀏覽器預覽沒有圖片)" }) : h("pre", { class: "kb-pre", text: `# ${doc.name}\n\n(瀏覽器預覽的示範內容)` }));
    return;
  }
  Bridge.teamKnowledgePreview(team, doc.id).then(
    (bytes) => {
      if (doc.kind === "image") {
        url = URL.createObjectURL(new Blob([bytes]));
        stage.append(h("img", { class: "lightbox-img", alt: "", src: url, draggable: "false" }));
      } else {
        const cut = bytes.byteLength > MAX_TEXT;
        const text = new TextDecoder().decode(cut ? bytes.slice(0, MAX_TEXT) : bytes);
        stage.append(h("pre", { class: "kb-pre", text }));
        if (cut) stage.append(h("p", { class: "hint", text: `只顯示前 200 KB,全文共 ${sizeText(bytes.byteLength)}` }));
      }
    },
    (err) => (problem.textContent = message(err)),
  );
}

// ── The panel ─────────────────────────────────────────────────────────────────

function row(team: string, doc: KnowledgeDoc, host: KnowledgeHost): HTMLElement {
  const icon = doc.kind === "image" && !doc.missing ? thumb(team, doc) : h("span", { class: "kb-icon", "aria-hidden": "true", text: doc.kind === "text" ? "📄" : "📎" });
  const vis = h(
    "div",
    { class: "segmented kb-vis", role: "group", "aria-label": `${doc.name} 誰看得到` },
    ...(
      [
        ["leader", "只有 Leader"],
        ["shared", "團隊共享"],
      ] as [KnowledgeVisibility, string][]
    ).map(([v, label]) =>
      h("button", { type: "button", class: doc.visibility === v ? "on" : "", disabled: doc.missing, "aria-pressed": String(doc.visibility === v), onClick: () => setVisibility(team, doc, v, host) }, label),
    ),
  );

  let note: HTMLElement;
  if (noting?.id === doc.id) {
    // data-key: the window's redraws give the caret back to it (main.ts render).
    const key = `kb-note-${doc.id}`;
    const input = h("input", { class: "field kb-note-input", "data-key": key, maxlength: "500", placeholder: "一句話說明這份文件" }) as HTMLInputElement;
    input.value = noting.text;
    input.addEventListener("input", () => noting && (noting.text = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") {
        noting = null;
        host.render();
      }
    });
    // Saved when the person leaves it — not when a redraw replaces it with its twin.
    input.addEventListener("blur", () =>
      setTimeout(() => {
        const now = document.activeElement as HTMLElement | null;
        if (noting?.id !== doc.id || now?.dataset?.key === key) return;
        saveNote(team, doc, noting.text, host);
      }),
    );
    queueMicrotask(() => {
      if (document.activeElement?.getAttribute("data-key") === key) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    note = input;
  } else {
    note = h(
      "button",
      { type: "button", class: `kb-note${doc.note ? "" : " empty"}`, disabled: doc.missing, title: "點一下修改說明", onClick: () => ((noting = { id: doc.id, text: doc.note }), host.render()) },
      doc.note || (doc.kind === "image" ? "加一句說明(看不到圖片的 agent 會讀這句)" : "加一句說明"),
    );
  }

  const canPreview = doc.kind !== "file" && !doc.missing;
  const menu =
    menuFor === doc.id
      ? h(
          "div",
          { class: "kb-menu", role: "menu", onClick: (e: Event) => e.stopPropagation() },
          h("button", { type: "button", role: "menuitem", disabled: !doc.sourceExists, title: doc.sourceExists ? `從 ${doc.source} 再複製一次` : doc.source ? `原檔已不在 ${doc.source}` : "這份文件是貼上的,沒有原檔", onClick: () => reimport(team, doc, host) }, "重新匯入"),
          h("button", { type: "button", role: "menuitem", disabled: doc.missing, onClick: () => ((menuFor = null), void act(team, host, () => (IS_TAURI ? Bridge.teamKnowledgeReveal(team, doc.id) : Promise.resolve()))) }, "在檔案總管中顯示"),
          h("button", { type: "button", role: "menuitem", class: "danger", onClick: () => ((menuFor = null), (removing = doc.id), host.render()) }, "移除"),
        )
      : null;

  return h(
    "div",
    { class: `kb-row${doc.missing ? " missing" : ""}`, "data-doc": doc.id },
    icon,
    h(
      "div",
      { class: "kb-main" },
      h(
        "div",
        { class: "kb-name" },
        h("b", { text: doc.name, title: doc.source || doc.name }),
        h("span", { class: "dim", text: ` ${sizeText(doc.bytes)}` }),
        doc.missing ? h("span", { class: "kb-tag bad", text: "檔案不見了" }) : doc.kind === "file" ? h("span", { class: "kb-tag", title: kindHint(doc), text: doc.program ? "程式 · 只保存" : "成員拿到檔案路徑" }) : null,
      ),
      note,
    ),
    removing === doc.id
      ? h(
          "div",
          { class: "kb-confirm" },
          h("span", { text: "確定移除?" }),
          h("button", { type: "button", class: "btn danger", onClick: () => remove(team, doc, host) }, "移除"),
          h("button", { type: "button", class: "btn plain", onClick: () => ((removing = null), host.render()) }, "取消"),
        )
      : h(
          "div",
          { class: "kb-side" },
          vis,
          canPreview
            ? h("button", { type: "button", class: "link", onClick: () => preview(team, doc) }, "預覽")
            : !doc.missing && !doc.program
              ? h("button", { type: "button", class: "link", onClick: () => void act(team, host, () => (IS_TAURI ? Bridge.teamKnowledgeOpen(team, doc.id) : Promise.resolve())) }, "開啟")
              : null,
          h(
            "div",
            { class: "kb-more" },
            h("button", { type: "button", class: "link kb-dots", "aria-label": "更多", "aria-expanded": String(menuFor === doc.id), onClick: (e: Event) => (e.stopPropagation(), (menuFor = menuFor === doc.id ? null : doc.id), host.render()) }, "⋯"),
            menu,
          ),
        ),
  );
}

/**
 * The 知識庫 panel of a team's setup. `leader` names the leader for the hint;
 * `running` says changes reach the members at once.
 */
export function knowledgePanel(team: string, leader: string, running: boolean, host: KnowledgeHost): HTMLElement {
  if (!views.has(team)) load(team, host);
  const view = views.get(team);
  const mine = held.filter((x) => x.team === team);
  const zone = h(
    "div",
    { class: `kb-drop${dragging ? " over" : ""}`, tabindex: "0", title: "也可以在這裡按 Ctrl+V 貼上圖片" },
    h("span", { text: "把檔案拖到這裡,或" }),
    h("button", { type: "button", class: "btn plain", onClick: () => pick(team, host) }, "選擇檔案…"),
    h("span", { class: "dim", text: "任何格式;文字與圖片 agent 讀得最好" }),
  );

  const panel = h(
    "section",
    { class: "panel form knowledge", onClick: () => (menuFor ? ((menuFor = null), host.render()) : undefined) },
    h("div", { class: "panel-head" }, h("h2", {}, "知識庫", typeof view === "object" ? h("span", { class: "count", text: String(view.docs.length) }) : null), typeof view === "object" ? h("span", { class: "dim kb-usage", text: usageLine(view) }) : null),
    h("p", { class: "hint", text: "給團隊參考的文件(設計稿、規格、圖片…)。加入時會複製一份,原檔之後搬走或修改都不影響;加入就存好了,不用按儲存。" }),
    problems?.team === team ? h("div", { class: "problem", role: "alert" }, ...problems.lines.map((l) => h("div", { text: l }))) : null,
    ...mine.map((x) =>
      h(
        "div",
        { class: "kb-held", role: "alert" },
        h("p", {}, h("b", { text: x.name }), ` 第 ${x.line} 行看起來有金鑰(${x.sample})。金鑰會被看得到這份文件的成員讀到,並送到它們的模型服務。`),
        h(
          "div",
          { class: "row end" },
          h("button", { type: "button", class: "btn plain", onClick: () => ((held = held.filter((y) => y !== x)), host.render()) }, "取消"),
          h(
            "button",
            {
              type: "button",
              class: "btn danger",
              onClick: () => {
                held = held.filter((y) => y !== x);
                void act(team, host, x.again);
              },
            },
            "仍要加入",
          ),
        ),
      ),
    ),
    zone,
    typeof view === "string"
      ? h("p", { class: "problem", text: view })
      : !view
        ? h("p", { class: "dim", text: "讀取中…" })
        : view.docs.length
          ? h("div", { class: "kb-list" }, ...view.docs.map((d) => row(team, d, host)))
          : h("p", { class: "dim kb-empty", text: "還沒有文件。" }),
    h("p", { class: "hint", text: `只有 Leader:只有 ${leader || "Leader"} 讀得到。團隊共享:所有成員都讀得到。已經讀過的成員不會忘記內容。${running ? "團隊執行中:改動馬上生效。" : ""}` }),
  );
  // Pasted pictures (or files) while the panel has the focus.
  panel.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void addFiles(team, files, host);
  });
  return panel;
}
