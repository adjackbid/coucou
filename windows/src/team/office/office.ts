// The Office: the company map, a team's office and the member drawer — a
// picture of the same record the board shows (feature/OFFICE-整合規劃.md).
//
// The page (main.ts) draws itself again on every change; the scenes here are
// kept and moved into each new page, so the Mochis keep moving. Selection is
// by (teamId, memberId) and is dropped when the team changes, so one team's
// work never shows in another's drawer.

import "./office.css";
import { h } from "../../views/dom";
import type { Artifact, CommandRecord, MemberSnapshot, Message, TeamRun, Capabilities } from "./contracts";
import { OfficeStore } from "./store";
import { RealAdapter } from "./adapter-real";
import { MockAdapter } from "./adapter-mock";
import { loadArt, MAX_DESKS, STATUS, TeamScene, wake } from "./scene";
import type { Snapshot, TeamFile } from "../types";

export interface OfficeHost {
  render(): void;
  /** Leave the Office for the board of the same team. */
  showBoard(teamId: string): void;
  /** Go to a team's office (selecting the team in the sidebar). */
  openTeam(teamId: string): void;
  /** Open a deliverable the way the board does. */
  openArtifact(teamId: string, ref: string): void;
  /** A deliverable that is a picture, as bytes; rejects when it is not one or cannot be read. */
  preview?(teamId: string, ref: string): Promise<ArrayBuffer>;
  pause(teamId: string): Promise<unknown>;
  resume(teamId: string): Promise<unknown>;
  /** Resolves to the message's id; the same request id is sent once. */
  instruct(teamId: string, text: string, request: string): Promise<string>;
}

const MAX_INSTRUCTION = 2000;
const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getTime() === 0 ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export class Office {
  readonly store: OfficeStore;
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
  /** The company map's view: 60–160 %, and how far it was dragged. */
  view = { zoom: 1, x: 0, y: 0 };
  tab: "work" | "talk" = "work";
  bubbles = true;
  calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  /** What is being typed to each team's leader, kept through failures. */
  private drafts = new Map<string, string>();
  private sending = new Map<string, { clientRequestId: string; commandId?: string; error?: string }>();
  private files: TeamFile[] = [];
  /** Pictures of deliverables: an object URL, null when there is none to show, or pending. */
  private previews = new Map<string, string | null | "pending">();
  private runs = new Map<string, Snapshot>();

  constructor(private host: OfficeHost, opts: { demo?: boolean } = {}) {
    this.demo = !!opts.demo;
    this.store = new OfficeStore(() => this.resync());
    if (this.demo) {
      this.mock = new MockAdapter();
      this.store.loadSnapshot(this.mock.snapshot());
      this.mock.subscribe((e) => this.store.receive(e));
      this.store.setConnection({ status: "live", lastAppliedSeq: this.store.cursor, lastServerTime: this.store.serverTime });
    } else {
      this.real = new RealAdapter({ pause: (t) => host.pause(t), resume: (t) => host.resume(t), instruct: (t, text, request) => host.instruct(t, text, request) });
    }
    this.store.onChange(() => {
      for (const s of this.scenes.values()) s.update();
      for (const s of this.minis.values()) s.update();
      // A member that went away closes its drawer.
      if (this.sel && !this.store.member(this.sel.teamId, this.sel.memberId)) {
        this.sel = null;
        this.notice = "這位成員已移出團隊。";
      }
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
    if (this.store.cursor < 0) {
      this.store.loadSnapshot(this.real.snapshot(files, runs));
      this.store.setConnection({ status: "live", lastAppliedSeq: this.store.cursor, lastServerTime: this.store.serverTime });
      return;
    }
    const e = this.real.diff(files, runs);
    if (e) this.store.receive(e);
  }

  private resync() {
    // The stream skipped or changed scope: start again from a whole picture.
    if (this.real) queueMicrotask(() => this.store.loadSnapshot(this.real!.snapshot(this.files, this.runs)));
    else if (this.mock) queueMicrotask(() => this.store.loadSnapshot(this.mock!.snapshot()));
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
    let s = map.get(teamId);
    if (!s) {
      s = new TeamScene(teamId, this.store, {
        mini,
        onSelect: (memberId) => {
          this.select(teamId, memberId);
        },
        preview: (a) => this.preview(a),
        onArtifact: (a) => this.openArtifact(teamId, a),
        onBlank: () => {
          if (this.sel?.teamId === teamId) this.close(teamId, false);
        },
      });
      map.set(teamId, s);
    }
    s.selected = !mini && this.sel?.teamId === teamId ? this.sel.memberId : null;
    s.bubblesOn = this.bubbles;
    s.reduceMotion = this.calm || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    s.update();
    return s;
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

  private connection() {
    const c = this.store.connection;
    if (this.store.syncing) return h("div", { class: "office-stale", role: "status", text: "資料同步中…" });
    if (c.status === "stale" || c.status === "reconnecting") return h("div", { class: "office-stale", role: "status", text: `資料已過期 · 最後更新 ${clock(c.lastServerTime ?? "")}` });
    return null;
  }

  // ── The company ──────────────────────────────────────────────────────────────

  company(): HTMLElement {
    const teams = this.store.teams();
    const count = this.store.headcount();
    if (!teams.length) return h("div", { class: "office-empty" }, h("p", { text: "還沒有團隊。按左下角的「新增團隊」開始。" }));
    const pick = teams.find((t) => t.teamId === this.companyPick) ?? teams[0];
    // Rooms laid out as a floor: as many columns as rows.
    const cols = Math.max(1, Math.ceil(Math.sqrt(teams.length)));
    const grid = h("div", { class: "office-map", role: "list", style: `${this.mapTransform()}--cols:${cols};` });
    for (const t of teams) {
      const run = this.store.run(t.currentRunId);
      const alerts = this.alerts(t.teamId).length;
      const p = this.store.progress(t.teamId);
      const room = h(
        "div",
        { class: `office-room-tile${t.teamId === pick.teamId ? " on" : ""}`, role: "listitem" },
        h(
          "button",
          {
            class: "office-room-pick", type: "button",
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
        ),
        h(
          "div",
          { class: "office-room-plate" },
          h("b", { title: t.name, text: t.name }),
          this.runLabel(run),
          h("span", { class: "dim", text: p.percent === null ? "尚未派工" : `${p.percent}%` }),
          alerts ? h("span", { class: "office-count", title: `${alerts} 項需要你`, text: String(alerts) }) : null,
        ),
      );
      grid.append(room);
    }
    const pickRun = this.store.run(pick.currentRunId);
    const leader = this.store.member(pick.teamId, pick.leaderMemberId);
    const attention = teams.flatMap((t) => this.alerts(t.teamId).map((m) => ({ t, m })));
    const side = h(
      "aside",
      { class: "office-side" },
      h("div", { class: "office-card" },
        h("div", { class: "row" }, h("h2", { title: pick.name, text: pick.name }), this.demoTag()),
        h("p", { class: "dim", text: pick.goal.split("\n")[0] }),
        this.runLabel(pickRun),
        this.progressBar(pick.teamId),
        leader ? h("p", { class: "dim", text: `Leader · ${leader.displayName ?? leader.memberId}(${STATUS[leader.workStatus].label})` }) : h("p", { class: "dim", text: "還沒有指定 Leader,請到團隊設定。" }),
        h("button", { class: "btn primary", type: "button", onClick: () => this.host.openTeam(pick.teamId) }, "進入辦公室 →"),
      ),
      h("div", { class: "office-card" },
        h("h3", { text: "團隊成員" }),
        ...this.store.members(pick.teamId).map((m) =>
          h("button", { class: "office-member-row", type: "button", onClick: () => { this.sel = { teamId: pick.teamId, memberId: m.memberId }; this.host.openTeam(pick.teamId); } },
            h("i", { class: "office-blob", style: `background:${m.color}` }),
            h("span", { class: "grow" }, h("b", { text: m.displayName ?? m.memberId }), h("small", { class: "dim", text: ` ${m.roleLabel}` })),
            this.status(m.workStatus)),
        ),
      ),
      attention.length
        ? h("div", { class: "office-card alert" }, h("h3", { text: "需要你的注意" }),
            ...attention.map(({ t, m }) =>
              h("button", { class: "office-member-row", type: "button", onClick: () => { this.sel = { teamId: t.teamId, memberId: m.memberId }; this.host.openTeam(t.teamId); } },
                h("i", { class: "office-blob", style: `background:${m.color}` }),
                h("span", { class: "grow" }, h("b", { text: `${t.name} · ${m.displayName}` }), h("small", { class: "dim", text: ` ${m.waitingFor?.reason ?? STATUS[m.workStatus].label}` })),
                h("span", { class: "office-pill alert", text: "查看" }))))
        : null,
    );
    return h(
      "div",
      { class: "office office-company" },
      h("div", { class: "office-head" },
        h("div", {}, h("h1", { text: "我的公司" }), h("p", { class: "dim", text: `${teams.length} 間辦公室 · ${count.agents} 位 Agents(${count.seats} 個席位)` })),
        this.demoTag(),
        this.demo ? h("button", { class: "btn plain", type: "button", title: "播放規格附帶的下一個事件", onClick: () => { if (!this.step()) { this.notice = "示範事件已全部播放。"; this.host.render(); } } }, "下一個示範事件") : null),
      this.connection(),
      h("div", { class: "office-body" }, this.mapViewport(grid), side),
    );
  }

  // ── The company map: drag to move, zoom 60–160 %, back to the whole floor ──

  private dragged = false;

  private mapTransform() {
    const v = this.view;
    return `transform:translate(${v.x}px, ${v.y}px) scale(${v.zoom});`;
  }

  private zoomTo(z: number) {
    this.view.zoom = Math.min(1.6, Math.max(0.6, Math.round(z * 10) / 10));
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
      this.view.x = start.vx + dx;
      this.view.y = start.vy + dy;
      grid.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
    });
    const end = () => {
      start = null;
      // A drag is not a click on the room it ended over.
      window.setTimeout(() => (this.dragged = false), 0);
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    vp.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomTo(this.view.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    const controls = h(
      "div",
      { class: "office-map-controls", role: "group", "aria-label": "地圖縮放" },
      h("button", { class: "icon-btn", type: "button", title: "縮小", "aria-label": "縮小", disabled: this.view.zoom <= 0.6, onClick: () => this.zoomTo(this.view.zoom - 0.1) }, "−"),
      h("span", { class: "dim", "aria-live": "polite", text: `${Math.round(this.view.zoom * 100)}%` }),
      h("button", { class: "icon-btn", type: "button", title: "放大", "aria-label": "放大", disabled: this.view.zoom >= 1.6, onClick: () => this.zoomTo(this.view.zoom + 0.1) }, "+"),
      h("button", { class: "btn plain", type: "button", title: "回到全景", onClick: () => { this.view = { zoom: 1, x: 0, y: 0 }; this.host.render(); } }, "全景"),
    );
    return h("div", { class: "office-map-wrap" }, vp, controls, h("p", { class: "dim office-hint", text: "點房間看摘要,雙擊或按「進入辦公室」進去 · 拖曳移動,Ctrl + 滾輪縮放" }));
  }

  // ── A team's office ──────────────────────────────────────────────────────────

  team(teamId: string): HTMLElement {
    const team = this.store.team(teamId);
    if (!team) return h("div", { class: "office-empty", text: "這個團隊還沒有資料。" });
    // A drawer from another team is not this team's business.
    if (this.sel && this.sel.teamId !== teamId) this.sel = null;
    const run = this.store.run(team.currentRunId);
    const members = this.store.members(teamId);
    const scene = this.scene(teamId);
    const caps = this.capabilities(run);
    const toggles = h(
      "div",
      { class: "office-toggles" },
      h("label", {}, h("input", { type: "checkbox", checked: this.bubbles, onChange: (e: Event) => { this.bubbles = (e.target as HTMLInputElement).checked; this.host.render(); } }), "溝通泡泡"),
      h("label", { title: "只調整畫面動畫,不影響團隊工作" }, h("input", { type: "checkbox", checked: this.calm, onChange: (e: Event) => { this.calm = (e.target as HTMLInputElement).checked; this.host.render(); } }), "減少動態"),
    );
    const pauseBtn = caps.canPause
      ? h("button", { class: "btn plain", type: "button", title: "暫停團隊:不再派新回合,正在做的會做完", onClick: () => void this.command(teamId, "pause") }, "暫停團隊")
      : caps.canResume
        ? h("button", { class: "btn primary", type: "button", onClick: () => void this.command(teamId, "resume") }, "繼續")
        : h("button", { class: "btn plain", type: "button", disabled: true, title: caps.unavailableReasons.pause ?? "" }, run?.status === "pausing" ? "暫停中…" : "暫停團隊");
    const extra = members.length > MAX_DESKS ? h("p", { class: "dim", text: `另外 ${members.length - MAX_DESKS} 位成員還沒有工位(房間最多 ${MAX_DESKS} 張桌子),在下方名單裡。` }) : null;
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
            h("b", {}, m.memberId === team.leaderMemberId ? "♛ " : "", m.displayName ?? m.memberId),
            h("small", { class: "dim", text: ` ${m.memberId === team.leaderMemberId ? "Leader · " : ""}${m.roleLabel}` }),
            h("span", { class: "office-roster-task", text: m.summary || (m.primaryTaskId ? this.store.task(m.primaryTaskId)?.title ?? "" : "") })),
          this.status(m.workStatus))),
    );
    const side = this.sel ? this.drawer(teamId) : this.activity(teamId);
    return h(
      "div",
      { class: "office office-team" },
      h("div", { class: "office-head" },
        h("div", { class: "office-head-main" }, this.runLabel(run), this.progressBar(teamId), this.demoTag()),
        toggles,
        pauseBtn),
      this.connection(),
      this.notice ? h("div", { class: "office-notice", role: "status", text: this.notice }) : null,
      h("div", { class: "office-body" },
        h("div", { class: "office-main" }, h("div", { class: "office-frame" }, scene.el), extra, roster),
        side),
    );
  }

  /** What happened in the office, newest first: hand-offs, questions, deliveries. */
  private activity(teamId: string): HTMLElement {
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
    return h(
      "aside",
      { class: "office-side" },
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
      h("p", { class: "dim office-hint", text: "點選 Agent 查看工作與對話" }),
    );
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
          h("div", { class: "row" }, leader ? h("span", { class: "office-pill quiet", text: "♛ Leader" }) : null, this.status(m.workStatus), this.demoTag()),
          h("small", { class: "dim", text: `最後更新 ${clock(m.lastActivityAt) || "—"}` })),
        h("button", { class: "icon-btn", type: "button", title: "關閉(Esc)", "aria-label": "關閉", onClick: () => this.close(teamId) }, "✕")),
      this.back
        ? h("button", { class: "link", type: "button", onClick: () => { const b = this.back!; this.back = null; this.select(b.teamId, b.memberId); } }, `← 回到 ${name(this.back.memberId)}`)
        : null,
      h("section", { class: "office-card" },
        h("h3", { text: "目前工作" }),
        task ? h("p", {}, h("b", { text: task.title }), others ? h("small", { class: "dim", text: ` 另外 ${others} 項` }) : null) : h("p", { class: "dim", text: m.workStatus === "idle" ? "待命,沒有指派的任務。" : "沒有進行中的任務。" }),
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
      this.composer(teamId),
    );
    return el;
  }

  private thread(teamId: string, talk: Message[]) {
    const name = (id: string) => this.store.member(teamId, id)?.displayName ?? id;
    if (!talk.length) return h("p", { class: "dim", text: "還沒有和這位成員有關的對話。" });
    return h("ol", { class: "office-thread" }, ...talk.slice(-40).map((x) => {
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
      placeholder: caps.canSendInstruction ? `補充指示給 Leader${leader ? `(${leader.displayName})` : ""}…` : caps.unavailableReasons.instruction ?? "",
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

  /** After the page is drawn: Mochis moving again. */
  afterRender() {
    wake();
  }
}
