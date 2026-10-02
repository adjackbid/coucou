// The Teamwork window: which teams there are, and — for the one selected —
// who is doing what, who waits on whom and what has been handed in.
//
// Everything shown comes from the team's snapshot as the orchestrator sends
// it (`team-changed`); this page keeps no state of its own beyond what is
// being typed. The screen is drawn again whole on every change, which is
// cheap at this size and leaves nothing to fall out of step.

import "./team.css";
import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import { h, clear } from "../views/dom";
import type { Danger, Deliverable, FeedItem, MemberStatus, MemberView, Snapshot, Task, TeamConfig, TeamFile } from "./types";

const root = document.getElementById("team-root")!;

let dir = "";
let files: TeamFile[] = [];
/** The latest snapshot of each team, by team id. */
const runs = new Map<string, Snapshot>();
/** The team file being looked at. */
let selected: string | null = null;
/** The last thing that went wrong, shown until the next action. */
let trouble = "";
/** Who the instruction box writes to: "" is the leader. */
let recipient = "";
/** What is typed in each field, so drawing again does not lose it. */
const drafts = new Map<string, string>();

const YOU = "you";
const PALETTE = ["#5b8def", "#34c7a0", "#a06cf0", "#f5b63d", "#ef6f8f", "#4fc3e8"];

const STATUS: Record<MemberStatus, { label: string; mark: string }> = {
  working: { label: "工作中", mark: "◔" },
  waitingDelivery: { label: "等待交付", mark: "⧖" },
  waitingReply: { label: "等待回覆", mark: "…" },
  waitingYou: { label: "等你處理", mark: "!" },
  idle: { label: "待命", mark: "○" },
  done: { label: "已完成", mark: "✓" },
  lost: { label: "失聯", mark: "×" },
};

const TEAM_STATUS: Record<Snapshot["status"], string> = {
  idle: "尚未啟動",
  running: "執行中",
  paused: "已暫停",
  finished: "已完成",
};

const DANGER: Record<Danger, string> = {
  "deletes-folder": "會刪除資料夾",
  "deletes-many": "會一次刪除多個檔案",
  installs: "會安裝套件或程式",
  downloads: "會從網路下載東西",
  "destructive-git": "這個 git 指令會丟掉變更",
  "sends-out": "會對外發送或發布",
  "outside-work-dir": "會動到工作資料夾以外的地方",
  system: "會變更系統或其他程序",
  opaque: "無法判讀這個指令在做什麼",
};

const PRIORITY: Record<Task["priority"], string> = { high: "高", medium: "中", low: "低" };

// ── Small pieces ──────────────────────────────────────────────────────────────

/**
 * The orchestrator's own sentences, in the window's language. Anything else —
 * an agent's error message, say — is shown as it came.
 */
function said(text: string): string {
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^It ended two turns in a row without a word about its open work\.$/, () => "連續兩輪結束時都沒有回報手上的工作"],
    [/^Paused by the user\.$/, () => "由你暫停"],
    [/^The team has used its (\d+) turns\.$/, (m) => `已用完 ${m[1]} 回合的上限`],
    [/^(TASK-\d+) was sent back (\d+) times\.$/, (m) => `${m[1]} 已被退回 ${m[2]} 次`],
    [/^Coucou was closed while the team was running\.$/, () => "團隊執行中時 Coucou 被關閉"],
    [/^interrupted$/, () => "被中斷"],
    // Why a team file cannot start.
    [/^The work folder (.+) does not exist\.$/, (m) => `工作資料夾 ${m[1]} 不存在`],
    [/^The work folder must be a full path\.$/, () => "工作資料夾必須是完整路徑"],
    [/^(.+) runs as agent '(.+)', which is not in Settings → Agents\.$/, (m) => `${m[1]} 使用的代理「${m[2]}」不在 設定 → Agents 裡`],
    [/^The leader '(.+)' is not a member\.$/, (m) => `Leader「${m[1]}」不是團隊成員`],
    [/^The team has no goal\.$/, () => "團隊沒有填寫任務目標"],
    [/^The team has no members\.$/, () => "團隊沒有成員"],
    [/^Two members are called '(.+)'\.$/, (m) => `有兩位成員的 id 都是「${m[1]}」`],
    [/^'(.+)' cannot be a member id\.$/, (m) => `「${m[1]}」不能當成員 id`],
    [/^The team id may only use letters, digits, '-' and '_'\.$/, () => "團隊 id 只能用英數字、- 與 _"],
    [/^A link joins '(.+)' and '(.+)', and one of them is not a member\.$/, (m) => `協作關係連到「${m[1]}」與「${m[2]}」,其中一個不是成員`],
    [/^The team '(.+)' is already running\.$/, (m) => `團隊「${m[1]}」已經在執行中`],
  ];
  for (const [pattern, to] of rules) {
    const m = text.match(pattern);
    if (m) return to(m);
  }
  return text;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function colorOf(snap: Snapshot | TeamConfig, id: string): string {
  const at = snap.members.findIndex((m) => m.id === id);
  if (at < 0) return "#9aa3b8";
  return snap.members[at].color || PALETTE[at % PALETTE.length];
}

function nameOf(snap: Snapshot, id: string): string {
  if (id === YOU) return "你";
  if (id === "system") return "Coucou";
  return snap.members.find((m) => m.id === id)?.name ?? id;
}

/** A member's face: the same blob as the drafts, in the member's colour. */
function blob(color: string, size = 28): HTMLElement {
  return h("i", { class: "blob", style: `--c:${color};--s:${size}px`, "aria-hidden": "true" });
}

function who(snap: Snapshot, id: string, size = 20): HTMLElement {
  if (id === YOU || id === "system") return h("span", { class: "who", text: nameOf(snap, id) });
  return h("span", { class: "who" }, blob(colorOf(snap, id), size), h("span", { text: nameOf(snap, id) }));
}

function button(label: string, kind: "primary" | "plain" | "danger", onClick: () => void, disabled = false): HTMLElement {
  return h("button", { class: `btn ${kind}`, type: "button", disabled, onClick: () => onClick() }, label);
}

/** A text field that survives the screen being drawn again. */
function field(key: string, placeholder: string, onSubmit: (text: string) => void): HTMLInputElement {
  const input = h("input", { type: "text", class: "field", placeholder, "data-key": key, spellcheck: "false" }) as HTMLInputElement;
  input.value = drafts.get(key) ?? "";
  input.addEventListener("input", () => drafts.set(key, input.value));
  input.addEventListener("keydown", (e) => {
    // What was typed stays until it has really been sent.
    if (e.key === "Enter" && !e.isComposing && input.value.trim()) onSubmit(input.value.trim());
  });
  return input;
}

/** Runs something the person clicked, and shows what went wrong if it did. */
async function act(what: () => Promise<unknown>, after?: () => void) {
  trouble = "";
  try {
    await what();
    after?.();
  } catch (err) {
    trouble = String(err instanceof Error ? err.message : err);
  }
  render();
}

// ── Sidebar: the teams ────────────────────────────────────────────────────────

function sidebar(): HTMLElement {
  const list = h("div", { class: "team-list" });
  for (const file of files) {
    const run = file.config ? runs.get(file.config.id) : undefined;
    const state = run ? TEAM_STATUS[run.status] : file.problems.length ? "需要修正" : "尚未啟動";
    const needsYou = run?.members.some((m) => m.status === "waitingYou" || m.status === "lost") ?? false;
    list.append(
      h(
        "button",
        {
          class: `team-item${file.file === selected ? " on" : ""}`,
          type: "button",
          onClick: () => {
            selected = file.file;
            trouble = "";
            render();
          },
        },
        h("span", { class: "team-item-name", text: file.config?.name ?? file.file }),
        h("span", { class: `team-item-state${run?.status === "running" ? " live" : ""}`, text: needsYou ? `${state} · 等你` : state }),
      ),
    );
  }
  if (!files.length) list.append(h("p", { class: "hint", text: "還沒有團隊檔案。" }));

  return h(
    "aside",
    { class: "sidebar glass" },
    h("div", { class: "brand" }, blob("#ffffff", 34), h("span", { text: "Teamwork" })),
    h("div", { class: "side-title", text: "團隊" }),
    list,
    h(
      "div",
      { class: "side-foot" },
      button("開啟團隊資料夾", "plain", () => void Bridge.teamOpenConfigs()),
      button("重新整理", "plain", () => void load()),
      h("p", { class: "hint", text: "每個團隊是資料夾裡的一個 JSON 檔。設定畫面完成前,請直接編輯檔案。" }),
    ),
  );
}

// ── A team that has not run yet ───────────────────────────────────────────────

function setup(file: TeamFile): HTMLElement {
  const config = file.config;
  const box = h("section", { class: "panel" });
  if (!config) {
    box.append(h("h2", { text: file.file }), h("p", { class: "problem", text: file.problems.join("\n") }));
    return box;
  }
  box.append(h("h2", { text: "團隊成員" }));
  const members = h("div", { class: "setup-members" });
  for (const m of config.members) {
    members.append(
      h(
        "div",
        { class: "setup-member" },
        blob(colorOf(config, m.id), 34),
        h(
          "div",
          {},
          h("div", { class: "setup-name" }, m.name, m.id === config.leader ? h("span", { class: "chip leader", text: "Leader" }) : null, h("span", { class: "chip", text: m.role })),
          h("div", { class: "dim", text: m.duty || "—" }),
        ),
        h("span", { class: "chip agent", title: "這位成員使用的代理(設定 → Agents)", text: m.agent }),
      ),
    );
  }
  box.append(members);
  box.append(
    h(
      "dl",
      { class: "facts" },
      h("dt", { text: "工作資料夾" }),
      h("dd", { class: "mono", text: config.workDir }),
      h("dt", { text: "工作模式" }),
      h("dd", { text: config.autoApprove ? "自主協作:一般動作不詢問,危險動作仍會問你" : "每個權限請求都問你" }),
      h("dt", { text: "回合上限" }),
      h("dd", { text: `${config.maxTurns} 回合後暫停等你` }),
    ),
  );
  if (file.problems.length) {
    box.append(h("div", { class: "problem" }, h("strong", { text: "這個團隊還不能啟動:" }), ...file.problems.map((p) => h("div", { text: `• ${said(p)}` }))));
  }
  box.append(
    h(
      "div",
      { class: "row end" },
      button("啟動 Teamwork", "primary", () => void act(async () => runs.set(config.id, await Bridge.teamStart(file.file))), file.problems.length > 0),
    ),
  );
  return box;
}

// ── The monitor ───────────────────────────────────────────────────────────────

function memberCard(snap: Snapshot, m: MemberView): HTMLElement {
  const status = STATUS[m.status];
  const task = m.task ? snap.tasks.find((t) => t.id === m.task) : undefined;
  const card = h("article", { class: `member ${m.status}` });
  card.append(
    h(
      "header",
      {},
      blob(colorOf(snap, m.id), 46),
      h(
        "div",
        { class: "member-head" },
        h("div", { class: "member-name" }, m.name, h("span", { class: `badge ${m.status}` }, h("b", { text: status.mark }), status.label)),
        h("div", { class: "member-role", text: m.isLeader ? `Leader · ${m.role}` : m.role }),
      ),
    ),
  );

  // What it is on, or what it is waiting for — always with a name.
  const lines = h("div", { class: "member-lines" });
  if (m.status === "waitingDelivery" && m.waiting) {
    lines.append(h("div", { text: `等待${m.waiting.what}` }), h("div", { class: "dim", text: `來自 ${nameOf(snap, m.waiting.on)}` }));
  } else if (m.status === "waitingReply" && m.waiting) {
    lines.append(h("div", { text: `等 ${nameOf(snap, m.waiting.on)} 回覆` }), h("div", { class: "dim", text: m.waiting.what }));
  } else if (m.status === "lost") {
    lines.append(h("div", { class: "dim", text: said(m.lostWhy) }));
  } else if (task) {
    lines.append(h("div", { text: task.title }));
    if (m.status === "working" && m.activity) lines.append(h("div", { class: "dim mono", text: m.activity }));
  } else if (m.status === "working") {
    lines.append(h("div", { text: m.activity || "思考中" }));
  } else {
    lines.append(h("div", { class: "dim", text: m.status === "done" ? "交辦的工作都已交付" : "目前沒有工作" }));
  }
  card.append(lines);

  // The three things that wait for the person, answered right on the card.
  if (m.permission) {
    const p = m.permission;
    const input = p.rawInput && typeof p.rawInput === "object" ? (p.rawInput as Record<string, unknown>) : {};
    const command = typeof input.command === "string" ? input.command : "";
    const allow = p.options.find((o) => o.kind === "allow_once") ?? p.options.find((o) => o.kind === "allow_always");
    const reject = p.options.find((o) => o.kind === "reject_once") ?? p.options.find((o) => o.kind === "reject_always");
    card.append(
      h(
        "div",
        { class: "ask" },
        h("div", { class: "ask-why", text: p.danger ? `要你批准:${DANGER[p.danger]}` : "要你批准" }),
        h("div", { class: "ask-what mono", text: command || p.title }),
        h(
          "div",
          { class: "row" },
          button("允許這一次", "primary", () => void act(() => Bridge.teamPermit(snap.id, m.id, allow?.optionId ?? null)), !allow),
          button("拒絕", "plain", () => void act(() => Bridge.teamPermit(snap.id, m.id, reject?.optionId ?? null))),
        ),
      ),
    );
  }
  const question = snap.questions.find((q) => q.by === m.id && q.answer === null);
  if (question) {
    card.append(
      h(
        "div",
        { class: "ask" },
        h("div", { class: "ask-why", text: "問你" }),
        h("div", { class: "ask-what", text: question.question }),
        field(`answer:${snap.id}:${question.id}`, "輸入回覆後按 Enter", (text) =>
          void act(
            () => Bridge.teamAnswer(snap.id, question.id, text),
            () => drafts.delete(`answer:${snap.id}:${question.id}`),
          ),
        ),
      ),
    );
  }
  if (m.status === "lost") {
    card.append(h("div", { class: "row" }, button("重新啟動這位成員", "primary", () => void act(() => Bridge.teamRecover(snap.id, m.id)))));
  }

  card.append(
    h("footer", {}, h("span", { class: "dim", text: m.duty }), h("span", { class: "chip agent", title: "使用的代理 · 已進行的回合數", text: `${m.agent} · ${m.turns} 回合` })),
  );
  return card;
}

function taskCard(snap: Snapshot, t: Task): HTMLElement {
  const met = t.criteria.filter((c) => c.claimed).length;
  const waitsFor = t.status === "todo" ? t.dependsOn.map((d) => snap.tasks.find((x) => x.id === d)).filter((d) => d && d.status !== "delivered" && d.status !== "done") : [];
  const card = h("article", { class: `task${t.blocked ? " blocked" : ""}`, title: t.detail });
  card.append(h("div", { class: "task-title" }, h("span", { text: t.title }), t.status === "done" ? h("span", { class: "tick", text: "✓", title: "已驗收" }) : null));
  const sub = t.blocked ? `卡住:${t.blocked.reason}(等 ${nameOf(snap, t.blocked.on)})` : waitsFor.length ? `等待${waitsFor.map((d) => d!.title).join("、")}` : t.note || t.detail.split("\n")[0];
  if (sub) card.append(h("div", { class: t.blocked ? "task-sub warn" : "task-sub", text: sub }));
  const marks = h("div", { class: "task-marks" });
  if (t.status === "delivered") marks.append(h("span", { class: "chip pending", text: "已交付,待驗收" }));
  if (t.criteria.length && t.status !== "done") marks.append(h("span", { class: "chip", title: t.criteria.map((c) => `${c.claimed ? "☑" : "☐"} ${c.text}`).join("\n"), text: `完成條件 ${met} / ${t.criteria.length}` }));
  if (t.rejections) marks.append(h("span", { class: "chip warn", text: `退回 ${t.rejections} 次` }));
  card.append(h("div", { class: "task-foot" }, who(snap, t.owner), marks, h("span", { class: `chip prio ${t.priority}`, title: "優先度", text: PRIORITY[t.priority] })));
  return card;
}

function board(snap: Snapshot): HTMLElement {
  const columns: [string, string, Task[]][] = [
    ["待處理", "todo", snap.tasks.filter((t) => t.status === "todo")],
    ["進行中", "doing", snap.tasks.filter((t) => t.status === "doing")],
    ["已完成", "done", snap.tasks.filter((t) => t.status === "delivered" || t.status === "done")],
  ];
  const grid = h("div", { class: "board" });
  for (const [title, kind, tasks] of columns) {
    const col = h("div", { class: `column ${kind}` }, h("div", { class: "column-head" }, h("span", { text: title }), h("span", { class: "count", text: String(tasks.length) })));
    for (const t of tasks) col.append(taskCard(snap, t));
    if (!tasks.length) col.append(h("div", { class: "empty", text: "—" }));
    grid.append(col);
  }
  return h("section", { class: "panel" }, h("h2", { text: "任務看板" }), snap.tasks.length ? grid : h("p", { class: "dim", text: "Leader 還沒有建立任務。" }));
}

const FEED_TITLE: Record<FeedItem["kind"], string> = {
  message: "訊息",
  task: "建立任務",
  delivered: "已交付",
  accepted: "驗收通過",
  rejected: "退回",
  blocked: "被卡住",
  asked: "向你提問",
  answered: "你的回覆",
  lost: "失聯",
  paused: "團隊暫停",
  finished: "團隊完成",
};

function feed(snap: Snapshot): HTMLElement {
  const list = h("div", { class: "feed" });
  const items = [...snap.feed].reverse().slice(0, 40);
  for (const item of items) {
    const task = item.task ? snap.tasks.find((t) => t.id === item.task) : undefined;
    const title = item.kind === "message" || item.kind === "task" || !task ? FEED_TITLE[item.kind] : `${FEED_TITLE[item.kind]} · ${task.title}`;
    list.append(
      h(
        "div",
        { class: `feed-item ${item.kind}${item.to === YOU ? " to-you" : ""}` },
        h("div", { class: "feed-head" }, who(snap, item.from), item.to ? h("span", { class: "arrow", text: "→" }) : null, item.to ? who(snap, item.to) : null, h("time", { text: clock(item.at) })),
        h("div", { class: "feed-title", text: item.kind === "task" && task ? `${title} · ${task.title}` : title }),
        item.text && item.kind !== "task" ? h("div", { class: "feed-text", text: said(item.text) }) : null,
      ),
    );
  }
  if (!items.length) list.append(h("p", { class: "dim", text: "還沒有任何協作紀錄。" }));
  return h("section", { class: "panel feed-panel" }, h("h2", { text: "最新協作" }), list);
}

function deliverables(snap: Snapshot): HTMLElement {
  const row = h("div", { class: "deliverables" });
  const icon = (d: Deliverable) => (d.locator.startsWith("http") ? "↗" : /image|圖/.test(d.kind) ? "▣" : /source|code|原始/.test(d.kind) ? "</>" : "▤");
  for (const d of [...snap.deliverables].reverse()) {
    const task = snap.tasks.find((t) => t.id === d.task);
    row.append(
      h(
        "button",
        { class: "deliverable", type: "button", title: `開啟 ${d.locator}`, onClick: () => void act(() => Bridge.teamOpen(snap.id, d.locator)) },
        h("span", { class: "deliverable-icon", text: icon(d) }),
        h(
          "span",
          { class: "deliverable-body" },
          h("span", { class: "deliverable-name", text: task?.title ?? d.task }),
          h("span", { class: "dim mono", text: d.locator }),
          h("span", { class: "dim", text: `${nameOf(snap, d.by)} · ${clock(d.at)} · ${d.summary}` }),
        ),
        h("span", { class: `chip ${d.accepted === true ? "ok" : d.accepted === false ? "warn" : "pending"}`, text: d.accepted === true ? "已驗收" : d.accepted === false ? "已退回" : "待驗收" }),
      ),
    );
  }
  if (!snap.deliverables.length) row.append(h("p", { class: "dim", text: "還沒有成員交付成果。" }));
  return h("section", { class: "panel" }, h("h2", { text: "已產生成果" }), row);
}

function composer(snap: Snapshot): HTMLElement {
  const select = h("select", { class: "field narrow", title: "傳給誰" }) as HTMLSelectElement;
  select.append(h("option", { value: "", text: "給 Leader" }));
  for (const m of snap.members) if (!m.isLeader) select.append(h("option", { value: m.id, text: `給 ${m.name}` }));
  select.value = recipient;
  select.addEventListener("change", () => (recipient = select.value));
  const send = (text: string) =>
    void act(
      () => Bridge.teamInstruct(snap.id, recipient, text),
      () => drafts.delete(`instruct:${snap.id}`),
    );
  const input = field(`instruct:${snap.id}`, "傳送新指示…(對方這一輪結束後才會讀到)", send);
  return h(
    "div",
    { class: "composer glass" },
    select,
    input,
    button("送出", "primary", () => {
      if (input.value.trim()) send(input.value.trim());
    }),
  );
}

function monitor(snap: Snapshot): HTMLElement {
  const percent = snap.total ? Math.round((snap.done / snap.total) * 100) : 0;
  const minutes = Math.max(0, Math.floor(((snap.finishedAt || Date.now()) - snap.startedAt) / 60_000));
  // Whoever waits on the person comes first.
  const order = (m: MemberView) => (m.status === "waitingYou" ? 0 : m.status === "lost" ? 1 : 2);
  const members = [...snap.members].sort((a, b) => order(a) - order(b));

  return h(
    "div",
    { class: "monitor" },
    h(
      "div",
      { class: "progress" },
      h("span", { class: "progress-label", text: "整體進度" }),
      h("span", { class: "progress-number", text: `${percent}%` }),
      h("div", { class: "bar", role: "progressbar", "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${percent}%` })),
      h("span", { class: "dim", text: `已驗收 ${snap.done} / ${snap.total} 項任務` }),
      h("span", { class: "dim", text: `${snap.totalTurns} / ${snap.maxTurns} 回合` }),
      h("span", { class: "dim", text: `已執行 ${minutes} 分鐘` }),
    ),
    h("div", { class: "members" }, ...members.map((m) => memberCard(snap, m))),
    h("div", { class: "split" }, board(snap), feed(snap)),
    deliverables(snap),
    snap.status === "finished" ? null : composer(snap),
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

function header(file: TeamFile, snap: Snapshot | undefined): HTMLElement {
  const name = snap?.name ?? file.config?.name ?? file.file;
  const goal = (snap?.goal ?? file.config?.goal ?? "").split("\n")[0];
  const count = snap?.members.length ?? file.config?.members.length ?? 0;
  const actions = h("div", { class: "row" });
  if (snap?.status === "running") {
    actions.append(
      button("暫停", "plain", () => void act(() => Bridge.teamPause(snap.id))),
      button("全部中斷", "danger", () => void act(() => Bridge.teamInterrupt(snap.id))),
    );
  } else if (snap?.status === "paused") {
    actions.append(button("繼續", "primary", () => void act(() => Bridge.teamResume(snap.id))));
  }
  if (snap && snap.status !== "running" && file.config) {
    actions.append(button("重新啟動團隊", "plain", () => void act(async () => runs.set(file.config!.id, await Bridge.teamStart(file.file))), file.problems.length > 0));
  }
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      {},
      h("h1", {}, name, snap ? h("span", { class: `state ${snap.status}`, text: TEAM_STATUS[snap.status] }) : null),
      h("p", { class: "dim", text: `${goal} · ${count} 位 AI 成員` }),
      snap?.status === "paused" && snap.pausedWhy ? h("p", { class: "paused-why", text: said(snap.pausedWhy) }) : null,
    ),
    actions,
  );
}

function tabs(): HTMLElement {
  // The other three screens come with the next stage; they are shown so the
  // order is clear, and say so rather than pretend.
  const tab = (label: string, on: boolean) =>
    h("button", { class: `tab${on ? " on" : ""}`, type: "button", disabled: !on }, label, on ? null : h("small", { text: "下一階段" }));
  return h("nav", { class: "tabs glass" }, tab("團隊設定", false), tab("協作關係", false), tab("工作監控", true), tab("溝通紀錄", false));
}

function main(): HTMLElement {
  const file = files.find((f) => f.file === selected);
  if (!file) {
    return h(
      "main",
      { class: "main glass" },
      h("div", { class: "welcome" }, h("h1", { text: "Teamwork" }), h("p", { class: "dim", text: "從左邊選一個團隊。" }), dir ? h("p", { class: "dim mono", text: dir }) : null),
    );
  }
  const snap = file.config ? runs.get(file.config.id) : undefined;
  return h(
    "main",
    { class: "main glass" },
    header(file, snap),
    tabs(),
    trouble ? h("div", { class: "problem", role: "alert", text: trouble.split("\n").map(said).join("\n") }) : null,
    h("div", { class: "scroll" }, snap ? monitor(snap) : setup(file)),
  );
}

function render() {
  // Drawing again must not take the caret out of a field someone is typing in.
  const active = document.activeElement as HTMLInputElement | null;
  const key = active?.dataset?.key;
  const caret = key ? [active!.selectionStart, active!.selectionEnd] : null;
  const scroll = root.querySelector(".scroll")?.scrollTop ?? 0;

  clear(root);
  root.append(h("div", { class: "shell" }, sidebar(), main()));

  const scroller = root.querySelector(".scroll");
  if (scroller) scroller.scrollTop = scroll;
  if (key) {
    const again = root.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(key)}"]`);
    if (again) {
      again.focus();
      if (caret) again.setSelectionRange(caret[0], caret[1]);
    }
  }
}

async function load() {
  if (IS_TAURI) {
    const listed = await Bridge.teamFiles();
    dir = listed?.dir ?? "";
    files = listed?.files ?? [];
    for (const snap of (await Bridge.teamSnapshots()) ?? []) runs.set(snap.id, snap);
  } else if (import.meta.env.DEV) {
    // A plain browser: the drafts' team, to look at the screen without the app.
    const demo = await import("./demo");
    dir = demo.demoFiles.dir;
    files = demo.demoFiles.files;
    runs.set("shop", demo.demoSnapshot());
  }
  if (!selected || !files.some((f) => f.file === selected)) {
    // The team that is running, else the first.
    selected = files.find((f) => f.config && runs.get(f.config.id)?.status === "running")?.file ?? files[0]?.file ?? null;
  }
  render();
}

async function start() {
  await onEvent<Snapshot>("team-changed", (snap) => {
    runs.set(snap.id, snap);
    render();
  });
  // "18 minutes" has to move on its own — but only while someone can see it:
  // a hidden window keeps no timer.
  let tick = 0;
  const watch = () => {
    window.clearInterval(tick);
    if (document.hidden) return;
    tick = window.setInterval(() => {
      if ([...runs.values()].some((r) => r.status === "running")) render();
    }, 30_000);
  };
  document.addEventListener("visibilitychange", () => {
    watch();
    // Shown again: the team files may have been edited meanwhile.
    if (!document.hidden) void load();
  });
  watch();
  await load();
}

void start();
