// A team to look at when the page is opened in a plain browser (`npm run dev`):
// the shopping-site team of the design drafts, eighteen minutes in. Add
// `?state=waiting` to see a member holding a permission card and another
// waiting for an answer.

import type { Line, PastRun, PricingChoices, ScreenPatch, Snapshot, TeamFile, TeamConfig, Usage, UsageReport, UsageRow } from "./types";

const NOW = Date.now();
const ago = (minutes: number) => NOW - minutes * 60_000;

const config: TeamConfig = {
  id: "shop",
  name: "購物網站團隊",
  goal: "建立一個購物網站\n包含商品列表、購物車與會員登入\n交付可預覽網站與測試報告",
  scope: ["商品目錄", "購物車", "會員登入"],
  workDir: "D:\\Projects\\shop",
  leader: "ai1",
  autoApprove: true,
  members: [
    { id: "ai1", name: "AI 1", role: "規劃", duty: "分解需求、指派任務、審查成果", agent: "claude", model: "sonnet", color: "#5b8def" },
    { id: "ai2", name: "AI 2", role: "執行整合", duty: "整合交付物、測試與驗收", agent: "copilot", color: "#34c7a0" },
    { id: "ai3", name: "AI 3", role: "網站開發", duty: "網站前後端開發與功能實作", agent: "cg", color: "#a06cf0" },
    { id: "ai4", name: "AI 4", role: "圖片生成", duty: "生成商品圖與行銷素材", agent: "agy", color: "#f5b63d" },
  ],
  links: [
    { from: "ai4", to: "ai3", kind: "delivery", what: "圖片素材" },
    { from: "ai3", to: "ai2", kind: "delivery", what: "網站版本" },
  ],
  expected: [],
  directTalk: true,
  sharedBoard: true,
  maxTurns: 60,
};

// `?theme=library` dresses the demo team's office in one look.
if (typeof location !== "undefined") config.officeTheme = new URLSearchParams(location.search).get("theme") ?? undefined;
// `?members=8` adds members to the demo team, to look at a full room.
const wanted = typeof location === "undefined" ? 4 : Math.min(8, Number(new URLSearchParams(location.search).get("members")) || 4);
const EXTRA_ROLES = ["文案撰寫", "測試驗收", "資料整理", "營運支援"];
for (let i = config.members.length; i < wanted; i++) {
  config.members.push({ id: `ai${i + 1}`, name: `AI ${i + 1}`, role: EXTRA_ROLES[i - 4] ?? "支援", duty: "", agent: "copilot", color: ["#F472B6", "#22D3EE", "#F59E0B", "#84CC16"][i - 4] ?? "#94A3B8" });
}

export const demoAgents: import("../core/state").AgentProfile[] = [
  { id: "copilot", name: "Copilot CLI", command: "copilot", args: ["--acp", "--stdio"], env: {}, cwd: "" },
  { id: "cg", name: "cg · glm-5.3-flash", command: "copilot", args: ["--acp", "--stdio"], env: { COPILOT_PROVIDER_BASE_URL: "https://llm-share.example.com/v1" }, cwd: "" },
  { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, cwd: "", protocol: "claude" },
  { id: "codex", name: "Codex", command: "codex", args: ["app-server"], env: {}, cwd: "", protocol: "codex" },
  { id: "agy", name: "Antigravity", command: "agy", args: [], env: {}, cwd: "", protocol: "agy" },
];

function used(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
  return { model, input, output, cacheRead, cacheWrite, reasoning: 0, requests: 0 };
}

export const demoFiles: { dir: string; files: TeamFile[] } = {
  dir: "C:\\Users\\you\\AppData\\Roaming\\Coucou\\teams",
  files: [
    { file: "shop.json", config, problems: [] },
    {
      file: "docs.json",
      config: { ...config, id: "docs", name: "文件翻譯團隊", goal: "把 README 翻成三種語言" },
      problems: ["The work folder D:\\Projects\\docs does not exist.", "AI 3 runs as agent 'cg', which is not in Settings → Agents."],
    },
  ],
};
// `?archived` shows the second demo team put away.
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("archived")) demoFiles.files[1].config!.archived = true;

const task = (
  n: number,
  title: string,
  owner: string,
  status: Snapshot["tasks"][number]["status"],
  extra: Partial<Snapshot["tasks"][number]> = {},
): Snapshot["tasks"][number] => ({
  id: `TASK-0${n}`,
  title,
  detail: "",
  owner,
  status,
  priority: "medium",
  criteria: [],
  dependsOn: [],
  deliverTo: null,
  blocked: null,
  note: "",
  rejections: 0,
  dispatched: status !== "todo",
  createdAt: ago(18),
  updatedAt: ago(2),
  ...extra,
});

/** A member as the snapshot shows it: the model is always there, empty for the agent's own. */
const seat = (i: number) => ({ ...config.members[i], model: config.members[i].model ?? "", screen: screens[config.members[i].id] ?? [], morePermissions: [] });

let n = 0;
const line = (kind: Line["kind"], text: string, extra: Partial<Line> = {}): Line => ({
  n: ++n,
  since: NOW - 60_000,
  at: NOW,
  kind,
  text,
  tool: "",
  teamTool: "",
  input: null,
  status: "",
  output: "",
  ...extra,
});
const turn = (k: number, heard: { from: string; text: string }[]) => line("turn", String(k), { status: "start", input: heard });
const tool = (title: string, kind: string, status: string, extra: Partial<Line> = {}) => line("tool", title, { tool: kind, status, ...extra });
const team = (name: string, input: unknown, status = "done") => line("tool", `coucou-team.${name}`, { tool: "other", teamTool: name, input, status });

/** What each member's screen shows, eighteen minutes in. */
const screens: Record<string, Line[]> = {
  ai1: [
    turn(1, [{ from: "system", text: "The team has started. Plan the work for this goal and create the tasks now:" }]),
    line("say", "我先看一下團隊與需求,再把工作拆成可以驗收的任務。"),
    team("team_status", {}),
    team("task_create", { title: "商品圖片", owner: "ai4" }),
    team("task_create", { title: "購物車功能", owner: "ai3" }),
    line("turn", "1", { status: "end" }),
    turn(4, [{ from: "ai3", text: "請問優惠券是否需要支援滿額折扣?以及是否需要會員限定的優惠?" }]),
    tool("Read docs/spec.md", "read", "done"),
    line("say", "首版先完成基本結帳流程,優惠券規則後續再擴充。我回覆 AI 3,"),
  ],
  ai2: [
    turn(1, [{ from: "system", text: "TASK-06 is yours and ready to start: 整合測試" }]),
    line("say", "TASK-06 要等 AI 3 的購物車功能交付才能開始,我先把測試清單寫好。"),
    tool("Edit tests/checklist.md", "edit", "done"),
    line("turn", "1", { status: "end" }),
  ],
  ai3: [
    turn(3, [{ from: "system", text: "AI 4 (ai4) handed in TASK-03 (商品圖片), which is meant for you: 6 張商品圖" }]),
    line("say", "收到商品圖,接著把購物車頁面做出來。"),
    team("task_update", { task: "TASK-04", status: "doing" }),
    tool("Run npm install zustand", "execute", "done", { input: { command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command npm install zustand' } }),
    tool("Edit src/cart/CartPage.tsx", "edit", "done"),
    tool("Run npm test -- cart", "execute", "running", { input: { command: "npm test -- cart" }, output: "PASS src/cart/add.test.ts\nPASS src/cart/qty.test.ts\nRUNS src/cart/total.test.ts" }),
  ],
  ai4: [
    turn(2, [{ from: "system", text: "TASK-03 is yours and ready to start: 商品圖片" }]),
    line("say", "六張商品圖都生成好了,放在 public/images。"),
    tool("Generate an image", "other", "done"),
    team("deliver", { task: "TASK-03", summary: "6 張商品圖:主圖、情境圖與細節圖", locator: "public/images" }),
    line("turn", "2", { status: "end" }),
  ],
};

export function demoSnapshot(): Snapshot {
  const waiting = new URLSearchParams(location.search).get("state") === "waiting";
  const snapshot: Snapshot = {
    id: "shop",
    seq: 40,
    detached: false,
    name: config.name,
    goal: config.goal,
    workDir: config.workDir,
    status: "running",
    pausedWhy: "",
    done: 3,
    total: 7,
    totalTurns: 11,
    maxTurns: 60,
    startedAt: ago(18),
    finishedAt: 0,
    members: [
      { ...seat(0), isLeader: true, status: "working", task: "TASK-05", waiting: null, activity: "Reading docs/spec.md", turns: 4, permission: null, lostWhy: "", usage: [used("claude-sonnet-5-5", 41_200, 9_800, 612_000, 38_000)] },
      {
        ...seat(1),
        isLeader: false,
        status: "waitingDelivery",
        task: "TASK-06",
        waiting: { on: "ai3", what: "購物車功能", task: "TASK-06" },
        activity: "",
        turns: 1,
        permission: null,
        lostWhy: "",
      },
      { ...seat(2), isLeader: false, status: "working", task: "TASK-04", waiting: null, activity: "Editing src/cart/CartPage.tsx", turns: 3, permission: null, lostWhy: "", usage: [used("glm-5.3-flash", 182_000, 21_400, 96_000)] },
      { ...seat(3), isLeader: false, status: "done", task: null, waiting: null, activity: "", turns: 2, permission: null, lostWhy: "", usage: [used("gemini-3.8-flash", 23_000, 4_100)] },
      ...config.members.slice(4).map((_, k) => ({ ...seat(4 + k), isLeader: false, status: (k % 2 ? "idle" : "working") as Snapshot["members"][number]["status"], task: null, waiting: null, activity: k % 2 ? "" : "Writing copy", turns: 1, permission: null, lostWhy: "" })),
    ],
    tasks: [
      task(1, "需求拆解", "ai1", "done", { note: "完成需求分析與任務分配" }),
      task(2, "商品列表", "ai3", "done", { note: "完成商品列表頁面" }),
      task(3, "商品圖片", "ai4", "done", { note: "6 張商品圖已交付", deliverTo: "ai3" }),
      task(4, "購物車功能", "ai3", "doing", {
        priority: "high",
        note: "實作購物車頁面與結帳流程",
        deliverTo: "ai2",
        dependsOn: ["TASK-03"],
        criteria: [
          { text: "加入商品", claimed: true },
          { text: "調整數量", claimed: false },
          { text: "計算小計", claimed: false },
        ],
      }),
      task(5, "需求確認", "ai1", "doing", { note: "確認優惠券與會員功能需求" }),
      task(6, "整合測試", "ai2", "todo", { dependsOn: ["TASK-04"], dispatched: false }),
      task(7, "驗收報告", "ai2", "todo", { dependsOn: ["TASK-06"], dispatched: false, note: "彙整測試結果與產出報告" }),
    ],
    deliverables: [
      { id: "D-1", task: "TASK-01", kind: "spec", locator: "docs/shopping-site-spec.md", summary: "需求規格", by: "ai1", at: ago(14), accepted: true },
      { id: "D-2", task: "TASK-03", kind: "image", locator: "public/images", summary: "6 張商品圖:主圖、情境圖與細節圖", by: "ai4", at: ago(4), accepted: true },
      { id: "D-3", task: "TASK-02", kind: "preview", locator: "http://localhost:5173/", summary: "購物網站首頁(開發中)", by: "ai3", at: ago(6), accepted: true },
    ],
    messages: [
      { id: "M-1", from: "system", to: "ai4", text: "TASK-03 is yours and ready to start: 商品圖片", task: "TASK-03", at: ago(17), heard: true },
      { id: "M-2", from: "ai4", to: "ai3", text: "這是 6 張商品圖,包含主圖、情境圖與細節圖,請用於購物車與商品頁面。", task: "TASK-03", at: ago(4), heard: true },
      { id: "M-3", from: "ai1", to: "ai3", text: "請完成購物車、數量調整與小計。", task: "TASK-04", at: ago(8), heard: true },
      { id: "M-4", from: "ai3", to: "ai1", text: "請問優惠券是否需要支援滿額折扣?以及是否需要會員限定的優惠?", task: "TASK-04", at: ago(3), heard: true },
      { id: "M-5", from: "ai1", to: "ai3", text: "首版先完成基本結帳流程,優惠券規則後續再擴充,請先專注於核心功能實作。", task: "TASK-04", at: ago(2), heard: true },
      { id: "M-6", from: "you", to: "ai1", text: "首頁的 Banner 請換成夏季主題。", task: null, at: ago(1), heard: false },
    ],
    questions: [],
    feed: [
      { at: ago(18), kind: "task", from: "ai1", to: "ai4", text: "商品圖片", task: "TASK-03" },
      { at: ago(4), kind: "delivered", from: "ai4", to: "ai3", text: "這是 6 張商品圖,包含主圖、情境圖與細節圖,請用於購物車與商品頁面。", task: "TASK-03" },
      { at: ago(3), kind: "message", from: "ai3", to: "ai1", text: "請問優惠券是否需要支援滿額折扣?以及是否需要會員限定的優惠?", task: "TASK-04" },
      { at: ago(2), kind: "message", from: "ai1", to: "ai3", text: "首版先完成基本結帳流程,優惠券規則後續再擴充,請先專注於核心功能實作。", task: "TASK-04" },
    ],
  };

  if (waiting) {
    snapshot.members[2] = {
      ...snapshot.members[2],
      status: "waitingYou",
      waiting: { on: "you", what: "Run rm -rf node_modules", task: "TASK-04" },
      morePermissions: [1, 2].map((i) => ({
        requestId: 12 + i,
        title: `Run npm install --save-dev @types/node@${20 + i}`,
        kind: "execute",
        rawInput: { command: `npm install --save-dev @types/node@${20 + i}` },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
        danger: "installs" as const,
      })),
      permission: {
        requestId: 12,
        title: "Run rm -rf node_modules",
        kind: "execute",
        rawInput: { command: "rm -rf node_modules && npm install" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
        danger: "deletes-folder",
      },
    };
    snapshot.members[0] = { ...snapshot.members[0], status: "waitingYou", waiting: { on: "you", what: "首版要支援手機版嗎?", task: "TASK-05" } };
    snapshot.questions = [{ id: "Q-1", by: "ai1", question: "首版要支援手機版嗎?", task: "TASK-05", at: ago(1), answer: null }];
    snapshot.members[3] = { ...snapshot.members[3], status: "lost", lostWhy: "It ended two turns in a row without a word about its open work." };
    snapshot.tasks[3].blocked = null;
  }
  // `?state=quiet`: AI 3 has been stuck in one command for seven minutes.
  if (new URLSearchParams(location.search).get("state") === "quiet") {
    for (const l of snapshot.members[2].screen) {
      l.at = NOW - 7 * 60_000;
      l.since = Math.min(l.since, l.at);
    }
  }
  // `?state=earlier`: the record of a run Coucou was closed in the middle of.
  if (new URLSearchParams(location.search).get("state") === "earlier") {
    snapshot.status = "paused";
    snapshot.detached = true;
    snapshot.pausedWhy = "Coucou was closed while the team was running.";
    snapshot.members = snapshot.members.map((m) => ({ ...m, status: m.status === "working" ? "idle" : m.status }));
    snapshot.members[0] = { ...snapshot.members[0], status: "lost", lostWhy: "It ended two turns in a row without a word about its open work." };
  }
  return snapshot;
}

/**
 * A team at work, for a plain browser: words arrive a few at a time, a
 * command runs and passes, and now and then something is handed across.
 */
export function demoStream(onScreen: (patch: ScreenPatch) => void, onChange: (snap: Snapshot) => void, snap: Snapshot) {
  const words = "我回覆 AI 3:首版先專注在加入商品、調整數量與小計,優惠券下一版再做。接著我來檢查規格裡的結帳流程有沒有漏掉的地方。".split("");
  const leader = snap.members[0].screen;
  const say = leader[leader.length - 1];
  const dev = snap.members[2].screen;
  const test = dev[dev.length - 1];
  let i = 0;
  let beat = 0;
  window.setInterval(() => {
    if (i < words.length) {
      say.text += words[i++] + (words[i] ?? "");
      i++;
      onScreen({ team: snap.id, member: "ai1", lines: [{ ...say }] });
    }
    beat++;
    if (beat % 9 === 0) {
      test.output += `\nPASS src/cart/case-${beat}.test.ts`;
      onScreen({ team: snap.id, member: "ai3", lines: [{ ...test }] });
    }
    if (beat % 40 === 0) {
      const kinds = [
        { kind: "message" as const, from: "ai1", to: "ai3", text: "首版先做核心結帳流程", task: "TASK-04" },
        { kind: "delivered" as const, from: "ai3", to: "ai2", text: "購物車功能", task: "TASK-04" },
        { kind: "task" as const, from: "ai1", to: "ai2", text: "整合測試", task: "TASK-06" },
        { kind: "accepted" as const, from: "ai1", to: "ai4", text: "", task: "TASK-03" },
      ];
      const k = kinds[(beat / 40 - 1) % kinds.length];
      snap.feed = [...snap.feed, { at: Date.now(), ...k }];
      onChange({ ...snap });
    }
  }, 90);
}

/** An earlier run of the demo team: yesterday's, finished, three members. */
export function demoHistory(): PastRun[] {
  const at = NOW - 26 * 60 * 60_000;
  return [{ archivedAt: at + 2 * 60 * 60_000, startedAt: at, finishedAt: at + 90 * 60_000, done: 3, total: 3, status: "finished" }];
}

export function demoPast(): Snapshot {
  const snap = demoSnapshot();
  const at = NOW - 26 * 60 * 60_000;
  snap.startedAt = at;
  snap.finishedAt = at + 90 * 60_000;
  snap.status = "finished";
  snap.detached = true;
  snap.members = snap.members.slice(0, 3).map((m) => ({ ...m, status: "done", phase: null, task: null, waiting: null, activity: "" }));
  snap.tasks = snap.tasks.slice(0, 3).map((t) => ({ ...t, status: "done", owner: t.owner === "ai4" ? "ai3" : t.owner }));
  snap.done = 3;
  snap.total = 3;
  snap.messages = snap.messages.slice(0, 2);
  snap.deliverables = [];
  return snap;
}

// ── Usage over the last weeks, for the 成本與用量 page in a browser ──────────

const DEMO_PRICES: Record<string, [number, number, number, number, string]> = {
  "claude-sonnet-5-5": [3, 15, 0.3, 3.75, "anthropic"],
  "claude-opus-5-5": [4, 20, 0.2, 5, "anthropic"],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25, "anthropic"],
  "gpt-5.6-sol": [4, 20, 0.4, 0, "openai"],
  "glm-5.3-flash": [0.15, 0.5, 0.03, 0, "zai"],
  "deepseek-v4.1-flash": [0.3, 1.2, 0.03, 0, "deepseek"],
  "gemini-3.8-flash": [0.75, 3.75, 0.075, 0, "gemini"],
};

/** A deterministic month and a half of three teams at work. */
export function demoReport(from: number, to: number): UsageReport {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const teams = [
    { id: "shop", name: "購物網站團隊", members: [["ai1", "AI 1", "claude", "claude-sonnet-5-5"], ["ai2", "AI 2", "copilot", "gpt-5.6-sol"], ["ai3", "AI 3", "cg", "glm-5.3-flash"], ["ai4", "AI 4", "agy", "gemini-3.8-flash"]] },
    { id: "docs", name: "文件翻譯團隊", members: [["ai1", "AI 1", "codex", "gpt-5.6-sol"], ["ai2", "AI 2", "cg", "deepseek-v4.1-flash"], ["ai3", "AI 3", "cg", "deepseek-v4.1-flash"]] },
    { id: "brand", name: "品牌設計團隊", members: [["lead", "總監", "claude", "claude-opus-5-5"], ["d1", "設計 1", "agy", "gemini-3.8-flash"], ["w1", "文案", "claude", "claude-haiku-4-5"]] },
  ];
  const rows: UsageRow[] = [];
  const day = 86_400_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let d = 44; d >= 0; d--) {
    for (const t of teams) {
      // Teams work some days, not all.
      if (rand() < (t.id === "shop" ? 0.35 : 0.6)) continue;
      const run = today.getTime() - d * day + 9 * 3_600_000;
      for (const [id, name, agent, model] of t.members) {
        const turns = 1 + Math.floor(rand() * 5);
        for (let k = 0; k < turns; k++) {
          const at = run + Math.floor(rand() * 8 * 3_600_000);
          const big = model.includes("opus") || model.includes("sonnet") ? 1.6 : 1;
          const input = Math.floor((8_000 + rand() * 60_000) * big);
          const usage: Usage = { model, input, output: Math.floor(input * (0.08 + rand() * 0.2)), cacheRead: Math.floor(input * (1 + rand() * 9)), cacheWrite: model.startsWith("claude") ? Math.floor(input * 0.3) : 0, reasoning: 0, requests: 1 + Math.floor(rand() * 6) };
          // One model nobody prices yet, to see how that looks.
          if (t.id === "brand" && id === "d1" && k === 0 && d % 9 === 0) usage.model = "nano-banana-3";
          rows.push({ at, team: t.id, teamName: t.name, run, member: id, memberName: name, agent, usage, estimatedUsd: null, pricedBy: "" });
        }
      }
    }
  }
  const inRange = rows.filter((r) => r.at >= from && r.at < to && r.at <= Date.now()).sort((a, b) => a.at - b.at);
  const seen = new Map<string, UsageReport["models"][number]["found"]>();
  for (const r of inRange) {
    const p = DEMO_PRICES[r.usage.model];
    const own = demoChoices.overrides[r.usage.model];
    const found = own
      ? { price: own, source: "override" as const, listedAs: r.usage.model }
      : p
        ? { price: { input: p[0], output: p[1], cacheRead: p[2], cacheWrite: p[3] }, source: "list" as const, listedAs: `${r.usage.model} (${p[4]})` }
        : null;
    seen.set(r.usage.model, found);
    if (found) {
      const u = r.usage;
      r.estimatedUsd = (u.input * found.price.input + u.output * found.price.output + u.cacheRead * found.price.cacheRead + u.cacheWrite * found.price.cacheWrite) / 1e6;
      r.pricedBy = found.source;
    }
  }
  return {
    rows: inRange,
    models: [...seen].map(([model, found]) => ({ model, found })).sort((a, b) => a.model.localeCompare(b.model)),
    choices: structuredClone(demoChoices),
    tableSource: "Coucou 內建的價目表 (LiteLLM)",
    tableFetchedAt: NOW - 3 * day,
    tableSize: 1329,
  };
}

export const demoChoices: PricingChoices = { overrides: {}, proxy: {}, billing: { claude: "subscription", codex: "subscription" }, currency: "TWD", rate: 32 };

/** Today's price of each model, as the app would quote it. */
export function demoQuote(models: string[]): Record<string, import("./types").Found | null> {
  const out: Record<string, import("./types").Found | null> = {};
  for (const m of models) {
    const p = DEMO_PRICES[m];
    out[m] = p ? { price: { input: p[0], output: p[1], cacheRead: p[2], cacheWrite: p[3] }, source: "list", listedAs: `${m} (${p[4]})` } : null;
  }
  return out;
}

/** What an endpoint might say its key spent. */
export function demoKeySpend(): import("./types").KeySpend {
  return { spend: 15.55, maxBudget: 150, budgetDuration: "7d", budgetResetAt: new Date(NOW + 2 * 86_400_000).toISOString(), modelSpend: { "deepseek-v4-flash": 11.92, "glm-5.3-flash": 2.41, "gemini-3.8-flash": 1.22 }, askedAt: Date.now() };
}
