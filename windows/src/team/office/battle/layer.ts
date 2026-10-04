// 中二模式 in the room. The office becomes the battlefield: the boss stands
// where the theme makes room for it, the members leave their desks and line
// up facing it — bigger, rounder, on their feet, holding what their look
// holds — and the work's real moves play out as a fight: each member's skill
// when its task is accepted, a combo when two or three are accepted together,
// a guard and a cleanse when someone is stuck and freed, the seal, the win.
// A skill card names each move as it is made, the way a game does.
//
// All of it is drawn over the office the scene already draws, on the scene's
// own frame loop: nothing runs while the window is hidden, and nothing is
// played that happened while no one was looking. The numbers are never here:
// the HP, the work, the questions are on the page already (skills.ts chooses
// the move; it never changes what a task is worth).

import type { BotEngine } from "../../../mochi/engine";
import { h } from "../../../views/dom";
import { sceneArt, wake, type BossState as Look, type SceneLayer, type Sprite, type TeamScene, type WorldArt } from "../scene";
import { DESIGN, type BattleSignal, type BattleViewModel, type HeroClass } from "./contracts";
import { EffectQueue, type Effect } from "./effects";
import { BOSS_KIT, BOSS_MOVES, BossDirector, resolvesWholeCast, type BossBlockCause, type BossCue, type BossMove, type WorldBossId } from "./bossMoves";
import { drawBossMove, type BossFxPoints } from "./bossFx";
import { WORLDS, type WorldId } from "./worlds";
import { RULES, SKILLS, SkillDirector, type Contribution, type HitPlan, type SkillId } from "./skills";

export const HERO_COLOR: Record<HeroClass, string> = {
  captain: "#5AA8FF",
  mage: "#3EE8A0",
  guardian: "#A98BFF",
  warrior: "#FFAA4A",
  support: "#FF86C8",
};
const GOLD = "#FFD36B";
const PURPLE = "#B58CFF";
const ORANGE = "#FF8A4C";
const GREEN = "#6EE7B7";

/** How much bigger members are drawn in battle than at their desks. */
const HERO_SCALE = 1.15;

export interface LayerHost {
  /** The boss as the work stands now. */
  vm(): BattleViewModel | null;
  hero(memberId: string): HeroClass;
  skill(memberId: string): SkillId;
  name(memberId: string): string;
  taskTitle(taskId: string): string;
  /** The team's members, in their order. */
  members(): string[];
  /** 減少動態: states and small marks, nothing moving. */
  calm(): boolean;
  /** Someone waiting on the person, for a counter that names no one. */
  waiting(): string | null;
  /** Each task an acceptance signal names, for the skills. */
  contributions(s: BattleSignal): Contribution[];
  /** A move was chosen for accepted work (the 戰鬥紀錄 can name it). */
  planned?(plan: HitPlan): void;
  /** On the company map: whether this room plays its fight, or stands still. */
  live?(): boolean;
  /** The team's battlefield (kit v4): a world of its own, or the office. */
  world(): WorldId;
  /** What a boss_counter is really about: the cause the record states, else unknown. */
  causeOf?(s: BattleSignal): BossBlockCause;
  /** The team's turns this run: 我方 HP is what is left of them. */
  turns?(): { used: number; max: number } | null;
  /** A member past its own limits: down until the person raises them. */
  fallen?(memberId: string): boolean;
}

/** One boss move playing or about to: its clock, its sources, what it has set off. */
interface ActiveCue {
  cue: BossCue;
  move: BossMove;
  signal: BattleSignal;
  startedAt: number;
  fired: Set<string>;
  sparks: number;
}

type Pt = { x: number; y: number };

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
  kind: "glow" | "streak" | "chip" | "plus";
  /** Drawn towards this point (new life flowing into the boss), else flying free. */
  to?: Pt;
  gravity?: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (p: Pt, q: Pt, t: number): Pt => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeIn = (t: number) => Math.pow(clamp01(t), 2);
/** How far into [from, to] ms an effect is, 0–1. */
const span = (ms: number, from: number, to: number) => clamp01((ms - from) / Math.max(1, to - from));
const bell = (t: number) => Math.sin(Math.PI * clamp01(t));

const images = new Map<string, HTMLImageElement>();
function image(file: string, onload?: () => void): HTMLImageElement | null {
  let im = images.get(file);
  if (!im) {
    im = new Image();
    im.src = `/office/${file}`;
    if (onload) im.addEventListener("load", onload, { once: true });
    images.set(file, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}

/** A soft round light of a colour, drawn once and reused for every glow and spark. */
const sprites = new Map<string, HTMLCanvasElement>();
function lightOf(color: string): HTMLCanvasElement {
  let c = sprites.get(color);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d")!;
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.18, color);
    g.addColorStop(0.5, color + "66");
    g.addColorStop(1, color + "00");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    sprites.set(color, c);
  }
  return c;
}

/** What each look holds, where, around a body centred at (cx, cy) of half-size rx × ry. */
function holdings(hero: HeroClass, cx: number, cy: number, rx: number, ry: number, top: number, dir: number, ox = 0, tilt = 0) {
  type Hold = { name: string; x: number; y: number; k: number; flip?: boolean; turn?: number; casts?: boolean; hand?: Pt };
  const out: Hold[] = [];
  switch (hero) {
    case "mage":
      out.push({ name: "staff", x: cx + dir * (rx + 6), y: cy + ry * 1.0, k: 0.82, turn: dir * 0.12, casts: true, hand: { x: cx + dir * (rx + 2), y: cy + ry * 0.25 } });
      out.push({ name: "hat", x: cx + ox * 2, y: top + 9, k: 0.74, turn: tilt });
      break;
    case "warrior":
      out.push({ name: "sword", x: cx + dir * (rx + 4), y: cy + ry * 0.5, k: 0.92, flip: dir < 0, turn: dir * 0.75, casts: true, hand: { x: cx + dir * (rx - 2), y: cy + ry * 0.38 } });
      break;
    case "guardian":
      out.push({ name: "shield", x: cx + dir * rx * 0.9, y: cy + ry * 1.1, k: 0.78, flip: dir < 0, casts: true, hand: { x: cx + dir * rx * 0.7, y: cy + ry * 0.35 } });
      break;
    case "captain":
      out.push({ name: "flag", x: cx - dir * (rx + 3), y: cy + ry * 1.0, k: 0.86, flip: dir < 0, casts: true, hand: { x: cx - dir * (rx - 1), y: cy + ry * 0.3 } });
      break;
    case "support":
      out.push({ name: "orb", x: cx + dir * (rx + 14), y: cy - ry * 0.1, k: 0.82, casts: true });
      break;
  }
  return out;
}

/** The front line first: who stands nearest the boss. */
const LINE: Record<HeroClass, number> = { guardian: 0, warrior: 1, captain: 2, support: 3, mage: 4 };

/** Each move's card: its sign, its family's word and colours. */
const CARD: Record<SkillId | "victory" | "neutral", { icon: string; word: string; tone: string }> = {
  fire_ember: { icon: "flame", word: "火", tone: "fire" },
  ice_lance: { icon: "snow", word: "冰", tone: "ice" },
  wind_crescent: { icon: "wind", word: "風", tone: "wind" },
  lightning_chain: { icon: "bolt", word: "雷", tone: "bolt" },
  blade_crescent: { icon: "moon", word: "", tone: "blade" },
  blade_pierce: { icon: "arrow", word: "", tone: "blade" },
  blade_counter: { icon: "shield", word: "", tone: "blade" },
  blade_heavy: { icon: "star", word: "", tone: "blade" },
  support_ward: { icon: "shield", word: "支援", tone: "ward" },
  support_cleanse: { icon: "heart", word: "支援", tone: "heal" },
  support_seal: { icon: "seal", word: "支援", tone: "seal" },
  combo_fire_wind: { icon: "combo", word: "合體技", tone: "combo" },
  combo_ice_lightning: { icon: "combo", word: "合體技", tone: "combo" },
  combo_ward_blade: { icon: "combo", word: "合體技", tone: "combo" },
  combo_trinity: { icon: "trinity", word: "合體技", tone: "combo" },
  victory: { icon: "crown", word: "", tone: "win" },
  neutral: { icon: "star", word: "", tone: "blade" },
};
const ICON: Record<string, string> = {
  flame: '<path d="M12 22c4.4 0 7-2.9 7-6.6 0-3.4-2.1-5.6-3.6-7.6-.4 1.9-1.4 3-2.4 3.4.4-3.4-1.2-6.7-4-9.2-.2 3.7-2.2 6-3.6 8C4.3 11.6 5 13.4 5 15.4 5 19.1 7.6 22 12 22Z"/><path d="M12 22c-1.8 0-3-1.3-3-3 0-1.9 1.6-3 2.1-4.6 1.2 1 3.9 2.4 3.9 4.7 0 1.7-1.2 2.9-3 2.9Z"/>',
  snow: '<path d="M12 2v20M3.3 7l17.4 10M20.7 7 3.3 17M9 4l3 2 3-2M9 20l3-2 3 2M4 10.5l3.4.3L8.7 8M20 13.5l-3.4-.3-1.3 2.8M4 13.5l3.4-.3 1.3 2.8M20 10.5l-3.4.3L15.3 8"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>',
  arrow: '<path d="M4 20 20 4M20 4h-7M20 4v7"/>',
  shield: '<path d="M12 3 20 6v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6Z"/>',
  star: '<path d="M12 2v14M8 12l4 4 4-4M5 21h14M7 18l-2-3M17 18l2-3"/>',
  heart: '<path d="M12 21s-8-4.8-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.2-8 11-8 11Z"/><path d="M12 9v6M9 12h6"/>',
  seal: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v4.5M12 16.5V21M3 12h4.5M16.5 12H21"/>',
  combo: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
  trinity: '<circle cx="12" cy="8" r="5"/><circle cx="8" cy="15" r="5"/><circle cx="16" cy="15" r="5"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5Z"/>',
};

/** What the boss says, now and then. */
const SAYS: Partial<Record<BattleSignal["kind"], string[]>> = {
  scope_added: ["還不夠…還要更多!", "需求,再來一點!"],
  review_returned: ["哼,重做吧!"],
  boss_counter: ["給我停下!", "卡住了吧!"],
  seal_wait: ["被…封住了…?"],
  victory: ["我…還會回來的…"],
  reopen: ["需求…又來了!"],
};

export class BattleLayer implements SceneLayer {
  readonly pad: number;
  /** Members drawn bigger in battle — less so when many share the floor. */
  get heroScale(): number {
    const n = this.host.members().length;
    return HERO_SCALE * (n > 6 ? 0.83 : n > 4 ? 0.92 : 1);
  }
  private boss: HTMLImageElement | null = null;
  private shadow: HTMLElement | null = null;
  /** The world's standing weather: a still light layer behind the fight. */
  private ambient: HTMLElement | null = null;
  /** When the boss next lashes out on its own — a show of temper, no damage. */
  private idleAt = 0;
  /** Turns seen last update, recent burns, and when the last pressure ultimate played. */
  private turnSeen = -1;
  private turnBurn: { at: number; n: number }[] = [];
  private turnUltAt = 0;
  private fx: HTMLCanvasElement | null = null;
  private card: HTMLElement | null = null;
  private cardTimer = 0;
  private speech: HTMLElement | null = null;
  private fxDrawn = false;
  private look: Look | null = null;
  private bossArt: import("../scene").BossArt | null = null;
  private vm: BattleViewModel | null = null;
  /** A moment held still (only to look at one move, in development); else the clock. */
  private frozen: number | null = null;
  private now = () => this.frozen ?? performance.now();
  private queue = new EffectQueue(() => this.now());
  private director = new SkillDirector(() => this.now());
  /** The boss's own moves: chosen from real causes, at most one on stage. */
  private bossDirector = new BossDirector(() => this.now());
  private bossCue: ActiveCue | null = null;
  /** The acceptance signals waiting for their moves, by id. */
  private accepted = new Map<string, BattleSignal>();
  private collectTimer = 0;
  private particles: Particle[] = [];
  private floats = new Set<HTMLElement>();
  /** What each playing effect has already set off (sparks, a number), so it happens once. */
  private fired = new WeakMap<Effect, Set<string>>();
  private spawned = new WeakMap<Effect, number>();
  private hidden: HTMLElement[] = [];
  private t = 0;
  private hurtAt = -1e9;
  private lastSaid = -1e9;

  constructor(private scene: TeamScene, private host: LayerHost) {
    this.pad = scene.mini ? 40 : 56;
  }

  /** The battlefield this room becomes: a world of the kit, when its art is here. */
  arena(): { id: string; art: WorldArt } | null {
    const id = this.host.world();
    if (id === "office") return null;
    const art = sceneArt()?.battle?.worlds?.[id];
    return art ? { id, art } : null;
  }

  /** The world on screen, office included. */
  get worldId(): WorldId {
    return this.arena()?.id as WorldId ?? "office";
  }

  /** A room of the company map with its fight turned off: the boss and the line-up, nothing moving. */
  private get still(): boolean {
    return this.scene.mini && !this.host.live?.();
  }

  // ── The battlefield ───────────────────────────────────────────────────────

  build() {
    const theme = this.scene.roomTheme;
    const art = sceneArt()?.battle;
    this.removeElements();
    if (!theme?.battle || !art) return;
    const stage = this.scene.stageEl;
    // What makes way for the fight: the meeting table, the lounge.
    for (const prop of theme.battle.hide) {
      const el = stage.querySelector<HTMLElement>(`[data-prop="${prop}"]`);
      if (el) {
        el.style.visibility = "hidden";
        this.hidden.push(el);
      }
    }
    const world = this.arena();
    const b = world ? world.art.boss : art.boss;
    const s = theme.battle.scale;
    const [ax, ay] = theme.battle.boss;
    const at = this.scene.screen(ax, ay);
    const z = this.scene.depthOf(ax, ay) + 6;
    const w = 340 * s;
    if (this.worldId !== "office") {
      const amb = this.scene.cropBox;
      this.ambient = h("div", { class: `bt-ambient amb-${this.worldId}`, "aria-hidden": "true", style: `left:${amb.x}px;top:${amb.y}px;width:${amb.w}px;height:${amb.h}px;z-index:1` });
      stage.append(this.ambient);
    }
    this.idleAt = 0;
    this.shadow = h("div", { class: "bt-boss-shadow", style: `left:${at.x - w / 2}px;top:${at.y - w * 0.17}px;width:${w}px;height:${w * 0.34}px;z-index:${z - 1}` });
    // Every state shares one canvas and one pivot: a change of state is a change of picture, nothing moves.
    const [gx, gy] = b.groundPivot.map((n) => (n / 2) * s);
    this.boss = h("img", {
      class: "bt-golem", alt: "", draggable: "false",
      style: `left:${at.x - gx}px;top:${at.y - gy}px;width:${(b.canvas[0] / 2) * s}px;height:${(b.canvas[1] / 2) * s}px;z-index:${z};transform-origin:${gx}px ${gy}px`,
    }) as HTMLImageElement;
    for (const st of Object.values(b.states)) image(st.file);
    this.bossArt = b;
    stage.append(this.shadow, this.boss);
    {
      const c = this.scene.cropBox;
      this.fx = h("canvas", { class: "bt-fx", "aria-hidden": "true", style: `left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px` }) as HTMLCanvasElement;
      stage.append(this.fx);
    }
    this.look = null;
    this.update();
  }

  /** Members' places facing the boss: the front line first, the casters behind. */
  formation(memberId: string) {
    const theme = this.scene.roomTheme;
    if (!theme?.battle) return null;
    const ids = this.host.members();
    if (!ids.includes(memberId)) ids.push(memberId);
    // A line for a few, rows for more.
    const sets = Object.entries(theme.battle.formation).map(([n, list]) => ({ n: Number(n), list })).sort((p, q) => p.n - q.n);
    const slots = (sets.find((x) => x.n >= ids.length) ?? sets[sets.length - 1])?.list;
    if (!slots?.length) return null;
    const rank = ids
      .map((id, i) => ({ id, i, line: LINE[this.host.hero(id)] }))
      .sort((p, q) => p.line - q.line || p.i - q.i)
      .findIndex((p) => p.id === memberId);
    const slot = slots[rank];
    if (!slot) return null;
    const me = this.scene.screen(slot[0], slot[1]);
    const boss = this.scene.screen(...theme.battle.boss);
    return { x: slot[0], y: slot[1], yaw: boss.x >= me.x ? 0.42 : -0.42 };
  }

  update() {
    const vm = this.host.vm();
    // Another run is another boss, and another session of moves.
    if (this.vm && vm && vm.runId !== this.vm.runId) this.stop();
    if (vm) this.director.setScope(vm.teamId, vm.runId);
    // Paused, syncing or not adding up: nothing goes on playing.
    if (vm && (vm.bossState === "paused" || vm.bossState === "syncing" || vm.bossState === "inconsistent" || vm.bossState === "stopped")) this.stop();
    this.vm = vm;
    if (!this.boss) return;
    // The few desks the fight leaves in the room (the scene draws them afresh with every update).
    for (const [x, y] of this.scene.roomTheme?.battle?.desks ?? []) this.scene.drawDesk({ x, y, facing: "SE" }, "#2E3A52");
    const state = vm?.bossState ?? "planning";
    // 回合就是我方的血: burned fast, the boss smells it and raises its ultimate.
    const t = this.host.turns?.() ?? null;
    // A snapshot without the counters (the demo stream has some) keeps the last seen value.
    if (t) {
      if (this.turnSeen >= 0 && t.used > this.turnSeen && !this.scene.mini) this.turnBurn.push({ at: Date.now(), n: t.used - this.turnSeen });
      if (this.turnSeen < 0 || t.used >= this.turnSeen || t.used < this.turnSeen - 1) this.turnSeen = t.used;
    }
    const cut = Date.now() - 75000;
    this.turnBurn = this.turnBurn.filter((x) => x.at >= cut);
    const burned = this.turnBurn.reduce((n, x) => n + x.n, 0);
    if (burned >= 4 && Date.now() - this.turnUltAt > 90000 && state === "engaged" && !this.bossCue && !this.scene.mini && !this.still && !this.host.calm() && !document.hidden && this.scene.el.isConnected) {
      this.turnUltAt = Date.now();
      this.turnBurn = [];
      this.turnPressure(burned);
    }
    // No task counted yet: the boss has not shown itself.
    const shown = !!vm && state !== "planning";
    this.boss.style.display = this.shadow!.style.display = shown ? "" : "none";
    this.boss.className = `bt-golem ${state}${vm?.phase ? ` ${vm.phase}` : ""}`;
    this.ambient?.classList.toggle("amb-seal", state === "sealing");
    this.ambient?.classList.toggle("amb-calm", state === "defeated");
    if (state !== "syncing") this.setLook(this.baseLook());
  }

  /** The boss's picture as the work stands, before any move plays. */
  private baseLook(): Look {
    const vm = this.vm;
    if (vm?.bossState === "defeated") return "defeated";
    if (vm?.bossState === "sealing") return "sealed";
    if (vm?.bossState === "engaged" && (vm.phase === "rage" || vm.phase === "last_seal")) return "rage";
    return "idle";
  }

  private setLook(v: Look) {
    if (this.look === v || !this.boss) return;
    // A boss without that picture shows the nearest it has (the worlds have no rage of their own).
    const states = this.bossArt?.states;
    if (!states) return;
    const pick = (states[v] ? v : v === "rage" ? (states.attack ? "attack" : "idle") : "idle") as Look;
    const st = states[pick];
    if (!st || this.look === pick) return;
    this.look = pick;
    this.boss.src = `/office/${st.file}`;
  }

  /** The boss's points in stage pixels: its feet, crystal core, where blows land, its head, its raised fist. */
  private bossPoints() {
    const theme = this.scene.roomTheme;
    const b = this.bossArt ?? sceneArt()?.battle?.boss;
    if (!theme?.battle || !b) return null;
    const s = theme.battle.scale;
    const at = this.scene.screen(...theme.battle.boss);
    const st = b.states[this.look ?? "idle"];
    const pt = (q: unknown): Pt => {
      const v = q as [number, number] | undefined;
      return v && typeof v[0] === "number" ? { x: at.x + ((v[0] - b.groundPivot[0]) / 2) * s, y: at.y + ((v[1] - b.groundPivot[1]) / 2) * s } : at;
    };
    return {
      feet: at, core: pt(st.coreCenter), hit: pt(st.hitTarget), top: pt(st.top),
      fist: pt(st.fist ?? st.counterOrigin), scale: s,
      anchor: (name: string): Pt => pt(st[name] ?? st.counterOrigin ?? st.coreCenter),
    };
  }

  detach() {
    this.stop();
    this.removeElements();
  }

  private removeElements() {
    for (const el of this.hidden) el.style.visibility = "";
    this.hidden = [];
    for (const el of [this.boss, this.shadow, this.ambient, this.fx, this.card, this.speech]) el?.remove();
    this.boss = this.shadow = this.card = this.speech = null;
    this.ambient = null;
    this.fx = null;
    this.look = null;
  }

  /** Everything playing or waiting is let go: hidden, another run, paused, the mode turned off. What was shown stays shown. */
  stop() {
    this.queue.clear();
    this.director.cancel();
    this.bossCue = null;
    this.accepted.clear();
    window.clearTimeout(this.collectTimer);
    this.collectTimer = 0;
    this.particles = [];
    for (const el of this.floats) el.remove();
    this.floats.clear();
    this.card?.remove();
    this.card = null;
    this.speech?.remove();
    this.speech = null;
    this.clearFx();
    if (this.boss) this.boss.style.transform = this.boss.style.filter = "";
    this.setLook(this.baseLook());
  }

  // ── Signals ───────────────────────────────────────────────────────────────

  /** A signal seen live: played if this office is on screen, else let go. */
  play(s: BattleSignal) {
    if (this.still || !this.boss || !this.scene.el.isConnected || document.hidden) return;
    if (s.kind === "acceptance_hit") {
      // Accepted work waits a moment for others' to come with it: a combo, or each its own move.
      this.accepted.set(s.signalId, s);
      if (!this.director.collecting) this.collectTimer = window.setTimeout(() => this.collect(), RULES.collectMs + 5);
      this.director.offer(this.host.contributions(s));
      return;
    }
    if (this.host.calm()) {
      // 減少動態: a small still mark of what changed, no movement — the move is its name.
      const cue = this.chooseCue(s, true);
      const label = this.label(s.kind, s);
      if (cue) this.float({ text: BOSS_MOVES[cue.moveId].name, sub: label?.text ?? s.reasonLabel, tone: "counter" }, this.anchorFor(s), true);
      else if (label) this.float(label, this.anchorFor(s), true);
      return;
    }
    if (s.kind === "reopen") this.stop();
    // In a world, the boss answers these itself, each with a move of its own.
    if (this.worldId !== "office") {
      if (s.kind === "unblock_support") {
        // A real unblock: a cast not yet begun is called off — only when all its sources are resolved.
        const freed = s.source.taskIds;
        if (this.bossCue && this.now() - this.bossCue.startedAt < this.bossCue.move.phases[0] && resolvesWholeCast(this.bossCue.cue.sourceTaskIds, freed)) this.bossCue = null;
      } else if (s.kind === "boss_counter" || s.kind === "member_interrupted" || s.kind === "review_returned" || s.kind === "delivery_waiting" || s.kind === "scope_added") {
        const cue = this.chooseCue(s, false);
        if (cue) this.startCue(cue, s);
        // The mark still floats (the +HP, the 待驗收), move or no move.
        const label = this.label(s.kind, s);
        if (label && s.kind !== "boss_counter") this.float(label, this.anchorFor(s));
        wake();
        return;
      }
    }
    this.queue.push(s);
    wake();
  }

  /** The kit's selection, from this signal's real sources. */
  private chooseCue(s: BattleSignal, dry: boolean): BossCue | null {
    const world = WORLDS[this.worldId];
    if (!world || world.bossId === "requirements-golem") return null;
    const vm = this.vm;
    if (!vm) return null;
    const kind = s.kind === "member_interrupted" ? "boss_counter" : s.kind;
    const cause: BossBlockCause = s.kind === "member_interrupted" ? "tool_error" : this.host.causeOf?.(s) ?? "unknown";
    const blocked = s.kind === "boss_counter" ? (s.source.taskIds.length ? s.source.taskIds : s.source.questionIds) : s.kind === "member_interrupted" ? s.source.memberIds : [];
    const ctx = {
      bossId: world.bossId as WorldBossId,
      signalKind: kind,
      sourceSignalIds: [s.signalId],
      evidence: s.evidence,
      cause,
      newlyBlockedTaskIds: blocked,
      addedCountedUncompletedTaskIds: s.kind === "scope_added" ? s.source.taskIds : [],
      scopeGrowthContributionHp: s.kind === "scope_added" ? s.displayDelta ?? 0 : 0,
      bossStateAfterApply: vm.bossState,
      live: !s.replay,
      visible: this.scene.el.isConnected && !document.hidden,
      modeEnabled: true,
      history: vm.isHistory,
      syncing: false,
      paused: false,
      reducedMotion: this.host.calm(),
    };
    this.bossDirector.setRun(vm.runId);
    if (dry) {
      // 減少動態: the choice still counts (and is consumed), the move is words only.
      const cue = this.bossDirector.choose(ctx);
      return cue;
    }
    return this.bossDirector.choose(ctx);
  }

  /** One boss move on stage at a time; a second waits its turn in the same queue of moments. */
  private startCue(cue: BossCue, s: BattleSignal) {
    const move = BOSS_MOVES[cue.moveId];
    this.bossCue = { cue, move, signal: s, startedAt: this.now(), fired: new Set(), sparks: 0 };
    const world = WORLDS[this.worldId];
    const kindWord = { attack: "", ultimate: "絕招・", guard: "防守・", regen: "回血・" }[cue.kind];
    const damage = cue.kind === "regen" && cue.scopeGrowthLabelHp ? `+${cue.scopeGrowthLabelHp} HP` : null;
    this.showBossCard(move, `${kindWord}${move.name}`, `${world.bossName} · ${s.reasonLabel} · 0 傷害${cue.kind === "regen" ? "" : " · 工作照常"}`, damage);
    this.say(s.kind);
  }

  /** An unprovoked lash: one of this boss's light attacks at a random member, nothing real behind it. */
  private idleMenace(now: number) {
    this.idleAt = now + 16000 + Math.random() * 18000;
    const world = WORLDS[this.worldId];
    const kit = BOSS_KIT[world.bossId as WorldBossId];
    const vm = this.vm;
    if (!kit || !vm) return;
    const pick = Math.random();
    const moveId = pick < 0.78 ? kit.attacks[Math.floor(Math.random() * 3)] : kit.guard;
    const move = BOSS_MOVES[moveId];
    const members = this.host.members();
    const at = members[Math.floor(Math.random() * members.length)];
    const signal: BattleSignal = {
      teamId: vm.teamId, runId: vm.runId, signalId: `idle|${now}`, kind: "boss_counter",
      source: { teamId: vm.teamId, runId: vm.runId, kind: "manual_replay", streamId: null, domainSeq: null, taskIds: [], memberIds: at ? [at] : [], questionIds: [] },
      reasonLabel: "", hpBefore: null, hpAfter: null, maxHpBefore: null, maxHpAfter: null, displayDelta: null,
      actorMemberId: null, observedAt: new Date().toISOString(), evidence: "observed_transition", replay: true,
    };
    const cue: BossCue = { moveId, kind: move.kind, consumedSourceSignalIds: [], sourceTaskIds: [], heroHpDelta: 0, extraBossDamage: 0, scopeGrowthLabelHp: 0, durationMs: move.phases[2], animated: true };
    // Straight onto the stage: no card, no speech, no record — the fight just breathes.
    this.bossCue = { cue, move, signal, startedAt: now, fired: new Set(), sparks: 0 };
    wake();
  }

  /** Turns burned in a hurry: the boss raises its ultimate over it — loud, but still 0 damage. */
  private turnPressure(burned: number) {
    const world = WORLDS[this.worldId];
    const kit = world.bossId === "requirements-golem" ? null : BOSS_KIT[world.bossId as WorldBossId];
    const vm = this.vm;
    if (!kit || !vm || !this.boss) return;
    const move = BOSS_MOVES[kit.ultimate];
    const members = this.host.members();
    const signal: BattleSignal = {
      teamId: vm.teamId, runId: vm.runId, signalId: `turns|${Date.now()}`, kind: "boss_counter",
      source: { teamId: vm.teamId, runId: vm.runId, kind: "manual_replay", streamId: null, domainSeq: null, taskIds: [], memberIds: members.slice(0, 3), questionIds: [] },
      reasonLabel: "回合快速消耗", hpBefore: null, hpAfter: null, maxHpBefore: null, maxHpAfter: null, displayDelta: null,
      actorMemberId: null, observedAt: new Date().toISOString(), evidence: "observed_transition", replay: true,
    };
    const cue: BossCue = { moveId: move.moveId, kind: move.kind, consumedSourceSignalIds: [], sourceTaskIds: [], heroHpDelta: 0, extraBossDamage: 0, scopeGrowthLabelHp: 0, durationMs: move.phases[2], animated: true };
    this.bossCue = { cue, move, signal, startedAt: this.now(), fired: new Set(), sparks: 0 };
    this.showBossCard(move, `絕招・${move.name}`, `${world.bossName} · 短時間消耗 ${burned} 回合 · 0 傷害 · 工作照常`, null);
    this.float({ text: `-${burned} 回合`, sub: "我方 HP", tone: "hit" }, { ...this.scene.screen(3.6, 3.2) });
    this.say("boss_counter");
    wake();
  }

  /** A member past its limits goes down where it stands. */
  memberDown(memberId: string, why: string) {
    const m = this.scene.mochi(memberId);
    if (!m || this.still) return;
    this.float({ text: "陣亡", sub: `${this.host.name(memberId)} · ${why}`, tone: "hit" }, { x: m.x, y: m.y - m.size * 0.9 });
    this.spark(null, m.x, m.y + m.size * 0.2, 8, "#8A93A8", { speed: 60, up: 90, size: 2.6 });
    wake();
  }

  /** The person raised the limit: back on its feet. */
  memberUp(memberId: string) {
    const m = this.scene.mochi(memberId);
    if (!m || this.still) return;
    this.float({ text: "復活!", sub: this.host.name(memberId), tone: "heal" }, { x: m.x, y: m.y - m.size * 0.9 });
    this.spark(null, m.x, m.y + m.size * 0.2, 10, "#8DE9C5", { speed: 50, up: 130, kind: "plus", size: 3 });
    wake();
  }

  /** 陣亡 for the scene: the fallen stay grey until revived. */
  fallen(memberId: string): boolean {
    return this.host.fallen?.(memberId) ?? false;
  }

  /** A boss move's card: the world's own colours. */
  private showBossCard(move: BossMove, title: string, sub: string, damage: string | null) {
    window.clearTimeout(this.cardTimer);
    this.card?.remove();
    const el = h(
      "div",
      { class: `bt-card c-boss${this.frozen !== null ? " still" : ""}`, role: "status", style: `--c1:${move.palette[1]};--c2:${move.palette[0]}` },
      h("span", { class: "bt-card-icon", "aria-hidden": "true", html: `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON.combo}</svg>` }),
      h("span", { class: "bt-card-text" }, h("b", {}, h("span", { class: "bt-card-word", text: "魔王・" }), title), h("small", { text: sub })),
      damage ? h("em", { class: "heal", text: damage }) : null,
    );
    this.scene.overlayEl.append(el);
    this.card = el;
    if (this.frozen === null) this.cardTimer = window.setTimeout(() => {
      el.remove();
      if (this.card === el) this.card = null;
    }, 1900);
  }

  /**
   * Development only: one boss move held at `ms` (team.html?…&bpose=moveId:ms).
   * The signal is made up for the picture; nothing of the work is touched.
   */
  poseBossMove(moveId: string, ms: number, s: BattleSignal) {
    const move = BOSS_MOVES[moveId];
    if (!move) return;
    this.stop();
    this.frozen = 0;
    const cue: BossCue = { moveId, kind: move.kind, consumedSourceSignalIds: [s.signalId], sourceTaskIds: [...s.source.taskIds], heroHpDelta: 0, extraBossDamage: 0, scopeGrowthLabelHp: move.kind === "regen" ? 200 : 0, durationMs: move.phases[2], animated: true };
    this.startCue(cue, s);
    this.bossCue!.startedAt = 0;
    this.frozen = ms;
    wake();
  }

  private collect() {
    this.collectTimer = 0;
    if (!this.scene.el.isConnected || document.hidden) return this.stop();
    const calm = this.host.calm();
    const result = this.director.take({ animate: true, reducedMotion: calm }, true);
    if (!result) return;
    for (const plan of result.plans) {
      this.host.planned?.(plan);
      const signal = this.accepted.get(plan.sourceSignalIds[0]);
      if (!signal) continue;
      const name = plan.skillId ? SKILLS[plan.skillId].name : "驗收命中";
      if (plan.kind === "text_only" && (calm || plan.memberIds.length)) {
        // Still: the number and the move's name, where the blow would land.
        const b = this.bossPoints();
        if (b) this.float({ text: `-${plan.displayDamage}`, sub: name, tone: "hit" }, { x: b.top.x, y: b.top.y - 10 }, true);
        continue;
      }
      this.queue.pushPlan(signal, plan);
    }
    this.accepted.clear();
    wake();
  }

  /**
   * Development only: one move held at `ms` into it, to look at (team.html?…&pose=skill:ms).
   * Nothing of the work is touched; the signal or plan is made up for the picture.
   */
  pose(signal: BattleSignal, plan: HitPlan | null, ms: number) {
    this.stop();
    this.frozen = 0;
    if (plan) this.queue.pushPlan(signal, plan);
    else this.queue.push(signal);
    this.queue.tick();
    this.frozen = ms;
    wake();
  }

  /** The win again, on request: a replay, never a second completion. */
  replay() {
    const vm = this.vm;
    if (!vm || vm.bossState !== "defeated") return;
    this.play({
      teamId: vm.teamId, runId: vm.runId, signalId: `${vm.runId}|victory|replay@${Date.now()}`, kind: "victory",
      source: { teamId: vm.teamId, runId: vm.runId, kind: "manual_replay", streamId: null, domainSeq: null, taskIds: [], memberIds: [], questionIds: [] },
      reasonLabel: "重播", hpBefore: 0, hpAfter: 0, maxHpBefore: vm.maxHp, maxHpAfter: vm.maxHp, displayDelta: null, actorMemberId: null,
      observedAt: new Date().toISOString(), evidence: "observed_transition", replay: true,
    });
  }

  private label(kind: BattleSignal["kind"], s: BattleSignal): { text: string; sub?: string; tone: string } | null {
    switch (kind) {
      case "scope_added": return { text: `+${s.displayDelta ?? 100} HP`, sub: "需求增加", tone: "regen" };
      case "delivery_waiting": return { text: "待驗收", tone: "shield" };
      case "review_returned": return { text: s.evidence === "explicit_event" ? "需要修改" : "返回執行", tone: "counter" };
      case "boss_counter": return { text: !s.source.taskIds.length ? "等你決定" : "受阻", sub: "守望結界", tone: "counter" };
      case "unblock_support": return { text: "解除", sub: "回復清輝", tone: "heal" };
      case "member_interrupted": return { text: "中斷", tone: "counter" };
      case "seal_wait": return { text: "封印", sub: "共鳴封印", tone: "seal" };
      case "victory": return { text: "討伐成功!", tone: "win" };
      case "reopen": return { text: "新指示", tone: "seal" };
      case "scope_adjusted": return { text: "範圍調整", tone: "quiet" };
      case "pause": return { text: "戰場冰封", tone: "quiet" };
      default: return null;
    }
  }

  /** Where a signal's mark goes: over the member it is about, else over the boss. */
  private anchorFor(s: BattleSignal): Pt {
    const b = this.bossPoints();
    const head = b ? { x: b.top.x, y: b.top.y - 10 } : { x: 0, y: 0 };
    const aboutMember = s.kind === "boss_counter" || s.kind === "unblock_support" || s.kind === "member_interrupted" || s.kind === "review_returned" || s.kind === "task_started";
    const id = s.actorMemberId ?? s.source.memberIds[0] ?? (s.kind === "boss_counter" ? this.host.waiting() : null);
    const m = aboutMember && id ? this.scene.mochi(id) : null;
    // Above the member's name, never over it.
    return m ? { x: m.x, y: m.y - 130 } : head;
  }

  private float(label: { text: string; sub?: string; tone: string }, at: Pt, still = false) {
    // At most two numbers at once: the rest are in the 戰鬥紀錄.
    if (label.tone === "hit" && [...this.floats].filter((f) => f.classList.contains("t-hit")).length >= RULES.maxHitLabels) return;
    const el = h("span", { class: `bt-float ${label.tone.split(" ").map((t) => `t-${t}`).join(" ")}${still || this.frozen !== null ? " still" : ""}` }, h("b", { text: label.text }), label.sub ? h("small", { text: label.sub }) : null);
    this.floats.add(el);
    this.scene.pinAt(el, at.x, at.y);
    if (this.frozen === null) window.setTimeout(() => {
      el.remove();
      this.floats.delete(el);
    }, still ? 2600 : 1600);
  }

  /** A move's card, the way a game names a skill: its sign, its name, who, the blow. */
  private showCard(kind: keyof typeof CARD, title: string, sub: string, damage: string | null) {
    const c = CARD[kind];
    window.clearTimeout(this.cardTimer);
    this.card?.remove();
    const el = h(
      "div",
      { class: `bt-card c-${c.tone}${this.frozen !== null ? " still" : ""}`, role: "status" },
      h("span", { class: "bt-card-icon", "aria-hidden": "true", html: `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[c.icon]}</svg>` }),
      h("span", { class: "bt-card-text" }, h("b", {}, c.word ? h("span", { class: "bt-card-word", text: `${c.word}・` }) : null, title), h("small", { text: sub })),
      damage ? h("em", { text: damage }) : null,
    );
    this.scene.overlayEl.append(el);
    this.card = el;
    // Held still (development): the card stays to be looked at.
    if (this.frozen === null) this.cardTimer = window.setTimeout(() => {
      el.remove();
      if (this.card === el) this.card = null;
    }, 1900);
  }

  /** The boss says something, now and then — never more than one line every few seconds. */
  private say(kind: BattleSignal["kind"]) {
    const lines = SAYS[kind];
    const b = this.bossPoints();
    if (!lines || !b || this.now() - this.lastSaid < 2500) return;
    this.lastSaid = this.now();
    this.speech?.remove();
    const el = h("span", { class: `bt-speech${this.frozen !== null ? " still" : ""}` }, h("b", { text: "需求魔王" }), h("span", { text: lines[Math.floor(Math.random() * lines.length)] }));
    this.scene.pinAt(el, b.top.x, b.top.y - 34);
    this.speech = el;
    if (this.frozen === null) window.setTimeout(() => {
      el.remove();
      if (this.speech === el) this.speech = null;
    }, 2200);
  }

  // ── Frames ────────────────────────────────────────────────────────────────

  frame(dt: number): boolean {
    const now = this.now();
    if (this.still || !this.boss) {
      if (this.queue.busy || this.particles.length) this.stop();
      return false;
    }
    if (this.host.calm()) {
      if (this.queue.busy || this.particles.length || this.bossCue) this.stop();
      return false;
    }
    this.t += dt;
    const active = this.queue.tick();
    // The boss's picture follows the moves: guarding a hand-in, flinching at a hit, drinking in new work, striking back.
    let look = this.baseLook();
    let scale = 1;
    let dim = 0;
    for (const e of active) {
      const ms = now - e.startedAt!;
      if (e.kind === "delivery_waiting" || e.kind === "review_returned") look = "guard";
      if (e.kind === "scope_added" && ms > 250) look = "regen";
      if (e.kind === "boss_counter" && ms < 520) look = "attack";
      if (e.kind === "victory") {
        // The Leader's blow lands at 700: only then does the boss fall.
        dim = span(ms, 700, 1200);
        scale = 1 - 0.08 * ease(span(ms, 750, 1350));
        if (ms >= 700 && ms < 860) look = "hurt";
        else if (ms >= 860) look = "defeated";
      }
    }
    // The boss's own move on stage: its pose while it casts.
    if (this.bossCue) {
      const ms = now - this.bossCue.startedAt;
      if (ms >= this.bossCue.move.phases[2]) this.bossCue = null;
      else if (look !== "defeated") {
        const kind = this.bossCue.cue.kind;
        look = kind === "guard" ? "guard" : kind === "regen" ? "regen" : ms < this.bossCue.move.phases[1] ? "attack" : look;
      }
    }
    // 平常也要出招: with nothing on, the boss still lashes out now and then —
    // pure temper, no damage, no card, and never while real moves play.
    if (!this.bossCue && !active.length && this.frozen === null && !this.scene.mini && this.worldId !== "office" && this.vm?.bossState === "engaged") {
      if (!this.idleAt) this.idleAt = now + 9000 + Math.random() * 9000;
      else if (now >= this.idleAt) this.idleMenace(now);
    }
    const hurt = Math.max(0, 1 - (now - this.hurtAt) / 260);
    if (hurt > 0.15 && look !== "defeated") look = "hurt";
    this.setLook(look);
    const breathe = this.vm?.bossState === "engaged" ? Math.sin(this.t * 2) * 3 : 0;
    this.boss.style.transform = `translate(${hurt ? Math.sin(now / 16) * 5 * hurt : 0}px, ${breathe}px) scale(${scale})`;
    this.boss.style.filter = hurt ? `brightness(${1 + 0.6 * hurt}) drop-shadow(0 0 18px rgba(255,255,255,${0.6 * hurt}))` : dim ? `brightness(${1 - 0.4 * dim})` : "";
    this.draw(active, now, dt);
    return true;
  }

  /** The boss cue's frame: anchors, targets and its own small share of sparks. */
  private drawCue(ctx: CanvasRenderingContext2D, b: NonNullable<ReturnType<BattleLayer["bossPoints"]>>, now: number) {
    const ac = this.bossCue;
    if (!ac) return;
    const pts: BossFxPoints = {
      origin: b.anchor(ac.move.sourceAnchor),
      core: b.core,
      feet: b.feet,
      hit: b.hit,
      top: b.top,
      scale: b.scale,
    };
    const targets: Pt[] = [];
    for (const id of ac.signal.source.memberIds.length ? ac.signal.source.memberIds : [this.host.waiting()].filter((m): m is string => !!m)) {
      const m = this.scene.mochi(id);
      if (m) targets.push({ x: m.x, y: m.y + m.size * 0.3 });
    }
    for (const tid of ac.signal.source.taskIds) {
      const owner = this.taskOwner?.(tid);
      const m = owner ? this.scene.mochi(owner) : null;
      if (m) targets.push({ x: m.x, y: m.y + m.size * 0.3 });
    }
    if (!targets.length) targets.push({ ...this.scene.screen(4.35, 4.5) });
    const cueMs = now - ac.startedAt;
    {
      // 環境回應: the rim lights up in the move's colour while it casts.
      const [tele, castEnd] = [ac.move.phases[0], ac.move.phases[1]];
      if (cueMs >= tele && cueMs <= castEnd + 150) {
        const k = bell(span(cueMs, tele, Math.min(castEnd + 150, tele + 650)));
        for (const [wx, wy] of [[6.1, 0.7], [0.7, 6.1]] as const) {
          const p = this.scene.screen(wx, wy);
          glow(ctx, p.x, p.y, 110 * b.scale, ac.move.palette[0], 0.22 * k);
        }
      }
      if (ac.move.kind === "regen") {
        // 需求回流: the field feeds the core — the arena's light runs inward.
        const span2 = this.scene.cropBox.w * 0.46;
        for (let i = 0; i < 6; i++) {
          const t0 = tele + i * 70;
          const k = span(cueMs, t0, t0 + 620);
          if (k <= 0 || k >= 1) continue;
          const ang = (i / 6) * Math.PI * 2 + 0.7;
          const start = { x: b.core.x + Math.cos(ang) * span2, y: b.core.y + Math.sin(ang) * span2 * 0.42 };
          const p = mix(start, b.core, ease(k));
          glow(ctx, p.x, p.y, 26, ac.move.palette[1], 0.55 * (1 - Math.abs(k - 0.5) * 0.7));
        }
      }
    }
    drawBossMove(ctx, {
      move: ac.move,
      ms: cueMs,
      pts,
      targets: targets.slice(0, 3),
      spark: (sx, sy, n, color, opts) => {
        const room = Math.min(n, 24 - ac.sparks);
        if (room <= 0) return;
        ac.sparks += room;
        this.spark(null, sx, sy, room, color, opts);
      },
    });
  }

  /** Who a task of this team belongs to, for aiming a counter (set by the Office). */
  taskOwner: ((taskId: string) => string | null) | null = null;

  /** A member's lunge as it strikes, or its flinch when the boss strikes back. */
  offset(memberId: string): Pt | null {
    const b = this.bossPoints();
    if (!b || this.still) return null;
    const now = this.now();
    for (const e of this.queue.active) {
      const ms = now - (e.startedAt ?? now);
      if (e.plan?.memberIds.includes(memberId) && e.plan.skillId) {
        const [a, c] = SKILLS[e.plan.skillId].phases;
        const m = this.scene.mochi(memberId);
        if (!m) continue;
        const d = Math.hypot(b.hit.x - m.x, b.hit.y - m.y) || 1;
        const k = bell(span(ms, a * 0.5, c + 120));
        if (e.plan.skillId === "blade_heavy") return { x: 0, y: -26 * bell(span(ms, 0, c)) };
        const reach = SKILLS[e.plan.skillId].family === "weapon" ? 34 : 14;
        return { x: ((b.hit.x - m.x) / d) * reach * k, y: ((b.hit.y - m.y) / d) * reach * k };
      }
      if (e.kind === "boss_counter" && this.about(e).id === memberId && ms > 300 && ms < 700) {
        return { x: Math.sin(ms / 20) * 4, y: 0 };
      }
      if (e.kind === "victory" && e.signal.actorMemberId === memberId) {
        // The Leader steps into the last blow.
        const m = this.scene.mochi(memberId);
        if (!m) continue;
        const d = Math.hypot(b.hit.x - m.x, b.hit.y - m.y) || 1;
        const k = bell(span(ms, 260, 800));
        return { x: ((b.hit.x - m.x) / d) * 42 * k, y: ((b.hit.y - m.y) / d) * 42 * k };
      }
    }
    return null;
  }

  private clearFx() {
    if (!this.fx || !this.fxDrawn) return;
    this.fx.getContext("2d")?.clearRect(0, 0, this.fx.width, this.fx.height);
    this.fxDrawn = false;
  }

  private draw(active: Effect[], now: number, dt: number) {
    if (!this.fx) return;
    if (!active.length && !this.particles.length && !this.bossCue) return this.clearFx();
    const c = this.scene.cropBox;
    const res = Math.min(2, window.devicePixelRatio || 1) * Math.min(1, Math.max(0.25, this.scene.scale));
    const W = Math.round(c.w * res);
    const H = Math.round(c.h * res);
    if (this.fx.width !== W || this.fx.height !== H) {
      this.fx.width = W;
      this.fx.height = H;
    }
    const ctx = this.fx.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(res, 0, 0, res, -c.x * res, -c.y * res);
    this.fxDrawn = true;
    const b = this.bossPoints();
    if (!b) return;
    for (const e of active) this.effect(ctx, e, now - e.startedAt!, b);
    this.drawCue(ctx, b, now);
    this.drawParticles(ctx, dt);
  }

  private once(e: Effect, key: string): boolean {
    let set = this.fired.get(e);
    if (!set) this.fired.set(e, (set = new Set()));
    if (set.has(key)) return false;
    set.add(key);
    return true;
  }

  /** Sparks, within the room's 80 and an effect's own share (a combo's 32). */
  private spark(e: Effect | null, x: number, y: number, n: number, color: string, opts: { speed?: number; to?: Pt; size?: number; up?: number; kind?: Particle["kind"]; dir?: number; spread?: number; gravity?: number } = {}) {
    const cap = e?.plan && e.plan.memberIds.length > 1 ? RULES.comboParticleLimit : 40;
    const had = e ? this.spawned.get(e) ?? 0 : 0;
    const room = Math.min(n, cap - had, DESIGN.particleLimit - this.particles.length);
    for (let i = 0; i < room; i++) {
      const a = opts.dir === undefined ? Math.random() * Math.PI * 2 : opts.dir + (Math.random() - 0.5) * (opts.spread ?? 1.2);
      const v = (opts.speed ?? 160) * (0.45 + Math.random() * 0.55);
      const max = 0.5 + Math.random() * 0.4;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7 - (opts.up ?? 30), life: max, max, color, size: (opts.size ?? 4) * (0.6 + Math.random() * 0.6), to: opts.to, kind: opts.kind ?? "glow", gravity: opts.gravity ?? 220 });
    }
    if (e && room > 0) this.spawned.set(e, had + room);
  }

  private drawParticles(ctx: CanvasRenderingContext2D, dt: number) {
    const step = this.frozen === null ? Math.min(0.05, dt) : 0;
    this.particles = this.particles.filter((p) => (p.life -= step) > 0);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.particles) {
      if (p.to) {
        const k = 1 - p.life / p.max;
        p.x = lerp(p.x, p.to.x, 0.05 + k * 0.2);
        p.y = lerp(p.y, p.to.y, 0.05 + k * 0.2);
      } else {
        p.x += p.vx * step;
        p.y += p.vy * step;
        p.vy += (p.gravity ?? 220) * step;
      }
      ctx.globalAlpha = clamp01(p.life / p.max);
      if (p.kind === "streak") {
        const n = Math.hypot(p.vx, p.vy) || 1;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (p.vx / n) * p.size * 4, p.y - (p.vy / n) * p.size * 4);
        ctx.stroke();
      } else if (p.kind === "chip") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.life * 9);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.size * 1.6, 0);
        ctx.lineTo(0, -p.size * 0.7);
        ctx.lineTo(-p.size * 1.6, 0);
        ctx.lineTo(0, p.size * 0.7);
        ctx.fill();
        ctx.restore();
      } else if (p.kind === "plus") {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.7;
        ctx.beginPath();
        ctx.moveTo(p.x - p.size * 2, p.y);
        ctx.lineTo(p.x + p.size * 2, p.y);
        ctx.moveTo(p.x, p.y - p.size * 2);
        ctx.lineTo(p.x, p.y + p.size * 2);
        ctx.stroke();
      }
      const r = p.size * 3.2;
      ctx.drawImage(lightOf(p.color), p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /** Where a member's moves start: the tip of what it holds, else the middle of its body. */
  private origin(memberId: string | null): Pt | null {
    const m = memberId ? this.scene.mochi(memberId) : null;
    if (!m) return null;
    const R = m.size * 0.3;
    const cy = m.y + R * 0.06;
    const dir = m.facing < -0.05 ? -1 : 1;
    const acc = sceneArt()?.battle?.accessories;
    const hold = holdings(this.host.hero(memberId!), m.x, cy, R * 1.14, R * 0.88, cy - R * 0.88, dir).find((x) => x.casts);
    const sp = hold && acc?.[hold.name];
    const off = this.offset(memberId!) ?? { x: 0, y: 0 };
    if (!hold || !sp?.effectOrigin) return { x: m.x + off.x, y: cy + off.y };
    const dx = ((sp.effectOrigin[0] - sp.groundPivot[0]) / 2) * hold.k * (hold.flip ? -1 : 1);
    const dy = ((sp.effectOrigin[1] - sp.groundPivot[1]) / 2) * hold.k;
    const t = hold.turn ?? 0;
    return { x: hold.x + dx * Math.cos(t) - dy * Math.sin(t) + off.x, y: hold.y + dx * Math.sin(t) + dy * Math.cos(t) + off.y };
  }

  /** The member a non-hit effect is about, and where it stands. */
  private about(e: Effect) {
    const id = e.signal.actorMemberId ?? e.signal.source.memberIds[0] ?? (e.kind === "boss_counter" || e.kind === "unblock_support" ? this.host.waiting() : null);
    const m = id ? this.scene.mochi(id) : null;
    return { id, at: m ? { x: m.x, y: m.y + 8 } : null, feet: m ? { x: m.x, y: m.y + m.size * 0.3 } : null, facing: m && m.facing < -0.05 ? -1 : 1 };
  }

  private effect(ctx: CanvasRenderingContext2D, e: Effect, ms: number, b: NonNullable<ReturnType<BattleLayer["bossPoints"]>>) {
    if (e.plan) return this.hit(ctx, e, e.plan, ms, b);
    const w = this.about(e);
    const label = this.label(e.kind, e.signal);
    // Marks about the boss go on its chest, beside where blows land; its words go over its head.
    const head = { x: b.hit.x + 90 * b.scale, y: b.hit.y - 20 };
    if (this.once(e, "say")) this.say(e.kind);
    switch (e.kind) {
      case "delivery_waiting": {
        // The member's move meets the review shield: a ripple, no number.
        const from = this.origin(w.id) ?? { x: b.core.x - 220, y: b.core.y - 160 };
        const ward = toward(b.hit, from, 70 * b.scale);
        const pal = w.id ? SKILLS[this.host.skill(w.id)].palette : [PURPLE, "#fff"];
        if (ms < 420) orb(ctx, mix(from, ward, ease(span(ms, 0, 300))), 14, pal[0], 1 - span(ms, 300, 420));
        if (ms >= 260) {
          if (this.once(e, "ward") && label) this.float(label, head);
          hexShield(ctx, ward.x, ward.y, 62 * b.scale, PURPLE, (1 - span(ms, 480, 650)) * 0.95, ms / 600);
          ripple(ctx, ward.x, ward.y, 56 * b.scale, pal[0], span(ms, 260, 650));
          if (this.once(e, "sparks")) this.spark(e, ward.x, ward.y, 10, pal[0], { speed: 120, kind: "streak" });
        }
        break;
      }
      case "review_returned": {
        const back = w.at ?? { x: b.core.x - 220, y: b.core.y - 80 };
        const ward = toward(b.hit, back, 70 * b.scale);
        hexShield(ctx, ward.x, ward.y, 62 * b.scale, PURPLE, 1 - span(ms, 250, 480), ms / 600);
        if (ms >= 220) {
          if (this.once(e, "back") && label) this.float(label, w.at ? { x: w.at.x, y: w.at.y - 130 } : head);
          arcShot(ctx, ward, back, ease(span(ms, 220, 600)), PURPLE, 10);
        }
        break;
      }
      case "scope_added": {
        // A crystal for each new task (up to five) out of the floor in front of the boss, then new life flowing into it.
        const n = Math.max(1, Math.min(5, e.taskIds.length));
        const r = 120 * b.scale;
        for (let i = 0; i < n; i++) {
          const a = Math.PI * (0.12 + (0.76 * (i + 0.5)) / n);
          const x = b.feet.x + Math.cos(a) * r * 1.2;
          const y = b.feet.y + Math.sin(a) * r * 0.42 + 4;
          const grow = ease(span(ms, i * 70, 320 + i * 70));
          crystal(ctx, x, y, 54 * b.scale * grow, 1 - span(ms, 720, 900));
          if (grow > 0.3) floorRing(ctx, x, y, 26 * grow, "#B68CFF", 0.6 * (1 - span(ms, 500, 900)));
          if (ms >= 420 && this.once(e, `flow${i}`)) this.spark(e, x, y - 30, 6, GREEN, { to: b.core, size: 4 });
        }
        if (ms >= 300 && this.once(e, "num") && label) this.float(label, head);
        if (ms >= 500) glow(ctx, b.core.x, b.core.y, 70, GREEN, 0.7 * (1 - span(ms, 650, 900)));
        break;
      }
      case "task_started": {
        // At work: only the first moment of a charge, at what it holds.
        const from = this.origin(w.id);
        if (from) charge(ctx, from, w.id ? SKILLS[this.host.skill(w.id)].palette[0] : GOLD, span(ms, 0, 160), 1 - span(ms, 160, 450), ms);
        break;
      }
      case "boss_counter": {
        // The boss strikes at whoever is stuck; 守望結界 stands in the way. Nobody is hurt.
        const at = w.at ?? { x: b.feet.x - 160, y: b.feet.y - 20 };
        const feet = w.feet ?? { x: at.x, y: at.y + 40 };
        if (ms < 520) {
          glow(ctx, b.fist.x, b.fist.y, 46, ORANGE, 0.8 * bell(span(ms, 0, 520)));
          floorMark(ctx, feet.x, feet.y, lerp(24, 64, ease(span(ms, 0, 420))), ORANGE, 0.55 + 0.3 * Math.sin(ms / 50));
        }
        if (ms >= 300 && ms < 640) shockwave(ctx, b.fist, at, ease(span(ms, 300, 520)), ORANGE, 1 - span(ms, 520, 640));
        if (ms >= 360) {
          if (this.once(e, "ward")) {
            if (label) this.float(label, { x: at.x, y: at.y - 130 });
            this.showCard("support_ward", SKILLS.support_ward.name, `${w.id ? this.host.name(w.id) : "團隊"} · ${!e.signal.source.taskIds.length ? "等你回覆或批准" : "任務受阻"} · 0 傷害`, null);
            this.spark(e, at.x + w.facing * 40, at.y, 10, "#DCD2FF", { speed: 140, kind: "streak" });
          }
          const k = ms - 360;
          hexShield(ctx, at.x + w.facing * 44, at.y - 4, 56 * ease(span(k, 0, 200)), "#B5A8FF", 1 - span(k, 380, 640), ms / 500);
        }
        break;
      }
      case "unblock_support": {
        // 回復清輝: a pink light comes down and becomes a green ring; small crosses rise.
        const at = w.at ?? { x: b.feet.x - 160, y: b.feet.y - 20 };
        if (ms < 300) orb(ctx, { x: at.x, y: lerp(at.y - 150, at.y - 30, ease(span(ms, 0, 300))) }, 14, "#F5BDD9", 1);
        if (ms >= 250) {
          if (this.once(e, "heal")) {
            if (label) this.float(label, { x: at.x, y: at.y - 130 });
            this.showCard("support_cleanse", SKILLS.support_cleanse.name, `${w.id ? this.host.name(w.id) : "團隊"} · 你回覆了,工作繼續 · 0 傷害`, null);
            for (let i = 0; i < 6; i++) this.spark(e, at.x + (Math.random() - 0.5) * 80, at.y + 20, 1, "#8DE9C5", { speed: 30, up: 120, kind: "plus", size: 3.2, gravity: -40 });
          }
          const k = span(ms, 250, 650);
          floorRing(ctx, at.x, at.y + 40, lerp(30, 70, ease(k)), "#8DE9C5", 1 - k);
          glow(ctx, at.x, at.y, 60, "#8DE9C5", 0.6 * (1 - k));
        }
        break;
      }
      case "member_interrupted": {
        const at = w.at ?? b.top;
        crack(ctx, at.x, at.y - 70, 1 - span(ms, 250, 400));
        if (this.once(e, "crack") && label) this.float(label, { x: at.x, y: at.y - 130 });
        break;
      }
      case "pause":
        glow(ctx, b.core.x, b.core.y, 150 * b.scale, "#BFE3FF", 0.6 * (1 - span(ms, 0, 200)));
        if (this.once(e, "frost") && label) this.float(label, head);
        break;
      case "seal_wait": {
        // 共鳴封印: purple-gold rings of runes close quietly round the core.
        const k = ease(span(ms, 100, 320));
        const fade = 1 - span(ms, 480, 700);
        runeRing(ctx, b.core.x, b.core.y, 78 * b.scale * lerp(1.7, 1, k), ms / 380, "#B99CFF", fade);
        runeRing(ctx, b.core.x, b.core.y, 54 * b.scale * lerp(1.9, 1, k), -ms / 300, "#E2C58F", fade);
        glow(ctx, b.core.x, b.core.y, 60, "#B99CFF", 0.6 * fade);
        if (this.once(e, "seal")) {
          if (label) this.float(label, head);
          this.showCard("support_seal", SKILLS.support_seal.name, "工作都已驗收 · 等待 Leader 結案", null);
        }
        break;
      }
      case "victory": {
        // The seal left a sliver: the Leader closes the case with the last blow.
        const leaderId = e.signal.actorMemberId;
        const from = (leaderId ? this.origin(leaderId) : null) ?? { x: b.core.x - 420, y: b.core.y + 300 };
        if (ms < 460) {
          // The charge: gold gathers round the Leader.
          const kc = ease(span(ms, 60, 420));
          glow(ctx, from.x, from.y - 30, 46 * (0.5 + kc), GOLD, 0.75 * kc);
          runeRing(ctx, from.x, from.y + 24, 42 * (0.6 + 0.4 * kc), ms / 300, GOLD, 0.85 * kc);
          if (this.once(e, "callout")) this.float({ text: "最後一擊", sub: `Leader・${leaderId ? this.host.name(leaderId) : "隊長"}`, tone: "win" }, { x: from.x, y: from.y - 130 });
        }
        if (ms >= 420 && ms < 760) {
          // The strike flies to the core.
          const k = easeIn(span(ms, 420, 700));
          const at = mix(from, b.core, k);
          skySword(ctx, at, [GOLD, "#FFF3D0"], 1 - span(ms, 700, 760), 1.5 * b.scale);
          glow(ctx, at.x, at.y, 46, GOLD, 0.5 * (1 - k * 0.4));
        }
        if (ms >= 700 && this.once(e, "impact")) {
          this.hurtAt = this.now();
          const sliver = Math.max(1, Math.round((this.vm?.maxHp ?? 100) * 0.02));
          this.float({ text: `-${sliver}`, sub: "Leader・最後一擊", tone: "hit" }, { x: b.hit.x + 70, y: b.hit.y - 40 });
          this.spark(e, b.core.x, b.core.y, 12, "#ffffff", { speed: 220, size: 3 });
        }
        if (ms >= 900 && this.once(e, "burst")) {
          this.spark(e, b.core.x, b.core.y, 34, GOLD, { speed: 300, up: 160, kind: "streak", size: 4 });
          this.showCard("victory", `${WORLDS[this.worldId].bossName} 討伐成功!`, "Leader 最後一擊 · 全部任務驗收", null);
        }
        if (ms >= 900) {
          ring(ctx, b.core.x, b.core.y, lerp(30, 260, ease(span(ms, 900, 1800))), GOLD, 1 - span(ms, 900, 1800), 8);
          ring(ctx, b.feet.x, b.feet.y, lerp(40, 200, ease(span(ms, 1000, 1900))), GOLD, 0.8 * (1 - span(ms, 1000, 1900)), 4);
        }
        break;
      }
      case "reopen":
        ring(ctx, b.core.x, b.core.y, lerp(30, 120, ease(span(ms, 0, 600))), PURPLE, 1 - span(ms, 0, 600), 5);
        if (this.once(e, "re") && label) this.float(label, head);
        break;
      case "scope_adjusted":
        if (this.once(e, "adj") && label) this.float(label, head);
        break;
      default:
        break;
    }
  }

  // ── Accepted work: each member's skill, or a combo ─────────────────────────

  private hit(ctx: CanvasRenderingContext2D, e: Effect, plan: HitPlan, ms: number, b: NonNullable<ReturnType<BattleLayer["bossPoints"]>>) {
    const skill = plan.skillId ? SKILLS[plan.skillId] : null;
    const [a, c, i, end] = skill?.phases ?? [120, 340, 500, 850];
    const target = b.hit;
    const from = plan.memberIds.map((m) => this.origin(m)).filter((p): p is Pt => !!p);
    const sky = { x: target.x - 200, y: target.y - 320 };
    const pal = skill?.palette ?? [GOLD, "#FFF3C4", "#E0A030"];
    // The card first: the move's name, who made it, what it hit.
    if (this.once(e, "card")) {
      const who = plan.memberIds.map((m) => this.host.name(m)).join(" + ");
      const task = plan.taskIds.length === 1 ? this.host.taskTitle(plan.taskIds[0]) : `${plan.taskIds.length} 項任務`;
      this.showCard(plan.skillId ?? "neutral", skill?.name ?? "驗收命中", `${who ? `${who} · ` : ""}${task} 驗收`, `-${plan.displayDamage}`);
    }
    // The blow lands once: the boss flinches, the number shows, the sparks fly.
    if (ms >= c && this.once(e, "impact")) {
      this.hurtAt = this.now();
      this.float({ text: `-${plan.displayDamage}`, tone: "hit" }, { x: b.hit.x + 80 * b.scale, y: b.hit.y - 10 });
      const combo = plan.memberIds.length > 1;
      this.spark(e, target.x, target.y, combo ? 20 : 14, pal[0], { speed: 260, kind: "streak", size: 4 });
      this.spark(e, target.x, target.y, 8, pal[1] ?? "#ffffff", { speed: 160, size: 3 });
    }
    const id = plan.skillId;
    if (!skill || !id || !from.length) {
      // No one assigned: a plain blow from above, nobody made up.
      if (ms < i) beam(ctx, sky, target, ease(span(ms, a, c)), GOLD, 1 - span(ms, c, i), 12);
      if (ms >= c) burst(ctx, target, lerp(20, 90, ease(span(ms, c, end))), GOLD, 1 - span(ms, c, end));
      return;
    }
    const u = easeIn(span(ms, a, c)) * 0.4 + ease(span(ms, a, c)) * 0.6;
    const after = span(ms, c, end);
    // Under each who strikes, its circle; where the blow lands, a flash and a ring of force.
    for (const [k, m] of plan.memberIds.entries()) {
      const at = this.scene.mochi(m);
      if (at) magicCircle(ctx, { x: at.x, y: at.y + at.size * 0.3 }, 54 * ease(span(ms, 0, a + 60)), pal[k % pal.length], 1 - span(ms, c, end), ms / 700 + k);
    }
    if (ms >= c) {
      flash(ctx, target, 70 + 60 * (plan.memberIds.length - 1), 1 - span(ms, c, c + 160));
      ring(ctx, target.x, target.y + 10, lerp(30, 180, ease(after)), "#ffffff", 0.7 * (1 - after), 3);
      floorRing(ctx, b.feet.x, b.feet.y, lerp(60, 200, ease(after)), pal[0], 0.6 * (1 - after));
    }
    if (skill.family !== "combo") {
      const p = from[0];
      charge(ctx, p, pal[0], span(ms, 0, a), 1 - span(ms, c, i), ms);
      switch (id) {
        case "fire_ember": {
          if (ms >= a && ms < c + 30) {
            const head = fireball(ctx, p, target, u, pal, 1.45);
            if (this.once(e, `ember${Math.floor(ms / 80)}`)) this.spark(e, head.x, head.y, 2, pal[0], { speed: 60, size: 3, gravity: 60 });
          }
          if (ms >= c) {
            burst(ctx, target, lerp(40, 170, ease(after)), pal[0], 1 - after);
            petals(ctx, target, lerp(40, 150, ease(after)), pal[1], 1 - after);
            glow(ctx, target.x, target.y, 150, pal[0], 0.9 * (1 - after));
            if (this.once(e, "embers")) this.spark(e, target.x, target.y, 14, pal[2], { speed: 220, up: 60, kind: "streak" });
          }
          break;
        }
        case "ice_lance": {
          if (ms >= a && ms < c + 30) for (const off of [-1, 0, 1]) shard(ctx, fan(p, target, off * 36 * (1 - u)), target, Math.max(0, u - Math.abs(off) * 0.06), pal, 1.35);
          if (ms >= c) {
            frost(ctx, target, lerp(40, 150, ease(after)), pal, 1 - after);
            glow(ctx, target.x, target.y, 140, pal[0], 0.8 * (1 - after));
            if (this.once(e, "chips")) this.spark(e, target.x, target.y, 14, pal[1], { speed: 240, kind: "chip", size: 4 });
          }
          break;
        }
        case "wind_crescent": {
          if (ms >= a && ms < c + 60) for (const k of [0, 1, 2]) windBlade(ctx, p, target, Math.max(0, u - k * 0.12), pal, k, 1.4);
          if (ms >= c) {
            vortex(ctx, target, lerp(55, 140, ease(after)), pal, 1 - after, ms / 90);
            if (this.once(e, "gust")) this.spark(e, target.x, target.y, 12, pal[1], { speed: 200, kind: "streak", size: 3 });
          }
          break;
        }
        case "lightning_chain": {
          if (ms >= a && ms < i) bolt(ctx, p, mix(p, target, Math.max(u, 0.08)), pal, Math.floor(ms / 60), 1 - span(ms, c, i), 2.1);
          if (ms >= c) {
            star(ctx, target, lerp(40, 140, ease(after)), pal[2], 1 - after);
            for (let k = 0; k < 3; k++) bolt(ctx, target, { x: target.x + Math.cos(k * 2.1 + 0.4) * 80, y: target.y + Math.sin(k * 2.1 + 0.4) * 60 }, pal, Math.floor(ms / 60) + k * 7, 0.8 * (1 - after), 0.7);
            glow(ctx, target.x, target.y, 100, pal[0], 0.8 * (1 - after));
          }
          break;
        }
        case "blade_crescent": {
          if (ms < a + 80) floorRing(ctx, p.x, p.y + 50, 46, pal[0], span(ms, 0, a));
          if (ms >= a && ms < i) bladeCrescent(ctx, mix(p, target, u), Math.atan2(target.y - p.y, target.x - p.x), 125, 30, pal, 1 - span(ms, c, i));
          if (ms >= a && this.once(e, "trail")) this.spark(e, p.x, p.y, 8, pal[0], { speed: 200, kind: "streak", dir: Math.atan2(target.y - p.y, target.x - p.x), spread: 0.6, gravity: 0 });
          if (ms >= c) bladeCrescent(ctx, target, -0.5, lerp(115, 155, after), 34, pal, 1 - after);
          break;
        }
        case "blade_pierce": {
          if (ms >= a && ms < i) spear(ctx, p, mix(p, target, u), pal, 1 - span(ms, c, i), 1.4);
          if (ms >= c) {
            shock(ctx, target, lerp(40, 140, ease(after)), pal[0], 1 - after);
            glow(ctx, target.x, target.y, 130, pal[0], 0.8 * (1 - after));
          }
          break;
        }
        case "blade_counter": {
          const m = this.scene.mochi(plan.memberIds[0]);
          const dir = m && m.facing < -0.05 ? -1 : 1;
          const sh = { x: (m?.x ?? p.x) + dir * 70, y: (m?.y ?? p.y) - 4 };
          hexShield(ctx, sh.x, sh.y, 76 * ease(span(ms, 0, a)), "#A9B9FF", 1 - span(ms, c + 100, end), ms / 500);
          if (ms >= a && ms < i) bladeCrescent(ctx, mix(sh, target, u), Math.atan2(target.y - sh.y, target.x - sh.x), 100, 26, [pal[1], "#FFF6D8"], 1 - span(ms, c, i));
          if (ms >= c) {
            bladeCrescent(ctx, target, 0.6, lerp(100, 140, after), 30, [pal[1], "#FFF6D8"], 1 - after);
            glow(ctx, target.x, target.y, 80, pal[1], 0.8 * (1 - after));
          }
          break;
        }
        case "blade_heavy": {
          // The sword raised, then a great blade of light falling on the boss.
          if (ms < c) glow(ctx, p.x, p.y - 30 * span(ms, 0, a), 40, pal[0], 0.9 * span(ms, 0, a));
          const top = { x: target.x, y: target.y - 360 * b.scale };
          if (ms >= a && ms < i) skySword(ctx, mix(top, target, easeIn(span(ms, a, c))), pal, 1 - span(ms, c, i), 1.55 * b.scale);
          if (ms >= c) {
            ring(ctx, b.core.x, b.core.y + 10, lerp(60, 150, ease(after)), pal[0], 1 - after, 6);
            floorRing(ctx, b.feet.x, b.feet.y, lerp(60, 180, ease(after)), pal[0], 0.9 * (1 - after));
            glow(ctx, target.x, target.y, 120, pal[1], 1 - after);
          }
          break;
        }
      }
      return;
    }
    // Two or three members: each charges, their moves meet on the way, one blow lands.
    for (const [k, p] of from.entries()) charge(ctx, p, pal[k % pal.length], span(ms, 0, a), 1 - span(ms, c, i), ms + k * 90);
    const centre = from.reduce((s, p) => ({ x: s.x + p.x / from.length, y: s.y + p.y / from.length }), { x: 0, y: 0 });
    const meet = mix(centre, target, 0.5);
    const half = (a + c) / 2;
    const u1 = ease(span(ms, a, half));
    const u2 = easeIn(span(ms, half, c)) * 0.4 + ease(span(ms, half, c)) * 0.6;
    const skillOf = (k: number) => (plan.memberIds[k] ? SKILLS[this.host.skill(plan.memberIds[k])] : null);
    switch (id) {
      case "combo_fire_wind": {
        const fi = from.findIndex((_, k) => skillOf(k)?.element === "fire");
        const fp = from[Math.max(0, fi)];
        const wp = from[fi === 0 ? 1 : 0];
        if (ms < half) {
          fireball(ctx, fp, meet, u1, SKILLS.fire_ember.palette, 1.3);
          windBlade(ctx, wp, meet, u1, SKILLS.wind_crescent.palette, 0, 1.4);
        } else if (ms < c + 40) {
          vortex(ctx, mix(meet, target, u2), 46, SKILLS.wind_crescent.palette, 0.9, ms / 70);
          fireball(ctx, meet, target, u2, SKILLS.fire_ember.palette, 2.0);
        }
        if (ms >= c) {
          burst(ctx, target, lerp(40, 150, ease(after)), pal[0], 1 - after);
          vortex(ctx, target, lerp(60, 140, ease(after)), SKILLS.wind_crescent.palette, 1 - after, ms / 90);
          glow(ctx, target.x, target.y, 140, pal[0], 0.9 * (1 - after));
        }
        break;
      }
      case "combo_ice_lightning": {
        const ii = from.findIndex((_, k) => skillOf(k)?.element === "ice");
        const ip = from[Math.max(0, ii)];
        const lp = from[ii === 0 ? 1 : 0];
        if (ms < half) {
          shard(ctx, ip, meet, u1, SKILLS.ice_lance.palette, 1.35);
          if (ms >= a) bolt(ctx, lp, mix(lp, meet, Math.max(u1, 0.06)), SKILLS.lightning_chain.palette, Math.floor(ms / 60), 1, 1.2);
        } else if (ms < i) {
          const at = mix(meet, target, u2);
          diamond(ctx, at, 40, pal[0], 1 - span(ms, c, i));
          bolt(ctx, meet, mix(meet, target, Math.max(u2, 0.06)), SKILLS.lightning_chain.palette, Math.floor(ms / 60), 1 - span(ms, c, i), 1.6);
        }
        if (ms >= c) {
          frost(ctx, target, lerp(40, 130, ease(after)), SKILLS.ice_lance.palette, 1 - after);
          star(ctx, target, lerp(40, 120, ease(after)), pal[1], 1 - after);
          glow(ctx, target.x, target.y, 130, pal[0], 0.9 * (1 - after));
        }
        break;
      }
      case "combo_ward_blade": {
        if (ms < half) for (const [k, p] of from.entries()) arcShot(ctx, p, meet, u1, pal[k % 2], 10);
        else if (ms < i) {
          const at = mix(meet, target, u2);
          hexShield(ctx, at.x, at.y, 52, pal[0], 1 - span(ms, c, i), ms / 400);
          bladeCrescent(ctx, at, Math.atan2(target.y - meet.y, target.x - meet.x), 70, 18, [pal[1], "#FFF6D8"], 1 - span(ms, c, i));
        }
        if (ms >= c) {
          hexShield(ctx, target.x, target.y, lerp(52, 90, after), pal[0], 1 - after, ms / 400);
          bladeCrescent(ctx, target, -0.4, lerp(80, 120, after), 24, [pal[1], "#FFF6D8"], 1 - after);
        }
        break;
      }
      case "combo_trinity": {
        const sigil = mix(centre, target, 0.62);
        if (ms < c) for (const [k, p] of from.entries()) beam(ctx, p, sigil, u1, pal[k % 3], 1 - span(ms, half, c), 9);
        if (ms >= half && ms < i) trefoil(ctx, mix(sigil, target, ease(span(ms, half + 120, c))), 54, pal, Math.min(1, span(ms, half, half + 120)) * (1 - span(ms, c, i)), ms / 400);
        if (ms >= c) {
          trefoil(ctx, target, lerp(54, 130, ease(after)), pal, 1 - after, ms / 400);
          ring(ctx, target.x, target.y, lerp(40, 160, ease(after)), pal[1], 1 - after, 5);
          glow(ctx, target.x, target.y, 150, pal[0], 0.9 * (1 - after));
        }
        break;
      }
    }
  }

  // ── The heroes' looks ─────────────────────────────────────────────────────

  decorate(memberId: string, ctx: CanvasRenderingContext2D, size: number, engine: BotEngine, facing: number) {
    const acc = sceneArt()?.battle?.accessories;
    if (!acc) return;
    const R = size * 0.3;
    const rx = R * 1.14;
    const ry = R * 0.88;
    const cx = size / 2 + engine.ox * R;
    const cy = size / 2 + engine.particleOverhang / 2 + engine.oy * R + R * 0.06;
    // What it holds is on the side it faces, in a little hand of its own colour.
    const dir = facing < -0.05 ? -1 : 1;
    const body = engine.bodyColor;
    for (const hold of holdings(this.host.hero(memberId), cx, cy, rx, ry, cy - ry * engine.sy, dir, engine.ox, engine.tilt)) {
      const sp: Sprite | undefined = acc[hold.name];
      const im = sp && image(sp.file, () => this.scene.redrawMochis());
      if (!sp || !im) continue;
      ctx.save();
      ctx.translate(hold.x, hold.y);
      if (hold.turn) ctx.rotate(hold.turn);
      ctx.scale(hold.flip ? -hold.k : hold.k, hold.k);
      ctx.drawImage(im, -sp.groundPivot[0] / 2, -sp.groundPivot[1] / 2, sp.canvas[0] / 2, sp.canvas[1] / 2);
      ctx.restore();
      if (hold.hand && body) {
        ctx.fillStyle = `rgb(${Math.round(body[0] * 205)},${Math.round(body[1] * 205)},${Math.round(body[2] * 205)})`;
        ctx.beginPath();
        ctx.ellipse(hold.hand.x, hold.hand.y, R * 0.19, R * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        ctx.ellipse(hold.hand.x - R * 0.05, hold.hand.y - R * 0.05, R * 0.07, R * 0.05, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// ── Drawing: each move its own outline (never colour alone), lit additively ───

/** A point `d` pixels from `from` towards `to`. */
function toward(from: Pt, to: Pt, d: number): Pt {
  const n = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) / n) * d, y: from.y + ((to.y - from.y) / n) * d };
}

/** `p` moved sideways to the line p→q by `d` pixels. */
function fan(p: Pt, q: Pt, d: number): Pt {
  const n = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: p.x - ((q.y - p.y) / n) * d, y: p.y + ((q.x - p.x) / n) * d };
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  if (alpha <= 0.01 || r <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  if (color === "#000000") {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(0,0,0,0.9)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(lightOf(color), x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();
}

function stroke(ctx: CanvasRenderingContext2D, color: string, width: number, alpha: number, draw: () => void, blur = 14) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.beginPath();
  draw();
  ctx.stroke();
  ctx.restore();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number, width: number) {
  stroke(ctx, color, width, alpha, () => ctx.ellipse(x, y, r, r * 0.6, 0, 0, Math.PI * 2), 18);
}

/** A ring on the floor: a magic circle, flat. */
function floorRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  if (alpha <= 0.01 || r <= 0) return;
  stroke(ctx, color, 3, alpha, () => ctx.ellipse(x, y, r, r * 0.42, 0, 0, Math.PI * 2), 16);
  stroke(ctx, color, 1.5, alpha * 0.8, () => ctx.ellipse(x, y, r * 0.75, r * 0.75 * 0.42, 0, 0, Math.PI * 2), 8);
  ctx.save();
  ctx.globalAlpha = clamp01(alpha) * 0.25;
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function ripple(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, k: number) {
  for (let i = 0; i < 3; i++) {
    const t = clamp01(k * 1.4 - i * 0.25);
    ring(ctx, x, y, r * (0.3 + t * 0.9), color, (1 - t) * 0.8, 3);
  }
}

/** Light gathering at what a member holds before it strikes. */
function charge(ctx: CanvasRenderingContext2D, p: Pt, color: string, k: number, alpha: number, ms: number) {
  if (k <= 0 || alpha <= 0.01) return;
  glow(ctx, p.x, p.y, lerp(16, 62, k), color, alpha);
  for (let i = 0; i < 3; i++) {
    const a0 = ms / 120 + (i * Math.PI * 2) / 3;
    stroke(ctx, color, 2.5, alpha * k, () => ctx.arc(p.x, p.y, 22 + 8 * k, a0, a0 + 1.1), 10);
  }
}

/** A ball of light. */
function orb(ctx: CanvasRenderingContext2D, p: Pt, r: number, color: string, alpha: number) {
  glow(ctx, p.x, p.y, r * 3, color, alpha);
  glow(ctx, p.x, p.y, r, "#ffffff", alpha);
}

/** A beam from a member reaching `u` of the way to its target. */
function beam(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, color: string, alpha = 1, width = 8) {
  if (u <= 0 || alpha <= 0.01) return;
  const end = mix(from, to, u);
  const path = () => { ctx.moveTo(from.x, from.y); ctx.lineTo(end.x, end.y); };
  stroke(ctx, color, width * 2.2, alpha * 0.35, path, 24);
  stroke(ctx, color, width, alpha, path, 16);
  stroke(ctx, "#ffffff", width * 0.35, alpha, path, 0);
  glow(ctx, end.x, end.y, width * 4, color, alpha);
}

/** A thrown blow: a bright head on an arc, with a trail. */
function arcShot(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, color: string, width = 8) {
  if (u <= 0) return;
  const lift = Math.min(170, Math.hypot(to.x - from.x, to.y - from.y) * 0.35);
  const at = (t: number) => ({ x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) - Math.sin(Math.PI * t) * lift });
  for (let i = 0; i < 8; i++) {
    const a = at(Math.max(0, u - i * 0.035));
    const b = at(Math.max(0, u - (i + 1) * 0.035));
    stroke(ctx, color, width * (1 - i / 9), 1 - i / 8, () => { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); });
  }
  const head = at(u);
  glow(ctx, head.x, head.y, width * 3, color, 1);
}

/** 燼火彈: a ball of fire with a long licking tail. Returns where its head is. */
function fireball(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, pal: string[], size = 1): Pt {
  const lift = Math.min(120, Math.hypot(to.x - from.x, to.y - from.y) * 0.18);
  const at = (t: number) => ({ x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) - Math.sin(Math.PI * t) * lift });
  const head = at(u);
  if (u <= 0) return head;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 12; i >= 1; i--) {
    const p = at(Math.max(0, u - i * 0.025));
    const wob = Math.sin(i * 1.7 + u * 30) * 4;
    const r = (28 - i * 1.8) * size;
    ctx.globalAlpha = 0.75 - i * 0.05;
    ctx.drawImage(lightOf(i < 4 ? pal[0] : pal[2]), p.x - r + wob, p.y - r, r * 2, r * 2);
  }
  ctx.restore();
  glow(ctx, head.x, head.y, 42 * size, pal[0], 1);
  glow(ctx, head.x, head.y, 18 * size, pal[1], 1);
  glow(ctx, head.x, head.y, 9 * size, "#ffffff", 1);
  return head;
}

/** A burst of light where a blow lands. */
function burst(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, alpha: number) {
  if (alpha <= 0.01) return;
  glow(ctx, c.x, c.y, r * 1.2, color, alpha);
  stroke(ctx, color, 5, alpha, () => {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.2;
      ctx.moveTo(c.x + Math.cos(a) * r * 0.45, c.y + Math.sin(a) * r * 0.45 * 0.7);
      ctx.lineTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r * 0.7);
    }
  }, 16);
}

/** The fire's impact: a ring of pointed petals. */
function petals(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, alpha: number) {
  stroke(ctx, color, 4, alpha, () => {
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const rr = i % 2 ? r * 0.6 : r;
      const x = c.x + Math.cos(a) * rr;
      const y = c.y + Math.sin(a) * rr * 0.62;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
  }, 18);
}

/** 霜晶槍: a long diamond shard flying at its target, a sparkle trail behind it. */
function shard(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, pal: string[], size = 1) {
  if (u <= 0) return;
  const p = mix(from, to, u);
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  for (let i = 1; i <= 6; i++) {
    const t = mix(from, to, Math.max(0, u - i * 0.04));
    glow(ctx, t.x, t.y, (10 - i) * size, pal[1], 0.8 - i * 0.1);
  }
  diamond(ctx, p, 26 * size, pal[0], 1, ang);
}

function diamond(ctx: CanvasRenderingContext2D, p: Pt, r: number, color: string, alpha: number, ang = 0) {
  if (alpha <= 0.01) return;
  glow(ctx, p.x, p.y, r * 1.6, color, alpha * 0.8);
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  const g = ctx.createLinearGradient(-r, -r * 0.3, r, r * 0.3);
  g.addColorStop(0, "rgba(213, 245, 255, 0.95)");
  g.addColorStop(0.5, color);
  g.addColorStop(1, "rgba(91, 156, 222, 0.9)");
  ctx.fillStyle = g;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(r * 1.5, 0);
  ctx.lineTo(0, -r * 0.42);
  ctx.lineTo(-r * 1.1, 0);
  ctx.lineTo(0, r * 0.42);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(r * 1.5, 0);
  ctx.lineTo(-r * 1.1, 0);
  ctx.stroke();
  ctx.restore();
}

/** The ice's impact: spikes of ice bursting out, a frost flower. */
function frost(ctx: CanvasRenderingContext2D, c: Pt, r: number, pal: string[], alpha: number) {
  if (alpha <= 0.01) return;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    diamond(ctx, { x: c.x + Math.cos(a) * r * 0.55, y: c.y + Math.sin(a) * r * 0.55 * 0.65 }, r * 0.2, pal[0], alpha, a);
  }
  stroke(ctx, pal[1], 2.5, alpha, () => {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + Math.cos(a) * r * 0.45, c.y + Math.sin(a) * r * 0.45 * 0.65);
    }
  }, 12);
}

/** 迴風刃: a crescent blade of wind, turning as it flies. */
function windBlade(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, pal: string[], k: number, size = 1) {
  if (u <= 0) return;
  const side = (k - 1) * 40;
  const p = fan(mix(from, to, u), to, side * (1 - u));
  p.y -= Math.sin(Math.PI * u) * (30 + k * 20);
  const ang = Math.atan2(to.y - from.y, to.x - from.x) + u * 4 + k;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  ctx.globalCompositeOperation = "lighter";
  const r = (34 - k * 5) * size;
  ctx.fillStyle = pal[0] + "88";
  ctx.strokeStyle = pal[1];
  ctx.lineWidth = 2.5;
  ctx.shadowColor = pal[0];
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.arc(0, 0, r, -1.4, 1.4);
  ctx.arc(-r * 0.4, 0, r * 0.8, 1.2, -1.2, true);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** The wind's impact: a small whirlwind round the point. */
function vortex(ctx: CanvasRenderingContext2D, c: Pt, r: number, pal: string[], alpha: number, turn: number) {
  for (let k = 0; k < 3; k++) {
    const rr = r * (1 - k * 0.22);
    stroke(ctx, pal[k % pal.length], 4 - k, alpha, () => ctx.ellipse(c.x, c.y - k * 10, rr, rr * 0.38, 0, turn + k * 2, turn + k * 2 + 4.2), 16);
  }
  glow(ctx, c.x, c.y, r * 0.7, pal[0], alpha * 0.6);
}

/** 星鏈雷: a thick zigzag bolt and its forks, changing shape a few times a second (never flashing fast). */
function bolt(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, pal: string[], seed: number, alpha: number, w = 1) {
  if (alpha <= 0.01) return;
  const rnd = (k: number) => {
    const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x) - 0.5;
  };
  const pts: Pt[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const p = mix(from, to, i / n);
    pts.push(fan(p, to, i === 0 || i === n ? 0 : rnd(i) * 40 * w));
  }
  const line = (ps: Pt[]) => () => ps.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  stroke(ctx, pal[0], 12 * w, alpha * 0.45, line(pts), 26);
  stroke(ctx, pal[1], 5 * w, alpha, line(pts), 14);
  stroke(ctx, "#ffffff", 2 * w, alpha, line(pts), 0);
  for (const k of [3, 6]) {
    const p = pts[k];
    const f = { x: p.x + rnd(k + 20) * 70, y: p.y + 30 + rnd(k + 30) * 40 };
    const mid = { x: (p.x + f.x) / 2 + rnd(k + 40) * 20, y: (p.y + f.y) / 2 };
    stroke(ctx, pal[1], 3 * w, alpha * 0.85, line([p, mid, f]), 10);
  }
  glow(ctx, to.x, to.y, 30 * w, pal[1], alpha);
}

/** An eight-pointed star where lightning lands. */
function star(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, alpha: number) {
  stroke(ctx, color, 4, alpha, () => {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const rr = i % 2 ? r * 0.55 : r;
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr * 0.75);
    }
  }, 18);
  glow(ctx, c.x, c.y, r * 0.7, color, alpha);
}

/** 月牙斬: a great golden crescent of a sword's sweep. */
function bladeCrescent(ctx: CanvasRenderingContext2D, c: Pt, ang: number, r: number, thick: number, pal: string[], alpha: number) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.translate(c.x, c.y);
  ctx.rotate(ang);
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createLinearGradient(-r, 0, r, 0);
  g.addColorStop(0, pal[0] + "00");
  g.addColorStop(0.55, pal[0]);
  g.addColorStop(1, pal[1] ?? "#ffffff");
  ctx.fillStyle = g;
  ctx.shadowColor = pal[0];
  ctx.shadowBlur = 24;
  ctx.beginPath();
  ctx.arc(-r * 0.3, 0, r, -1.25, 1.25);
  ctx.arc(-r * 0.3 - thick, 0, r - thick * 0.4, 1.15, -1.15, true);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#FFF8DC";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(-r * 0.3, 0, r, -1.1, 1.1);
  ctx.stroke();
  ctx.restore();
}

/** 破陣刺: a golden spear of light with a broad head. */
function spear(ctx: CanvasRenderingContext2D, from: Pt, head: Pt, pal: string[], alpha: number, size = 1) {
  const path = () => { ctx.moveTo(from.x, from.y); ctx.lineTo(head.x, head.y); };
  stroke(ctx, pal[0], 16 * size, alpha * 0.35, path, 24);
  stroke(ctx, pal[0], 7 * size, alpha, path, 16);
  stroke(ctx, "#ffffff", 2.5 * size, alpha, path, 0);
  for (const off of [-16 * size, 16 * size]) {
    const s = fan(mix(from, head, 0.6), head, off);
    const e2 = fan(mix(from, head, 0.85), head, off);
    stroke(ctx, pal[1], 2, alpha * 0.8, () => { ctx.moveTo(s.x, s.y); ctx.lineTo(e2.x, e2.y); }, 6);
  }
  const ang = Math.atan2(head.y - from.y, head.x - from.x);
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.translate(head.x, head.y);
  ctx.rotate(ang);
  ctx.scale(size, size);
  ctx.fillStyle = pal[1];
  ctx.shadowColor = pal[0];
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.moveTo(30, 0);
  ctx.lineTo(-12, -16);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-12, 16);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Where a thrust lands: a triangle of shock lines. */
function shock(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, alpha: number) {
  stroke(ctx, color, 5, alpha, () => {
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      const a2 = a + (Math.PI * 2) / 3;
      ctx.moveTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r * 0.8);
      ctx.lineTo(c.x + Math.cos(a2) * r, c.y + Math.sin(a2) * r * 0.8);
    }
  }, 18);
}

/** 星落重擊: a great sword of light, point down. */
function skySword(ctx: CanvasRenderingContext2D, tip: Pt, pal: string[], alpha: number, k: number) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.translate(tip.x, tip.y);
  ctx.scale(k, k);
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createLinearGradient(0, -230, 0, 0);
  g.addColorStop(0, pal[0] + "00");
  g.addColorStop(0.3, pal[0]);
  g.addColorStop(1, pal[1]);
  ctx.fillStyle = g;
  ctx.shadowColor = pal[0];
  ctx.shadowBlur = 30;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(16, -40);
  ctx.lineTo(14, -170);
  ctx.lineTo(-14, -170);
  ctx.lineTo(-16, -40);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = pal[0];
  ctx.fillRect(-40, -184, 80, 14);
  ctx.fillRect(-7, -230, 14, 46);
  ctx.strokeStyle = "#FFFBEA";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(0, -165);
  ctx.stroke();
  ctx.restore();
  glow(ctx, tip.x, tip.y - 80 * k, 120 * k, pal[0], alpha * 0.5);
}

/** The review shield: a faceted hexagon of light. */
function hexShield(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number, turn = 0) {
  if (alpha <= 0.01 || r <= 1) return;
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    return { x: x + Math.cos(a) * r * 0.62, y: y + Math.sin(a) * r };
  });
  const outline = () => { pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); };
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
  g.addColorStop(0, "rgba(220, 210, 255, 0.45)");
  g.addColorStop(1, "rgba(140, 100, 255, 0.18)");
  ctx.fillStyle = g;
  ctx.beginPath();
  outline();
  ctx.fill();
  ctx.restore();
  stroke(ctx, color, 4, alpha, outline, 20);
  stroke(ctx, "#ffffff", 1.2, alpha * 0.8, () => { for (const p of pts) { ctx.moveTo(x, y); ctx.lineTo(p.x, p.y); } }, 0);
  const shine = (Math.sin(turn * 3) + 1) / 2;
  glow(ctx, x - r * 0.2, y - r * 0.5 + shine * r, r * 0.5, "#E8E0FF", alpha * 0.5);
}

/** A crystal of new work, rising out of the floor. */
function crystal(ctx: CanvasRenderingContext2D, x: number, y: number, hgt: number, alpha: number) {
  if (hgt <= 0.5 || alpha <= 0.01) return;
  const w = hgt * 0.34;
  glow(ctx, x, y - hgt * 0.5, hgt * 0.9, "#A46BFF", alpha * 0.6);
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  const g = ctx.createLinearGradient(x - w, y - hgt, x + w, y);
  g.addColorStop(0, "#F0E6FF");
  g.addColorStop(0.4, "#A46BFF");
  g.addColorStop(1, "#4B1FB0");
  ctx.fillStyle = g;
  ctx.shadowColor = "#A46BFF";
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(x, y - hgt);
  ctx.lineTo(x + w, y - hgt * 0.62);
  ctx.lineTo(x + w * 0.7, y);
  ctx.lineTo(x - w * 0.7, y);
  ctx.lineTo(x - w, y - hgt * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - hgt);
  ctx.lineTo(x - w * 0.15, y);
  ctx.moveTo(x - w, y - hgt * 0.62);
  ctx.lineTo(x + w * 0.2, y - hgt * 0.5);
  ctx.stroke();
  ctx.restore();
}

/** Where the counter will land: a warning on the floor. */
function floorMark(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  floorRing(ctx, x, y, r, color, alpha);
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.fillStyle = "#FFF1E6";
  ctx.textAlign = "center";
  ctx.fillText("!", x, y + 9);
  ctx.restore();
}

/** The boss's counter: a wave of force from its fist to whoever is stuck. */
function shockwave(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, color: string, alpha: number) {
  if (u <= 0 || alpha <= 0.01) return;
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  for (let k = 0; k < 3; k++) {
    const q = mix(from, to, Math.max(0, u - k * 0.08));
    stroke(ctx, color, 6 - k * 1.5, alpha * (1 - k * 0.3), () => ctx.arc(q.x, q.y, 30 - k * 4, ang - 1, ang + 1), 18);
  }
  const p = mix(from, to, u);
  glow(ctx, p.x, p.y, 40, color, alpha);
}

function crack(ctx: CanvasRenderingContext2D, x: number, y: number, alpha: number) {
  stroke(ctx, "#FF8A8A", 4, alpha, () => {
    ctx.moveTo(x - 20, y - 14);
    ctx.lineTo(x - 6, y - 3);
    ctx.lineTo(x - 13, y + 6);
    ctx.lineTo(x + 4, y + 17);
    ctx.moveTo(x - 6, y - 3);
    ctx.lineTo(x + 17, y - 11);
  }, 6);
}

/** A ring of runes, turning: the seal closing round the core. */
function runeRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, turn: number, color: string, alpha: number) {
  if (alpha <= 0.01) return;
  stroke(ctx, color, 3, alpha, () => ctx.arc(x, y, r, 0, Math.PI * 2), 16);
  stroke(ctx, color, 1.5, alpha, () => ctx.arc(x, y, r * 0.86, 0, Math.PI * 2), 8);
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    ctx.save();
    ctx.rotate(turn + (i * Math.PI) / 4);
    ctx.translate(r * 0.93, 0);
    ctx.rotate(Math.PI / 4);
    ctx.strokeRect(-4, -4, 8, 8);
    ctx.restore();
  }
  ctx.restore();
}

/** 三曜協奏: a three-petalled sigil. */
function trefoil(ctx: CanvasRenderingContext2D, c: Pt, r: number, pal: string[], alpha: number, turn: number) {
  if (alpha <= 0.01) return;
  for (let i = 0; i < 3; i++) {
    const a = turn + (i * Math.PI * 2) / 3;
    const p = { x: c.x + Math.cos(a) * r * 0.45, y: c.y + Math.sin(a) * r * 0.45 };
    stroke(ctx, pal[i % pal.length], 4, alpha, () => ctx.arc(p.x, p.y, r * 0.5, 0, Math.PI * 2), 18);
  }
  stroke(ctx, pal[1], 2, alpha, () => {
    for (let i = 0; i <= 3; i++) {
      const a = -turn + (i * Math.PI * 2) / 3;
      const p = { x: c.x + Math.cos(a) * r * 1.05, y: c.y + Math.sin(a) * r * 1.05 };
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    }
  }, 10);
  glow(ctx, c.x, c.y, r * 0.8, pal[1], alpha * 0.7);
}

/** A turning circle of runes on the floor, under whoever casts. */
function magicCircle(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, alpha: number, turn: number) {
  if (alpha <= 0.01 || r <= 2) return;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(1, 0.42);
  ctx.globalAlpha = clamp01(alpha);
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2);
  ctx.stroke();
  // A six-pointed star inside, turning the other way.
  ctx.beginPath();
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i <= 3; i++) {
      const a = -turn * 1.4 + k * Math.PI / 3 + (i * Math.PI * 2) / 3;
      const x = Math.cos(a) * r * 0.76;
      const y = Math.sin(a) * r * 0.76;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
  }
  ctx.stroke();
  for (let i = 0; i < 12; i++) {
    const a = turn + (i * Math.PI) / 6;
    ctx.save();
    ctx.rotate(a);
    ctx.translate(r * 0.89, 0);
    ctx.fillStyle = color;
    ctx.fillRect(-2, -5, 4, 10);
    ctx.restore();
  }
  ctx.globalAlpha = clamp01(alpha) * 0.22;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The instant a blow lands: a short white flash, local, never the whole screen. */
function flash(ctx: CanvasRenderingContext2D, c: Pt, r: number, alpha: number) {
  if (alpha <= 0.01) return;
  glow(ctx, c.x, c.y, r, "#ffffff", alpha);
  glow(ctx, c.x, c.y, r * 0.45, "#ffffff", alpha);
}
