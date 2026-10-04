// One team's office: the Blender-rendered room (public/office/scene.json), a
// workstation per member, each member a Mochi on its chair, a label you can
// click or tab to, and the latest words said in the room as bubbles.
//
// A scene lives as long as the window and is moved into each new page, so a
// Mochi keeps its animation. What it shows is read from the store at every
// update: the pose follows workStatus, a bubble is a recorded message, a
// clock is a recorded wait. Nothing here decides what anyone is doing.

import { BotEngine, hexToRGB } from "../../mochi/engine";
import type { BotStateName } from "../../core/layout";
import { h } from "../../views/dom";
import type { Artifact, MemberSnapshot, Message, WorkStatus } from "./contracts";
import type { OfficeStore } from "./store";

// ── The room as rendered (windows/public/office/scene.json) ───────────────────

interface StationArt {
  layers: [string, string];
  canvas: [number, number];
  groundPivot: [number, number];
  actorBottom: [number, number];
  screenQuad: [number, number][];
}
export interface SceneArt {
  room: { file: string; artifactSlots: [number, number][][]; whiteboardQuad: [number, number][]; spots: Record<string, [number, number]> };
  workstations: Record<"SE" | "SW", StationArt>;
  props: {
    meetingTable: { file: string; canvas: [number, number]; groundPivot: [number, number]; at: [number, number] };
    /** The lounge: a sofa whose seats take members with nothing to do. */
    sofa?: { file: string; canvas: [number, number]; groundPivot: [number, number]; seats: [number, number][]; at: [number, number] };
  };
  worldToScreen: { x0: number; y0: number; perMetreX: number; perMetreY: number; perMetreZ: number };
}

let art: SceneArt | null = null;
let loading: Promise<SceneArt | null> | null = null;
/** The rendered room and its anchors; null until loaded, or if it could not be. */
export function loadArt(): Promise<SceneArt | null> {
  loading ??= fetch("/office/scene.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (art = j))
    .catch(() => null);
  return loading;
}

/** Logical room size: the art is drawn at 2×. */
export const ROOM_W = 1600;
export const ROOM_H = 1000;
/** The part of the canvas the room fills: the scene shows this, not the empty corners. */
export const CROP = { x: 190, y: 0, w: 1220, h: 990 };
const H = (v: number) => v / 2;

function toScreen(x: number, y: number, z = 0) {
  const w = art!.worldToScreen;
  return { x: H(w.x0 + (y - x) * w.perMetreX), y: H(w.y0 + (x + y) * w.perMetreY - z * w.perMetreZ) };
}

/**
 * Where members sit, in metres on the floor: rows of desks, all facing the
 * same way, like an office: desks side by side form a bench per row. Up
 * to four take two benches of two; five or six two benches of three; seven
 * or eight two benches of four. Members beyond eight wait for a bigger room.
 */
type Desk = { x: number; y: number; facing: "SE" | "SW" };
const ROWS = [1.1, 3.1];
export const MAX_DESKS = 8;
export function desksFor(count: number): Desk[] {
  // Desks side by side make one long bench per row: 1.4 m apart, as long as a desk.
  const cols = count <= 4 ? [2.3, 3.7] : count <= 6 ? [1.6, 3.0, 4.4] : [0.95, 2.35, 3.75, 5.15];
  const all = ROWS.flatMap((y) => cols.map((x) => ({ x, y, facing: "SE" as const })));
  // Fill a whole row before the next; two in a row of three sit at its ends.
  return all.slice(0, Math.max(0, Math.min(count, MAX_DESKS)));
}

// ── What a status looks like ──────────────────────────────────────────────────

export const STATUS: Record<WorkStatus, { label: string; icon: string; tone: "work" | "wait" | "alert" | "done" | "quiet" }> = {
  planning: { label: "規劃中", icon: "✎", tone: "work" },
  working: { label: "工作中", icon: "●", tone: "work" },
  reviewing: { label: "審核中", icon: "◎", tone: "work" },
  waiting_dependency: { label: "等待交付", icon: "◷", tone: "wait" },
  waiting_input: { label: "等待回覆", icon: "?", tone: "alert" },
  blocked: { label: "工作受阻", icon: "!", tone: "alert" },
  completed: { label: "工作完成", icon: "✓", tone: "done" },
  paused: { label: "已暫停", icon: "Ⅱ", tone: "quiet" },
  error: { label: "執行失敗", icon: "✕", tone: "alert" },
  idle: { label: "待命", icon: "○", tone: "quiet" },
  unknown: { label: "狀態未知", icon: "…", tone: "quiet" },
};

const POSE: Record<WorkStatus, BotStateName> = {
  planning: "thinking",
  working: "working",
  reviewing: "searching",
  waiting_dependency: "idle",
  waiting_input: "question",
  blocked: "approval",
  completed: "idle",
  paused: "idle",
  error: "error",
  idle: "idle",
  unknown: "idle",
};

// ── A Mochi ───────────────────────────────────────────────────────────────────

const BODY = 90;
interface Actor {
  memberId: string;
  canvas: HTMLCanvasElement;
  engine: BotEngine;
  size: number;
  yaw: number;
  status: WorkStatus | null;
  /** Drawn once more even when nothing moves (reduced motion, a mini scene). */
  dirty: boolean;
}

export interface SceneOptions {
  /** Small and still: the company map's thumbnails. */
  mini?: boolean;
  onSelect?: (memberId: string) => void;
  /** A click on the room where there is no one: the selection is let go. */
  onBlank?: () => void;
  /** A deliverable's picture, when there is one to show (an object URL), else null. */
  preview?: (a: Artifact) => string | null;
  /** A deliverable on the wall was clicked. */
  onArtifact?: (a: Artifact) => void;
}

/** Lays an element of w × h px onto a parallelogram of the room (TL, TR, BR, BL in 2× pixels). */
function onQuad(el: HTMLElement, quad: [number, number][], w: number, h: number) {
  const [tl, tr, , bl] = quad.map(([x, y]) => [H(x), H(y)]);
  const m = [(tr[0] - tl[0]) / w, (tr[1] - tl[1]) / w, (bl[0] - tl[0]) / h, (bl[1] - tl[1]) / h, tl[0], tl[1]];
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.transform = `matrix(${m.join(",")})`;
}

const KIND_ICON: Record<Artifact["kind"], string> = { image: "🖼", document: "📄", code: "⌨", website: "🌐", bundle: "📦" };

export class TeamScene {
  readonly el: HTMLElement;
  private stage: HTMLElement;
  private actors = new Map<string, Actor>();
  private labels = new Map<string, HTMLButtonElement>();
  private bubbles: HTMLElement;
  /** Labels and bubbles stay at reading size: placed in room coordinates, not scaled with the room. */
  private overlay: HTMLElement;
  private pinned: { el: HTMLElement; x: number; y: number }[] = [];
  private k = 1;
  private seenMessages = new Set<string>();
  private first = true;
  selected: string | null = null;
  bubblesOn = true;
  reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  constructor(readonly teamId: string, private store: OfficeStore, private opts: SceneOptions = {}) {
    this.stage = h("div", { class: "office-stage" });
    this.bubbles = h("div", { class: "office-bubbles", "aria-live": "polite" });
    this.overlay = h("div", { class: "office-overlay" }, this.bubbles);
    this.el = h("div", { class: `office-scene${opts.mini ? " mini" : ""}`, style: `aspect-ratio:${CROP.w} / ${CROP.h}` }, this.stage, this.overlay);
    // The room is drawn at 1600 × 1000 and scaled to whatever width it is given.
    const fit = () => {
      const w = this.el.clientWidth;
      if (!w) return;
      this.k = w / CROP.w;
      this.stage.style.transform = `scale(${this.k}) translate(${-CROP.x}px, ${-CROP.y}px)`;
      this.layout();
    };
    new ResizeObserver(fit).observe(this.el);
    // A Mochi picks its member; anywhere else in the room lets the selection go.
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".office-label, .office-bubble, .office-frame-item")) return;
      const mochi = t.closest<HTMLElement>(".office-mochi");
      if (mochi?.dataset.member) this.opts.onSelect?.(mochi.dataset.member);
      else this.opts.onBlank?.();
    });
    this.build();
    scenes.add(this);
  }

  private build() {
    this.stage.replaceChildren();
    this.actors.clear();
    this.labels.clear();
    if (!art) {
      // Without the art the office still works: the members as a list of buttons.
      this.stage.append(h("div", { class: "office-noart", text: "辦公室圖片載入中…" }));
      return;
    }
    const a = art;
    this.stage.append(h("img", { class: "office-room", src: `/office/${a.room.file}`, alt: "", draggable: "false" }));
    // The meeting table stands in front of what is behind it.
    const mt = a.props.meetingTable;
    const at = toScreen(...mt.at);
    this.stage.append(
      h("img", {
        class: "office-layer", src: `/office/${mt.file}`, alt: "", draggable: "false",
        style: `left:${at.x - H(mt.groundPivot[0])}px;top:${at.y - H(mt.groundPivot[1])}px;width:${H(mt.canvas[0])}px;z-index:${this.depth(...mt.at)}`,
      }),
    );
    const sofa = a.props.sofa;
    if (sofa) {
      const s = toScreen(...sofa.at);
      this.stage.append(
        h("img", {
          class: "office-layer", src: `/office/${sofa.file}`, alt: "", draggable: "false",
          style: `left:${s.x - H(sofa.groundPivot[0])}px;top:${s.y - H(sofa.groundPivot[1])}px;width:${H(sofa.canvas[0])}px;z-index:${this.depth(...sofa.at)}`,
        }),
      );
    }
  }

  /** Puts a reading-size element at a point of the room. */
  private pin(el: HTMLElement, x: number, y: number) {
    this.pinned.push({ el, x, y });
    this.overlay.append(el);
    this.place1(el, x, y);
  }
  private place1(el: HTMLElement, x: number, y: number) {
    el.style.left = `${(x - CROP.x) * this.k}px`;
    el.style.top = `${(y - CROP.y) * this.k}px`;
  }
  private layout() {
    this.pinned = this.pinned.filter((p) => p.el.isConnected);
    for (const p of this.pinned) this.place1(p.el, p.x, p.y);
  }

  private depth(x: number, y: number) {
    return Math.round((x + y) * 100) * 10;
  }

  /**
   * The walls carry the team's own record: its latest deliverables in the
   * frames, its plan on the whiteboard. Nothing here is decoration made up.
   */
  private drawWalls() {
    if (!art) return;
    this.stage.querySelectorAll(".office-wall").forEach((n) => n.remove());
    const latest = [...this.store.artifacts(this.teamId)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, art.room.artifactSlots.length);
    latest.forEach((a, i) => {
      const url = this.opts.preview?.(a) ?? null;
      const item = h(
        "button",
        {
          class: `office-wall office-frame-item ${a.kind}`, type: "button", tabindex: this.opts.mini ? "-1" : "0",
          title: `${a.name}(v${a.artifactVersion})`, "aria-label": `成果:${a.name}`,
          onClick: (e: Event) => { e.stopPropagation(); this.opts.onArtifact?.(a); },
        },
        url ? h("img", { src: url, alt: "", draggable: "false" }) : h("span", { class: "kind", text: KIND_ICON[a.kind] }),
        url ? null : h("span", { class: "name", text: a.name }),
      );
      onQuad(item, art!.room.artifactSlots[i], 100, 96);
      this.stage.append(item);
    });
    // The plan: the run's tasks, done ones ticked; the first few that fit.
    const tasks = this.store.tasks(this.teamId);
    if (tasks.length) {
      const done = tasks.filter((t) => t.status === "completed").length;
      const board = h(
        "div",
        { class: "office-wall office-plan", "aria-hidden": "true" },
        h("b", { text: `計畫 ${done}/${tasks.length}` }),
        ...tasks.slice(0, 6).map((t) => h("span", { class: t.status === "completed" ? "ok" : t.status === "running" || t.status === "reviewing" ? "now" : "" }, t.status === "completed" ? "✓ " : t.status === "running" || t.status === "reviewing" ? "▸ " : "○ ", t.title)),
      );
      onQuad(board, art.room.whiteboardQuad, 280, 200);
      this.stage.append(board);
    }
  }

  /**
   * The member's place: its desk — kept, so it never moves desks — or,
   * planning, the whiteboard; with nothing to do, a seat in the lounge.
   */
  private place(m: MemberSnapshot, i: number, count: number) {
    const desk = desksFor(count)[i];
    const standing = m.workStatus === "planning" && art ? art.room.spots.whiteboard : null;
    const lounge = m.workStatus === "idle" ? this.lounge.get(m.memberId) ?? null : null;
    return { desk, standing, lounge };
  }

  /** Who sits where on the sofa this time round: idle members in order, as many as it seats. */
  private lounge = new Map<string, { x: number; y: number }>();
  private seatLounge(members: MemberSnapshot[]) {
    this.lounge.clear();
    const sofa = art?.props.sofa;
    if (!sofa) return;
    const at = toScreen(...sofa.at);
    const idle = members.filter((m) => m.workStatus === "idle").slice(0, sofa.seats.length);
    idle.forEach((m, i) => this.lounge.set(m.memberId, { x: at.x - H(sofa.groundPivot[0]) + H(sofa.seats[i][0]), y: at.y - H(sofa.groundPivot[1]) + H(sofa.seats[i][1]) }));
  }

  /** Read the store again and bring the scene up to it. */
  update() {
    if (!art) return;
    const team = this.store.team(this.teamId);
    if (!team) return;
    const members = this.store.members(this.teamId);
    const keep = new Set<string>();
    // Everything per member is drawn afresh; only the Mochis carry over.
    this.stage.querySelectorAll(".office-ws, .office-screen, .office-shadow").forEach((n) => n.remove());
    this.overlay.querySelectorAll(".office-label").forEach((n) => n.remove());
    this.drawWalls();
    const seated = members.slice(0, MAX_DESKS);
    this.seatLounge(seated);
    seated.forEach((m, i) => {
      keep.add(m.memberId);
      this.drawMember(m, i, seated.length, m.memberId === team.leaderMemberId);
    });
    for (const [id, actor] of this.actors) {
      if (!keep.has(id)) {
        actor.canvas.remove();
        this.actors.delete(id);
      }
    }
    if (!this.opts.mini) this.drawBubbles(members);
    this.first = false;
    wake();
  }

  private drawMember(m: MemberSnapshot, i: number, count: number, leader: boolean) {
    const a = art!;
    const { desk, standing, lounge } = this.place(m, i, count);
    const ws = a.workstations[desk.facing];
    const at = toScreen(desk.x, desk.y);
    const ox = at.x - H(ws.groundPivot[0]);
    const oy = at.y - H(ws.groundPivot[1]);
    const local = ([px, py]: [number, number]) => ({ x: ox + H(px), y: oy + H(py) });
    const z = this.depth(desk.x, desk.y);
    const color = m.color ?? "#3B9EFF";
    const [W, Ht] = ws.canvas.map(H);
    const sel = this.selected === m.memberId;

    this.stage.append(
      h("div", { class: `office-shadow${sel ? " on" : ""}`, style: `left:${at.x}px;top:${at.y + 8}px;z-index:${z};--c:${color}` }),
      h("img", { class: "office-layer office-ws", src: `/office/${ws.layers[0]}`, alt: "", draggable: "false", style: `left:${ox}px;top:${oy}px;width:${W}px;height:${Ht}px;z-index:${z + 1}` }),
    );
    // The screen: the member's colour, lit while it works.
    const quad = ws.screenQuad.map(local);
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", `office-screen ${STATUS[m.workStatus].tone}`);
    svg.setAttribute("width", String(ROOM_W));
    svg.setAttribute("height", String(ROOM_H));
    svg.setAttribute("style", `z-index:${z + 2}`);
    const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const lines = [0.3, 0.48, 0.66].map((t, k) => {
      const l = lerp(quad[0], quad[3], t), r = lerp(quad[1], quad[2], t);
      const p = lerp(l, r, 0.12), q = lerp(l, r, [0.8, 0.62, 0.72][k]);
      return `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>`;
    }).join("");
    svg.innerHTML = `<polygon points="${quad.map((p) => `${p.x},${p.y}`).join(" ")}" fill="${color}"/>${lines}`;
    this.stage.append(svg);
    this.stage.append(h("img", { class: "office-layer office-ws", src: `/office/${ws.layers[1]}`, alt: "", draggable: "false", style: `left:${ox}px;top:${oy}px;width:${W}px;height:${Ht}px;z-index:${z + 3}` }));

    // The Mochi: on its chair, or standing at the whiteboard.
    const sofaAt = art!.props.sofa?.at;
    const seat = standing ? toScreen(standing[0], standing[1]) : lounge ?? local(ws.actorBottom);
    const seatZ = standing ? this.depth(standing[0], standing[1]) + 4 : lounge && sofaAt ? this.depth(...sofaAt) + 4 : z + 4;
    const actor = this.actor(m, color);
    const size = actor.size;
    const bottom = seat.y + (standing ? 0 : BODY * 0.06);
    Object.assign(actor.canvas.style, { left: `${seat.x - size / 2}px`, top: `${bottom - size / 2 - BODY / 2}px`, zIndex: String(seatZ) });
    actor.canvas.classList.toggle("selected", sel);
    if (!actor.canvas.isConnected) this.stage.append(actor.canvas);
    const screenMid = (quad[0].x + quad[1].x) / 2;
    actor.yaw = standing ? 0.5 : lounge ? 0 : screenMid < seat.x ? -0.42 : 0.42;
    this.pose(actor, m.workStatus);
    if (standing) this.stage.append(h("div", { class: "office-shadow small", style: `left:${seat.x}px;top:${seat.y}px;z-index:${seatZ - 1}` }));

    if (this.opts.mini) return;
    // The label: the member's name and what it is doing, a button for mouse and keyboard.
    const st = STATUS[m.workStatus];
    const task = m.primaryTaskId ? this.store.task(m.primaryTaskId)?.title : "";
    const wait = m.workStatus === "waiting_dependency" && m.waitingFor
      ? `等 ${m.waitingFor.memberIds.map((id) => this.store.member(this.teamId, id)?.displayName ?? id).join("、") || "交付"}${m.waitingFor.expectedArtifact ? ` · ${m.waitingFor.expectedArtifact}` : ""}`
      : "";
    const label = h(
      "button",
      {
        class: `office-label ${st.tone}${sel ? " on" : ""}${m.engineStatus === "offline" ? " offline" : ""}${lounge ? " compact" : ""}`, type: "button",
        style: `--c:${color}`,
        "aria-pressed": sel ? "true" : "false",
        "aria-label": `${m.displayName ?? m.memberId}${leader ? ",Leader" : ""},${m.roleLabel},${st.label}${task ? `,${task}` : ""}${m.engineStatus === "offline" ? ",未連線" : ""}`,
        "data-member": m.memberId,
        onClick: () => this.opts.onSelect?.(m.memberId),
      },
      h("span", { class: "who" }, leader ? h("i", { class: "crown", "aria-hidden": "true", text: "♛" }) : null, h("b", { text: m.displayName ?? m.memberId }), h("span", { class: "role", text: leader ? `Leader · ${m.roleLabel}` : m.roleLabel })),
      h("span", { class: "st" }, h("i", { "aria-hidden": "true", text: st.icon }), wait || (task ? `${st.label} · ${task}` : st.label)),
    );
    this.labels.set(m.memberId, label);
    // Over the member's head, where nothing nearer the camera can hide it.
    this.pin(label, seat.x, bottom - BODY - 4);
  }

  private actor(m: MemberSnapshot, color: string): Actor {
    let a = this.actors.get(m.memberId);
    if (!a) {
      const size = Math.round(BODY / 0.6);
      const canvas = h("canvas", { class: "office-mochi", "aria-hidden": "true", "data-member": m.memberId, style: `width:${size}px;height:${size}px` });
      const engine = new BotEngine();
      engine.isMini = true;
      engine.bodyColor = hexToRGB(color);
      engine.setState("idle", true);
      a = { memberId: m.memberId, canvas, engine, size, yaw: 0, status: null, dirty: true };
      this.actors.set(m.memberId, a);
    }
    return a;
  }

  /** The pose follows the recorded status; a finish is celebrated once, when it happens. */
  private pose(a: Actor, s: WorkStatus) {
    if (a.status === s) return;
    const was = a.status;
    a.status = s;
    a.dirty = true;
    a.engine.setPermanentEmote(s === "completed" ? "happy" : null);
    if (s === "completed" && was && !this.first && !this.opts.mini && !this.reduceMotion) {
      a.engine.setState("finished");
      window.setTimeout(() => a.status === "completed" && a.engine.setState("idle"), 2600);
      return;
    }
    a.engine.setState(POSE[s]);
  }

  /** Words said in the room since it was opened: up to three, over the speaker's head. */
  private drawBubbles(members: MemberSnapshot[]) {
    const msgs = this.store.messages(this.teamId);
    if (this.first) {
      for (const m of msgs) this.seenMessages.add(m.messageId);
      return;
    }
    const fresh = msgs.filter((m) => !this.seenMessages.has(m.messageId));
    for (const m of fresh) {
      this.seenMessages.add(m.messageId);
      if (this.bubblesOn) this.bubble(m, members);
    }
  }

  private bubble(msg: Message, members: MemberSnapshot[]) {
    const from = msg.from.kind === "member" ? msg.from.memberId : null;
    const speaker = from ? this.actors.get(from) : null;
    if (!speaker) return;
    const name = (id: string) => members.find((x) => x.memberId === id)?.displayName ?? id;
    const to = msg.toMemberIds.map(name).join("、");
    const b = h(
      "button",
      {
        class: "office-bubble", type: "button",
        title: msg.text,
        onClick: () => from && this.opts.onSelect?.(from),
      },
      h("small", { text: to ? `${name(from!)} → ${to}` : name(from!) }),
      h("span", { text: msg.text.length > 40 ? `${msg.text.slice(0, 40)}…` : msg.text }),
    );
    // Above the speaker's label.
    this.pin(b, parseFloat(speaker.canvas.style.left) + speaker.size / 2, parseFloat(speaker.canvas.style.top) + speaker.size / 2 - BODY / 2 - 90);
    this.bubbles.append(b);
    while (this.bubbles.children.length > 3) this.bubbles.firstElementChild!.remove();
    // Bubbles are a passing picture of a recorded message; the message stays in the log.
    window.setTimeout(() => b.remove(), 9000);
  }

  focusLabel(memberId: string) {
    this.labels.get(memberId)?.focus();
  }

  destroy() {
    scenes.delete(this);
  }

  /** Drawn by the frame loop. */
  frame(dt: number, dpr: number): boolean {
    let moving = false;
    for (const a of this.actors.values()) {
      if (!a.canvas.isConnected) continue;
      const still = this.opts.mini || this.reduceMotion;
      if (still && !a.dirty) continue;
      const px = Math.round(a.size * dpr);
      if (a.canvas.width !== px) {
        a.canvas.width = px;
        a.canvas.height = px;
      }
      const ctx = a.canvas.getContext("2d");
      if (!ctx) continue;
      // A still Mochi is drawn as it settles, then left.
      a.engine.update(still ? 1 : dt);
      a.engine.yaw = a.yaw;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, a.size, a.size);
      a.engine.draw(ctx, a.size, a.size);
      a.dirty = false;
      if (!still) moving = true;
    }
    return moving;
  }
}

// ── One frame loop for every scene on screen; none while hidden ───────────────

const scenes = new Set<TeamScene>();
let raf = 0;
let last = 0;
function frame(t: number) {
  raf = 0;
  if (document.hidden) {
    last = 0;
    return;
  }
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 1 / 40;
  last = t;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let moving = false;
  for (const s of scenes) if (s.el.isConnected && s.frame(dt, dpr)) moving = true;
  if (moving) raf = requestAnimationFrame(frame);
  else last = 0;
}
export function wake() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}
document.addEventListener("visibilitychange", wake);
