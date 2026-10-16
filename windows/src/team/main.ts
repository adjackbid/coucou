// The Teamwork window: which teams there are, how each is set up, and — for
// the one running — who is doing what, who waits on whom and what has been
// handed in.
//
// What the monitor shows comes whole from the team's snapshot as the
// orchestrator sends it (`team-changed`); this page keeps nothing of its own
// beyond what is being typed. The screen is drawn again on every change,
// which is cheap at this size and leaves nothing to fall out of step — except
// the live pieces (live.ts): each member's Mochi, bubble and screen, which
// stream between pictures (`team-screen`) and are moved into each new one.

import { onLangChange, setLang, tr, trf } from "../core/i18n";
import "./team.css";
import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import type { AgentProfile, ModelChoice } from "../core/state";
import { h, clear } from "../views/dom";
import * as live from "./live";
import { dropdown, menuOpen, onMenuClosed, refreshSuggestions, suggest } from "./ui";
import { linksScreen, logScreen, openThread, type Page } from "./screens";
import { companyName, Office, setCompanyName } from "./office/office";
import { LARGE_FROM, THEME_LABELS } from "./office/scene";
import { savedWorld, saveWorld, WORLD_IDS, WORLDS } from "./office/battle/worlds";
import { ambientMotion, battleTempo, saveAmbientMotion, saveBattleTempo, saveCompanyFps, type Tempo } from "./office/battle/session";
import { costPage, fmtMoney, fmtTokens, refreshSoon, usageSummary, type CostHost } from "./cost";
import { MAX_INSTRUCTIONS, onStep as secretaryStep, secretaryAttachFiles, secretaryInstructions, secretaryName, secretaryPage, secretaryTitle, setSecretaryDragging, setSecretaryInstructions, setSecretaryName, type SecretaryHost } from "./secretary";
import { constitutionPage } from "./constitution";
import { isImage, openImage, thumbImg, thumbsFor } from "./images";
import { agentLabel, agentsPage, baseOf, loadTeamAgents, memberChoices, teamAgentCounts, teamAgents, teamProfiles, type AgentsHost } from "./agents";
import { addFiles as addKnowledgeFiles, dropTarget, knowledgeChanged, knowledgePanel, setDragging, type KnowledgeHost } from "./knowledge";
import type { Danger, Deliverable, FeedItem, MemberStatus, MemberView, ScreenPatch, SecretaryStep, Snapshot, Task, TeamConfig, TeamFile } from "./types";

const root = document.getElementById("team-root")!;

/**
 * 玻璃濃度 (0–100): how dark a sheet lies over the system's blur. Windows
 * draws the blur itself and its radius cannot be set; how much of the
 * desktop shows through it can. Windows 11's acrylic is tinted already, so
 * it starts bare; Windows 10's classic blur is not, so it starts at half.
 */
const WIN10 = !!(window as unknown as { __coucouWin10?: boolean }).__coucouWin10;
const SHEET_DEFAULT = WIN10 ? 50 : 0;
function sheet(): number {
  try {
    const v = Number(localStorage.getItem("coucou.window.sheet"));
    if (localStorage.getItem("coucou.window.sheet") !== null && Number.isFinite(v)) return Math.max(0, Math.min(100, v));
  } catch {
    /* the default */
  }
  return SHEET_DEFAULT;
}
function applySheet(value = sheet()) {
  document.documentElement.classList.toggle("win10", WIN10);
  document.documentElement.style.setProperty("--sheet", String(value / 100));
}
function saveSheet(value: number) {
  try {
    localStorage.setItem("coucou.window.sheet", String(value));
  } catch {
    /* this session only */
  }
}
applySheet();

let dir = "";
let files: TeamFile[] = [];
/** The agents of Settings → Agents: what a member can run as. */
let agents: AgentProfile[] = [];
/** The latest snapshot of each team, by team id. */
const runs = new Map<string, Snapshot>();
/** The team file being looked at, and which of its screens. */
let selected: string | null = null;
let tab: "setup" | "links" | "monitor" | "log" = "setup";
/** 檢查代理 results, while the setup tab shows them. */
let doctor: import("../core/state").AgentCheck[] | "running" | string | null = null;
/** The little gear beside Agent Center or 公司總覽: which panel is open, and where. */
let sidePop: { which: "secretary" | "company"; top: number } | null = null;
/** The monitor as a board, or as the team's office. */
let monitorMode: "board" | "office" = "board";
/** The company map instead of one team; or the office of a team that has no file here (示範資料). */
let place: "team" | "company" | "office" | "cost" | "secretary" | "law" | "agents" = "team";
/** The place the window showed when it was last drawn: a page can tell being entered from being redrawn. */
let drawnPlace: string | null = null;
let officeTeam: string | null = null;
/** The form's working copy of the selected team; saved on request. */
let editing: TeamConfig | null = null;
let unsaved = false;
/** The last thing that went wrong, shown until the next action. */
let trouble = "";
/** Who the instruction box writes to: "" is the leader. */
let recipient = "";
/** What is typed in each field, so drawing again does not lose it. */
const drafts = new Map<string, string>();
/** The models each agent offers, asked once per window: agent id → list (or why not). */
const modelLists = new Map<string, ModelChoice[] | string>();
/** The team file whose delete button has been pressed once. */
let confirming: string | null = null;
/** Each agent's own folder (agent id, path); asked once. */
let agentFolders: [string, string][] | null = null;
/** Members whose 進階設定 is open, by id. */
const advancedOpen = new Set<string>();
/** The members panel's help, opened by its ? button. */
let memberHelp = false;
/** The sidebar's 已封存 section, open or not. */
let showArchived = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("archived") === "open";
const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const ICON_ARCHIVE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/></svg>';
const ICON_UNARCHIVE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M12 18v-6M9.5 14.5 12 12l2.5 2.5"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

/** The member whose screen is shown large; null for everyone side by side. */
let focused: string | null = null;

/** A file going out with the next instruction: already in the team's folder. */
interface Attachment {
  path: string;
  name: string;
  /** A thumbnail, for an image whose bytes the page had. */
  preview: string | null;
}
/** What the next instruction carries, per team. */
const attachments = new Map<string, Attachment[]>();
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

async function attach(team: string, add: () => Promise<Attachment>) {
  await act(async () => {
    const a = await add();
    attachments.set(team, [...(attachments.get(team) ?? []), a]);
  });
}

function attachBlob(team: string, file: File) {
  const name = file.name || `pasted-${Date.now()}.png`;
  void attach(team, async () => ({ path: await Bridge.teamAttachBytes(team, name, await file.arrayBuffer()), name, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null }));
}

const YOU = "you";
/** Coucou's own accents, for members that were given no colour. */
const PALETTE = ["#3B9EFF", "#34D399", "#A78BFA", "#F5A524", "#F472B6", "#22D3EE"];

/** A member's state in words, in the language of the moment. */
function memberStatus(): Record<MemberStatus, { label: string; mark: string }> {
  return {
    working: { label: tr("工作中", "Working"), mark: "◔" },
    waitingDelivery: { label: tr("等待交付", "Waiting for a handoff"), mark: "⧖" },
    waitingReply: { label: tr("等待回覆", "Waiting for a reply"), mark: "…" },
    waitingYou: { label: tr("等你處理", "Needs you"), mark: "!" },
    idle: { label: tr("待命", "Idle"), mark: "○" },
    done: { label: tr("已完成", "Done"), mark: "✓" },
    lost: { label: tr("失聯", "Disconnected"), mark: "×" },
  };
}

function teamStatusLabels(): Record<Snapshot["status"], string> {
  return {
    idle: tr("尚未啟動", "Not started"),
    running: tr("執行中", "Running"),
    paused: tr("已暫停", "Paused"),
    finished: tr("已完成", "Finished"),
  };
}

/** A team's state in words: one the person ended reads as such, not as done. */
function teamStatus(snap: Snapshot): string {
  return snap.status === "finished" && snap.ended ? tr("已結束", "Ended") : teamStatusLabels()[snap.status];
}

/** "、" between names in Chinese, ", " in English. */
function joinNames(names: string[]): string {
  return names.join(tr("、", ", "));
}

/** "3 位 AI 成員" / "3 AI members". */
function aiMembers(n: number): string {
  return n === 1 ? tr("1 位 AI 成員", "1 AI member") : trf("{n} 位 AI 成員", "{n} AI members", { n });
}

/** The team whose 結束團隊 has been pressed once, and until when it waits for the second press. */
let ending: { team: string; until: number } | null = null;

/** 結束團隊: pressed twice, since what is under way is cut short. */
function endButton(snap: Snapshot): HTMLElement {
  const armed = ending?.team === snap.id && ending.until > Date.now();
  return h(
    "button",
    {
      class: `btn ${armed ? "danger" : "plain"} end-team`,
      type: "button",
      title: tr(
        "結束這個團隊:正在做的這一輪會被打斷,所有成員的代理都會停掉,未完成的任務就停在現在的樣子。做好的檔案都留著;之後再傳指示,團隊會重新開工。",
        "End this team: the turn under way is cut short, every member's agent stops, and unfinished tasks stay as they are now. Finished files are kept; send a new instruction later and the team gets back to work.",
      ),
      onClick: () => {
        if (!armed) {
          ending = { team: snap.id, until: Date.now() + 5000 };
          render();
          window.setTimeout(() => {
            if (ending?.team === snap.id && ending.until <= Date.now()) {
              ending = null;
              render();
            }
          }, 5100);
          return;
        }
        ending = null;
        void act(() => Bridge.teamEnd(snap.id));
      },
    },
    armed ? tr("確定結束?再按一次", "End it? Press again") : tr("結束團隊", "End team"),
  );
}

/** Why a step waits for approval, after "Needs your approval:". */
function dangerLabel(d: Danger): string {
  const labels: Record<Danger, string> = {
    "deletes-folder": tr("會刪除資料夾", "it deletes a folder"),
    "deletes-many": tr("會一次刪除多個檔案", "it deletes several files at once"),
    installs: tr("會安裝套件或程式", "it installs packages or programs"),
    downloads: tr("會從網路下載東西", "it downloads something from the internet"),
    "destructive-git": tr("這個 git 指令會丟掉變更", "this git command throws away changes"),
    "sends-out": tr("會對外發送或發布", "it sends or publishes something outside"),
    "outside-work-dir": tr("會動到工作資料夾以外的地方", "it touches things outside the work folder"),
    system: tr("會變更系統或其他程序", "it changes the system or other programs"),
    opaque: tr("無法判讀這個指令在做什麼", "there's no telling what this command does"),
  };
  return labels[d];
}

function priorityLabel(p: Task["priority"]): string {
  return p === "high" ? tr("高", "High") : p === "medium" ? tr("中", "Medium") : tr("低", "Low");
}

// ── Small pieces ──────────────────────────────────────────────────────────────

/**
 * The orchestrator's own sentences, in the window's language. Anything else —
 * an agent's error message, say — is shown as it came.
 */
function said(text: string): string {
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^It ended two turns in a row without a word about its open work\.$/, () => tr("連續兩輪結束時都沒有回報手上的工作", "Ended two turns in a row without a word about its open work")],
    [/^Paused by the user\.$/, () => tr("由你暫停", "Paused by you")],
    [/^Ended by the user\.$/, () => tr("由你結束,未完成的任務停在原處", "Ended by you; unfinished tasks stay where they are")],
    [
      /^(.+) reached its limit: (.+?)\.( Raise the limit in the team's setup and save, then resume\.)?$/,
      (m) =>
        trf("{who} 已達用量上限({limit}),團隊先暫停。{then}", "{who} reached its limit ({limit}), so the team paused. {then}", {
          who: m[1],
          limit: m[2],
          then: m[3]
            ? tr("請先到團隊設定提高上限並儲存,再按繼續。", "Raise the limit in the team's setup and save first, then press Continue.")
            : tr("到團隊設定提高上限並儲存後,可以按繼續。", "Once you raise the limit in the team's setup and save, you can press Continue."),
        }),
    ],
    [/^The team has used its (\d+) turns\.$/, (m) => trf("已用完 {n} 回合的上限", "Used up its limit of {n} turns", { n: m[1] })],
    [/^(TASK-\d+) was sent back (\d+) times\.$/, (m) => trf("{task} 已被退回 {n} 次", "{task} was sent back {n} times", { task: m[1], n: m[2] })],
    [/^(?:Coucou|Agent Center) was closed while the team was running\.$/, () => tr("團隊執行中時 Agent Center 被關閉", "Agent Center was closed while the team was running")],
    [/^interrupted$/, () => tr("被中斷", "Interrupted")],
    // Why a team cannot start.
    [/^The work folder (.+) does not exist\.$/, (m) => trf("工作資料夾 {p} 不存在", "The work folder {p} doesn't exist", { p: m[1] })],
    [/^The work folder must be a full path\.$/, () => tr("還沒有選擇工作資料夾", "No work folder chosen yet")],
    [
      /^(.+) runs as agent '(.*)', which is not in Settings → Agents( or Teamwork → Agent Pool)?\.$/,
      (m) =>
        trf("{who} 還沒有選擇代理{why}", "{who} has no agent yet{why}", {
          who: m[1],
          why: m[2] ? trf("(「{id}」不在 設定 → Agents 或 Agent Pool 裡)", " (\"{id}\" isn't in Settings → Agents or Agent Pool)", { id: m[2] }) : "",
        }),
    ],
    [/^The leader '(.+)' is not a member\.$/, (m) => trf("Leader「{id}」不是團隊成員", "The Leader \"{id}\" isn't a member of the team", { id: m[1] })],
    [/^The team has no goal\.$/, () => tr("還沒有填寫任務描述", "No task description yet")],
    [/^The team has no members\.$/, () => tr("團隊沒有成員", "The team has no members")],
    [/^Two members are called '(.+)'\.$/, (m) => trf("有兩位成員的 id 都是「{id}」", "Two members both have the id \"{id}\"", { id: m[1] })],
    [/^'(.+)' cannot be a member id\.$/, (m) => trf("「{id}」不能當成員 id", "\"{id}\" can't be a member id", { id: m[1] })],
    [/^The team id may only use letters, digits, '-' and '_'\.$/, () => tr("團隊 id 只能用英數字、- 與 _", "A team id may only use letters, digits, - and _")],
    [
      /^A link joins '(.+)' and '(.+)', and one of them is not a member\.$/,
      (m) => trf("協作關係連到「{a}」與「{b}」,其中一個不是成員", "A link joins \"{a}\" and \"{b}\", but one of them isn't a member", { a: m[1], b: m[2] }),
    ],
    [/^The team '(.+)' is already running\.$/, (m) => trf("團隊「{name}」已經在執行中", "The team \"{name}\" is already running", { name: m[1] })],
    [/^That is not a member of the team\.$/, () => tr("這不是團隊成員", "That isn't a member of the team")],
    [
      /^This team was loaded from an earlier run\. Press Continue to pick it up\.$/,
      () => tr("這是上次執行留下的紀錄:按上方「從中斷處繼續」,它會和其他成員一起重新啟動", "This is the record of an earlier run: press \"Resume where it stopped\" above and it restarts with the rest of the team"),
    ],
    [
      /^The team's record has no setup to pick up\.$/,
      () => tr("這份紀錄裡沒有團隊設定,沒辦法接著做;請到「團隊設定」重新開始", "This record has no team setup to pick up from; start again from Team setup"),
    ],
  ];
  for (const [pattern, to] of rules) {
    const m = text.match(pattern);
    if (m) return to(m);
  }
  // Agents' own errors, wherever they sit in what came back.
  const inside: [RegExp, (m: RegExpMatchArray) => string][] = [
    [
      /Claude Code is not signed in\./,
      () => tr("Claude Code 還沒登入:請在終端機執行 claude,輸入 /login 登入後,再按「重新啟動這位成員」", "Claude Code isn't signed in: run claude in a terminal, sign in with /login, then press \"Restart this member\""),
    ],
    [
      /The '(.+?)' model is not supported when using Codex with a ChatGPT account/,
      (m) => trf("Codex 的 ChatGPT 帳號不能用「{model}」模型,請在團隊設定替這位成員換一個模型", "Codex with a ChatGPT account can't use the \"{model}\" model; pick another model for this member in the team's setup", { model: m[1] }),
    ],
    [/user rejected MCP tool call/, () => tr("Codex 擋下了團隊工具的呼叫", "Codex blocked a call to the team tools")],
  ];
  for (const [pattern, to] of inside) {
    const m = text.match(pattern);
    if (m) return to(m);
  }
  return text;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function colorOf(team: { members: { id: string; color: string }[] }, id: string): string {
  const at = team.members.findIndex((m) => m.id === id);
  if (at < 0) return "#9398A1";
  return team.members[at].color || PALETTE[at % PALETTE.length];
}

function nameOf(snap: Snapshot, id: string): string {
  if (id === YOU) return tr("你", "You");
  if (id === "system") return "Agent Center";
  return snap.members.find((m) => m.id === id)?.name ?? id;
}

/** A member's face: a small Mochi in the member's colour. */
function blob(color: string, size = 28): HTMLElement {
  return h("i", { class: "blob", style: `--c:${color};--s:${size}px`, "aria-hidden": "true" });
}

function who(snap: Snapshot, id: string, size = 18): HTMLElement {
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

function select(file: string) {
  selected = file;
  place = "team";
  trouble = "";
  const picked = files.find((f) => f.file === file);
  editing = picked?.config ? structuredClone(picked.config) : null;
  unsaved = false;
  const run = picked?.config ? runs.get(picked.config.id) : undefined;
  tab = run && run.status !== "idle" ? "monitor" : "setup";
}

function sidebar(): HTMLElement {
  const list = h("div", { class: "team-list" });
  const row = (file: TeamFile, away: boolean): HTMLElement => {
    const run = file.config ? runs.get(file.config.id) : undefined;
    const busy = !!run && run.status !== "finished" && !run.detached;
    const state = run ? teamStatus(run) : file.problems.length ? tr("尚未設定完成", "Not fully set up") : tr("可以啟動", "Ready to start");
    const needsYou = run?.members.some((m) => m.status === "waitingYou" || m.status === "lost") ?? false;
    return (
      h(
        "div",
        { class: `team-row${file.file === selected && place === "team" ? " on" : ""}${away ? " away" : ""}` },
        h(
          "button",
          {
            class: `team-item${file.file === selected && place === "team" ? " on" : ""}`,
            type: "button",
            onClick: () => {
              select(file.file);
              render();
            },
          },
          h("span", { class: "team-item-name", text: file.config?.name || tr("未命名的團隊", "Untitled team") }),
          h("span", { class: `team-item-state${run?.status === "running" ? " live" : ""}${needsYou ? " you" : ""}`, text: needsYou ? trf("{state} · 等你", "{state} · needs you", { state }) : state }),
        ),
        h(
          "span",
          { class: "team-actions" },
          // Putting away keeps the file: the team leaves the list and the company map, nothing is lost.
          h("button", {
            class: "icon-btn",
            type: "button",
            title: away
              ? tr("取消封存:放回團隊清單和公司總覽", "Unarchive: put it back in the team list and the company overview")
              : busy
                ? tr("團隊執行中,先停下才能封存", "The team is running; stop it before archiving it")
                : tr("封存(不刪除):不再顯示在團隊清單和公司總覽,可以在「已封存」找回", "Archive (not delete): it leaves the team list and the company overview; you can find it again under Archived"),
            "aria-label": away ? tr("取消封存", "Unarchive") : tr("封存這個團隊", "Archive this team"),
            disabled: !away && busy,
            html: away ? ICON_UNARCHIVE : ICON_ARCHIVE,
            onClick: () =>
              void act(async () => {
                await Bridge.teamArchive(file.file, !away);
                await load();
              }),
          }),
          h("button", {
            class: "icon-btn",
            type: "button",
            title: tr("複製這個團隊", "Duplicate this team"),
            "aria-label": tr("複製這個團隊", "Duplicate this team"),
            html: ICON_COPY,
            onClick: () =>
              void act(async () => {
                const copy = await Bridge.teamDuplicate(file.file);
                await load();
                select(copy);
              }),
          }),
          // Deleting asks twice, right here: the first click arms it.
          confirming === file.file
            ? h("button", {
                class: "icon-btn armed",
                type: "button",
                title: tr("再按一次刪除(檔案會移到 .deleted,可以找回)", "Press again to delete (the file moves to .deleted, so you can get it back)"),
                onClick: () =>
                  void act(async () => {
                    confirming = null;
                    await Bridge.teamDelete(file.file);
                    if (selected === file.file) selected = null;
                    await load();
                  }),
              }, tr("刪除?", "Delete?"))
            : h("button", {
                class: "icon-btn",
                type: "button",
                title: busy ? tr("團隊執行中,先停下才能刪除", "The team is running; stop it before deleting it") : tr("刪除這個團隊", "Delete this team"),
                "aria-label": tr("刪除這個團隊", "Delete this team"),
                disabled: busy,
                html: ICON_TRASH,
                onClick: () => {
                  confirming = file.file;
                  render();
                  window.setTimeout(() => {
                    if (confirming === file.file) {
                      confirming = null;
                      render();
                    }
                  }, 4000);
                },
              }),
        ),
      )
    );
  };
  const inUse = files.filter((f) => !f.config?.archived);
  const away = files.filter((f) => f.config?.archived);
  for (const file of inUse) list.append(row(file, false));
  if (!inUse.length) list.append(h("p", { class: "hint", text: away.length ? tr("團隊都已封存。", "All teams are archived.") : tr("還沒有團隊。", "No teams yet.") }));
  // Teams put away: a quiet section at the end of the list, closed until asked for.
  if (away.length) {
    list.append(
      h(
        "button",
        { class: `archive-toggle${showArchived ? " on" : ""}`, type: "button", "aria-expanded": String(showArchived), onClick: () => ((showArchived = !showArchived), render()) },
        h("span", { html: ICON_ARCHIVE }),
        trf("已封存 {n}", "Archived {n}", { n: away.length }),
        h("i", { "aria-hidden": "true", text: showArchived ? "▾" : "▸" }),
      ),
    );
    if (showArchived) for (const file of away) list.append(row(file, true));
  }

  // A small gear on the row: the panel beside it holds the quieter settings.
  const gear = (which: "secretary" | "company", label: string) =>
    h("span", {
      class: "team-gear", role: "button", tabindex: "0", title: label, "aria-label": label,
      html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>',
      onClick: (e: Event) => {
        e.stopPropagation();
        const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
        // Agent Center's panel is the taller one (its instructions box).
        sidePop = sidePop?.which === which ? null : { which, top: Math.max(12, Math.min(at.top, window.innerHeight - (which === "secretary" ? 520 : 280))) };
        render();
      },
    });
  const pop = !sidePop
    ? null
    : h(
        "div",
        { class: "side-pop", role: "dialog", "aria-label": sidePop.which === "secretary" ? tr("Agent Center 設定", "Agent Center settings") : tr("公司設定", "Company settings"), style: `top:${sidePop.top}px` },
        h("div", { class: "side-pop-head" },
          h("b", { text: sidePop.which === "secretary" ? tr("Agent Center 設定", "Agent Center settings") : tr("公司設定", "Company settings") }),
          h("button", { class: "side-pop-close", type: "button", "aria-label": tr("關閉", "Close"), onClick: () => { sidePop = null; render(); } }, "✕")),
        sidePop.which === "secretary"
          ? h("div", { class: "side-pop-body" },
              h("label", { text: tr("顯示名稱", "Display name") }),
              h("input", {
                value: secretaryName(), placeholder: "Agent Center",
                onChange: (e: Event) => { setSecretaryName((e.target as HTMLInputElement).value); render(); },
              }),
              h("p", { class: "hint", text: tr("想叫它什麼都可以;改完馬上生效。", "Call it anything you like; the change applies right away.") }),
              h("label", { for: "sec-instructions", text: tr("自訂指示", "Your instructions") }),
              ...((count: HTMLElement) => [
                h("textarea", {
                  id: "sec-instructions",
                  class: "side-pop-text",
                  "data-key": "sec-instructions",
                  rows: "7",
                  maxlength: String(MAX_INSTRUCTIONS),
                  spellcheck: "false",
                  placeholder: tr("例如:\n開團隊預設 3 人。\n預算優先,便宜的模型夠用就用便宜的。\n回答先講結論,再列細節。", "e.g.\nNew teams have 3 members by default.\nBudget first: use cheaper models where they will do.\nLead with the answer, then the details."),
                  text: secretaryInstructions(),
                  // Kept as it is typed: the window may be drawn again before the box loses focus.
                  onInput: (e: Event) => {
                    setSecretaryInstructions((e.target as HTMLTextAreaElement).value);
                    count.textContent = `${secretaryInstructions().length} / ${MAX_INSTRUCTIONS}`;
                  },
                }),
                count,
              ])(h("span", { class: "side-pop-count", text: `${secretaryInstructions().length} / ${MAX_INSTRUCTIONS}` })),
              h("p", { class: "hint", text: tr("每次問 Agent Center 都會接在它的系統提示後面,下一個問題就生效。可以調它的做法、口吻和偏好;它還是不會不經你按確認就做事。", "Added after Agent Center's own system prompt each time you ask; it applies from your next question. Shape how it works, its tone and what it prefers; it still never acts without your click.") }),
              h("label", { text: tr("開團隊使用的 Agent", "Agents for new teams") }),
              h("p", { class: "hint" },
                tr("Agent Center 開團隊、你新增團隊成員時,只從 ", "When Agent Center starts a team or you add a member, agents come only from the team agents in "),
                h("button", { class: "link", type: "button", onClick: () => { sidePop = null; place = "agents"; render(); } }, "Agent Pool"),
                tr(" 裡的團隊 Agent(Cloud Agent 與 Local Agent)挑,Agent Center 會照每個 Agent 的說明選人。以前設定好、用原生 Agent 的團隊照樣能啟動。", " (Cloud Agents and Local Agents), and Agent Center picks each one by its description. Teams set up earlier with native agents still start.")))
          : h("div", { class: "side-pop-body" },
              h("label", { text: tr("公司名稱", "Company name") }),
              h("input", {
                value: companyName(), placeholder: tr("我的公司", "My company"),
                onChange: (e: Event) => { setCompanyName((e.target as HTMLInputElement).value); render(); },
              }),
              // 中二模式's own knobs, only while 設定 → 團隊與 Agent Center offers it at all.
              ...(office.battleAllowed ? [
              h("label", { text: tr("戰鬥動畫流暢度(戰鬥模式)", "Animation frame rate (Battle mode)") }),
              h("div", { class: "segmented" },
                ...[20, 30, 60].map((n) =>
                  h("button", {
                    type: "button", class: office.companyFps === n ? "on" : "",
                    onClick: () => { office.companyFps = n; saveCompanyFps(n); render(); },
                  }, `${n} FPS`))),
              h("p", { class: "hint", text: tr("公司總覽裡每間辦公室戰鬥動畫的更新頻率。團隊多的時候調低比較省效能,只有一兩個團隊時可以調高。", "How often each office's battle animation updates in the company overview. Turn it down when you have many teams, to save power; with one or two teams you can turn it up.") }),
              ] : []),
              h("label", { text: tr("玻璃濃度", "Glass opacity") }),
              (() => {
                const shown = h("b", { class: "sheet-value", text: `${sheet()}%` });
                const slider = h("input", {
                  type: "range", min: "0", max: "100", step: "1", value: String(sheet()), class: "sheet-slider",
                  "aria-label": tr("玻璃濃度", "Glass opacity"),
                  // Dragging previews at once — the window itself is the preview.
                  onInput: (e: Event) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    applySheet(v);
                    shown.textContent = `${v}%`;
                  },
                  onChange: (e: Event) => saveSheet(Number((e.target as HTMLInputElement).value)),
                }) as HTMLInputElement;
                const preset = (label: string, v: number) =>
                  h("button", { type: "button", onClick: () => { slider.value = String(v); applySheet(v); saveSheet(v); shown.textContent = `${v}%`; } }, label);
                return h("div", { class: "sheet-row" },
                  h("div", { class: "sheet-line" }, slider, shown),
                  h("div", { class: "segmented" }, preset(tr("玻璃", "Glass"), SHEET_DEFAULT), preset(tr("加深", "Darker"), 80), preset(tr("不透明", "Opaque"), 100)));
              })(),
              h("p", { class: "hint", text: tr("越低,模糊的桌面透出越多;越高越接近實色。模糊本身的強度由 Windows 決定,無法調整。拖動時視窗會即時變化。", "Lower lets more of the blurred desktop show through; higher gets closer to a solid color. Windows sets how strong the blur is, and that can't be changed. The window changes as you drag.") }),
              ...(office.battleAllowed ? [
              h("label", { text: tr("戰鬥節奏(戰鬥模式)", "Battle pace (Battle mode)") }),
              h("div", { class: "segmented" },
                ...([["calm", tr("平靜", "Calm")], ["normal", tr("一般", "Normal")], ["fierce", tr("激烈", "Fierce")]] as [Tempo, string][]).map(([v, label]) =>
                  h("button", { type: "button", class: battleTempo() === v ? "on" : "", onClick: () => { saveBattleTempo(v); render(); } }, label))),
              h("p", { class: "hint", text: tr("AI 在工作時,英雄多久出手試探一次、魔王多常反擊。只是演出:不扣血、不出卡片,HP 只看真實的任務驗收。", "While the AI works, how often the heroes probe and the boss strikes back. It's only a show: no HP lost, no cards; HP follows real task reviews only.") }),
              h("label", { class: "side-pop-check" },
                h("input", { type: "checkbox", checked: ambientMotion(), onChange: (e: Event) => { saveAmbientMotion((e.target as HTMLInputElement).checked); render(); } }),
                tr("場地微動(戰鬥模式)", "Ambient motion (Battle mode)")),
              h("p", { class: "hint", text: tr("戰場上的餘燼、雪花、落葉、電花、星塵。只是氣氛,減少動態時一律停止。", "Embers, snow, falling leaves, sparks and stardust on the battlefield. Just atmosphere; it always stops when motion is reduced.") }),
              ] : [])),
      );
  return h(
    "aside",
    { class: "sidebar pane" },
    h("div", { class: "brand", "data-drag": "" }, teamMark(30), h("span", { text: "Teamwork" })),
    pop,
    h(
      "button",
      {
        class: `team-item company${place === "secretary" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "secretary";
          render();
        },
      },
      h("span", { class: "team-item-name", text: secretaryName() }),
      h("span", { class: "team-item-state", text: tr("需要時叫我:查現況、開團隊", "Call me when you need me: check status, start teams") }),
      gear("secretary", tr("Agent Center 設定", "Agent Center settings")),
    ),
    h(
      "button",
      {
        class: `team-item company${place === "company" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "company";
          render();
        },
      },
      h("span", { class: "team-item-name", text: tr("公司總覽", "Company overview") }),
      h("span", { class: "team-item-state", text: office.demo ? tr("示範資料", "Demo data") : tr("所有團隊的辦公室", "Every team's office") }),
      gear("company", tr("公司設定", "Company settings")),
    ),
    h(
      "button",
      {
        class: `team-item company${place === "cost" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "cost";
          render();
        },
      },
      h("span", { class: "team-item-name", text: tr("成本與用量", "Cost & usage") }),
      h("span", { class: "team-item-state", text: tr("Token 用量與預估費用", "Token usage and estimated cost") }),
    ),
    h(
      "button",
      {
        class: `team-item company${place === "law" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "law";
          render();
        },
      },
      h("span", { class: "team-item-name", text: tr("憲法", "Constitution") }),
      h("span", { class: "team-item-state", text: tr("所有成員都要遵守的規則", "Rules every member follows") }),
    ),
    h(
      "button",
      {
        class: `team-item company${place === "agents" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "agents";
          render();
        },
      },
      h("span", { class: "team-item-name", text: "Agent Pool" }),
      h("span", { class: "team-item-state", text: ((c) => `Cloud ${c.cloud} · Local ${c.local}`)(teamAgentCounts(agents)) }), // i18n-ok: the same in both
    ),
    h("div", { class: "side-title", text: tr("團隊", "Teams") }),
    list,
    h(
      "div",
      { class: "side-foot" },
      button(tr("＋ 新增團隊", "＋ New team"), "plain", () =>
        void act(async () => {
          const file = await Bridge.teamNew();
          await load();
          select(file);
        }),
      ),
      h("button", { class: "link", type: "button", title: dir, onClick: () => void Bridge.teamOpenConfigs() }, tr("開啟團隊檔案的資料夾", "Open the team files folder")),
    ),
  );
}

/** Three small Mochis side by side: the Teamwork mark, as on the island. */
function teamMark(size: number): HTMLElement {
  const el = h("span", { class: "team-mark", style: `--s:${size}px`, "aria-hidden": "true" });
  el.append(blob("#34D399", size * 0.62), blob("#A78BFA", size * 0.78), blob("#F5A524", size * 0.62));
  return el;
}

// ── Team setup ────────────────────────────────────────────────────────────────

/**
 * Folders besides the work folder where safe steps also go without asking:
 * each member's own agent folder, and any the person adds. Nothing is
 * trusted until it is chosen here.
 */
function trustedFolders(config: TeamConfig): HTMLElement {
  if (agentFolders === null) {
    agentFolders = [];
    void (async () => {
      agentFolders = IS_TAURI
        ? ((await Bridge.teamAgentFolders()) ?? [])
        : [["copilot", "C:\\Users\\you\\.copilot\\session-state"], ["cg", "C:\\Users\\you\\.copilot\\session-state"], ["codex", "C:\\Users\\you\\.codex\\generated_images"], ["agy", "C:\\Users\\you\\.gemini\\antigravity\\brain"]];
      render();
    })();
  }
  const used = new Set(config.members.map((m) => m.agent));
  // One line a folder, with every agent of the team that keeps its files there.
  const byPath = new Map<string, string[]>();
  for (const [agent, path] of agentFolders ?? []) {
    if (used.has(agent)) byPath.set(path, [...(byPath.get(path) ?? []), allAgents().find((a) => a.id === agent)?.name ?? agent]);
  }
  const own = [...byPath.entries()].map(([path, who]) => [path, joinNames(who)] as const);
  const dirs = config.trustedDirs ?? [];
  const toggle = h("input", { type: "checkbox", checked: !!config.agentFolders, disabled: !own.length }) as HTMLInputElement;
  toggle.addEventListener("change", () => {
    config.agentFolders = toggle.checked || undefined;
    unsaved = true;
    render();
  });
  return h(
    "div",
    { class: "trusted" },
    h("label", { text: tr("也可以自動批准的資料夾", "Other folders that can be approved automatically") }),
    h(
      "label",
      { class: "trusted-check" },
      toggle,
      h(
        "span",
        {},
        h("b", { text: tr("代理自己的暫存資料夾", "The agents' own scratch folders") }),
        own.length
          ? h("span", { class: "trusted-paths" }, ...own.map(([path, who]) => h("span", {}, h("span", { class: "mono", text: path }), h("small", { text: ` · ${who}` }))))
          : h("span", { class: "hint", text: tr("這個團隊用到的代理沒有已知的暫存資料夾。", "The agents this team uses have no known scratch folders.") }),
      ),
    ),
    ...dirs.map((d, i) =>
      h(
        "div",
        { class: "trusted-dir" },
        h("span", { class: "mono", text: d }),
        h(
          "button",
          {
            class: "link",
            type: "button",
            onClick: () => {
              config.trustedDirs = dirs.filter((_, k) => k !== i);
              if (!config.trustedDirs.length) config.trustedDirs = undefined;
              unsaved = true;
              render();
            },
          },
          tr("移除", "Remove"),
        ),
      ),
    ),
    h(
      "div",
      { class: "row" },
      button(tr("新增資料夾…", "Add folder…"), "plain", () =>
        void act(async () => {
          const picked = await Bridge.pickFolder(config.workDir, tr("選擇也可以自動批准的資料夾", "Choose a folder that can also be approved automatically"));
          if (picked && !dirs.some((d) => d.toLowerCase() === picked.toLowerCase())) {
            config.trustedDirs = [...dirs, picked];
            unsaved = true;
          }
        }),
      ),
    ),
    h("p", {
      class: "hint",
      text: tr(
        "預設都不勾。勾選或加入的資料夾,會和工作資料夾一樣:改檔、建置不會問你;刪資料夾、安裝、對外發送仍然會問。改了以後,團隊下次啟動時生效。",
        "Nothing is checked by default. A folder you check or add is treated like the work folder: editing files and building won't ask you; deleting folders, installing and sending things out still will. Changes apply the next time the team starts.",
      ),
    }),
  );
}

/** What each field of a member means, for whoever sets a team up the first time. */
function memberHelpCard(): HTMLElement {
  const item = (term: string, text: string, example = "") =>
    h("div", { class: "help-item" }, h("dt", { text: term }), h("dd", {}, text, example ? h("span", { class: "help-eg", text: trf("例:{eg}", "e.g. {eg}", { eg: example }) }) : null));
  return h(
    "div",
    { class: "member-help", id: "member-help", role: "note" },
    h(
      "dl",
      {},
      item(tr("名稱", "Name"), tr("畫面上和隊友之間稱呼這位成員的名字。", "What this member is called on screen and by its teammates."), tr("AI 1、設計師", "AI 1, Designer")),
      item(
        tr("角色", "Role"),
        tr("2～6 個字的職稱。全隊都看得到,Leader 依它決定任務派給誰;工位和 Office 的標籤也顯示它。", "A job title of a word or two. The whole team sees it, the Leader decides who gets which task by it, and it labels the desk and the Office too."),
        tr("網站開發、圖片生成、測試", "Web dev, Image generation, Testing"),
      ),
      item(tr("代理", "Agent"), tr("這位成員用哪個 AI 工具工作。每位成員可以用不同的代理;要新增或修改代理,到「設定 → Agents」。", "Which AI tool this member works with. Each member can use a different agent; to add or change agents, go to Settings → Agents.")),
      item(tr("模型", "Model"), tr("留空就用代理自己的預設模型。也可以指定一個:點這一欄會列出這個代理提供的模型。", "Leave it empty to use the agent's own default model. Or pick one: click the field to list the models this agent offers.")),
      item(
        tr("職責", "Duty"),
        tr("一兩句只寫給這位成員的工作說明:負責什麼、交付什麼、不碰什麼。隊友看不到;空著也可以,它就只依角色和 Leader 派的任務做事。", "A sentence or two for this member alone: what it's responsible for, what it hands in, what it leaves alone. Teammates don't see it. It can stay empty; the member then works from its role and the tasks the Leader gives it."),
        tr("依需求產生商品圖,存到 public/images 交給網站開發;不改程式碼", "Make product images as asked, save them to public/images for the web developer; don't touch the code"),
      ),
      item("Leader", tr("每個團隊一位。負責把目標拆成任務、派給隊友、驗收成果,最後向你回報。建議交給能力較強的代理或模型。", "One per team. Splits the goal into tasks, hands them to teammates, reviews the results and reports back to you. Best given to a stronger agent or model.")),
      item(tr("移除", "Remove"), tr("至少要留一位成員。團隊已經在執行時,要加人請到「工作監控」按「＋ 加人手」。", "At least one member has to stay. To add someone while the team is running, press \"＋ More hands\" in Monitor.")),
    ),
    h("p", { class: "hint", text: tr("成員之間誰把成果交給誰、能不能直接對話,在「協作關係」設定。", "Who hands work to whom, and who may talk to whom directly, is set in Collaboration.") }),
  );
}

/**
 * A member's 進階設定: limits on what it may use in a run. Empty is no
 * limit (the default); past a limit the team pauses and the member's turn
 * is stopped, until the limit is raised (it holds at once, even mid-run).
 */
function advanced(config: TeamConfig, m: TeamConfig["members"][number], at: number): HTMLElement {
  const isOpen = advancedOpen.has(m.id);
  const limits = [m.maxTokens ? `${fmtTokens(m.maxTokens)} tokens` : "", m.maxCostUsd ? `$${m.maxCostUsd}` : ""].filter(Boolean);
  const toggle = h(
    "button",
    { class: "link member-adv-toggle", type: "button", "aria-expanded": String(isOpen), onClick: () => (isOpen ? advancedOpen.delete(m.id) : advancedOpen.add(m.id), render()) },
    `${isOpen ? "▾" : "▸"} ${tr("進階設定", "Advanced")}`,
    limits.length ? h("span", { class: "chip", text: trf("上限 {v}", "Limit {v}", { v: limits.join(" · ") }) }) : null,
  );
  if (!isOpen) return toggle;
  const number = (key: string, value: number | undefined, set: (v: number | undefined) => void, attrs: Record<string, string>) =>
    bound("input", `m${at}.${key}`, value ? String(value) : "", (v) => set(Number(v) > 0 ? Number(v) : undefined), { type: "number", min: "0", class: "field narrow member-limit", ...attrs }); // i18n-ok: CSS classes
  const used = runs.get(config.id)?.members.find((x) => x.id === m.id)?.usage ?? [];
  const now = used.length ? usageSummary(used, () => render()) : null;
  return h(
    "div",
    { class: "member-adv" },
    toggle,
    h(
      "div",
      { class: "member-adv-body" },
      h("label", { text: tr("這一輪最多用", "Most it may use this run") }),
      h("div", { class: "row nowrap" }, number("maxTokens", m.maxTokens, (v) => (m.maxTokens = v), { placeholder: tr("不限制", "No limit"), step: "100000" }), h("span", { class: "hint", text: tr("tokens(含快取)", "tokens (cache included)") })),
      h("label", { text: tr("費用上限", "Cost limit") }),
      h(
        "div",
        { class: "row nowrap" },
        h("span", { class: "hint", text: "US$" }), // i18n-ok: a currency sign
        number("maxCostUsd", m.maxCostUsd, (v) => (m.maxCostUsd = v), { placeholder: tr("不限制", "No limit"), step: "0.5" }),
        h("span", { class: "hint", text: tr("依「成本與用量」的價格表估算", "Estimated from the price list in Cost & usage") }),
      ),
      now
        ? h("p", {
            class: "hint",
            text: trf("這一輪目前已用 {tokens} tokens{usd}。", "Used so far this run: {tokens} tokens{usd}.", { tokens: fmtTokens(now.tokens), usd: now.usd != null ? ` · ${fmtMoney(now.usd)}` : "" }),
          })
        : null,
      h("p", {
        class: "hint",
        text: tr(
          "留空就不限制(預設)。到達上限時,團隊會先暫停並中斷這位成員正在做的這一輪;提高上限並儲存後就生效(執行中也是),再按「繼續」。",
          "Leave it empty for no limit (the default). At the limit, the team pauses and this member's turn under way is stopped. A raised limit holds once you save it (even mid-run); then press Continue.",
        ),
      }),
    ),
  );
}

/** An input bound to the form's working copy. Typing does not redraw. */
function bound<K extends "input" | "textarea">(tag: K, key: string, value: string, set: (v: string) => void, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const el = h(tag, { class: "field", "data-key": key, spellcheck: "false", ...attrs }) as HTMLInputElement | HTMLTextAreaElement;
  el.value = value;
  el.addEventListener("input", () => {
    set(el.value);
    touched();
  });
  return el as HTMLElementTagNameMap[K];
}

/** Something in the form changed: the save button says so, without a redraw. */
function touched() {
  unsaved = true;
  root.querySelector(".save")?.classList.add("due");
}

function nextMemberId(config: TeamConfig): string {
  for (let n = 1; ; n++) if (!config.members.some((m) => m.id === `ai${n}`)) return `ai${n}`;
}

/** A new member row in the form, to fill in. */
function addMember(config: TeamConfig) {
  const id = nextMemberId(config);
  // New members take a team agent; the first member leads, and an n8n node cannot.
  const pool = teamProfiles(agents);
  const first = config.members.length ? pool[0] : pool.find((p) => p.protocol !== "n8n");
  config.members.push({ id, name: `AI ${id.slice(2)}`, role: "", duty: "", agent: first?.id ?? "", color: "" });
  unsaved = true;
}

async function save(): Promise<boolean> {
  if (!selected || !editing) return false;
  await Bridge.teamSave(selected, editing);
  unsaved = false;
  // The file is read back, with whatever still stops it from starting.
  const listed = await Bridge.teamFiles();
  files = listed?.files ?? files;
  return true;
}

function setup(file: TeamFile): HTMLElement {
  const config = editing;
  if (!config) {
    return h("section", { class: "panel" }, h("h2", { text: file.file }), h("p", { class: "problem", text: file.problems.map(said).join("\n") }));
  }
  const run = runs.get(config.id);
  // Agents still behind it: the form waits for the next start. A record from
  // an earlier run, or a finished team, can be started again from scratch.
  const running = run?.status === "running" || (run?.status === "paused" && !run.detached);
  const again = !!run && !running;
  // Members added to the form while the team runs: they can join it now.
  const newcomers = running && run ? config.members.filter((m) => !run.members.some((x) => x.id === m.id)) : [];

  // ── Left: what the team is for ──
  const folder = bound("input", "workDir", config.workDir, (v) => (config.workDir = v), { placeholder: tr("選擇所有成員一起工作的資料夾", "Choose the folder every member works in") });
  const goal = h(
    "section",
    { class: "panel form" },
    h("h2", { text: tr("任務目標", "Goal") }),
    h("label", { text: tr("團隊名稱", "Team name") }),
    bound("input", "name", config.name, (v) => (config.name = v), { placeholder: tr("例如:購物網站團隊", "e.g. Online shop team") }),
    h("label", { text: tr("任務描述", "Task description") }),
    bound("textarea", "goal", config.goal, (v) => (config.goal = v), { rows: "5", placeholder: tr("要完成什麼、包含哪些功能、最後要交付什麼", "What to build, which features it has, what to hand in at the end") }),
    h("label", { text: tr("任務範圍(以逗號分隔)", "Scope (comma-separated)") }),
    // Read back with any of the separators, whichever language wrote it.
    bound("input", "scope", joinNames(config.scope), (v) => (config.scope = v.split(/[,,、]/).map((x) => x.trim()).filter(Boolean)), { placeholder: tr("商品目錄、購物車、會員登入", "Product catalog, cart, member login") }),
    h("label", { text: tr("工作資料夾", "Work folder") }),
    h(
      "div",
      { class: "row nowrap" },
      folder,
      button(tr("選擇資料夾…", "Choose folder…"), "plain", () =>
        void act(async () => {
          const picked = await Bridge.pickFolder(config.workDir, tr("選擇團隊的工作資料夾", "Choose the team's work folder"));
          if (picked) {
            config.workDir = picked;
            unsaved = true;
          }
        }),
      ),
    ),
    h("p", { class: "hint", text: tr("所有成員都在這個資料夾裡工作,交付的成果也放在這裡。", "Every member works in this folder, and what they hand in goes here too.") }),
    h("label", { text: tr("工作模式", "Work mode") }),
    h(
      "div",
      { class: "segmented" },
      h("button", { type: "button", class: config.autoApprove ? "on" : "", onClick: () => ((config.autoApprove = true), (unsaved = true), render()) }, tr("自主協作", "Autonomous mode")),
      h("button", { type: "button", class: config.autoApprove ? "" : "on", onClick: () => ((config.autoApprove = false), (unsaved = true), render()) }, tr("逐步確認", "Confirm each step")),
    ),
    h("p", {
      class: "hint",
      text: config.autoApprove
        ? tr("成員改檔、建置、跑測試不會問你;刪資料夾、安裝東西、對外發送等危險動作仍然會問。", "Members edit files, build and run tests without asking you; risky steps such as deleting folders, installing things or sending things out still ask.")
        : tr("成員的每一個權限請求都會問你。", "You're asked about every permission request a member makes."),
    }),
    config.autoApprove ? trustedFolders(config) : null,
    h("label", { text: tr("辦公室風格", "Office style") }),
    h(
      "div",
      { class: "segmented wrap" },
      ...[["", tr("自動", "Auto")], ...Object.entries(THEME_LABELS)].map(([key, label]) =>
        h("button", { type: "button", class: (config.officeTheme ?? "") === key ? "on" : "", onClick: () => ((config.officeTheme = key || undefined), (unsaved = true), render()) }, label),
      ),
    ),
    h("p", {
      class: "hint",
      text: trf(
        "Office 檢視裡這個團隊的辦公室長什麼樣子。自動:{n} 位成員以上用高級辦公室(在公司總覽佔較大的格子),其他依團隊固定挑一種。",
        "What this team's office looks like in the Office view. Auto: teams of {n} or more members get the deluxe office (a bigger tile in the company overview); every other team keeps one style picked for it.",
        { n: LARGE_FROM },
      ),
    }),
    // The battlefield is only a choice while 設定 → 團隊與 Agent Center offers 中二模式 at all.
    ...(office.battleAllowed ? [
    h("label", { text: tr("戰鬥模式戰場", "Battle mode arena") }),
    h(
      "div",
      { class: "segmented wrap" },
      ...WORLD_IDS.map((id) =>
        h("button", { type: "button", class: savedWorld(config.id) === id ? "on" : "", title: WORLDS[id].label, onClick: () => { saveWorld(config.id, id); office.worldChanged(config.id); } }, WORLDS[id].label),
      ),
    ),
    h("p", { class: "hint", text: tr("戰鬥模式下這個團隊在哪個場地討伐哪隻魔王。只改變畫面,不影響工作、任務或 HP;改了馬上生效,不用儲存。", "Where this team fights which boss in Battle mode. It only changes the picture, not the work, the tasks or HP; it applies right away, no need to save.") }),
    ] : []),
    h("label", { text: tr("回合上限", "Turn limit") }),
    h("div", { class: "row nowrap" }, bound("input", "maxTurns", String(config.maxTurns), (v) => (config.maxTurns = Math.max(1, Math.min(500, Number(v) || 60))), { type: "number", min: "1", max: "500", class: "field narrow" }), h("span", { class: "hint", text: tr("整個團隊用完這麼多回合後會暫停,等你決定要不要繼續。", "Once the whole team has used this many turns, it pauses until you decide whether to go on.") })),
  );

  // ── Right: who is in it ──
  const members = h("div", { class: "member-rows" });
  config.members.forEach((m, at) => {
    const isLeader = config.leader === m.id;
    // Members are chosen from the team agents, Cloud then Local; a native
    // agent set up earlier stays on the list (memberChoices).
    const hintOf = (a: AgentProfile) => {
      const own = teamAgents().find((t) => t.id === a.id);
      return own ? trf("基底 {base}", "based on {base}", { base: agents.find((n) => n.id === own.base)?.name ?? own.base }) : undefined;
    };
    const agentChoices = memberChoices(agents, m.agent, isLeader, hintOf);
    if (m.agent && !agentChoices.some((c) => c.value === m.agent)) {
      agentChoices.unshift({ value: m.agent, label: trf("{id}(不存在)", "{id} (missing)", { id: m.agent }), hint: tr("不在 設定 → Agents 或 Agent Pool 裡", "Not in Settings → Agents or Agent Pool") });
    }
    const agent = dropdown({
      value: m.agent,
      choices: agentChoices,
      placeholder: tr("選擇代理…", "Choose an agent…"),
      title: tr("這位成員用哪個代理執行", "Which agent this member runs as"),
      onChange: (v) => {
        m.agent = v;
        unsaved = true;
        render();
      },
    });
    const profile = allAgents().find((a) => a.id === m.agent);
    const nodeLeads = isLeader && profile?.protocol === "n8n";
    // A team agent offers its base's models: asked of the base, with the base's key.
    const lister = baseOf(m.agent, agents);
    const known = lister ? modelLists.get(lister.id) : undefined;
    const model = bound("input", `m${at}.model`, m.model ?? "", (v) => (m.model = v.trim()), {
      placeholder: profile?.model ? trf("模型:{model}(代理預設)", "Model: {model} (agent default)", { model: profile.model }) : tr("模型:代理預設", "Model: agent default"),
      title: typeof known === "string" ? known : tr("留空就用代理自己的預設模型", "Leave it empty to use the agent's own default model"),
      autocomplete: "off",
    });
    suggest(model, () => {
      const got = lister ? modelLists.get(lister.id) : tr("這個代理不在 設定 → Agents 裡", "This agent isn't in Settings → Agents");
      if (got === undefined) return tr("讀取這個代理提供的模型…", "Reading the models this agent offers…");
      return Array.isArray(got) ? got.map((c) => ({ value: c.id, label: c.id, hint: c.label !== c.id ? c.label : undefined })) : got;
    });
    // The list is asked for the first time the field is used: a handshake
    // with the agent, nothing spent.
    model.addEventListener("focus", () => {
      if (!lister || modelLists.has(lister.id)) return;
      modelLists.set(lister.id, tr("載入中…", "Loading…"));
      Bridge.agentModels(lister)
        .then((found) => modelLists.set(lister.id, found))
        .catch((err) => modelLists.set(lister.id, String(err).replace(/^Error:\s*/, "")))
        .finally(() => refreshSuggestions(model));
    });
    members.append(
      h(
        "div",
        { class: `member-row${isLeader ? " leader" : ""}` },
        blob(colorOf(config, m.id), 34),
        h(
          "div",
          { class: "member-fields" },
          h(
            "div",
            { class: "row nowrap" },
            bound("input", `m${at}.name`, m.name, (v) => (m.name = v), { placeholder: tr("名稱", "Name"), class: "field name" }),
            bound("input", `m${at}.role`, m.role, (v) => (m.role = v), { placeholder: tr("角色,例如:網站開發", "Role, e.g. Web dev"), title: tr("全隊看得到的短職稱,Leader 依它派工", "A short title the whole team sees; the Leader assigns work by it") }),
            agent,
          ),
          h("div", { class: "row nowrap" }, model),
          nodeLeads ? h("p", { class: "problem", text: tr("n8n 節點不能當 Leader:請把 Leader 換給別的成員,或替這位成員換一個 Agent。", "An n8n node cannot lead: make another member the Leader, or give this member another agent.") }) : null,
          bound("input", `m${at}.duty`, m.duty, (v) => (m.duty = v), {
            placeholder: tr("職責:這位成員負責什麼、交付什麼(只給它自己看)", "Duty: what this member is responsible for and hands in (only it sees this)"),
            title: tr("只寫給這位成員的工作說明", "Work notes for this member alone"),
          }),
          advanced(config, m, at),
        ),
        h(
          "div",
          { class: "member-side" },
          h(
            "button",
            { type: "button", class: `chip pick${isLeader ? " leader" : ""}`, title: tr("Leader 負責拆解需求、指派任務與審核成果", "The Leader breaks the request down, assigns tasks and reviews the results"), onClick: () => ((config.leader = m.id), (unsaved = true), render()) },
            isLeader ? "♛ Leader" : tr("設為 Leader", "Make Leader"),
          ),
          h(
            "button",
            {
              type: "button",
              class: "link quiet-danger",
              disabled: config.members.length <= 1,
              onClick: () => {
                config.members.splice(at, 1);
                if (config.leader === m.id) config.leader = config.members[0].id;
                unsaved = true;
                render();
              },
            },
            tr("移除", "Remove"),
          ),
        ),
      ),
    );
  });

  const team = h(
    "section",
    { class: "panel form" },
    h(
      "div",
      { class: "panel-head" },
      h("h2", {}, tr("團隊成員", "Members"), h("span", { class: "count", text: String(config.members.length) })),
      h(
        "button",
        {
          type: "button",
          class: `help-toggle${memberHelp ? " on" : ""}`,
          "aria-expanded": String(memberHelp),
          "aria-controls": "member-help",
          title: memberHelp ? tr("收起說明", "Hide the help") : tr("每一欄怎麼填", "How to fill in each field"),
          onClick: () => {
            memberHelp = !memberHelp;
            render();
          },
        },
        h("b", { "aria-hidden": "true", text: "?" }),
        memberHelp ? tr("收起說明", "Hide help") : tr("怎麼填", "How to fill in"),
      ),
    ),
    memberHelp ? memberHelpCard() : null,
    members,
    h(
      "button",
      {
        type: "button",
        class: "add",
        onClick: () => {
          addMember(config);
          render();
        },
      },
      tr("＋ 加入成員", "＋ Add member"),
    ),
    agents.length
      ? h("p", { class: "hint" }, tr("代理在 ", "Add and edit agents in "), h("button", { class: "link", type: "button", onClick: () => void Bridge.openSettingsPage("agents") }, tr("設定 → Agents", "Settings → Agents")), tr(" 裡新增與修改", ""), h("span", {}, tr(";成員只從 ", "; members are chosen from the team agents in "), h("button", { class: "link", type: "button", onClick: () => { place = "agents"; render(); } }, "Agent Pool"), tr(" 裡的團隊 Agent 挑", "")), tr("。 ", ". "),
          h("button", { class: "link", type: "button", disabled: doctor === "running", title: tr("逐一確認每個代理的 CLI 找不找得到、能不能回答版本;找得到就等於重新定位成功", "Checks each agent's CLI in turn: can it be found, does it answer with its version. Found means it was located again."), onClick: () => {
            doctor = "running";
            render();
            Bridge.agentsDoctor(agents).then((r) => { doctor = r; render(); }, (e) => { doctor = String(e); render(); });
          } }, doctor === "running" ? tr("檢查中…", "Checking…") : tr("檢查代理", "Check agents")))
      : h("p", { class: "problem" }, tr("還沒有任何代理。請先到 ", "No agents yet. Create one in "), h("button", { class: "link", type: "button", onClick: () => void Bridge.openSettingsPage("agents") }, tr("設定 → Agents", "Settings → Agents")), tr(" 建立。", " first.")),
    Array.isArray(doctor)
      ? h("div", { class: "agent-doctor" }, ...doctor.map((c) =>
          h("p", { class: c.error ? "problem" : "hint" },
            h("b", { text: c.name }), " ",
            c.error ? `✕ ${c.error}` : `✓ ${c.version || tr("有回應", "responded")} · ${c.found ?? ""} · ${c.tookMs} ms`)))
      : typeof doctor === "string" && doctor !== "running"
        ? h("p", { class: "problem", text: trf("檢查代理失敗:{why}", "Checking the agents failed: {why}", { why: doctor }) })
        : null,
  );

  const stops = unsaved ? [] : file.problems;
  return h(
    "div",
    { class: "setup" },
    h(
      "div",
      { class: "setup-grid" },
      h("div", { class: "setup-col" }, goal, knowledgePanel(config.id, config.members.find((m) => m.id === config.leader)?.name ?? "", running, knowledgeHost)),
      team,
    ),
    stops.length ? h("div", { class: "problem" }, h("strong", { text: tr("啟動前還需要:", "Before it can start:") }), ...stops.map((p) => h("div", { text: `• ${said(p)}` }))) : null,
    h(
      "div",
      { class: "row end bar" }, // i18n-ok: CSS classes
      running
        ? h("span", {
            class: "hint",
            text: newcomers.length
              ? trf("{names} 可以馬上加入;其他修改下次啟動才會套用。", "{names} can join right away; other changes apply at the next start.", { names: joinNames(newcomers.map((m) => m.name)) })
              : tr("這個團隊正在執行;這裡的修改下次啟動才會套用。", "This team is running; changes made here apply at the next start."),
          })
        : null,
      running && newcomers.length
        ? button(newcomers.length === 1 ? tr("讓 1 位新成員加入 →", "Let the new member join →") : trf("讓 {n} 位新成員加入 →", "Let {n} new members join →", { n: newcomers.length }), "primary", () =>
            void act(async () => {
              if (!(await save())) return;
              const again = files.find((f) => f.file === selected);
              const theirs = again?.problems.filter((p) => newcomers.some((m) => p.startsWith(`${m.name} `))) ?? [];
              if (theirs.length) throw new Error(theirs.join("\n"));
              await Bridge.teamJoin(file.file);
              tab = "monitor";
            }),
          )
        : null,
      again ? h("span", { class: "hint", text: tr("重新開始會從頭跑一次;上一次的紀錄會保留在團隊紀錄資料夾。", "Starting again runs it from the top; the last run's record stays in the team's records folder.") }) : null,
      h("button", { class: `btn plain save${unsaved ? " due" : ""}`, type: "button", onClick: () => void act(save) }, tr("儲存", "Save")), // i18n-ok: CSS classes
      button(
        again ? tr("重新開始 →", "Start again →") : tr("啟動 Teamwork →", "Start Teamwork →"),
        "primary",
        () =>
          void act(async () => {
            await save();
            const again = files.find((f) => f.file === selected);
            if (again?.problems.length) throw new Error(again.problems.join("\n"));
            runs.set(config.id, await Bridge.teamStart(file.file));
            tab = "monitor";
          }),
        running,
      ),
    ),
  );
}

// ── The monitor ───────────────────────────────────────────────────────────────

const CROWN = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#F5A524" stroke="#0b0c0e" stroke-width="1.2" stroke-linejoin="round" d="M3.5 8.5l4.6 3.6L12 5l3.9 7.1 4.6-3.6-1.9 10H5.4z"/></svg>';

/**
 * A member at its desk: its Mochi, what it says right now, what waits for
 * the person, and its live screen.
 */
function desk(snap: Snapshot, m: MemberView): HTMLElement {
  // Planning and reviewing are kinds of work, said as such.
  const statuses = memberStatus();
  const status = m.phase ? { ...statuses[m.status], label: m.phase === "planning" ? tr("規劃中", "Planning") : tr("審核中", "Reviewing") } : statuses[m.status];
  const task = m.task ? snap.tasks.find((t) => t.id === m.task) : undefined;
  const { avatar, bubble, screen, pulse } = live.parts(snap, m);
  const big = focused === m.id;
  const el = h("article", { class: `desk ${m.status}${big ? " focused" : ""}`, style: `--c:${colorOf(snap, m.id)}` });
  el.append(
    h(
      "header",
      { class: "desk-top" },
      h("span", { class: "seat" }, avatar, m.isLeader ? h("i", { class: "crown", title: "Leader", html: CROWN }) : null),
      h(
        "div",
        { class: "member-head" },
        h("div", { class: "member-name" }, h("span", { class: "name", text: m.name }), h("span", { class: `badge ${m.status}` }, h("b", { text: status.mark }), status.label)),
        h("div", { class: "member-role", title: m.duty, text: m.isLeader ? `Leader · ${m.role}` : m.role }), // i18n-ok: "Leader" is the same in both
      ),
      h(
        "button",
        {
          class: "zoom",
          type: "button",
          title: big ? tr("縮回", "Shrink back") : tr("放大這位成員的畫面", "Enlarge this member's screen"),
          "aria-label": big ? tr("縮回", "Shrink back") : tr("放大這位成員的畫面", "Enlarge this member's screen"),
          onClick: () => {
            focused = big ? null : m.id;
            render();
          },
        },
        big ? "⤡" : "⤢",
      ),
    ),
    bubble,
  );

  // The things that wait for the person, answered right on the card.
  el.append(...asks(snap, m));
  if (m.status === "lost" && snap.detached) {
    el.append(h("div", { class: "hint", text: tr("按上方「從中斷處繼續」,它會和其他成員一起重新啟動。", "Press \"Resume where it stopped\" above and it restarts with the rest of the team.") }));
  } else if (m.status === "lost") {
    el.append(h("div", { class: "row" }, button(tr("重新啟動這位成員", "Restart this member"), "primary", () => void act(() => Bridge.teamRecover(snap.id, m.id)))));
  }

  // Whether it is alive: its last sign of life, and — when it has gone quiet
  // in the middle of a turn — a way to interrupt just this turn.
  el.append(
    h(
      "div",
      { class: "pulse-row" },
      pulse,
      otherModel(m),
      spend(m.usage, trf("{name} 這一輪用掉的 token", "Tokens {name} used this run", { name: m.name })),
      m.status === "working"
        ? h("button", { class: "btn plain stall", type: "button", title: tr("停掉它這一輪;它下一輪會被提醒手上的工作", "Stops its turn under way; on its next turn it's reminded of its open work"), onClick: () => void act(() => Bridge.teamInterruptMember(snap.id, m.id)) }, tr("打斷這一輪", "Interrupt this turn")) // i18n-ok: CSS classes
        : null,
    ),
  );
  const runsAs = `${agentLabel(m.agent)}${m.model ? ` · ${m.model}` : ""}`;
  const turns = m.turns === 1 ? trf("{agent} · 1 回合", "{agent} · 1 turn", { agent: runsAs }) : trf("{agent} · {n} 回合", "{agent} · {n} turns", { agent: runsAs, n: m.turns });
  el.append(
    screen,
    h(
      "footer",
      { class: "desk-foot" },
      task ? h("span", { class: "chip task", title: task.detail || task.title, text: `${task.id} · ${task.title}` }) : h("span", { class: "chip", title: m.duty, text: tr("沒有進行中的任務", "No task in progress") }),
      h("span", { class: "chip agent", title: `${tr("使用的代理與模型 · 已進行的回合數", "Agent and model in use · turns so far")}\n${turns}`, text: turns }),
    ),
  );
  return el;
}

/**
 * What a member waits on the person for — a permission card, a question —
 * answered right there: on its desk, in the Office's drawer, on the company map.
 */
function asks(snap: Snapshot, m: MemberView): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (m.permission) {
    const p = m.permission;
    const input = p.rawInput && typeof p.rawInput === "object" ? (p.rawInput as Record<string, unknown>) : {};
    const command = typeof input.command === "string" ? input.command : "";
    const allow = p.options.find((o) => o.kind === "allow_once") ?? p.options.find((o) => o.kind === "allow_always");
    const reject = p.options.find((o) => o.kind === "reject_once") ?? p.options.find((o) => o.kind === "reject_always");
    // Several at once (Codex runs steps side by side): every one is listed,
    // and they can be answered together.
    const more = m.morePermissions;
    const commandOf = (x: typeof p) => {
      const raw = x.rawInput && typeof x.rawInput === "object" ? (x.rawInput as Record<string, unknown>) : {};
      return typeof raw.command === "string" ? raw.command : x.title;
    };
    out.push(
      h(
        "div",
        { class: "ask" },
        h("div", {
          class: "ask-why",
          text: p.rule
            ? trf("憲法要你批准:{rule}", "The constitution needs your approval: {rule}", { rule: p.rule })
            : p.danger
              ? trf("要你批准:{why}", "Needs your approval: {why}", { why: dangerLabel(p.danger) })
              : tr("要你批准", "Needs your approval"),
        }),
        h("div", { class: "ask-what mono", text: command || p.title }),
        more.length
          ? h(
              "details",
              { class: "ask-more" },
              h("summary", { text: more.length === 1 ? tr("還有 1 個請求在排隊", "1 more request waiting") : trf("還有 {n} 個請求在排隊", "{n} more requests waiting", { n: more.length }) }),
              ...more.map((x) => h("div", { class: "ask-what mono", text: commandOf(x) })),
            )
          : null,
        h(
          "div",
          { class: "row" },
          button(tr("允許這一次", "Allow once"), "primary", () => void act(() => Bridge.teamPermit(snap.id, m.id, allow?.optionId ?? null)), !allow),
          button(tr("拒絕", "Deny"), "plain", () => void act(() => Bridge.teamPermit(snap.id, m.id, reject?.optionId ?? null))),
          more.length ? button(trf("全部允許({n})", "Allow all ({n})", { n: more.length + 1 }), "plain", () => void act(() => Bridge.teamPermit(snap.id, m.id, allow?.optionId ?? null, true)), !allow) : null,
          more.length ? button(tr("全部拒絕", "Deny all"), "plain", () => void act(() => Bridge.teamPermit(snap.id, m.id, reject?.optionId ?? null, true))) : null,
        ),
      ),
    );
  }
  const question = snap.questions.find((q) => q.by === m.id && q.answer === null);
  if (question) {
    out.push(
      h(
        "div",
        { class: "ask" },
        h("div", { class: "ask-why", text: tr("問你", "Asks you") }),
        h("div", { class: "ask-what", text: question.question }),
        field(`answer:${snap.id}:${question.id}`, tr("輸入回覆後按 Enter", "Type a reply and press Enter"), (text) =>
          void act(
            () => Bridge.teamAnswer(snap.id, question.id, text),
            () => drafts.delete(`answer:${snap.id}:${question.id}`),
          ),
        ),
      ),
    );
  }
  return out;
}

/** Everyone at their desks: the leader first, then as the team lists them. */
function stage(snap: Snapshot): HTMLElement {
  if (focused && !snap.members.some((m) => m.id === focused)) focused = null;
  const members = [...snap.members].sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
  return h(
    "section",
    { class: `stage${focused ? " has-focus" : ""}` },
    h(
      "div",
      { class: "stage-head" },
      h("h2", { text: tr("團隊現場", "The team at work") }),
      snap.status !== "finished" && !snap.detached
        ? h(
            "button",
            {
              class: "btn plain more-hands", // i18n-ok: CSS classes
              type: "button",
              title: tr("人手不夠時,加一位成員到這個執行中的團隊", "Short-handed? Add a member to this running team"),
              onClick: () => {
                if (!editing) return;
                addMember(editing);
                tab = "setup";
                render();
                root.querySelector(".member-row:last-of-type")?.scrollIntoView({ block: "center", behavior: "smooth" });
              },
            },
            tr("＋ 加人手", "＋ More hands"),
          )
        : null,
      h("span", { class: "hint", text: tr("每位成員說的話、跑的指令和結果都即時出現在它的畫面上;隊友之間的交辦、訊息與交付會從一位飛到另一位。", "What each member says, the commands it runs and their results show live on its screen; handoffs, messages and deliveries between teammates fly from one to the other.") }),
    ),
    h("div", { class: "desks" }, ...members.map((m) => desk(snap, m))),
  );
}

function taskCard(snap: Snapshot, t: Task): HTMLElement {
  const met = t.criteria.filter((c) => c.claimed).length;
  const waitsFor = t.status === "todo" ? t.dependsOn.map((d) => snap.tasks.find((x) => x.id === d)).filter((d) => d && d.status !== "delivered" && d.status !== "done") : [];
  const card = h("article", { class: `task${t.blocked ? " blocked" : ""}`, title: t.detail });
  card.append(h("div", { class: "task-title" }, h("span", { text: t.title }), t.status === "done" ? h("span", { class: "tick", text: "✓", title: tr("已驗收", "Accepted") }) : null));
  const sub = t.blocked
    ? trf("卡住:{why}(等 {who})", "Stuck: {why} (waiting for {who})", { why: t.blocked.reason, who: nameOf(snap, t.blocked.on) })
    : waitsFor.length
      ? trf("等待{tasks}", "Waiting for {tasks}", { tasks: joinNames(waitsFor.map((d) => d!.title)) })
      : t.note || t.detail.split("\n")[0];
  if (sub) card.append(h("div", { class: t.blocked ? "task-sub warn" : "task-sub", text: sub }));
  const marks = h("div", { class: "task-marks" });
  if (t.status === "delivered") marks.append(h("span", { class: "chip pending", text: tr("已交付,待驗收", "Handed in, awaiting review") }));
  if (t.criteria.length && t.status !== "done") marks.append(h("span", { class: "chip", title: t.criteria.map((c) => `${c.claimed ? "☑" : "☐"} ${c.text}`).join("\n"), text: trf("完成條件 {met} / {n}", "Criteria {met} / {n}", { met, n: t.criteria.length }) }));
  if (t.rejections) marks.append(h("span", { class: "chip warn", text: t.rejections === 1 ? tr("退回 1 次", "Sent back once") : trf("退回 {n} 次", "Sent back {n} times", { n: t.rejections }) }));
  card.append(h("div", { class: "task-foot" }, who(snap, t.owner), marks, h("span", { class: `chip prio ${t.priority}`, title: tr("優先度", "Priority"), text: priorityLabel(t.priority) })));
  return card;
}

function board(snap: Snapshot): HTMLElement {
  const columns: [string, string, Task[]][] = [
    [tr("待處理", "To do"), "todo", snap.tasks.filter((t) => t.status === "todo")],
    [tr("進行中", "In progress"), "doing", snap.tasks.filter((t) => t.status === "doing")],
    [tr("已完成", "Done"), "done", snap.tasks.filter((t) => t.status === "delivered" || t.status === "done")],
  ];
  const grid = h("div", { class: "board" });
  for (const [title, kind, tasks] of columns) {
    const col = h("div", { class: `column ${kind}` }, h("div", { class: "column-head" }, h("span", { text: title }), h("span", { class: "count", text: String(tasks.length) })));
    for (const t of tasks) col.append(taskCard(snap, t));
    if (!tasks.length) col.append(h("div", { class: "empty", text: "—" }));
    grid.append(col);
  }
  return h("section", { class: "panel" }, h("h2", { text: tr("任務看板", "Task board") }), snap.tasks.length ? grid : h("p", { class: "dim", text: tr("Leader 還沒有建立任務。", "The Leader hasn't created any tasks yet.") }));
}

/** What a line of the team's feed is, by its kind. */
function feedTitle(kind: FeedItem["kind"]): string {
  const titles: Record<FeedItem["kind"], string> = {
    message: tr("訊息", "Message"),
    task: tr("建立任務", "New task"),
    delivered: tr("已交付", "Handed in"),
    accepted: tr("驗收通過", "Accepted"),
    rejected: tr("退回", "Sent back"),
    blocked: tr("被卡住", "Stuck"),
    asked: tr("向你提問", "Asked you"),
    answered: tr("你的回覆", "Your reply"),
    lost: tr("失聯", "Disconnected"),
    paused: tr("團隊暫停", "Team paused"),
    finished: tr("團隊完成", "Team finished"),
    ended: tr("由你結束", "Ended by you"),
    joined: tr("加入團隊", "Joined the team"),
    reopened: tr("再次開工", "Back at work"),
  };
  return titles[kind];
}

function feed(snap: Snapshot): HTMLElement {
  const list = h("div", { class: "feed" });
  const items = [...snap.feed].reverse().slice(0, 40);
  for (const item of items) {
    const task = item.task ? snap.tasks.find((t) => t.id === item.task) : undefined;
    const title = item.kind === "message" || !task ? feedTitle(item.kind) : `${feedTitle(item.kind)} · ${task.title}`;
    list.append(
      h(
        "div",
        { class: `feed-item ${item.kind}${item.to === YOU ? " to-you" : ""}` },
        h("div", { class: "feed-head" }, who(snap, item.from), item.to ? h("span", { class: "arrow", text: "→" }) : null, item.to ? who(snap, item.to) : null, h("time", { text: clock(item.at) })),
        h("div", { class: "feed-title", text: title }),
        item.text && item.kind !== "task" ? h("div", { class: "feed-text", text: said(item.text) }) : null,
        // The pictures it is about: named in the words, or handed in for its task.
        item.kind === "task" ? null : thumbsFor(snap.id, item.text, ...(item.task && /delivered|accepted|rejected/.test(item.kind) ? snap.deliverables.filter((d) => d.task === item.task).slice(-1).map((d) => d.locator) : [])),
      ),
    );
  }
  if (!items.length) list.append(h("p", { class: "dim", text: tr("還沒有任何協作紀錄。", "Nothing has happened between members yet.") }));
  return h("section", { class: "panel feed-panel" }, h("h2", { text: tr("最新協作", "Latest activity") }), list);
}

function deliverables(snap: Snapshot): HTMLElement {
  const row = h("div", { class: "deliverables" });
  const icon = (d: Deliverable) => (d.locator.startsWith("http") ? "↗" : /image|圖/.test(d.kind) ? "▣" : /source|code|原始/.test(d.kind) ? "</>" : "▤");
  const pictures = [...snap.deliverables].reverse().map((d) => d.locator).filter(isImage);
  for (const d of [...snap.deliverables].reverse()) {
    const task = snap.tasks.find((t) => t.id === d.task);
    const picture = isImage(d.locator);
    row.append(
      h(
        "button",
        {
          class: `deliverable${picture ? " picture" : ""}`,
          type: "button",
          title: picture ? trf("看 {path}", "View {path}", { path: d.locator }) : trf("開啟 {path}", "Open {path}", { path: d.locator }),
          // A picture opens large in the window; anything else in Explorer.
          onClick: () => (picture ? openImage(snap.id, pictures, pictures.indexOf(d.locator)) : void act(() => Bridge.teamOpen(snap.id, d.locator))),
        },
        h("span", { class: "deliverable-icon", text: icon(d) }, picture ? thumbImg(snap.id, d.locator) : null),
        h(
          "span",
          { class: "deliverable-body" },
          h("span", { class: "deliverable-name", text: task?.title ?? d.task }),
          h("span", { class: "dim mono", text: d.locator }),
          h("span", { class: "dim", text: `${nameOf(snap, d.by)} · ${clock(d.at)} · ${d.summary}` }),
        ),
        h("span", {
          class: `chip ${d.accepted === true ? "ok" : d.accepted === false ? "warn" : "pending"}`,
          text: d.accepted === true ? tr("已驗收", "Accepted") : d.accepted === false ? tr("已退回", "Sent back") : tr("待驗收", "Awaiting review"),
        }),
      ),
    );
  }
  if (!snap.deliverables.length) row.append(h("p", { class: "dim", text: tr("還沒有成員交付成果。", "No member has handed anything in yet.") }));
  return h("section", { class: "panel" }, h("h2", { text: tr("已產生成果", "Deliverables") }), row);
}

function composer(snap: Snapshot): HTMLElement {
  const leader = snap.members.find((m) => m.isLeader);
  const to = dropdown({
    value: recipient,
    choices: [
      { value: "", label: tr("給 Leader", "To the Leader"), hint: leader?.name },
      ...snap.members.filter((m) => !m.isLeader).map((m) => ({ value: m.id, label: trf("給 {name}", "To {name}", { name: m.name }), hint: m.role })),
    ],
    title: tr("傳給誰", "Send to"),
    className: "narrow",
    onChange: (v) => {
      recipient = v;
      render();
    },
  });
  const files = attachments.get(snap.id) ?? [];
  // The pictures go as full paths in the message: every agent can open an
  // image file in the team's folder with its own tool. The words around them
  // are the person's own message (the feed and the log show it as theirs), so
  // they come in the person's language; every agent reads either.
  const send = (text: string) => {
    if (!text && !files.length) return;
    let body = text || (files.some((f) => IMAGE.test(f.name)) ? tr("請看附上的圖片。", "Please look at the attached image.") : tr("請看附上的檔案。", "Please look at the attached file."));
    if (files.length) {
      const pictures = files.every((f) => IMAGE.test(f.name));
      const head = pictures
        ? tr("附上的圖片(在團隊資料夾裡,請用你讀檔或看圖片的工具打開):", "Attached images (in the team's folder; open them with your file or image tool):")
        : tr("附上的檔案(在團隊資料夾裡,請用你讀檔或看圖片的工具打開):", "Attached files (in the team's folder; open them with your file or image tool):");
      body += `\n\n${head}\n${files.map((f) => `- ${f.path}`).join("\n")}`;
    }
    void act(
      () => Bridge.teamInstruct(snap.id, recipient, body),
      () => {
        drafts.delete(`instruct:${snap.id}`);
        for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
        attachments.delete(snap.id);
      },
    );
  };
  // A finished team is not closed: new words start it again, the leader first.
  const hint = snap.status === "finished" && snap.ended
    ? tr("團隊已由你結束。要接著做,寫在這裡送出,Leader 會從現在的進度繼續,團隊會重新開工", "You ended this team. To carry on, write here and send: the Leader goes on from where things stand and the team gets back to work")
    : snap.status === "finished"
    ? tr("團隊已完成。對成果不滿意或有新需求,寫在這裡送出,Leader 會接著處理,團隊會繼續工作", "The team is done. Not happy with the result, or need something new? Write here and send: the Leader picks it up and the team keeps working")
    : tr("傳送新指示…可貼上、拖進或附上圖片(對方這一輪結束後才會讀到)", "Send a new instruction… you can paste, drop or attach images (read once their turn under way ends)");
  const input = field(`instruct:${snap.id}`, hint, (t) => send(t));
  // Ctrl+V of a screenshot attaches it.
  input.addEventListener("paste", (e) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (!pasted.length) return;
    e.preventDefault();
    for (const f of pasted) attachBlob(snap.id, f);
  });
  const picker = h("input", { type: "file", accept: "image/*", multiple: true, style: "display:none" }) as HTMLInputElement;
  picker.addEventListener("change", () => {
    for (const f of picker.files ?? []) attachBlob(snap.id, f);
    picker.value = "";
  });
  const clip = h(
    "button",
    {
      class: "btn plain clip", // i18n-ok: CSS classes
      type: "button",
      title: tr("附上圖片(也可以直接貼上或拖進視窗)", "Attach images (you can also paste them or drop them on the window)"),
      "aria-label": tr("附上圖片", "Attach images"),
      onClick: () => picker.click(),
    },
    tr("＋圖", "＋ Image"),
  );
  const tray = files.length
    ? h(
        "div",
        { class: "attachments" },
        ...files.map((f) =>
          h(
            "span",
            { class: "attachment", title: f.path },
            f.preview ? h("img", { src: f.preview, alt: f.name }) : h("i", { text: IMAGE.test(f.name) ? "▣" : "▤" }),
            h("span", { class: "attachment-name", text: f.name }),
            h("button", {
              type: "button",
              class: "attachment-x",
              title: tr("拿掉", "Remove"),
              "aria-label": trf("拿掉 {name}", "Remove {name}", { name: f.name }),
              onClick: () => {
                if (f.preview) URL.revokeObjectURL(f.preview);
                attachments.set(snap.id, files.filter((x) => x !== f));
                render();
              },
            }, "×"),
          ),
        ),
      )
    : null;
  return h(
    "div",
    { class: `composer-wrap${files.length ? " has-files" : ""}` },
    tray,
    h(
      "div",
      { class: "composer" },
      to,
      clip,
      picker,
      input,
      button(tr("送出", "Send"), "primary", () => send(input.value.trim())),
    ),
  );
}

function monitor(snap: Snapshot): HTMLElement {
  // The board and the Office read progress from the same calculation.
  const shared = office.main.progress(snap.id);
  const percent = shared.percent ?? 0;
  const minutes = Math.max(0, Math.floor(((snap.finishedAt || Date.now()) - snap.startedAt) / 60_000));

  return h(
    "div",
    { class: "monitor" },
    h(
      "div",
      { class: "progress" },
      h("span", { class: "progress-label", text: tr("整體進度", "Overall progress") }),
      h("span", { class: "progress-number", text: shared.percent === null ? tr("尚未派工", "Nothing assigned yet") : `${percent}%` }),
      h("div", { class: "meter", role: "progressbar", "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${percent}%` })),
      h("span", { class: "dim", text: trf("已驗收 {done} / {total} 項任務", "{done} / {total} tasks accepted", { done: snap.done, total: snap.total }) }),
      h("span", { class: "dim", text: trf("{used} / {max} 回合", "{used} / {max} turns", { used: snap.totalTurns, max: snap.maxTurns }) }),
      h("span", { class: "dim", text: trf("已執行 {n} 分鐘", "Running for {n} min", { n: minutes }) }),
      spend(snap.members.flatMap((m) => m.usage ?? []), tr("全隊這一輪用掉的 token", "Tokens the whole team used this run")),
    ),
    stage(snap),
    h("div", { class: "split" }, board(snap), feed(snap)),
    deliverables(snap),
    composer(snap),
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

/** The window has no title bar of its own: these three stand in for it. */
function windowButtons(): HTMLElement {
  const b = (label: string, title: string, action: "minimize" | "maximize" | "close") =>
    h("button", { class: `win ${action}`, type: "button", title, "aria-label": title, onClick: () => void Bridge.teamWindow(action) }, label);
  return h("div", { class: "window-buttons" }, b("–", tr("最小化", "Minimize"), "minimize"), b("▢", tr("最大化", "Maximize"), "maximize"), b("✕", tr("關閉", "Close"), "close"));
}

function header(file: TeamFile, snap: Snapshot | undefined): HTMLElement {
  const name = snap?.name || editing?.name || file.config?.name || tr("未命名的團隊", "Untitled team");
  const goal = (snap?.goal ?? editing?.goal ?? "").split("\n")[0];
  const count = snap?.members.length ?? editing?.members.length ?? 0;
  const actions = h("div", { class: "row" });
  if (snap?.status === "running") {
    actions.append(
      h("button", { class: "btn plain", type: "button", title: tr("不再開始新的回合;正在做的這一輪會做完", "No new turns start; the turns under way finish"), onClick: () => void act(() => Bridge.teamPause(snap.id)) }, tr("暫停", "Pause")),
      button(tr("全部中斷", "Interrupt all"), "danger", () => void act(() => Bridge.teamInterrupt(snap.id))),
      endButton(snap),
    );
  } else if (snap?.status === "paused") {
    // A team from an earlier run gets its agents back, and its members
    // their work, where it stopped.
    actions.append(button(snap.detached ? tr("從中斷處繼續", "Resume where it stopped") : tr("繼續", "Continue"), "primary", () => void act(() => Bridge.teamResume(snap.id))));
    // Pausing hands out no new turns; the ones under way run to their end.
    // Whoever is still at it can be stopped now.
    const busy = snap.members.filter((m) => m.status === "working").length;
    if (busy && !snap.detached) {
      actions.append(button(trf("立刻停下({n} 位還在做)", "Stop now ({n} still working)", { n: busy }), "danger", () => void act(() => Bridge.teamInterrupt(snap.id))));
    }
    actions.append(endButton(snap));
  }
  return h(
    "header",
    { class: "top", "data-drag": "" },
    h(
      "div",
      { class: "top-title", "data-drag": "" },
      h("h1", { "data-drag": "" }, name, snap ? h("span", { class: `state ${snap.status}${snap.ended ? " ended" : ""}`, text: teamStatus(snap) }) : null),
      h("p", { class: "dim", "data-drag": "", text: goal ? `${goal} · ${aiMembers(count)}` : aiMembers(count) }),
      snap?.status === "paused" && snap.pausedWhy
        ? h("p", {
            class: "paused-why",
            text: snap.detached
              ? trf("{why} · 按「從中斷處繼續」接著做,或到「團隊設定」重新開始", "{why} · Press \"Resume where it stopped\" to carry on, or start again from Team setup", { why: said(snap.pausedWhy) })
              : snap.members.some((m) => m.status === "working")
                ? trf(
                    "{why} · 不再開始新的回合;還在做的成員會把這一輪做完,要馬上停請按「立刻停下」",
                    "{why} · No new turns start; members still at work finish the turn they're on. To stop them at once, press \"Stop now\"",
                    { why: said(snap.pausedWhy) },
                  )
                : said(snap.pausedWhy),
          })
        : null,
    ),
    actions,
    windowButtons(),
  );
}

function tabs(snap: Snapshot | undefined): HTMLElement {
  const item = (label: string, id: typeof tab, enabled: boolean, note = "") =>
    h(
      "button",
      {
        class: `tab${id && tab === id ? " on" : ""}`,
        type: "button",
        disabled: !enabled,
        onClick: () => {
          tab = id;
          render();
        },
      },
      label,
      note ? h("small", { text: note }) : null,
    );
  return h(
    "nav",
    { class: "tabs" },
    item(tr("團隊設定", "Team setup"), "setup", true),
    item(tr("協作關係", "Collaboration"), "links", !!editing),
    item(tr("工作監控", "Monitor"), "monitor", true, ""),
    item(tr("溝通紀錄", "Message log"), "log", !!snap, snap ? "" : tr("啟動後", "after start")),
    tab === "monitor"
      ? h(
          "div",
          { class: "office-switch", role: "group", "aria-label": tr("看板或辦公室", "Board or office") },
          h("button", { class: monitorMode === "board" ? "on" : "", type: "button", "aria-pressed": String(monitorMode === "board"), disabled: !snap, title: snap ? "" : tr("團隊啟動後才有看板", "The board appears once the team has started"), onClick: () => { monitorMode = "board"; render(); } }, tr("看板", "Board")),
          h("button", { class: monitorMode === "office" ? "on" : "", type: "button", "aria-pressed": String(monitorMode === "office"), onClick: () => { monitorMode = "office"; render(); } }, "Office"), // i18n-ok: the Office view's name in both languages
        )
      : null,
  );
}

function main(): HTMLElement {
  if (place === "agents") {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("nav", { class: "crumbs", "data-drag": "", "aria-label": tr("位置", "Location") }, h("b", { text: "Agent Pool" })), windowButtons()),
      h("div", { class: "scroll" }, agentsPage(agentsHost, drawnPlace !== "agents")),
    );
  }
  if (place === "law") {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("nav", { class: "crumbs", "data-drag": "", "aria-label": tr("位置", "Location") }, h("b", { text: tr("憲法", "Constitution") })), windowButtons()),
      h("div", { class: "scroll" }, constitutionPage({ render: () => render() })),
    );
  }
  if (place === "secretary") {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("nav", { class: "crumbs", "data-drag": "", "aria-label": tr("位置", "Location") }, secretaryTitle(secretaryHost)), windowButtons()),
      secretaryPage(secretaryHost),
    );
  }
  if (place === "cost") {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("nav", { class: "crumbs", "data-drag": "", "aria-label": tr("位置", "Location") }, h("b", { text: tr("成本與用量", "Cost & usage") })), windowButtons()),
      h("div", { class: "scroll" }, costPage(costHost)),
    );
  }
  if (place === "company" || (place === "office" && officeTeam)) {
    const team = place === "office" ? office.store.team(officeTeam!) : undefined;
    return h(
      "main",
      { class: "main pane" },
      h(
        "header",
        { class: "top", "data-drag": "" },
        h(
          "nav",
          { class: "crumbs", "data-drag": "", "aria-label": tr("位置", "Location") },
          place === "office"
            ? h("button", { class: "link", type: "button", onClick: () => { place = "company"; render(); } }, tr("公司總覽", "Company overview"))
            : h("b", { text: tr("公司總覽", "Company overview") }),
          team ? h("span", { class: "dim", text: ` › ${team.name}` }) : null,
        ),
        windowButtons(),
      ),
      h("div", { class: "scroll" }, place === "office" ? office.team(officeTeam!) : office.company()),
    );
  }
  const file = files.find((f) => f.file === selected);
  if (!file) {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("div", { "data-drag": "" }), windowButtons()),
      h("div", { class: "welcome" }, teamMark(64), h("h1", { text: "Teamwork" }), h("p", { class: "dim", text: files.length ? tr("從左邊選一個團隊。", "Pick a team on the left.") : tr("按左下角的「新增團隊」開始。", "Press \"New team\" at the bottom left to start.") })),
    );
  }
  const snap = file.config ? runs.get(file.config.id) : undefined;
  // A screen that needs a running team falls back to the setup.
  const view =
    tab === "monitor" && (monitorMode === "office" || !snap) && file.config ? office.team(file.config.id)
    : tab === "monitor" && snap ? monitor(snap)
    : tab === "log" && snap && editing ? logScreen(editing, snap, page)
    : tab === "links" && editing ? linksScreen(editing, snap, page)
    : setup(file);
  return h(
    "main",
    { class: "main pane" },
    header(file, snap),
    tabs(snap),
    trouble ? h("div", { class: "problem", role: "alert", text: trouble.split("\n").map(said).join("\n") }) : null,
    h("div", { class: "scroll" }, view),
  );
}

/** Agent Center's page: it may add a team, and point at one. */
const secretaryHost: SecretaryHost = {
  render: () => render(),
  reload: () => load(),
  openTeam: (id) => {
    const file = files.find((f) => f.config?.id === id);
    if (file) {
      select(file.file);
      render();
    }
  },
};

/** A team's 知識庫 panel, in its setup. */
const knowledgeHost: KnowledgeHost = { render: () => render() };

/** The Agent Pool page: team agents built on Settings → Agents. */
const agentsHost: AgentsHost = {
  render: () => render(),
  natives: () => agents,
  usedBy: (id) => files.filter((f) => f.config?.members.some((m) => m.agent === id)).map((f) => f.config!.name || f.file),
  openSettings: () => void Bridge.openSettingsPage("agents"),
};

/** Every agent a member may name, for names and default models: native and team. */
function allAgents(): AgentProfile[] {
  return [...agents, ...teamProfiles(agents).filter((t) => !agents.some((a) => a.id === t.id))];
}

/** The 成本與用量 page draws inside this window, with its agents' names. */
const costHost: CostHost = {
  render: () => render(),
  agents: () => allAgents(),
  openSecretary: () => {
    place = "secretary";
    render();
  },
};

/** The model a member was given, when the calls it made used another (as the meter saw them). */
function otherModel(m: MemberView): HTMLElement | null {
  // An alias ("sonnet") or an effort suffix ("-high") still names the same model.
  const norm = (x: string) => x.toLowerCase().replace(/\[.*\]$/, "").replace(/\./g, "-").trim();
  const same = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));
  const ran = (m.usage ?? []).map((u) => u.model).filter(Boolean);
  if (!m.model || !ran.length || ran.some((r) => same(r, m.model))) return null;
  return h("span", {
    class: "chip warn",
    title: trf("指定的模型是 {set},但實際送出的請求用的是 {ran}。請檢查這個代理的設定。", "The model set is {set}, but the requests actually sent used {ran}. Check this agent's settings.", { set: m.model, ran: joinNames(ran) }),
    text: trf("實際:{ran}", "Actual: {ran}", { ran: joinNames(ran) }),
  });
}

/** Tokens and cost beside a member or a team at work: "182K tokens · $0.04". */
function spend(usage: MemberView["usage"], title: string): HTMLElement | null {
  const s = usageSummary(usage, () => render());
  if (!s.tokens) return null;
  const text = `${fmtTokens(s.tokens)} tokens${s.usd != null ? ` · ${s.priced ? "" : "≥ "}${fmtMoney(s.usd)}` : ""}`;
  return h("span", { class: "chip spend", title: trf("{title}。預估成本依「成本與用量」的價格表計算。", "{title}. The estimated cost uses the price list in Cost & usage.", { title }), text });
}

/** The Office: the same record as the board, as rooms. `?office=mock` in a browser shows the spec's demo company. */
const office = new Office(
  {
    render: () => render(),
    dragEnded: () => {
      if (renderWaiting) {
        renderWaiting = false;
        render();
      }
    },
    showBoard: () => {
      monitorMode = "board";
      render();
    },
    openTeam: (teamId) => {
      const file = files.find((f) => f.config?.id === teamId);
      if (file) {
        select(file.file);
        tab = "monitor";
        monitorMode = "office";
      } else {
        place = "office";
        officeTeam = teamId;
      }
      render();
    },
    openTask: (teamId, taskId) => {
      const file = files.find((f) => f.config?.id === teamId);
      if (!file) return;
      if (selected !== file.file) select(file.file);
      openThread(teamId, taskId);
      tab = "log";
      render();
    },
    openArtifact: (teamId, ref) => (isImage(ref) ? openImage(teamId, ref) : void act(() => Bridge.teamOpen(teamId, ref))),
    preview: IS_TAURI ? (teamId, ref) => Bridge.teamPreview(teamId, ref) : undefined,
    // A plain browser (`npm run dev`) shows one made-up earlier run of the demo team.
    history: IS_TAURI ? (teamId) => Bridge.teamHistory(teamId) : import.meta.env.DEV ? async (teamId) => (teamId === "shop" ? (await import("./demo")).demoHistory() : []) : undefined,
    past: IS_TAURI ? (teamId, at) => Bridge.teamPast(teamId, at) : import.meta.env.DEV ? async () => (await import("./demo")).demoPast() : undefined,
    openSetup: (teamId) => {
      const file = files.find((f) => f.config?.id === teamId);
      if (file) select(file.file);
      tab = "setup";
      render();
    },
    pause: (teamId) => Bridge.teamPause(teamId),
    resume: (teamId) => Bridge.teamResume(teamId),
    instruct: (teamId, text, request) => Bridge.teamInstruct(teamId, "", text, request),
    asks: (teamId, memberId) => {
      const snap = runs.get(teamId);
      const m = snap?.members.find((x) => x.id === memberId);
      return snap && m ? asks(snap, m) : [];
    },
    trouble: () => trouble,
  },
  { demo: !IS_TAURI && new URLSearchParams(location.search).get("office") === "mock" },
);
// Development only: the office, to drive its scenes from the console.
if (import.meta.env.DEV && !IS_TAURI) Object.assign(window, { __office: office });

/** What the 協作關係 and 溝通紀錄 screens borrow from the page. */
const page: Page = { render: () => render(), act, save, said, colorOf, blob, composer, touched };

/** Drawing again waits while a menu is open: it hangs from a field that would be replaced. */
let renderWaiting = false;
onMenuClosed(() => {
  if (renderWaiting) {
    renderWaiting = false;
    render();
  }
});

function render() {
  // …and while a finger or the mouse is still on the 星域: rebuilding the page would drop the drag.
  if (menuOpen() || office.dragging()) {
    renderWaiting = true;
    return;
  }
  // Drawing again must not take the caret out of a field someone is typing in.
  const active = document.activeElement as HTMLInputElement | null;
  const key = active?.dataset?.key;
  const caret = key && active!.type !== "number" ? [active!.selectionStart, active!.selectionEnd] : null;
  const scroll = root.querySelector(".scroll")?.scrollTop ?? 0;

  clear(root);
  root.append(h("div", { class: "shell" }, sidebar(), main()));

  const scroller = root.querySelector(".scroll");
  if (scroller) scroller.scrollTop = scroll;
  // Nodes kept across redraws (the 星域, its rings) were detached and put back: give them their focus back.
  if (active && active !== document.body && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  drawnPlace = place;
  live.afterRender();
  office.afterRender();
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
    const boot = await Bridge.boot();
    agents = boot?.settings.agents ?? [];
    setLang(boot?.lang);
    // 中二模式 is off unless 設定 → 團隊與 Agent Center turned it on; a raid saved as
    // the last view then opens as the office (the preference itself is kept).
    office.battleAllowed = !!boot?.settings.battleMode;
    if (!office.battleAllowed && office.mode === "battle") office.mode = "office";
    await loadTeamAgents(() => {}, agents, true);
    for (const snap of (await Bridge.teamSnapshots()) ?? []) {
      runs.set(snap.id, snap);
      live.applySnapshot(snap);
    }
  } else if (import.meta.env.DEV) {
    // A plain browser: the drafts' team, to look at the screen without the app.
    const demo = await import("./demo");
    // No desktop behind a browser tab: stand one in, so the glass has something to show.
    document.documentElement.classList.add("demo");
    dir = demo.demoFiles.dir;
    files = demo.demoFiles.files;
    agents = demo.demoAgents;
    await loadTeamAgents(() => {}, agents);
    if (!runs.has("shop")) {
      const snap = demo.demoSnapshot();
      runs.set("shop", snap);
      live.applySnapshot(snap);
      tab = "monitor";
      // `?view=office` / `?view=company` open the Office straight away, to look at it.
      const view = new URLSearchParams(location.search).get("view");
      if (view === "office") monitorMode = "office";
      const member = new URLSearchParams(location.search).get("member");
      if (member) office.sel = { teamId: "shop", memberId: member };
      demo.demoStream(live.applyPatch, (next) => {
        runs.set(next.id, next);
        live.applySnapshot(next);
        if (tab === "monitor") render();
      }, snap);
      // `&battle=off` is the window with 中二模式 turned off in the settings.
      if (new URLSearchParams(location.search).get("battle") === "off") {
        office.battleAllowed = false;
        if (office.mode === "battle") office.mode = "office";
      }
      // `&battle=play` plays a whole raid on the demo team, to look at 中二模式.
      if (new URLSearchParams(location.search).get("battle") === "play") {
        (await import("./battle-demo")).playBattle(snap, (next) => {
          runs.set(next.id, next);
          live.applySnapshot(next);
          office.feed(files, runs);
          render();
        });
      }
      // `&pose=combo_trinity:700` holds one move still, to look at it; `&calm=1` is 減少動態.
      const pose = new URLSearchParams(location.search).get("pose");
      if (pose) window.setTimeout(async () => (await import("./battle-demo")).poseBattle(office, "shop", pose), 800);
      const bpose = new URLSearchParams(location.search).get("bpose");
      if (bpose) window.setTimeout(async () => (await import("./battle-demo")).poseBossMove(office, "shop", bpose), 800);
      if (new URLSearchParams(location.search).get("calm") === "1") office.calm = true;
    }
  }
  office.feed(files, runs);
  if (!selected || !files.some((f) => f.file === selected)) {
    // The team that is running, else the first one not put away.
    const first = files.find((f) => f.config && runs.get(f.config.id)?.status === "running")?.file ?? (files.find((f) => !f.config?.archived) ?? files[0])?.file ?? null;
    if (first) select(first);
    else selected = null;
  } else if (!unsaved) {
    // The file may have been edited outside; an untouched form follows it.
    const again = files.find((f) => f.file === selected);
    editing = again?.config ? structuredClone(again.config) : null;
  }
  // A browser opened at `?view=company` starts on the company map.
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "company") place = "company";
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "cost") place = "cost";
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "secretary") place = "secretary";
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "setup") {
    tab = "setup";
    // `&adv=ai1` opens that member's 進階設定, to look at it.
    const adv = new URLSearchParams(location.search).get("adv");
    if (adv) advancedOpen.add(adv);
  }
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "law") place = "law";
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "agents") place = "agents";
  firstLoad = false;
  render();
}
let firstLoad = true;

/**
 * Files dragged onto the window: into the knowledge base of the team being
 * set up, to Agent Center, or with the next instruction to the team on
 * screen. Through the page's own HTML5 drag and drop (the window has no
 * Tauri drop handler, see create_team_window): the files come as bytes.
 * Anywhere else a dropped file is refused, never opened by the webview.
 */
function wireDrops() {
  const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files"); // i18n-ok: a drag data type
  let depth = 0;
  const show = (on: boolean) => {
    const target = dropTarget(place, tab);
    setDragging(on && target === "knowledge", knowledgeHost);
    setSecretaryDragging(on && target === "secretary", secretaryHost);
  };
  window.addEventListener("dragenter", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) show(true);
  });
  window.addEventListener("dragover", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = dropTarget(place, tab) ? "copy" : "none";
  });
  window.addEventListener("dragleave", (e) => {
    if (!carriesFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      show(false);
    }
  });
  window.addEventListener("drop", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    const dropped = [...(e.dataTransfer?.files ?? [])];
    if (!dropped.length) return;
    const target = dropTarget(place, tab);
    void Bridge.log(`team window: ${dropped.length} file(s) dropped on ${target ?? "nothing"}`);
    if (target === "knowledge") {
      const team = files.find((f) => f.file === selected)?.config?.id;
      if (team) void addKnowledgeFiles(team, dropped, knowledgeHost);
    } else if (target === "secretary") {
      void secretaryAttachFiles(dropped, secretaryHost);
    } else if (target === "attachment") {
      const file = files.find((f) => f.file === selected);
      const team = file?.config ? runs.get(file.config.id) : undefined;
      if (team) for (const f of dropped) attachBlob(team.id, f);
    }
  });
}

async function start() {
  live.setSaid(said);
  // A language change redraws the whole window; typing in a form survives a
  // render the way it survives a team's update (see the focus keeping below).
  onLangChange(() => render());
  await onEvent<string>("lang-changed", (l) => setLang(l));
  await onEvent<Snapshot>("team-changed", (snap) => {
    const had = runs.get(snap.id);
    if (had && had.startedAt === snap.startedAt && snap.seq < had.seq) return;
    runs.set(snap.id, snap);
    live.applySnapshot(snap);
    office.feed(files, runs);
    // New tokens may have come in: the cost page asks again, a little later.
    if (place === "cost") refreshSoon(costHost);
    // Typing in the form is not interrupted by a team at work behind it.
    if (tab === "monitor" || !unsaved) render();
  });
  wireDrops();
  // What Agent Center is doing while it works on a request.
  await onEvent<SecretaryStep>("secretary-step", (step) => secretaryStep(step, secretaryHost));
  // Settings → 清除歷史紀錄: the teams, their runs and Agent Center's words this window holds are gone; start over from disk.
  await onEvent<boolean>("history-cleared", () => location.reload());
  // Each member's screen, as it happens: no redraw, just the lines.
  await onEvent<ScreenPatch>("team-screen", live.applyPatch);
  // A team's documents changed: here, by its leader sharing one, or by Agent Center.
  await onEvent<{ team: string }>("team-knowledge-changed", ({ team }) => knowledgeChanged(team, knowledgeHost));
  // Team agents saved: what teams can start with may have changed.
  await onEvent("team-agents-changed", () => {
    void load().then(() => {
      if (!unsaved) render();
    });
  });
  // The settings window's "Open Agent Center ↗" / "Agent Pool ↗".
  await onEvent<string>("team-goto", (page) => {
    if (page === "secretary" || page === "agents") {
      place = page;
      render();
    }
  });
  // Agents may have been added in the settings window meanwhile.
  await onEvent<{ agents: AgentProfile[]; battleMode?: boolean }>("settings-changed", (s) => {
    agents = s.agents ?? agents;
    office.allowBattle(!!s.battleMode);
    if (!unsaved) render();
  });

  // The browser's own right-click menu belongs to no app: only fields and
  // selected text keep it, for copy and paste.
  document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement;
    const editing = target.closest("input, textarea, [contenteditable]");
    if (!editing && !window.getSelection()?.toString()) e.preventDefault();
  });

  // The page is the title bar: drag it by its header, double-click to maximize.
  root.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement;
    if (e.button === 0 && e.detail === 1 && target.hasAttribute("data-drag")) {
      // The webview must not start a selection or its own drag while the
      // native move loop runs: on some machines the two fight and the
      // window jumps around.
      e.preventDefault();
      void Bridge.teamWindow("drag");
    }
  });
  root.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).hasAttribute("data-drag")) void Bridge.teamWindow("maximize");
  });

  // "18 minutes" has to move on its own — but only while someone can see it:
  // a hidden window keeps no timer.
  let tick = 0;
  const watch = () => {
    window.clearInterval(tick);
    if (document.hidden) return;
    tick = window.setInterval(() => {
      if (tab === "monitor" && [...runs.values()].some((r) => r.status === "running")) render();
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
