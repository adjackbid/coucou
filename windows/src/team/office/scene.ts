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
  /** Where the chair meets the floor, for its pool of shade. */
  chairFeet?: [number, number][];
}
type WorldToScreen = { x0: number; y0: number; perMetreX: number; perMetreY: number; perMetreZ: number };
/** A piece of décor: drawn where it stands, sorted by depth like the rest. */
interface Decor {
  id: string;
  file: string;
  canvas: [number, number];
  groundPivot: [number, number];
  at: [number, number];
  /** A rug or floor inlay: under everything that stands. */
  floor?: boolean;
  /** Its pool of shade, as wide as this share of its canvas (0 for none). */
  shadow?: number;
}
interface Props {
  meetingTable?: { file: string; canvas: [number, number]; groundPivot: [number, number]; at: [number, number] };
  /** What makes a room lived in: a coffee bar, plants, a glass meeting room… */
  decor?: Decor[];
  /** The lounge: a sofa whose seats take members with nothing to do. */
  sofa?: { file: string; canvas: [number, number]; groundPivot: [number, number]; seats: [number, number][]; at: [number, number] };
}
interface RoomArt {
  file: string;
  /** The image, in 2× pixels, and the part of it the room fills (logical px). */
  canvas: [number, number];
  crop: { x: number; y: number; w: number; h: number };
  worldToScreen: WorldToScreen;
  artifactSlots: [number, number][][];
  whiteboardQuad: [number, number][];
  spots: Record<string, [number, number]>;
}
/** 正向滿版 (fullbleed-frontal-v1): a second camera for the same theme. */
interface FrontalJson {
  room: RoomArt;
  workstations: Record<string, StationArt>;
  /** Fixed desk anchors, nearest first (metres of this camera's own floor basis). */
  desks: [number, number][];
  props?: Props;
  mochiScale?: number;
}
/** One look of an office (scene.json `themes`): its room, props and desks. */
interface ThemeJson {
  label: string;
  size: "standard" | "large";
  frontal?: FrontalJson;
  /** The large rooms' frontal version for 5–12 people (twelve desks). */
  frontalLarge?: FrontalJson;
  room: RoomArt;
  props: Props;
  /** "standard" uses the shared desks. */
  workstations: "standard" | Record<"SE" | "SW", StationArt>;
  /** 中二模式: where the boss stands (metres), how big, and what makes way for it. */
  /** Where the members stand, by how many there are: the smallest list that seats them all, front line first. */
  battle?: { boss: [number, number]; scale: number; hide: string[]; formation: Record<string, [number, number][]>; desks: [number, number][] };
}
/** A picture rendered in the office camera: its canvas and where it touches the floor (2× px). */
export interface Sprite {
  file: string;
  canvas: [number, number];
  groundPivot: [number, number];
  /** Where its effects start: a staff's gem, a sword's tip. */
  effectOrigin?: [number, number];
}
export type BossState = "idle" | "rage" | "guard" | "hurt" | "regen" | "sealed" | "defeated" | "attack";
/** The boss: every state on one canvas with one groundPivot; each state carries its own named points. */
export interface BossArt {
  canvas: [number, number];
  groundPivot: [number, number];
  states: Record<BossState, { file: string } & Record<string, [number, number] | [number, number][]>>;
}
export interface BattleArt {
  boss: BossArt;
  accessories: Record<string, Sprite>;
  /** The five battlefields (kit v4): each an arena pair and a boss of its own states. */
  worlds?: Record<string, WorldArt>;
}
/** A battlefield rendered in the office camera: its ground and backdrop, its front edge, its boss. */
export interface WorldArt {
  arena: { file: string; front: string };
  boss: BossArt;
  battle: NonNullable<ThemeJson["battle"]>;
}
export interface SceneArt {
  workstations: Record<"SE" | "SW", StationArt>;
  themes: Record<string, ThemeJson>;
  battle?: BattleArt;
}
export interface Theme {
  name: string;
  label: string;
  large: boolean;
  room: RoomArt;
  props: Props;
  battle: ThemeJson["battle"];
  workstations: Record<"SE" | "SW", StationArt>;
  desks: (count: number) => Desk[];
  maxDesks: number;
  /** The frontal fullbleed camera: chair behind the member, desk front over it, no live screens. */
  frontal?: boolean;
  /** Mochis drawn this much bigger than BODY in this camera. */
  mochiScale?: number;
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

const H = (v: number) => v / 2;

/** The art as loaded: the battle layer reads its boss and accessories here. */
export const sceneArt = () => art;

function toScreenIn(w: WorldToScreen, x: number, y: number, z = 0) {
  return { x: H(w.x0 + (y - x) * w.perMetreX), y: H(w.y0 + (x + y) * w.perMetreY - z * w.perMetreZ) };
}

// ── The looks of an office ────────────────────────────────────────────────────

/** Office looks, in the order the team settings offer them. */
export const THEME_LABELS: Record<string, string> = {
  warm: "溫暖木質",
  japandi: "日式靜謐",
  industrial: "工業創作",
  biophilic: "植感共創",
  futurelab: "未來科技",
  library: "書房策略",
  premium: "高級辦公室",
  penthouse: "頂樓景觀",
};
/** The large rooms: a big team gets one of these, the same per team. */
const LARGE = ["premium", "penthouse"];
const STANDARD = ["warm", "japandi", "industrial", "biophilic", "futurelab", "library"];
/** Looks that were renamed: a team file may still name the old one. */
const RENAMED: Record<string, string> = { nordic: "japandi", studio: "biophilic" };
/** From this many members a team gets the large office. */
export const LARGE_FROM = 5;

/**
 * The look a team's office has: the one its settings name, else Coucou's
 * choice — the large office for a big team, and for the others one of the
 * standard looks, the same for a team every time (from its id).
 */
export function themeName(teamId: string, setting: string | undefined, members: number): string {
  const named = setting ? RENAMED[setting] ?? setting : "";
  if (THEME_LABELS[named]) return named;
  let h = 0;
  for (const ch of teamId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  if (members >= LARGE_FROM) {
    // Development only: `&large=penthouse` picks the large room, to look at it.
    const asked = import.meta.env?.DEV && typeof location !== "undefined" ? new URLSearchParams(location.search).get("large") : null;
    if (asked && LARGE.includes(asked)) return asked;
    return LARGE[h % LARGE.length];
  }
  return STANDARD[h % STANDARD.length];
}

/** The same theme through the frontal fullbleed camera, when its art exists. */
export function frontalTheme(name: string, large = false): Theme | null {
  if (!art) return null;
  const key = art.themes[name] ? name : "warm";
  const base = art.themes[key];
  const f = large ? base.frontalLarge : base.frontal;
  if (!f) return null;
  return {
    name: `front${large ? "L" : ""}:${key}`,
    label: base.label,
    large: base.size === "large",
    room: f.room,
    props: f.props ?? {},
    battle: base.battle,
    workstations: f.workstations,
    desks: (count: number) => f.desks.slice(0, Math.max(0, count)).map(([x, y]) => ({ x, y, facing: "SE" as const })),
    maxDesks: f.desks.length,
    frontal: true,
    mochiScale: f.mochiScale ?? 1.2,
  };
}

export function theme(name: string): Theme | null {
  if (!art) return null;
  const t = art.themes[name] ?? art.themes.warm;
  const large = t.size === "large";
  return {
    name: art.themes[name] ? name : "warm",
    label: t.label,
    large,
    room: t.room,
    props: t.props,
    battle: t.battle,
    workstations: t.workstations === "standard" ? art.workstations : t.workstations,
    desks: large ? largeDesks : desksFor,
    maxDesks: large ? 12 : MAX_DESKS,
  };
}

/** The large office (10 × 9 m): benches of four between the meeting room, the lounge and the kitchen. */
function largeDesks(count: number): Desk[] {
  const rows = count <= 8 ? [4.2, 6.6] : [4.0, 5.9, 7.8];
  // Two benches of two per row, with an aisle between them.
  const cols = [3.0, 4.4, 6.3, 7.7];
  return rows.flatMap((y) => cols.map((x) => ({ x, y, facing: "SE" as const }))).slice(0, Math.max(0, Math.min(count, 12)));
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
  // Eight keep clear of what stands against the right wall (bookcase, rack, plants).
  const cols = count <= 4 ? [2.3, 3.7] : count <= 6 ? [1.6, 3.0, 4.4] : [1.1, 2.5, 3.9, 5.3];
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

/** Nothing to do for now: these members go and sit in the lounge. */
const RESTING = new Set<WorkStatus>(["idle", "completed", "waiting_dependency"]);

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
  /** Room around the body for what it holds (中二模式); the canvas is size + 2 × pad. */
  pad: number;
  /** Moved off its place this frame by the layer (a lunge); drawn back when it ends. */
  off?: { x: number; y: number };
  /** Where its canvas is (top-left, stage pixels), and where it is going: between desk and sofa it walks. */
  at?: { x: number; y: number };
  to?: { x: number; y: number; z: number };
}

/** How fast a Mochi walks across the room, in stage pixels a second. */
const WALK = 240;

export interface SceneOptions {
  /** Small and still: the company map's thumbnails. */
  mini?: boolean;
  /** A mini room's frames per second while its fight plays (default 20). */
  fps?: () => number;
  onSelect?: (memberId: string) => void;
  /** A bubble was clicked: the message's speaker, to open on its conversation. */
  onMessage?: (memberId: string) => void;
  /** A click on the room where there is no one: the selection is let go. */
  onBlank?: () => void;
  /** A deliverable's picture, when there is one to show (an object URL), else null. */
  preview?: (a: Artifact) => string | null;
  /** A deliverable on the wall was clicked. */
  onArtifact?: (a: Artifact) => void;
}

/** A layer drawn over an office — 中二模式's boss, effects and heroes' looks. */
export interface SceneLayer {
  /** Room around each Mochi's canvas for what it holds. */
  readonly pad: number;
  /** The room was built (again): put in it what belongs there. */
  build(): void;
  /** The store changed. */
  update(): void;
  /** A frame; true while anything of the layer still moves. */
  frame(dt: number): boolean;
  /** Draws over a Mochi, the body drawn in size × size at the origin. */
  decorate?(memberId: string, ctx: CanvasRenderingContext2D, size: number, engine: BotEngine, facing: number): void;
  /** 陣亡: a member past its own limits, grey where it stands. */
  fallen?(memberId: string): boolean;
  /** Members drawn bigger than at their desks (1 = as they are). */
  readonly heroScale?: number;
  /** The battlefield this room becomes, if any: the office's furniture and walls make way for it. */
  arena?(): { id: string; art: WorldArt } | null;
  /** Where a member stands instead of its desk (metres), and the way it faces; null for its desk. */
  formation?(memberId: string, index: number, count: number): { x: number; y: number; yaw: number } | null;
  /** How far a member's Mochi is moved this frame (a lunge, a recoil), in stage pixels. */
  offset?(memberId: string): { x: number; y: number } | null;
  /** Taken off: everything of it leaves the room, nothing keeps playing. */
  detach(): void;
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
  /** The look on screen; the room is built again when the team's changes. */
  private theme: Theme | null = null;
  /** How many members have a desk in this office. */
  get capacity(): number {
    return this.theme?.maxDesks ?? MAX_DESKS;
  }
  selected: string | null = null;
  bubblesOn = true;
  reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  /** What is drawn over the office, if anything (中二模式). */
  private layer: SceneLayer | null = null;
  /** The office asked for the frontal fullbleed camera (never in 中二模式). */
  frontal = false;

  constructor(readonly teamId: string, private store: OfficeStore, private opts: SceneOptions = {}) {
    this.stage = h("div", { class: "office-stage" });
    this.bubbles = h("div", { class: "office-bubbles", "aria-live": "polite" });
    this.overlay = h("div", { class: "office-overlay" }, this.bubbles);
    this.el = h("div", { class: `office-scene${opts.mini ? " mini" : ""}` }, this.stage, this.overlay);
    // The room is drawn at its own size and scaled to whatever width it is given.
    const fit = () => {
      const w = this.el.clientWidth;
      if (!w) return;
      const crop = this.crop;
      this.k = w / crop.w;
      this.stage.style.transform = `scale(${this.k}) translate(${-crop.x}px, ${-crop.y}px)`;
      this.layout();
    };
    this.fit = fit;
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

  private fit: () => void = () => {};

  // ── For a layer over the room ──

  get stageEl(): HTMLElement {
    return this.stage;
  }
  get overlayEl(): HTMLElement {
    return this.overlay;
  }
  get roomTheme(): Theme | null {
    return this.theme;
  }
  get mini(): boolean {
    return !!this.opts.mini;
  }
  /** Room pixels to screen pixels. */
  get scale(): number {
    return this.k;
  }
  get cropBox() {
    return this.crop;
  }
  /** A point of the floor (metres), in stage pixels. */
  screen(x: number, y: number, z = 0) {
    return this.toScreen(x, y, z);
  }
  depthOf(x: number, y: number) {
    return this.depth(x, y);
  }
  /** A member's Mochi where it is now: the middle of its body's canvas (stage pixels), its size, the way it faces. */
  mochi(memberId: string): { x: number; y: number; size: number; facing: number } | null {
    const a = this.actors.get(memberId);
    if (!a?.at || !a.canvas.isConnected) return null;
    return { x: a.at.x + a.pad + a.size / 2, y: a.at.y + a.pad + a.size / 2, size: a.size, facing: a.yaw };
  }
  memberIds(): string[] {
    return [...this.actors.keys()];
  }
  /** Puts a reading-size element at a point of the room, kept there as the room is resized. */
  pinAt(el: HTMLElement, x: number, y: number) {
    this.pin(el, x, y);
  }

  /** Every Mochi drawn once more (what it holds has finished loading). */
  redrawMochis() {
    for (const a of this.actors.values()) a.dirty = true;
    wake();
  }

  /** A layer over the room, or none: the one before is taken off. */
  setLayer(layer: SceneLayer | null) {
    if (this.layer === layer) return;
    this.layer?.detach();
    this.layer = layer;
    if (this.theme) layer?.build();
    this.update();
  }
  get currentLayer(): SceneLayer | null {
    return this.layer;
  }

  private get crop() {
    return this.theme?.room.crop ?? { x: 0, y: 0, w: 1220, h: 990 };
  }
  private toScreen(x: number, y: number, z = 0) {
    return toScreenIn(this.theme!.room.worldToScreen, x, y, z);
  }

  private build() {
    this.stage.replaceChildren();
    this.overlay.replaceChildren(this.bubbles);
    this.pinned = [];
    for (const a of this.actors.values()) a.canvas.remove();
    this.actors.clear();
    this.labels.clear();
    const t = this.theme;
    if (!t) {
      // Without the art the office still works: the members as a list of buttons.
      this.stage.append(h("div", { class: "office-noart", text: "辦公室圖片載入中…" }));
      return;
    }
    const [cw, ch] = t.room.canvas.map(H);
    this.stage.style.width = `${cw}px`;
    this.stage.style.height = `${ch}px`;
    this.el.style.aspectRatio = `${t.room.crop.w} / ${t.room.crop.h}`;
    this.el.dataset.theme = t.name;
    this.stage.append(h("img", { class: "office-room", src: `/office/${t.room.file}`, alt: "", draggable: "false", style: `width:${cw}px;height:${ch}px` }));
    // A battlefield's front edge: chunky ground between the fight and the camera.
    const arena = this.layer?.arena?.() ?? null;
    if (arena && t.name === `world:${arena.id}`) {
      this.stage.append(
        h("img", {
          class: "office-layer bt-arena-front", src: `/office/${arena.art.arena.front}`, alt: "", draggable: "false",
          style: `left:0;top:0;width:${cw}px;height:${ch}px;z-index:${this.depth(7.2, 7.2)}`,
        }),
      );
    }
    // The meeting table stands in front of what is behind it.
    const mt = t.props.meetingTable;
    if (mt) {
      const at = this.toScreen(...mt.at);
      this.stage.append(
        h("div", { class: "office-shadow prop", "data-prop": "meetingTable", style: `left:${at.x}px;top:${at.y - 4}px;width:${H(mt.canvas[0]) * 0.82}px;height:${H(mt.canvas[0]) * 0.36}px;z-index:${this.depth(...mt.at) - 1}` }),
        h("img", {
          class: "office-layer", src: `/office/${mt.file}`, alt: "", draggable: "false", "data-prop": "meetingTable",
          style: `left:${at.x - H(mt.groundPivot[0])}px;top:${at.y - H(mt.groundPivot[1])}px;width:${H(mt.canvas[0])}px;z-index:${this.depth(...mt.at)}`,
        }),
      );
    }
    const sofa = t.props.sofa;
    if (sofa) {
      const s = this.toScreen(...sofa.at);
      this.stage.append(
        h("div", { class: "office-shadow prop", "data-prop": "sofa", style: `left:${s.x}px;top:${s.y - 6}px;width:${H(sofa.canvas[0]) * 0.92}px;height:${H(sofa.canvas[0]) * 0.34}px;z-index:${this.depth(...sofa.at) - 1}` }),
        h("img", {
          class: "office-layer", src: `/office/${sofa.file}`, alt: "", draggable: "false", "data-prop": "sofa",
          style: `left:${s.x - H(sofa.groundPivot[0])}px;top:${s.y - H(sofa.groundPivot[1])}px;width:${H(sofa.canvas[0])}px;z-index:${this.depth(...sofa.at)}`,
        }),
      );
    }
    for (const d of t.props.decor ?? []) {
      const p = this.toScreen(...d.at);
      const z = d.floor ? 1 : this.depth(...d.at);
      if (!d.floor && (d.shadow ?? 0.8) > 0) {
        const w = H(d.canvas[0]) * (d.shadow ?? 0.8);
        this.stage.append(h("div", { class: "office-shadow prop", "data-prop": "decor", style: `left:${p.x}px;top:${p.y - 4}px;width:${w}px;height:${w * 0.4}px;z-index:${z - 1}` }));
      }
      this.stage.append(
        h("img", {
          class: "office-layer office-decor", src: `/office/${d.file}`, alt: "", draggable: "false", "data-prop": "decor", "data-decor": d.id,
          style: `left:${p.x - H(d.groundPivot[0])}px;top:${p.y - H(d.groundPivot[1])}px;width:${H(d.canvas[0])}px;z-index:${z}`,
        }),
      );
    }
    this.layer?.build();
    this.fit();
  }

  /** Puts a reading-size element at a point of the room. */
  private pin(el: HTMLElement, x: number, y: number) {
    this.pinned.push({ el, x, y });
    this.overlay.append(el);
    this.place1(el, x, y);
  }
  private place1(el: HTMLElement, x: number, y: number) {
    const crop = this.crop;
    el.style.left = `${(x - crop.x) * this.k}px`;
    el.style.top = `${(y - crop.y) * this.k}px`;
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
    const room = this.theme!.room;
    this.stage.querySelectorAll(".office-wall").forEach((n) => n.remove());
    if (!room.whiteboardQuad.length) return;
    const latest = [...this.store.artifacts(this.teamId)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, room.artifactSlots.length);
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
      onQuad(item, room.artifactSlots[i], 100, 96);
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
      onQuad(board, room.whiteboardQuad, 280, 200);
      this.stage.append(board);
    }
  }

  /**
   * The member's place: its desk — kept, so it never moves desks — or,
   * planning, the whiteboard; with nothing to do, a seat in the lounge.
   */
  private place(m: MemberSnapshot, i: number, count: number) {
    const desk = this.theme!.desks(count)[i];
    // 中二模式: everyone takes their place facing the boss, whatever they are doing.
    const spot = this.layer?.formation?.(m.memberId, i, count) ?? null;
    if (spot) return { desk, standing: [spot.x, spot.y] as [number, number], lounge: null, yaw: spot.yaw };
    const standing = m.workStatus === "planning" ? this.theme!.room.spots.whiteboard ?? null : null;
    const lounge = this.lounge.get(m.memberId) ?? null;
    return { desk, standing, lounge, yaw: null as number | null };
  }

  /**
   * Who sits where on the sofa this time round: members with nothing to do —
   * done, never given work, or waiting for someone else's hand-in — those
   * with no work at all first, as many as it seats. A member that keeps
   * resting keeps its seat.
   */
  private lounge = new Map<string, { x: number; y: number }>();
  private loungeSeat = new Map<string, number>();
  private seatLounge(members: MemberSnapshot[]) {
    this.lounge.clear();
    const sofa = this.theme?.props.sofa;
    if (!sofa) return;
    const at = this.toScreen(...sofa.at);
    const rank = (s: WorkStatus) => (s === "completed" || s === "idle" ? 0 : 1);
    const resting = members.filter((m) => RESTING.has(m.workStatus)).sort((a, b) => rank(a.workStatus) - rank(b.workStatus)).slice(0, sofa.seats.length);
    const kept = new Map<string, number>();
    const taken = new Set<number>();
    for (const m of resting) {
      const was = this.loungeSeat.get(m.memberId);
      if (was !== undefined && was < sofa.seats.length && !taken.has(was)) {
        kept.set(m.memberId, was);
        taken.add(was);
      }
    }
    for (const m of resting) {
      if (kept.has(m.memberId)) continue;
      const free = sofa.seats.findIndex((_, i) => !taken.has(i));
      kept.set(m.memberId, free);
      taken.add(free);
    }
    this.loungeSeat = kept;
    for (const [id, i] of kept) this.lounge.set(id, { x: at.x - H(sofa.groundPivot[0]) + H(sofa.seats[i][0]), y: at.y - H(sofa.groundPivot[1]) + H(sofa.seats[i][1]) });
  }

  /** A battlefield as a look of the office: the same projection, no props, no desks. */
  private arenaTheme(id: string, a: WorldArt): Theme {
    return {
      name: `world:${id}`,
      label: id,
      large: false,
      room: {
        file: a.arena.file,
        canvas: [3200, 2000],
        crop: { x: 190, y: 0, w: 1220, h: 990 },
        worldToScreen: { x0: 1600, y0: 738, perMetreX: 197.99, perMetreY: 98.99, perMetreZ: 242.49 },
        artifactSlots: [],
        whiteboardQuad: [],
        spots: {},
      },
      props: {},
      battle: a.battle,
      workstations: art!.workstations,
      desks: desksFor,
      maxDesks: MAX_DESKS,
    };
  }

  /** Read the store again and bring the scene up to it. */
  update() {
    if (!art) return;
    const team = this.store.team(this.teamId);
    if (!team) return;
    const members = this.store.members(this.teamId);
    const arena = this.layer?.arena?.() ?? null;
    let base = themeName(this.teamId, team.officeLayoutId, members.length);
    const frontDesks = (art.themes[base] ?? art.themes.warm)?.frontal?.desks.length ?? 0;
    let front = !arena && this.frontal && frontDesks > 0;
    let large = false;
    // More members than the frontal room has desks: the team moves to a
    // bigger office — a large room's frontal version, which seats twelve —
    // rather than leaving anyone outside. Without one, the classic camera.
    if (front && members.length > frontDesks) {
      base = themeName(this.teamId, undefined, Math.max(members.length, LARGE_FROM));
      const big = (art.themes[base] ?? art.themes.warm)?.frontalLarge?.desks.length ?? 0;
      large = big >= members.length;
      front = large;
    }
    const name = arena ? `world:${arena.id}` : front ? `front${large ? "L" : ""}:${base}` : base;
    if (this.theme?.name !== name) {
      this.theme = arena ? this.arenaTheme(arena.id, arena.art) : front ? frontalTheme(base, large) : theme(base);
      this.build();
      // Another room: everyone is put in place, nobody walks over from the old one.
      for (const a of this.actors.values()) a.at = undefined;
      this.loungeSeat.clear();
    }
    const keep = new Set<string>();
    // Everything per member is drawn afresh; only the Mochis carry over.
    this.stage.querySelectorAll(".office-ws, .office-screen, .office-shadow").forEach((n) => n.remove());
    this.overlay.querySelectorAll(".office-label").forEach((n) => n.remove());
    this.drawWalls();
    const seated = members.slice(0, this.theme!.maxDesks);
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
    this.drawBubbles(members);
    this.layer?.update();
    this.first = false;
    wake();
  }

  private drawMember(m: MemberSnapshot, i: number, count: number, leader: boolean) {
    const t = this.theme!;
    const { desk, standing, lounge, yaw } = this.place(m, i, count);
    const ws = t.workstations[desk.facing];
    const at = this.toScreen(desk.x, desk.y);
    const ox = at.x - H(ws.groundPivot[0]);
    const oy = at.y - H(ws.groundPivot[1]);
    const local = ([px, py]: [number, number]) => ({ x: ox + H(px), y: oy + H(py) });
    const z = this.depth(desk.x, desk.y);
    const color = m.color ?? "#3B9EFF";
    const [W, Ht] = ws.canvas.map(H);
    const sel = this.selected === m.memberId;
    // 中二模式 clears the floor: the members stand in the fight, their desks put away.
    const quad = yaw === null ? this.drawDesk(desk, color, STATUS[m.workStatus].tone, sel) : ws.screenQuad.map(local);

    // The Mochi: on its chair, or standing at the whiteboard.
    const sofaAt = t.props.sofa?.at;
    const seat = standing ? this.toScreen(standing[0], standing[1]) : lounge ?? local(ws.actorBottom);
    const deskLift = this.theme?.frontal ? 2 : 4;
    const seatZ = standing ? this.depth(standing[0], standing[1]) + 4 : lounge && sofaAt ? this.depth(...sofaAt) + 4 : z + deskLift;
    const actor = this.actor(m, color);
    // 中二模式 draws its heroes bigger, rounder, on their feet.
    const body = BODY * (this.layer?.heroScale ?? this.theme?.mochiScale ?? 1);
    const size = Math.round(body / 0.6);
    // What it holds needs room around it: a canvas that size bigger, put back by as much.
    const pad = this.layer?.pad ?? 0;
    if (actor.pad !== pad || actor.size !== size) {
      // Drawn at another size: kept where it stands, measured from its feet.
      const feet = actor.at ? { x: actor.at.x + actor.pad + actor.size / 2, y: actor.at.y + actor.pad + actor.size / 2 } : null;
      actor.pad = pad;
      actor.size = size;
      actor.canvas.style.width = actor.canvas.style.height = `${size + 2 * pad}px`;
      actor.at = feet ? { x: feet.x - size / 2 - pad, y: feet.y - size / 2 - pad } : undefined;
      actor.dirty = true;
    }
    actor.engine.glossy = actor.engine.feet = !!this.layer;
    const bottom = seat.y + (standing ? 0 : body * 0.06);
    // Between desk and sofa the Mochi walks there (frame() moves it); the
    // first picture and 減少動態 just put it in its place.
    const left = seat.x - size / 2 - pad;
    const top = bottom - size / 2 - body / 2 - pad;
    actor.to = { x: left, y: top, z: seatZ };
    const walking = !!actor.at && !this.first && !this.reduceMotion && (actor.at.x !== left || actor.at.y !== top);
    if (!walking) actor.at = { x: left, y: top };
    // On the way it is drawn over whatever it passes.
    const drawnZ = walking ? Math.max(Number(actor.canvas.style.zIndex) || 0, seatZ) : seatZ;
    Object.assign(actor.canvas.style, { left: `${actor.at!.x}px`, top: `${actor.at!.y}px`, zIndex: String(drawnZ) });
    if (walking) actor.dirty = true;
    actor.canvas.classList.toggle("selected", sel);
    actor.canvas.classList.toggle("bt-down", !!this.layer?.fallen?.(m.memberId));
    if (!actor.canvas.isConnected) this.stage.append(actor.canvas);
    const screenMid = (quad[0].x + quad[1].x) / 2;
    void W;
    void Ht;
    actor.yaw = yaw ?? (standing ? 0.5 : lounge ? 0 : screenMid < seat.x ? -0.42 : 0.42);
    this.pose(actor, m.workStatus);
    if (standing) this.stage.append(h("div", { class: "office-shadow small", style: `left:${seat.x}px;top:${seat.y}px;z-index:${seatZ - 1}` }));

    if (this.opts.mini) {
      // The company map is live but small: each member's state as a mark over its head.
      const st = STATUS[m.workStatus];
      const chip = h("span", { class: `office-label office-chip ${st.tone}`, title: `${m.displayName ?? m.memberId} · ${st.label}`, style: `--c:${color}` }, st.icon);
      this.pin(chip, seat.x, bottom - body - 4);
      return;
    }
    // The label: the member's name and what it is doing, a button for mouse and keyboard.
    const st = STATUS[m.workStatus];
    const task = m.primaryTaskId ? this.store.task(m.primaryTaskId)?.title : "";
    const wait = m.workStatus === "waiting_dependency" && m.waitingFor
      ? `等 ${m.waitingFor.memberIds.map((id) => this.store.member(this.teamId, id)?.displayName ?? id).join("、") || "交付"}${m.waitingFor.expectedArtifact ? ` · ${m.waitingFor.expectedArtifact}` : ""}`
      : "";
    const label = h(
      "button",
      {
        class: `office-label ${st.tone}${sel ? " on" : ""}${m.engineStatus === "offline" ? " offline" : ""}${lounge || (t.large && !sel) || (yaw !== null && !sel) ? " compact" : ""}`, type: "button",
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
    this.pin(label, seat.x, bottom - body - 4);
  }

  /**
   * A desk at a place of the floor, its screen in a colour: a member's, or (中二模式)
   * one kept as part of the room. Drawn afresh at every update with the members'.
   */
  drawDesk(desk: Desk, color: string, tone = "quiet", sel = false): { x: number; y: number }[] {
    const t = this.theme!;
    const ws = t.workstations[desk.facing];
    const at = this.toScreen(desk.x, desk.y);
    const ox = at.x - H(ws.groundPivot[0]);
    const oy = at.y - H(ws.groundPivot[1]);
    const local = ([px, py]: [number, number]) => ({ x: ox + H(px), y: oy + H(py) });
    const z = this.depth(desk.x, desk.y);
    const [W, Ht] = ws.canvas.map(H);
    if (t.frontal) {
      // 正向鏡頭: the chair behind (z+1), the member between (z+2), the desk
      // with the monitor's BACK in front (z+3) — no live screen to draw.
      const img = (file: string, zi: number) =>
        file ? h("img", { class: "office-layer office-ws", src: `/office/${file}`, alt: "", draggable: "false", style: `left:${ox}px;top:${oy}px;width:${W}px;height:${Ht}px;z-index:${zi}` }) : null;
      const chairEl = img(ws.layers[0], z + 1);
      const deskEl = img(ws.layers[1], z + 3);
      this.stage.append(
        h("div", { class: `office-shadow${sel ? " on" : ""}`, style: `left:${at.x}px;top:${at.y + 6}px;z-index:${z};--c:${color}` }),
        ...(chairEl ? [chairEl] : []),
        ...(deskEl ? [deskEl] : []),
      );
      return ws.screenQuad.map(local);
    }
    const chairAt = ws.chairFeet?.length
      ? local([ws.chairFeet.reduce((n, p) => n + p[0], 0) / ws.chairFeet.length, ws.chairFeet.reduce((n, p) => n + p[1], 0) / ws.chairFeet.length])
      : null;
    this.stage.append(
      h("div", { class: `office-shadow${sel ? " on" : ""}`, style: `left:${at.x}px;top:${at.y + 8}px;z-index:${z};--c:${color}` }),
      chairAt ? h("div", { class: "office-shadow seat", style: `left:${chairAt.x}px;top:${chairAt.y - 2}px;z-index:${z}` }) : h("i", { style: "display:none" }),
      h("img", { class: "office-layer office-ws", src: `/office/${ws.layers[0]}`, alt: "", draggable: "false", style: `left:${ox}px;top:${oy}px;width:${W}px;height:${Ht}px;z-index:${z + 1}` }),
    );
    // The screen: the member's colour, lit while it works.
    const quad = ws.screenQuad.map(local);
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", `office-screen ${tone}`);
    svg.setAttribute("width", String(H(t.room.canvas[0])));
    svg.setAttribute("height", String(H(t.room.canvas[1])));
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
    return quad;
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
      a = { memberId: m.memberId, canvas, engine, size, pad: 0, yaw: 0, status: null, dirty: true };
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
    if (s === "completed" && was && !this.first && !this.reduceMotion) {
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
    if (this.opts.mini) {
      const mark = h("span", { class: "office-bubble mini", title: `${name(from!)}${to ? ` → ${to}` : ""}:${msg.text}` }, "💬");
      this.pin(mark, parseFloat(speaker.canvas.style.left) + speaker.pad + speaker.size / 2 + 30, parseFloat(speaker.canvas.style.top) + speaker.pad + speaker.size / 2 - BODY / 2 - 40);
      this.bubbles.append(mark);
      window.setTimeout(() => mark.remove(), 6000);
      return;
    }
    const b = h(
      "button",
      {
        class: "office-bubble", type: "button",
        title: msg.text,
        onClick: (e: Event) => { e.stopPropagation(); if (from) (this.opts.onMessage ?? this.opts.onSelect)?.(from); },
      },
      h("small", { text: to ? `${name(from!)} → ${to}` : name(from!) }),
      h("span", { text: msg.text.length > 40 ? `${msg.text.slice(0, 40)}…` : msg.text }),
    );
    // Above the speaker's label.
    this.pin(b, parseFloat(speaker.canvas.style.left) + speaker.pad + speaker.size / 2, parseFloat(speaker.canvas.style.top) + speaker.pad + speaker.size / 2 - BODY / 2 - 90);
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
  private sinceDrawn = 0;

  frame(dt: number, dpr: number): boolean {
    let moving = false;
    const still = this.reduceMotion;
    // The company map's rooms move at about 20 frames a second: enough to be alive.
    this.sinceDrawn += dt;
    if (this.opts.mini && !still && this.sinceDrawn < 1 / (this.opts.fps?.() ?? 20) && ![...this.actors.values()].some((a) => a.dirty)) return true;
    const step = this.opts.mini ? this.sinceDrawn : dt;
    this.sinceDrawn = 0;
    // A canvas is drawn at the size it is shown: the room is scaled down, so is the Mochi.
    const res = dpr * Math.min(1, Math.max(0.25, this.k));
    for (const a of this.actors.values()) {
      if (!a.canvas.isConnected) continue;
      // Walking to its new place: a step nearer each frame, facing the way it goes.
      let facing = a.yaw;
      if (a.at && a.to && (a.at.x !== a.to.x || a.at.y !== a.to.y)) {
        const dx = a.to.x - a.at.x;
        const dy = a.to.y - a.at.y;
        const d = Math.hypot(dx, dy);
        const reach = WALK * Math.min(0.1, step);
        if (still || d <= reach) {
          a.at = { x: a.to.x, y: a.to.y };
          a.canvas.style.zIndex = String(a.to.z);
        } else {
          a.at = { x: a.at.x + (dx / d) * reach, y: a.at.y + (dy / d) * reach };
          facing = dx < 0 ? -0.7 : 0.7;
        }
        a.canvas.style.left = `${a.at.x}px`;
        a.canvas.style.top = `${a.at.y}px`;
        a.dirty = true;
        moving = true;
      }
      // On its feet, it steps as it goes.
      const walkingNow = !!(a.at && a.to && (a.at.x !== a.to.x || a.at.y !== a.to.y));
      a.engine.stride = walkingNow && !still ? Math.sin(performance.now() / 70) : 0;
      // A lunge or a recoil from the layer: moved for this frame only.
      const off = still ? null : this.layer?.offset?.(a.memberId) ?? null;
      if (off || a.off) {
        const o = off ?? { x: 0, y: 0 };
        a.canvas.style.transform = off ? `translate(${o.x}px, ${o.y}px)` : "";
        a.off = off ?? undefined;
        a.dirty = true;
      }
      if (still && !a.dirty) continue;
      const full = a.size + 2 * a.pad;
      const px = Math.round(full * res);
      if (a.canvas.width !== px) {
        a.canvas.width = px;
        a.canvas.height = px;
      }
      const ctx = a.canvas.getContext("2d");
      if (!ctx) continue;
      // A still Mochi is drawn as it settles, then left.
      a.engine.update(still ? 1 : Math.min(0.1, step));
      a.engine.yaw = facing;
      ctx.setTransform(res, 0, 0, res, 0, 0);
      ctx.clearRect(0, 0, full, full);
      ctx.translate(a.pad, a.pad);
      // 中二模式 puts everyone on their feet: a pool of shade holds them to the ground.
      if (this.layer) {
        // Wider than the body, so the pool shows at the sides and in front of the feet.
        ctx.save();
        ctx.translate(a.size / 2, a.size * 0.85);
        ctx.scale(1, 0.34);
        const r = a.size * 0.46;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        g.addColorStop(0, "rgba(6, 4, 12, 0.55)");
        g.addColorStop(0.55, "rgba(6, 4, 12, 0.34)");
        g.addColorStop(1, "rgba(6, 4, 12, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(-r, -r, r * 2, r * 2);
        ctx.restore();
      }
      a.engine.draw(ctx, a.size, a.size);
      if (this.layer?.decorate) this.layer.decorate(a.memberId, ctx, a.size, a.engine, facing);
      a.dirty = false;
      if (!still) moving = true;
    }
    if (this.layer?.frame(dt)) moving = true;
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
