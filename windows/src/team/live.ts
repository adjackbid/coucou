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
import { onLangChange, tr, trf } from "../core/i18n";
import { h, clear } from "../views/dom";
import type { FeedItem, Line, MemberView, ScreenPatch, Snapshot } from "./types";
import { imagePaths, picKey, thumbRow } from "./images";

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
  /** Each picture shown on the screen, under the newest line that names it. */
  pics: Map<string, { n: number; row: HTMLElement }>;
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
  if (id === YOU) return tr("你", "You");
  if (id === SYSTEM) return "Agent Center";
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
    return t ? trf("{id}「{title}」", "{id} “{title}”", { id, title: t.title }) : id;
  };
  switch (l.teamTool) {
    case "team_status":
      return tr("查看團隊現況", "Check how the team is doing");
    case "task_create":
      return trf("建立任務「{title}」→ {owner}", "Create task “{title}” → {owner}", { title: a("title"), owner: nameOf(snap, a("owner")) });
    case "task_assign":
      return trf("把 {task} 交給 {owner}", "Give {task} to {owner}", { task: task(a("task")), owner: nameOf(snap, a("owner")) });
    case "set_reviewer":
      return trf("指定 {task} 由 {who} 驗收", "Have {who} review {task}", { task: task(a("task")), who: nameOf(snap, a("reviewer")) });
    case "brief_member":
      return trf("交代 {who}:{text}", "Brief {who}: {text}", { who: nameOf(snap, a("member")), text: short(a("text") || a("skills"), 60) });
    case "team_finish":
      return tr("宣告團隊工作完成", "Declare the team's work done");
    case "task_update":
      return a("status") === "doing"
        ? trf("開始做 {task}", "Start {task}", { task: task(a("task")) })
        : a("note")
          ? trf("更新 {task}:{note}", "Update {task}: {note}", { task: task(a("task")), note: short(a("note"), 60) })
          : trf("更新 {task}", "Update {task}", { task: task(a("task")) });
    case "task_block":
      return trf("卡住了,等 {who}:{reason}", "Stuck, waiting for {who}: {reason}", { who: nameOf(snap, a("waiting_on")), reason: short(a("reason"), 60) });
    case "deliver":
      return trf("交付 {task}:{summary}", "Deliver {task}: {summary}", { task: task(a("task")), summary: short(a("summary"), 70) });
    case "review":
      return a("accept") === "true"
        ? trf("驗收通過 {task}", "Accept {task}", { task: task(a("task")) })
        : trf("退回 {task}:{reason}", "Send back {task}: {reason}", { task: task(a("task")), reason: short(a("reason"), 60) });
    case "message_send":
      return trf("傳訊息給 {to}:{text}", "Message {to}: {text}", { to: nameOf(snap, a("to")), text: short(a("text"), 80) });
    case "ask_human":
      return trf("問你:{q}", "Ask you: {q}", { q: short(a("question"), 80) });
    default:
      return l.text;
  }
}

/** Any other tool: what it did, short. The agents title their steps in English. */
function toolWords(l: Line): string {
  const command = arg(l.input, "command");
  if (l.tool === "execute") return bare(command || l.text.replace(/^Run\s+/, ""));
  return l.text
    .replace(/^Run\s+/, tr("執行 ", "Run "))
    .replace(/^Edit\s+/, tr("編輯 ", "Edit "))
    .replace(/^Read\s+/, tr("讀取 ", "Read "))
    .replace(/^Search the web$/, tr("搜尋網路", "Search the web"))
    .replace(/^Sub-agent\s+(.*)$/, tr("子代理 $1 分頭處理", "Sub-agent $1"))
    .replace(/^Generate an image$/, tr("生成圖片", "Generate an image"));
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

/** What a member heard at the start of a turn (Coucou tells members in English), in the window's words. */
export function heardWords(text: string): string {
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^The team has started\./, () => tr("團隊開始了:規劃工作並建立任務", "The team has started: plan the work and create tasks")],
    [/^(TASK-\d+) is yours and ready to start: (.+)/, (m) => trf("{task}「{title}」交給你了", "{task} “{title}” is yours", { task: m[1], title: m[2] })],
    [/^(.+?) handed in (TASK-\d+) \((.+?)\), which is meant for you/, (m) => trf("{who} 交付了 {task}「{title}」給你", "{who} handed in {task} “{title}” for you", { who: m[1], task: m[2], title: m[3] })],
    [/^(.+?) handed in (TASK-\d+) \((.+?)\)/, (m) => trf("{who} 交付了 {task}「{title}」,請驗收", "{who} handed in {task} “{title}”: please review it", { who: m[1], task: m[2], title: m[3] })],
    [/^(.+?) sent (TASK-\d+) \((.+?)\) back: (.+)/, (m) => trf("{who} 退回了 {task}「{title}」:{why}", "{who} sent {task} “{title}” back: {why}", { who: m[1], task: m[2], title: m[3], why: m[4] })],
    [/^No task exists yet/, () => tr("還沒有任務,請馬上建立", "No task yet: create them now")],
    [/^You ended your turn, but this is still open/, () => tr("提醒:手上的工作還沒回報", "Reminder: your open work isn't reported yet")],
    [/^You were restarted/, () => tr("你被重新啟動了", "You were restarted")],
    [/^(?:Coucou|Agent Center) was closed while the team was working/, () => tr("Agent Center 重新開啟了,從中斷的地方接著做", "Agent Center reopened: carry on where you left off")],
    [/^Every task has been accepted\./, () => tr("全部驗收完成,請寫最終報告", "Everything is accepted: write the final report")],
    [/^You asked: [\s\S]*?\nThe user answers: ([\s\S]+)/, (m) => trf("你的回覆:{answer}", "Your answer: {answer}", { answer: m[1] })],
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
        const el = h("div", { class: "line turn" }, h("span", { class: "rule", text: trf("第 {n} 回合", "Turn {n}", { n: l.text }) }));
        for (const x of heard.slice(-4)) {
          el.append(
            h(
              "div",
              { class: "heard", style: `--from:${colorOf(snap, x.from)}` },
              h("b", { text: x.from === SYSTEM ? "Agent Center" : nameOf(snap, x.from) }),
              short(heardWords(x.text), 160),
            ),
          );
        }
        return el;
      }
      if (l.status === "failed") return h("div", { class: "line turn failed" }, h("span", { class: "rule", text: tr("回合失敗", "Turn failed") }), h("div", { class: "why", text: said(l.output) })); // i18n-ok: CSS classes
      return h("div", { class: "line turn end" }, h("span", { class: "rule", text: tr("回合結束", "Turn ended") })); // i18n-ok: CSS classes
    }
    case "say":
      return h("div", { class: "line say" }, h("p", { text: l.text.trim() }));
    case "think":
      return h("div", { class: "line think", text: `${tr("思考", "Thinking")} · ${tailOf(l.text, 220)}` });
    case "tool": {
      const team = !!l.teamTool;
      const mark = l.status === "running" ? h("i", { class: "spin", "aria-label": tr("進行中", "Running") }) : h("i", { class: "mark", text: l.status === "failed" ? "✕" : "✓" });
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
    d.pics.clear();
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
    pics: new Map(),
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
  if (snap) pictures(snap.id, d, l, el);
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

/** Every string in a tool's input: where a file went is often only there. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/**
 * The pictures a line names, under it: what the member wrote, a tool that
 * wrote, copied or read a picture, what it handed in. A picture named again
 * by a later line moves there, so the screen shows each once, where it was
 * last spoken of.
 */
function pictures(team: string, d: Desk, l: Line, el: HTMLElement) {
  if (l.kind !== "say" && !(l.kind === "tool" && l.status === "done")) return;
  const named = imagePaths([l.text, ...(l.kind === "tool" ? strings(l.input) : [])].join("\n"));
  const mine = named.filter((p) => {
    const was = d.pics.get(picKey(p));
    return !was || was.n <= l.n;
  });
  if (!mine.length) return;
  const row = thumbRow(team, mine);
  if (!row) return;
  for (const p of mine) {
    const key = picKey(p);
    const was = d.pics.get(key);
    if (was && was.n < l.n) {
      was.row.querySelector(`[data-pic="${CSS.escape(key)}"]`)?.remove();
      if (!was.row.querySelector(".pic")) was.row.remove();
    }
    d.pics.set(key, { n: l.n, row });
  }
  el.append(row);
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
      return trf("我失聯了:{why}", "I lost contact: {why}", { why: said(m.lostWhy) });
    case "waitingYou": {
      if (m.permission) {
        const raw = m.permission.rawInput && typeof m.permission.rawInput === "object" ? (m.permission.rawInput as Record<string, unknown>) : {};
        const more = m.morePermissions.length ? trf("(還有 {n} 個)", " ({n} more)", { n: m.morePermissions.length }) : "";
        return trf("等你批准{more}:{what}", "Waiting for you to approve{more}: {what}", { more, what: short(typeof raw.command === "string" ? bare(raw.command) : m.permission.title, 90) });
      }
      const q = snap.questions.find((x) => x.by === m.id && x.answer === null);
      return q ? trf("想問你:{q}", "I have a question: {q}", { q: short(q.question, 90) }) : tr("等你回覆", "Waiting for your answer");
    }
    case "waitingDelivery":
      return m.waiting ? trf("等 {who} 交付「{what}」", "Waiting for {who} to deliver “{what}”", { who: nameOf(snap, m.waiting.on), what: m.waiting.what }) : tr("等隊友交付", "Waiting for a teammate to deliver");
    case "waitingReply":
      return m.waiting ? trf("等 {who} 回覆:{what}", "Waiting for {who} to reply: {what}", { who: nameOf(snap, m.waiting.on), what: short(m.waiting.what, 60) }) : tr("等隊友回覆", "Waiting for a teammate to reply");
    case "done":
      return snap.status === "finished" ? tr("收工!", "All done!") : tr("我的工作都交付了", "All my work is delivered");
    case "idle":
      return snap.status === "finished" ? (snap.ended ? tr("團隊已結束", "The team has ended") : tr("收工!", "All done!")) : snap.status === "paused" ? tr("團隊暫停中", "The team is paused") : tr("待命中,等下一個任務", "Standing by for the next task");
    case "working": {
      const last = d.lines.get(Math.max(0, ...d.lines.keys()));
      if (!last) return tr("開工了…", "Getting started…");
      if (last.kind === "say") return tailOf(last.text, 110) || "…";
      if (last.kind === "think") return tr("思考中…", "Thinking…");
      if (last.kind === "tool") return last.teamTool ? teamWords(snap, last) : `${last.tool === "execute" ? tr("執行 ", "Run ") : ""}${short(toolWords(last), 90)}`;
      return tr("開工了…", "Getting started…");
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
  if (!d.rows.size && !d.screen.firstChild) d.screen.append(quietLine());
  return { avatar: d.avatar, bubble: d.bubble, screen: d.screen, pulse: d.pulse };
}

function quietLine(): HTMLElement {
  return h("div", { class: "line quiet", text: tr("還沒有動靜。輪到這位成員時,它說的話、跑的指令和結果都會即時出現在這裡。", "Nothing yet. When it is this member's turn, what it says, the commands it runs and their results appear here as they happen.") });
}

/**
 * The language changed: the screens keep their lines as drawn, so each is
 * drawn again from what it said (where it was scrolled to stays), and so are
 * the bubbles and the signs of life.
 */
onLangChange(() => {
  for (const d of desks.values()) {
    const snap = snaps.get(d.team);
    const lines = [...d.lines.values()].sort((a, b) => a.n - b.n);
    clear(d.screen);
    d.lines.clear();
    d.rows.clear();
    d.pics.clear();
    for (const l of lines) put(snap, d, l);
    if (!d.rows.size) d.screen.append(quietLine());
    const m = snap?.members.find((x) => x.id === d.member);
    if (snap && m) refresh(snap, m);
    stick(d);
  }
  signs();
});

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
  if (s < 60) return trf("{n} 秒", "{n}s", { n: s });
  const m = Math.floor(s / 60);
  return m < 60 ? trf("{n} 分鐘", "{n} min", { n: m }) : trf("{h} 小時 {m} 分", "{h} h {m} min", { h: Math.floor(m / 60), m: m % 60 });
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
      const on = running ? trf(",停在「{what}」{for}", ", on “{what}” for {for}", { what: short(running.teamTool ? teamWords(snap, running) : toolWords(running), 40), for: ago(now - running.since) }) : "";
      text = quiet ? trf("⚠ 已經 {ago}沒有動靜{on}", "⚠ No sign of life for {ago}{on}", { ago: ago(now - last), on }) : now - last < 15_000 ? tr("● 正在動", "● Active now") : trf("● {ago}前有動靜{on}", "● Active {ago} ago{on}", { ago: ago(now - last), on });
    } else if (last) {
      text = trf("上次動靜:{ago}前", "Last active {ago} ago", { ago: ago(now - last) });
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
  task: String.fromCharCode(0xff0b), // a full-width plus: a glyph, not a word
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
  const label = f.kind === "message" || f.kind === "answered" ? short(f.text, 16) : f.kind === "accepted" ? tr("驗收", "Accepted") : f.kind === "rejected" ? tr("退回", "Sent back") : short(task?.title ?? f.text, 14);

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
