// A team to look at when the page is opened in a plain browser (`npm run dev`):
// the shopping-site team of the design drafts, eighteen minutes in. Add
// `?state=waiting` to see a member holding a permission card and another
// waiting for an answer.
//
// The demo is in the language of the page when it is first read (`?lang=en`
// or `?lang=zh-TW`), like a record. What Coucou itself tells members, the
// agents' step titles and the orchestrator's sentences stay in English, as
// the app writes them: the window words them (heardWords, said, toolWords).

import { tr, trf } from "../core/i18n";
import type { Line, PastRun, PricingChoices, ScreenPatch, Snapshot, TeamFile, TeamConfig, Usage, UsageReport, UsageRow } from "./types";

const NOW = Date.now();
const ago = (minutes: number) => NOW - minutes * 60_000;

const config: TeamConfig = {
  id: "shop",
  name: tr("購物網站團隊", "Shopping site team"),
  goal: tr("建立一個購物網站\n包含商品列表、購物車與會員登入\n交付可預覽網站與測試報告", "Build a shopping site\nwith a product list, a cart and member sign-in\nDeliver a site to preview and a test report"),
  scope: [tr("商品目錄", "Product catalog"), tr("購物車", "Cart"), tr("會員登入", "Member sign-in")],
  workDir: "D:\\Projects\\shop",
  leader: "ai1",
  autoApprove: true,
  members: [
    { id: "ai1", name: "AI 1", role: tr("規劃", "Planning"), duty: tr("分解需求、指派任務、審查成果", "Breaks down the needs, assigns tasks, reviews results"), agent: "claude", model: "sonnet", color: "#5b8def" },
    { id: "ai2", name: "AI 2", role: tr("執行整合", "Integration"), duty: tr("整合交付物、測試與驗收", "Puts the deliveries together, tests and accepts them"), agent: "copilot", color: "#34c7a0", maxTokens: 300_000 },
    { id: "ai3", name: "AI 3", role: tr("網站開發", "Web dev"), duty: tr("網站前後端開發與功能實作", "Builds the site's front and back end and its features"), agent: "cg", color: "#a06cf0" },
    { id: "ai4", name: "AI 4", role: tr("圖片生成", "Images"), duty: tr("生成商品圖與行銷素材", "Makes product pictures and marketing assets"), agent: "agy", color: "#f5b63d" },
  ],
  links: [
    { from: "ai4", to: "ai3", kind: "delivery", what: tr("圖片素材", "Image assets") },
    { from: "ai3", to: "ai2", kind: "delivery", what: tr("網站版本", "Site builds") },
  ],
  expected: [],
  directTalk: true,
  sharedBoard: true,
  maxTurns: 60,
};

// `?theme=library` dresses the demo team's office in one look.
if (typeof location !== "undefined") config.officeTheme = new URLSearchParams(location.search).get("theme") ?? undefined;
// `?members=8` adds members to the demo team, to look at a full room.
const wanted = typeof location === "undefined" ? 4 : Math.min(12, Number(new URLSearchParams(location.search).get("members")) || 4);
const EXTRA_ROLES = [tr("文案撰寫", "Copywriting"), tr("測試驗收", "Testing"), tr("資料整理", "Data cleanup"), tr("營運支援", "Operations"), tr("前端開發", "Front end"), tr("後端開發", "Back end"), tr("資料分析", "Data analysis"), tr("設計審查", "Design review")];
for (let i = config.members.length; i < wanted; i++) {
  config.members.push({ id: `ai${i + 1}`, name: `AI ${i + 1}`, role: EXTRA_ROLES[i - 4] ?? tr("支援", "Support"), duty: "", agent: "copilot", color: ["#F472B6", "#22D3EE", "#F59E0B", "#84CC16", "#FB7185", "#38BDF8", "#A78BFA", "#34D399"][i - 4] ?? "#94A3B8" });
}

export const demoAgents: import("../core/state").AgentProfile[] = [
  { id: "copilot", name: "Copilot CLI", command: "copilot", args: ["--acp", "--stdio"], env: {}, cwd: "" },
  { id: "cg", name: "cg · glm-5.3-flash", command: "copilot", args: ["--acp", "--stdio"], env: { COPILOT_PROVIDER_BASE_URL: "https://llm-share.example.com/v1" }, cwd: "" },
  { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, cwd: "", protocol: "claude" },
  { id: "codex", name: "Codex", command: "codex", args: ["app-server"], env: {}, cwd: "", protocol: "codex" },
  { id: "agy", name: "Antigravity", command: "agy", args: [], env: {}, cwd: "", protocol: "agy" },
  { id: "ollama", name: tr("本機模型 · qwen3-coder", "Local model · qwen3-coder"), command: "copilot", args: ["--acp", "--stdio"], env: { COPILOT_PROVIDER_BASE_URL: "http://localhost:11434/v1" }, cwd: "", model: "qwen3-coder", location: "local" },
  { id: "n8n-report", name: tr("n8n 週報流程", "n8n weekly report"), command: "", args: [], env: {}, cwd: "", protocol: "n8n", location: "local", url: "http://n8n.office.lan/webhook/weekly-report", headerName: "X-API-Key" },
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
      config: { ...config, id: "docs", name: tr("文件翻譯團隊", "Docs translation team"), goal: tr("把 README 翻成三種語言", "Translate the README into three languages") },
      problems: ["The work folder D:\\Projects\\docs does not exist.", "AI 3 runs as agent 'cg', which is not in Settings → Agent Provider."], // i18n-ok: Rust's English, worded by said()
    },
  ],
};
// `?archived` shows the second demo team put away.
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("archived")) demoFiles.files[1].config!.archived = true;
// `?model=mismatch`: AI 3 was given one model, its calls used another (the board flags it).
if (typeof location !== "undefined" && new URLSearchParams(location.search).get("model") === "mismatch") config.members[2].model = "minimax-m2.7";

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
  reviewer: null,
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
    turn(1, [{ from: "system", text: "The team has started. Plan the work for this goal and create the tasks now:" }]), // i18n-ok: what Agent Center tells a member
    line("say", tr("我先看一下團隊與需求,再把工作拆成可以驗收的任務。", "Let me look at the team and the requirements first, then split the work into tasks that can be reviewed.")),
    team("team_status", {}),
    team("task_create", { title: tr("商品圖片", "Product images"), owner: "ai4" }),
    team("task_create", { title: tr("購物車功能", "Cart"), owner: "ai3" }),
    line("turn", "1", { status: "end" }),
    turn(4, [{ from: "ai3", text: tr("請問優惠券是否需要支援滿額折扣?以及是否需要會員限定的優惠?", "Should coupons support discounts above a spend? And do we need members-only offers?") }]),
    tool("Read docs/spec.md", "read", "done"),
    line("say", tr("首版先完成基本結帳流程,優惠券規則後續再擴充。我回覆 AI 3,", "The first version does the basic checkout; coupon rules can come later.")),
  ],
  ai2: [
    turn(1, [{ from: "system", text: `TASK-06 is yours and ready to start: ${tr("整合測試", "Integration tests")}` }]), // i18n-ok: what Agent Center tells a member
    line("say", tr("TASK-06 要等 AI 3 的購物車功能交付才能開始,我先把測試清單寫好。", "TASK-06 has to wait for AI 3's cart, so I'm writing the test checklist first.")),
    tool("Edit tests/checklist.md", "edit", "done"),
    line("turn", "1", { status: "end" }),
  ],
  ai3: [
    turn(3, [{ from: "system", text: `AI 4 (ai4) handed in TASK-03 (${tr("商品圖片", "Product images")}), which is meant for you: ${tr("6 張商品圖", "6 product pictures")}` }]), // i18n-ok: what Agent Center tells a member
    line("say", tr("收到商品圖,接著把購物車頁面做出來。", "Got the product pictures; now building the cart page.")),
    team("task_update", { task: "TASK-04", status: "doing" }),
    tool("Run npm install zustand", "execute", "done", { input: { command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command npm install zustand' } }), // i18n-ok: the agent's step title
    tool("Edit src/cart/CartPage.tsx", "edit", "done"),
    tool("Run npm test -- cart", "execute", "running", { input: { command: "npm test -- cart" }, output: "PASS src/cart/add.test.ts\nPASS src/cart/qty.test.ts\nRUNS src/cart/total.test.ts" }), // i18n-ok: the agent's step title
  ],
  ai4: [
    turn(2, [{ from: "system", text: `TASK-03 is yours and ready to start: ${tr("商品圖片", "Product images")}` }]), // i18n-ok: what Agent Center tells a member
    line("say", tr("六張商品圖都生成好了,放在 public/images:主圖 public/images/hero.png、情境圖 public/images/scene.jpg。", "All six product pictures are made, in public/images: the main one public/images/hero.png, the scene public/images/scene.jpg.")),
    tool("Generate an image", "other", "done"), // i18n-ok: the agent's step title
    tool("Read public/images/hero.png", "read", "done", { input: { path: "public/images/hero.png" } }),
    team("deliver", { task: "TASK-03", summary: tr("6 張商品圖:主圖、情境圖與細節圖", "6 product pictures: main, scene and detail shots"), locator: "public/images" }),
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
    timeLimitMin: 0,
    timeReserveMin: 0,
    timeWarned: false,
    timeUp: false,
    members: [
      { ...seat(0), isLeader: true, status: "working", task: "TASK-05", waiting: null, activity: "Reading docs/spec.md", turns: 4, permission: null, lostWhy: "", usage: [used("claude-sonnet-5-5", 41_200, 9_800, 612_000, 38_000)] },
      {
        ...seat(1),
        isLeader: false,
        status: "waitingDelivery",
        task: "TASK-06",
        waiting: { on: "ai3", what: tr("購物車功能", "Cart"), task: "TASK-06" },
        activity: "",
        turns: 1,
        permission: null,
        lostWhy: "",
        usage: [used("gpt-6-mini", 150_000, 28_000, 42_000)],
      },
      { ...seat(2), isLeader: false, status: "working", task: "TASK-04", waiting: null, activity: "Editing src/cart/CartPage.tsx", turns: 3, permission: null, lostWhy: "", usage: [used("glm-5.3-flash", 182_000, 21_400, 96_000)] },
      { ...seat(3), isLeader: false, status: "done", task: null, waiting: null, activity: "", turns: 2, permission: null, lostWhy: "", usage: [used("gemini-3.8-flash", 23_000, 4_100)] },
      ...config.members.slice(4).map((_, k) => ({ ...seat(4 + k), isLeader: false, status: (k % 2 ? "idle" : "working") as Snapshot["members"][number]["status"], task: null, waiting: null, activity: k % 2 ? "" : "Writing copy", turns: 1, permission: null, lostWhy: "" })), // i18n-ok: an agent's step title
    ],
    tasks: [
      task(1, tr("需求拆解", "Break down the needs"), "ai1", "done", { note: tr("完成需求分析與任務分配", "Needs analysed and tasks assigned") }),
      task(2, tr("商品列表", "Product list"), "ai3", "done", { note: tr("完成商品列表頁面", "Product list page done") }),
      task(3, tr("商品圖片", "Product images"), "ai4", "done", { note: tr("6 張商品圖已交付", "6 product pictures delivered"), deliverTo: "ai3" }),
      task(4, tr("購物車功能", "Cart"), "ai3", "doing", {
        priority: "high",
        note: tr("實作購物車頁面與結帳流程", "Build the cart page and the checkout"),
        deliverTo: "ai2",
        dependsOn: ["TASK-03"],
        criteria: [
          { text: tr("加入商品", "Add items"), claimed: true },
          { text: tr("調整數量", "Change quantities"), claimed: false },
          { text: tr("計算小計", "Work out the subtotal"), claimed: false },
        ],
      }),
      task(5, tr("需求確認", "Confirm the needs"), "ai1", "doing", { note: tr("確認優惠券與會員功能需求", "Confirm what coupons and member features need") }),
      task(6, tr("整合測試", "Integration tests"), "ai2", "todo", { dependsOn: ["TASK-04"], dispatched: false }),
      task(7, tr("驗收報告", "Acceptance report"), "ai2", "todo", { dependsOn: ["TASK-06"], dispatched: false, note: tr("彙整測試結果與產出報告", "Gather the test results into a report") }),
    ],
    deliverables: [
      { id: "D-1", task: "TASK-01", kind: "spec", locator: "docs/shopping-site-spec.md", summary: tr("需求規格", "Requirements spec"), by: "ai1", at: ago(14), accepted: true },
      { id: "D-2", task: "TASK-03", kind: "image", locator: "public/images", summary: tr("6 張商品圖:主圖、情境圖與細節圖", "6 product pictures: main, scene and detail shots"), by: "ai4", at: ago(4), accepted: true },
      { id: "D-3", task: "TASK-02", kind: "preview", locator: "http://localhost:5173/", summary: tr("購物網站首頁(開發中)", "Shopping site home page (in progress)"), by: "ai3", at: ago(6), accepted: true },
    ],
    messages: [
      { id: "M-1", from: "system", to: "ai4", text: `TASK-03 is yours and ready to start: ${tr("商品圖片", "Product images")}`, task: "TASK-03", at: ago(17), heard: true }, // i18n-ok: what Agent Center tells a member
      { id: "M-2", from: "ai4", to: "ai3", text: tr("這是 6 張商品圖,包含主圖、情境圖與細節圖,請用於購物車與商品頁面。", "Here are the 6 product pictures: main, scene and detail shots. Use them on the cart and product pages."), task: "TASK-03", at: ago(4), heard: true },
      { id: "M-3", from: "ai1", to: "ai3", text: tr("請完成購物車、數量調整與小計。", "Please finish the cart, quantity changes and the subtotal."), task: "TASK-04", at: ago(8), heard: true },
      { id: "M-4", from: "ai3", to: "ai1", text: tr("請問優惠券是否需要支援滿額折扣?以及是否需要會員限定的優惠?", "Should coupons support discounts above a spend? And do we need members-only offers?"), task: "TASK-04", at: ago(3), heard: true },
      { id: "M-5", from: "ai1", to: "ai3", text: tr("首版先完成基本結帳流程,優惠券規則後續再擴充,請先專注於核心功能實作。", "The first version does the basic checkout; coupon rules come later. Focus on the core features first."), task: "TASK-04", at: ago(2), heard: true },
      { id: "M-6", from: "you", to: "ai1", text: tr("首頁的 Banner 請換成夏季主題。", "Please give the home page banner a summer theme."), task: null, at: ago(1), heard: false },
    ],
    questions: [],
    feed: [
      { at: ago(18), kind: "task", from: "ai1", to: "ai4", text: tr("商品圖片", "Product images"), task: "TASK-03" },
      { at: ago(4), kind: "delivered", from: "ai4", to: "ai3", text: tr("這是 6 張商品圖,包含主圖、情境圖與細節圖,請用於購物車與商品頁面。", "Here are the 6 product pictures: main, scene and detail shots. Use them on the cart and product pages."), task: "TASK-03" },
      { at: ago(3), kind: "message", from: "ai3", to: "ai1", text: tr("請問優惠券是否需要支援滿額折扣?以及是否需要會員限定的優惠?", "Should coupons support discounts above a spend? And do we need members-only offers?"), task: "TASK-04" },
      { at: ago(2), kind: "message", from: "ai1", to: "ai3", text: tr("首版先完成基本結帳流程,優惠券規則後續再擴充,請先專注於核心功能實作。", "The first version does the basic checkout; coupon rules come later. Focus on the core features first."), task: "TASK-04" },
    ],
  };

  if (waiting) {
    snapshot.members[2] = {
      ...snapshot.members[2],
      status: "waitingYou",
      waiting: { on: "you", what: "Run rm -rf node_modules", task: "TASK-04" },
      morePermissions: [1, 2].map((i) => ({
        requestId: 12 + i,
        title: `Run npm install --save-dev @types/node@${20 + i}`, // i18n-ok: the agent's own title
        kind: "execute",
        rawInput: { command: `npm install --save-dev @types/node@${20 + i}` },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" }, // i18n-ok: the agent's own option
          { optionId: "reject", name: "Reject", kind: "reject_once" }, // i18n-ok: the agent's own option
        ],
        danger: "installs" as const,
      })),
      permission: {
        requestId: 12,
        title: "Run rm -rf node_modules", // i18n-ok: the agent's own title
        kind: "execute",
        rawInput: { command: "rm -rf node_modules && npm install" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" }, // i18n-ok: the agent's own option
          { optionId: "reject", name: "Reject", kind: "reject_once" }, // i18n-ok: the agent's own option
        ],
        danger: "deletes-folder",
      },
    };
    snapshot.members[0] = { ...snapshot.members[0], status: "waitingYou", waiting: { on: "you", what: tr("首版要支援手機版嗎?", "Should the first version work on phones?"), task: "TASK-05" } };
    snapshot.questions = [{ id: "Q-1", by: "ai1", question: tr("首版要支援手機版嗎?", "Should the first version work on phones?"), task: "TASK-05", at: ago(1), answer: null }];
    snapshot.members[3] = { ...snapshot.members[3], status: "lost", lostWhy: "It ended two turns in a row without a word about its open work." }; // i18n-ok: Rust's English, worded by said()
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
    snapshot.pausedWhy = "Agent Center was closed while the team was running."; // i18n-ok: Rust's English, worded by said()
    snapshot.members = snapshot.members.map((m) => ({ ...m, status: m.status === "working" ? "idle" : m.status }));
    snapshot.members[0] = { ...snapshot.members[0], status: "lost", lostWhy: "It ended two turns in a row without a word about its open work." }; // i18n-ok: Rust's English, worded by said()
  }
  return snapshot;
}

/**
 * A team at work, for a plain browser: words arrive a few at a time, a
 * command runs and passes, and now and then something is handed across.
 */
export function demoStream(onScreen: (patch: ScreenPatch) => void, onChange: (snap: Snapshot) => void, snap: Snapshot) {
  const words = tr(
    "我回覆 AI 3:首版先專注在加入商品、調整數量與小計,優惠券下一版再做。接著我來檢查規格裡的結帳流程有沒有漏掉的地方。",
    " I'm telling AI 3: focus on adding items, changing quantities and the subtotal first; coupons come in the next version. Then I'll check the spec's checkout for anything missing.",
  ).split("");
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
        { kind: "message" as const, from: "ai1", to: "ai3", text: tr("首版先做核心結帳流程", "Core checkout first in version one"), task: "TASK-04" },
        { kind: "delivered" as const, from: "ai3", to: "ai2", text: tr("購物車功能", "Cart"), task: "TASK-04" },
        { kind: "task" as const, from: "ai1", to: "ai2", text: tr("整合測試", "Integration tests"), task: "TASK-06" },
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
    { id: "shop", name: tr("購物網站團隊", "Shopping site team"), members: [["ai1", "AI 1", "claude", "claude-sonnet-5-5"], ["ai2", "AI 2", "copilot", "gpt-5.6-sol"], ["ai3", "AI 3", "cg", "glm-5.3-flash"], ["ai4", "AI 4", "agy", "gemini-3.8-flash"]] },
    { id: "docs", name: tr("文件翻譯團隊", "Docs translation team"), members: [["ai1", "AI 1", "codex", "gpt-5.6-sol"], ["ai2", "AI 2", "cg", "deepseek-v4.1-flash"], ["ai3", "AI 3", "cg", "deepseek-v4.1-flash"]] },
    { id: "brand", name: tr("品牌設計團隊", "Brand design team"), members: [["lead", tr("總監", "Director"), "claude", "claude-opus-5-5"], ["d1", tr("設計 1", "Designer 1"), "agy", "gemini-3.8-flash"], ["w1", tr("文案", "Copywriter"), "claude", "claude-haiku-4-5"]] },
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
  // What each member did: turns as many as its records, a hand-in or two, now and then sent back.
  const activity: import("./types").Activity[] = [];
  for (const t of teams) {
    for (const [id, name] of t.members) {
      const mine = inRange.filter((r) => r.team === t.id && r.member === id);
      if (!mine.length) continue;
      const delivered = Math.max(1, Math.round(mine.length / 6));
      activity.push({ team: t.id, member: id, memberName: name, role: "", leader: id === t.members[0][0], turns: mine.length, failedTurns: mine.length > 20 ? 1 : 0, delivered, rejected: id === "ai3" ? 2 : 0, accepted: delivered, reviews: id === t.members[0][0] ? delivered * 2 : 0, messages: delivered * 2 });
    }
  }
  return {
    rows: inRange,
    activity,
    models: [...seen].map(([model, found]) => ({ model, found })).sort((a, b) => a.model.localeCompare(b.model)),
    choices: structuredClone(demoChoices),
    tableSource: tr("Agent Center 內建的價目表 (LiteLLM)", "Agent Center's built-in price list (LiteLLM)"),
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

/** Agent Center in a browser: a canned answer, after a moment, with a card when asked for a team. */
export async function demoSecretary(text: string, step?: (s: import("./types").SecretaryStep) => void): Promise<import("./types").SecretaryReply> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(500);
  if (/組合|which|哪/i.test(text)) {
    return {
      text: tr("這個團隊可以用兩種組合,差在成本和品質。你要哪一種?", "This team can be put together two ways, trading cost against quality. Which do you want?"),
      steps: [{ tool: "list_agents", label: tr("查看可用的代理", "Looked at the available agents") }],
      proposals: [],
      choices: { question: tr("你要哪一種?", "Which do you want?"), options: [tr("省錢組合:Leader 用 Gemini,程式用 Deepseek", "Budget: Gemini leads, Deepseek codes"), tr("品質組合:Leader 用規劃大師,程式用 Codex Sol", "Quality: Planning master leads, Codex Sol codes"), tr("先列出兩種組合的預估成本", "Show the estimated cost of both first")], multiple: false },
    };
  }
  if (/開|建立|新團隊|new team|set up|create/i.test(text)) {
    // Looking Agent Pool over, as a real model would: the agents, then a few of their models.
    step?.({ tool: "list_agents", label: tr("查看可用的代理", "Looking at the available agents") });
    for (const agent of ["ta-reviewer", "ta-painter", "ta-joker", "ta-local-coder"]) {
      await wait(650);
      step?.({ tool: "agent_models", label: trf("查詢「{agent}」提供的模型", "Checking the models \"{agent}\" offers", { agent }), agent });
    }
    await wait(700);
    step?.({ tool: "propose_team", label: tr("擬好新團隊「官網改版」", "Drafted the new team “Website redesign”") });
    await wait(400);
    return {
      text: tr("已擬好新團隊,**尚未建立**。按卡片上的「建立並啟動」才會執行。", "I've prepared a new team, **not created yet**. Nothing happens until you click “Create and start” on the card."),
      steps: [{ tool: "list_agents", label: tr("查看可用的代理", "Looked at the available agents") }, { tool: "propose_team", label: tr("擬好新團隊「官網改版」", "Prepared the new team “Website redesign”") }],
      proposals: [
        {
          id: "P-1",
          kind: "team",
          title: tr("新團隊「官網改版」", "New team “Website redesign”"),
          lines: [
            tr("目標:把公司官網改成新版設計,含首頁、產品頁、聯絡我們", "Goal: move the company website to the new design, with the home, product and contact pages"),
            tr("工作資料夾:D:\\Code\\site(會建立)", "Work folder: D:\\Code\\site (will be created)"),
            tr("AI 1(Leader) · 規劃 · claude / sonnet — 拆解需求、派工、驗收", "AI 1 (Leader) · Planning · claude / sonnet — breaks down the needs, hands out work, reviews"),
            tr("AI 2 · 前端 · cg / glm-5.3-flash — 實作頁面", "AI 2 · Front end · cg / glm-5.3-flash — builds the pages"),
            tr("AI 3 · 文案 · codex / gpt-5.6-sol — 撰寫各頁文案", "AI 3 · Copy · codex / gpt-5.6-sol — writes each page's copy"),
          ],
          confirm: tr("建立並啟動", "Create and start"),
          state: "open",
          outcome: "",
          picks: [
            { agent: "ta-reviewer", name: "AI 1", role: tr("規劃", "Planning"), leader: true },
            { agent: "ta-joker", name: "AI 2", role: tr("前端", "Front end"), leader: false },
            { agent: "ta-painter", name: "AI 3", role: tr("文案", "Copy"), leader: false },
          ],
        },
      ],
    };
  }
  return {
    text: tr(
      "目前有 2 個團隊:\n- **購物網站團隊**:執行中,任務 3/7 已驗收,第 11/60 回合。AI 3 正在做購物車,AI 2 在等 AI 3 交付。\n- **文件翻譯團隊**:還沒啟動(工作資料夾不存在)。\n\n**在等你的**:沒有權限卡;Leader 有 1 個問題「首版要支援手機版嗎?」。\n近 7 天花費約 NT$21(1.03M tokens)。",
      "There are 2 teams:\n- **Shopping site team**: running, 3/7 tasks accepted, turn 11/60. AI 3 is building the cart, AI 2 is waiting for AI 3's delivery.\n- **Docs translation team**: not started (its work folder doesn't exist).\n\n**Waiting for you**: no permission cards; the Leader has 1 question, “Should the first version work on phones?”.\nThe last 7 days cost about NT$21 (1.03M tokens).",
    ),
    steps: [{ tool: "list_teams", label: tr("查看所有團隊", "Looked at all teams") }, { tool: "team_detail", label: tr("查看「購物網站團隊」的現況", "Checked on “Shopping site team”") }, { tool: "usage_summary", label: tr("查詢近 7 天的用量與成本", "Looked up the last 7 days' usage and cost") }],
    proposals: [],
  };
}

/** The starting constitution, for a browser. */
export function demoConstitution(): import("./types").Constitution {
  const r = (id: string, text: string, level: "off" | "ask" | "never") => ({ id, text, level, check: id, patterns: [] as string[] });
  return {
    rules: [
      r("git-folder", tr("不能刪除或搬走 .git 資料夾(整個版本紀錄會不見)", "Don't delete or move a .git folder (the whole version history would be lost)"), "never"),
      r("drive-root", tr("不能刪除或格式化整顆磁碟,或 Windows、Program Files、使用者資料夾這類系統資料夾", "Don't delete or format a whole drive, or system folders such as Windows, Program Files or the user folders"), "never"),
      r("install", tr("安裝軟體或套件之前要先問我", "Ask me before installing software or packages"), "ask"),
      r("git-destructive", tr("會丟掉變更的 git 指令(reset --hard、clean、強制推送)之前要先問我", "Ask me before git commands that throw changes away (reset --hard, clean, force push)"), "ask"),
      r("send-out", tr("對外發送或發布(git push、npm publish、寄信、上傳)之前要先問我", "Ask me before sending or publishing anything (git push, npm publish, email, uploads)"), "ask"),
      r("system", tr("變更系統(登錄檔、服務、關閉程式、權限)之前要先問我", "Ask me before changing the system (registry, services, closing programs, permissions)"), "ask"),
      r("download", tr("從網路下載檔案之前要先問我", "Ask me before downloading files from the internet"), "ask"),
      { id: "mine-1", text: tr("不能動 D:\\重要資料", "Keep out of D:\\Important"), level: "never" as const, check: "", patterns: [tr("D:\\重要資料\\*", "D:\\Important\\*")] },

    ],
  };
}
