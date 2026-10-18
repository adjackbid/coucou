// Agent Center: the person calls on Coucou's secretary when they need it — to hear how
// the teams are doing, what waits for them, what it cost, or to have a team
// set up or told something. Agent Center (secretary.rs) reads Coucou's
// records freely; what it prepares comes back as cards, and only a click on
// a card's button makes it happen.
//
// The conversation lives in the app for as long as it runs; this page keeps
// what it shows, and is drawn inside the Teamwork window by main.ts.

import { forgetShow, pickShow, SHOW_MS, turnLeft, type Pick, type PoolAgent } from "./pick-show";
import "./secretary.css";
import { Bridge, IS_TAURI } from "../core/bridge";
import { tr, trf } from "../core/i18n";
import { h } from "../views/dom";
import { dropdown, editableText } from "./ui";
import { kbSaid, sizeText } from "./knowledge";
import { FACES, HUB, svgEl, teamAgents } from "./agents";
import { loadSkillLibrary, skillLibrary } from "./skill-lib";
import { kindIcon, markColor, markHint, markOf } from "../views/agent-kind";
import { locationOf, type AgentProfile } from "../core/state";
import type { LibrarySkill, SecretaryChat, SecretaryChoices, SecretaryProposal, SecretaryReply, SecretaryStep, SecretaryUpload } from "./types";

export interface SecretaryHost {
  render(): void;
  /** The team files changed (a team was created): read them again. */
  reload(): Promise<void>;
  /** Shows a team by its id. */
  openTeam(id: string): void;
  /** Agent Pool, for the picking animation. */
  pool(): PoolAgent[];
  /** The native agents (Settings → Agent Provider), for the picker's cards. */
  profiles(): AgentProfile[];
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
  /** Options to click, from offer_choices or read off a question that ends the answer. */
  choices?: SecretaryChoices;
}

/** Options ticked so far on a question that takes more than one. */
let ticked: string[] = [];

/** A list item's words: no marker, no bold. */
function itemText(line: string): string | null {
  const m = /^\s*(?:[-*•]|\d+[.)、]|[A-Ha-h][.)、]|\(?[A-Ha-h1-9]\)|[①-⑥])\s*(.+)$/.exec(line);
  return m ? m[1].replace(/\*\*/g, "").trim() : null;
}

/**
 * When a model asks a multiple-choice question in words: a question line and
 * 2–6 short list items next to it, at the end of the answer. Anything else is
 * left as words.
 */
export function guessChoices(text: string): SecretaryChoices | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // "你要哪一種?", "要做哪些頁面?(可複選)"; or a line that asks for a pick and ends in a colon.
  const isQuestion = (l: string) => /[?？]\s*([(（][^)）]*[)）])?\s*(\*\*)?$/.test(l) || (/[:：]\s*$/.test(l) && /選|哪|pick|choose|which|option/i.test(l));
  let end = lines.length;
  // A closing line after the list ("請選擇。", "選好跟我說"): one is allowed.
  if (end > 0 && itemText(lines[end - 1]) === null && !isQuestion(lines[end - 1])) end--;
  let start = end;
  while (start > 0 && itemText(lines[start - 1]) !== null) start--;
  const items = lines.slice(start, end).map((l) => itemText(l)!);
  if (items.length < 2 || items.length > 6 || items.some((o) => o.length > 80)) return undefined;
  const before = lines[start - 1];
  const after = lines[end];
  const question = before && isQuestion(before) ? before : after && isQuestion(after) ? after : null;
  if (!question) return undefined;
  return { question: question.replace(/\*\*/g, ""), options: items, multiple: /可複選|多選|可以選多個|choose (any|several)|select all/i.test(question) };
}

/** The options under an answer: a click answers with it; on the latest answer only. */
function choicesView(host: SecretaryHost, c: SecretaryChoices, live: boolean): HTMLElement {
  const pick = (o: string) => {
    if (!live || waiting) return;
    if (!c.multiple) return void ask(host, o);
    ticked = ticked.includes(o) ? ticked.filter((x) => x !== o) : [...ticked, o];
    host.render();
  };
  return h(
    "div",
    { class: `sec-choices${live ? "" : " past"}`, role: "group", "aria-label": c.question },
    ...c.options.map((o) =>
      h("button", { type: "button", class: `sec-choice${c.multiple && ticked.includes(o) ? " on" : ""}`, disabled: !live || waiting, "aria-pressed": c.multiple ? String(ticked.includes(o)) : undefined, onClick: () => pick(o) }, c.multiple ? h("span", { class: "sec-choice-box", "aria-hidden": "true" }) : null, h("span", { text: o })),
    ),
    c.multiple && live
      ? h(
          "button",
          {
            type: "button",
            class: "btn primary sec-choice-send", // i18n-ok: CSS classes
            disabled: !ticked.length || waiting,
            onClick: () => {
              const picked = ticked;
              ticked = [];
              void ask(host, picked.join(tr("、", ", ")));
            },
          },
          tr("送出選擇", "Send"),
        )
      : null,
    live ? h("span", { class: "hint", text: tr("或直接在下面輸入", "or type your own below") }) : null,
  );
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

/** Files dropped on the window while Agent Center's page is open, or picked. */
export function secretaryAttachPaths(paths: string[], host: SecretaryHost) {
  return attachAll(
    host,
    paths.map((path) => () => (IS_TAURI ? Bridge.secretaryUploadPath(path) : Promise.resolve(demoUpload(path.split(/[\\/]/).pop() || path, 2048)))),
  );
}

/** Files are over the window while Agent Center's page is open (or no longer). */
let dragging = false;
export function setSecretaryDragging(on: boolean, host: SecretaryHost) {
  if (dragging === on) return;
  dragging = on;
  host.render();
}

/** Files dropped on Agent Center's page, or pasted: they go with the next request. */
export function secretaryAttachFiles(files: File[], host: SecretaryHost) {
  return attachFiles(files, host);
}

function attachFiles(files: File[], host: SecretaryHost) {
  return attachAll(
    host,
    files.map((file) => async () => {
      const name = file.name || trf("貼上的圖片-{t}.png", "pasted-image-{t}.png", { t: Date.now() });
      return IS_TAURI ? Bridge.secretaryUploadBytes(name, await file.arrayBuffer()) : demoUpload(name, file.size);
    }),
  );
}

function pickFiles(host: SecretaryHost) {
  if (!IS_TAURI) return void secretaryAttachPaths([tr("D:\\Docs\\品牌指南.md", "D:\\Docs\\brand-guide.md"), tr("D:\\Docs\\首頁草圖.png", "D:\\Docs\\home-sketch.png")], host);
  Bridge.pickFiles(tr("附加檔案給 Agent Center", "Attach files for Agent Center"))
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
    { class: "attachment sec-file", title: `${f.name} · ${sizeText(f.bytes)}${f.keyLike ? tr(" · 疑似含金鑰", " · may hold a key") : ""}` },
    h("span", { "aria-hidden": "true", text: KIND_ICON[f.kind] }),
    h("span", { class: "attachment-name", text: f.name }),
    f.keyLike ? h("span", { class: "sec-file-key", text: "⚠" }) : null,
    remove ? h("button", { type: "button", class: "attachment-x", "aria-label": trf("移除 {name}", "Remove {name}", { name: f.name }), onClick: remove }, "×") : null,
  );
}

/** Questions to start with; they are sent as the person's own words. */
const suggestions = () => [
  tr("各團隊現在狀況如何?", "How are the teams doing?"),
  tr("有什麼在等我處理?", "What is waiting for me?"),
  tr("這週花了多少錢?", "How much did this week cost?"),
  tr("幫我開一個新團隊…", "Set up a new team for me…"),
];
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
/**
 * What the person calls Agent Center; empty until they name it, and then
 * shown as Agent Center. Earlier versions saved their default (\u79d8\u66f8) itself
 * ("\u79d8\u66f8" below): it still means no name. The name goes to Rust as it
 * is (secretary.rs treats "", \u79d8\u66f8 and Agent Center alike).
 */
let name = stored("coucou.secretary.name")?.trim() ?? "";
const OLD_DEFAULT = "\u79d8\u66f8";

/** Whether the person gave Agent Center a name of their own. */
const named = () => !!name && name !== OLD_DEFAULT && name !== "Agent Center";

export function secretaryName(): string {
  return named() ? name : "Agent Center";
}

/** The person's own instructions for Agent Center (its ⚙ → 自訂指示): they go after its system prompt. */
let instructions = stored("coucou.secretary.instructions") ?? "";

/** As long as secretary.rs keeps of them (MAX_INSTRUCTIONS). */
export const MAX_INSTRUCTIONS = 2000;

export function secretaryInstructions(): string {
  return instructions;
}

export function setSecretaryInstructions(v: string) {
  instructions = v.slice(0, MAX_INSTRUCTIONS);
  store("coucou.secretary.instructions", instructions);
}

export { skillLibrary, loadSkillLibrary } from "./skill-lib";

/** Skills Agent Center reads itself, by name; null: never set, so every `for: agent-center` skill. */
let centerSkills: string[] | null = storedNames("coucou.secretary.skills");
/** Skills the person took away from members, by name. */
let hiddenSkills: string[] = storedNames("coucou.secretary.skillsHidden") ?? [];

function storedNames(key: string): string[] | null {
  try {
    const got: unknown = JSON.parse(stored(key) ?? "null");
    return Array.isArray(got) ? got.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** Whether Agent Center reads this skill itself. */
export function centerReads(skill: LibrarySkill): boolean {
  return centerSkills ? centerSkills.includes(skill.name) : skill.forCenter;
}

export function setCenterReads(skill: LibrarySkill, on: boolean) {
  const now = new Set(centerSkills ?? (skillLibrary() ?? []).filter((s) => s.forCenter).map((s) => s.name));
  if (on) now.add(skill.name);
  else now.delete(skill.name);
  centerSkills = [...now];
  store("coucou.secretary.skills", JSON.stringify(centerSkills));
}

/** Whether Agent Center may hand this skill to a leader or member. */
export function membersGet(skill: LibrarySkill): boolean {
  return !skill.forCenter && !hiddenSkills.includes(skill.name);
}

export function setMembersGet(skill: LibrarySkill, on: boolean) {
  hiddenSkills = on ? hiddenSkills.filter((n) => n !== skill.name) : [...new Set([...hiddenSkills, skill.name])];
  store("coucou.secretary.skillsHidden", JSON.stringify(hiddenSkills));
}

/** What goes with each question: the names Agent Center reads, and the names members may not get. */
function skillChoices(): { skills: string[]; hidden: string[] } {
  // Not listed yet (asked before the library answered): Rust skips a name it cannot find.
  const listed = skillLibrary();
  if (!listed) return { skills: centerSkills ?? ["agent-center-planning"], hidden: hiddenSkills };
  const skills = centerSkills ? centerSkills.filter((n) => listed.some((s) => s.name === n)) : listed.filter((s) => s.forCenter).map((s) => s.name);
  return { skills, hidden: hiddenSkills };
}

// The library is listed once at start, so the first question already carries Agent Center's skills.
if (IS_TAURI) loadSkillLibrary(() => {});

/** Agent Center's picking shown as it proposes a team (pick-show.ts): off unless the person turns it on. */
let pickShowing = stored("coucou.secretary.pickShow") === "1";

/** Fast mode: the speed slider at 快 or 極速 (the earlier ⚙ switch is folded into it). */

/**
 * The speed slider by the chat box: 1 most thorough … 3 balanced … 5 fastest. It shapes
 * how Agent Center sizes and staffs a team and what it tells the leader; 4 and 5 are fast mode.
 */
let speed = Math.min(5, Math.max(1, Number(stored("coucou.secretary.speed") ?? (stored("coucou.secretary.fast") === "1" ? "4" : "3")) || 3));

export function secretarySpeed(): number {
  return speed;
}

export function setSecretarySpeed(v: number) {
  speed = Math.min(5, Math.max(1, Math.round(v) || 3));
  store("coucou.secretary.speed", String(speed));
}

/** The slider's levels, in the person's words. */
export function speedName(v: number): string {
  return [tr("最仔細", "Most thorough"), tr("仔細", "Thorough"), tr("平衡", "Balanced"), tr("快", "Fast"), tr("極速", "Fastest")][Math.min(5, Math.max(1, v)) - 1];
}

function speedHint(v: number): string {
  return [
    tr("準確第一:每份成果都有獨立審查,最終成果兩人審,可以來回修到好。", "Accuracy first: every deliverable gets an independent review, the final one two; work goes back until right."),
    tr("偏仔細:每份成果一次獨立審查,必要時再退回一次。", "Leaning thorough: one independent review per deliverable, one more round if needed."),
    tr("平衡:Agent Center 自己判斷題目大小、人數與審查方式。", "Balanced: Agent Center sizes the team and the reviewing itself."),
    tr("快:最小團隊、每個任務一次審查、不來回(快速模式)。", "Fast: the smallest team, one review per task, no second round (fast mode)."),
    tr("極速:一個人從頭做到尾,先交出可用版本再說;精細度最低。", "Fastest: one member does it all and delivers a usable first version; least polish."),
  ][Math.min(5, Math.max(1, v)) - 1];
}

/** The slider by the model picker. */
function speedBar(host: SecretaryHost): HTMLElement {
  const label = h("span", { class: "sec-speed-name", text: speedName(speed) });
  const input = h("input", { type: "range", min: "1", max: "5", step: "1", value: String(speed), "aria-label": tr("任務完成速度", "Speed of the work") }) as HTMLInputElement;
  input.addEventListener("input", () => {
    setSecretarySpeed(Number(input.value));
    label.textContent = speedName(speed);
    box.title = speedHint(speed);
    box.dataset.level = String(speed);
  });
  input.addEventListener("change", () => host.render());
  const box = h("label", { class: "sec-speed", "data-level": String(speed), title: speedHint(speed) }, h("span", { class: "sec-speed-icon", "aria-hidden": "true", text: "⚡" }), input, label);
  return box;
}

/** The root folder for new teams (its ⚙ → 根目錄): a team the person gave no folder gets a subfolder of it. */
let rootFolder = stored("coucou.secretary.root") ?? "";

export function secretaryRoot(): string {
  return rootFolder;
}

export function setSecretaryRoot(v: string) {
  rootFolder = v.trim();
  store("coucou.secretary.root", rootFolder);
}

export function fastModeOn(): boolean {
  return speed >= 4;
}

export function setFastModeOn(v: boolean) {
  setSecretarySpeed(v ? 4 : 3);
}

export function pickShowOn(): boolean {
  return pickShowing;
}

export function setPickShowOn(v: boolean) {
  pickShowing = v;
  store("coucou.secretary.pickShow", v ? "1" : "0");
}

/**
 * The picking, over the conversation while Agent Center works (pick-show.ts).
 * It starts when Agent Center looks at Agent Pool (list_agents, agent_models,
 * propose_team), lights each agent it looks at, and when the answer brings a
 * new team, locks on the members and goes away a moment after. `hidden`: the
 * person put it away; it stays away for this question. `preview`: played from
 * the ⚙, with made-up looking and picks.
 */
let show: { id: string; picks: Pick[] | null; seenAt: Record<string, number>; continued: boolean; hidden: boolean; preview: boolean; shownAt: number; leaving?: boolean } | null = null;
let showTimers: number[] = [];

/** How long the finished picking stays before it goes. */
const SHOW_LINGER = 2200;

function clearShowTimers() {
  for (const t of showTimers) clearTimeout(t);
  showTimers = [];
}

function dropShow() {
  clearShowTimers();
  if (show) forgetShow(show.id);
  show = null;
}

/** Fades the picking out, then takes it away. */
function endShow(host: SecretaryHost) {
  if (!show || show.leaving) return;
  clearShowTimers();
  show.leaving = true;
  host.render();
  showTimers.push(
    window.setTimeout(() => {
      dropShow();
      host.render();
    }, 250),
  );
}

/** Agent Center looked at Agent Pool: the looking starts (or goes on), with this agent lit. */
function lookedAt(step: SecretaryStep, host: SecretaryHost) {
  if (!pickShowOn() || !["list_agents", "agent_models", "propose_team"].includes(step.tool) || !host.pool().length) return;
  if (!show) show = { id: `scan-${Date.now()}`, picks: null, seenAt: {}, continued: false, hidden: false, preview: false, shownAt: performance.now() };
  if (show.picks === null && step.agent && !(step.agent in show.seenAt)) show.seenAt[step.agent] = performance.now();
}

/** The answer came: the members it picked lock on, then the picking goes; any other answer ends it. */
function answered(reply: SecretaryReply, host: SecretaryHost) {
  const team = reply.proposals.find((p) => p.kind === "team" && p.picks?.length);
  if (!team || !pickShowOn() || show?.hidden) {
    if (show) endShow(host);
    return;
  }
  lockOn(team.picks!, host, false);
}

/** The members lock on: straight away, or — after the looking — once its sweep is back at the top, so it carries on unbroken. */
function lockOn(picks: Pick[], host: SecretaryHost, preview: boolean) {
  clearShowTimers();
  const before = show;
  const apply = () => {
    if (before) forgetShow(before.id);
    show = { id: `lock-${Date.now()}`, picks, seenAt: before?.seenAt ?? {}, continued: !!before, hidden: false, preview, shownAt: before?.shownAt ?? performance.now() };
    // A preview stays until closed; a real one leaves the card to be read.
    if (!preview) showTimers.push(window.setTimeout(() => endShow(host), SHOW_MS + SHOW_LINGER));
    host.render();
  };
  if (before && before.picks === null) showTimers.push(window.setTimeout(apply, turnLeft(before.id)));
  else apply();
}

/** From Agent Center's ⚙: a moment of looking at a few agents, then a made-up pick, one per category first. */
export function previewPickShow(host: SecretaryHost) {
  const pool = host.pool();
  clearShowTimers();
  if (show) forgetShow(show.id);
  show = null;
  if (!pool.length) {
    show = { id: "empty", picks: [], seenAt: {}, continued: false, hidden: false, preview: true, shownAt: performance.now() };
    host.render();
    return;
  }
  const firsts = pool.filter((p, i) => p.category && pool.findIndex((q) => q.category === p.category) === i);
  const chosen = [...firsts, ...pool.filter((p) => !firsts.includes(p))].slice(0, Math.min(4, pool.length));
  const picks = chosen.map((p, i) => ({ agent: p.id, name: `AI ${i + 1}`, role: p.category || tr("成員", "Member"), leader: i === 0 }));
  show = { id: `scan-${Date.now()}`, picks: null, seenAt: {}, continued: false, hidden: false, preview: true, shownAt: performance.now() };
  host.render();
  // Looking: a few agents, picked ones among them, one after another.
  const looked = [...new Set([chosen[0], pool[pool.length - 1], ...chosen.slice(1), pool[Math.floor(pool.length / 2)]])].filter(Boolean).slice(0, 5);
  looked.forEach((p, i) =>
    showTimers.push(
      window.setTimeout(() => {
        if (show?.preview && show.picks === null && !(p.id in show.seenAt)) {
          show.seenAt[p.id] = performance.now();
          host.render();
        }
      }, 500 + i * 450),
    ),
  );
  showTimers.push(
    window.setTimeout(() => {
      if (!show?.preview) return;
      lockOn(picks, host, true);
    }, 700 + looked.length * 450),
  );
}

function showOverlay(host: SecretaryHost): HTMLElement | null {
  if (!show || show.hidden) return null;
  const shown = show;
  const away = () => {
    if (shown.preview || shown.picks) return endShow(host);
    // Still looking: put away for this question.
    shown.hidden = true;
    host.render();
  };
  return h(
    "div",
    {
      class: `ps-overlay${shown.preview ? "" : " live"}${shown.leaving ? " leaving" : ""}`,
      // Faded in once, when it first came: a redraw does not fade it in again.
      style: `animation-delay:${shown.shownAt - performance.now()}ms`,
      onClick: (e: Event) => e.target === e.currentTarget && away(),
    },
    h(
      "div",
      { class: "stack", style: "width:min(900px,100%)" },
      host.pool().length
        ? pickShow(shown.id, shown.picks, host.pool(), { seenAt: shown.seenAt, continued: shown.continued })
        : h("p", { class: "problem", text: tr("Agent Pool 裡還沒有 Agent,沒有東西可以挑。", "Agent Pool has no agents yet: there is nothing to pick from.") }),
      h(
        "div",
        { class: "ps-overlay-foot" },
        shown.preview ? h("button", { class: "btn plain", type: "button", onClick: () => previewPickShow(host) }, tr("再播一次", "Play again")) : null,
        h("button", { class: "btn primary", type: "button", onClick: away }, shown.preview ? tr("關閉", "Close") : shown.picks ? tr("看提案", "See the proposal") : tr("隱藏", "Hide")),
      ),
    ),
  );
}

export function setSecretaryName(v: string) {
  name = v.trim();
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

/** A step Agent Center took, as it happens (`secretary-step`). */
export function onStep(step: SecretaryStep, host: SecretaryHost) {
  if (!waiting) return;
  live.push(step);
  lookedAt(step, host);
  stick = true;
  host.render();
}

async function ensureProviders(host: SecretaryHost) {
  if (providers) return;
  providers = IS_TAURI ? ((await Bridge.secretaryProviders()) ?? []) : [["custom", "Custom", "deepseek-v4-flash"]]; // i18n-ok: demo provider name, as Settings names it
  // Rust lists the provider Settings marks 使用中 first. The Settings page
  // promises Agent Center uses that one, so when it changes (in Settings,
  // while Teamwork is open or not) Agent Center follows; the dropdown here
  // only switches away until the next change in Settings.
  const active = providers[0]?.[0] ?? "";
  const seen = stored("coucou.secretary.activeSeen");
  if (!providers.some((p) => p[0] === provider) || (seen !== null && seen !== active)) {
    provider = active;
    store("coucou.secretary.provider", provider);
  }
  store("coucou.secretary.activeSeen", active);
  host.render();
}

/**
 * Settings changed (a provider added or removed, renamed, its model edited,
 * another marked 使用中): the list is read again so the dropdown says what
 * Settings says, and a new 使用中 becomes Agent Center's model. Nothing to
 * do before the list was first read: that read is fresh anyway.
 */
export async function refreshProviders(host: SecretaryHost) {
  if (!providers) return;
  providers = null;
  await ensureProviders(host);
}

/**
 * Asks Agent Center from another page (成本分析): the exchange joins the
 * conversation, and the answer — or why there is none — comes back as words.
 */
export async function consult(text: string, render: () => void): Promise<string> {
  if (waiting) return named() ? trf("{name}還在處理上一件事,稍等一下再試。", "{name} is still on the last request: try again in a moment.", { name }) : tr("Agent Center 還在處理上一件事,稍等一下再試。", "Agent Center is still on the last request: try again in a moment.");
  if (!providers) await ensureProviders({ render, reload: async () => {}, openTeam: () => {}, pool: () => [], profiles: () => [] });
  await ask({ render, reload: async () => {}, openTeam: () => {}, pool: () => [], profiles: () => [] }, text, false);
  const last = entries[entries.length - 1];
  return last?.who === "error" ? trf("沒有成功:{why}", "Didn't work: {why}", { why: last.text }) : (last?.text ?? "");
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
  // A new question: whatever picking was on screen is over.
  dropShow();
  host.render();
  try {
    const reply: SecretaryReply = IS_TAURI
      ? await Bridge.secretaryAsk(words, provider || null, tz(), name, files.map((f) => f.id), instructions.trim(), skillChoices().skills, skillChoices().hidden, speed >= 4, rootFolder, speed)
      : await (await import("./demo")).demoSecretary(words, (step) => onStep(step, host));
    const unused = unusedUploads(files, reply.proposals);
    entries.push({ who: "secretary", text: reply.text, steps: reply.steps, proposals: reply.proposals, unused: unused.length ? unused : undefined, choices: reply.choices ?? guessChoices(reply.text) });
    ticked = [];
    answered(reply, host);
    void persist();
  } catch (err) {
    entries.push({ who: "error", text: String(err instanceof Error ? err.message : err) });
    dropShow();
  }
  waiting = false;
  live = [];
  stick = true;
  host.render();
}

/**
 * 對話紀錄: every conversation is saved as it goes (Agent Center's side in Rust, the
 * entries here), and 新對話 starts another; the list brings an earlier one back.
 */
let chats: SecretaryChat[] | null = null;
let chatsOpen = false;

function chatTitle(): string {
  return entries.find((e) => e.who === "you")?.text.trim().split("\n")[0].slice(0, 60) ?? "";
}

/** Saves the conversation on screen; nothing before anything was said. */
async function persist() {
  if (!IS_TAURI || !entries.length) return;
  try {
    await Bridge.secretaryChatSave(chatTitle(), JSON.stringify(entries));
    chats = null;
  } catch {
    // Not saved this time: it is saved again after the next answer.
  }
}

async function toggleChats(host: SecretaryHost) {
  chatsOpen = !chatsOpen;
  if (chatsOpen) {
    await persist();
    chats = IS_TAURI ? ((await Bridge.secretaryChats()) ?? []) : [];
  }
  host.render();
}

async function openChat(host: SecretaryHost, id: string) {
  if (waiting) return;
  await persist();
  try {
    const json = await Bridge.secretaryChatOpen(id);
    const back = JSON.parse(json) as Entry[];
    entries = Array.isArray(back) ? back : [];
    pending = [];
    heldKey = [];
    uploadProblems = [];
    ticked = [];
    dropShow();
    chatsOpen = false;
    chats = null;
    stick = true;
  } catch (err) {
    entries.push({ who: "error", text: String(err instanceof Error ? err.message : err) });
  }
  host.render();
}

async function deleteChat(host: SecretaryHost, c: SecretaryChat) {
  if (!confirmDelete(c)) return;
  try {
    await Bridge.secretaryChatDelete(c.id);
    chats = (chats ?? []).filter((x) => x.id !== c.id);
  } catch (err) {
    entries.push({ who: "error", text: String(err instanceof Error ? err.message : err) });
  }
  host.render();
}

function confirmDelete(c: SecretaryChat): boolean {
  return typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(trf("刪除對話「{title}」?", "Delete the conversation \"{title}\"?", { title: c.title })) : true;
}

function chatList(host: SecretaryHost): HTMLElement {
  const list = chats ?? [];
  return h(
    "div",
    { class: "sec-chats" },
    h("div", { class: "sec-chats-head" }, h("b", { text: tr("對話紀錄", "Conversations") }), h("button", { class: "link", type: "button", onClick: () => { chatsOpen = false; host.render(); } }, tr("關閉", "Close"))),
    list.length
      ? h(
          "div",
          { class: "sec-chats-list" },
          ...list.map((c) =>
            h(
              "div",
              { class: `sec-chat${c.current ? " on" : ""}` },
              h("button", { class: "sec-chat-open", type: "button", disabled: waiting || c.current, onClick: () => void openChat(host, c.id) }, h("span", { class: "sec-chat-title", text: c.title }), h("span", { class: "dim", text: `${new Date(c.updatedMs).toLocaleString()}${c.current ? tr(" · 現在這段", " · on screen") : ""}` })),
              h("button", { class: "sec-chat-del", type: "button", title: tr("刪除", "Delete"), "aria-label": tr("刪除這段對話", "Delete this conversation"), onClick: () => void deleteChat(host, c) }, "✕"),
            ),
          ),
        )
      : h("p", { class: "dim", text: tr("還沒有存下來的對話。每段對話在 Agent Center 回答後會自動保存。", "No saved conversations yet. Each one is saved as Agent Center answers.") }),
  );
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
    const missing = IS_TAURI ? await Bridge.secretaryMissingFolder(p.id) : (/(?:工作資料夾|Work folder):\s*(.+?)\s*\((?:還不存在|doesn't exist yet)/.exec(p.lines.join("\n"))?.[1] ?? null);
    if (missing) {
      askFolder.set(p.id, missing);
      host.render();
      return;
    }
  }
  doing.add(p.id);
  host.render();
  try {
    const done = IS_TAURI ? await Bridge.secretaryConfirm(p.id, tz(), createFolder) : { ...p, state: "done" as const, outcome: tr("(瀏覽器預覽,沒有真的執行)", "(browser preview, nothing was really run)") };
    replace(done);
    if (p.kind === "team") await host.reload();
  } catch (err) {
    replace({ ...p, state: "failed", outcome: String(err instanceof Error ? err.message : err) });
  }
  doing.delete(p.id);
  host.render();
  void persist();
}

/** 取消 on "create the folder?": nothing is created, the team is not opened, and the card is cancelled. */
async function keepOut(host: SecretaryHost, p: SecretaryProposal) {
  askFolder.delete(p.id);
  await decline(host, p, tr("沒有建立資料夾,團隊也沒有開", "No folder was created and the team was not opened"));
}

/**
 * 調整人選 on a team card: Agent Center picked first, and the person changes the
 * team by ticking Agent Pool's cards. One draft per team agent, in Agent Pool's
 * order, plus any member picked from outside it (a provider by its id).
 */
interface PickDraft {
  agent: string;
  name: string;
  role: string;
  leader: boolean;
  on: boolean;
}

const picking = new Map<string, PickDraft[]>();

function startPick(host: SecretaryHost, p: SecretaryProposal) {
  const picks = p.picks ?? [];
  const drafts: PickDraft[] = teamAgents().map((a) => {
    const had = picks.find((k) => k.agent === a.id);
    return { agent: a.id, name: had?.name ?? (a.name || a.id), role: had?.role ?? "", leader: had?.leader ?? false, on: !!had };
  });
  for (const k of picks) if (!drafts.some((d) => d.agent === k.agent)) drafts.push({ agent: k.agent, name: k.name, role: k.role, leader: k.leader, on: true });
  picking.set(p.id, drafts);
  openPickModal(host, p);
  host.render();
}

/** The picker window, one at a time; it draws itself again on every tick. */
let pickModal: { id: string; el: HTMLElement; draw: () => void; close: () => void } | null = null;

function closePickModal() {
  pickModal?.close();
}

/**
 * The picker, over the whole window: Agent Pool's ring on the left — the
 * Local Agents inside the company's edge, the Cloud Agents outside, Agent
 * Center in the middle — where a click puts an agent in or out of the team;
 * on the right, who is in, with a role and the Leader. 套用人選 asks Agent
 * Center to redo the plan with them.
 */
function openPickModal(host: SecretaryHost, p: SecretaryProposal) {
  closePickModal();
  const el = h("div", { class: "sec-pick-overlay", role: "dialog", "aria-modal": "true", "aria-label": tr("調整人選", "Change members") });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cancel();
  };
  const close = () => {
    el.remove();
    document.removeEventListener("keydown", onKey);
    if (pickModal?.id === p.id) pickModal = null;
  };
  const cancel = () => {
    if (doing.has(p.id)) return;
    picking.delete(p.id);
    close();
    host.render();
  };
  const draw = () => {
    const drafts = picking.get(p.id) ?? [];
    const chosen = drafts.filter((d) => d.on);
    const leader = chosen.find((d) => d.leader) ?? chosen[0];
    const busy = doing.has(p.id);
    const natives = host.profiles();
    const agents = teamAgents();
    const baseOf = (d: PickDraft) => {
      const a = agents.find((x) => x.id === d.agent);
      return { a, base: a ? natives.find((n) => n.id === a.base) : natives.find((n) => n.id === d.agent) };
    };
    // Rings as Agent Pool draws them: Local inside the company's edge, Cloud outside.
    const placed = drafts.map((d, i) => ({ d, i, ...baseOf(d) }));
    const whereOf = (x: { base: AgentProfile | undefined }) => (x.base ? locationOf(x.base) : "cloud");
    const rings = (["local", "cloud"] as const).map((where) => ({ where, list: placed.filter((x) => whereOf(x) === where) })).filter((r) => r.list.length);
    const room = (n: number) => (n * 104) / (2 * Math.PI);
    const local = rings.find((r) => r.where === "local");
    const cloud = rings.find((r) => r.where === "cloud");
    const rLocal = local ? Math.max(170, room(local.list.length)) : 0;
    const edge = local ? rLocal + 70 : 120;
    const rCloud = cloud ? Math.max(edge + 90, 240, room(cloud.list.length)) : 0;
    const R = Math.max(edge, rCloud);
    const S = 2 * R + 190;
    const cx = S / 2, cy = S / 2 - 8;
    const lines = svgEl("svg", { class: "ta-ring-lines", viewBox: `0 0 ${S} ${S}`, "aria-hidden": "true" });
    lines.append(svgEl("circle", { class: "ta-ring-inside", cx, cy, r: edge }));
    for (const r of rings) lines.append(svgEl("circle", { class: `ta-ring-orbit ${r.where}`, cx, cy, r: r.where === "local" ? rLocal : rCloud }));
    const nodes: HTMLElement[] = [];
    for (const r of rings) {
      const radius = r.where === "local" ? rLocal : rCloud;
      const step = (2 * Math.PI) / r.list.length;
      r.list.forEach((x, j) => {
        const t = -Math.PI / 2 + j * step + (r.where === "local" ? step / 2 : 0);
        const px = cx + radius * Math.cos(t), py = cy + radius * Math.sin(t);
        if (x.d.on) {
          lines.append(svgEl("line", { class: "ta-ring-link", x1: cx, y1: cy, x2: px, y2: py }));
          lines.append(svgEl("circle", { class: "ta-ring-knot", cx: (cx + px) / 2, cy: (cy + py) / 2, r: 4 }));
        }
        const mark = x.base ? markOf(x.base) : "cloud";
        const face = FACES[x.i % FACES.length];
        const model = x.a?.model || x.base?.model || "";
        const tip = [x.a?.name || x.base?.name || x.d.agent, `${x.base ? `${x.base.name}` : tr("Provider 不存在", "Provider missing")}${model ? ` · ${model}` : ""}`, x.a?.description, x.d.on ? tr("按一下移出團隊", "Click to take it out") : tr("按一下加入團隊", "Click to put it in")].filter(Boolean).join("\n");
        nodes.push(h(
          "button",
          {
            type: "button",
            class: `ta-node sec-ring-node${x.base ? "" : " broken"}${x.d.on ? " lit on" : ""}${x.d.leader ? " leader" : ""}`,
            style: `left:${(px / S) * 100}%;top:${(py / S) * 100}%;--c:${face};--m:${markColor(mark)}`,
            title: tip,
            "aria-pressed": String(x.d.on),
            disabled: busy,
            onClick: () => {
              x.d.on = !x.d.on;
              if (!x.d.on) x.d.leader = false;
              draw();
            },
          },
          h("span", { class: "ta-node-ring" }, h("i", { class: "blob", style: `--c:${face};--s:26px`, "aria-hidden": "true" }), h("i", { class: "sec-ring-tick", "aria-hidden": "true", text: x.d.leader ? "★" : "✓" })),
          h("span", { class: "ta-node-name" }, kindIcon(mark, 12), h("span", { text: x.a?.name || x.base?.name || x.d.agent })),
          h("span", { class: `ta-node-cat${x.a?.category.trim() ? "" : " none"}`, text: x.a?.category.trim() || (x.a ? tr("未分類", "Uncategorized") : tr("Provider", "Provider")) }), // i18n-ok: the same in both
        ));
      });
    }
    const zone = (r: number, where: "local" | "cloud") => h("span", { class: `ta-ring-zone ${where}`, style: `left:${((cx + r * Math.cos(Math.PI / 2)) / S) * 100}%;top:${((cy + r * Math.sin(Math.PI / 2)) / S) * 100}%`, title: markHint(where) }, kindIcon(where, 14), h("span", { text: where === "local" ? tr("內部 · 地端服務", "Inside · on-premises") : tr("外部 · 雲端服務", "Outside · cloud services") }));
    const stage = h("div", { class: "ta-ring sec-pick-ring" },
      h("div", { class: "ta-ring-stage" },
        h("div", { class: "ta-ring-field" },
          lines,
          h("div", { class: `ta-ring-hub${chosen.length ? " on" : ""}`, style: `left:${(cx / S) * 100}%;top:${(cy / S) * 100}%` }, h("span", { class: "ta-ring-core", html: HUB }), h("b", { text: "Agent Center" })), // i18n-ok: the same in both
          zone(edge, "local"),
          cloud ? zone(rCloud, "cloud") : null,
          ...nodes,
          drafts.length ? null : h("p", { class: "ta-ring-empty", text: tr("Agent Pool 還沒有 Agent。", "Agent Pool has no agents yet.") }))));
    const row = (d: PickDraft) => {
      const { a, base } = baseOf(d);
      const face = FACES[drafts.indexOf(d) % FACES.length];
      return h("div", { class: `sec-pick-row${d.leader ? " leader" : ""}`, style: `--c:${face}` },
        h("i", { class: "blob", style: `--c:${face};--s:24px`, "aria-hidden": "true" }),
        h("div", { class: "sec-pick-row-text" },
          h("b", {}, base ? kindIcon(markOf(base), 13) : null, h("span", { text: a?.name || base?.name || d.agent })),
          h("div", { class: "sec-pick-role" },
            h("input", { type: "text", value: d.role, placeholder: tr("角色(選填)", "Role (optional)"), maxlength: "20", disabled: busy, onInput: (e: Event) => { d.role = (e.target as HTMLInputElement).value; } }),
            h("label", { class: `sec-pick-lead${d.leader ? " on" : ""}` },
              h("input", { type: "radio", name: `sec-lead-${p.id}`, checked: d.leader, disabled: busy, onChange: () => { for (const x of drafts) x.leader = false; d.leader = true; draw(); } }),
              "Leader"))), // i18n-ok: the same in both
        h("button", { type: "button", class: "sec-pick-out", title: tr("移出團隊", "Take out of the team"), "aria-label": trf("移出 {name}", "Take {name} out", { name: a?.name || d.agent }), disabled: busy, onClick: () => { d.on = false; d.leader = false; draw(); } }, "✕"));
    };
    const side = h("aside", { class: "sec-pick-side" },
      h("div", { class: "sec-pick-side-head" }, h("b", { text: tr("這次的團隊", "This team") }), h("span", { class: "count", text: `${chosen.length} / ${drafts.length}` })),
      chosen.length
        ? h("div", { class: "sec-pick-rows" }, ...chosen.map(row))
        : h("p", { class: "hint", text: tr("還沒有人。點左邊環上的 Agent 加入。", "No one yet. Click an agent on the ring to put it in.") }),
      h("p", { class: "hint", text: tr("可以填角色、指定 Leader;沒選的不會進團隊。套用後 Agent Center 會照這份名單重擬計畫。", "Give them a role and pick the Leader; unpicked ones stay out. Agent Center redoes the plan with this list.") }));
    el.replaceChildren(
      h("div", { class: "sec-pick-modal" },
        h("div", { class: "sec-pick-modal-head" },
          h("div", {}, h("h2", { text: tr("調整人選", "Change members") }), h("p", { class: "hint", text: trf("「{team}」:Agent Center 先選了 {n} 位,你可以改。", "“{team}”: Agent Center picked {n}; change it as you like.", { team: p.title, n: (p.picks ?? []).length }) })),
          h("button", { type: "button", class: "sec-pick-close", "aria-label": tr("關閉", "Close"), disabled: busy, onClick: cancel }, "✕")),
        h("div", { class: "sec-pick-modal-body" }, stage, side),
        h("div", { class: "sec-pick-modal-foot" },
          h("span", { class: "hint", text: p.outcome && p.state === "open" && picking.has(p.id) ? p.outcome : chosen.length ? trf("{n} 位,Leader:{who}", "{n} members, Leader: {who}", { n: chosen.length, who: leader?.name ?? "" }) : tr("還沒有選任何人", "No one is picked yet") }),
          h("span", { style: "flex:1" }),
          h("button", { class: "btn plain", type: "button", disabled: busy, onClick: cancel }, tr("取消", "Cancel")),
          h("button", { class: "btn primary", type: "button", disabled: busy || !chosen.length, onClick: () => void applyPick(host, p) }, busy ? tr("處理中…", "Working…") : tr("套用人選", "Use these members")))));
  };
  el.addEventListener("click", (e) => { if (e.target === el) cancel(); });
  document.addEventListener("keydown", onKey);
  document.body.append(el);
  pickModal = { id: p.id, el, draw, close };
  draw();
}

async function applyPick(host: SecretaryHost, p: SecretaryProposal) {
  const drafts = picking.get(p.id) ?? [];
  const members = drafts.filter((d) => d.on).map(({ agent, name, role, leader }) => ({ agent, name, role: role.trim(), leader }));
  if (!members.length) return;
  if (!members.some((m) => m.leader)) members[0].leader = true;
  doing.add(p.id);
  pickModal?.draw();
  host.render();
  try {
    const revised = IS_TAURI
      ? await Bridge.secretaryReviseTeam(p.id, members, tz())
      : { ...p, picks: members, lines: p.lines.filter((l) => !/ · /.test(l)).concat(members.map((m) => `${m.name}${m.leader ? tr("(Leader)", " (Leader)") : ""} · ${m.role || "—"} · ${m.agent}`)) };
    replace(revised);
    picking.delete(p.id);
    doing.delete(p.id);
    closePickModal();
  } catch (err) {
    replace({ ...p, outcome: String(err instanceof Error ? err.message : err) });
    doing.delete(p.id);
    pickModal?.draw();
  }
  host.render();
  void persist();
}

async function decline(host: SecretaryHost, p: SecretaryProposal, why = "") {
  const done = IS_TAURI ? await Bridge.secretaryDecline(p.id) : { ...p, state: "declined" as const };
  replace({ ...(done ?? { ...p, state: "declined" as const }), outcome: why });
  host.render();
  void persist();
}

/** Agent Center's words: line breaks, **bold**, `code` and "- " lists, nothing else. */
/** A Markdown table's row: its cells, or null when the line is not one. */
function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|") || t.length < 3) return null;
  return t.slice(1, -1).split("|").map((c) => c.trim());
}

function words(text: string): HTMLElement {
  const box = h("div", { class: "sec-words" });
  let list: HTMLElement | null = null;
  let table: HTMLTableElement | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    // Markdown tables: the first row heads it, the |---| line is skipped.
    const row = cells(line);
    if (row) {
      list = null;
      if (row.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) {
        box.append(h("div", { class: "sec-table-wrap" }, (table = h("table", { class: "sec-table" }))));
        table.append(h("tr", {}, ...row.map((c) => inline(h("th"), c))));
      } else table.append(h("tr", {}, ...row.map((c) => inline(h("td"), c))));
      continue;
    }
    table = null;
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
        h("p", {}, tr("資料夾 ", "The folder "), h("code", { text: folder }), tr(" 不存在,要建立它嗎?", " doesn't exist. Create it?")),
        h(
          "div",
          { class: "sec-card-actions" },
          h("button", { class: "btn primary", type: "button", onClick: () => void confirm(host, p, true) }, tr("建立", "Create")),
          h("button", { class: "btn plain", type: "button", onClick: () => void keepOut(host, p) }, tr("取消", "Cancel")),
          h("span", { class: "hint", text: p.kind === "team" ? tr("建立資料夾後才會開這個團隊", "The team opens once the folder is created") : tr("建立資料夾後才會啟動", "It starts once the folder is created") }),
        ),
      )
    :
    p.state === "done"
      ? h("div", { class: "sec-card-state done" }, h("span", { text: p.outcome ? trf("✓ 已完成:{what}", "✓ Done: {what}", { what: p.outcome }) : tr("✓ 已完成", "✓ Done") }))
      : p.state === "declined"
        ? h("div", { class: "sec-card-state", text: p.outcome ? trf("已取消:{why}", "Cancelled: {why}", { why: p.outcome }) : tr("已取消", "Cancelled") })
        : p.state === "failed"
          ? h("div", { class: "sec-card-state failed", text: trf("沒有成功:{why}", "Didn't work: {why}", { why: p.outcome }) })
          : picking.has(p.id)
            ? h(
                "div",
                { class: "sec-card-actions" },
                h("button", { class: "btn primary", type: "button", disabled: busy, onClick: () => openPickModal(host, p) }, tr("打開挑人視窗", "Open the picker")),
                h("button", { class: "btn plain", type: "button", disabled: busy, onClick: () => { closePickModal(); picking.delete(p.id); host.render(); } }, tr("取消", "Cancel")),
                h("span", { class: "hint", text: tr("正在調整人選", "Changing the members") }),
              )
            : h(
                "div",
                { class: "sec-card-actions" },
                h("button", { class: "btn primary", type: "button", disabled: busy, onClick: () => void confirm(host, p) }, busy ? tr("處理中…", "Working…") : p.confirm),
                p.kind === "team" ? h("button", { class: "btn plain", type: "button", disabled: busy, onClick: () => startPick(host, p) }, tr("調整人選", "Change members")) : null,
                h("button", { class: "btn plain", type: "button", disabled: busy, onClick: () => void decline(host, p) }, tr("不用了", "No thanks")),
                h("span", { class: "hint", text: p.outcome && p.state === "open" ? p.outcome : tr("按下才會執行", "Nothing happens until you click") }),
              );
  const team = p.state === "done" ? /\(id ([A-Za-z0-9_-]+)\)/.exec(p.outcome)?.[1] : undefined;
  return h(
    "div",
    { class: `sec-card ${p.state}` },
    h("div", { class: "sec-card-head" }, h("span", { class: "sec-card-kind", text: p.kind === "team" ? tr("新團隊", "New team") : p.kind === "instruction" ? tr("指令", "Instruction") : tr("操作", "Action") }), h("b", { text: p.title })),
    h("ul", { class: "sec-card-lines" }, ...p.lines.map((l) => h("li", { text: l }))),
    state,
    team ? h("button", { class: "link", type: "button", onClick: () => host.openTeam(team) }, tr("打開這個團隊 →", "Open this team →")) : null,
  );
}

/** `?view=secretary&ask=…` in a browser asks once, to look at a conversation. */
let asked = false;

/** The page's title: Agent Center's name, changed by clicking it. */
export function secretaryTitle(host: SecretaryHost): HTMLElement {
  return editableText("secretary", secretaryName(), {
    tag: "b",
    className: "sec-title",
    label: tr("Agent Center 的名字", "Agent Center's name"),
    // Left empty, it goes back to the default name (in the language of the moment).
    fallback: "",
    maxLength: 20,
    onSave: (v) => {
      // The default name kept as it was stays the default, not a name in one language.
      if (!name && v === secretaryName()) return;
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
        h("h2", { text: named() ? trf("我是{name},需要什麼跟我說", "I'm {name}. Tell me what you need", { name }) : tr("我是 Agent Center,需要什麼跟我說", "I'm Agent Center. Tell me what you need") }),

        h("p", { class: "dim", text: tr("我會查 Agent Center 的紀錄回答你:各團隊進度、誰卡住、誰在等你、花了多少錢。也可以請我開新團隊、給團隊下指令、暫停或封存團隊——我先擬好,你按確認才會執行。", "I answer from Agent Center's records: how each team is getting on, who is stuck, who is waiting for you, what it cost. You can also ask me to set up a team, give a team an instruction, or pause or archive one: I prepare it, and it happens only when you confirm.") }),
        h("div", { class: "sec-suggest" }, ...suggestions().map((s) => h("button", { class: "chip pick", type: "button", onClick: () => (s.endsWith("…") ? ((draft = s.replace("…", ":")), host.render()) : void ask(host, s)) }, s))),
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
    else {
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
            e.choices ? choicesView(host, e.choices, e === entries[entries.length - 1]) : null,
            e.unused?.length
              ? h(
                  "div",
                  { class: "sec-unused" },
                  h("span", { class: "hint", text: e.unused.length === 1 ? tr("附加的 1 個檔案還沒放進任何團隊", "The attached file isn't in any team yet") : trf("附加的 {n} 個檔案還沒放進任何團隊", "{n} attached files aren't in any team yet", { n: e.unused.length }) }),
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
                    tr("放回輸入列", "Put back in the input"),
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
                    tr("丟掉", "Discard"),
                  ),
                )
              : null,
          ),
        ),
      );
    }
  }
  if (waiting) list.append(h("div", { class: "sec-row" }, h("div", { class: "sec-bubble thinking" }, steps(live, true), h("span", { class: "sec-dots", "aria-label": tr("處理中", "Working") }, h("i"), h("i"), h("i")))));
  if (stick) {
    stick = false;
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  }

  const input = h("textarea", {
    class: "field sec-input",
    rows: "2",
    "data-key": "secretary-input",
    placeholder: dragging ? tr("放開就附加這些檔案", "Drop to attach these files") : tr("例如:各團隊現在怎麼樣?/幫我開一個做官網的團隊,資料夾 D:\\Code\\site(可以直接把檔案拖進來或貼上)", "e.g. How are the teams doing? / Set up a team to build our website in D:\\Code\\site (you can drag files in or paste them)"),
    spellcheck: "false",
  }) as HTMLTextAreaElement;
  input.value = draft;
  input.addEventListener("input", () => (draft = input.value));
  // A pasted picture or file goes with the request. Files copied in
  // Explorer may reach the page as nothing it can read: their paths come
  // from the clipboard itself.
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      void attachFiles(files, host);
      return;
    }
    const types = [...(e.clipboardData?.types ?? [])];
    if (!IS_TAURI || types.includes("text/plain")) return;
    e.preventDefault();
    void Bridge.clipboardFiles().then((paths) => (paths.length ? secretaryAttachPaths(paths, host) : undefined));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void ask(host, input.value);
    }
  });
  const choices = (providers ?? []).map(([id, name, model]) => ({ value: id, label: `${name} · ${model}`, hint: tr("Agent Center 用這個聊天模型思考", "Agent Center thinks with this chat model") }));
  return h(
    "div",
    { class: "secretary" },
    list,
    showOverlay(host),
    h(
      "div",
      { class: `sec-composer${dragging ? " over" : ""}` },
      uploadProblems.length ? h("div", { class: "problem", role: "alert" }, ...uploadProblems.map((p) => h("div", { text: p }))) : null,
      ...heldKey.map((f) =>
        h(
          "div",
          { class: "kb-held", role: "alert" },
          h("p", {}, h("b", { text: f.name }), trf(" 第 {line} 行看起來有金鑰({sample})。放進知識庫後,看得到它的成員都會讀到,並送到它們的模型服務。", " seems to hold a key on line {line} ({sample}). In the knowledge base, every member who can see it reads it and sends it to its model service.", { line: f.keyLike?.line ?? "?", sample: f.keyLike?.sample ?? "" })),
          h(
            "div",
            { class: "row end" },
            h("button", { type: "button", class: "btn plain", onClick: () => (dropUpload(f.id), host.render()) }, tr("取消", "Cancel")),
            h("button", { type: "button", class: "btn danger", onClick: () => void keepKeyed(host, f) }, tr("仍要加入", "Add anyway")),
          ),
        ),
      ),
      pending.length ? h("div", { class: "attachments sec-files" }, ...pending.map((f) => fileChip(f, () => (dropUpload(f.id), host.render())))) : null,
      chatsOpen ? chatList(host) : null,
      input,
      h(
        "div",
        { class: "sec-composer-row" },
        choices.length
          ? dropdown({ value: provider, choices, className: "sec-model", title: tr("Agent Center 用哪個聊天模型（設定 → 聊天模型）", "Which chat model Agent Center uses (Settings → Chat models)"), onChange: (v) => ((provider = v), store("coucou.secretary.provider", v), host.render()) })
          : providers
            ? h("button", { class: "link hint", type: "button", onClick: () => void Bridge.openSettingsPage("chat") }, tr("還沒有聊天模型：到「設定 → 聊天模型」新增一個", "No chat model yet: add one in Settings → Chat models"))
            : h("span", { class: "hint", text: "" }),
        speedBar(host),
        instructions.trim() ? h("span", { class: "chip sec-own", title: trf("自訂指示(在側欄 Agent Center 的 ⚙ 裡改):\n{text}", "Your instructions (change them under Agent Center's ⚙ in the sidebar):\n{text}", { text: instructions.trim() }), text: tr("已套用自訂指示", "Your instructions on") }) : null,
        h("button", { class: "link sec-attach", type: "button", title: tr("附加檔案(也可以拖進視窗或貼上圖片):要放進團隊知識庫的設計稿、規格、圖片…", "Attach files (or drag them onto the window, or paste a picture): designs, specs, pictures for a team's knowledge base…"), disabled: waiting, onClick: () => pickFiles(host) }, tr("📎 附加檔案", "📎 Attach files")),
        h("span", { class: "grow" }),
        IS_TAURI ? h("button", { class: `link${chatsOpen ? " on" : ""}`, type: "button", disabled: waiting, title: tr("切回之前的對話", "Go back to an earlier conversation"), onClick: () => void toggleChats(host) }, tr("對話紀錄", "Conversations")) : null,
        entries.length
          ? h(
              "button",
              {
                class: "link",
                type: "button",
                disabled: waiting,
                onClick: () => {
                  void (async () => {
                    // The one on screen is kept: 對話紀錄 brings it back.
                    await persist();
                    entries = [];
                    pending = [];
                    heldKey = [];
                    uploadProblems = [];
                    chatsOpen = false;
                    await Bridge.secretaryReset();
                    host.render();
                  })();
                },
              },
              tr("新對話", "New conversation"),
            )
          : null,
        h("button", { class: "btn primary", type: "button", disabled: waiting || !choices.length, onClick: () => void ask(host, input.value) }, waiting ? tr("處理中…", "Working…") : tr("送出", "Send")),

      ),
    ),
  );
}
