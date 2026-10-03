// A team to look at when the page is opened in a plain browser (`npm run dev`):
// the shopping-site team of the design drafts, eighteen minutes in. Add
// `?state=waiting` to see a member holding a permission card and another
// waiting for an answer.

import type { Snapshot, TeamFile, TeamConfig } from "./types";

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

export const demoAgents = [
  { id: "copilot", name: "Copilot CLI", command: "copilot", args: ["--acp", "--stdio"], env: {}, cwd: "" },
  { id: "cg", name: "cg · glm-5.3-flash", command: "copilot", args: ["--acp", "--stdio"], env: {}, cwd: "" },
  { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, cwd: "", protocol: "claude" as const },
  { id: "codex", name: "Codex", command: "codex", args: ["app-server"], env: {}, cwd: "", protocol: "codex" as const },
];

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
const seat = (i: number) => ({ ...config.members[i], model: config.members[i].model ?? "" });

export function demoSnapshot(): Snapshot {
  const waiting = new URLSearchParams(location.search).get("state") === "waiting";
  const snapshot: Snapshot = {
    id: "shop",
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
      { ...seat(0), isLeader: true, status: "working", task: "TASK-05", waiting: null, activity: "Reading docs/spec.md", turns: 4, permission: null, lostWhy: "" },
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
      { ...seat(2), isLeader: false, status: "working", task: "TASK-04", waiting: null, activity: "Editing src/cart/CartPage.tsx", turns: 3, permission: null, lostWhy: "" },
      { ...seat(3), isLeader: false, status: "done", task: null, waiting: null, activity: "", turns: 2, permission: null, lostWhy: "" },
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
    messages: [],
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
  return snapshot;
}
