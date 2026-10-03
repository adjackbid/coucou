// The live side of the monitor: every member as a Mochi that moves with what
// its agent is doing, a bubble with what it is saying right now, its screen —
// each word, command and result as it happens — and the team's traffic
// flying from one member to the other.
//
// The rest of the page is drawn again on every change; these pieces are not.
// Each lives as long as the window, keyed by team and member, and is moved
// into the page drawn afresh, so a Mochi keeps its animation and a screen its
// scroll. They only move while someone can see them: the frame loop stops
// when no Mochi is on screen or the window is hidden.

import { BotEngine, hexToRGB } from "../mochi/engine";
import type { BotStateName } from "../core/layout";
import { h, clear } from "../views/dom";
import type { FeedItem, Line, MemberView, ScreenPatch, Snapshot } from "./types";

const YOU = "you";
const SYSTEM = "system";
/** A Mochi's body, in CSS pixels; its canvas is larger, for the hops and sparks. */
const BODY = 50;
/** Lines kept on a screen. */
const KEEP = 300;
/** A member at work this long without a sign of life may be stuck. */
const QUIET_MS = 4 * 60_000;

interface Desk {
  team: string;
  member: string;
  color: string;
  avatar: HTMLElement;
  canvas: HTMLCanvasElement;
  engine: BotEngine;
  size: number;
  bubble: HTMLElement;
  screen: HTMLElement;
  /** Its last sign of life, kept current by the clock. */
  pulse: HTMLElement;
  lines: Map<number, Line>;
  rows: Map<number, HTMLElement>;
  /** Following the newest line, or left where the reader scrolled to. */
  follow: boolean;
  scrollTop: number;
  /** When the reader last touched the screen: only they stop it following. */
  touched: number;
  /** The run the lines belong to; a team started again starts a clean screen. */
  run: number;
}

const desks = new Map<string, Desk>();
const snaps = new Map<string, Snapshot>();
/** Feed items already flown, per team; the first picture of a team flies nothing. */
const flown = new Map<string, Set<string>>();

/** The page's own wording of the orchestrator's sentences. */
let said: (text: string) => string = (t) => t;
export function setSaid(fn: (text: string) => string) {
  said = fn;
}

const keyOf = (team: string, member: string) => `${team}/${member}`;

function nameOf(snap: Snapshot | undefined, id: string): string {
  if (id === YOU) return "你";
  if (id === SYSTEM) return "Coucou";
  return snap?.members.find((m) => m.id === id)?.name ?? id;
}

function colorOf(snap: Snapshot | undefined, id: string): string {
  return snap?.members.find((m) => m.id === id)?.color || "#9398A1";
}

const short = (text: string, keep: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > keep ? `${flat.slice(0, keep)}…` : flat;
};

const tailOf = (text: string, keep: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > keep ? `…${flat.slice(flat.length - keep)}` : flat;
};

// ── What the lines say ────────────────────────────────────────────────────────

/** Codex runs everything through PowerShell: show what it ran, not the wrapper. */
function bare(command: string): string {
  const m = command.match(/^\s*(?:"[^"]*?(?:pwsh|powershell|bash|cmd)(?:\.exe)?"|\S*?(?:pwsh|powershell|bash|cmd)(?:\.exe)?)\s+(?:-(?!c\b|command\b)\w+(?:\s+(?!-)\S+)?\s+)*(?:-Command|-c|\/c)\s+([\s\S]+)$/i);
  let out = (m ? m[1] : command).trim();
  if (/^(['"]).*\1$/s.test(out)) out = out.slice(1, -1);
  return out;
}

function arg(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : typeof v === "boolean" || typeof v === "number" ? String(v) : "";
}

/** A team tool call, in the window's words. */
function teamWords(snap: Snapshot | undefined, l: Line): string {
  const a = (k: string) => arg(l.input, k);
  const task = (id: string) => {
    const t = snap?.tasks.find((x) => x.id === id);
    return t ? `${id}「${t.title}」` : id;
  };
  switch (l.teamTool) {
    case "team_status":
      return "查看團隊現況";
    case "task_create":
      return `建立任務「${a("title")}」→ ${nameOf(snap, a("owner"))}`;
    case "task_assign":
      return `把 ${task(a("task"))} 交給 ${nameOf(snap, a("owner"))}`;
    case "task_update":
      return a("status") === "doing" ? `開始做 ${task(a("task"))}` : `更新 ${task(a("task"))}${a("note") ? `:${short(a("note"), 60)}` : ""}`;
    case "task_block":
      return `卡住了,等 ${nameOf(snap, a("waiting_on"))}:${short(a("reason"), 60)}`;
    case "deliver":
      return `交付 ${task(a("task"))}:${short(a("summary"), 70)}`;
    case "review":
      return a("accept") === "true" ? `驗收通過 ${task(a("task"))}` : `退回 ${task(a("task"))}:${short(a("reason"), 60)}`;
    case "message_send":
      return `傳訊息給 ${nameOf(snap, a("to"))}:${short(a("text"), 80)}`;
    case "ask_human":
      return `問你:${short(a("question"), 80)}`;
    default:
      return l.text;
  }
}

/** Any other tool: what it did, short. */
function toolWords(l: Line): string {
  const command = arg(l.input, "command");
  if (l.tool === "execute") return bare(command || l.text.replace(/^Run\s+/, ""));
  return l.text
    .replace(/^Run\s+/, "執行 ")
    .replace(/^Edit\s+/, "編輯 ")
    .replace(/^Read\s+/, "讀取 ")
    .replace(/^Search the web$/, "搜尋網路")
    .replace(/^Sub-agent\s+(.*)$/, "子代理 $1 分頭處理")
    .replace(/^Generate an image$/, "生成圖片");
}

const TOOL_MARK: Record<string, string> = {
  execute: "›",
  edit: "✎",
  read: "◎",
  search: "◎",
  fetch: "↗",
  think: "…",
  move: "⇄",
  delete: "⌫",
};

/** What a member heard at the start of a turn, in the window's words. */
export function heardWords(text: string): string {
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^The team has started\./, () => "團隊開始了:規劃工作並建立任務"],
    [/^(TASK-\d+) is yours and ready to start: (.+)/, (m) => `${m[1]}「${m[2]}」交給你了`],
    [/^(.+?) handed in (TASK-\d+) \((.+?)\), which is meant for you/, (m) => `${m[1]} 交付了 ${m[2]}「${m[3]}」給你`],
    [/^(.+?) handed in (TASK-\d+) \((.+?)\)/, (m) => `${m[1]} 交付了 ${m[2]}「${m[3]}」,請驗收`],
    [/^(.+?) sent (TASK-\d+) \((.+?)\) back: (.+)/, (m) => `${m[1]} 退回了 ${m[2]}「${m[3]}」:${m[4]}`],
    [/^No task exists yet/, () => "還沒有任務,請馬上建立"],
    [/^You ended your turn, but this is still open/, () => "提醒:手上的工作還沒回報"],
    [/^You were restarted/, () => "你被重新啟動了"],
    [/^Coucou was closed while the team was working/, () => "Coucou 重新開啟了,從中斷的地方接著做"],
    [/^Every task has been accepted\./, () => "全部驗收完成,請寫最終報告"],
    [/^You asked: [\s\S]*?\nThe user answers: ([\s\S]+)/, (m) => `你的回覆:${m[1]}`],
  ];
  for (const [pattern, to] of rules) {
    const m = text.match(pattern);
    if (m) return to(m);
  }
  return text;
}

function row(snap: Snapshot | undefined, l: Line): HTMLElement {
  switch (l.kind) {
    case "turn": {
      if (l.status === "start") {
        const heard = Array.isArray(l.input) ? (l.input as { from: string; text: string }[]) : [];
        const el = h("div", { class: "line turn" }, h("span", { class: "rule", text: `第 ${l.text} 回合` }));
        for (const x of heard.slice(-4)) {
          el.append(
            h(
              "div",
              { class: "heard", style: `--from:${colorOf(snap, x.from)}` },
              h("b", { text: x.from === SYSTEM ? "Coucou" : nameOf(snap, x.from) }),
              short(heardWords(x.text), 160),
            ),
          );
        }
        return el;
      }
      if (l.status === "failed") return h("div", { class: "line turn failed" }, h("span", { class: "rule", text: "回合失敗" }), h("div", { class: "why", text: said(l.output) }));
      return h("div", { class: "line turn end" }, h("span", { class: "rule", text: "回合結束" }));
    }
    case "say":
      return h("div", { class: "line say" }, h("p", { text: l.text.trim() }));
    case "think":
      return h("div", { class: "line think", text: `思考 · ${tailOf(l.text, 220)}` });
    case "tool": {
      const team = !!l.teamTool;
      const mark = l.status === "running" ? h("i", { class: "spin", "aria-label": "進行中" }) : h("i", { class: "mark", text: l.status === "failed" ? "✕" : "✓" });
      const el = h(
        "div",
        { class: `line tool ${team ? "team" : `k-${l.tool}`} s-${l.status}`, title: team ? "" : l.text },
        mark,
        team ? null : h("span", { class: "kind", text: TOOL_MARK[l.tool] ?? "⚙" }),
        h("span", { class: team ? "what" : "what mono", text: team ? teamWords(snap, l) : toolWords(l) }),
        l.status === "running" ? h("span", { class: "took", "data-since": String(l.since) }) : null,
      );
      // The end of what it printed: while it runs, and when it failed.
      const out = l.output.trim();
      if (out && l.status !== "done") {
        const last = out.split("\n").slice(l.status === "running" ? -4 : -3).join("\n");
        el.append(h("pre", { class: "out", text: team ? said(last) : last }));
      }
      return el;
    }
  }
}

// ── A member's desk ───────────────────────────────────────────────────────────

function desk(snap: Snapshot, m: MemberView): Desk {
  const key = keyOf(snap.id, m.id);
  let d = desks.get(key);
  if (d && d.run !== snap.startedAt) {
    // The team was started again: a clean screen.
    clear(d.screen);
    d.lines.clear();
    d.rows.clear();
    d.run = snap.startedAt;
  }
  if (d) return d;

  const size = Math.round(BODY / 0.6);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = h("canvas", { width: Math.round(size * dpr), height: Math.round(size * dpr), style: `width:${size}px;height:${size}px` });
  const avatar = h("span", { class: "avatar", style: `width:${BODY}px;height:${BODY}px` }, canvas);
  const engine = new BotEngine();
  engine.isMini = true;
  engine.bodyColor = hexToRGB(m.color || "#3B9EFF");
  engine.setState("idle", true);
  const screen = h("div", { class: "screen", tabindex: "0" });
  d = {
    team: snap.id,
    member: m.id,
    color: m.color,
    avatar,
    canvas,
    engine,
    size,
    bubble: h("div", { class: "bubble" }),
    screen,
    pulse: h("span", { class: "pulse" }),
    lines: new Map(),
    rows: new Map(),
    follow: true,
    scrollTop: 0,
    touched: 0,
    run: snap.startedAt,
  };
  const me = d;
  const touch = () => (me.touched = performance.now());
  screen.addEventListener("wheel", touch, { passive: true });
  screen.addEventListener("pointerdown", touch);
  screen.addEventListener("keydown", touch);
  screen.addEventListener("scroll", () => {
    if (!screen.isConnected) return;
    me.scrollTop = screen.scrollTop;
    // Only the reader decides to stop following, by scrolling up.
    if (performance.now() - me.touched < 1500) me.follow = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 28;
  });
  desks.set(key, d);
  return d;
}

function put(snap: Snapshot | undefined, d: Desk, l: Line) {
  const was = d.lines.get(l.n);
  if (was && was.text === l.text && was.status === l.status && was.output === l.output && was.teamTool === l.teamTool) return;
  d.lines.set(l.n, l);
  const el = row(snap, l);
  const old = d.rows.get(l.n);
  if (old) old.replaceWith(el);
  else {
    // Lines come in order; one older than the newest shown goes where it belongs.
    const after = [...d.rows.keys()].filter((n) => n > l.n).sort((a, b) => a - b)[0];
    if (after !== undefined) d.rows.get(after)!.before(el);
    else d.screen.append(el);
  }
  d.rows.set(l.n, el);
  while (d.rows.size > KEEP) {
    const first = Math.min(...d.rows.keys());
    d.rows.get(first)?.remove();
    d.rows.delete(first);
    d.lines.delete(first);
  }
}

/** The last thing said is still being written while the member works. */
function caret(d: Desk, m: MemberView | undefined) {
  d.screen.querySelector(".line.say.open")?.classList.remove("open");
  if (m?.status !== "working") return;
  const last = Math.max(0, ...d.rows.keys());
  const line = d.lines.get(last);
  if (line?.kind === "say") d.rows.get(last)?.classList.add("open");
}

function stick(d: Desk) {
  if (!d.screen.isConnected) return;
  if (d.follow) d.screen.scrollTop = d.screen.scrollHeight;
  else d.screen.scrollTop = d.scrollTop;
}

/** How the member's Mochi should look. */
function mood(snap: Snapshot, m: MemberView, d: Desk): BotStateName {
  switch (m.status) {
    case "lost":
      return "error";
    case "waitingYou":
      return m.permission ? "approval" : "question";
    case "done":
      return "finished";
    case "waitingDelivery":
    case "waitingReply":
      return "idle";
    case "idle":
      return snap.status === "finished" ? "finished" : "sleeping";
    case "working": {
      const last = d.lines.get(Math.max(0, ...d.lines.keys()));
      if (last?.kind === "think") return "thinking";
      if (last?.kind === "tool" && last.status === "running" && ["read", "search", "fetch"].includes(last.tool)) return "searching";
      return "working";
    }
  }
}

/** What the member's bubble says: what it is saying or doing right now. */
function bubbleText(snap: Snapshot, m: MemberView, d: Desk): string {
  switch (m.status) {
    case "lost":
      return `我失聯了:${said(m.lostWhy)}`;
    case "waitingYou": {
      if (m.permission) {
        const raw = m.permission.rawInput && typeof m.permission.rawInput === "object" ? (m.permission.rawInput as Record<string, unknown>) : {};
        const more = m.morePermissions.length ? `(還有 ${m.morePermissions.length} 個)` : "";
        return `等你批准${more}:${short(typeof raw.command === "string" ? bare(raw.command) : m.permission.title, 90)}`;
      }
      const q = snap.questions.find((x) => x.by === m.id && x.answer === null);
      return q ? `想問你:${short(q.question, 90)}` : "等你回覆";
    }
    case "waitingDelivery":
      return m.waiting ? `等 ${nameOf(snap, m.waiting.on)} 交付「${m.waiting.what}」` : "等隊友交付";
    case "waitingReply":
      return m.waiting ? `等 ${nameOf(snap, m.waiting.on)} 回覆:${short(m.waiting.what, 60)}` : "等隊友回覆";
    case "done":
      return snap.status === "finished" ? "收工!" : "我的工作都交付了";
    case "idle":
      return snap.status === "finished" ? "收工!" : snap.status === "paused" ? "團隊暫停中" : "待命中,等下一個任務";
    case "working": {
      const last = d.lines.get(Math.max(0, ...d.lines.keys()));
      if (!last) return "開工了…";
      if (last.kind === "say") return tailOf(last.text, 110) || "…";
      if (last.kind === "think") return "思考中…";
      if (last.kind === "tool") return last.teamTool ? teamWords(snap, last) : `${last.tool === "execute" ? "執行 " : ""}${short(toolWords(last), 90)}`;
      return "開工了…";
    }
  }
}

function refresh(snap: Snapshot, m: MemberView) {
  const d = desk(snap, m);
  if (d.color !== m.color) {
    d.color = m.color;
    d.engine.bodyColor = hexToRGB(m.color || "#3B9EFF");
  }
  const next = mood(snap, m, d);
  if (d.engine.state !== next) d.engine.setState(next);
  const text = bubbleText(snap, m, d);
  if (d.bubble.textContent !== text) d.bubble.textContent = text;
  d.bubble.className = `bubble ${m.status}`;
  caret(d, m);
}

// ── What main.ts uses ─────────────────────────────────────────────────────────

/** The member's lasting pieces, to be put into the page being drawn. */
export function parts(snap: Snapshot, m: MemberView): { avatar: HTMLElement; bubble: HTMLElement; screen: HTMLElement; pulse: HTMLElement } {
  const d = desk(snap, m);
  if (!d.rows.size) {
    for (const l of m.screen) put(snap, d, l);
    refresh(snap, m);
  }
  if (!d.rows.size && !d.screen.firstChild) d.screen.append(h("div", { class: "line quiet", text: "還沒有動靜。輪到這位成員時,它說的話、跑的指令和結果都會即時出現在這裡。" }));
  return { avatar: d.avatar, bubble: d.bubble, screen: d.screen, pulse: d.pulse };
}

/** A new picture of a team. */
export function applySnapshot(snap: Snapshot) {
  snaps.set(snap.id, snap);
  for (const m of snap.members) {
    const d = desk(snap, m);
    if (m.screen.length) d.screen.querySelector(".line.quiet")?.remove();
    for (const l of m.screen) put(snap, d, l);
    refresh(snap, m);
    stick(d);
  }
  // What happened between members since the last picture flies across.
  let seen = flown.get(snap.id);
  const ids = (f: FeedItem) => `${f.at}|${f.kind}|${f.from}|${f.to}|${f.task ?? ""}|${f.text.length}`;
  if (!seen) {
    flown.set(snap.id, new Set(snap.feed.map(ids)));
    return;
  }
  const fresh = snap.feed.filter((f) => !seen!.has(ids(f)));
  for (const f of fresh) seen.add(ids(f));
  fresh.slice(-6).forEach((f, i) => window.setTimeout(() => fly(snap, f), i * 320));
}

/** Lines of one member's screen, as they happen. */
export function applyPatch(patch: ScreenPatch) {
  const snap = snaps.get(patch.team);
  const m = snap?.members.find((x) => x.id === patch.member);
  if (!snap || !m) return;
  const d = desk(snap, m);
  d.screen.querySelector(".line.quiet")?.remove();
  for (const l of patch.lines) put(snap, d, l);
  refresh(snap, m);
  stick(d);
  wake();
  signs();
}

/** After the page was drawn: screens back where they were, Mochis moving. */
export function afterRender() {
  for (const d of desks.values()) stick(d);
  wake();
  beat();
}

// ── Signs of life ─────────────────────────────────────────────────────────────

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分鐘` : `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
}

function clockOf(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Each desk's last sign of life, how long its running steps have taken, and whether it has gone quiet. */
function signs() {
  const now = Date.now();
  for (const d of desks.values()) {
    if (!d.pulse.isConnected) continue;
    const snap = snaps.get(d.team);
    const m = snap?.members.find((x) => x.id === d.member);
    const lines = [...d.lines.values()];
    const last = lines.reduce((t, l) => Math.max(t, l.at), 0);
    const working = m?.status === "working";
    const quiet = working && last > 0 && now - last > QUIET_MS;
    let text = "";
    if (working && last) {
      const running = lines.filter((l) => l.kind === "tool" && l.status === "running").sort((a, b) => b.n - a.n)[0];
      const on = running ? `,停在「${short(running.teamTool ? teamWords(snap, running) : toolWords(running), 40)}」${ago(now - running.since)}` : "";
      text = quiet ? `⚠ 已經 ${ago(now - last)}沒有動靜${on}` : now - last < 15_000 ? "● 正在動" : `● ${ago(now - last)}前有動靜${on}`;
    } else if (last) {
      text = `上次動靜:${ago(now - last)}前`;
    }
    if (d.pulse.textContent !== text) d.pulse.textContent = text;
    d.pulse.className = `pulse${working ? " on" : ""}${quiet ? " quiet" : ""}`;
    d.pulse.closest(".desk")?.classList.toggle("stalled", !!quiet);
    for (const took of d.screen.querySelectorAll<HTMLElement>(".took[data-since]")) {
      took.textContent = clockOf(now - Number(took.dataset.since));
    }
  }
}

let clock = 0;

/** The signs move on their own, every few seconds — while someone can see them. */
function beat() {
  signs();
  if (clock || document.hidden) return;
  clock = window.setInterval(() => {
    const shown = [...desks.values()].some((d) => d.pulse.isConnected);
    if (document.hidden || !shown) {
      window.clearInterval(clock);
      clock = 0;
      return;
    }
    signs();
  }, 5000);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) beat();
});

// ── Hand-offs flying between members ──────────────────────────────────────────

const FLY: Partial<Record<FeedItem["kind"], string>> = {
  message: "✉",
  task: "＋",
  delivered: "⬆",
  accepted: "✓",
  rejected: "↩",
  asked: "?",
  answered: "✉",
};

function anchor(snap: Snapshot, who: string): { x: number; y: number } | null {
  let el: Element | null = null;
  if (who === YOU) el = document.querySelector(".composer") ?? document.querySelector(".top");
  else if (who === SYSTEM) el = document.querySelector(".stage-head");
  else el = desks.get(keyOf(snap.id, who))?.avatar ?? null;
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  return who === SYSTEM ? { x: r.left + 40, y: r.top + r.height / 2 } : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

let layer: HTMLElement | null = null;

function fly(snap: Snapshot, f: FeedItem) {
  const glyph = FLY[f.kind];
  if (!glyph || !f.to || f.from === f.to) return;
  const from = anchor(snap, f.from);
  const to = anchor(snap, f.to);
  if (!from || !to) return land(snap, f);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return land(snap, f);

  if (!layer || !layer.isConnected) {
    layer = h("div", { class: "flyers", "aria-hidden": "true" });
    document.body.append(layer);
  }
  const task = f.task ? snap.tasks.find((t) => t.id === f.task) : undefined;
  const label = f.kind === "message" || f.kind === "answered" ? short(f.text, 16) : f.kind === "accepted" ? "驗收" : f.kind === "rejected" ? "退回" : short(task?.title ?? f.text, 14);
  const color = f.from === YOU || f.from === SYSTEM ? "#f5f6f8" : colorOf(snap, f.from);
  const flyer = h("div", { class: `flyer k-${f.kind}`, style: `--c:${color}` }, h("b", { text: glyph }), label);
  layer.append(flyer);
  const w = flyer.offsetWidth;
  const ht = flyer.offsetHeight;
  // Along an arc that rises above both ends.
  const lift = Math.min(140, Math.abs(to.x - from.x) * 0.25 + 50);
  const cx = (from.x + to.x) / 2;
  const cy = Math.min(from.y, to.y) - lift;
  const frames: Keyframe[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cx + t * t * to.x;
    const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cy + t * t * to.y;
    const scale = t < 0.1 ? 0.6 + t * 4 : t > 0.88 ? 1 - (t - 0.88) * 4 : 1;
    frames.push({ transform: `translate(${x - w / 2}px, ${y - ht / 2}px) scale(${scale.toFixed(3)})`, opacity: t < 0.06 || t > 0.97 ? 0 : 1, offset: t });
  }
  const anim = flyer.animate(frames, { duration: 1250, easing: "cubic-bezier(.45,.05,.35,1)" });
  anim.onfinish = () => {
    flyer.remove();
    land(snap, f);
  };
}

/** The one who receives it reacts. */
function land(snap: Snapshot, f: FeedItem) {
  const to = desks.get(keyOf(snap.id, f.to));
  const from = desks.get(keyOf(snap.id, f.from));
  if (to) {
    to.engine.squash();
    to.engine.blink();
  }
  if (f.kind === "accepted") {
    // Praise goes to the one whose work it was.
    const owner = snap.tasks.find((t) => t.id === f.task)?.owner;
    const d = owner ? desks.get(keyOf(snap.id, owner)) : to;
    d?.engine.triggerEmote("proud", 1.6);
    d?.engine.emit("spark", 5);
  } else if (f.kind === "rejected") {
    to?.engine.triggerEmote("surprised", 1.2);
  } else if (f.kind === "delivered") {
    from?.engine.triggerEmote("happy", 1.2);
  }
}

// ── The frame loop ────────────────────────────────────────────────────────────

let raf = 0;
let last = 0;

function frame(t: number) {
  raf = 0;
  if (document.hidden) {
    last = 0;
    return;
  }
  // About 40 frames a second is all a small Mochi needs.
  if (last && t - last < 24) {
    raf = requestAnimationFrame(frame);
    return;
  }
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 1 / 40;
  last = t;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let any = false;
  for (const d of desks.values()) {
    if (!d.canvas.isConnected) continue;
    any = true;
    // The window may have moved to a screen with another scale.
    const px = Math.round(d.size * dpr);
    if (d.canvas.width !== px) {
      d.canvas.width = px;
      d.canvas.height = px;
    }
    const ctx = d.canvas.getContext("2d");
    if (!ctx) continue;
    d.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, d.size, d.size);
    d.engine.draw(ctx, d.size, d.size);
  }
  if (any) raf = requestAnimationFrame(frame);
  else last = 0;
}

function wake() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}

document.addEventListener("visibilitychange", wake);
