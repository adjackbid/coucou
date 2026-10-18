// The Office: the company map, a team's office and the member drawer — a
// picture of the same record the board shows (feature/OFFICE-整合規劃.md).
//
// The page (main.ts) draws itself again on every change; the scenes here are
// kept and moved into each new page, so the Mochis keep moving. Selection is
// by (teamId, memberId) and is dropped when the team changes, so one team's
// work never shows in another's drawer.

import "./office.css";
import { h } from "../../views/dom";
import { onLangChange, tr, trf } from "../../core/i18n";
import type { Artifact, CommandRecord, MemberSnapshot, Message, Team, TeamRun, Capabilities, WorkStatus } from "./contracts";
import { OfficeStore } from "./store";
import { floorColumns } from "./floor";
import { RealAdapter, fileFromSnapshot } from "./adapter-real";
import { MockAdapter } from "./adapter-mock";
import { loadArt, STATUS, TeamScene, themeName, THEME_LABELS, wake } from "./scene";
import { dropdown, editableText } from "../ui";
import { thumbsFor } from "../images";
import type { PastRun, Snapshot, TeamFile, Usage } from "../types";
import { fmtMoney, fmtTokens, usageSummary } from "../cost";
import { Battle, companyFps, companyLive, HERO_LABELS, heroOf, savedMode, saveCompanyLive, saveMode, setHero, setSkill, skillOf } from "./battle/session";
import { savedWorld, WORLDS } from "./battle/worlds";
import type { BossBlockCause } from "./battle/bossMoves";
import { BattleLayer } from "./battle/layer";
import { HIT_SKILLS, SKILLS, type Contribution, type HitPlan, type SkillId } from "./battle/skills";
import { battleLog, bossCard, bossHud, companyState, roomBadge , teamBar} from "./battle/hud";
import { inputFrom, project } from "./battle/projector";
import type { BattleSignal, BattleViewModel, HeroClass, PresentationMode } from "./battle/contracts";
import "./orbit/orbit.css";
import { OrbitView } from "./orbit/view";
import { OrbitFeed, agentStatus, sceneFrom, type TeamLinks } from "./orbit/adapter";
import { agentKey, splitAgentKey, STATUS_LABEL, type OrbitScene } from "./orbit/contracts";

export interface OfficeHost {
  render(): void;
  /** Leave the Office for the board of the same team. */
  showBoard(teamId: string): void;
  /** The task's thread in 溝通紀錄 (the task id is Coucou's own). */
  openTask?(teamId: string, taskId: string): void;
  /** Go to a team's office (selecting the team in the sidebar). */
  openTeam(teamId: string): void;
  /** Open a deliverable the way the board does. */
  openArtifact(teamId: string, ref: string): void;
  /** Jump to 團隊設定 (to raise a fallen member's limits). */
  openSetup?(teamId: string): void;
  /** Agent Center: the hub of the 無邊界 map. */
  openSecretary?(): void;
  /** A deliverable that is a picture, as bytes; rejects when it is not one or cannot be read. */
  preview?(teamId: string, ref: string): Promise<ArrayBuffer>;
  /** A team's earlier runs, newest first, and one of them as it ended. */
  history?(teamId: string): Promise<PastRun[]>;
  past?(teamId: string, archivedAt: number): Promise<Snapshot>;
  pause(teamId: string): Promise<unknown>;
  resume(teamId: string): Promise<unknown>;
  /** Resolves to the message's id; the same request id is sent once. */
  instruct(teamId: string, text: string, request: string): Promise<string>;
  /** What a member waits on the person for (a permission card, a question), answerable where it is shown. */
  asks?(teamId: string, memberId: string): HTMLElement[];
  /** What last went wrong when the person answered, if anything. */
  trouble?(): string;
  /** The 星域's camera drag ended: a redraw that waited for it may go now. */
  dragEnded?(): void;
}

const MAX_INSTRUCTION = 2000;

/** 正向滿版鏡頭 (fullbleed-frontal-v1): the default office camera. */
function frontalCam(): boolean {
  // The frontal fullbleed camera is the office's own now; `&camera=classic`
  // (or coucou.office.camera = "classic") brings back the 45° rooms.
  try {
    const asked = typeof location !== "undefined" ? new URLSearchParams(location.search).get("camera") : null;
    if (asked) return asked !== "classic";
    return localStorage.getItem("coucou.office.camera") !== "classic";
  } catch {
    return true;
  }
}

/** The element of a move, in a word. */
function elementWord(element: string): string {
  switch (element) {
    case "fire": return tr("火", "Fire");
    case "ice": return tr("冰", "Ice");
    case "wind": return tr("風", "Wind");
    case "lightning": return tr("雷", "Thunder");
    case "physical": return tr("刀光", "Blade");
    case "support": return tr("支援", "Support");
    default: return "";
  }
}

/** What the person calls their company; "My Company" until they name it. */
export function companyName(): string {
  try {
    return localStorage.getItem("coucou.company.name")?.trim() || tr("我的公司", "My Company");
  } catch {
    return tr("我的公司", "My Company");
  }
}

export function setCompanyName(name: string) {
  try {
    localStorage.setItem("coucou.company.name", name);
  } catch {
    /* kept until the window closes */
  }
}
// i18n: model-facing — what the Leader is told when a member falls or comes back (always Chinese, like every brief).
function fallenNote(name: string, limit: "tokens" | "cost" | null, battle: boolean): string {
  const what = limit === "cost" ? "成本上限" : "Token 上限"; // i18n-ok: model-facing
  const fell = battle ? "在戰鬥模式中陣亡" : "已停下"; // i18n-ok: model-facing
  return `【系統】${name} 已達自己的${what},${fell}。請不要再指派新任務給 ${name};等人類在「團隊設定」提高上限讓它${battle ? "復活" : "繼續"}。`; // i18n-ok: model-facing
}
function revivedNote(name: string): string {
  return `【系統】${name} 的上限已提高,已復活,可以繼續指派任務。`; // i18n-ok: model-facing
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getTime() === 0 ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export class Office {
  /** The company as it is now. */
  readonly main: OfficeStore;
  /** An earlier run being looked at, read only; null for the current one. */
  private viewing: OfficeStore | null = null;
  /** What the screens read: the run on screen. */
  get store(): OfficeStore {
    return this.viewing ?? this.main;
  }
  readonly demo: boolean;
  private real: RealAdapter | null = null;
  private mock: MockAdapter | null = null;
  private scenes = new Map<string, TeamScene>();
  private minis = new Map<string, TeamScene>();
  /** The team the drawer belongs to, and the member in it. */
  sel: { teamId: string; memberId: string } | null = null;
  /** Where we came from when following a dependency. */
  private back: { teamId: string; memberId: string } | null = null;
  companyPick: string | null = null;
  /** The company map's view: 60–160 %, and how far it was dragged from the centre. */
  view = { zoom: 1, x: 0, y: 0 };
  /** Until the person zooms or drags, the map fits the whole floor in view. */
  private viewTouched = false;
  /** The map's frame as last laid out: the floor is shaped to it. */
  private mapFrame = { w: 784, h: 670 };
  tab: "work" | "talk" = "work";
  bubbles = true;
  /**
   * 減少動態: the checkbox decides. Windows' "show animations" only sets the
   * first value — a machine with animations off (remote desktop, best
   * performance) must still be able to turn the Mochis' bounce back on.
   */
  calm = (() => {
    try {
      const saved = localStorage.getItem("coucou.office.calm");
      if (saved === "on" || saved === "off") return saved === "on";
    } catch {
      /* the system's choice, then */
    }
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  })();
  /** What is being typed to each team's leader, kept through failures. */
  private drafts = new Map<string, string>();
  private sending = new Map<string, { clientRequestId: string; commandId?: string; error?: string }>();
  private files: TeamFile[] = [];
  /** How much of each member's conversation is unfolded. */
  private threadLength = new Map<string, number>();
  /** Pictures of deliverables: an object URL, null when there is none to show, or pending. */
  private previews = new Map<string, string | null | "pending">();
  /** Each team's earlier runs, as last asked; and the one picked, with its record. */
  private histories = new Map<string, PastRun[] | "pending">();
  private picked = new Map<string, { at: number; store: OfficeStore | null; error?: () => string }>();
  private runs = new Map<string, Snapshot>();
  /** 中二模式: the same work told as a raid; the person's own preference. */
  mode: PresentationMode = savedMode();
  /** Whether 中二模式 is offered at all (設定 → 團隊與 Agent Center). Off, nothing of it is drawn or named. */
  battleAllowed = true;
  /** In 中二模式, whether the company map plays every room's fight (it costs more to draw). */
  companyLive = companyLive();
  companyFps = companyFps();
  /** Who already fell, per team: a down and a revival are each told once. */
  private fallenSeen = new Map<string, Set<string>>();
  /** In 中二模式, what the column beside the room shows. */
  private sideView: "battle" | "raw" = "battle";
  /** Each team's raid as the window has watched it. */
  readonly battle: Battle;
  /** 星域: one scene at a time — the company's, or one team's — kept across redraws and disposed when left. */
  private orbit: OrbitView | null = null;
  private orbitKey = "";
  private orbitFeed: OrbitFeed | null = null;
  /** The ring picked in the company's 星域 (a team's own 星域 uses the drawer's selection). */
  private orbitSel: string | null = null;

  constructor(private host: OfficeHost, opts: { demo?: boolean } = {}) {
    this.demo = !!opts.demo;
    this.main = new OfficeStore(() => this.resync());
    this.battle = new Battle(() => this.main, (teamId) => this.extras(teamId));
    // A signal seen live is played in that team's office, if it is the one on screen.
    // On the company map too, when its fights are on: only the room on screen plays it.
    this.battle.onSignal((sig) => {
      if (this.mode !== "battle") return;
      for (const sc of [this.scenes.get(sig.teamId), this.minis.get(sig.teamId)]) {
        const layer = sc?.currentLayer;
        if (layer instanceof BattleLayer) layer.play(sig);
      }
    });
    if (this.demo) {
      this.mock = new MockAdapter(Number(new URLSearchParams(location.search).get("rooms")) || 4);
      this.main.loadSnapshot(this.mock.snapshot());
      this.mock.subscribe((e) => this.main.receive(e));
      this.main.setConnection({ status: "live", lastAppliedSeq: this.main.cursor, lastServerTime: this.main.serverTime });
      // `&autostep=1` plays the recorded events one by one, to watch the Office react.
      if (import.meta.env.DEV && new URLSearchParams(location.search).get("autostep")) {
        const t = window.setInterval(() => {
          if (!this.step()) window.clearInterval(t);
          host.render();
        }, 1200);
      }
    } else {
      this.real = new RealAdapter({ pause: (t) => host.pause(t), resume: (t) => host.resume(t), instruct: (t, text, request) => host.instruct(t, text, request) });
    }
    this.main.onChange(() => {
      for (const s of this.scenes.values()) {
        s.frontal = this.mode !== "battle" && frontalCam();
        s.update();
      }
      for (const s of this.minis.values()) {
        s.frontal = this.mode !== "battle" && frontalCam();
        s.update();
      }
      // What changed, told as the raid: only once the store has applied it.
      this.battle.observeAll();
      // …and as the 星域: the scene as it stands, and each new message as a light (never twice).
      if (this.orbit && this.orbitFeed) {
        this.orbit.setScene(this.orbitScene());
        if (!this.viewing) this.orbit.push(this.orbitFeed.pull(this.main));
      }
      // A member that went away closes its drawer.
      if (this.sel && !this.viewing && !this.main.member(this.sel.teamId, this.sel.memberId)) {
        this.sel = null;
        this.tell(() => tr("這位成員已移出團隊。", "This member has left the team."));
      }
    });
    // Hidden: nothing of the raid goes on, and nothing is caught up on later.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) return;
      for (const sc of this.scenes.values()) {
        const layer = sc.currentLayer;
        if (layer instanceof BattleLayer) layer.stop();
      }
    });
    // Escape closes the member drawer wherever focus is, unless a field is being typed in.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.sel) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select") && !t.closest(".office-drawer")) return;
      this.close(this.sel.teamId);
    });
    void loadArt().then(() => {
      for (const s of [...this.scenes.values(), ...this.minis.values()]) s.el.remove();
      this.scenes.clear();
      this.minis.clear();
      host.render();
    });
    // Another language: the words the record was given here (a waiting member's
    // next step, an unnamed team, the demo's own data) are made again; the
    // window then draws itself again.
    onLangChange(() => {
      if (this.real) this.feed(this.files, this.runs);
      else if (this.mock) this.main.loadSnapshot(this.mock.snapshot());
    });
  }

  /** The last word to the person; picked when drawn, so it follows the language. */
  private told: () => string = () => "";
  get notice(): string {
    return this.told();
  }
  private tell(words: () => string) {
    this.told = words;
  }

  /** Coucou's teams as they stand: a new picture becomes the next event. */
  feed(files: TeamFile[], runs: Map<string, Snapshot>) {
    if (!this.real) return;
    this.files = files;
    this.runs = runs;
    this.real.settle(runs);
    if (this.main.cursor < 0) {
      this.main.loadSnapshot(this.real.snapshot(files, runs));
      this.main.setConnection({ status: "live", lastAppliedSeq: this.main.cursor, lastServerTime: this.main.serverTime });
      return;
    }
    const e = this.real.diff(files, runs);
    if (e) this.main.receive(e);
  }

  private resync() {
    // The stream skipped or changed scope: start again from a whole picture.
    if (this.real) queueMicrotask(() => this.main.loadSnapshot(this.real!.snapshot(this.files, this.runs)));
    else if (this.mock) queueMicrotask(() => this.main.loadSnapshot(this.mock!.snapshot()));
  }

  /** The demo's next recorded event. */
  step(): boolean {
    return this.mock?.step() ?? false;
  }

  private capabilities(run: TeamRun | undefined): Capabilities {
    return (this.real ?? this.mock)!.capabilities(run);
  }

  private scene(teamId: string, mini = false): TeamScene {
    const map = mini ? this.minis : this.scenes;
    const key = this.viewing ? `${teamId}#${this.picked.get(teamId)?.at}` : teamId;
    let s = map.get(key);
    if (!s) {
      s = new TeamScene(teamId, this.store, {
        mini,
        fps: () => this.companyFps,
        onSelect: (memberId) => {
          this.select(teamId, memberId);
        },
        // A bubble is a message: it opens the speaker's conversation.
        onMessage: (memberId) => {
          this.tab = "talk";
          this.select(teamId, memberId);
        },
        preview: (a) => this.preview(a),
        onArtifact: (a) => this.openArtifact(teamId, a),
        onBlank: () => {
          if (this.sel?.teamId === teamId) this.close(teamId, false);
        },
      });
      map.set(key, s);
    }
    s.selected = !mini && this.sel?.teamId === teamId ? this.sel.memberId : null;
    s.bubblesOn = this.bubbles;
    s.reduceMotion = this.calm;
    // 中二模式: the boss and the heroes' looks over the room; the Office as it was otherwise.
    if (this.mode === "battle") {
      let layer = this.layers.get(s);
      if (!layer) {
        this.layers.set(s, (layer = new BattleLayer(s, this.layerHost(teamId, this.store))));
        layer.taskOwner = (taskId) => this.store.task(taskId)?.assigneeMemberId ?? null;
      }
      s.setLayer(layer);
    } else s.setLayer(null);
    s.frontal = this.mode !== "battle" && frontalCam();
    s.update();
    return s;
  }

  private layers = new WeakMap<TeamScene, BattleLayer>();

  /** What a team's battle layer asks of the Office. */
  private layerHost(teamId: string, store: OfficeStore) {
    const history = store !== this.main;
    return {
      vm: () => {
        if (!history) return this.battle.vm(teamId);
        const input = inputFrom(store, teamId, { isHistory: true });
        return input ? project(input) : null;
      },
      hero: (memberId: string) => this.hero(teamId, memberId),
      skill: (memberId: string) => this.skill(teamId, memberId),
      name: (memberId: string) => store.member(teamId, memberId)?.displayName ?? memberId,
      taskTitle: (taskId: string) => store.task(taskId)?.title ?? tr("任務", "Task"),
      members: () => store.members(teamId).map((m) => m.memberId),
      // Only members really at work skirmish with the boss.
      rerender: () => this.host.render(),
      busy: () => store.members(teamId).filter((m) => m.workStatus === "working" || m.workStatus === "reviewing" || m.workStatus === "planning").map((m) => m.memberId),
      live: () => this.companyLive,
      world: () => savedWorld(teamId),
      turns: () => {
        const run = this.runs.get(teamId);
        return run && run.maxTurns ? { used: run.totalTurns, max: run.maxTurns } : null;
      },
      fallen: (memberId: string) => !!this.vitals(teamId, memberId)?.dead,
      // What a counter is really about, from the record: a question to the person, or a dependency.
      causeOf: (sig: BattleSignal): BossBlockCause => {
        if (sig.source.questionIds.length) return "human_input";
        const statuses = sig.source.taskIds.map((id) => store.task(id)?.status);
        if (statuses.some((st) => st === "waiting_input")) return "human_input";
        if (statuses.some((st) => st === "blocked")) return "dependency_wait";
        return "unknown";
      },
      calm: () => this.calm,
      waiting: () => store.members(teamId).find((m) => m.workStatus === "waiting_input" || m.workStatus === "blocked")?.memberId ?? null,
      contributions: (sig: BattleSignal) => this.contributions(teamId, sig),
      planned: (plan: HitPlan) => {
        for (const id of plan.sourceSignalIds) {
          const names = this.moves.get(id) ?? [];
          const who = plan.memberIds.map((m) => store.member(teamId, m)?.displayName ?? m).join(" + ");
          const skillId = plan.skillId;
          // Named when shown, so the 戰鬥紀錄 follows the language.
          names.push(() => `${skillId ? SKILLS[skillId].name : tr("驗收命中", "Accepted!")}${who ? `(${who})` : ""}`);
          this.moves.set(id, names);
        }
        this.host.render();
      },
    };
  }

  /** The moves chosen for each acceptance signal, for the 戰鬥紀錄 (each named when shown). */
  private moves = new Map<string, (() => string)[]>();

  /** Each task an acceptance names, as the skills see it: who did it, how they look, when it really happened. */
  private contributions(teamId: string, sig: BattleSignal): Contribution[] {
    const acceptedAt = this.extras(teamId).acceptedAt;
    return sig.source.taskIds.map((taskId) => {
      const task = this.main.task(taskId);
      const memberId = task?.assigneeMemberId && this.main.member(teamId, task.assigneeMemberId) ? task.assigneeMemberId : null;
      return {
        teamId,
        runId: sig.runId,
        signalId: sig.signalId,
        kind: sig.kind,
        live: !sig.replay,
        countedByCurrentProgress: true,
        acceptanceKey: `${teamId}/${sig.runId}/${taskId}/${task?.revision ?? 0}`,
        taskId,
        memberId,
        skillId: memberId ? this.skill(teamId, memberId) : null,
        heroClass: memberId ? this.hero(teamId, memberId) : null,
        batchId: `${sig.source.streamId}@${sig.source.domainSeq}`,
        sourceTimeMs: acceptedAt?.get(taskId) ?? null,
      };
    });
  }

  /** A deliverable's picture, fetched once; the scenes are drawn again when it arrives. */
  private preview(a: Artifact): string | null {
    if (a.kind !== "image" || this.demo || !this.host.preview) return null;
    const key = `${a.artifactId}@${a.artifactVersion}`;
    const got = this.previews.get(key);
    if (got !== undefined) return got === "pending" ? null : got;
    this.previews.set(key, "pending");
    this.host.preview(a.teamId, a.resourceRef).then(
      (bytes) => {
        this.previews.set(key, URL.createObjectURL(new Blob([bytes])));
        for (const s of [...this.scenes.values(), ...this.minis.values()]) s.update();
        this.host.render();
      },
      () => this.previews.set(key, null),
    );
    return null;
  }

  private openArtifact(teamId: string, a: Artifact) {
    if (this.demo) {
      this.tell(() => trf("示範資料:「{name}」沒有實際檔案可以開啟。", "Demo data: “{name}” has no real file to open.", { name: a.name }));
      this.host.render();
    } else this.host.openArtifact(teamId, a.resourceRef);
  }

  select(teamId: string, memberId: string | null) {
    this.sel = memberId ? { teamId, memberId } : null;
    this.host.render();
    // Focus follows into the drawer's heading for keyboard users.
    if (memberId) requestAnimationFrame(() => document.querySelector<HTMLElement>(".office-drawer h2")?.focus());
  }

  /** Closes the drawer; from the keyboard, focus goes back to the member's label. */
  private close(teamId: string, refocus = true) {
    const was = this.sel?.memberId;
    this.sel = null;
    this.back = null;
    this.host.render();
    if (was && refocus) requestAnimationFrame(() => this.scenes.get(teamId)?.focusLabel(was));
  }

  // ── Small pieces ─────────────────────────────────────────────────────────────

  private demoTag() {
    return this.demo ? h("span", { class: "office-demo", title: tr("這些是規格附帶的示範資料,不是正在執行的團隊", "This is the sample data that comes with the spec, not a team at work"), text: tr("示範資料", "Demo data") }) : null;
  }

  private status(s: MemberSnapshot["workStatus"]) {
    const st = STATUS[s];
    return h("span", { class: `office-pill ${st.tone}` }, h("i", { "aria-hidden": "true", text: st.icon }), st.label);
  }

  private runLabel(run: TeamRun | undefined) {
    const m: Record<TeamRun["status"], [string, string, string]> = {
      idle: [tr("待命", "Standing by"), "○", "quiet"], running: [tr("執行中", "Running"), "●", "work"], pausing: [tr("暫停中", "Pausing"), "Ⅱ", "wait"], paused: [tr("已暫停", "Paused"), "Ⅱ", "quiet"],
      needs_attention: [tr("需介入", "Needs you"), "!", "alert"], completed: [tr("已完成", "Done"), "✓", "done"], failed: [tr("失敗", "Failed"), "✕", "alert"], cancelled: [tr("已取消", "Cancelled"), "–", "quiet"],
    };
    const [label, icon, tone] = m[run?.status ?? "idle"];
    return h("span", { class: `office-pill ${tone}` }, h("i", { "aria-hidden": "true", text: icon }), label);
  }

  private progressBar(teamId: string) {
    const p = this.store.progress(teamId);
    return h(
      "div",
      { class: "office-progress" },
      h("b", { text: p.percent === null ? tr("尚未派工", "No tasks yet") : `${p.percent}%` }),
      p.total ? h("span", { class: "dim", text: trf("{done} / {all} 項任務", "{done} / {all} tasks", { done: p.completed, all: p.total }) }) : null,
      h("span", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(p.percent ?? 0) }, h("i", { style: `width:${p.percent ?? 0}%` })),
    );
  }

  private alerts(teamId: string) {
    return this.store.members(teamId).filter((m) => STATUS[m.workStatus].tone === "alert");
  }

  /** 中二模式的個人血量: what is left of a member's own limits (and which one ran out); null when none are set. */
  private vitals(teamId: string, memberId: string): { frac: number; dead: boolean; why: string; limit: "tokens" | "cost" | null } | null {
    const cfg = this.files.find((f) => f.config?.id === teamId)?.config;
    const mc = cfg?.members.find((x) => x.id === memberId);
    if (!mc || (!mc.maxTokens && !mc.maxCostUsd)) return null;
    const mv = this.runs.get(teamId)?.members.find((x) => x.id === memberId);
    if (!mv) return null;
    const u = usageSummary(mv.usage ?? [], () => this.host.render());
    let worst = 0;
    let limit: "tokens" | "cost" | null = null;
    if (mc.maxTokens && u.tokens / mc.maxTokens > worst) {
      worst = u.tokens / mc.maxTokens;
      limit = "tokens";
    }
    if (mc.maxCostUsd && u.usd != null && u.usd / mc.maxCostUsd > worst) {
      worst = u.usd / mc.maxCostUsd;
      limit = "cost";
    }
    const why = limit === "tokens" ? tr("Token 已達上限", "Token limit reached") : limit === "cost" ? tr("成本已達上限", "Cost limit reached") : "";
    return { frac: Math.max(0, 1 - worst), dead: worst >= 1, why, limit };
  }

  /** 陣亡與復活: floats on the field, and one word to the Leader each way. */
  private fallenWatch(teamId: string) {
    const run = this.runs.get(teamId);
    if (!run) return;
    const teamView = this.store.team(teamId);
    const storeRun = teamView ? this.store.run(teamView.currentRunId) : undefined;
    const canTell = !!this.real && run.status === "running" && !!storeRun && this.capabilities(storeRun).canSendInstruction;
    let seen = this.fallenSeen.get(teamId);
    if (!seen) this.fallenSeen.set(teamId, (seen = new Set()));
    const layer = this.scenes.get(teamId)?.currentLayer;
    const bl = layer instanceof BattleLayer ? layer : null;
    for (const m of this.store.members(teamId)) {
      const v = this.vitals(teamId, m.memberId);
      const dead = !!v?.dead;
      if (dead && !seen.has(m.memberId)) {
        seen.add(m.memberId);
        bl?.memberDown(m.memberId, v!.why);
        // The Leader is told once per run; the request id keeps it to once.
        if (canTell) {
          void this.host
            .instruct(teamId, fallenNote(m.displayName ?? m.memberId, v!.limit, this.battleAllowed), `bt-fallen:${run.id}:${this.battle.vm(teamId)?.runId ?? ""}:${m.memberId}`)
            .catch(() => {});
        }
      } else if (!dead && seen.has(m.memberId)) {
        seen.delete(m.memberId);
        bl?.memberUp(m.memberId);
        if (canTell) {
          void this.host
            .instruct(teamId, revivedNote(m.displayName ?? m.memberId), `bt-revived:${run.id}:${this.battle.vm(teamId)?.runId ?? ""}:${m.memberId}`)
            .catch(() => {});
        }
      }
    }
  }

  /** What a team (or one member) has used this run: tokens and their cost at today's prices. */
  private spend(teamId: string, memberId?: string): { tokens: number; cost: string } | null {
    const snap = this.runs.get(teamId);
    if (!snap) return null;
    const usage: Usage[] = snap.members.filter((m) => !memberId || m.id === memberId).flatMap((m) => m.usage ?? []);
    const s = usageSummary(usage, () => this.host.render());
    if (!s.tokens) return null;
    return { tokens: s.tokens, cost: s.usd == null ? "" : `${s.priced ? "" : "≥ "}${fmtMoney(s.usd)}` };
  }

  /** "任務 2/4 · 1.2M tokens · NT$3.4" — the team's numbers, live. */
  private figures(teamId: string, cls = "office-figures"): HTMLElement | null {
    const snap = this.runs.get(teamId);
    if (!snap) return null;
    const s = this.spend(teamId);
    return h(
      "div",
      { class: cls, title: tr("本輪的任務、用掉的 token 與預估成本(依「成本與用量」的價格表),隨團隊工作即時更新", "This run's tasks, the tokens used and their estimated cost (from the price list in Cost & usage), updated live as the team works") },
      h("span", {}, h("small", { text: tr("任務", "Tasks") }), h("b", { text: `${snap.done}/${snap.total}` })),
      h("span", {}, h("small", { text: "Token" }), h("b", { text: s ? fmtTokens(s.tokens) : "0" })),
      h("span", {}, h("small", { text: tr("成本", "Cost") }), h("b", { text: s?.cost || "—" })),
    );
  }

  /** What waits on the person for this member, answerable here. */
  private asksOf(teamId: string, memberId: string): HTMLElement[] {
    return this.viewing || this.demo ? [] : this.host.asks?.(teamId, memberId) ?? [];
  }

  private trouble(): HTMLElement | null {
    const t = this.host.trouble?.() ?? "";
    return t ? h("div", { class: "problem", role: "alert", text: t }) : null;
  }

  private connection() {
    const c = this.store.connection;
    if (this.store.syncing) return h("div", { class: "office-stale", role: "status", text: tr("資料同步中…", "Syncing…") });
    if (c.status === "stale" || c.status === "reconnecting") return h("div", { class: "office-stale", role: "status", text: trf("資料已過期 · 最後更新 {t}", "Out of date · last updated {t}", { t: clock(c.lastServerTime ?? "") }) });
    return null;
  }

  // ── 中二模式 ───────────────────────────────────────────────────────────────

  /** What the store does not keep and the raid needs: how often each task was sent back, the open questions. */
  private extras(teamId: string) {
    const snap = this.runs.get(teamId);
    if (!snap) return {};
    return {
      rejections: new Map(snap.tasks.map((t) => [`${teamId}:${t.id}`, t.rejections ?? 0] as [string, number])),
      questionIds: (snap.questions ?? []).filter((q) => q.answer === null).map((q) => q.id),
      // When each task was accepted, as Coucou recorded it: the only time two members' work is "together".
      acceptedAt: new Map((snap.feed ?? []).filter((f) => f.kind === "accepted" && f.task).map((f) => [`${teamId}:${f.task}`, f.at] as [string, number])),
    };
  }

  /** The boss of the run on screen: the current one live, an earlier one as history. */
  private boss(teamId: string): BattleViewModel | null {
    if (!this.viewing) return this.battle.vm(teamId);
    const input = inputFrom(this.store, teamId, { isHistory: true });
    return input ? project(input) : null;
  }

  private hero(teamId: string, memberId: string): HeroClass {
    const team = this.store.team(teamId);
    const members = this.store.members(teamId);
    const m = members.find((x) => x.memberId === memberId);
    return heroOf(teamId, memberId, m?.roleLabel ?? "", team?.leaderMemberId === memberId, Math.max(0, members.indexOf(m!)));
  }

  private skill(teamId: string, memberId: string): SkillId {
    const members = this.store.members(teamId);
    const i = members.findIndex((x) => x.memberId === memberId);
    return skillOf(teamId, memberId, this.hero(teamId, memberId), Math.max(0, i));
  }

  private heroChip(teamId: string, memberId: string) {
    const c = this.hero(teamId, memberId);
    return h("span", { class: `bt-hero ${c}`, title: tr("戰鬥模式的職業外觀:只是外觀,不改變工作", "Your class in Battle mode: just a look, the work stays the same"), text: HERO_LABELS[c] });
  }

  /**
   * Office, 中二模式, Space or Standard: the same work, told four ways. A
   * team's own page offers only Office and 中二模式 (Space and Standard are
   * company-wide pictures), and no switch at all when that leaves one.
   */
  private modeSwitch(team = false): HTMLElement | null {
    const opt = (mode: PresentationMode, label: string, title: string) =>
      h("button", { class: `bt-${mode}${this.mode === mode ? " on" : ""}`, type: "button", "aria-pressed": this.mode === mode ? "true" : "false", title, onClick: () => this.setMode(mode) }, label);
    if (team && !this.battleAllowed) return null;
    return h("div", { class: "bt-mode", role: "group", "aria-label": tr("畫面模式", "View mode") },
      opt("office", "Office", tr("一般辦公室畫面", "The usual office view")), // i18n-ok: the view's name, the same in both languages
      this.battleAllowed ? opt("battle", tr("戰鬥模式", "Battle mode"), tr("同一份工作,看成團隊討伐需求魔王:只改變畫面,不影響工作", "The same work, told as your team's raid on the Requirements Overlord: only the picture changes, never the work")) : null,
      team ? null : opt("orbit", "Space", tr("同一份工作,看成 Agent 在同一個宇宙裡的光環與協作連線:只改變畫面,不影響工作", "The same work, told as your agents' light rings and the lines between them, all in one universe: only the picture changes, never the work")), // i18n-ok: Space is the view's name in both languages
      team ? null : opt("space", "Standard", tr("每個團隊的辦公室漂在同一片星空裡,圍著 Agent Center;只改變畫面,不影響工作", "Every team's office floats in one sky around Agent Center: only the picture changes, never the work"))); // i18n-ok: Standard is the view's name in both languages
  }

  /** 團隊設定 picked another battlefield: the old one's moves stop where they are. */
  worldChanged(teamId: string) {
    for (const sc of [this.scenes.get(teamId), this.minis.get(teamId)]) {
      const layer = sc?.currentLayer;
      if (layer instanceof BattleLayer) layer.stop();
    }
    this.host.render();
  }

  /** The settings window turned 中二模式 on or off. Off, a raid on screen goes back to the office. */
  allowBattle(on: boolean) {
    if (this.battleAllowed === on) return;
    this.battleAllowed = on;
    if (!on && this.mode === "battle") this.setMode("office");
    else this.host.render();
  }

  setMode(mode: PresentationMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    saveMode(mode);
    // Off: the boss leaves every room and nothing of it goes on playing.
    if (mode !== "battle") for (const s of [...this.scenes.values(), ...this.minis.values()]) s.setLayer(null);
    // Leaving the 星域 gives its frames, listeners and GPU back; coming back starts clean.
    if (mode !== "orbit") this.dropOrbit();
    this.host.render();
  }

  // ── 星域 ──────────────────────────────────────────────────────────────────────

  private dropOrbit() {
    this.orbit?.dispose();
    this.orbit = null;
    this.orbitFeed = null;
    this.orbitKey = "";
  }

  /** Each team's standing links, from its file. */
  private teamLinks(): TeamLinks {
    return new Map(this.files.filter((f) => f.config).map((f) => [f.config!.id, f.config!.links]));
  }

  /** The scene the current 星域 shows: the whole company, or one team of it (shown even when put away). */
  private orbitScene(): OrbitScene {
    const mode = this.demo ? "demo" : "live";
    if (this.orbitKey === "company" || !this.orbitKey) return sceneFrom(this.store, this.teamLinks(), mode);
    return sceneFrom(this.store, this.teamLinks(), mode, { team: this.orbitKey });
  }

  /** A pointer is held on the 星域: main.ts waits with its redraw until it is lifted. */
  dragging(): boolean {
    return !!this.orbit?.dragging;
  }

  /** The one 星域 view, made for this key; another key's view is disposed first. */
  private orbitView(key: string): OrbitView {
    if (this.orbit && this.orbitKey !== key) this.dropOrbit();
    if (!this.orbit) {
      this.orbitKey = key;
      const company = key === "company";
      this.orbit = new OrbitView(
        {
          onSelect: (id) => {
            if (company) {
              this.orbitSel = id;
              this.orbit?.select(id);
              this.host.render();
            } else if (id) this.select(key, splitAgentKey(id).memberId);
            else this.close(key, false);
          },
          onPickTeam: (teamId) => {
            if (!company) return;
            this.orbitSel = null;
            this.companyPick = this.companyPick === teamId ? null : teamId;
            this.host.render();
          },
          reduce: () => this.calm,
          onDragEnd: () => this.host.dragEnded?.(),
        },
        { demo: this.demo },
      );
      // The feed takes note of what is already in the record, so the scene opens quiet.
      this.orbitFeed = new OrbitFeed();
      this.orbitFeed.pull(this.main);
    }
    this.orbit.setScene(this.orbitScene());
    return this.orbit;
  }

  /** 暫停漂浮 and 減少動態, in the window's own controls. */
  private orbitToolbar(view: OrbitView): HTMLElement {
    return h("div", { class: "orbit-toolbar" },
      this.calmToggle(),
      h("button", {
        class: "btn plain", type: "button", "aria-pressed": view.paused ? "true" : "false", disabled: this.calm,
        title: this.calm ? tr("減少動態已停止所有持續動作", "Reduce motion has stopped every continuous movement") : tr("只停止畫面的漂浮與背景流動:連線、狀態、選擇和相機照常,也不影響團隊工作", "Stops only the drift and the moving background: lines, states, selection and camera carry on, and the team's work isn't touched"),
        onClick: () => { view.togglePause(); this.host.render(); },
      }, view.paused ? tr("繼續漂浮", "Resume drift") : tr("暫停漂浮", "Pause drift")),
      this.demo ? h("button", { class: "btn plain", type: "button", title: tr("沿場景裡真實存在的連線播三道示範光流(只在示範資料)", "Plays three sample light streams along lines the scene really has (demo data only)"), onClick: () => { if (!view.demo()) this.tell(() => tr("沒有可示範的連線。", "There are no lines to show.")); this.host.render(); } }, tr("示範資料傳送", "Demo transfer")) : null);
  }

  /** The 減少動態 checkbox the Office and the 星域 share. */
  private calmToggle(): HTMLElement {
    return h("label", { title: tr("只調整畫面動畫,不影響團隊工作", "Only changes the animation, never the team's work") }, h("input", { type: "checkbox", checked: this.calm, onChange: (e: Event) => {
      this.calm = (e.target as HTMLInputElement).checked;
      try {
        localStorage.setItem("coucou.office.calm", this.calm ? "on" : "off");
      } catch {
        /* this session only */
      }
      this.host.render();
    } }), tr("減少動態", "Reduce motion"));
  }

  /** Under the scene: the last transfer in words, and where the data comes from. */
  private orbitFoot(view: OrbitView): HTMLElement {
    const c = this.store.connection;
    const data = this.demo
      ? tr("示意資料,非即時工作狀態", "Sample data, not live work")
      : this.viewing
        ? tr("之前的一輪,只看結果", "An earlier run, results only")
        : `${tr("即時資料", "Live data")}${c.lastServerTime ? trf(" · 最後更新 {t}", " · last updated {t}", { t: clock(c.lastServerTime) }) : ""}`;
    return h("div", { class: "orbit-foot" }, view.eventLine, h("span", { class: "orbit-data", text: data }));
  }

  /** The company as one universe. */
  private orbitCompany(teams: Team[], away: number, count: { seats: number }): HTMLElement {
    const view = this.orbitView("company");
    // The view resolves the pick against the rings it shows: a member gone, or a team put away, is no longer picked.
    view.select(this.orbitSel);
    this.orbitSel = view.selected;
    const pick = teams.find((t) => t.teamId === this.companyPick) ?? null;
    const side = h(
      "aside",
      { class: "office-side" },
      ...(this.orbitSel ? [this.orbitPickCard(view, this.orbitSel)] : pick ? this.roomSummary(pick) : [this.companySummary(teams)]),
      this.attentionCard(teams),
    );
    return h(
      "div",
      { class: "office office-company orbit" },
      h("div", { class: "office-head" },
        h("div", {}, editableText("company", companyName(), {
          tag: "h1",
          label: tr("公司名稱", "Company name"),
          fallback: tr("我的公司", "My Company"),
          onSave: (v) => setCompanyName(v),
          render: () => this.host.render(),
        }), h("p", { class: "dim", text: `${trf("{n} 個團隊 · {seats} 位 Agents", `${teams.length === 1 ? "{n} team" : "{n} teams"} · ${count.seats === 1 ? "{seats} agent" : "{seats} agents"}`, { n: teams.length, seats: count.seats })}${away ? trf(" · 另有 {n} 個團隊已封存", " · {n} more archived", { n: away }) : ""}` })),
        this.demoTag(),
        h("span", { style: "flex:1" }),
        this.orbitToolbar(view),
        this.modeSwitch()),
      this.connection(),
      this.trouble(),
      this.notice ? h("div", { class: "office-notice", role: "status", text: this.notice }) : null,
      h("div", { class: "office-body" },
        h("div", { class: "office-map-wrap" }, view.el, this.orbitFoot(view), h("p", { class: "dim office-hint", text: tr("點光環看它的協作關係,點團隊名稱看摘要 · 拖曳旋轉,滾輪縮放,「全景」回到預設視角", "Click a ring to see who it works with, a team name for its summary · drag to turn, scroll to zoom, Overview goes back to the default view") })),
        side),
    );
  }

  /** One team's own cluster, where its rooms would be. */
  private orbitFrame(teamId: string): HTMLElement[] {
    const view = this.orbitView(teamId);
    view.select(this.sel && this.sel.teamId === teamId ? agentKey(teamId, this.sel.memberId) : null);
    return [view.el, this.orbitFoot(view)];
  }

  /** The ring picked in the company's 星域: who it is, what it does, who it is tied to. */
  private orbitPickCard(view: OrbitView, id: string): HTMLElement {
    const { teamId, memberId } = splitAgentKey(id);
    const team = this.store.team(teamId)!;
    const m = this.store.member(teamId, memberId)!;
    const status = agentStatus(m);
    const name = (agent: string) => {
      const k = splitAgentKey(agent);
      return `${k.teamId === teamId ? "" : `${this.store.team(k.teamId)?.name ?? ""} · `}${this.store.member(k.teamId, k.memberId)?.displayName ?? k.memberId}`;
    };
    const rels = view.directRelations(id);
    const color = this.orbitScene().agents.find((a) => a.id === id)?.color ?? m.color ?? "#65b5f2";
    return h("div", { class: "office-card orbit-pick" },
      h("div", { class: "orbit-pick-head" },
        h("i", { class: "orbit-pick-ring", style: `color:${color}`, "aria-hidden": "true" }),
        h("div", { class: "grow" },
          h("h2", { text: `${m.displayName ?? memberId} · ${m.roleLabel}` }),
          h("small", { class: "dim", text: `${team.name}${memberId === team.leaderMemberId ? " · Leader" : ""}` })), // i18n-ok: "Leader" is the same in both languages
        h("button", { class: "icon-btn", type: "button", title: tr("取消選擇", "Clear selection"), "aria-label": tr("取消選擇", "Clear selection"), onClick: () => { this.orbitSel = null; view.select(null); this.host.render(); } }, "✕")),
      h("div", { class: "row" }, this.status(m.workStatus), status === "unknown" || status === "offline" ? h("span", { class: "office-pill quiet", text: STATUS_LABEL[status] }) : null, this.demoTag()),
      m.summary ? h("p", { class: "dim", text: m.summary }) : null,
      h("h3", { text: trf("直接關係 · {n} 條", "Direct ties · {n}", { n: rels.length }) }),
      rels.length
        ? h("ul", { class: "orbit-relations" }, ...rels.map((r) => {
            const other = r.fromAgentId === id ? r.toAgentId : r.fromAgentId;
            const word = r.kind === "team_connection" ? tr("團隊關係", "Team tie") : r.kind === "workflow" ? tr("工作流程", "Workflow") : tr("實際傳送", "Sent");
            return h("li", {}, h("i", { class: r.kind, style: `color:${color};background:${r.kind === "workflow" ? "" : color}`, "aria-hidden": "true" }), h("span", { class: "grow", text: name(other) }), h("small", { class: "dim", text: word }));
          }))
        : h("p", { class: "dim", text: tr("沒有常駐的協作連線。", "No standing ties.") }),
      ...this.asksOf(teamId, memberId),
      h("button", { class: "btn primary", type: "button", onClick: () => { this.sel = { teamId, memberId }; this.host.openTeam(teamId); } }, tr("進入辦公室看這位成員 →", "See this member in the office →")));
  }

  /** Members waiting on the person, across the company. */
  private attentionCard(teams: Team[]): HTMLElement | null {
    const attention = teams.flatMap((t) => this.alerts(t.teamId).map((m) => ({ t, m })));
    if (!attention.length) return null;
    return h("div", { class: "office-card alert" }, h("h3", { text: tr("需要你的注意", "Needs your attention") }),
      ...attention.map(({ t, m }) =>
        h("div", { class: "office-attn" },
          h("button", { class: "office-member-row", type: "button", title: tr("進入這間辦公室看這位成員", "Go into this office to see this member"), onClick: () => { this.sel = { teamId: t.teamId, memberId: m.memberId }; this.host.openTeam(t.teamId); } },
            h("i", { class: "office-blob", style: `background:${m.color}` }),
            h("span", { class: "grow" }, h("b", { text: `${t.name} · ${m.displayName}` }), h("small", { class: "dim", text: ` ${m.waitingFor?.reason ?? STATUS[m.workStatus].label}` })),
            h("span", { class: "office-pill alert", text: tr("查看", "View") })),
          ...this.asksOf(t.teamId, m.memberId))));
  }

  /** A line of the 戰鬥紀錄 was clicked: what really happened — the member, else the task. */
  private openSignal(teamId: string, s: BattleSignal) {
    const tasks = s.source.taskIds;
    const member = s.actorMemberId ?? s.source.memberIds[0]
      ?? (s.kind === "boss_counter" ? this.store.members(teamId).find((m) => m.workStatus === "waiting_input" || m.workStatus === "blocked")?.memberId : undefined)
      ?? (tasks.length === 1 ? this.store.task(tasks[0])?.assigneeMemberId ?? undefined : undefined);
    if (member && this.store.member(teamId, member)) return this.select(teamId, member);
    if (tasks.length === 1 && this.host.openTask && !this.demo) return this.host.openTask(teamId, tasks[0].slice(teamId.length + 1));
    this.host.showBoard(teamId);
  }

  /** In 中二模式, the column beside the room: what waits on the person, the result, the 戰鬥紀錄. */
  private battleSide(teamId: string, vm: BattleViewModel | null): HTMLElement {
    const tabs = h("div", { class: "bt-side-tabs", role: "tablist" },
      h("button", { class: this.sideView === "battle" ? "on" : "", type: "button", role: "tab", "aria-selected": String(this.sideView === "battle"), onClick: () => { this.sideView = "battle"; this.host.render(); } }, tr("戰鬥紀錄", "Battle log")),
      h("button", { class: this.sideView === "raw" ? "on" : "", type: "button", role: "tab", "aria-selected": String(this.sideView === "raw"), onClick: () => { this.sideView = "raw"; this.host.render(); } }, tr("原始活動", "Raw activity")));
    if (this.sideView === "raw") return h("aside", { class: "office-side" }, tabs, ...this.activityCards(teamId));
    const name = (id: string) => this.store.member(teamId, id)?.displayName ?? id;
    // The boss's counter is a real question: answered here, the way it is everywhere else.
    const waiting = this.viewing ? [] : this.alerts(teamId);
    const decide = waiting.length
      ? h("div", { class: "office-card bt-decide" },
          h("h3", { text: tr("需要你決定", "Your call") }),
          h("p", { class: "dim", text: tr("魔王反擊:有成員在等你。回覆或批准之後,團隊才會繼續。", "The boss strikes back: a member is waiting for you. The team carries on once you reply or approve.") }),
          ...waiting.flatMap((m) => [
            h("button", { class: "office-member-row", type: "button", onClick: () => this.select(teamId, m.memberId) },
              h("i", { class: "office-blob", style: `background:${m.color}` }),
              h("span", { class: "grow" }, h("b", { text: m.displayName }), h("small", { class: "dim", text: ` ${m.waitingFor?.reason ?? STATUS[m.workStatus].label}` })),
              h("span", { class: "office-pill alert", text: tr("查看", "View") })),
            ...this.asksOf(teamId, m.memberId),
          ]))
      : null;
    return h("aside", { class: "office-side" },
      tabs,
      vm?.bossState === "defeated" ? this.result(teamId, vm) : null,
      decide,
      h("div", { class: "office-card" },
        h("h3", { text: this.viewing ? tr("戰鬥紀錄(這是之前的一輪,只看結果)", "Battle log (an earlier run, results only)") : tr("戰鬥紀錄", "Battle log") }),
        this.viewing
          ? h("p", { class: "dim", text: tr("之前的一輪不重演過程;它的對話與交付在「原始活動」。", "An earlier run isn't replayed; its talk and deliverables are under Raw activity.") })
          : battleLog(this.battle.log(teamId), { name, open: (s) => this.openSignal(teamId, s), moves: (id) => this.moves.get(id)?.map((move) => move()) }),
        h("p", { class: "dim office-hint", text: tr("每一列都是真實發生的事:點一下看那位成員或任務。", "Every line really happened: click one to see that member or task.") })),
      this.earlierRuns(teamId));
  }

  /** 討伐成果: the run reported done, every counted task accepted — and the way to the real record. */
  private result(teamId: string, vm: BattleViewModel): HTMLElement {
    const tasks = vm.countedTaskIds.map((id) => this.store.task(id)).filter((t): t is NonNullable<typeof t> => !!t);
    const s = this.viewing ? null : this.spend(teamId);
    const leader = this.store.member(teamId, this.store.team(teamId)?.leaderMemberId ?? "");
    return h("div", { class: "office-card bt-result" },
      h("div", { class: "bt-result-head" },
        h("span", { class: "bt-medal", "aria-hidden": "true", html: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5Z"/></svg>' }),
        h("div", { class: "grow" }, h("h3", { text: tr("討伐成果", "Raid results") }), h("small", { class: "dim", text: leader
          ? trf("{boss} 已擊敗 · {leader} 已結案", "{boss} defeated · {leader} closed it out", { boss: WORLDS[savedWorld(teamId)].bossName, leader: leader.displayName ?? leader.memberId })
          : trf("{boss} 已擊敗 · 已結案", "{boss} defeated · closed out", { boss: WORLDS[savedWorld(teamId)].bossName }) }))),
      h("div", { class: "office-figures" },
        h("span", {}, h("small", { text: tr("驗收任務", "Accepted") }), h("b", { text: trf("{n} 項", "{n}", { n: vm.progress.completed }) })),
        s ? h("span", {}, h("small", { text: "Token" }), h("b", { text: fmtTokens(s.tokens) })) : null,
        s ? h("span", {}, h("small", { text: tr("成本", "Cost") }), h("b", { text: s.cost || "—" })) : null),
      h("ul", { class: "bt-result-tasks" }, ...tasks.map((t) =>
        h("li", {}, h("button", {
          type: "button", title: tr("看這個任務的對話與交付", "See this task's talk and deliverables"),
          onClick: () => (this.host.openTask && !this.demo && !this.viewing ? this.host.openTask(teamId, t.taskId.slice(teamId.length + 1)) : t.assigneeMemberId && this.select(teamId, t.assigneeMemberId)),
        }, h("i", { "aria-hidden": "true", text: "✓" }), t.title)))),
      h("div", { class: "bt-actions" },
        h("button", { class: "btn plain", type: "button", onClick: () => this.host.showBoard(teamId) }, tr("看任務看板", "See the task board")),
        this.viewing ? null : h("button", {
          class: "btn plain", type: "button", title: tr("只重播動畫:不重算任何資料,也不算第二次完成", "Replays the animation only: nothing is counted again, and it isn't a second win"),
          onClick: () => { const l = this.scenes.get(teamId)?.currentLayer; if (l instanceof BattleLayer) l.replay(); },
        }, tr("重播擊敗動畫", "Replay the victory"))),
      h("p", { class: "dim office-hint", text: tr("獎章只是這台電腦上的完成紀念;Token 和費用照原本的統計。", "The medal is just a keepsake on this computer; tokens and costs are counted as usual.") }));
  }

  // ── The company ──────────────────────────────────────────────────────────────

  company(): HTMLElement {
    this.viewing = null;
    // Teams put away stay in the record but not on the floor.
    const teams = this.store.teams().filter((t) => !t.archived);
    const away = this.store.teams().length - teams.length;
    const count = this.store.headcount();
    if (!teams.length) return h("div", { class: "office-empty" }, h("p", { text: away ? trf("{n} 個團隊都已封存。到側欄下方的「已封存」可以取出。", "All {n} teams are archived. You can bring them back from Archived at the bottom of the sidebar.", { n: away }) : tr("還沒有團隊。按左下角的「新增團隊」開始。", "No teams yet. Click New team at the bottom left to start.") }));
    if (this.mode === "orbit") return this.orbitCompany(teams, away, count);
    if (this.mode === "space") return this.spaceCompany(teams, away, count);
    // The room picked, if any: a click on the floor where there is no room lets it go.
    const pick = teams.find((t) => t.teamId === this.companyPick) ?? null;
    // Rooms laid out as a floor: as many columns as rows. A large office takes 2 × 2 cells.
    const large = (t: (typeof teams)[number]) => themeName(t.teamId, t.officeLayoutId, t.memberIds.length) === "premium";
    const cols = floorColumns(teams.map((t) => (large(t) ? 2 : 1)), this.mapFrame.w / this.mapFrame.h);
    const grid = h("div", { class: "office-map", role: "list", style: `${this.mapTransform()}--cols:${cols};` });
    const battle = this.mode === "battle";
    for (const t of teams) {
      const run = this.store.run(t.currentRunId);
      const alerts = this.alerts(t.teamId).length;
      const p = this.store.progress(t.teamId);
      const room = h(
        "div",
        { class: `office-room-tile${t.teamId === pick?.teamId ? " on" : ""}${large(t) ? " big" : ""}`, role: "listitem" },
        h(
          "button",
          {
            class: `office-room-pick${battle ? " battle" : ""}`, type: "button",
            "aria-label": [t.name, p.percent === null ? tr("尚未派工", "No tasks yet") : `${p.percent}%`, alerts ? trf("{n} 項需要你", alerts === 1 ? "{n} needs you" : "{n} need you", { n: alerts }) : ""].filter(Boolean).join(tr(",", ", ")),
            onClick: () => {
              if (this.dragged) return;
              this.companyPick = t.teamId;
              this.host.render();
            },
            onKeydown: ((e: KeyboardEvent) => { if (e.key === "Enter" && e.shiftKey) this.host.openTeam(t.teamId); }) as EventListener,
            onDblclick: () => this.host.openTeam(t.teamId),
          },
          this.scene(t.teamId, true).el,
          // The boss of each room, still: the animation is only in the team's own office.
          battle ? roomBadge(this.battle.vm(t.teamId)) : null,
        ),
        h(
          "div",
          { class: "office-room-plate" },
          h("b", { title: t.name, text: t.name }),
          h("span", { class: "office-theme-tag", text: THEME_LABELS[themeName(t.teamId, t.officeLayoutId, t.memberIds.length)] }),
          run && (run.status === "running" || run.status === "needs_attention" || run.status === "pausing") ? h("span", { class: "office-live", title: tr("團隊正在工作,畫面即時更新", "The team is at work, updating live"), text: "LIVE" }) : null, // i18n-ok: LIVE is the same in both languages
          this.runLabel(run),
          h("span", { class: "dim", text: p.percent === null ? tr("尚未派工", "No tasks yet") : `${p.percent}%` }),
          alerts ? h("span", { class: "office-count", title: trf("{n} 項需要你", alerts === 1 ? "{n} needs you" : "{n} need you", { n: alerts }), text: String(alerts) }) : null,
        ),
        this.figures(t.teamId, "office-figures room"),
      );
      grid.append(room);
    }
    const side = h(
      "aside",
      { class: "office-side" },
      ...(pick ? this.roomSummary(pick) : [this.companySummary(teams)]),
      this.attentionCard(teams),
    );
    return h(
      "div",
      { class: "office office-company" },
      h("div", { class: "office-head" },
        h("div", {}, editableText("company", companyName(), {
          tag: "h1",
          label: tr("公司名稱", "Company name"),
          fallback: tr("我的公司", "My Company"),
          onSave: (v) => setCompanyName(v),
          render: () => this.host.render(),
        }), h("p", { class: "dim", text: `${trf("{n} 間辦公室 · {seats} 位員工", "{n} offices · {seats} staff", { n: teams.length, seats: count.seats })}${away ? trf(" · 另有 {n} 個團隊已封存", " · {n} more archived", { n: away }) : ""}` })),
        this.demoTag(),
        this.demo ? h("button", { class: "btn plain", type: "button", title: tr("播放規格附帶的下一個事件", "Plays the next event that comes with the spec"), onClick: () => { if (!this.step()) this.tell(() => tr("示範事件已全部播放。", "Every demo event has played.")); this.host.render(); } }, tr("下一個示範事件", "Next demo event")) : null,
        h("span", { style: "flex:1" }),
        battle ? h("span", { class: "bt-tagline", text: tr("每個團隊的目標都是一隻需求魔王", "Every team's goal is a Requirements Overlord") }) : null,
        battle
          ? h("label", { class: "bt-live", title: tr("在公司總覽也播放每間辦公室的戰鬥過程:比較耗效能,關掉後縮圖只顯示靜態的戰況", "Plays every office's fight on the Company overview too: it costs more to draw; turned off, the thumbnails show each battle standing still") },
              h("input", {
                type: "checkbox", checked: this.companyLive,
                onChange: (e: Event) => {
                  this.companyLive = (e.target as HTMLInputElement).checked;
                  saveCompanyLive(this.companyLive);
                  // Off: every room stops where it is.
                  if (!this.companyLive) for (const sc of this.minis.values()) { const l = sc.currentLayer; if (l instanceof BattleLayer) l.stop(); }
                  this.host.render();
                },
              }),
              tr("戰鬥動畫", "Battle animation"))
          : null,
        this.modeSwitch()),
      this.connection(),
      this.trouble(),
      h("div", { class: "office-body" }, this.mapViewport(grid), side),
    );
  }

  // ── 無邊界 ────────────────────────────────────────────────────────────────────

  /** The tone of each team on the 無邊界 map, by its place in the list: neighbours never share one. */
  private static SPACE_TONES = ["#F5A524", "#FB7185", "#34D399", "#A78BFA", "#F472B6", "#38BDF8", "#2DD4BF", "#FBBF24"];

  /** A fixed sprinkle of stars, as one box-shadow: the same sky every time. */
  private static stars(w: number, h: number): string {
    let seed = 7;
    const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const out: string[] = [];
    for (let i = 0; i < 140; i++) {
      const x = Math.round(next() * w), y = Math.round(next() * h), a = (0.2 + next() * 0.5).toFixed(2);
      out.push(`${x}px ${y}px 0 ${next() < 0.15 ? 1 : 0}px rgba(255, 255, 255, ${a})`);
    }
    return out.join(",");
  }

  /** Agent Center's mark: a hexagon with a dot in it. */
  private static HEX = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5Z"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="5.6" stroke-dasharray="2.2 3"/></svg>';

  /**
   * 無邊界: one team per card around Agent Center, inside one big dashed
   * ring. Each card reads left to right the way the work flows: what was
   * asked of Agent Center, Agent Center, then the agents it put on it; a bar
   * under them is how far the team is. A dotted path ties every card to the
   * hub, flowing while the team works. The corners carry the company's numbers.
   */
  private spaceCompany(teams: Team[], away: number, count: { seats: number }): HTMLElement {
    const pick = teams.find((t) => t.teamId === this.companyPick) ?? null;
    const n = teams.length;
    const CW = 320, CH = 190;
    // Cards on an ellipse wide enough that none touch: its rim is about 2π·0.83·rx long.
    const rx = Math.max(560, Math.ceil((n * (CW + 70)) / (2 * Math.PI * 0.832)));
    const ry = Math.round(rx * 0.62);
    const W = 2 * rx + CW + 260, H = 2 * ry + CH + 220;
    const cx = W / 2, cy = H / 2;
    const spots = teams.map((t, i) => {
      // The first card sits top-left, the way a page is read; the rest follow clockwise.
      const a = -Math.PI * 0.75 + (i / n) * 2 * Math.PI;
      return { t, i, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), tone: Office.SPACE_TONES[i % Office.SPACE_TONES.length] };
    });
    const live = (run: TeamRun | undefined) => !!run && (run.status === "running" || run.status === "needs_attention" || run.status === "pausing");
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "office-space-paths");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    svg.setAttribute("aria-hidden", "true");
    // The company's edge: one dashed ring around every card.
    const rim = document.createElementNS(ns, "ellipse");
    rim.setAttribute("cx", String(cx));
    rim.setAttribute("cy", String(cy));
    rim.setAttribute("rx", String(rx + CW / 2 + 70));
    rim.setAttribute("ry", String(ry + CH / 2 + 70));
    rim.setAttribute("class", "office-space-rim");
    svg.append(rim);
    for (const s of spots) {
      const run = this.store.run(s.t.currentRunId);
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", `M ${s.x} ${s.y} L ${cx} ${cy}`);
      path.setAttribute("class", `office-space-path${live(run) ? " live" : ""}`);
      path.setAttribute("style", `--tone:${s.tone}`);
      svg.append(path);
      // A bead on the path, a little out from the hub, in the team's tone.
      const bead = document.createElementNS(ns, "circle");
      const k = 0.62;
      bead.setAttribute("cx", String(cx + (s.x - cx) * k));
      bead.setAttribute("cy", String(cy + (s.y - cy) * k));
      bead.setAttribute("r", "5");
      bead.setAttribute("class", "office-space-bead");
      bead.setAttribute("style", `--tone:${s.tone}`);
      svg.append(bead);
    }
    const board = h("div", { class: "office-space", style: `${this.mapTransform()}width:${W}px;height:${H}px;` },
      h("i", { class: "office-space-stars", "aria-hidden": "true", style: `box-shadow:${Office.stars(W, H)}` }),
      svg);
    const working = new Set<WorkStatus>(["working", "planning", "reviewing"]);
    let online = 0, done = 0, decisions = 0;
    const badge = (run: TeamRun | undefined, alerts: number): [string, string] => {
      if (alerts) return [tr("等你決定", "Needs you"), "alert"];
      switch (run?.status) {
        case "running": return [tr("進行中", "Running"), "work"];
        case "pausing": case "paused": return [tr("暫停", "Paused"), "quiet"];
        case "needs_attention": return [tr("等你決定", "Needs you"), "alert"];
        case "completed": return [tr("完成", "Done"), "done"];
        case "failed": return [tr("失敗", "Failed"), "alert"];
        default: return [tr("待命", "Standing by"), "quiet"];
      }
    };
    const face = (color: string, cls = "", title = "") => h("i", { class: `sp-face ${cls}`, style: `--c:${color}`, title, "aria-hidden": title ? undefined : "true" });
    for (const s of spots) {
      const { t } = s;
      const run = this.store.run(t.currentRunId);
      const alerts = this.alerts(t.teamId).length;
      const p = this.store.progress(t.teamId);
      const members = this.store.members(t.teamId);
      const busy = members.filter((m) => working.has(m.workStatus)).length;
      online += busy;
      done += p.completed;
      decisions += alerts;
      // What the team was asked: its goal, or failing that the last thing said in it.
      const talk = t.goal.trim() || [...this.store.messages(t.teamId)].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).at(-1)?.text?.trim() || tr("還沒有交代任務", "Nothing asked yet");
      const [label, tone] = badge(run, alerts);
      const shown = members.slice(0, 5);
      const card = h(
        "div",
        { class: `sp-card${t.teamId === pick?.teamId ? " on" : ""}${live(run) ? " live" : ""}`, role: "listitem", style: `left:${s.x}px;top:${s.y}px;--tone:${s.tone}` },
        h(
          "button",
          {
            class: "sp-card-pick", type: "button",
            "aria-label": [t.name, label, p.percent === null ? tr("尚未派工", "No tasks yet") : `${p.percent}%`].join(tr(",", ", ")),
            onClick: () => {
              if (this.dragged) return;
              this.companyPick = t.teamId;
              this.host.render();
            },
            onKeydown: ((e: KeyboardEvent) => { if (e.key === "Enter" && e.shiftKey) this.host.openTeam(t.teamId); }) as EventListener,
            onDblclick: () => this.host.openTeam(t.teamId),
          },
          h("div", { class: "sp-head" },
            h("b", { title: t.name, text: t.name }),
            h("span", { class: `sp-badge ${tone}`, text: label })),
          h("div", { class: "sp-flow" },
            h("div", { class: "sp-talk", title: talk },
              face(s.tone, "you"),
              h("p", { text: talk })),
            h("i", { class: "sp-wire", "aria-hidden": "true" }),
            h("span", { class: "sp-center", title: "Agent Center", html: Office.HEX }), // i18n-ok: the same in both
            h("i", { class: "sp-wire fan", "aria-hidden": "true" }),
            h("div", { class: "sp-agents", title: trf("{n} 位成員,{busy} 位工作中", "{n} members, {busy} working", { n: members.length, busy }) },
              ...shown.map((m) => face(m.color ?? s.tone, working.has(m.workStatus) ? "busy" : "", `${m.displayName ?? m.memberId} · ${STATUS[m.workStatus]?.label ?? m.workStatus}`)),
              members.length > shown.length ? h("small", { text: `+${members.length - shown.length}` }) : null,
              members.length ? null : h("small", { class: "dim", text: tr("還沒有成員", "No members yet") }))),
          h("div", { class: "sp-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(p.percent ?? 0), title: p.total ? trf("{done} / {all} 項任務", "{done} / {all} tasks", { done: p.completed, all: p.total }) : tr("尚未派工", "No tasks yet") },
            h("i", { style: `width:${p.percent ?? 0}%` })),
        ),
      );
      board.append(card);
    }
    const hub = h(
      "button",
      {
        class: "office-hub", type: "button", style: `left:${cx}px;top:${cy}px`,
        title: this.host.openSecretary ? tr("打開 Agent Center", "Open Agent Center") : "",
        onClick: () => { if (!this.dragged) this.host.openSecretary?.(); },
      },
      h("i", { class: "office-hub-ring r3", "aria-hidden": "true" }),
      h("i", { class: "office-hub-ring r2", "aria-hidden": "true" }),
      h("span", { class: "office-hub-core", html: Office.HEX }),
      h("span", { class: "office-hub-label", text: "Agent Center" }), // i18n-ok: the same in both
    );
    board.append(hub);
    // The company's numbers in the corners, over the sky and not scaled with it.
    const stat = (where: string, big: string, small: string, tone = "") =>
      h("div", { class: `sp-stat ${where} ${tone}` }, h("b", { text: big }), h("small", { text: small }));
    // The company's name and size are in the page head already: only the numbers here.
    const corners = [
      stat("tr", String(done), tr("個任務 · 已完成", "tasks · done"), "ok"),
      stat("bl", String(online), tr("位 Agent · 同時在線", "agents · at work now"), "ok"),
      stat("br", String(decisions), decisions === 1 ? tr("個決定等你", "decision waits for you") : tr("個決定等你", "decisions wait for you"), decisions ? "alert" : ""),
    ];
    const chart = h(
      "div",
      { class: "office-minimap", "aria-hidden": "true" },
      h("div", { class: "office-minimap-sky" },
        h("i", { class: "office-minimap-hub", style: `left:${((cx / W) * 100).toFixed(1)}%;top:${((cy / H) * 100).toFixed(1)}%` }),
        ...spots.map((s) => h("i", { class: `office-minimap-dot${s.t.teamId === pick?.teamId ? " on" : ""}`, style: `left:${((s.x / W) * 100).toFixed(1)}%;top:${((s.y / H) * 100).toFixed(1)}%;background:${s.tone}` }))),
    );
    const side = h(
      "aside",
      { class: "office-side" },
      ...(pick ? this.roomSummary(pick) : [this.companySummary(teams)]),
      this.attentionCard(teams),
    );
    return h(
      "div",
      { class: "office office-company space" },
      h("div", { class: "office-head" },
        h("div", {}, editableText("company", companyName(), {
          tag: "h1",
          label: tr("公司名稱", "Company name"),
          fallback: tr("我的公司", "My Company"),
          onSave: (v) => setCompanyName(v),
          render: () => this.host.render(),
        }), h("p", { class: "dim", text: `${trf("{n} 間辦公室 · {seats} 位員工", "{n} offices · {seats} staff", { n: teams.length, seats: count.seats })}${away ? trf(" · 另有 {n} 個團隊已封存", " · {n} more archived", { n: away }) : ""}` })),
        this.demoTag(),
        this.demo ? h("button", { class: "btn plain", type: "button", title: tr("播放規格附帶的下一個事件", "Plays the next event that comes with the spec"), onClick: () => { if (!this.step()) this.tell(() => tr("示範事件已全部播放。", "Every demo event has played.")); this.host.render(); } }, tr("下一個示範事件", "Next demo event")) : null,
        h("span", { style: "flex:1" }),
        this.modeSwitch()),
      this.connection(),
      this.trouble(),
      h("div", { class: "office-body" }, this.mapViewport(board, { cls: "space", over: [...corners, chart] }), side),
    );
  }

  /** In 中二模式, the picked room's boss: the same numbers as its office. */
  private bossCard(pick: Team): HTMLElement | null {
    const vm = this.battle.vm(pick.teamId);
    if (!vm) return null;
    const added = this.battle.log(pick.teamId).filter((s) => s.kind === "scope_added" && s.runId === vm.runId).reduce((n, s) => n + s.source.taskIds.length, 0);
    return bossCard(vm, {
      world: WORLDS[savedWorld(pick.teamId)],
      added,
      // The team's own board: into its office first, then its tasks.
      board: () => {
        this.host.openTeam(pick.teamId);
        this.host.showBoard(pick.teamId);
      },
    });
  }

  /** The room picked on the map: its team at a glance, and the way in. */
  private roomSummary(pick: Team): (HTMLElement | null)[] {
    const pickRun = this.store.run(pick.currentRunId);
    const leader = this.store.member(pick.teamId, pick.leaderMemberId);
    return [
      h("div", { class: "office-card" },
        h("div", { class: "row" }, h("h2", { title: pick.name, text: pick.name }), this.demoTag()),
        h("p", { class: "dim", text: pick.goal.split("\n")[0] }),
        this.runLabel(pickRun),
        this.progressBar(pick.teamId),
        this.figures(pick.teamId),
        leader ? h("p", { class: "dim", text: `Leader · ${leader.displayName ?? leader.memberId}(${STATUS[leader.workStatus].label})` }) : h("p", { class: "dim", text: tr("還沒有指定 Leader,請到團隊設定。", "No Leader yet: pick one in Team setup.") }), // i18n-ok: "Leader" is the same in both languages
        h("button", { class: "btn primary", type: "button", onClick: () => this.host.openTeam(pick.teamId) }, tr("進入辦公室 →", "Go into the office →")),
      ),
      this.mode === "battle" ? this.bossCard(pick) : null,
      h("div", { class: "office-card" },
        h("h3", { text: tr("團隊成員", "Members") }),
        ...this.store.members(pick.teamId).map((m) =>
          h("button", { class: "office-member-row", type: "button", onClick: () => { this.sel = { teamId: pick.teamId, memberId: m.memberId }; this.host.openTeam(pick.teamId); } },
            h("i", { class: "office-blob", style: `background:${m.color}` }),
            h("span", { class: "grow" }, h("b", { text: m.displayName ?? m.memberId }), h("small", { class: "dim", text: ` ${m.roleLabel}` })),
            this.status(m.workStatus)),
        ),
      ),
    ];
  }

  /** No room picked: how the company stands, and how to look closer. */
  private companySummary(teams: Team[]): HTMLElement {
    const runOf = (t: Team) => this.store.run(t.currentRunId)?.status;
    const need = teams.filter((t) => runOf(t) === "needs_attention" || this.alerts(t.teamId).length).length;
    const busy = teams.filter((t) => (runOf(t) === "running" || runOf(t) === "pausing") && !this.alerts(t.teamId).length).length;
    const done = teams.filter((t) => runOf(t) === "completed").length;
    const rest = Math.max(0, teams.length - busy - need - done);
    const stat = (n: number, label: string, tone: string) => h("div", { class: `office-stat ${tone}` }, h("b", { text: String(n) }), h("span", { text: label }));
    // Every team's run: tasks, tokens and their cost, most expensive first.
    const rows = teams
      .map((t) => ({ t, snap: this.runs.get(t.teamId), s: this.spend(t.teamId) }))
      .filter((r) => r.snap);
    const tasks = rows.reduce((a, r) => [a[0] + r.snap!.done, a[1] + r.snap!.total], [0, 0]);
    const tokens = rows.reduce((a, r) => a + (r.s?.tokens ?? 0), 0);
    const all = usageSummary(rows.flatMap((r) => r.snap!.members.flatMap((m) => m.usage ?? [])), () => this.host.render());
    rows.sort((a, b) => (b.s?.tokens ?? 0) - (a.s?.tokens ?? 0));
    // Everyone on the payroll, by what they are doing now.
    const staff = teams.flatMap((t) => this.store.members(t.teamId));
    const tone = (m: (typeof staff)[number]) => STATUS[m.workStatus].tone;
    const working = staff.filter((m) => tone(m) === "work").length;
    const waitingYou = staff.filter((m) => tone(m) === "alert").length;
    const resting = staff.length - working - waitingYou;
    return h("div", { class: "office-card" },
      h("div", { class: "row" }, h("h2", { text: tr("公司總覽", "Company overview") }), this.demoTag()),
      h("h3", { class: "office-stats-title", text: tr("員工", "Staff") }),
      h("div", { class: "office-stats" }, stat(staff.length, tr("員工", "Staff"), "quiet"), stat(working, tr("工作中", "Working"), "work"), stat(waitingYou, tr("等你處理", "Waiting for you"), "alert"), stat(resting, tr("休息/待命", "Resting / standing by"), "done")),
      h("h3", { class: "office-stats-title", text: trf("團隊({n} 個)", "Teams ({n})", { n: teams.length }) }),
      this.mode === "battle"
        ? (() => {
            // The same teams, by their boss: paused, stopped or failed is never counted as beaten.
            const states = teams.map((t) => this.battle.vm(t.teamId)).map((vm) => (vm ? companyState(vm).tone : "idle"));
            const n = (tone: string) => states.filter((s) => s === tone).length;
            return h("div", { class: "office-stats" }, stat(n("fight"), tr("討伐中", "Fighting"), "work"), stat(n("alert"), tr("需介入", "Needs you"), "alert"), stat(n("won"), tr("已擊敗", "Defeated"), "done"), stat(n("idle"), tr("待命", "Standing by"), "quiet"));
          })()
        : h("div", { class: "office-stats" }, stat(busy, tr("執行中", "Running"), "work"), stat(need, tr("需介入", "Needs you"), "alert"), stat(done, tr("已完成", "Done"), "done"), stat(rest, tr("待命", "Standing by"), "quiet")),
      rows.length
        ? h("div", { class: "office-figures", title: tr("各團隊本輪的合計,隨團隊工作即時更新", "Every team's totals for this run, updated live as they work") },
            h("span", {}, h("small", { text: tr("任務", "Tasks") }), h("b", { text: `${tasks[0]}/${tasks[1]}` })),
            h("span", {}, h("small", { text: "Token" }), h("b", { text: fmtTokens(tokens) })),
            h("span", {}, h("small", { text: tr("預估成本", "Est. cost") }), h("b", { text: all.usd == null ? "—" : `${all.priced ? "" : "≥ "}${fmtMoney(all.usd)}` })))
        : null,
      rows.length
        ? h("table", { class: "office-teams" },
            h("thead", {}, h("tr", {}, h("th", { text: tr("團隊", "Team") }), h("th", { text: tr("任務", "Tasks") }), h("th", { text: "Token" }), h("th", { text: tr("成本", "Cost") }))),
            h("tbody", {}, ...rows.map(({ t, snap, s }) =>
              h("tr", { onClick: () => { this.companyPick = t.teamId; this.host.render(); }, title: tr("看這間辦公室的摘要", "See this office's summary") },
                h("td", {}, h("i", { class: `office-dot ${this.runTone(t)}` }), t.name),
                h("td", { text: `${snap!.done}/${snap!.total}` }),
                h("td", { text: s ? fmtTokens(s.tokens) : "0" }),
                h("td", { text: s?.cost || "—" })))))
        : null,
      h("p", { class: "dim", text: `${this.mode === "orbit" ? tr("點團隊名稱看它的摘要,再按「進入辦公室」進去。", "Click a team name for its summary, then Go into the office. ") : tr("點一間辦公室看它的摘要;雙擊直接進去。", "Click an office for its summary; double-click to go in. ")}${tr("成本依「成本與用量」的價格表估算。", "Costs are estimated from the price list in Cost & usage.")}` }),
    );
  }

  private runTone(t: Team): string {
    const s = this.store.run(t.currentRunId)?.status;
    return this.alerts(t.teamId).length || s === "needs_attention" ? "alert" : s === "running" || s === "pausing" ? "work" : s === "completed" ? "done" : "quiet";
  }

  // ── The company map: drag to move, zoom 40–160 %, back to the whole floor ──

  private dragged = false;

  private mapTransform() {
    const v = this.view;
    return `transform:translate(${v.x}px, ${v.y}px) scale(${v.zoom});`;
  }

  /**
   * Places the floor in its viewport: centred both ways at the zoom chosen,
   * then moved by however far it was dragged. Called whenever the viewport
   * or the floor changes size.
   */
  private fitZoom(vp: HTMLElement, grid: HTMLElement) {
    const fit = Math.min(1, (vp.clientWidth - 8) / grid.offsetWidth, (vp.clientHeight - 8) / grid.offsetHeight);
    return Math.min(1.6, Math.max(0.4, Math.floor(fit * 10) / 10));
  }

  private placeMap(vp: HTMLElement, grid: HTMLElement) {
    if (vp.clientWidth && vp.clientHeight) {
      const before = this.mapFrame.w / this.mapFrame.h;
      this.mapFrame = { w: vp.clientWidth, h: vp.clientHeight };
      // A frame of another shape may want another number of columns.
      if (Math.abs(Math.log(before / (vp.clientWidth / vp.clientHeight))) > 0.25) queueMicrotask(() => this.host.render());
    }
    if (!this.viewTouched && grid.offsetWidth) {
      this.view.zoom = this.fitZoom(vp, grid);
      const label = vp.parentElement?.querySelector(".office-map-controls span");
      if (label) label.textContent = `${Math.round(this.view.zoom * 100)}%`;
    }
    const v = this.view;
    const cx = (vp.clientWidth - grid.offsetWidth * v.zoom) / 2;
    const cy = (vp.clientHeight - grid.offsetHeight * v.zoom) / 2;
    grid.style.transform = `translate(${cx + v.x}px, ${cy + v.y}px) scale(${v.zoom})`;
  }

  private zoomTo(z: number) {
    this.viewTouched = true;
    this.view.zoom = Math.min(1.6, Math.max(0.4, Math.round(z * 10) / 10));
    this.host.render();
  }

  private mapViewport(grid: HTMLElement, extra: { cls?: string; over?: (HTMLElement | null)[] } = {}): HTMLElement {
    const vp = h("div", { class: `office-map-viewport${extra.cls ? ` ${extra.cls}` : ""}`, "aria-label": tr("辦公室地圖,拖曳可移動", "Office map, drag to move it") }, grid, ...(extra.over ?? []));
    let start: { x: number; y: number; vx: number; vy: number; id: number } | null = null;
    vp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, id: e.pointerId };
      this.dragged = false;
    });
    vp.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!this.dragged && Math.hypot(dx, dy) < 5) return;
      if (!this.dragged) vp.setPointerCapture(e.pointerId);
      this.dragged = true;
      this.viewTouched = true;
      this.view.x = start.vx + dx;
      this.view.y = start.vy + dy;
      this.placeMap(vp, grid);
    });
    // Centred from the first frame, and again when the window or the floor changes size.
    const ro = new ResizeObserver(() => {
      if (!vp.isConnected) return ro.disconnect();
      this.placeMap(vp, grid);
    });
    ro.observe(vp);
    ro.observe(grid);
    const end = () => {
      start = null;
      // A drag is not a click on the room it ended over.
      window.setTimeout(() => (this.dragged = false), 0);
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    // A click on the floor where there is no room lets the picked room go.
    vp.addEventListener("click", (e) => {
      if (this.dragged || (e.target as HTMLElement).closest(".office-room-tile") || this.companyPick === null) return;
      this.companyPick = null;
      this.host.render();
    });
    vp.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomTo(this.view.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    const controls = h(
      "div",
      { class: "office-map-controls", role: "group", "aria-label": tr("地圖縮放", "Map zoom") },
      h("button", { class: "icon-btn", type: "button", title: tr("縮小", "Zoom out"), "aria-label": tr("縮小", "Zoom out"), disabled: this.view.zoom <= 0.4, onClick: () => this.zoomTo(this.view.zoom - 0.1) }, "−"),
      h("span", { class: "dim", "aria-live": "polite", text: `${Math.round(this.view.zoom * 100)}%` }),
      h("button", { class: "icon-btn", type: "button", title: tr("放大", "Zoom in"), "aria-label": tr("放大", "Zoom in"), disabled: this.view.zoom >= 1.6, onClick: () => this.zoomTo(this.view.zoom + 0.1) }, "+"),
      h("button", {
        class: "btn plain", type: "button", title: tr("縮放到看得見所有辦公室", "Zoom to see every office"),
        onClick: () => {
          // The whole floor in view, centred both ways — and kept so as the window changes.
          this.viewTouched = false;
          this.view = { zoom: this.fitZoom(vp, grid), x: 0, y: 0 };
          this.host.render();
        },
      }, tr("全景", "Overview")),
    );
    return h("div", { class: "office-map-wrap" }, vp, controls, h("p", { class: "dim office-hint", text: tr("點房間看摘要,雙擊或按「進入辦公室」進去 · 拖曳移動,Ctrl + 滾輪縮放", "Click a room for its summary, double-click or Go into the office to go in · drag to move, Ctrl + scroll to zoom") }));
  }

  // ── A team's office ──────────────────────────────────────────────────────────

  team(teamId: string): HTMLElement {
    const pick = this.picked.get(teamId);
    this.viewing = pick?.store ?? null;
    const team = this.store.team(teamId);
    if (!team) return h("div", { class: "office-empty", text: tr("這個團隊還沒有資料。", "Nothing for this team yet.") });
    // A drawer from another team is not this team's business.
    if (this.sel && this.sel.teamId !== teamId) this.sel = null;
    const run = this.store.run(team.currentRunId);
    const members = this.store.members(teamId);
    // Space and Standard are the company's pictures: a team's page is its office, or its battle.
    const orbit = false;
    const scene = this.scene(teamId);
    const past = !!this.viewing;
    const battle = this.mode === "battle";
    const vm = battle ? this.boss(teamId) : null;
    const caps: Capabilities = past
      ? { canPause: false, canResume: false, canSendInstruction: false, pauseMode: "cooperative", unavailableReasons: { pause: tr("這是歷史執行", "This is an earlier run"), resume: tr("這是歷史執行", "This is an earlier run"), instruction: tr("這是歷史執行,只能查看", "This is an earlier run, to look at only") } }
      : this.capabilities(run);
    const toggles = orbit
      ? this.orbitToolbar(this.orbitView(teamId))
      : h(
          "div",
          { class: "office-toggles" },
          h("label", {}, h("input", { type: "checkbox", checked: this.bubbles, onChange: (e: Event) => { this.bubbles = (e.target as HTMLInputElement).checked; this.host.render(); } }), tr("溝通泡泡", "Chat bubbles")),
          this.calmToggle(),
        );
    const pauseBtn = past
      ? null
      : caps.canPause
      ? h("button", { class: "btn plain", type: "button", title: tr("暫停團隊:不再派新回合,正在做的會做完", "Pause the team: no new rounds, what's under way gets finished"), onClick: () => void this.command(teamId, "pause") }, tr("暫停團隊", "Pause team"))
      : caps.canResume
        ? h("button", { class: "btn primary", type: "button", onClick: () => void this.command(teamId, "resume") }, tr("繼續", "Resume"))
        : h("button", { class: "btn plain", type: "button", disabled: true, title: caps.unavailableReasons.pause ?? "" }, run?.status === "pausing" ? tr("暫停中…", "Pausing…") : tr("暫停團隊", "Pause team"));
    const cap = scene?.capacity ?? Infinity;
    const extra = members.length > cap ? h("p", { class: "dim", text: trf("另外 {n} 位成員還沒有工位(這間辦公室最多 {cap} 張桌子),在下方名單裡。", members.length - cap === 1 ? "{n} more member has no desk yet (this office has at most {cap}); it's in the list below." : "{n} more members have no desk yet (this office has at most {cap}); they're in the list below.", { n: members.length - cap, cap }) }) : null;
    const roster = h(
      "div",
      { class: "office-roster", role: "list", "aria-label": tr("團隊成員", "Members") },
      ...members.map((m) =>
        h("button", {
          class: `office-roster-item${this.sel?.memberId === m.memberId ? " on" : ""}`, type: "button", role: "listitem",
          "aria-pressed": this.sel?.memberId === m.memberId ? "true" : "false",
          onClick: () => this.select(teamId, m.memberId),
        },
          h("i", { class: "office-blob", style: `background:${m.color}` }),
          h("span", { class: "grow" },
            h("b", {}, m.memberId === team.leaderMemberId ? "♛ " : "", m.displayName ?? m.memberId, battle ? this.heroChip(teamId, m.memberId) : null),
            h("small", { class: "dim", text: ` ${m.memberId === team.leaderMemberId ? "Leader · " : ""}${m.roleLabel}` }), // i18n-ok: "Leader" is the same in both languages
            h("span", { class: "office-roster-task", text: m.summary || (m.primaryTaskId ? this.store.task(m.primaryTaskId)?.title ?? "" : "") }),
            (() => {
              const s = past ? null : this.spend(teamId, m.memberId);
              return s ? h("span", { class: "office-roster-spend", text: `${fmtTokens(s.tokens)} tokens${s.cost ? ` · ${s.cost}` : ""}` }) : null;
            })(),
            (() => {
              if (!battle || past) return null;
              const v = this.vitals(teamId, m.memberId);
              if (!v) return null;
              return h("span", { class: `bt-member-hp${v.dead ? " dead" : v.frac <= 0.2 ? " low" : ""}`, title: v.dead ? trf("已達上限而陣亡:{why}。到團隊設定提高上限才會復活。", "Fallen at the limit: {why}. Raise the limit in Team setup to revive it.", { why: v.why }) : tr("這位成員自己的上限當生命:用越多越少", "This member's own limit is its HP: the more it uses, the less is left") },
                h("i", {}, h("b", { style: `width:${v.dead ? 0 : Math.max(2, v.frac * 100).toFixed(0)}%` })),
                v.dead ? h("em", { text: tr("陣亡", "Fallen") }) : null);
            })()),
          this.status(m.workStatus))),
    );
    if (battle && !past) this.fallenWatch(teamId);
    const side = this.sel ? this.drawer(teamId) : battle ? this.battleSide(teamId, vm) : this.activity(teamId);
    return h(
      "div",
      { class: `office office-team${battle ? " battle" : ""}` },
      h("div", { class: "office-head" },
        h("div", { class: "office-head-main" }, this.runLabel(run), this.progressBar(teamId), past ? null : this.figures(teamId, "office-figures inline"), this.demoTag()),
        toggles,
        pauseBtn,
        this.modeSwitch(true)),
      past
        ? h("div", { class: "office-history-bar", role: "status" },
            h("span", { class: "grow" }, h("b", { text: tr("你正在看之前的一輪", "You're looking at an earlier run") }), trf(" · {when} 收起的紀錄,只能查看,不會影響現在的團隊", " · the record put away {when}, to look at only: it doesn't touch the team now", { when: this.when(this.store.run(team.currentRunId) ? pick!.at : pick!.at) })),
            h("button", { class: "btn primary", type: "button", onClick: () => void this.pickRun(teamId, null) }, tr("回到本輪", "Back to this run")))
        : null,
      pick?.error ? h("div", { class: "office-notice", role: "alert", text: pick.error() }) : null,
      this.connection(),
      this.trouble(),
      this.notice ? h("div", { class: "office-notice", role: "status", text: this.notice }) : null,
      h("div", { class: "office-body" },
        h("div", { class: "office-main" },
          ...(scene
            ? [h("div", { class: `office-frame${battle ? " battle" : ""}` }, scene.el, battle && vm ? bossHud(this.blowPending(teamId) ? { ...vm, bossState: "sealing" } : vm, WORLDS[savedWorld(teamId)]) : null, battle && vm ? teamBar(this.runs.get(teamId) && this.runs.get(teamId)!.maxTurns ? { used: this.runs.get(teamId)!.totalTurns, max: this.runs.get(teamId)!.maxTurns } : null) : null)]
            : this.orbitFrame(teamId)),
          extra, roster),
        side),
    );
  }

  private when(ms: number) {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  /**
   * Earlier runs: when a team is started again, Coucou keeps the old log
   * beside the new one. They are listed under the office's activity, to be
   * looked at; the current run is what the office shows otherwise.
   */
  private earlierRuns(teamId: string): HTMLElement | null {
    if (!this.host.history) return null;
    const list = this.histories.get(teamId);
    if (list === undefined) {
      this.histories.set(teamId, "pending");
      this.host.history(teamId).then((runs) => { this.histories.set(teamId, runs); if (runs.length) this.host.render(); }, () => this.histories.set(teamId, []));
      return null;
    }
    if (list === "pending" || !list.length) return null;
    const word: Record<PastRun["status"], string> = { idle: tr("沒有開始", "Never started"), running: tr("中斷", "Interrupted"), paused: tr("暫停時收起", "Put away while paused"), finished: tr("已完成", "Done") };
    const on = this.picked.get(teamId)?.at;
    return h("div", { class: "office-card" },
      h("h3", { text: tr("之前的執行", "Earlier runs") }),
      h("p", { class: "dim", text: tr("團隊重新開始時,上一輪的紀錄會保留下來,可以點開回顧。", "When a team starts over, the last run's record is kept: click one to look back.") }),
      ...list.slice(0, 6).map((r) => {
        const here = r.archivedAt === on;
        return h("button", {
          class: `office-member-row${here ? " here" : ""}`, type: "button", "aria-pressed": here ? "true" : "false",
          onClick: () => void this.pickRun(teamId, here ? null : r.archivedAt),
        },
          h("span", { class: "grow" },
            h("b", { text: trf("{when} 開始", "Started {when}", { when: this.when(r.startedAt || r.archivedAt) }) }),
            h("small", { class: "dim", text: ` · ${r.total ? trf("{done}/{all} 項", "{done}/{all} tasks", { done: r.done, all: r.total }) : tr("沒有任務", "No tasks")} · ${word[r.status]}` })),
          h("span", { class: `office-pill ${here ? "work" : "quiet"}`, text: here ? tr("正在看", "Viewing") : tr("查看", "View") }));
      }));
  }

  private async pickRun(teamId: string, at: number | null) {
    this.sel = null;
    if (at === null || !this.host.past) {
      this.picked.delete(teamId);
      this.host.render();
      return;
    }
    this.picked.set(teamId, { at, store: null });
    try {
      const snap = await this.host.past(teamId, at);
      const file = fileFromSnapshot(snap);
      const store = new OfficeStore();
      const runs = new Map([[teamId, snap]]);
      store.loadSnapshot(new RealAdapter({ pause: async () => {}, resume: async () => {}, instruct: async () => "" }).snapshot([file], runs));
      this.picked.set(teamId, { at, store });
    } catch (err) {
      const why = String(err instanceof Error ? err.message : err);
      this.picked.set(teamId, { at, store: null, error: () => trf("讀不到這一輪的紀錄:{err}", "Couldn't read this run's record: {err}", { err: why }) });
    }
    this.host.render();
  }

  /** What happened in the office, newest first: hand-offs, questions, deliveries. */
  private activity(teamId: string): HTMLElement {
    return h("aside", { class: "office-side" }, ...this.activityCards(teamId));
  }

  private activityCards(teamId: string): (HTMLElement | null)[] {
    const name = (id: string) => this.store.member(teamId, id)?.displayName ?? id;
    const items: { at: string; who: string | null; head: string; body: string; artifact?: string }[] = [];
    for (const m of this.store.messages(teamId)) {
      const from = m.from.kind === "member" ? m.from.memberId : null;
      const fromName = m.from.kind === "member" ? name(m.from.memberId) : m.from.kind === "user" ? tr("你", "You") : "Agent Center";
      items.push({ at: m.occurredAt, who: from, head: `${fromName}${m.toMemberIds.length ? ` → ${m.toMemberIds.map(name).join(tr("、", ", "))}` : ""}`, body: m.text });
    }
    for (const a of this.store.artifacts(teamId)) {
      items.push({ at: a.updatedAt, who: a.authorMemberId, head: trf("{name} 交付", "{name} delivered", { name: name(a.authorMemberId) }), body: a.name, artifact: a.artifactId });
    }
    items.sort((a, b) => b.at.localeCompare(a.at));
    const waits = this.store.members(teamId).filter((m) => m.workStatus === "waiting_dependency" && m.waitingFor);
    return [
      h("div", { class: "office-card" },
        h("h3", { text: tr("辦公室動態", "Office activity") }),
        items.length
          ? h("ol", { class: "office-feed" }, ...items.slice(0, 30).map((it) =>
              h("li", {},
                h("button", { type: "button", class: "office-feed-item", onClick: () => it.who && this.select(teamId, it.who) },
                  h("time", { text: clock(it.at) }),
                  h("b", { text: it.head }),
                  h("span", { text: it.body })))))
          : h("p", { class: "dim", text: tr("還沒有動態。", "Nothing yet.") })),
      waits.length
        ? h("div", { class: "office-card" }, h("h3", { text: tr("待處理相依關係", "Open dependencies") }),
            ...waits.map((m) => h("button", { class: "office-member-row", type: "button", onClick: () => this.select(teamId, m.memberId) },
              h("span", { class: "grow" }, h("b", { text: trf("{name} 正在等待 {on}", "{name} is waiting on {on}", { name: m.displayName ?? m.memberId, on: m.waitingFor!.memberIds.map(name).join(tr("、", ", ")) || tr("交付", "a hand-in") }) }), h("small", { class: "dim", text: ` ${m.waitingFor!.expectedArtifact ?? m.waitingFor!.reason}` })))))
        : null,
      this.earlierRuns(teamId),
      h("p", { class: "dim office-hint", text: tr("點選 Agent 查看工作與對話", "Click an agent to see its work and talk") }),
    ];
  }

  // ── The member drawer ────────────────────────────────────────────────────────

  private drawer(teamId: string): HTMLElement {
    const team = this.store.team(teamId)!;
    const m = this.store.member(teamId, this.sel!.memberId)!;
    const name = (id: string) => this.store.member(teamId, id)?.displayName ?? id;
    const leader = m.memberId === team.leaderMemberId;
    const task = m.primaryTaskId ? this.store.task(m.primaryTaskId) : undefined;
    const others = m.activeTaskIds.filter((id) => id !== m.primaryTaskId).length;
    const talk = this.store.messages(teamId).filter((x) => (x.from.kind === "member" && x.from.memberId === m.memberId) || x.toMemberIds.includes(m.memberId));
    const files = this.store.artifacts(teamId).filter((a) => a.authorMemberId === m.memberId);
    const dep = m.waitingFor?.memberIds[0];
    const el = h(
      "aside",
      { class: "office-side office-drawer", role: "dialog", "aria-label": trf("{name} 的工作", "{name}'s work", { name: m.displayName ?? m.memberId }), onKeydown: ((e: KeyboardEvent) => { if (e.key === "Escape") this.close(teamId); }) as EventListener },
      h("div", { class: "office-drawer-head" },
        h("i", { class: "office-blob big", style: `background:${m.color}` }),
        h("div", { class: "grow" },
          h("h2", { tabindex: "-1", text: `${m.displayName} · ${m.roleLabel}` }),
          h("div", { class: "row" }, leader ? h("span", { class: "office-pill quiet", text: "♛ Leader" }) : null, this.status(m.workStatus), // i18n-ok: "Leader" is the same in both languages
            m.engineStatus === "offline" ? h("span", { class: "office-pill quiet", title: tr("沒有代理在執行;顯示的是紀錄裡最後的狀態", "No agent is running; this is the last state in the record"), text: tr("⌁ 未連線", "⌁ Offline") }) : null, this.demoTag()),
          h("small", { class: "dim", text: (() => {
            const s = this.viewing ? null : this.spend(teamId, m.memberId);
            return `${trf("最後更新 {t}", "Last updated {t}", { t: clock(m.lastActivityAt) || "—" })}${s ? `${trf(" · 本輪 {tokens} tokens", " · {tokens} tokens this run", { tokens: fmtTokens(s.tokens) })}${s.cost ? ` · ${s.cost}` : ""}` : ""}`;
          })() })),
        h("button", { class: "icon-btn", type: "button", title: tr("關閉(Esc)", "Close (Esc)"), "aria-label": tr("關閉", "Close"), onClick: () => this.close(teamId) }, "✕")),
      this.back
        ? h("button", { class: "link", type: "button", onClick: () => { const b = this.back!; this.back = null; this.select(b.teamId, b.memberId); } }, trf("← 回到 {name}", "← Back to {name}", { name: name(this.back.memberId) }))
        : null,
      (() => {
        if (this.mode !== "battle" || this.viewing) return null;
        const v = this.vitals(teamId, m.memberId);
        if (!v?.dead) return null;
        return h("section", { class: "office-card bt-fallen-card" },
          h("h3", { text: tr("☠ 陣亡", "☠ Fallen") }),
          h("p", { class: "dim", text: trf("{name} {why},倒在戰場上。Leader 已被告知先不要派工作給它。", "{name}: {why}, down on the battlefield. The Leader has been told not to give it work for now.", { name: m.displayName ?? m.memberId, why: v.why }) }),
          this.host.openSetup
            ? h("button", { class: "btn primary", type: "button", onClick: () => this.host.openSetup!(teamId) }, tr("去團隊設定提高上限(復活)", "Raise the limit in Team setup (revive)"))
            : h("p", { class: "hint", text: tr("到「團隊設定」提高它的上限並儲存,就會復活。", "Raise its limit in Team setup and save, and it comes back.") }));
      })(),
      (() => {
        const asks = this.asksOf(teamId, m.memberId);
        return asks.length ? h("section", { class: "office-card office-asks" }, h("h3", { text: tr("需要你處理", "Needs you") }), ...asks) : null;
      })(),
      this.mode === "battle"
        ? h("section", { class: "office-card bt-hero-pick" },
            h("b", { text: tr("職業外觀", "Class") }),
            dropdown({
              value: this.hero(teamId, m.memberId),
              title: tr("只是外觀:不改變這位成員的工作、權限或驗收", "Just a look: it doesn't change this member's work, permissions or reviews"),
              choices: (Object.keys(HERO_LABELS) as HeroClass[]).map((c) => ({ value: c, label: HERO_LABELS[c] })),
              onChange: (v) => { setHero(teamId, m.memberId, v as HeroClass); this.host.render(); },
            }),
            h("b", { text: tr("驗收招式", "Finishing move") }),
            dropdown({
              value: this.skill(teamId, m.memberId),
              title: tr("這位成員的任務驗收通過時的招式:只是外觀,每項任務都固定 100 HP", "The move shown when this member's task is accepted: just a look, every task is still 100 HP"),
              choices: HIT_SKILLS.map((id) => ({ value: id, label: SKILLS[id].name, hint: elementWord(SKILLS[id].element) })),
              onChange: (v) => { setSkill(teamId, m.memberId, v as SkillId); this.host.render(); },
            }),
            h("small", { class: "dim bt-hero-note", text: tr("只改變戰鬥模式裡的樣子:每項任務都固定 100 HP,不影響工作、權限或驗收。", "Only changes how things look in Battle mode: every task is still 100 HP, and work, permissions and reviews stay the same.") }))
        : null,
      h("section", { class: "office-card" },
        h("h3", { text: tr("目前工作", "Working on") }),
        task ? h("p", {}, h("b", { text: task.title }), others ? h("small", { class: "dim", text: trf(" 另外 {n} 項", " and {n} more", { n: others }) }) : null) : h("p", { class: "dim", text: m.workStatus === "idle" ? tr("待命,沒有指派的任務。", "Standing by, no task assigned.") : tr("沒有進行中的任務。", "No task in progress.") }),
        task && this.host.openTask && !this.viewing && !this.demo
          ? h("button", { class: "btn plain", type: "button", title: tr("在溝通紀錄裡看這個任務的對話與交付", "See this task's talk and deliverables in the conversation log"), onClick: () => this.host.openTask!(teamId, task.taskId.slice(teamId.length + 1)) }, tr("開啟任務", "Open task"))
          : null,
        m.summary && m.summary !== task?.title ? h("p", { class: "dim", text: m.summary }) : null,
        task?.acceptanceCriteria.length ? h("ul", { class: "office-criteria" }, ...task.acceptanceCriteria.map((c) => h("li", { class: c.passed ? "ok" : "" }, h("i", { "aria-hidden": "true", text: c.passed ? "✓" : "○" }), c.text))) : null),
      m.waitingFor
        ? h("section", { class: "office-card wait" },
            h("dl", {},
              h("dt", { text: tr("等待原因", "Waiting because") }), h("dd", { text: m.waitingFor.reason }),
              m.waitingFor.memberIds.length ? h("dt", { text: tr("依賴對象", "Depends on") }) : null,
              m.waitingFor.memberIds.length ? h("dd", { text: m.waitingFor.memberIds.map((id) => `${name(id)} · ${this.store.member(teamId, id)?.roleLabel ?? ""}`).join(tr("、", ", ")) }) : null,
              m.waitingFor.expectedArtifact ? h("dt", { text: tr("所需交付", "Needs") }) : null,
              m.waitingFor.expectedArtifact ? h("dd", { text: m.waitingFor.expectedArtifact }) : null,
              m.waitingFor.nextAction ? h("dt", { text: tr("下一步", "Next") }) : null,
              m.waitingFor.nextAction ? h("dd", { text: m.waitingFor.nextAction }) : null),
            dep && this.store.member(teamId, dep)
              ? h("button", { class: "btn plain", type: "button", onClick: () => { this.back = { teamId, memberId: m.memberId }; this.sel = { teamId, memberId: dep }; this.host.render(); } }, tr("定位依賴 Agent", "Show the agent it depends on"))
              : null)
        : null,
      h("div", { class: "tabs office-tabs", role: "tablist" },
        h("button", { class: `tab${this.tab === "work" ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(this.tab === "work"), onClick: () => { this.tab = "work"; this.host.render(); } }, trf("成果 ({n})", "Deliverables ({n})", { n: files.length })),
        h("button", { class: `tab${this.tab === "talk" ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(this.tab === "talk"), onClick: () => { this.tab = "talk"; this.host.render(); } }, trf("對話 ({n})", "Talk ({n})", { n: talk.length }))),
      this.tab === "talk" ? this.thread(teamId, talk) : this.filesList(teamId, files),
      this.viewing ? null : this.composer(teamId),
    );
    return el;
  }

  private thread(teamId: string, talk: Message[]) {
    const name = (id: string) => this.store.member(teamId, id)?.displayName ?? id;
    if (!talk.length) return h("p", { class: "dim", text: tr("還沒有和這位成員有關的對話。", "No talk with this member yet.") });
    // The newest forty, and the way to earlier ones forty at a time.
    const key = `${teamId}/${this.sel?.memberId}`;
    const shown = this.threadLength.get(key) ?? 40;
    const hidden = Math.max(0, talk.length - shown);
    const more = hidden
      ? h("li", { class: "office-more" }, h("button", { class: "link", type: "button", onClick: () => { this.threadLength.set(key, shown + 40); this.host.render(); } }, trf("顯示更早的 {n} 則(還有 {left} 則)", "Show {n} earlier ({left} left)", { n: Math.min(40, hidden), left: hidden })))
      : null;
    return h("ol", { class: "office-thread" }, more, ...talk.slice(-shown).map((x) => {
      const from = x.from.kind === "member" ? name(x.from.memberId) : x.from.kind === "user" ? tr("你", "You") : "Agent Center";
      const long = x.text.length > 160;
      const body = h("p", { class: long ? "clip" : "", text: x.text });
      return h("li", {},
        h("div", { class: "meta" }, h("b", { text: `${from}${x.toMemberIds.length ? ` → ${x.toMemberIds.map(name).join(tr("、", ", "))}` : ""}` }), h("time", { text: clock(x.occurredAt) }), h("small", { class: "dim", text: x.deliveryStatus === "delivered" ? tr("已讀取", "Read") : x.deliveryStatus === "failed" ? tr("送達失敗", "Not delivered") : tr("已送出", "Sent") }), x.taskId ? h("small", { class: "dim", text: this.store.task(x.taskId)?.title ?? "" }) : null),
        body,
        long ? h("button", { class: "link", type: "button", onClick: (e: Event) => { body.classList.toggle("clip"); (e.target as HTMLElement).textContent = body.classList.contains("clip") ? tr("展開", "More") : tr("收合", "Less"); } }, tr("展開", "More")) : null,
        // The pictures the message names, to look at here.
        this.demo ? null : thumbsFor(teamId, x.text));
    }));
  }

  private filesList(teamId: string, files: ReturnType<OfficeStore["artifacts"]>) {
    if (!files.length) return h("p", { class: "dim", text: tr("還沒有交付成果。", "Nothing delivered yet.") });
    return h("ul", { class: "office-files" }, ...files.map((a) => {
      const pic = this.preview(a);
      return h("li", {}, h("button", {
        class: "office-file", type: "button",
        title: this.demo ? tr("示範資料:沒有實際檔案", "Demo data: no real file") : a.resourceRef,
        onClick: () => this.openArtifact(teamId, a),
      },
      pic ? h("img", { class: "office-thumb", src: pic, alt: "" }) : h("i", { "aria-hidden": "true", text: { image: "🖼", document: "📄", code: "⌨", website: "🌐", bundle: "📦" }[a.kind] }),
      h("span", { class: "grow", text: a.name }), h("small", { class: "dim", text: `v${a.artifactVersion}` })));
    }));
  }

  /** 補充指示 to the team's leader: sending, accepted, applied or failed — the text survives a failure. */
  private composer(teamId: string): HTMLElement {
    const team = this.store.team(teamId)!;
    const caps = this.capabilities(this.store.run(team.currentRunId));
    const s = this.sending.get(teamId);
    const cmd: CommandRecord | undefined = s?.commandId ? this.store.command(s.commandId) : undefined;
    const state = s?.error ? trf("失敗:{err}", "Failed: {err}", { err: s.error }) : !s ? "" : !s.commandId ? tr("送出中…", "Sending…")
      : cmd?.status === "applied" ? tr("已套用 · Leader 已讀到", "Applied · the Leader has read it")
      : cmd?.status === "applying" ? tr("已記錄 · Leader 下一輪會讀到", "Recorded · the Leader reads it next round")
      : cmd?.status === "failed" ? trf("失敗:{err}", "Failed: {err}", { err: cmd.errorMessage ?? "" }) : tr("已接受", "Accepted");
    const leader = this.store.member(teamId, team.leaderMemberId);
    const area = h("textarea", {
      class: "office-input", rows: "2", maxlength: String(MAX_INSTRUCTION), "data-key": `office-instruct-${teamId}`,
      placeholder: !caps.canSendInstruction ? caps.unavailableReasons.instruction ?? ""
        : this.store.run(team.currentRunId)?.status === "completed"
          ? trf("團隊已完成 · 有新需求或修改意見就寫給 Leader{who},團隊會繼續工作", "The team is done · write any new asks or changes to the Leader{who} and the team carries on", { who: leader ? tr(`(${leader.displayName})`, ` (${leader.displayName})`) : "" })
          : trf("補充指示給 Leader{who}…", "More instructions for the Leader{who}…", { who: leader ? tr(`(${leader.displayName})`, ` (${leader.displayName})`) : "" }),
      disabled: !caps.canSendInstruction,
      "aria-label": tr("補充指示給 Leader", "More instructions for the Leader"),
    }) as HTMLTextAreaElement;
    area.value = this.drafts.get(teamId) ?? "";
    area.addEventListener("input", () => this.drafts.set(teamId, area.value));
    const send = () => void this.instruct(teamId, area.value);
    area.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    return h("div", { class: "office-composer" },
      h("div", { class: "row" }, area, h("button", { class: "btn primary", type: "button", disabled: !caps.canSendInstruction, onClick: send }, s?.error || cmd?.status === "failed" ? tr("重試", "Retry") : tr("送出", "Send"))),
      state ? h("small", { class: `office-sendstate${s?.error ? " bad" : ""}`, role: "status", text: state }) : h("small", { class: "dim", text: `${(this.drafts.get(teamId) ?? "").length} / ${MAX_INSTRUCTION}` }));
  }

  private async instruct(teamId: string, raw: string) {
    const text = raw.trim();
    if (!text || text.length > MAX_INSTRUCTION) return;
    const team = this.store.team(teamId)!;
    const prev = this.sending.get(teamId);
    // A retry of the same words is the same command.
    const clientRequestId = prev && (prev.error || !prev.commandId) && this.drafts.get(teamId) === raw ? prev.clientRequestId : crypto.randomUUID();
    this.sending.set(teamId, { clientRequestId });
    this.host.render();
    try {
      const ack = await (this.real ?? this.mock)!.sendCommand({ kind: "instruction", teamId, runId: team.currentRunId, clientRequestId, expectedRunRevision: this.store.run(team.currentRunId)?.revision ?? 0, payload: { text, target: "leader" } });
      this.sending.set(teamId, { clientRequestId, commandId: ack.commandId });
      const rec = this.store.command(ack.commandId);
      if (!rec) {
        const now = new Date().toISOString();
        this.store.noteCommand({ commandId: ack.commandId, clientRequestId, teamId, runId: team.currentRunId, kind: "instruction", status: "accepted", createdAt: now, errorCode: null, errorMessage: null, revision: 0, updatedAt: now });
      }
      this.drafts.delete(teamId);
    } catch (err) {
      this.sending.set(teamId, { clientRequestId, error: String(err instanceof Error ? err.message : err) });
    }
    this.host.render();
  }

  private async command(teamId: string, kind: "pause" | "resume") {
    const team = this.store.team(teamId)!;
    try {
      await (this.real ?? this.mock)!.sendCommand({ kind, teamId, runId: team.currentRunId, clientRequestId: crypto.randomUUID(), expectedRunRevision: this.store.run(team.currentRunId)?.revision ?? 0, payload: null });
      this.tell(() => kind === "pause" ? tr("已送出暫停:不再派新的回合,正在做的會做完。", "Pause sent: no new rounds, what's under way gets finished.") : tr("已送出繼續。", "Resume sent."));
    } catch (err) {
      this.tell(() => trf("沒有成功:{err}", "That didn't work: {err}", { err: String(err instanceof Error ? err.message : err) }));
    }
    this.host.render();
  }

  /** Development only: a team's battle layer, to hold one move still and look at it. */
  /** The Leader's final blow has not landed yet in this team's room. */
  private blowPending(teamId: string): boolean {
    const l = this.scenes.get(teamId)?.currentLayer;
    return l instanceof BattleLayer && l.finishPending;
  }

  debugLayer(teamId: string): BattleLayer | null {
    const layer = this.scenes.get(teamId)?.currentLayer;
    return layer instanceof BattleLayer ? layer : null;
  }

  /** After the page is drawn: Mochis moving again; a raid no longer on screen stops, and is not caught up on later. */
  afterRender() {
    for (const sc of this.scenes.values()) {
      const layer = sc.currentLayer;
      if (!sc.el.isConnected && layer instanceof BattleLayer) layer.stop();
    }
    // The 星域 draws only while it is on the page; off it, no frame runs.
    if (this.orbit) {
      if (this.orbit.el.isConnected) this.orbit.wake();
      else this.orbit.stop();
    }
    wake();
  }
}
