// Deck story for the Agent Team slides: the team 「生成式 AI 介紹網頁」 as the
// app itself draws it in a browser. Served instead of src/team/demo.ts by
// vite.deck.config.ts (untracked); nothing here touches the app's own files.
export * from "/src/team/demo.ts";
import type { Line, ScreenPatch, Snapshot, TeamConfig, TeamFile, Usage } from "/src/team/types.ts";

const NOW = Date.now();
const q = (k: string) => (typeof location === "undefined" ? null : new URLSearchParams(location.search).get(k));

const config: TeamConfig = {
  id: "team",
  name: "生成式 AI 介紹網頁",
  goal: "做一個介紹生成式 AI 的單頁網站\n要有圖片、三個章節,可以直接放到公司官網",
  scope: ["首頁與導覽", "三個章節頁", "主視覺與插圖"],
  workDir: "D:\\Code\\genai-intro",
  leader: "ai1",
  autoApprove: true,
  members: [
    { id: "ai1", name: "Claude Fable", role: "組長", duty: "拆解需求、派工、驗收", agent: "claude", model: "claude-fable-5-1", color: "#5b8def" },
    { id: "ai2", name: "Codex Sol", role: "前端", duty: "實作頁面與樣式", agent: "codex", model: "gpt-5.6-sol", color: "#34c7a0" },
    { id: "ai3", name: "Gemini", role: "生圖", duty: "主視覺與章節插圖", agent: "agy", model: "gemini-3.8-flash", color: "#f5b63d" },
    { id: "ai4", name: "LocalLLM", role: "審查", duty: "內容正確性與無障礙審查", agent: "ollama", model: "qwen3-coder", color: "#a06cf0" },
  ],
  links: [
    { from: "ai3", to: "ai2", kind: "delivery", what: "圖片素材" },
    { from: "ai2", to: "ai4", kind: "delivery", what: "網頁版本" },
  ],
  expected: [],
  directTalk: true,
  sharedBoard: true,
  maxTurns: 60,
};

export const demoAgents: any[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, cwd: "", protocol: "claude" },
  { id: "codex", name: "Codex", command: "codex", args: ["app-server"], env: {}, cwd: "", protocol: "codex" },
  { id: "agy", name: "Antigravity", command: "agy", args: [], env: {}, cwd: "", protocol: "agy" },
  { id: "copilot", name: "Copilot CLI", command: "copilot", args: ["--acp", "--stdio"], env: {}, cwd: "" },
  { id: "ollama", name: "本機模型 · qwen3-coder", command: "copilot", args: ["--acp", "--stdio"], env: { COPILOT_PROVIDER_BASE_URL: "http://localhost:11434/v1" }, cwd: "", model: "qwen3-coder", location: "local" },
] as any;

// `?deck=run` opens with the team already created and running; otherwise (Agent
// Center) there is no team until the proposal card is confirmed.
const RUN = q("deck") === "run";
export const demoFiles: { dir: string; files: TeamFile[] } = {
  dir: "C:\\Users\\Steven\\AppData\\Roaming\\Coucou\\teams",
  files: RUN ? [{ file: "team.json", config, problems: [] }] : [],
};

/** The browser stand-in for Bridge.secretaryConfirm: the team file appears, the card is done. */
let armed: () => void = () => {};
const go = RUN ? Promise.resolve() : new Promise<void>((r) => (armed = r));
let current: Snapshot | null = null;
export function demoConfirm(p: any) {
  if (!demoFiles.files.length) demoFiles.files.push({ file: "team.json", config, problems: [] });
  if (current) current.startedAt = Date.now() - 20_000;
  armed();
  return { ...p, state: "done", outcome: `已建立並啟動團隊 ${config.name}(id ${config.id})` };
}

function used(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
  return { model, input, output, cacheRead, cacheWrite, reasoning: 0, requests: 0 };
}

let n = 0;
const line = (kind: Line["kind"], text: string, extra: Partial<Line> = {}): Line => ({ n: ++n, since: Date.now(), at: Date.now(), kind, text, tool: "", teamTool: "", input: null, status: "", output: "", ...extra });
const turn = (k: number, heard: { from: string; text: string }[]) => line("turn", String(k), { status: "start", input: heard });
const tool = (title: string, kind: string, status: string, extra: Partial<Line> = {}) => line("tool", title, { tool: kind, status, ...extra });
const team = (name: string, input: unknown, status = "done") => line("tool", `coucou-team.${name}`, { tool: "other", teamTool: name, input, status });

const TITLES: Record<string, string> = {
  "TASK-01": "網站架構與大綱",
  "TASK-02": "主視覺與章節插圖",
  "TASK-03": "首頁與導覽",
  "TASK-04": "章節頁:模型種類與應用",
  "TASK-05": "大綱與術語正確性審查",
  "TASK-06": "響應式與無障礙檢查",
  "TASK-07": "最終驗收與交付",
};
const OWNER: Record<string, string> = { "TASK-01": "ai1", "TASK-02": "ai3", "TASK-03": "ai2", "TASK-04": "ai2", "TASK-05": "ai4", "TASK-06": "ai4", "TASK-07": "ai1" };
const task = (id: string, status: Snapshot["tasks"][number]["status"], extra: Partial<Snapshot["tasks"][number]> = {}): Snapshot["tasks"][number] => ({
  id, title: TITLES[id], detail: "", owner: OWNER[id], status, priority: "medium", criteria: [], dependsOn: [], deliverTo: null, reviewer: null, blocked: null, note: "", rejections: 0,
  dispatched: status !== "todo", createdAt: NOW - 60_000, updatedAt: NOW, ...extra,
});

const seat = (i: number) => ({ ...config.members[i], model: config.members[i].model ?? "", screen: [] as Line[], morePermissions: [] });

export function demoSnapshot(): Snapshot {
  const snap: Snapshot = {
    id: "team", seq: 1, detached: false, name: config.name, goal: config.goal, workDir: config.workDir,
    status: "running", pausedWhy: "", done: 1, total: 7, totalTurns: 2, maxTurns: 60,
    startedAt: NOW - 2 * 60_000, finishedAt: 0, timeLimitMin: 0, timeReserveMin: 0, timeWarned: false, timeUp: false,
    members: [
      { ...seat(0), isLeader: true, status: "working", phase: "planning", task: "TASK-01", waiting: null, activity: "", turns: 2, workMs: 2 * 60_000, permission: null, lostWhy: "", usage: [used("claude-fable-5-1", 18_000, 3_200, 120_000, 9_000)] },
      { ...seat(1), isLeader: false, status: "idle", task: null, waiting: null, activity: "", turns: 0, workMs: 0, permission: null, lostWhy: "", usage: [used("gpt-5.6-sol", 0, 0)] },
      { ...seat(2), isLeader: false, status: "idle", task: null, waiting: null, activity: "", turns: 0, workMs: 0, permission: null, lostWhy: "", usage: [used("gemini-3.8-flash", 0, 0)] },
      { ...seat(3), isLeader: false, status: "idle", task: null, waiting: null, activity: "", turns: 0, workMs: 0, permission: null, lostWhy: "", usage: [used("qwen3-coder", 0, 0)] },
    ],
    tasks: [
      task("TASK-01", "done", { note: "三章節大綱與頁面結構已定" }),
      task("TASK-02", "todo", { dispatched: false, deliverTo: "ai2" }),
      task("TASK-03", "todo", { dispatched: false, dependsOn: ["TASK-01"] }),
      task("TASK-04", "todo", { dispatched: false, dependsOn: ["TASK-03"] }),
      task("TASK-05", "todo", { dispatched: false, dependsOn: ["TASK-01"] }),
      task("TASK-06", "todo", { dispatched: false, dependsOn: ["TASK-04"] }),
      task("TASK-07", "todo", { dispatched: false, dependsOn: ["TASK-02", "TASK-04", "TASK-06"] }),
    ],
    deliverables: [{ id: "D-1", task: "TASK-01", kind: "spec", locator: "docs/outline.md", summary: "網站架構與三章節大綱", by: "ai1", at: NOW - 30_000, accepted: true }],
    messages: [],
    questions: [],
    feed: [],
  };
  snap.members[0].screen = [
    turn(1, [{ from: "system", text: "The team has started. Plan the work for this goal and create the tasks now:" }]),
    line("say", "我先把需求拆成可以驗收的任務:架構與大綱我自己來,主視覺交給 Gemini,首頁與章節頁交給 Codex Sol,正確性與無障礙審查交給 LocalLLM。"),
    team("team_status", {}),
    tool("Edit docs/outline.md", "edit", "done"),
    team("deliver", { task: "TASK-01", summary: "網站架構與三章節大綱", locator: "docs/outline.md" }),
    line("turn", "1", { status: "end" }),
    turn(2, [{ from: "system", text: "TASK-01 was accepted. Hand out the work that can start now." }]),
    line("say", "大綱定了。三件事互不相依,我同時派出去,讓大家平行開工。"),
  ];
  current = snap;
  return snap;
}

/** The run, as it would unfold: three members start at the same moment, the leader keeps handing out work as results come in. */
export function demoStream(onScreen: (patch: ScreenPatch) => void, onChange: (snap: Snapshot) => void, snap: Snapshot) {
  const m = (id: string) => snap.members.find((x) => x.id === id)!;
  const t = (id: string) => snap.tasks.find((x) => x.id === id)!;
  const say = (who: string, text: string, extra: Partial<Line> = {}) => { const l = line("say", text, extra); m(who).screen = [...m(who).screen, l]; onScreen({ team: snap.id, member: who, lines: [l] }); return l; };
  const add = (who: string, l: Line) => { m(who).screen = [...m(who).screen, l]; onScreen({ team: snap.id, member: who, lines: [l] }); return l; };
  const grow = (who: string, inTok: number, outTok: number) => { const u = m(who).usage![0]; u.input += inTok; u.output += outTok; if (who === "ai1") u.cacheRead += inTok * 6; };
  const feed = (kind: Snapshot["feed"][number]["kind"], from: string, to: string, text: string, taskId: string | null, at = Date.now()) => { snap.feed = [...snap.feed, { at, kind, from, to, text, task: taskId }]; };
  const change = () => { snap.seq++; onChange({ ...snap, members: snap.members.map((x) => ({ ...x })), tasks: snap.tasks.map((x) => ({ ...x })) }); };
  const give = (id: string, at: number) => {
    const who = OWNER[id];
    Object.assign(t(id), { status: "doing", dispatched: true, updatedAt: at });
    Object.assign(m(who), { status: "working", task: id, turns: m(who).turns + 1 });
    feed("task", "ai1", who, TITLES[id], id, at);
    add(who, turn(m(who).turns, [{ from: "system", text: `${id} is yours and ready to start: ${TITLES[id]}` }]));
    add(who, team("task_update", { task: id, status: "doing" }));
  };
  const deliver = (id: string, summary: string, at: number) => {
    const who = OWNER[id];
    Object.assign(t(id), { status: "delivered", updatedAt: at });
    Object.assign(m(who), { status: "idle", task: null, activity: "" });
    snap.deliverables = [...snap.deliverables, { id: `D-${snap.deliverables.length + 1}`, task: id, kind: "file", locator: "", summary, by: who, at, accepted: false }];
    feed("delivered", who, t(id).deliverTo ?? "ai1", summary, id, at);
    add(who, team("deliver", { task: id, summary }));
    add(who, line("turn", String(m(who).turns), { status: "end" }));
    grow(who, 60_000, 9_000);
  };
  const accept = (id: string, at: number) => {
    Object.assign(t(id), { status: "done", updatedAt: at });
    snap.done = snap.tasks.filter((x) => x.status === "done").length;
    snap.totalTurns++;
    m("ai1").phase = "reviewing";
    feed("accepted", "ai1", OWNER[id], "", id, at);
    add("ai1", team("review", { task: id, accept: "true" }));
    grow("ai1", 30_000, 2_000);
  };
  const steps: [number, () => void][] = [
    [600, () => { add("ai1", team("task_create", { title: TITLES["TASK-02"], owner: "ai3" })); change(); }],
    [1500, () => { add("ai1", team("task_create", { title: TITLES["TASK-03"], owner: "ai2" })); change(); }],
    [2400, () => { add("ai1", team("task_create", { title: TITLES["TASK-05"], owner: "ai4" })); change(); }],
    [3400, () => { say("ai1", "三個任務同時派出:Gemini 畫主視覺與插圖,Codex Sol 做首頁與導覽,LocalLLM 先審大綱與術語。"); }],
    // The same moment: three members start together.
    [5200, () => {
      const at = Date.now();
      give("TASK-02", at); give("TASK-03", at); give("TASK-05", at);
      m("ai1").phase = "reviewing"; m("ai1").task = null; m("ai1").activity = "";
      snap.totalTurns += 3;
      change();
    }],
    [6400, () => { say("ai3", "收到,先依大綱定主視覺的風格,再出五張章節插圖。"); m("ai3").activity = "Generate an image"; grow("ai3", 4_000, 600); change(); }],
    [6900, () => { say("ai2", "先把首頁骨架、導覽列與三個章節的錨點做出來,樣式用同一套 tokens。"); m("ai2").activity = "Editing src/index.html"; grow("ai2", 20_000, 3_000); change(); }],
    [7400, () => { say("ai4", "我來核對大綱裡的術語與說法,有問題的地方標出來給組長。"); m("ai4").activity = "Reading docs/outline.md"; grow("ai4", 9_000, 1_200); change(); }],
    [8200, () => { add("ai3", tool("Generate an image", "other", "running")); add("ai2", tool("Edit src/index.html", "edit", "done")); add("ai4", tool("Read docs/outline.md", "read", "done")); change(); }],
    [10_000, () => { add("ai2", tool("Edit src/styles/base.css", "edit", "done")); add("ai4", tool("Read docs/glossary.md", "read", "done")); change(); }],
    [11_500, () => { say("ai4", "「擴散模型」一段把訓練與推論混在一起,建議拆成兩段並補一張流程圖;其餘術語正確。"); }],
    [12_200, () => { deliver("TASK-05", "大綱審查:1 處建議修改,其餘通過", Date.now()); change(); }],
    [13_600, () => { accept("TASK-05", Date.now()); say("ai1", "採納 LocalLLM 的意見,請 Codex Sol 在章節頁把訓練與推論分開說明。"); change(); }],
    [15_000, () => { add("ai3", tool("Generate an image", "other", "done")); add("ai3", tool("Read assets/img/hero.webp", "read", "done")); change(); }],
    [16_200, () => { deliver("TASK-02", "主視覺 1 張、章節插圖 5 張", Date.now()); change(); }],
    [17_400, () => { accept("TASK-02", Date.now()); change(); }],
    [18_400, () => { add("ai2", tool("Run npx html-validate src/**/*.html", "execute", "done", { input: { command: "npx html-validate src/**/*.html" }, output: "src/index.html: 0 errors" })); change(); }],
    [19_600, () => { deliver("TASK-03", "首頁與導覽,含三章節錨點", Date.now()); change(); }],
    // Results back: the leader accepts and hands out the next two at once.
    [21_000, () => {
      const at = Date.now();
      accept("TASK-03", at);
      say("ai1", "首頁通過。接著 Codex Sol 做章節頁,LocalLLM 同時做響應式與無障礙檢查。");
      give("TASK-04", at); give("TASK-06", at);
      m("ai1").phase = "reviewing";
      snap.totalTurns += 2;
      change();
    }],
    [22_600, () => { say("ai2", "開始做三個章節頁,把訓練與推論分成兩段。"); m("ai2").activity = "Editing src/sections/models.html"; add("ai2", tool("Edit src/sections/models.html", "edit", "done")); say("ai4", "用 375px 與 1280px 兩種寬度檢查排版,並跑一次無障礙掃描。"); m("ai4").activity = "Run npx pa11y http://localhost:5173"; add("ai4", tool("Run npx pa11y http://localhost:5173", "execute", "running", { input: { command: "npx pa11y http://localhost:5173" } })); grow("ai2", 40_000, 6_000); grow("ai4", 12_000, 1_500); change(); }],
    [25_500, () => { add("ai2", tool("Edit src/styles/cards.css", "edit", "done")); change(); }],
    [27_000, () => { deliver("TASK-04", "三個章節頁,含流程圖位置", Date.now()); change(); }],
    [28_200, () => { accept("TASK-04", Date.now()); change(); }],
    [29_400, () => { deliver("TASK-06", "響應式 2 種寬度通過,無障礙 0 個錯誤", Date.now()); change(); }],
    [30_600, () => { accept("TASK-06", Date.now()); change(); }],
    [31_800, () => {
      const at = Date.now();
      Object.assign(t("TASK-07"), { status: "doing", dispatched: true, updatedAt: at });
      Object.assign(m("ai1"), { status: "working", phase: null, task: "TASK-07" });
      say("ai1", "全部通過,我把首頁、章節頁與圖片整合後交付。");
      add("ai1", team("task_update", { task: "TASK-07", status: "doing" }));
      change();
    }],
    [34_000, () => {
      const at = Date.now();
      Object.assign(t("TASK-07"), { status: "done", updatedAt: at });
      snap.done = 7;
      snap.status = "finished";
      snap.finishedAt = at;
      snap.members.forEach((x) => Object.assign(x, { status: "done", task: null, activity: "", phase: null }));
      feed("finished", "ai1", "", "生成式 AI 介紹網頁已交付", "TASK-07", at);
      add("ai1", team("team_finish", {}));
      change();
    }],
  ];
  const t0 = Number(q("t0") ?? 0);
  void go.then(() => { for (const [at, fn] of steps) window.setTimeout(fn, Math.max(0, at - t0) + 400); });
  // A quiet tick keeps the clocks moving.
  window.setInterval(() => { snap.members.forEach((x) => { if (x.status === "working") x.workMs = (x.workMs ?? 0) + 1000; }); }, 1000);
}

export async function demoSecretary(_text: string, step?: (s: import("/src/team/types.ts").SecretaryStep) => void): Promise<import("/src/team/types.ts").SecretaryReply> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(500);
  step?.({ tool: "list_agents", label: "查看可用的代理" });
  for (const agent of ["ta-claude", "ta-codex", "ta-gemini", "ta-local"]) {
    await wait(650);
    step?.({ tool: "agent_models", label: `查詢「${agent}」提供的模型`, agent });
  }
  await wait(700);
  step?.({ tool: "propose_team", label: `擬好新團隊「${config.name}」` });
  await wait(400);
  return {
    text: `看過 Agent Pool 之後,我建議開一個 4 人團隊:由 Claude Fable 當組長拆解與驗收,Codex Sol 寫頁面,Gemini 出主視覺與插圖,LocalLLM 在本機做正確性與無障礙審查。已擬好新團隊「${config.name}」,**尚未建立**。按卡片上的「建立並啟動」才會執行;想換人可以按「調整人選」。`,
    steps: [{ tool: "list_agents", label: "查看可用的代理" }, { tool: "propose_team", label: `擬好新團隊「${config.name}」` }],
    proposals: [
      {
        id: "P-1",
        kind: "team",
        title: `新團隊「${config.name}」`,
        lines: [
          "目標:做一個介紹生成式 AI 的單頁網站,要有圖片、三個章節,可以直接放到公司官網",
          "範圍:首頁與導覽、三個章節頁、主視覺與插圖",
          "工作資料夾:D:\\Code\\genai-intro",
          "Claude Fable(Leader) · 組長 · claude / claude-fable-5-1 — 拆解需求、派工、驗收",
          "Codex Sol · 前端 · codex / gpt-5.6-sol — 實作頁面與樣式",
          "Gemini · 生圖 · agy / gemini-3.8-flash — 主視覺與章節插圖",
          "LocalLLM · 審查 · ollama / qwen3-coder — 內容正確性與無障礙審查",
        ],
        confirm: "建立並啟動",
        state: "open",
        outcome: "",
      },
    ],
  };
}
