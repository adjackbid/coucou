// The Office: the company map, a team's office and the member drawer — a
// picture of the same record the board shows (feature/OFFICE-整合規劃.md).
//
// The page (main.ts) draws itself again on every change; the scenes here are
// kept and moved into each new page, so the Mochis keep moving. Selection is
// by (teamId, memberId) and is dropped when the team changes, so one team's
// work never shows in another's drawer.

import "./office.css";
import { h } from "../../views/dom";
import type { Artifact, CommandRecord, MemberSnapshot, Message, Team, TeamRun, Capabilities } from "./contracts";
import { OfficeStore } from "./store";
import { floorColumns } from "./floor";
import { RealAdapter, fileFromSnapshot } from "./adapter-real";
import { MockAdapter } from "./adapter-mock";
import { loadArt, STATUS, TeamScene, themeName, THEME_LABELS, wake } from "./scene";
import { dropdown, editableText } from "../ui";
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
}

const MAX_INSTRUCTION = 2000;

/** 正向滿版鏡頭 (fullbleed-frontal-v1): on by dev URL `&camera=frontal` or a saved choice. */
function frontalCam(): boolean {
  try {
    if (typeof location !== "undefined" && new URLSearchParams(location.search).get("camera") === "frontal") return true;
    return localStorage.getItem("coucou.office.camera") === "frontal";
  } catch {
    return false;
  }
}

/** The element of a move, in a word. */
const ELEMENT_WORD: Record<string, string> = { fire: "火", ice: "冰", wind: "風", lightning: "雷", physical: "刀光", support: "支援", any: "" };

/** What the person calls their company; "我的公司" until they name it. */
export function companyName(): string {
  try {
    return localStorage.getItem("coucou.company.name")?.trim() || "我的公司";
  } catch {
    return "我的公司";
  }
}

export function setCompanyName(name: string) {
  try {
    localStorage.setItem("coucou.company.name", name);
  } catch {
    /* kept until the window closes */
  }
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
  calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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
  private picked = new Map<string, { at: number; store: OfficeStore | null; error?: string }>();
  private runs = new Map<string, Snapshot>();
  /** 中二模式: the same work told as a raid; the person's own preference. */
  mode: PresentationMode = savedMode();
  /** In 中二模式, whether the company map plays every room's fight (it costs more to draw). */
  companyLive = companyLive();
  companyFps = companyFps();
  /** Who already fell, per team: a down and a revival are each told once. */
  private fallenSeen = new Map<string, Set<string>>();
  /** In 中二模式, what the column beside the room shows. */
  private sideView: "battle" | "raw" = "battle";
  /** Each team's raid as the window has watched it. */
  readonly battle: Battle;

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
        s.frontal = this.mode === "office" && frontalCam();
        s.update();
      }
      for (const s of this.minis.values()) {
        s.frontal = this.mode === "office" && frontalCam();
        s.update();
      }
      // What changed, told as the raid: only once the store has applied it.
      this.battle.observeAll();
      // A member that went away closes its drawer.
      if (this.sel && !this.viewing && !this.main.member(this.sel.teamId, this.sel.memberId)) {
        this.sel = null;
        this.notice = "這位成員已移出團隊。";
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
  }

  notice = "";

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
    s.reduceMotion = this.calm || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    // 中二模式: the boss and the heroes' looks over the room; the Office as it was otherwise.
    if (this.mode === "battle") {
      let layer = this.layers.get(s);
      if (!layer) {
        this.layers.set(s, (layer = new BattleLayer(s, this.layerHost(teamId, this.store))));
        layer.taskOwner = (taskId) => this.store.task(taskId)?.assigneeMemberId ?? null;
      }
      s.setLayer(layer);
    } else s.setLayer(null);
    s.frontal = this.mode === "office" && frontalCam();
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
      taskTitle: (taskId: string) => store.task(taskId)?.title ?? "任務",
      members: () => store.members(teamId).map((m) => m.memberId),
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
      calm: () => this.calm || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
      waiting: () => store.members(teamId).find((m) => m.workStatus === "waiting_input" || m.workStatus === "blocked")?.memberId ?? null,
      contributions: (sig: BattleSignal) => this.contributions(teamId, sig),
      planned: (plan: HitPlan) => {
        for (const id of plan.sourceSignalIds) {
          const names = this.moves.get(id) ?? [];
          const who = plan.memberIds.map((m) => store.member(teamId, m)?.displayName ?? m).join(" + ");
          names.push(`${plan.skillId ? SKILLS[plan.skillId].name : "驗收命中"}${who ? `(${who})` : ""}`);
          this.moves.set(id, names);
        }
        this.host.render();
      },
    };
  }

  /** The moves chosen for each acceptance signal, for the 戰鬥紀錄. */
  private moves = new Map<string, string[]>();

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
      this.notice = `示範資料:「${a.name}」沒有實際檔案可以開啟。`;
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
    return this.demo ? h("span", { class: "office-demo", title: "這些是規格附帶的示範資料,不是正在執行的團隊", text: "示範資料" }) : null;
  }

  private status(s: MemberSnapshot["workStatus"]) {
    const st = STATUS[s];
    return h("span", { class: `office-pill ${st.tone}` }, h("i", { "aria-hidden": "true", text: st.icon }), st.label);
  }

  private runLabel(run: TeamRun | undefined) {
    const m: Record<TeamRun["status"], [string, string, string]> = {
      idle: ["待命", "○", "quiet"], running: ["執行中", "●", "work"], pausing: ["暫停中", "Ⅱ", "wait"], paused: ["已暫停", "Ⅱ", "quiet"],
      needs_attention: ["需介入", "!", "alert"], completed: ["已完成", "✓", "done"], failed: ["失敗", "✕", "alert"], cancelled: ["已取消", "–", "quiet"],
    };
    const [label, icon, tone] = m[run?.status ?? "idle"];
    return h("span", { class: `office-pill ${tone}` }, h("i", { "aria-hidden": "true", text: icon }), label);
  }

  private progressBar(teamId: string) {
    const p = this.store.progress(teamId);
    return h(
      "div",
      { class: "office-progress" },
      h("b", { text: p.percent === null ? "尚未派工" : `${p.percent}%` }),
      p.total ? h("span", { class: "dim", text: `${p.completed} / ${p.total} 項任務` }) : null,
      h("span", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(p.percent ?? 0) }, h("i", { style: `width:${p.percent ?? 0}%` })),
    );
  }

  private alerts(teamId: string) {
    return this.store.members(teamId).filter((m) => STATUS[m.workStatus].tone === "alert");
  }

  /** 中二模式的個人血量: what is left of a member's own limits; null when none are set. */
  private vitals(teamId: string, memberId: string): { frac: number; dead: boolean; why: string } | null {
    const cfg = this.files.find((f) => f.config?.id === teamId)?.config;
    const mc = cfg?.members.find((x) => x.id === memberId);
    if (!mc || (!mc.maxTokens && !mc.maxCostUsd)) return null;
    const mv = this.runs.get(teamId)?.members.find((x) => x.id === memberId);
    if (!mv) return null;
    const u = usageSummary(mv.usage ?? [], () => this.host.render());
    let worst = 0;
    let why = "";
    if (mc.maxTokens && u.tokens / mc.maxTokens > worst) {
      worst = u.tokens / mc.maxTokens;
      why = "Token 已達上限";
    }
    if (mc.maxCostUsd && u.usd != null && u.usd / mc.maxCostUsd > worst) {
      worst = u.usd / mc.maxCostUsd;
      why = "成本已達上限";
    }
    return { frac: Math.max(0, 1 - worst), dead: worst >= 1, why };
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
            .instruct(teamId, `【系統】${m.displayName} 已達自己的${v!.why.replace("已達上限", "上限")},在中二模式中陣亡。請不要再指派新任務給 ${m.displayName};等人類在「團隊設定」提高上限讓它復活。`, `bt-fallen:${run.id}:${this.battle.vm(teamId)?.runId ?? ""}:${m.memberId}`)
            .catch(() => {});
        }
      } else if (!dead && seen.has(m.memberId)) {
        seen.delete(m.memberId);
        bl?.memberUp(m.memberId);
        if (canTell) {
          void this.host
            .instruct(teamId, `【系統】${m.displayName} 的上限已提高,已復活,可以繼續指派任務。`, `bt-revived:${run.id}:${this.battle.vm(teamId)?.runId ?? ""}:${m.memberId}`)
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
      { class: cls, title: "本輪的任務、用掉的 token 與預估成本(依「成本與用量」的價格表),隨團隊工作即時更新" },
      h("span", {}, h("small", { text: "任務" }), h("b", { text: `${snap.done}/${snap.total}` })),
      h("span", {}, h("small", { text: "Token" }), h("b", { text: s ? fmtTokens(s.tokens) : "0" })),
      h("span", {}, h("small", { text: "成本" }), h("b", { text: s?.cost || "—" })),
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
    if (this.store.syncing) return h("div", { class: "office-stale", role: "status", text: "資料同步中…" });
    if (c.status === "stale" || c.status === "reconnecting") return h("div", { class: "office-stale", role: "status", text: `資料已過期 · 最後更新 ${clock(c.lastServerTime ?? "")}` });
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
    return h("span", { class: `bt-hero ${c}`, title: "中二模式的職業外觀:只是外觀,不改變工作", text: HERO_LABELS[c] });
  }

  /** Office or 中二模式: the same work, told two ways. */
  private modeSwitch(): HTMLElement {
    const opt = (mode: PresentationMode, label: string, title: string) =>
      h("button", { class: `bt-${mode}${this.mode === mode ? " on" : ""}`, type: "button", "aria-pressed": this.mode === mode ? "true" : "false", title, onClick: () => this.setMode(mode) }, label);
    return h("div", { class: "bt-mode", role: "group", "aria-label": "畫面模式" },
      opt("office", "Office", "一般辦公室畫面"),
      opt("battle", "中二模式", "同一份工作,看成團隊討伐需求魔王:只改變畫面,不影響工作"));
  }

  /** 團隊設定 picked another battlefield: the old one's moves stop where they are. */
  worldChanged(teamId: string) {
    for (const sc of [this.scenes.get(teamId), this.minis.get(teamId)]) {
      const layer = sc?.currentLayer;
      if (layer instanceof BattleLayer) layer.stop();
    }
    this.host.render();
  }

  setMode(mode: PresentationMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    saveMode(mode);
    // Off: the boss leaves every room and nothing of it goes on playing.
    if (mode === "office") for (const s of [...this.scenes.values(), ...this.minis.values()]) s.setLayer(null);
    this.host.render();
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
      h("button", { class: this.sideView === "battle" ? "on" : "", type: "button", role: "tab", "aria-selected": String(this.sideView === "battle"), onClick: () => { this.sideView = "battle"; this.host.render(); } }, "戰鬥紀錄"),
      h("button", { class: this.sideView === "raw" ? "on" : "", type: "button", role: "tab", "aria-selected": String(this.sideView === "raw"), onClick: () => { this.sideView = "raw"; this.host.render(); } }, "原始活動"));
    if (this.sideView === "raw") return h("aside", { class: "office-side" }, tabs, ...this.activityCards(teamId));
    const name = (id: string) => this.store.member(teamId, id)?.displayName ?? id;
    // The boss's counter is a real question: answered here, the way it is everywhere else.
    const waiting = this.viewing ? [] : this.alerts(teamId);
    const decide = waiting.length
      ? h("div", { class: "office-card bt-decide" },
          h("h3", { text: "需要你決定" }),
          h("p", { class: "dim", text: "魔王反擊:有成員在等你。回覆或批准之後,團隊才會繼續。" }),
          ...waiting.flatMap((m) => [
            h("button", { class: "office-member-row", type: "button", onClick: () => this.select(teamId, m.memberId) },
              h("i", { class: "office-blob", style: `background:${m.color}` }),
              h("span", { class: "grow" }, h("b", { text: m.displayName }), h("small", { class: "dim", text: ` ${m.waitingFor?.reason ?? STATUS[m.workStatus].label}` })),
              h("span", { class: "office-pill alert", text: "查看" })),
            ...this.asksOf(teamId, m.memberId),
          ]))
      : null;
    return h("aside", { class: "office-side" },
      tabs,
      vm?.bossState === "defeated" ? this.result(teamId, vm) : null,
      decide,
      h("div", { class: "office-card" },
        h("h3", { text: this.viewing ? "戰鬥紀錄(這是之前的一輪,只看結果)" : "戰鬥紀錄" }),
        this.viewing
          ? h("p", { class: "dim", text: "之前的一輪不重演過程;它的對話與交付在「原始活動」。" })
          : battleLog(this.battle.log(teamId), { name, open: (s) => this.openSignal(teamId, s), moves: (id) => this.moves.get(id) }),
        h("p", { class: "dim office-hint", text: "每一列都是真實發生的事:點一下看那位成員或任務。" })),
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
        h("div", { class: "grow" }, h("h3", { text: "討伐成果" }), h("small", { class: "dim", text: `${WORLDS[savedWorld(teamId)].bossName} 已擊敗 · ${leader ? `${leader.displayName} ` : ""}已結案` }))),
      h("div", { class: "office-figures" },
        h("span", {}, h("small", { text: "驗收任務" }), h("b", { text: `${vm.progress.completed} 項` })),
        s ? h("span", {}, h("small", { text: "Token" }), h("b", { text: fmtTokens(s.tokens) })) : null,
        s ? h("span", {}, h("small", { text: "成本" }), h("b", { text: s.cost || "—" })) : null),
      h("ul", { class: "bt-result-tasks" }, ...tasks.map((t) =>
        h("li", {}, h("button", {
          type: "button", title: "看這個任務的對話與交付",
          onClick: () => (this.host.openTask && !this.demo && !this.viewing ? this.host.openTask(teamId, t.taskId.slice(teamId.length + 1)) : t.assigneeMemberId && this.select(teamId, t.assigneeMemberId)),
        }, h("i", { "aria-hidden": "true", text: "✓" }), t.title)))),
      h("div", { class: "bt-actions" },
        h("button", { class: "btn plain", type: "button", onClick: () => this.host.showBoard(teamId) }, "看任務看板"),
        this.viewing ? null : h("button", {
          class: "btn plain", type: "button", title: "只重播動畫:不重算任何資料,也不算第二次完成",
          onClick: () => { const l = this.scenes.get(teamId)?.currentLayer; if (l instanceof BattleLayer) l.replay(); },
        }, "重播擊敗動畫")),
      h("p", { class: "dim office-hint", text: "獎章只是這台電腦上的完成紀念;Token 和費用照原本的統計。" }));
  }

  // ── The company ──────────────────────────────────────────────────────────────

  company(): HTMLElement {
    this.viewing = null;
    // Teams put away stay in the record but not on the floor.
    const teams = this.store.teams().filter((t) => !t.archived);
    const away = this.store.teams().length - teams.length;
    const count = this.store.headcount();
    if (!teams.length) return h("div", { class: "office-empty" }, h("p", { text: away ? `${away} 個團隊都已封存。到側欄下方的「已封存」可以取出。` : "還沒有團隊。按左下角的「新增團隊」開始。" }));
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
            "aria-label": `${t.name},${run ? "" : ""}${p.percent === null ? "尚未派工" : `${p.percent}%`}${alerts ? `,${alerts} 項需要你` : ""}`,
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
          run && (run.status === "running" || run.status === "needs_attention" || run.status === "pausing") ? h("span", { class: "office-live", title: "團隊正在工作,畫面即時更新", text: "LIVE" }) : null,
          this.runLabel(run),
          h("span", { class: "dim", text: p.percent === null ? "尚未派工" : `${p.percent}%` }),
          alerts ? h("span", { class: "office-count", title: `${alerts} 項需要你`, text: String(alerts) }) : null,
        ),
        this.figures(t.teamId, "office-figures room"),
      );
      grid.append(room);
    }
    const attention = teams.flatMap((t) => this.alerts(t.teamId).map((m) => ({ t, m })));
    const side = h(
      "aside",
      { class: "office-side" },
      ...(pick ? this.roomSummary(pick) : [this.companySummary(teams)]),
      attention.length
        ? h("div", { class: "office-card alert" }, h("h3", { text: "需要你的注意" }),
            ...attention.map(({ t, m }) =>
              h("div", { class: "office-attn" },
                h("button", { class: "office-member-row", type: "button", title: "進入這間辦公室看這位成員", onClick: () => { this.sel = { teamId: t.teamId, memberId: m.memberId }; this.host.openTeam(t.teamId); } },
                  h("i", { class: "office-blob", style: `background:${m.color}` }),
                  h("span", { class: "grow" }, h("b", { text: `${t.name} · ${m.displayName}` }), h("small", { class: "dim", text: ` ${m.waitingFor?.reason ?? STATUS[m.workStatus].label}` })),
                  h("span", { class: "office-pill alert", text: "查看" })),
                ...this.asksOf(t.teamId, m.memberId))))
        : null,
    );
    return h(
      "div",
      { class: "office office-company" },
      h("div", { class: "office-head" },
        h("div", {}, editableText("company", companyName(), {
          tag: "h1",
          label: "公司名稱",
          fallback: "我的公司",
          onSave: (v) => setCompanyName(v),
          render: () => this.host.render(),
        }), h("p", { class: "dim", text: `${teams.length} 間辦公室 · ${count.seats} 位員工${away ? ` · 另有 ${away} 個團隊已封存` : ""}` })),
        this.demoTag(),
        this.demo ? h("button", { class: "btn plain", type: "button", title: "播放規格附帶的下一個事件", onClick: () => { if (!this.step()) this.notice = "示範事件已全部播放。"; this.host.render(); } }, "下一個示範事件") : null,
        h("span", { style: "flex:1" }),
        battle ? h("span", { class: "bt-tagline", text: "每個團隊的目標都是一隻需求魔王" }) : null,
        battle
          ? h("label", { class: "bt-live", title: "在公司總覽也播放每間辦公室的戰鬥過程:比較耗效能,關掉後縮圖只顯示靜態的戰況" },
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
              "戰鬥動畫")
          : null,
        this.modeSwitch()),
      this.connection(),
      this.trouble(),
      h("div", { class: "office-body" }, this.mapViewport(grid), side),
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
        leader ? h("p", { class: "dim", text: `Leader · ${leader.displayName ?? leader.memberId}(${STATUS[leader.workStatus].label})` }) : h("p", { class: "dim", text: "還沒有指定 Leader,請到團隊設定。" }),
        h("button", { class: "btn primary", type: "button", onClick: () => this.host.openTeam(pick.teamId) }, "進入辦公室 →"),
      ),
      this.mode === "battle" ? this.bossCard(pick) : null,
      h("div", { class: "office-card" },
        h("h3", { text: "團隊成員" }),
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
      h("div", { class: "row" }, h("h2", { text: "公司總覽" }), this.demoTag()),
      h("h3", { class: "office-stats-title", text: "員工" }),
      h("div", { class: "office-stats" }, stat(staff.length, "員工", "quiet"), stat(working, "工作中", "work"), stat(waitingYou, "等你處理", "alert"), stat(resting, "休息/待命", "done")),
      h("h3", { class: "office-stats-title", text: `團隊(${teams.length} 個)` }),
      this.mode === "battle"
        ? (() => {
            // The same teams, by their boss: paused, stopped or failed is never counted as beaten.
            const states = teams.map((t) => this.battle.vm(t.teamId)).map((vm) => (vm ? companyState(vm).tone : "idle"));
            const n = (tone: string) => states.filter((s) => s === tone).length;
            return h("div", { class: "office-stats" }, stat(n("fight"), "討伐中", "work"), stat(n("alert"), "需介入", "alert"), stat(n("won"), "已擊敗", "done"), stat(n("idle"), "待命", "quiet"));
          })()
        : h("div", { class: "office-stats" }, stat(busy, "執行中", "work"), stat(need, "需介入", "alert"), stat(done, "已完成", "done"), stat(rest, "待命", "quiet")),
      rows.length
        ? h("div", { class: "office-figures", title: "各團隊本輪的合計,隨團隊工作即時更新" },
            h("span", {}, h("small", { text: "任務" }), h("b", { text: `${tasks[0]}/${tasks[1]}` })),
            h("span", {}, h("small", { text: "Token" }), h("b", { text: fmtTokens(tokens) })),
            h("span", {}, h("small", { text: "預估成本" }), h("b", { text: all.usd == null ? "—" : `${all.priced ? "" : "≥ "}${fmtMoney(all.usd)}` })))
        : null,
      rows.length
        ? h("table", { class: "office-teams" },
            h("thead", {}, h("tr", {}, h("th", { text: "團隊" }), h("th", { text: "任務" }), h("th", { text: "Token" }), h("th", { text: "成本" }))),
            h("tbody", {}, ...rows.map(({ t, snap, s }) =>
              h("tr", { onClick: () => { this.companyPick = t.teamId; this.host.render(); }, title: "看這間辦公室的摘要" },
                h("td", {}, h("i", { class: `office-dot ${this.runTone(t)}` }), t.name),
                h("td", { text: `${snap!.done}/${snap!.total}` }),
                h("td", { text: s ? fmtTokens(s.tokens) : "0" }),
                h("td", { text: s?.cost || "—" })))))
        : null,
      h("p", { class: "dim", text: "點一間辦公室看它的摘要;雙擊直接進去。成本依「成本與用量」的價格表估算。" }),
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

  private mapViewport(grid: HTMLElement): HTMLElement {
    const vp = h("div", { class: "office-map-viewport", "aria-label": "辦公室地圖,拖曳可移動" }, grid);
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
      { class: "office-map-controls", role: "group", "aria-label": "地圖縮放" },
      h("button", { class: "icon-btn", type: "button", title: "縮小", "aria-label": "縮小", disabled: this.view.zoom <= 0.4, onClick: () => this.zoomTo(this.view.zoom - 0.1) }, "−"),
      h("span", { class: "dim", "aria-live": "polite", text: `${Math.round(this.view.zoom * 100)}%` }),
      h("button", { class: "icon-btn", type: "button", title: "放大", "aria-label": "放大", disabled: this.view.zoom >= 1.6, onClick: () => this.zoomTo(this.view.zoom + 0.1) }, "+"),
      h("button", {
        class: "btn plain", type: "button", title: "縮放到看得見所有辦公室",
        onClick: () => {
          // The whole floor in view, centred both ways — and kept so as the window changes.
          this.viewTouched = false;
          this.view = { zoom: this.fitZoom(vp, grid), x: 0, y: 0 };
          this.host.render();
        },
      }, "全景"),
    );
    return h("div", { class: "office-map-wrap" }, vp, controls, h("p", { class: "dim office-hint", text: "點房間看摘要,雙擊或按「進入辦公室」進去 · 拖曳移動,Ctrl + 滾輪縮放" }));
  }

  // ── A team's office ──────────────────────────────────────────────────────────

  team(teamId: string): HTMLElement {
    const pick = this.picked.get(teamId);
    this.viewing = pick?.store ?? null;
    const team = this.store.team(teamId);
    if (!team) return h("div", { class: "office-empty", text: "這個團隊還沒有資料。" });
    // A drawer from another team is not this team's business.
    if (this.sel && this.sel.teamId !== teamId) this.sel = null;
    const run = this.store.run(team.currentRunId);
    const members = this.store.members(teamId);
    const scene = this.scene(teamId);
    const past = !!this.viewing;
    const battle = this.mode === "battle";
    const vm = battle ? this.boss(teamId) : null;
    const caps: Capabilities = past
      ? { canPause: false, canResume: false, canSendInstruction: false, pauseMode: "cooperative", unavailableReasons: { pause: "這是歷史執行", resume: "這是歷史執行", instruction: "這是歷史執行,只能查看" } }
      : this.capabilities(run);
    const toggles = h(
      "div",
      { class: "office-toggles" },
      h("label", {}, h("input", { type: "checkbox", checked: this.bubbles, onChange: (e: Event) => { this.bubbles = (e.target as HTMLInputElement).checked; this.host.render(); } }), "溝通泡泡"),
      h("label", { title: "只調整畫面動畫,不影響團隊工作" }, h("input", { type: "checkbox", checked: this.calm, onChange: (e: Event) => { this.calm = (e.target as HTMLInputElement).checked; this.host.render(); } }), "減少動態"),
    );
    const pauseBtn = past
      ? null
      : caps.canPause
      ? h("button", { class: "btn plain", type: "button", title: "暫停團隊:不再派新回合,正在做的會做完", onClick: () => void this.command(teamId, "pause") }, "暫停團隊")
      : caps.canResume
        ? h("button", { class: "btn primary", type: "button", onClick: () => void this.command(teamId, "resume") }, "繼續")
        : h("button", { class: "btn plain", type: "button", disabled: true, title: caps.unavailableReasons.pause ?? "" }, run?.status === "pausing" ? "暫停中…" : "暫停團隊");
    const cap = scene.capacity;
    const extra = members.length > cap ? h("p", { class: "dim", text: `另外 ${members.length - cap} 位成員還沒有工位(這間辦公室最多 ${cap} 張桌子),在下方名單裡。` }) : null;
    const roster = h(
      "div",
      { class: "office-roster", role: "list", "aria-label": "團隊成員" },
      ...members.map((m) =>
        h("button", {
          class: `office-roster-item${this.sel?.memberId === m.memberId ? " on" : ""}`, type: "button", role: "listitem",
          "aria-pressed": this.sel?.memberId === m.memberId ? "true" : "false",
          onClick: () => this.select(teamId, m.memberId),
        },
          h("i", { class: "office-blob", style: `background:${m.color}` }),
          h("span", { class: "grow" },
            h("b", {}, m.memberId === team.leaderMemberId ? "♛ " : "", m.displayName ?? m.memberId, battle ? this.heroChip(teamId, m.memberId) : null),
            h("small", { class: "dim", text: ` ${m.memberId === team.leaderMemberId ? "Leader · " : ""}${m.roleLabel}` }),
            h("span", { class: "office-roster-task", text: m.summary || (m.primaryTaskId ? this.store.task(m.primaryTaskId)?.title ?? "" : "") }),
            (() => {
              const s = past ? null : this.spend(teamId, m.memberId);
              return s ? h("span", { class: "office-roster-spend", text: `${fmtTokens(s.tokens)} tokens${s.cost ? ` · ${s.cost}` : ""}` }) : null;
            })(),
            (() => {
              if (!battle || past) return null;
              const v = this.vitals(teamId, m.memberId);
              if (!v) return null;
              return h("span", { class: `bt-member-hp${v.dead ? " dead" : v.frac <= 0.2 ? " low" : ""}`, title: v.dead ? `已達上限而陣亡:${v.why}。到團隊設定提高上限才會復活。` : "這位成員自己的上限當生命:用越多越少" },
                h("i", {}, h("b", { style: `width:${v.dead ? 0 : Math.max(2, v.frac * 100).toFixed(0)}%` })),
                v.dead ? h("em", { text: "陣亡" }) : null);
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
        this.modeSwitch()),
      past
        ? h("div", { class: "office-history-bar", role: "status" },
            h("span", { class: "grow" }, h("b", { text: "你正在看之前的一輪" }), ` · ${this.when(this.store.run(team.currentRunId) ? pick!.at : pick!.at)} 收起的紀錄,只能查看,不會影響現在的團隊`),
            h("button", { class: "btn primary", type: "button", onClick: () => void this.pickRun(teamId, null) }, "回到本輪"))
        : null,
      pick?.error ? h("div", { class: "office-notice", role: "alert", text: pick.error }) : null,
      this.connection(),
      this.trouble(),
      this.notice ? h("div", { class: "office-notice", role: "status", text: this.notice }) : null,
      h("div", { class: "office-body" },
        h("div", { class: "office-main" }, h("div", { class: `office-frame${battle ? " battle" : ""}` }, scene.el, battle && vm ? bossHud(vm, WORLDS[savedWorld(teamId)]) : null, battle && vm ? teamBar(this.runs.get(teamId) && this.runs.get(teamId)!.maxTurns ? { used: this.runs.get(teamId)!.totalTurns, max: this.runs.get(teamId)!.maxTurns } : null) : null), extra, roster),
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
    const word: Record<PastRun["status"], string> = { idle: "沒有開始", running: "中斷", paused: "暫停時收起", finished: "已完成" };
    const on = this.picked.get(teamId)?.at;
    return h("div", { class: "office-card" },
      h("h3", { text: "之前的執行" }),
      h("p", { class: "dim", text: "團隊重新開始時,上一輪的紀錄會保留下來,可以點開回顧。" }),
      ...list.slice(0, 6).map((r) => {
        const here = r.archivedAt === on;
        return h("button", {
          class: `office-member-row${here ? " here" : ""}`, type: "button", "aria-pressed": here ? "true" : "false",
          onClick: () => void this.pickRun(teamId, here ? null : r.archivedAt),
        },
          h("span", { class: "grow" },
            h("b", { text: `${this.when(r.startedAt || r.archivedAt)} 開始` }),
            h("small", { class: "dim", text: ` · ${r.total ? `${r.done}/${r.total} 項` : "沒有任務"} · ${word[r.status]}` })),
          h("span", { class: `office-pill ${here ? "work" : "quiet"}`, text: here ? "正在看" : "查看" }));
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
      this.picked.set(teamId, { at, store: null, error: `讀不到這一輪的紀錄:${String(err instanceof Error ? err.message : err)}` });
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
      const fromName = m.from.kind === "member" ? name(m.from.memberId) : m.from.kind === "user" ? "你" : "Coucou";
      items.push({ at: m.occurredAt, who: from, head: `${fromName}${m.toMemberIds.length ? ` → ${m.toMemberIds.map(name).join("、")}` : ""}`, body: m.text });
    }
    for (const a of this.store.artifacts(teamId)) {
      items.push({ at: a.updatedAt, who: a.authorMemberId, head: `${name(a.authorMemberId)} 交付`, body: a.name, artifact: a.artifactId });
    }
    items.sort((a, b) => b.at.localeCompare(a.at));
    const waits = this.store.members(teamId).filter((m) => m.workStatus === "waiting_dependency" && m.waitingFor);
    return [
      h("div", { class: "office-card" },
        h("h3", { text: "辦公室動態" }),
        items.length
          ? h("ol", { class: "office-feed" }, ...items.slice(0, 30).map((it) =>
              h("li", {},
                h("button", { type: "button", class: "office-feed-item", onClick: () => it.who && this.select(teamId, it.who) },
                  h("time", { text: clock(it.at) }),
                  h("b", { text: it.head }),
                  h("span", { text: it.body })))))
          : h("p", { class: "dim", text: "還沒有動態。" })),
      waits.length
        ? h("div", { class: "office-card" }, h("h3", { text: "待處理相依關係" }),
            ...waits.map((m) => h("button", { class: "office-member-row", type: "button", onClick: () => this.select(teamId, m.memberId) },
              h("span", { class: "grow" }, h("b", { text: `${m.displayName} 正在等待 ${m.waitingFor!.memberIds.map(name).join("、") || "交付"}` }), h("small", { class: "dim", text: ` ${m.waitingFor!.expectedArtifact ?? m.waitingFor!.reason}` })))))
        : null,
      this.earlierRuns(teamId),
      h("p", { class: "dim office-hint", text: "點選 Agent 查看工作與對話" }),
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
      { class: "office-side office-drawer", role: "dialog", "aria-label": `${m.displayName} 的工作`, onKeydown: ((e: KeyboardEvent) => { if (e.key === "Escape") this.close(teamId); }) as EventListener },
      h("div", { class: "office-drawer-head" },
        h("i", { class: "office-blob big", style: `background:${m.color}` }),
        h("div", { class: "grow" },
          h("h2", { tabindex: "-1", text: `${m.displayName} · ${m.roleLabel}` }),
          h("div", { class: "row" }, leader ? h("span", { class: "office-pill quiet", text: "♛ Leader" }) : null, this.status(m.workStatus),
            m.engineStatus === "offline" ? h("span", { class: "office-pill quiet", title: "沒有代理在執行;顯示的是紀錄裡最後的狀態", text: "⌁ 未連線" }) : null, this.demoTag()),
          h("small", { class: "dim", text: (() => {
            const s = this.viewing ? null : this.spend(teamId, m.memberId);
            return `最後更新 ${clock(m.lastActivityAt) || "—"}${s ? ` · 本輪 ${fmtTokens(s.tokens)} tokens${s.cost ? ` · ${s.cost}` : ""}` : ""}`;
          })() })),
        h("button", { class: "icon-btn", type: "button", title: "關閉(Esc)", "aria-label": "關閉", onClick: () => this.close(teamId) }, "✕")),
      this.back
        ? h("button", { class: "link", type: "button", onClick: () => { const b = this.back!; this.back = null; this.select(b.teamId, b.memberId); } }, `← 回到 ${name(this.back.memberId)}`)
        : null,
      (() => {
        if (this.mode !== "battle" || this.viewing) return null;
        const v = this.vitals(teamId, m.memberId);
        if (!v?.dead) return null;
        return h("section", { class: "office-card bt-fallen-card" },
          h("h3", { text: "☠ 陣亡" }),
          h("p", { class: "dim", text: `${m.displayName} ${v.why},倒在戰場上。Leader 已被告知先不要派工作給它。` }),
          this.host.openSetup
            ? h("button", { class: "btn primary", type: "button", onClick: () => this.host.openSetup!(teamId) }, "去團隊設定提高上限(復活)")
            : h("p", { class: "hint", text: "到「團隊設定」提高它的上限並儲存,就會復活。" }));
      })(),
      (() => {
        const asks = this.asksOf(teamId, m.memberId);
        return asks.length ? h("section", { class: "office-card office-asks" }, h("h3", { text: "需要你處理" }), ...asks) : null;
      })(),
      this.mode === "battle"
        ? h("section", { class: "office-card bt-hero-pick" },
            h("b", { text: "職業外觀" }),
            dropdown({
              value: this.hero(teamId, m.memberId),
              title: "只是外觀:不改變這位成員的工作、權限或驗收",
              choices: (Object.keys(HERO_LABELS) as HeroClass[]).map((c) => ({ value: c, label: HERO_LABELS[c] })),
              onChange: (v) => { setHero(teamId, m.memberId, v as HeroClass); this.host.render(); },
            }),
            h("b", { text: "驗收招式" }),
            dropdown({
              value: this.skill(teamId, m.memberId),
              title: "這位成員的任務驗收通過時的招式:只是外觀,每項任務都固定 100 HP",
              choices: HIT_SKILLS.map((id) => ({ value: id, label: SKILLS[id].name, hint: ELEMENT_WORD[SKILLS[id].element] })),
              onChange: (v) => { setSkill(teamId, m.memberId, v as SkillId); this.host.render(); },
            }),
            h("small", { class: "dim bt-hero-note", text: "只改變中二模式裡的樣子:每項任務都固定 100 HP,不影響工作、權限或驗收。" }))
        : null,
      h("section", { class: "office-card" },
        h("h3", { text: "目前工作" }),
        task ? h("p", {}, h("b", { text: task.title }), others ? h("small", { class: "dim", text: ` 另外 ${others} 項` }) : null) : h("p", { class: "dim", text: m.workStatus === "idle" ? "待命,沒有指派的任務。" : "沒有進行中的任務。" }),
        task && this.host.openTask && !this.viewing && !this.demo
          ? h("button", { class: "btn plain", type: "button", title: "在溝通紀錄裡看這個任務的對話與交付", onClick: () => this.host.openTask!(teamId, task.taskId.slice(teamId.length + 1)) }, "開啟任務")
          : null,
        m.summary && m.summary !== task?.title ? h("p", { class: "dim", text: m.summary }) : null,
        task?.acceptanceCriteria.length ? h("ul", { class: "office-criteria" }, ...task.acceptanceCriteria.map((c) => h("li", { class: c.passed ? "ok" : "" }, h("i", { "aria-hidden": "true", text: c.passed ? "✓" : "○" }), c.text))) : null),
      m.waitingFor
        ? h("section", { class: "office-card wait" },
            h("dl", {},
              h("dt", { text: "等待原因" }), h("dd", { text: m.waitingFor.reason }),
              m.waitingFor.memberIds.length ? h("dt", { text: "依賴對象" }) : null,
              m.waitingFor.memberIds.length ? h("dd", { text: m.waitingFor.memberIds.map((id) => `${name(id)} · ${this.store.member(teamId, id)?.roleLabel ?? ""}`).join("、") }) : null,
              m.waitingFor.expectedArtifact ? h("dt", { text: "所需交付" }) : null,
              m.waitingFor.expectedArtifact ? h("dd", { text: m.waitingFor.expectedArtifact }) : null,
              m.waitingFor.nextAction ? h("dt", { text: "下一步" }) : null,
              m.waitingFor.nextAction ? h("dd", { text: m.waitingFor.nextAction }) : null),
            dep && this.store.member(teamId, dep)
              ? h("button", { class: "btn plain", type: "button", onClick: () => { this.back = { teamId, memberId: m.memberId }; this.sel = { teamId, memberId: dep }; this.host.render(); } }, "定位依賴 Agent")
              : null)
        : null,
      h("div", { class: "tabs office-tabs", role: "tablist" },
        h("button", { class: `tab${this.tab === "work" ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(this.tab === "work"), onClick: () => { this.tab = "work"; this.host.render(); } }, `成果 (${files.length})`),
        h("button", { class: `tab${this.tab === "talk" ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(this.tab === "talk"), onClick: () => { this.tab = "talk"; this.host.render(); } }, `對話 (${talk.length})`)),
      this.tab === "talk" ? this.thread(teamId, talk) : this.filesList(teamId, files),
      this.viewing ? null : this.composer(teamId),
    );
    return el;
  }

  private thread(teamId: string, talk: Message[]) {
    const name = (id: string) => this.store.member(teamId, id)?.displayName ?? id;
    if (!talk.length) return h("p", { class: "dim", text: "還沒有和這位成員有關的對話。" });
    // The newest forty, and the way to earlier ones forty at a time.
    const key = `${teamId}/${this.sel?.memberId}`;
    const shown = this.threadLength.get(key) ?? 40;
    const hidden = Math.max(0, talk.length - shown);
    const more = hidden
      ? h("li", { class: "office-more" }, h("button", { class: "link", type: "button", onClick: () => { this.threadLength.set(key, shown + 40); this.host.render(); } }, `顯示更早的 ${Math.min(40, hidden)} 則(還有 ${hidden} 則)`))
      : null;
    return h("ol", { class: "office-thread" }, more, ...talk.slice(-shown).map((x) => {
      const from = x.from.kind === "member" ? name(x.from.memberId) : x.from.kind === "user" ? "你" : "Coucou";
      const long = x.text.length > 160;
      const body = h("p", { class: long ? "clip" : "", text: x.text });
      return h("li", {},
        h("div", { class: "meta" }, h("b", { text: `${from}${x.toMemberIds.length ? ` → ${x.toMemberIds.map(name).join("、")}` : ""}` }), h("time", { text: clock(x.occurredAt) }), h("small", { class: "dim", text: x.deliveryStatus === "delivered" ? "已讀取" : x.deliveryStatus === "failed" ? "送達失敗" : "已送出" }), x.taskId ? h("small", { class: "dim", text: this.store.task(x.taskId)?.title ?? "" }) : null),
        body,
        long ? h("button", { class: "link", type: "button", onClick: (e: Event) => { body.classList.toggle("clip"); (e.target as HTMLElement).textContent = body.classList.contains("clip") ? "展開" : "收合"; } }, "展開") : null);
    }));
  }

  private filesList(teamId: string, files: ReturnType<OfficeStore["artifacts"]>) {
    if (!files.length) return h("p", { class: "dim", text: "還沒有交付成果。" });
    return h("ul", { class: "office-files" }, ...files.map((a) => {
      const pic = this.preview(a);
      return h("li", {}, h("button", {
        class: "office-file", type: "button",
        title: this.demo ? "示範資料:沒有實際檔案" : a.resourceRef,
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
    const state = s?.error ? `失敗:${s.error}` : !s ? "" : !s.commandId ? "送出中…"
      : cmd?.status === "applied" ? "已套用 · Leader 已讀到"
      : cmd?.status === "applying" ? "已記錄 · Leader 下一輪會讀到"
      : cmd?.status === "failed" ? `失敗:${cmd.errorMessage ?? ""}` : "已接受";
    const leader = this.store.member(teamId, team.leaderMemberId);
    const area = h("textarea", {
      class: "office-input", rows: "2", maxlength: String(MAX_INSTRUCTION), "data-key": `office-instruct-${teamId}`,
      placeholder: !caps.canSendInstruction ? caps.unavailableReasons.instruction ?? ""
        : this.store.run(team.currentRunId)?.status === "completed" ? `團隊已完成 · 有新需求或修改意見就寫給 Leader${leader ? `(${leader.displayName})` : ""},團隊會繼續工作`
        : `補充指示給 Leader${leader ? `(${leader.displayName})` : ""}…`,
      disabled: !caps.canSendInstruction,
      "aria-label": "補充指示給 Leader",
    }) as HTMLTextAreaElement;
    area.value = this.drafts.get(teamId) ?? "";
    area.addEventListener("input", () => this.drafts.set(teamId, area.value));
    const send = () => void this.instruct(teamId, area.value);
    area.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    return h("div", { class: "office-composer" },
      h("div", { class: "row" }, area, h("button", { class: "btn primary", type: "button", disabled: !caps.canSendInstruction, onClick: send }, s?.error || cmd?.status === "failed" ? "重試" : "送出")),
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
      this.notice = kind === "pause" ? "已送出暫停:不再派新的回合,正在做的會做完。" : "已送出繼續。";
    } catch (err) {
      this.notice = `沒有成功:${String(err instanceof Error ? err.message : err)}`;
    }
    this.host.render();
  }

  /** Development only: a team's battle layer, to hold one move still and look at it. */
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
    wake();
  }
}
