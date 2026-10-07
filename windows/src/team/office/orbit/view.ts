// The 星域 scene: one universe in a box. Rings are camera-facing sprites at
// real 3D positions; names and team titles are HTML laid over the projection
// so text never bends; the camera turns within the spec's limits and zooms
// 65–220 %. The sky drifts on its own clock, which 暫停漂浮 stops and 減少動態
// (the Office's own setting) stops along with every other continuous motion;
// a transfer runs on its event's own time.
//
// The view keeps nothing of the work: it is handed a scene and events
// (adapter.ts) and only draws them. dispose() returns every frame request,
// observer, listener and GPU resource; the Office keeps one view at a time.

import { h } from "../../../views/dom";
import { STATUS_LABEL, type AgentStatus, type OrbitAgent, type OrbitEvent, type OrbitMessageEvent, type OrbitPreset, type OrbitRelation, type OrbitScene, type OrbitTeam } from "./contracts";
import { ClusterLayout, clamp, curve, memberPosition, orbitPoint, type Vec3 } from "./layout";
import { backgroundPoint, colour, glow, makeStars, NEBULAE, paintEnergyRing, ringAppearance } from "./paint";
import { GlEngine, type GlNode, type GlPacket } from "./webgl";

export interface OrbitViewHost {
  /** A ring was clicked; null when the selection was let go. */
  onSelect(agentId: string | null): void;
  /** A team's title was clicked. */
  onPickTeam(teamId: string): void;
  /** 減少動態, as the Office keeps it. */
  reduce(): boolean;
  /** The last pointer was lifted: a page redraw that waited for the drag may go now. */
  onDragEnd?(): void;
}

interface Projected {
  x: number;
  y: number;
  scale: number;
  depth: number;
}

interface Node {
  agent: OrbitAgent;
  slot: number;
  index: number;
  size: number;
  position: Vec3;
  projected: Projected;
  button: HTMLButtonElement;
  dot: HTMLElement;
  name: HTMLElement;
  role: HTMLElement;
  /** 減少動態: a transfer just arrived here, shown still. */
  litUntil: number;
}

interface Cluster {
  team: OrbitTeam;
  size: number;
  slot: number;
  /** Where it is drawn now, and where it is going (a new neighbour may move it slowly). */
  centre: Vec3;
  target: Vec3;
  label: HTMLElement;
  title: HTMLElement;
  count: HTMLElement;
}

interface Packet {
  key: string;
  messageId: string;
  from: string;
  to: string;
  color: string;
  start: number;
  /** Messages merged into this light when they came too close together. */
  count: number;
  summary: string;
  received: boolean;
  /** 減少動態: only a brighter line and a lit receiver, until this time. */
  still: boolean;
}

const TRAVEL_MS = 1700;
const ARRIVAL_END = 1.17;
const MERGE_MS = 600;
const STILL_MS = 2400;
const FRAME_MS = 32;
const MAX_DPR = 1.7;
const VIEW_KEY = "coucou.orbit.view";
const YAW = [-1.35, 1.35] as const;
const PITCH = [0.08, 1.35] as const;
const ZOOM = [0.65, 2.2] as const;
/** Room kept clear above (titles) and below (controls) the scene. */
const PAD_TOP = 48;
const PAD_BOTTOM = 112;
const DOT_GLYPH: Record<AgentStatus, string> = { busy: "", waiting: "", done: "✓", idle: "", error: "!", offline: "–", unknown: "?" };

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function savedView(): Partial<{ yaw: number; pitch: number; zoom: number; paused: boolean; view: OrbitPreset }> {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OrbitView {
  readonly el: HTMLElement;
  /** The last transfer, in words: the Office places this line under the scene. */
  readonly eventLine: HTMLElement;
  private fallback: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private glHost: HTMLElement;
  private labels: HTMLElement;
  private agents: HTMLElement;
  private motionState: HTMLElement;
  private legend: HTMLElement;
  private zoomValue: HTMLElement;
  private controls: HTMLElement;
  /** Where the camera controls begin, from the top of the scene: rings and titles stay above it. */
  private controlsTop = 0;
  private presets = new Map<OrbitPreset, HTMLButtonElement>();

  private scene: OrbitScene = { schemaVersion: "1.0.0", mode: "live", teams: [], agents: [], relations: [] };
  private nodes = new Map<string, Node>();
  private clusters = new Map<string, Cluster>();
  /** Lines a real message needed where no standing one was: kept until its light has arrived. */
  private extra = new Map<string, { rel: OrbitRelation; until: number }>();
  private packets: Packet[] = [];
  private layout = new ClusterLayout();
  private stars = makeStars();

  state = { yaw: 0.14, pitch: 0.55, zoom: 1, paused: false, view: "oblique" as OrbitPreset };
  selected: string | null = null;

  private w = 1;
  private h = 1;
  private dpr = 1;
  private vertical = false;
  private focal = 1;
  private distance = 20;
  private phase = 0;
  private last = 0;
  private raf = 0;
  private visible = true;
  private dirty = true;
  private engine: GlEngine | null = null;
  private disposed = false;
  private timers = new Set<number>();
  private saveTimer = 0;
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  private media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  private onVisibility = () => (document.hidden ? this.stop() : this.wake());
  private onMedia = () => this.wake();
  private onWindowPointerUp = (e: PointerEvent) => this.endPointer(e);

  constructor(private host: OrbitViewHost, opts: { demo?: boolean } = {}) {
    const saved = savedView();
    for (const k of ["yaw", "pitch", "zoom"] as const) if (Number.isFinite(saved[k])) this.state[k] = saved[k]!;
    if (typeof saved.paused === "boolean") this.state.paused = saved.paused;
    this.state.view = saved.view === "top" || saved.view === "side" || saved.view === "custom" ? saved.view : "oblique";
    this.state.yaw = clamp(this.state.yaw, YAW[0], YAW[1]);
    this.state.pitch = clamp(this.state.pitch, PITCH[0], PITCH[1]);
    this.state.zoom = clamp(this.state.zoom, ZOOM[0], ZOOM[1]);

    this.fallback = h("canvas", { class: "orbit-fallback", role: "img", "aria-label": "Agent 以彩色光環和光芯呈現,在星塵和柔光緩慢流動的宇宙中漂浮;同團隊以常駐光線連結,傳送資料時沿連線出現更亮的光流。" });
    this.ctx = this.fallback.getContext("2d")!;
    this.glHost = h("div", { class: "orbit-webgl", "aria-hidden": "true" });
    this.labels = h("div", { class: "orbit-labels" });
    this.agents = h("div", { class: "orbit-agents" });
    this.motionState = h("span", { class: "orbit-motion-state", role: "status" });
    this.legend = h("div", { class: "orbit-legend" });
    this.zoomValue = h("span", { class: "orbit-zoom-value", "aria-live": "polite" });
    this.eventLine = h("span", { class: "orbit-event", "aria-live": "polite", text: "協作連線常亮 · 資料傳送時光流加亮" });
    const preset = (view: OrbitPreset, label: string) => {
      const b = h("button", { type: "button", "aria-pressed": "false", onClick: () => this.setPreset(view) }, label) as HTMLButtonElement;
      this.presets.set(view, b);
      return b;
    };
    const controls = h(
      "div",
      { class: "orbit-controls" },
      h("div", { class: "orbit-presets", role: "group", "aria-label": "視角" },
        h("button", { type: "button", "aria-label": "向左轉動視角", title: "向左轉動視角", onClick: () => this.turn(-0.2) }, "↶"),
        preset("oblique", "斜視"), preset("top", "俯視"), preset("side", "側視"),
        h("button", { type: "button", "aria-label": "向右轉動視角", title: "向右轉動視角", onClick: () => this.turn(0.2) }, "↷")),
      h("div", { class: "orbit-zoom", role: "group", "aria-label": "縮放" },
        h("button", { type: "button", "aria-label": "縮小", title: "縮小", onClick: () => { this.zoomBy(1 / 1.2); this.persist(); } }, "−"),
        this.zoomValue,
        h("button", { type: "button", "aria-label": "放大", title: "放大", onClick: () => { this.zoomBy(1.2); this.persist(); } }, "＋"),
        h("button", { class: "orbit-overview", type: "button", title: "相機回到預設角度與 100%;不改變選擇", onClick: () => this.resetView() }, "全景")),
    );
    this.controls = controls;
    this.el = h(
      "div",
      { class: "orbit-world", role: "group", "aria-label": "可旋轉、縮放的 Agent 協作星域", tabindex: "0", "data-renderer": "none" },
      this.fallback,
      this.glHost,
      this.labels,
      this.agents,
      h("div", { class: "orbit-scene-top" }, h("span", { text: opts.demo ? "協作軌道 · 示意資料" : "協作軌道" }), this.motionState),
      controls,
      h("div", { class: "orbit-scene-bottom" }, this.legend, h("span", { class: "orbit-gesture", text: "拖曳旋轉 · 滾輪縮放 · 點光環看協作關係" })),
    );
    this.pointer();
    this.el.addEventListener("keydown", (e) => this.key(e));
    this.ro = new ResizeObserver(() => this.layoutSize());
    this.ro.observe(this.el);
    this.io = new IntersectionObserver(
      (entries) => {
        this.visible = entries[0]?.isIntersecting ?? true;
        if (this.visible) {
          this.last = 0;
          this.wake();
        } else this.stop();
      },
      { threshold: 0.02 },
    );
    this.io.observe(this.el);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.media?.addEventListener("change", this.onMedia);
    window.addEventListener("pointerup", this.onWindowPointerUp);
    window.addEventListener("pointercancel", this.onWindowPointerUp);
    this.sync();
    this.startGl();
  }

  // ── Renderer ─────────────────────────────────────────────────────────────────

  /** Native WebGL when it is there; the Canvas fallback draws the same scene otherwise. */
  private startGl() {
    const forced = import.meta.env.DEV && new URLSearchParams(location.search).get("gl") === "off";
    if (forced) {
      this.el.dataset.renderer = "canvas";
      return;
    }
    try {
      const surface = h("canvas");
      this.glHost.append(surface);
      this.engine = new GlEngine(surface, this.stars, () => {
        // Context lost: the Canvas draws everything from the next frame on.
        this.engine = null;
        surface.remove();
        this.el.dataset.renderer = "canvas";
        this.wake();
      });
      this.el.dataset.renderer = "webgl";
    } catch {
      this.glHost.replaceChildren();
      this.engine = null;
      this.el.dataset.renderer = "canvas";
    }
  }

  get renderer(): "webgl" | "canvas" {
    return this.engine ? "webgl" : "canvas";
  }

  // ── The scene ─────────────────────────────────────────────────────────────────

  /** The company as it stands now; what was already there keeps its place and colour. */
  setScene(scene: OrbitScene) {
    this.scene = scene;
    const sizes = new Map<string, number>();
    for (const a of scene.agents) sizes.set(a.teamId, (sizes.get(a.teamId) ?? 0) + 1);
    this.layout.update(scene.teams.map((t) => ({ id: t.id, size: sizes.get(t.id) ?? 0 })));
    const teamIds = new Set(scene.teams.map((t) => t.id));
    for (const [id, c] of this.clusters) {
      if (teamIds.has(id)) continue;
      c.label.remove();
      this.clusters.delete(id);
    }
    for (const t of scene.teams) {
      const size = sizes.get(t.id) ?? 0;
      const slot = this.layout.slot(t.id);
      let c = this.clusters.get(t.id);
      if (!c) {
        const title = h("span", { class: "orbit-team-name" });
        const count = h("small");
        const label = h("button", { class: "orbit-team-title", type: "button", title: "看這個團隊的摘要", onClick: () => this.host.onPickTeam(t.id) }, h("b", { "aria-hidden": "true" }), title, count);
        this.labels.append(label);
        const target = this.layout.centre(t.id, { vertical: this.vertical });
        c = { team: t, size, slot, centre: [...target] as Vec3, target, label, title, count };
        this.clusters.set(t.id, c);
      }
      c.team = t;
      c.size = size;
      c.slot = slot;
      c.target = this.layout.centre(t.id, { vertical: this.vertical });
      c.title.textContent = t.name;
      c.count.textContent = `${size} 位 Agents`;
      (c.label.firstElementChild as HTMLElement).style.background = t.color;
    }
    const ids = new Set(scene.agents.map((a) => a.id));
    for (const [id, n] of this.nodes) {
      if (ids.has(id)) continue;
      n.button.remove();
      this.nodes.delete(id);
    }
    const index = new Map<string, number>();
    for (const a of scene.agents) {
      const i = index.get(a.teamId) ?? 0;
      index.set(a.teamId, i + 1);
      const c = this.clusters.get(a.teamId);
      let n = this.nodes.get(a.id);
      if (!n) {
        const dot = h("b", { class: "orbit-state-dot", "aria-hidden": "true" });
        const name = h("span", { class: "orbit-agent-name" });
        const role = h("small", { class: "orbit-agent-role" });
        const button = h("button", { class: "orbit-agent", type: "button", "aria-pressed": "false", "data-id": a.id }, dot, h("span", { class: "orbit-agent-text" }, name, role)) as HTMLButtonElement;
        button.addEventListener("click", (e) => {
          if (this.wasDragging) {
            e.preventDefault();
            return;
          }
          this.host.onSelect(this.selected === a.id ? null : a.id);
        });
        this.agents.append(button);
        n = { agent: a, slot: c?.slot ?? 0, index: i, size: c?.size ?? 1, position: [0, 0, 0], projected: { x: 0, y: 0, scale: 1, depth: 1 }, button, dot, name, role, litUntil: 0 };
        this.nodes.set(a.id, n);
      }
      n.agent = a;
      n.slot = c?.slot ?? 0;
      n.index = i;
      n.size = c?.size ?? 1;
      n.name.textContent = a.name;
      n.role.textContent = a.role;
      n.dot.textContent = DOT_GLYPH[a.status];
      n.button.dataset.status = a.status;
      n.button.setAttribute("aria-label", `${c?.team.name ?? ""} ${a.name},${a.role},${STATUS_LABEL[a.status]}`);
      n.button.setAttribute("aria-pressed", String(this.selected === a.id));
    }
    if (this.selected && !this.nodes.has(this.selected)) this.selected = null;
    this.packets = this.packets.filter((p) => this.nodes.has(p.from) && this.nodes.has(p.to));
    for (const [k, x] of this.extra) if (!this.nodes.has(x.rel.fromAgentId) || !this.nodes.has(x.rel.toAgentId)) this.extra.delete(k);
    this.renderLegend();
    this.dirty = true;
    this.wake();
  }

  /** The statuses on screen, explained. */
  private renderLegend() {
    const present = new Set(this.scene.agents.map((a) => a.status));
    const order: AgentStatus[] = ["busy", "waiting", "done", "idle", "error", "offline", "unknown"];
    this.legend.replaceChildren(...order.filter((s) => present.has(s) || s === "busy" || s === "waiting" || s === "done").map((s) => h("span", {}, h("b", { class: `orbit-dot-${s}` }), STATUS_LABEL[s])));
  }

  /** Who is directly tied to an agent, standing lines only. */
  directRelations(agentId: string): OrbitRelation[] {
    return this.scene.relations.filter((r) => r.fromAgentId === agentId || r.toAgentId === agentId);
  }

  /** The ring the Office wants outlined; the Office decides, the view shows. */
  select(agentId: string | null) {
    this.selected = agentId && this.nodes.has(agentId) ? agentId : null;
    for (const [id, n] of this.nodes) n.button.setAttribute("aria-pressed", String(id === this.selected));
    this.dirty = true;
    this.wake();
  }

  // ── Transfers ─────────────────────────────────────────────────────────────────

  /** Real events, in order. A light per message; two on the same path within 600 ms become one, counted. */
  push(events: readonly OrbitEvent[]) {
    const now = performance.now();
    for (const e of events) {
      if (e.type === "agent_status_changed") continue;
      if (!this.nodes.has(e.fromAgentId) || !this.nodes.has(e.toAgentId) || e.fromAgentId === e.toAgentId) continue;
      if (e.type === "message_sent") this.send(e, now);
      else this.receive(e, now);
    }
    this.wake();
  }

  private describe(e: OrbitMessageEvent, suffix = "") {
    const from = this.nodes.get(e.fromAgentId), to = this.nodes.get(e.toAgentId);
    if (!from || !to) return;
    const team = this.clusters.get(from.agent.teamId)?.team.name ?? "";
    const cross = from.agent.teamId !== to.agent.teamId ? ` → ${this.clusters.get(to.agent.teamId)?.team.name ?? ""}` : "";
    this.eventLine.textContent = `${team}${cross} · ${from.agent.name} → ${to.agent.name} · ${e.summary}${suffix}`;
  }

  private send(e: OrbitMessageEvent, now: number) {
    const key = `${e.fromAgentId}>${e.toAgentId}`;
    const still = this.host.reduce();
    const open = this.packets.find((p) => p.key === key && !p.received && now - p.start < MERGE_MS);
    if (open) {
      open.count += 1;
      open.summary = e.summary;
      this.describe(e, ` · 共 ${open.count} 則`);
      return;
    }
    const color = e.summary.startsWith("交付") ? "#86e7c4" : "#8ed8ff";
    this.packets.push({ key, messageId: e.messageId, from: e.fromAgentId, to: e.toAgentId, color, start: now, count: 1, summary: e.summary, received: false, still });
    // A path no standing line covers (across teams, say) gets one for the duration.
    const pk = pairKey(e.fromAgentId, e.toAgentId);
    if (!this.scene.relations.some((r) => pairKey(r.fromAgentId, r.toAgentId) === pk)) {
      this.extra.set(pk, { rel: { id: `live:${pk}`, fromAgentId: e.fromAgentId, toAgentId: e.toAgentId, kind: "communication", directed: true }, until: now + TRAVEL_MS * ARRIVAL_END + 1500 });
    }
    if (still) {
      const to = this.nodes.get(e.toAgentId)!;
      to.litUntil = now + STILL_MS;
      this.later(() => this.wake(), STILL_MS + 20);
      this.describe(e, " · 已送出(靜態顯示)");
    } else this.describe(e);
  }

  private receive(e: OrbitMessageEvent, now: number) {
    const p = this.packets.find((x) => x.messageId === e.messageId && x.to === e.toAgentId);
    if (p) {
      p.received = true;
      this.describe(e, " · 已收到");
      return;
    }
    // Read before this window saw it sent: only the arrival shows.
    const still = this.host.reduce();
    this.packets.push({ key: `${e.fromAgentId}>${e.toAgentId}`, messageId: e.messageId, from: e.fromAgentId, to: e.toAgentId, color: "#8ed8ff", start: now - TRAVEL_MS, count: 1, summary: e.summary, received: true, still });
    if (still) {
      this.nodes.get(e.toAgentId)!.litUntil = now + STILL_MS;
      this.later(() => this.wake(), STILL_MS + 20);
    }
    this.describe(e, " · 已收到");
  }

  /** The lights under way at this moment, and the ones that have ended dropped. */
  private livePackets(now: number): { p: Packet; t: number }[] {
    const out: { p: Packet; t: number }[] = [];
    this.packets = this.packets.filter((p) => {
      if (p.still) return now - p.start < STILL_MS;
      const t = (now - p.start) / TRAVEL_MS;
      if (t > ARRIVAL_END) return false;
      out.push({ p, t: Math.max(0, t) });
      return true;
    });
    for (const [k, x] of this.extra) if (x.until < now && !this.packets.some((p) => pairKey(p.from, p.to) === k)) this.extra.delete(k);
    return out;
  }

  /** Development and demo only: three lights along lines the scene really has. Never used with live data. */
  demo(): boolean {
    const rels = this.scene.relations.filter((r) => this.nodes.has(r.fromAgentId) && this.nodes.has(r.toAgentId));
    if (!rels.length) return false;
    const from = this.selected ? rels.filter((r) => r.fromAgentId === this.selected || r.toAgentId === this.selected) : rels;
    const pick = (from.length ? from : rels).slice(0, 3);
    pick.forEach((r, i) => {
      const fwd = this.selected && r.toAgentId === this.selected ? { from: r.toAgentId, to: r.fromAgentId } : { from: r.fromAgentId, to: r.toAgentId };
      this.later(() => this.push([{ id: `demo:${Date.now()}:${i}`, type: "message_sent", messageId: `demo:${Date.now()}:${i}`, fromAgentId: fwd.from, toAgentId: fwd.to, summary: "示範資料", occurredAt: new Date().toISOString() }]), i * 900);
    });
    return true;
  }

  private later(fn: () => void, ms: number) {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
  }

  // ── Camera ────────────────────────────────────────────────────────────────────

  get paused() {
    return this.state.paused;
  }

  togglePause() {
    this.state.paused = !this.state.paused;
    this.last = 0;
    this.sync();
    this.wake();
    this.persist();
  }

  private defaultPitch() {
    return this.vertical ? 0.25 : 0.55;
  }

  setPreset(view: OrbitPreset) {
    this.state.view = view;
    this.state.yaw = view === "side" ? 0.78 : 0.14;
    this.state.pitch = view === "top" ? 1.18 : view === "side" ? 0.14 : this.defaultPitch();
    this.sync();
    this.wake();
    this.persist();
  }

  turn(by: number) {
    this.state.yaw = clamp(this.state.yaw + by, YAW[0], YAW[1]);
    this.state.view = "custom";
    this.sync();
    this.wake();
    this.persist();
  }

  zoomBy(ratio: number) {
    this.state.zoom = clamp(this.state.zoom * ratio, ZOOM[0], ZOOM[1]);
    this.sync();
    this.wake();
  }

  /** The default angle and 100 %; the work and the selection stay as they are. */
  resetView() {
    this.state.yaw = 0.14;
    this.state.pitch = this.defaultPitch();
    this.state.zoom = 1;
    this.state.view = "oblique";
    this.sync();
    this.wake();
    this.persist();
  }

  private key(e: KeyboardEvent) {
    if (e.target !== this.el) return;
    const map: Record<string, () => void> = {
      ArrowLeft: () => this.turn(-0.15),
      ArrowRight: () => this.turn(0.15),
      ArrowUp: () => { this.state.pitch = clamp(this.state.pitch + 0.1, PITCH[0], PITCH[1]); this.state.view = "custom"; },
      ArrowDown: () => { this.state.pitch = clamp(this.state.pitch - 0.1, PITCH[0], PITCH[1]); this.state.view = "custom"; },
      "+": () => this.zoomBy(1.2),
      "=": () => this.zoomBy(1.2),
      "-": () => this.zoomBy(1 / 1.2),
      "0": () => this.resetView(),
    };
    const fn = map[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
    this.sync();
    this.wake();
    this.persist();
  }

  /** The controls show the camera as it is. */
  private sync() {
    const reduce = this.host.reduce();
    this.motionState.textContent = reduce ? "減少動態" : this.state.paused ? "漂浮已暫停" : "緩慢漂浮中";
    this.zoomValue.textContent = `${Math.round(this.state.zoom * 100)}%`;
    for (const [view, b] of this.presets) b.setAttribute("aria-pressed", String(view === this.state.view));
    this.el.dataset.zoom = this.state.zoom.toFixed(3);
    this.el.dataset.yaw = this.state.yaw.toFixed(4);
    this.el.dataset.pitch = this.state.pitch.toFixed(4);
    this.el.dataset.motion = reduce ? "reduced" : this.state.paused ? "paused" : "drifting";
  }

  /** The person's camera, kept on this machine; never written to the work. */
  private persist() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify({ yaw: this.state.yaw, pitch: this.state.pitch, zoom: this.state.zoom, paused: this.state.paused, view: this.state.view }));
      } catch {
        /* this window only */
      }
    }, 180);
  }

  // ── Pointer ───────────────────────────────────────────────────────────────────

  private pointers = new Map<number, [number, number]>();
  private previous: [number, number] | null = null;
  private startPoint: [number, number] | null = null;
  private pinch = 0;
  private wasDragging = false;

  private pointer() {
    const el = this.el;
    const blocked = (t: EventTarget | null) => !!(t instanceof Element && (t.closest(".orbit-controls") || t.closest(".orbit-team-title")));
    el.addEventListener("pointerdown", (e) => {
      if (blocked(e.target)) return;
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      this.previous = [e.clientX, e.clientY];
      this.startPoint = this.previous;
      this.wasDragging = false;
      const t = e.target as Element;
      if (t === el || t === this.fallback || t.closest(".orbit-labels")) el.setPointerCapture(e.pointerId);
      if (this.pointers.size === 2) {
        const a = [...this.pointers.values()];
        this.pinch = Math.hypot(a[1][0] - a[0][0], a[1][1] - a[0][1]);
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId) || !this.previous || !this.startPoint) return;
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.pointers.size === 2) {
        const a = [...this.pointers.values()], d = Math.hypot(a[1][0] - a[0][0], a[1][1] - a[0][1]);
        if (this.pinch > 0) this.zoomBy(d / this.pinch);
        this.pinch = d;
        this.wasDragging = true;
        return;
      }
      const dx = e.clientX - this.previous[0], dy = e.clientY - this.previous[1];
      // Five pixels tell a drag from a click on a ring.
      if (Math.hypot(e.clientX - this.startPoint[0], e.clientY - this.startPoint[1]) > 5) {
        this.wasDragging = true;
        el.classList.add("orbit-dragging");
        this.state.yaw = clamp(this.state.yaw - dx * 0.005, YAW[0], YAW[1]);
        this.state.pitch = clamp(this.state.pitch + dy * 0.004, PITCH[0], PITCH[1]);
        this.state.view = "custom";
        this.sync();
        this.wake();
      }
      this.previous = [e.clientX, e.clientY];
    });
    el.addEventListener("pointerup", (e) => this.endPointer(e));
    el.addEventListener("pointercancel", (e) => this.endPointer(e));
    el.addEventListener("lostpointercapture", (e) => this.endPointer(e));
    let wheelTimer = 0;
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomBy(Math.exp(-clamp(e.deltaY, -180, 180) * 0.0015));
        window.clearTimeout(wheelTimer);
        wheelTimer = window.setTimeout(() => this.persist(), 180);
      },
      { passive: false },
    );
    // A click on the sky lets the selection go.
    el.addEventListener("click", (e) => {
      if (this.wasDragging || blocked(e.target)) return;
      const t = e.target as Element;
      if (t.closest(".orbit-agent")) return;
      if (this.selected) this.host.onSelect(null);
    });
  }

  /** A pointer is held on the scene: the page must not be rebuilt under it (that would drop the capture). */
  get dragging(): boolean {
    return this.pointers.size > 0;
  }

  private endPointer(e: PointerEvent) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size) {
      this.previous = [...this.pointers.values()][0];
      this.startPoint = this.previous;
    } else {
      this.el.classList.remove("orbit-dragging");
      this.persist();
      // The click that ends a drag is not a click on what it ended over.
      window.setTimeout(() => (this.wasDragging = false), 80);
      this.host.onDragEnd?.();
    }
    this.pinch = 0;
  }

  // ── Frames ────────────────────────────────────────────────────────────────────

  /**
   * Measures the box and sizes both canvases to it. Setting a canvas's size
   * clears it, and a ResizeObserver fires after this frame's animation
   * callbacks — so the scene is drawn again right here, not a frame later,
   * or it would flash empty while the window is being resized.
   */
  private layoutSize(drawNow = true) {
    const rect = this.el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.w = rect.width;
    this.h = rect.height;
    this.controlsTop = this.controls.offsetTop || this.h - PAD_BOTTOM + 30;
    const wasVertical = this.vertical;
    this.vertical = this.w < 490;
    if (wasVertical !== this.vertical) {
      for (const c of this.clusters.values()) c.target = this.layout.centre(c.team.id, { vertical: this.vertical });
      if (this.state.view === "oblique") this.state.pitch = this.defaultPitch();
    }
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.fallback.width = Math.round(this.w * this.dpr);
    this.fallback.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.focal = this.h / (2 * Math.tan((42 * Math.PI) / 360));
    this.engine?.resize(this.w, this.h, this.dpr);
    this.dirty = true;
    if (drawNow && !this.disposed && this.visible && !document.hidden && this.el.isConnected) this.draw(performance.now());
    this.wake();
  }

  /** The scene's centre on screen: a little above the middle, clear of titles and controls. */
  private get yCentre() {
    return PAD_TOP + (this.h - PAD_TOP - PAD_BOTTOM) / 2;
  }

  /**
   * How far the camera stands so that every cluster fits at 100 %: the
   * reference's 18.5 for four teams, further for more or larger ones. Fitted
   * at the default tilt, so tilting the camera only tilts — a vertical drag
   * is pitch, never a dolly.
   */
  private fitDistance(): number {
    const centres = this.layout.centres({ vertical: this.vertical });
    let halfX = 7.8, halfY = 2.6, halfZ = 7.2;
    if (centres.length) {
      halfX = 0;
      halfY = 0;
      halfZ = 0;
      for (const c of centres) {
        halfX = Math.max(halfX, Math.abs(c.p[0]) + c.r + 0.4);
        halfY = Math.max(halfY, Math.abs(c.p[1]) + (this.vertical ? c.r * 0.9 : 1.1));
        halfZ = Math.max(halfZ, Math.abs(c.p[2]) + c.r * 0.8);
      }
    }
    const tilt = this.defaultPitch();
    const sp = Math.sin(tilt), cp = Math.cos(tilt);
    const halfV = halfY * cp + halfZ * sp + 0.6;
    const usableH = Math.max(120, this.h - PAD_TOP - PAD_BOTTOM);
    const byWidth = (halfX * this.focal) / (0.97 * (this.w / 2) - 24);
    const byHeight = (halfV * this.focal) / (0.94 * (usableH / 2));
    // The reference's 18.5 (22 stacked) is for four teams; one team alone may be looked at closer, many from further.
    const floor = (this.vertical ? 22 : 18.5) * clamp((this.vertical ? halfY : halfX) / (this.vertical ? 10.5 : 7.8), 0.65, 1e9);
    return Math.max(floor, byWidth, byHeight) / this.state.zoom;
  }

  private project(p: Vec3): Projected {
    const sy = Math.sin(this.state.yaw), cy = Math.cos(this.state.yaw), sp = Math.sin(this.state.pitch), cp = Math.cos(this.state.pitch);
    const x = p[0] * cy - p[2] * sy;
    const y = -p[0] * sp * sy + p[1] * cp - p[2] * sp * cy;
    const z = this.distance - p[0] * cp * sy - p[1] * sp - p[2] * cp * cy;
    return { x: this.w / 2 + (x * this.focal) / z, y: this.yCentre - (y * this.focal) / z, scale: this.focal / z, depth: z };
  }

  /** Clusters glide to where they belong; members circle and bob. Returns whether anything is still gliding. */
  private updatePositions(reduce: boolean): boolean {
    let gliding = false;
    for (const c of this.clusters.values()) {
      for (let i = 0; i < 3; i++) {
        const d = c.target[i] - c.centre[i];
        if (Math.abs(d) < 0.002) c.centre[i] = c.target[i];
        else {
          c.centre[i] += reduce ? d : d * 0.08;
          gliding = true;
        }
      }
    }
    // Paused or 減少動態, the clock stands still and so does every member — where it is, not at some rest position.
    for (const n of this.nodes.values()) {
      const c = this.clusters.get(n.agent.teamId);
      if (!c) continue;
      n.position = memberPosition(c.centre, n.index, c.size, c.slot, { phase: this.phase, drift: 1, vertical: this.vertical });
    }
    return gliding && !reduce;
  }

  /** Names under their rings, team titles clear of rings, names and each other. */
  private projectLabels() {
    const w = this.w;
    const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
    for (const n of this.nodes.values()) {
      const v = this.project(n.position);
      n.projected = v;
      const size = clamp(v.scale * 0.96, 25, 150);
      const b = n.button;
      b.style.left = `${v.x}px`;
      b.style.top = `${v.y}px`;
      b.style.setProperty("--orbit-size", `${size}px`);
      b.style.zIndex = String(Math.round(1000 - v.depth * 10));
      b.style.opacity = String(clamp(1 - (v.depth - this.distance) * 0.027, 0.5, 1));
      // Shown while whole ring and name stay above the camera controls.
      const on = v.depth > 1 && v.x > 25 && v.x < w - 25 && v.y > PAD_TOP && v.y + size / 2 + 20 < this.controlsTop;
      b.hidden = !on;
      if (on) occupied.push({ left: v.x - Math.max(34, size / 2), right: v.x + Math.max(34, size / 2), top: v.y - size / 2 - 4, bottom: v.y + size / 2 + 24 });
    }
    const hit = (a: (typeof occupied)[number], b: (typeof occupied)[number]) => a.left < b.right + 7 && a.right > b.left - 7 && a.top < b.bottom + 7 && a.bottom > b.top - 7;
    for (const c of this.clusters.values()) {
      const members = [...this.nodes.values()].filter((n) => n.agent.teamId === c.team.id && !n.button.hidden);
      const cv = this.project(c.centre);
      const label = c.label;
      const lw = Math.max(label.offsetWidth || 0, 148), lh = Math.max(label.offsetHeight || 0, 38);
      const visible = cv.depth > 1 && cv.x > -60 && cv.x < w + 60 && cv.y > 30 && cv.y < this.controlsTop;
      label.hidden = !visible;
      if (!visible) continue;
      const top = members.length ? Math.min(...members.map((n) => n.projected.y - clamp(n.projected.scale * 0.96, 25, 150) * 0.55)) - 42 : cv.y - 60;
      const bottom = members.length ? Math.max(...members.map((n) => n.projected.y + clamp(n.projected.scale * 0.96, 25, 150) / 2 + 24)) + lh / 2 + 14 : cv.y + 60;
      const maxY = this.controlsTop - lh / 2 - 8;
      const candidates: { x: number; y: number; cost: number }[] = [];
      for (const dy of [0, -18, -36, -54, 18, 36, 54, -80, 80]) for (const dx of [0, -60, 60, -110, 110]) candidates.push({ x: clamp(cv.x + dx, lw / 2 + 10, w - lw / 2 - 10), y: clamp(top + dy, 30 + lh / 2, maxY), cost: Math.abs(dx) + Math.abs(dy) * 1.5 });
      for (const dx of [0, -60, 60]) candidates.push({ x: clamp(cv.x + dx, lw / 2 + 10, w - lw / 2 - 10), y: clamp(bottom, 30 + lh / 2, maxY), cost: Math.abs(dx) + Math.abs(bottom - top) * 1.1 });
      candidates.sort((a, b) => a.cost - b.cost);
      let choice = candidates[0];
      for (const p of candidates) {
        const box = { left: p.x - lw / 2, right: p.x + lw / 2, top: p.y - lh / 2, bottom: p.y + lh / 2 };
        if (!occupied.some((o) => hit(box, o))) {
          choice = p;
          break;
        }
      }
      label.style.left = `${choice.x}px`;
      label.style.top = `${choice.y}px`;
      occupied.push({ left: choice.x - lw / 2, right: choice.x + lw / 2, top: choice.y - lh / 2, bottom: choice.y + lh / 2 });
    }
  }

  private relations(): OrbitRelation[] {
    return this.extra.size ? [...this.scene.relations, ...[...this.extra.values()].map((x) => x.rel)] : this.scene.relations;
  }

  /** A line of 3D points on the 2D canvas; broken where it goes behind the camera. */
  private line(points: Vec3[], color: string, alpha: number, width: number) {
    const ctx = this.ctx;
    ctx.strokeStyle = colour(color, alpha);
    ctx.lineWidth = width;
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      const v = this.project(p);
      if (v.depth < 0.5) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(v.x, v.y);
        started = true;
      } else ctx.lineTo(v.x, v.y);
    }
    ctx.stroke();
  }

  /** The sky: clouds, each cluster's haze, the stars, and the sparks that ride the orbits. */
  private drawBackdrop(glowK: number) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    NEBULAE.forEach((cloud, i) => {
      const p = backgroundPoint(cloud.p, this.phase);
      p[0] += Math.sin(this.phase * 0.018 + i * 2) * 1.2;
      p[1] += Math.sin(this.phase * 0.014 + i) * 0.8;
      const v = this.project(p);
      if (v.depth < 1) return;
      ctx.save();
      ctx.translate(v.x, v.y);
      ctx.rotate(cloud.angle + Math.sin(this.phase * 0.012 + i) * 0.08);
      ctx.scale(1.65, 0.72);
      glow(ctx, 0, 0, v.scale * cloud.radius, cloud.color, cloud.alpha * glowK);
      ctx.restore();
    });
    for (const c of this.clusters.values()) {
      const v = this.project(c.centre);
      if (v.depth > 1) glow(ctx, v.x, v.y, clamp(v.scale * 4.3, 100, 310), c.team.color, 0.085 * glowK);
    }
    ctx.fillStyle = "#b9d4ea";
    for (const s of this.stars) {
      const v = this.project(backgroundPoint(s.p, this.phase));
      if (v.depth > 1 && v.x > 0 && v.x < this.w && v.y > 0 && v.y < this.h) {
        ctx.globalAlpha = s.a;
        ctx.beginPath();
        ctx.arc(v.x, v.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    for (const c of this.clusters.values()) {
      for (let i = 0; i < 3; i++) {
        const v = this.project(orbitPoint(c.centre, c.size, this.phase * 0.09 + (i * Math.PI * 2) / 3 + c.slot, 0, this.vertical));
        if (v.depth > 1) {
          glow(ctx, v.x, v.y, 7, c.team.color, 0.22 * glowK);
          ctx.fillStyle = colour(c.team.color, 0.65);
          ctx.beginPath();
          ctx.arc(v.x, v.y, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /** The standing lines: core 1.15 px with a 3.8 px halo; the selection's own lines 1.7 / 5 px, other teams dimmed. */
  private drawConnections(now: number) {
    const ctx = this.ctx;
    const sel = this.selected ? this.nodes.get(this.selected) : undefined;
    let shown = 0;
    for (const r of this.relations()) {
      const a = this.nodes.get(r.fromAgentId), b = this.nodes.get(r.toAgentId);
      if (!a || !b) continue;
      const direct = !!sel && (r.fromAgentId === sel.agent.id || r.toAgentId === sel.agent.id);
      const sameTeam = !!sel && sel.agent.teamId === a.agent.teamId;
      const lit = this.packets.some((p) => p.still && pairKey(p.from, p.to) === pairKey(r.fromAgentId, r.toAgentId) && now - p.start < STILL_MS);
      const points = Array.from({ length: 33 }, (_, i) => curve(a.position, b.position, 0.09 + (i / 32) * 0.82));
      const shade = r.kind === "communication" ? "#8ed8ff" : this.clusters.get(a.agent.teamId)?.team.color ?? "#8ed8ff";
      const alpha = lit ? 0.95 : direct ? 0.84 : sel && !sameTeam ? 0.23 : r.kind === "team_connection" ? 0.48 : 0.29;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = colour(shade, direct || lit ? 0.8 : 0.55);
      ctx.shadowBlur = direct || lit ? 14 : 9;
      this.line(points, shade, alpha * 0.25, direct || lit ? 5 : 3.8);
      ctx.shadowBlur = 0;
      this.line(points, shade, alpha, direct || lit ? 1.7 : 1.15);
      this.line(points, direct || lit ? "#effaff" : "#d5eaf8", alpha * (direct || lit ? 0.6 : 0.22), 0.65);
      ctx.restore();
      shown++;
    }
    this.el.dataset.connections = String(shown);
  }

  private intensityFor(status: AgentStatus) {
    return status === "offline" ? 0.5 : status === "idle" || status === "unknown" ? 0.72 : 1;
  }

  /** Everything the Canvas draws when there is no WebGL: orbits, rings and lights too. */
  private drawFallback(live: { p: Packet; t: number }[], glowK: number) {
    const ctx = this.ctx;
    for (const c of this.clusters.values()) {
      for (const l of [0, 1] as const) {
        this.line(Array.from({ length: 97 }, (_, i) => orbitPoint(c.centre, c.size, (i / 96) * Math.PI * 2, l, this.vertical)), c.team.color, l ? 0.13 : 0.35, 1);
      }
    }
    const ordered = [...this.nodes.values()].sort((a, b) => b.projected.depth - a.projected.depth);
    for (const n of ordered) {
      const v = n.projected;
      if (v.depth < 1) continue;
      const look = ringAppearance(this.phase, n.slot, n.index, 0.8);
      glow(ctx, v.x, v.y, v.scale * 1.25, n.agent.color, 0.21 * glowK);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      paintEnergyRing(ctx, n.agent.color, v.x, v.y, (v.scale * look.size) / 128, look.rotation, look.intensity * this.intensityFor(n.agent.status), n.agent.status === "offline");
      ctx.restore();
      if (n.agent.id === this.selected) {
        ctx.strokeStyle = "#d5eeff";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(v.x, v.y, v.scale * 0.69, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (const { p, t } of live) {
      const a = this.nodes.get(p.from)!, b = this.nodes.get(p.to)!;
      const u = clamp(t, 0, 1);
      this.line(Array.from({ length: 25 }, (_, i) => curve(a.position, b.position, i / 24)), p.color, 0.45, 1.3);
      for (let k = 0; k < 8; k++) {
        const pos = this.project(curve(a.position, b.position, clamp(u - k * 0.016, 0, 1)));
        glow(ctx, pos.x, pos.y, 8 - k * 0.6, p.color, (1 - k / 9) * 0.55);
      }
      if (t > 1) {
        const end = this.project(b.position);
        ctx.strokeStyle = colour(p.color, clamp((ARRIVAL_END - t) * 4, 0, 1));
        ctx.beginPath();
        ctx.arc(end.x, end.y, 12 + (t - 1) * 170, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private draw(now: number): boolean {
    const reduce = this.host.reduce();
    const glowK = 0.8;
    this.distance = this.fitDistance();
    const gliding = this.updatePositions(reduce);
    this.projectLabels();
    const live = this.livePackets(now);
    for (const n of this.nodes.values()) n.button.classList.toggle("lit", n.litUntil > now);
    this.drawBackdrop(glowK);
    this.drawConnections(now);
    if (this.engine) {
      const sorted = [...this.nodes.values()].filter((n) => n.projected.depth > 0.5).sort((a, b) => b.projected.depth - a.projected.depth);
      const nodes: GlNode[] = sorted.map((n) => {
        const look = ringAppearance(this.phase, n.slot, n.index, glowK);
        return { position: n.position, color: n.agent.color, dashed: n.agent.status === "offline", size: look.size, rotation: look.rotation, intensity: look.intensity * this.intensityFor(n.agent.status) };
      });
      const orbits = [...this.clusters.values()].flatMap((c) => ([0, 1] as const).map((l) => ({ points: Array.from({ length: 97 }, (_, i) => orbitPoint(c.centre, c.size, (i / 96) * Math.PI * 2, l, this.vertical)), color: c.team.color, alpha: l ? 0.15 : 0.45 })));
      const packets: GlPacket[] = live.map(({ p, t }) => {
        const a = this.nodes.get(p.from)!, b = this.nodes.get(p.to)!;
        return {
          points: Array.from({ length: 28 }, (_, i) => curve(a.position, b.position, i / 27)),
          color: p.color,
          t,
          tail: t <= 1 ? Array.from({ length: 8 }, (_, k) => curve(a.position, b.position, clamp(t - k * 0.016, 0, 1))) : [],
          end: b.position,
        };
      });
      const sel = this.selected ? this.nodes.get(this.selected) : undefined;
      this.engine.draw({
        camera: { yaw: this.state.yaw, pitch: this.state.pitch, distance: this.distance, offset: (0.5 - this.yCentre / this.h) * 2 },
        phase: this.phase,
        glow: glowK,
        centres: [...this.clusters.values()].map((c) => ({ p: c.centre, color: c.team.color })),
        orbits,
        nodes,
        selected: sel?.position ?? null,
        packets,
      });
    } else this.drawFallback(live, glowK);
    this.el.dataset.phase = this.phase.toFixed(2);
    this.dirty = false;
    return gliding || live.length > 0 || this.packets.length > 0;
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.disposed || !this.visible || document.hidden || !this.el.isConnected) {
      this.last = 0;
      return;
    }
    if (now - this.last < FRAME_MS && !this.dirty) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    // The first frame may come before the ResizeObserver has measured the box.
    if (this.w <= 1) this.layoutSize(false);
    // Coming back after a while is not a jump: at most 80 ms pass per frame.
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.08) : 0;
    this.last = now;
    const reduce = this.host.reduce();
    if (!this.state.paused && !reduce) this.phase += dt;
    const busy = this.draw(now);
    if ((!this.state.paused && !reduce) || busy) this.raf = requestAnimationFrame(this.tick);
  };

  /** Draw again, and keep drawing while there is motion. Nothing happens off screen or in a hidden window. */
  wake() {
    this.dirty = true;
    this.sync();
    if (!this.raf && !this.disposed && this.visible && !document.hidden && this.el.isConnected) this.raf = requestAnimationFrame(this.tick);
  }

  /** No more frames until wake(); the lights in flight finish when it comes back, late ones are dropped. */
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  /** Everything given back: frames, observers, listeners, timers, the GPU. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    window.clearTimeout(this.saveTimer);
    this.ro.disconnect();
    this.io.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.media?.removeEventListener("change", this.onMedia);
    window.removeEventListener("pointerup", this.onWindowPointerUp);
    window.removeEventListener("pointercancel", this.onWindowPointerUp);
    this.engine?.dispose();
    this.engine = null;
    this.el.remove();
  }
}
