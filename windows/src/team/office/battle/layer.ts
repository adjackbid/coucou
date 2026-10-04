// 中二模式 in the room: the boss where the theme makes room for it, the
// heroes' looks on their Mochis, and the short moves that show how the work
// moved — each member's skill when its task is accepted, a combo when two or
// three are accepted together, the guard and the cleanse when someone is
// stuck and freed, the seal, the win. All of it over the office the scene
// already draws, on the scene's own frame loop: nothing runs while the window
// is hidden, and nothing is played that happened while no one was looking.
//
// The numbers are never here: the HP, the work, the questions are on the page
// already. A move only tells how they came to be (skills.ts chooses it).

import type { BotEngine } from "../../../mochi/engine";
import { h } from "../../../views/dom";
import { sceneArt, wake, type BossState as Look, type SceneLayer, type Sprite, type TeamScene } from "../scene";
import { DESIGN, type BattleSignal, type BattleViewModel, type HeroClass } from "./contracts";
import { EffectQueue, type Effect } from "./effects";
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
const ORANGE = "#FF9A5A";
const GREEN = "#6EE7B7";

export interface LayerHost {
  /** The boss as the work stands now. */
  vm(): BattleViewModel | null;
  hero(memberId: string): HeroClass;
  skill(memberId: string): SkillId;
  /** 減少動態: states and small marks, nothing moving. */
  calm(): boolean;
  /** Someone waiting on the person, for a counter that names no one. */
  waiting(): string | null;
  /** Each task an acceptance signal names, for the skills. */
  contributions(s: BattleSignal): Contribution[];
  /** A move was chosen for accepted work (the 戰鬥紀錄 can name it). */
  planned?(plan: HitPlan): void;
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
  /** Drawn towards this point (a stream into the boss), else falling free. */
  to?: Pt;
}

/** The room is shown at about two thirds of its size: the moves are drawn bigger to read as well. */
const FX = 1.5;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (p: Pt, q: Pt, t: number): Pt => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
/** How far into [from, to] ms an effect is, 0–1. */
const span = (ms: number, from: number, to: number) => clamp01((ms - from) / Math.max(1, to - from));

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

/** What each look holds, where, around a body centred at (cx, cy) of half-size rx × ry. */
function holdings(hero: HeroClass, cx: number, cy: number, rx: number, ry: number, top: number, dir: number, ox = 0, tilt = 0) {
  type Hold = { name: string; x: number; y: number; k: number; flip?: boolean; turn?: number; casts?: boolean };
  const out: Hold[] = [];
  switch (hero) {
    case "mage":
      out.push({ name: "staff", x: cx + dir * (rx + 3), y: cy + ry * 0.8, k: 0.55, turn: dir * 0.12, casts: true });
      out.push({ name: "hat", x: cx + ox * 2, y: top + 7, k: 0.6, turn: tilt });
      break;
    case "warrior":
      out.push({ name: "sword", x: cx + dir * (rx + 1), y: cy + ry * 0.35, k: 0.55, flip: dir < 0, turn: dir * 0.38, casts: true });
      break;
    case "guardian":
      out.push({ name: "shield", x: cx + dir * rx * 0.8, y: cy + ry * 1.0, k: 0.5, flip: dir < 0, casts: true });
      break;
    case "captain":
      out.push({ name: "flag", x: cx - dir * (rx + 1), y: cy + ry * 0.85, k: 0.6, flip: dir < 0, casts: true });
      break;
    case "support":
      out.push({ name: "orb", x: cx + dir * (rx + 10), y: cy - ry * 0.15, k: 0.6, casts: true });
      break;
  }
  return out;
}

export class BattleLayer implements SceneLayer {
  readonly pad: number;
  private boss: HTMLImageElement | null = null;
  private shadow: HTMLElement | null = null;
  private fx: HTMLCanvasElement | null = null;
  private fxDrawn = false;
  private look: Look | null = null;
  private vm: BattleViewModel | null = null;
  /** A moment held still (only to look at one move, in development); else the clock. */
  private frozen: number | null = null;
  private now = () => this.frozen ?? performance.now();
  private queue = new EffectQueue(() => this.now());
  private director = new SkillDirector(() => this.now());
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

  constructor(private scene: TeamScene, private host: LayerHost) {
    this.pad = scene.mini ? 0 : 30;
  }

  // ── The room ──────────────────────────────────────────────────────────────

  build() {
    const theme = this.scene.roomTheme;
    const art = sceneArt()?.battle;
    this.removeElements();
    if (!theme?.battle || !art) return;
    const stage = this.scene.stageEl;
    // What makes way for the boss (the meeting table in a standard office).
    for (const prop of theme.battle.hide) {
      const el = stage.querySelector<HTMLElement>(`[data-prop="${prop}"]`);
      if (el) {
        el.style.visibility = "hidden";
        this.hidden.push(el);
      }
    }
    const b = art.boss;
    const s = theme.battle.scale;
    const [ax, ay] = theme.battle.boss;
    const at = this.scene.screen(ax, ay);
    const z = this.scene.depthOf(ax, ay) + 6;
    const w = 150 * s;
    this.shadow = h("div", { class: "bt-boss-shadow", style: `left:${at.x - w / 2}px;top:${at.y - w * 0.16}px;width:${w}px;height:${w * 0.32}px;z-index:${z - 1}` });
    // Every state shares one canvas and one pivot: a change of state is a change of picture, nothing moves.
    const [gx, gy] = b.groundPivot.map((n) => (n / 2) * s);
    this.boss = h("img", {
      class: "bt-golem", alt: "", draggable: "false",
      style: `left:${at.x - gx}px;top:${at.y - gy}px;width:${(b.canvas[0] / 2) * s}px;height:${(b.canvas[1] / 2) * s}px;z-index:${z};transform-origin:${gx}px ${gy}px`,
    }) as HTMLImageElement;
    for (const st of Object.values(b.states)) image(st.file);
    stage.append(this.shadow, this.boss);
    if (!this.scene.mini) {
      const c = this.scene.cropBox;
      this.fx = h("canvas", { class: "bt-fx", "aria-hidden": "true", style: `left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px` }) as HTMLCanvasElement;
      stage.append(this.fx);
    }
    this.look = null;
    this.update();
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
    const state = vm?.bossState ?? "planning";
    // No task counted yet: the boss has not shown itself.
    const shown = !!vm && state !== "planning";
    this.boss.style.display = this.shadow!.style.display = shown ? "" : "none";
    this.boss.className = `bt-golem ${state}`;
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
    const st = sceneArt()?.battle?.boss.states[v];
    if (!st) return;
    this.look = v;
    this.boss.src = `/office/${st.file}`;
  }

  /** The boss's points in stage pixels: its feet, crystal core, where blows land, its head. */
  private bossPoints() {
    const theme = this.scene.roomTheme;
    const b = sceneArt()?.battle?.boss;
    if (!theme?.battle || !b) return null;
    const s = theme.battle.scale;
    const at = this.scene.screen(...theme.battle.boss);
    const st = b.states[this.look ?? "idle"];
    const p = (q: [number, number]): Pt => ({ x: at.x + ((q[0] - b.groundPivot[0]) / 2) * s, y: at.y + ((q[1] - b.groundPivot[1]) / 2) * s });
    return { feet: at, core: p(st.coreCenter), hit: p(st.hitTarget), top: p(b.top), scale: s };
  }

  detach() {
    this.stop();
    this.removeElements();
  }

  private removeElements() {
    for (const el of this.hidden) el.style.visibility = "";
    this.hidden = [];
    for (const el of [this.boss, this.shadow, this.fx]) el?.remove();
    this.boss = this.shadow = null;
    this.fx = null;
    this.look = null;
  }

  /** Everything playing or waiting is let go: hidden, another run, paused, the mode turned off. What was shown stays shown. */
  stop() {
    this.queue.clear();
    this.director.cancel();
    this.accepted.clear();
    window.clearTimeout(this.collectTimer);
    this.collectTimer = 0;
    this.particles = [];
    for (const el of this.floats) el.remove();
    this.floats.clear();
    this.clearFx();
    if (this.boss) this.boss.style.transform = this.boss.style.filter = "";
    this.setLook(this.baseLook());
  }

  // ── Signals ───────────────────────────────────────────────────────────────

  /** A signal seen live: played if this office is on screen, else let go. */
  play(s: BattleSignal) {
    if (this.scene.mini || !this.boss || !this.scene.el.isConnected || document.hidden) return;
    if (s.kind === "acceptance_hit") {
      // Accepted work waits a moment for others' to come with it: a combo, or each its own move.
      this.accepted.set(s.signalId, s);
      if (!this.director.collecting) this.collectTimer = window.setTimeout(() => this.collect(), RULES.collectMs + 5);
      this.director.offer(this.host.contributions(s));
      return;
    }
    if (this.host.calm()) {
      // 減少動態: a small still mark of what changed, no movement.
      const label = this.label(s.kind, s);
      if (label) this.float(label, this.anchorFor(s), true);
      return;
    }
    if (s.kind === "reopen") this.stop();
    this.queue.push(s);
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
        if (b) this.float({ text: `-${plan.displayDamage}`, sub: name, tone: "hit" }, { x: b.top.x, y: b.top.y - 6 }, true);
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
    const head = b ? { x: b.top.x, y: b.top.y - 6 } : { x: 0, y: 0 };
    const aboutMember = s.kind === "boss_counter" || s.kind === "unblock_support" || s.kind === "member_interrupted" || s.kind === "review_returned" || s.kind === "task_started";
    const id = s.actorMemberId ?? s.source.memberIds[0] ?? (s.kind === "boss_counter" ? this.host.waiting() : null);
    const m = aboutMember && id ? this.scene.mochi(id) : null;
    // Above the member's name, never over it.
    return m ? { x: m.x, y: m.y - 104 } : head;
  }

  private float(label: { text: string; sub?: string; tone: string }, at: Pt, still = false) {
    // At most two numbers at once: the rest are in the 戰鬥紀錄.
    if (label.tone === "hit" && [...this.floats].filter((f) => f.classList.contains("t-hit")).length >= RULES.maxHitLabels) return;
    const el = h("span", { class: `bt-float ${label.tone.split(" ").map((t) => `t-${t}`).join(" ")}${still || this.frozen !== null ? " still" : ""}` }, h("b", { text: label.text }), label.sub ? h("small", { text: label.sub }) : null);
    this.floats.add(el);
    this.scene.pinAt(el, at.x, at.y);
    window.setTimeout(() => {
      el.remove();
      this.floats.delete(el);
    }, still ? 2600 : 1500);
  }

  // ── Frames ────────────────────────────────────────────────────────────────

  frame(dt: number): boolean {
    const now = this.now();
    if (this.scene.mini || !this.boss) return false;
    if (this.host.calm()) {
      if (this.queue.busy || this.particles.length) this.stop();
      return false;
    }
    this.t += dt;
    const active = this.queue.tick();
    // The boss's picture follows the moves: guarding a hand-in, flinching at a hit, drinking in new work.
    let look = this.baseLook();
    let scale = 1;
    let dim = 0;
    for (const e of active) {
      const ms = now - e.startedAt!;
      if (e.kind === "delivery_waiting" || e.kind === "review_returned") look = "guard";
      if (e.kind === "scope_added" && ms > 250) look = "regen";
      if (e.kind === "victory") {
        dim = span(ms, 0, 500);
        scale = 1 - 0.12 * ease(span(ms, 500, 1100));
        if (ms >= 500) look = "defeated";
      }
    }
    const hurt = Math.max(0, 1 - (now - this.hurtAt) / 240);
    if (hurt > 0.2 && look !== "defeated") look = "hurt";
    this.setLook(look);
    const breathe = this.vm?.bossState === "engaged" ? Math.sin(this.t * 2.2) * 2.2 : 0;
    this.boss.style.transform = `translate(${hurt ? Math.sin(now / 18) * 3 * hurt : 0}px, ${breathe}px) scale(${scale})`;
    this.boss.style.filter = hurt ? `brightness(${1 + 0.5 * hurt})` : dim ? `brightness(${1 - 0.35 * dim})` : "";
    this.draw(active, now, dt);
    return true;
  }

  private clearFx() {
    if (!this.fx || !this.fxDrawn) return;
    this.fx.getContext("2d")?.clearRect(0, 0, this.fx.width, this.fx.height);
    this.fxDrawn = false;
  }

  private draw(active: Effect[], now: number, dt: number) {
    if (!this.fx) return;
    if (!active.length && !this.particles.length) return this.clearFx();
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
  private spark(e: Effect | null, x: number, y: number, n: number, color: string, opts: { speed?: number; to?: Pt; size?: number; up?: number } = {}) {
    const cap = e?.plan && e.plan.memberIds.length > 1 ? RULES.comboParticleLimit : 40;
    const had = e ? this.spawned.get(e) ?? 0 : 0;
    const room = Math.min(n, cap - had, DESIGN.particleLimit - this.particles.length);
    for (let i = 0; i < room; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (opts.speed ?? 120) * (0.4 + Math.random() * 0.6);
      const max = 0.45 + Math.random() * 0.35;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6 - (opts.up ?? 40), life: max, max, color, size: (opts.size ?? 3) * (0.6 + Math.random() * 0.6), to: opts.to });
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
        p.x = lerp(p.x, p.to.x, 0.06 + k * 0.2);
        p.y = lerp(p.y, p.to.y, 0.06 + k * 0.2);
      } else {
        p.x += p.vx * step;
        p.y += p.vy * step;
        p.vy += 260 * step;
      }
      ctx.globalAlpha = clamp01(p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 1.4, 0, Math.PI * 2);
      ctx.fill();
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
    if (!hold || !sp?.effectOrigin) return { x: m.x, y: cy };
    const dx = ((sp.effectOrigin[0] - sp.groundPivot[0]) / 2) * hold.k * (hold.flip ? -1 : 1);
    const dy = ((sp.effectOrigin[1] - sp.groundPivot[1]) / 2) * hold.k;
    const t = hold.turn ?? 0;
    return { x: hold.x + dx * Math.cos(t) - dy * Math.sin(t), y: hold.y + dx * Math.sin(t) + dy * Math.cos(t) };
  }

  /** The member a non-hit effect is about, and where it stands. */
  private about(e: Effect) {
    const id = e.signal.actorMemberId ?? e.signal.source.memberIds[0] ?? (e.kind === "boss_counter" || e.kind === "unblock_support" ? this.host.waiting() : null);
    const m = id ? this.scene.mochi(id) : null;
    return { id, at: m ? { x: m.x, y: m.y + 6 } : null, facing: m && m.facing < -0.05 ? -1 : 1, color: id ? HERO_COLOR[this.host.hero(id)] : GOLD };
  }

  private effect(ctx: CanvasRenderingContext2D, e: Effect, ms: number, b: NonNullable<ReturnType<BattleLayer["bossPoints"]>>) {
    if (e.plan) return this.hit(ctx, e, e.plan, ms, b);
    const w = this.about(e);
    const label = this.label(e.kind, e.signal);
    const head = { x: b.top.x, y: b.top.y - 6 };
    switch (e.kind) {
      case "delivery_waiting": {
        // The member's move meets the review shield: a ripple, no number.
        const from = this.origin(w.id) ?? { x: b.core.x - 160, y: b.core.y - 200 };
        const ward = toward(b.hit, from, 42 * b.scale);
        const color = w.id ? SKILLS[this.host.skill(w.id)].palette[0] : PURPLE;
        if (ms < 420) orb(ctx, mix(from, ward, ease(span(ms, 0, 300))), 7, color, 1 - span(ms, 300, 420));
        if (ms >= 260) {
          if (this.once(e, "ward") && label) this.float(label, head);
          hex(ctx, ward.x, ward.y, 30 * b.scale, PURPLE, (1 - span(ms, 450, 650)) * 0.9);
          ripple(ctx, ward.x, ward.y, 30 * b.scale, color, span(ms, 260, 650));
        }
        break;
      }
      case "review_returned": {
        const back = w.at ?? { x: b.core.x - 160, y: b.core.y - 120 };
        const ward = toward(b.hit, back, 42 * b.scale);
        hex(ctx, ward.x, ward.y, 30 * b.scale, PURPLE, 1 - span(ms, 250, 450));
        if (ms >= 220) {
          if (this.once(e, "back") && label) this.float(label, w.at ? { x: w.at.x, y: w.at.y - 110 } : head);
          arcShot(ctx, ward, back, ease(span(ms, 220, 600)), PURPLE);
        }
        break;
      }
      case "scope_added": {
        // A crystal for each new task (up to five) out of the floor, then new life flowing into the boss.
        const n = Math.max(1, Math.min(5, e.taskIds.length));
        // On the floor in an arc in front of the boss, never over it.
        const r = 80 * b.scale;
        for (let i = 0; i < n; i++) {
          const a = Math.PI * (0.12 + (0.76 * (i + 0.5)) / n);
          const x = b.feet.x + Math.cos(a) * r * 1.3;
          const y = b.feet.y + Math.sin(a) * r * 0.45 + 4;
          crystal(ctx, x, y, 30 * b.scale * ease(span(ms, i * 60, 300 + i * 60)), 1 - span(ms, 700, 900));
          if (ms >= 450 && this.once(e, `flow${i}`)) this.spark(e, x, y - 14, 5, GREEN, { to: b.core, size: 3 });
        }
        if (ms >= 300 && this.once(e, "num") && label) this.float(label, head);
        if (ms >= 600) glow(ctx, b.core.x, b.core.y, 30, GREEN, 0.5 * (1 - span(ms, 700, 900)));
        break;
      }
      case "task_started": {
        // At work: only the first moment of a charge, at what it holds.
        const from = this.origin(w.id);
        if (from) glow(ctx, from.x, from.y, lerp(6, 20, span(ms, 0, 120)), w.id ? SKILLS[this.host.skill(w.id)].palette[0] : GOLD, 0.7 * (1 - span(ms, 120, 450)));
        break;
      }
      case "boss_counter": {
        // 守望結界: the counter's warning on the floor, then an open shield at the member's side. Nobody is hurt.
        const at = w.at ?? { x: b.feet.x - 60, y: b.feet.y - 30 };
        const feet = { x: at.x, y: at.y + 30 };
        if (ms < 400) {
          floorMark(ctx, feet.x, feet.y, lerp(18, 44, ease(span(ms, 0, 350))), ORANGE, 0.5 + 0.3 * Math.sin(ms / 50));
          dashed(ctx, b.core, at, ORANGE, 0.6 * span(ms, 0, 350));
        }
        if (ms >= 350) {
          if (this.once(e, "ward") && label) this.float(label, { x: at.x, y: at.y - 110 });
          const k = ms - 350;
          openHex(ctx, at.x + w.facing * 34, at.y - 4, 34 * ease(span(k, 0, 300)), "#B5A8FF", 1 - span(k, 300, 650));
        }
        break;
      }
      case "unblock_support": {
        // 回復清輝: a pink light comes down and becomes a soft green ring with three motes.
        const at = w.at ?? { x: b.feet.x - 60, y: b.feet.y - 30 };
        if (ms < 300) orb(ctx, { x: at.x, y: lerp(at.y - 90, at.y - 20, ease(span(ms, 0, 300))) }, 8, "#F5BDD9", 1);
        if (ms >= 250) {
          if (this.once(e, "heal") && label) this.float(label, { x: at.x, y: at.y - 110 });
          const k = span(ms, 250, 650);
          ring(ctx, at.x, at.y + 26, lerp(20, 42, ease(k)), "#8DE9C5", 1 - k, 3);
          for (let i = 0; i < 3; i++) {
            const a = ms / 300 + (i * Math.PI * 2) / 3;
            glow(ctx, at.x + Math.cos(a) * 40, at.y + 26 + Math.sin(a) * 18, 6, "#8DE9C5", 1 - k);
          }
        }
        break;
      }
      case "member_interrupted": {
        const at = w.at ?? b.top;
        crack(ctx, at.x, at.y - 52, 1 - span(ms, 250, 400));
        if (this.once(e, "crack") && label) this.float(label, { x: at.x, y: at.y - 110 });
        break;
      }
      case "pause":
        glow(ctx, b.core.x, b.core.y, 80 * b.scale, "#BFE3FF", 0.5 * (1 - span(ms, 0, 200)));
        if (this.once(e, "frost") && label) this.float(label, head);
        break;
      case "seal_wait": {
        // 共鳴封印: thin purple-gold rings close quietly round the core.
        const k = ease(span(ms, 100, 300));
        runeRing(ctx, b.core.x, b.core.y, 40 * b.scale * lerp(1.6, 1, k), ms / 400, "#B99CFF", 1 - span(ms, 450, 700));
        runeRing(ctx, b.core.x, b.core.y, 28 * b.scale * lerp(1.8, 1, k), -ms / 300, "#E2C58F", 1 - span(ms, 450, 700));
        if (this.once(e, "seal") && label) this.float(label, head);
        break;
      }
      case "victory": {
        glow(ctx, b.core.x, b.core.y, 26, "#000000", 0.5 * span(ms, 0, 500));
        if (ms >= 500 && this.once(e, "burst")) {
          this.spark(e, b.core.x, b.core.y, 30, GOLD, { speed: 220, up: 120 });
          this.spark(e, b.core.x, b.core.y, 10, "#ffffff", { speed: 160, size: 2 });
        }
        if (ms >= 500) ring(ctx, b.core.x, b.core.y, lerp(20, 160, ease(span(ms, 500, 1300))), GOLD, 1 - span(ms, 500, 1300), 6);
        if (ms >= 900 && this.once(e, "medal") && label) this.float({ ...label, tone: "win big" }, { x: b.top.x, y: b.top.y - 18 });
        break;
      }
      case "reopen":
        ring(ctx, b.core.x, b.core.y, lerp(16, 60, ease(span(ms, 0, 600))), PURPLE, 1 - span(ms, 0, 600), 4);
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
    const sky = { x: target.x - 150, y: target.y - 230 };
    // The blow lands once: the boss flinches, the number shows, the sparks fly.
    if (ms >= c && this.once(e, "impact")) {
      this.hurtAt = this.now();
      this.float({ text: `-${plan.displayDamage}`, sub: skill?.name ?? "驗收命中", tone: "hit" }, { x: b.top.x, y: b.top.y - 6 });
      const pal = skill?.palette ?? [GOLD];
      this.spark(e, target.x, target.y, plan.memberIds.length > 1 ? 18 : 12, pal[0], { speed: 170 });
      this.spark(e, target.x, target.y, 6, pal[1] ?? "#ffffff", { speed: 120, size: 2 });
    }
    const id = plan.skillId;
    if (!skill || !id || !from.length) {
      // No one assigned: a plain blow from above, nobody made up.
      if (ms < i) beam(ctx, sky, target, ease(span(ms, a, c)), GOLD, 1 - span(ms, c, i));
      if (ms >= c) ring(ctx, target.x, target.y, lerp(12, 60, ease(span(ms, c, end))), GOLD, 1 - span(ms, c, end), 4);
      return;
    }
    const pal = skill.palette;
    const charge = (p: Pt, color: string) => glow(ctx, p.x, p.y, lerp(6, 22, span(ms, 0, a)), color, 0.7 * (1 - span(ms, c, i)));
    const u = ease(span(ms, a, c));
    const after = span(ms, c, end);
    if (skill.family !== "combo") {
      const p = from[0];
      charge(p, pal[0]);
      switch (id) {
        case "fire_ember":
          if (ms < c) fireDrop(ctx, p, target, u, pal);
          if (ms >= c) petals(ctx, target, lerp(14, 52, ease(after)), pal[0], 1 - after);
          if (ms >= c && this.once(e, "embers")) this.spark(e, target.x, target.y, 10, pal[2], { speed: 140, up: 80 });
          break;
        case "ice_lance":
          if (ms < c) for (const off of [-1, 0, 1]) shard(ctx, fan(p, target, off * 12 * (1 - u)), target, u, pal);
          if (ms >= c) frost(ctx, target, lerp(16, 42, ease(after)), pal, 1 - after);
          break;
        case "wind_crescent":
          if (ms < c + 40) { ribbon(ctx, p, target, u, pal[0], 0); ribbon(ctx, p, target, u, pal[2], Math.PI); }
          if (ms >= c) swirl(ctx, target, lerp(10, 34, ease(after)), pal[0], 1 - after, ms / 120);
          break;
        case "lightning_chain":
          if (ms >= a && ms < i) bolt(ctx, p, mix(p, target, Math.max(u, 0.05)), pal, Math.floor(ms / 70), 1 - span(ms, c, i));
          if (ms >= c) star(ctx, target, lerp(10, 30, ease(after)), pal[2], 1 - after);
          break;
        case "blade_crescent":
          if (ms < i) crescent(ctx, mix(p, target, u), Math.atan2(target.y - p.y, target.x - p.x), 26, pal, 1 - span(ms, c, i));
          if (ms >= c) crescent(ctx, target, -0.6, lerp(30, 46, after), pal, 1 - after);
          break;
        case "blade_pierce":
          if (ms < i) lance(ctx, p, mix(p, target, u), pal, 1 - span(ms, c, i));
          if (ms >= c) shock(ctx, target, lerp(10, 36, ease(after)), pal[0], 1 - after);
          break;
        case "blade_counter":
          if (ms < c + 60) hex(ctx, p.x, p.y, 16, pal[0], 1 - span(ms, a, c + 60));
          if (ms >= a && ms < i) arcShot(ctx, p, target, u, pal[1]);
          if (ms >= c) { hex(ctx, target.x, target.y, 24, pal[0], 1 - after); crescent(ctx, target, 0.5, 30, [pal[1], "#FFF6D8"], 1 - after); }
          break;
        case "blade_heavy": {
          glow(ctx, p.x, p.y - 10 * span(ms, 0, a), 18, pal[0], 0.8 * (1 - span(ms, a, c)));
          const top = { x: target.x, y: target.y - 150 * b.scale };
          if (ms >= a && ms < i) heavyBlade(ctx, top, mix(top, target, u), pal, 1 - span(ms, c, i));
          if (ms >= c) { ring(ctx, b.feet.x, b.feet.y, lerp(20, 60, ease(after)), pal[0], 1 - after, 3); glow(ctx, target.x, target.y, 26, pal[1], 1 - after); }
          break;
        }
      }
      return;
    }
    // Two or three members: each charges, their moves meet on the way, one blow lands.
    for (const [k, p] of from.entries()) charge(p, pal[k % pal.length]);
    const centre = from.reduce((s, p) => ({ x: s.x + p.x / from.length, y: s.y + p.y / from.length }), { x: 0, y: 0 });
    const meet = mix(centre, target, 0.5);
    const half = (a + c) / 2;
    const u1 = ease(span(ms, a, half));
    const u2 = ease(span(ms, half, c));
    const skillOf = (k: number) => (plan.memberIds[k] ? SKILLS[this.host.skill(plan.memberIds[k])] : null);
    switch (id) {
      case "combo_fire_wind": {
        const fi = from.findIndex((_, k) => skillOf(k)?.element === "fire");
        const fp = from[Math.max(0, fi)];
        const wp = from[fi === 0 ? 1 : 0];
        if (ms < half) { fireDrop(ctx, fp, meet, u1, SKILLS.fire_ember.palette); ribbon(ctx, wp, meet, u1, pal[1], 0); }
        else if (ms < c + 40) { fireDrop(ctx, meet, target, u2, SKILLS.fire_ember.palette); ribbon(ctx, meet, target, u2, pal[1], 0); ribbon(ctx, meet, target, u2, pal[1], Math.PI); }
        if (ms >= c) { petals(ctx, target, lerp(16, 56, ease(after)), pal[0], 1 - after); ring(ctx, target.x, target.y, lerp(20, 70, ease(after)), pal[1], 1 - after, 3); }
        break;
      }
      case "combo_ice_lightning": {
        const ii = from.findIndex((_, k) => skillOf(k)?.element === "ice");
        const ip = from[Math.max(0, ii)];
        const lp = from[ii === 0 ? 1 : 0];
        if (ms < half) { shard(ctx, ip, meet, u1, SKILLS.ice_lance.palette); if (ms >= a) bolt(ctx, lp, mix(lp, meet, Math.max(u1, 0.05)), SKILLS.lightning_chain.palette, Math.floor(ms / 70), 1); }
        else if (ms < i) { diamond(ctx, mix(meet, target, u2), 22, pal[0], 1 - span(ms, c, i)); bolt(ctx, meet, mix(meet, target, Math.max(u2, 0.05)), SKILLS.lightning_chain.palette, Math.floor(ms / 70), 1 - span(ms, c, i)); }
        if (ms >= c) { frost(ctx, target, lerp(16, 44, ease(after)), SKILLS.ice_lance.palette, 1 - after); star(ctx, target, lerp(12, 32, ease(after)), pal[1], 1 - after); }
        break;
      }
      case "combo_ward_blade": {
        if (ms < half) for (const p of from) arcShot(ctx, p, meet, u1, pal[from.indexOf(p) % 2]);
        else if (ms < i) { const h2 = mix(meet, target, u2); hex(ctx, h2.x, h2.y, 26, pal[0], 1 - span(ms, c, i)); crescent(ctx, h2, -0.4, 22, [pal[1], "#FFF6D8"], 1 - span(ms, c, i)); }
        if (ms >= c) { hex(ctx, target.x, target.y, lerp(24, 40, after), pal[0], 1 - after); crescent(ctx, target, -0.4, lerp(30, 48, after), [pal[1], "#FFF6D8"], 1 - after); }
        break;
      }
      case "combo_trinity": {
        const sigil = mix(centre, target, 0.62);
        if (ms < c) for (const [k, p] of from.entries()) beam(ctx, p, sigil, u1, pal[k % 3], 1 - span(ms, half, c));
        if (ms >= half && ms < i) trefoil(ctx, mix(sigil, target, ease(span(ms, half + 120, c))), 26, pal, Math.min(1, span(ms, half, half + 120)) * (1 - span(ms, c, i)), ms / 500);
        if (ms >= c) { trefoil(ctx, target, lerp(26, 60, ease(after)), pal, 1 - after, ms / 500); ring(ctx, target.x, target.y, lerp(24, 80, ease(after)), pal[1], 1 - after, 3); }
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
    // What it holds is on the side it faces.
    const dir = facing < -0.05 ? -1 : 1;
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
    }
  }
}

// ── Drawing: small shapes, each its own outline (never colour alone) ──────────

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
  r *= FX;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.globalCompositeOperation = color === "#000000" ? "source-over" : "lighter";
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function orb(ctx: CanvasRenderingContext2D, p: Pt, r: number, color: string, alpha: number) {
  glow(ctx, p.x, p.y, r * 2.4, color, alpha * 0.8);
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function stroke(ctx: CanvasRenderingContext2D, color: string, width: number, alpha: number, draw: () => void, blur = 12) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.strokeStyle = color;
  ctx.lineWidth = width * FX;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * FX;
  ctx.beginPath();
  draw();
  ctx.stroke();
  ctx.restore();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number, width: number) {
  stroke(ctx, color, width, alpha, () => ctx.ellipse(x, y, r, r * 0.55, 0, 0, Math.PI * 2));
}

function ripple(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, k: number) {
  for (let i = 0; i < 2; i++) {
    const t = clamp01(k * 1.4 - i * 0.3);
    ring(ctx, x, y, r * (0.4 + t * 0.8), color, (1 - t) * 0.8, 2);
  }
}

/** A beam from a hero reaching `u` of the way to its target. */
function beam(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, color: string, alpha = 1) {
  if (u <= 0 || alpha <= 0.01) return;
  const end = mix(from, to, u);
  stroke(ctx, color, 6, alpha, () => { ctx.moveTo(from.x, from.y); ctx.lineTo(end.x, end.y); }, 16);
  stroke(ctx, "#ffffff", 2, alpha, () => { ctx.moveTo(from.x, from.y); ctx.lineTo(end.x, end.y); }, 0);
  glow(ctx, end.x, end.y, 14, color, alpha);
}

/** A thrown blow: a bright head on an arc, with a short trail. */
function arcShot(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, color: string) {
  if (u <= 0) return;
  const lift = Math.min(150, Math.hypot(to.x - from.x, to.y - from.y) * 0.35);
  const at = (t: number) => ({ x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) - Math.sin(Math.PI * t) * lift });
  for (let i = 0; i < 6; i++) {
    const a = at(Math.max(0, u - i * 0.04));
    const b = at(Math.max(0, u - (i + 1) * 0.04));
    stroke(ctx, color, 7 - i, 1 - i / 6, () => { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); });
  }
  const head = at(u);
  glow(ctx, head.x, head.y, 14, color, 1);
}

/** 燼火彈: a drop of fire, pointed the way it flies, with a short tail. */
function fireDrop(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, pal: string[]) {
  if (u <= 0) return;
  const lift = Math.min(90, Math.hypot(to.x - from.x, to.y - from.y) * 0.2);
  const at = (t: number) => ({ x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) - Math.sin(Math.PI * t) * lift });
  for (let i = 1; i <= 5; i++) {
    const p = at(Math.max(0, u - i * 0.035));
    glow(ctx, p.x, p.y, 10 - i, pal[2], 0.7 - i * 0.12);
  }
  const p = at(u);
  const q = at(Math.max(0, u - 0.02));
  const ang = Math.atan2(p.y - q.y, p.x - q.x);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  ctx.scale(FX, FX);
  const g = ctx.createRadialGradient(-2, 0, 1, 0, 0, 12);
  g.addColorStop(0, pal[1]);
  g.addColorStop(0.6, pal[0]);
  g.addColorStop(1, pal[2]);
  ctx.fillStyle = g;
  ctx.shadowColor = pal[0];
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.moveTo(12, 0);
  ctx.quadraticCurveTo(0, -9, -10, 0);
  ctx.quadraticCurveTo(0, 9, 12, 0);
  ctx.fill();
  ctx.restore();
}

/** The fire's impact: a ring of pointed petals. */
function petals(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, alpha: number) {
  stroke(ctx, color, 2.5, alpha, () => {
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const rr = i % 2 ? r * 0.62 : r;
      const x = c.x + Math.cos(a) * rr;
      const y = c.y + Math.sin(a) * rr * 0.6;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
  });
}

/** 霜晶槍: a diamond shard flying at its target. */
function shard(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, pal: string[]) {
  if (u <= 0) return;
  const p = mix(from, to, u);
  diamond(ctx, p, 9, pal[0], 1, Math.atan2(to.y - from.y, to.x - from.x));
  stroke(ctx, pal[1], 1.5, 0.6, () => { const t = mix(from, to, Math.max(0, u - 0.12)); ctx.moveTo(t.x, t.y); ctx.lineTo(p.x, p.y); }, 6);
}

function diamond(ctx: CanvasRenderingContext2D, p: Pt, r: number, color: string, alpha: number, ang = 0) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  ctx.scale(FX, FX);
  ctx.fillStyle = "rgba(213, 245, 255, 0.55)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(r * 1.4, 0);
  ctx.lineTo(0, -r * 0.6);
  ctx.lineTo(-r * 1.4, 0);
  ctx.lineTo(0, r * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** The ice's impact: an angular frost flower. */
function frost(ctx: CanvasRenderingContext2D, c: Pt, r: number, pal: string[], alpha: number) {
  stroke(ctx, pal[0], 2, alpha, () => {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const tip = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * 0.6 };
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(tip.x, tip.y);
      const mid = mix(c, tip, 0.6);
      for (const s of [-1, 1]) {
        ctx.moveTo(mid.x, mid.y);
        ctx.lineTo(mid.x + Math.cos(a + s * 0.7) * r * 0.25, mid.y + Math.sin(a + s * 0.7) * r * 0.15);
      }
    }
  }, 8);
}

/** 迴風刃: a thin ribbon weaving towards its target. */
function ribbon(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, u: number, color: string, phase: number) {
  if (u <= 0) return;
  const n = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const side = { x: -(to.y - from.y) / n, y: (to.x - from.x) / n };
  const start = Math.max(0, u - 0.45);
  stroke(ctx, color, 3, 0.9, () => {
    for (let i = 0; i <= 16; i++) {
      const t = lerp(start, u, i / 16);
      const w = Math.sin(t * Math.PI * 3 + phase) * 12 * (1 - t * 0.6);
      const x = lerp(from.x, to.x, t) + side.x * w;
      const y = lerp(from.y, to.y, t) + side.y * w;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
  }, 10);
}

/** The wind's impact: a small spiral. */
function swirl(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, alpha: number, turn: number) {
  stroke(ctx, color, 2.5, alpha, () => {
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      const a = turn + t * Math.PI * 3;
      const x = c.x + Math.cos(a) * r * t;
      const y = c.y + Math.sin(a) * r * t * 0.6;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
  }, 10);
}

/** 星鏈雷: one zigzag arc and two short forks, steady between changes (never flickering fast). */
function bolt(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, pal: string[], seed: number, alpha: number) {
  const rnd = (k: number) => {
    const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x) - 0.5;
  };
  const pts: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    const p = mix(from, to, i / 8);
    const o = i === 0 || i === 8 ? 0 : rnd(i) * 22;
    pts.push(fan(p, to, o));
  }
  const line = (ps: Pt[]) => () => ps.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  stroke(ctx, pal[0], 4, alpha, line(pts), 14);
  stroke(ctx, "#ffffff", 1.5, alpha, line(pts), 0);
  for (const k of [3, 5]) {
    const p = pts[k];
    const f = { x: p.x + rnd(k + 20) * 40, y: p.y + 14 + rnd(k + 30) * 20 };
    stroke(ctx, pal[1], 2, alpha * 0.8, line([p, mix(p, f, 0.5), f]), 8);
  }
}

/** A four-point star where lightning lands. */
function star(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, alpha: number) {
  stroke(ctx, color, 2.5, alpha, () => {
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r * 0.7);
    }
  });
  glow(ctx, c.x, c.y, r * 0.6, color, alpha);
}

/** 月牙斬: a golden crescent. */
function crescent(ctx: CanvasRenderingContext2D, c: Pt, ang: number, r: number, pal: string[], alpha: number) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.translate(c.x, c.y);
  ctx.rotate(ang);
  ctx.scale(FX, FX);
  ctx.fillStyle = pal[0];
  ctx.shadowColor = pal[0];
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(0, 0, r, -1.2, 1.2);
  ctx.arc(-r * 0.35, 0, r * 0.82, 1.1, -1.1, true);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = pal[1] ?? "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/** 破陣刺: a thin gold line with a spearhead at its front. */
function lance(ctx: CanvasRenderingContext2D, from: Pt, head: Pt, pal: string[], alpha: number) {
  stroke(ctx, pal[0], 3, alpha, () => { ctx.moveTo(from.x, from.y); ctx.lineTo(head.x, head.y); }, 10);
  const ang = Math.atan2(head.y - from.y, head.x - from.x);
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.translate(head.x, head.y);
  ctx.rotate(ang);
  ctx.scale(FX, FX);
  ctx.fillStyle = pal[1];
  ctx.shadowColor = pal[0];
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-6, -7);
  ctx.lineTo(-6, 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Where a thrust lands: three short lines out from the point. */
function shock(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, alpha: number) {
  stroke(ctx, color, 2.5, alpha, () => {
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      ctx.moveTo(c.x + Math.cos(a) * r * 0.4, c.y + Math.sin(a) * r * 0.4);
      ctx.lineTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
    }
  });
}

/** 星落重擊: a short, thick blade of light coming straight down. */
function heavyBlade(ctx: CanvasRenderingContext2D, top: Pt, tip: Pt, pal: string[], alpha: number) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  const g = ctx.createLinearGradient(top.x, top.y, tip.x, tip.y);
  g.addColorStop(0, "rgba(255, 206, 101, 0)");
  g.addColorStop(1, pal[0]);
  ctx.fillStyle = g;
  ctx.shadowColor = pal[0];
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(top.x - 7 * FX, top.y);
  ctx.lineTo(top.x + 7 * FX, top.y);
  ctx.lineTo(tip.x + 4 * FX, tip.y - 8 * FX);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(tip.x - 4 * FX, tip.y - 8 * FX);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The review shield: a hexagon of light. */
function hex(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  if (alpha <= 0.01 || r <= 0) return;
  r *= 1.2;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const px = x + Math.cos(a) * r * 0.8;
    const py = y + Math.sin(a) * r;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(167, 139, 250, 0.26)";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * FX;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14 * FX;
  ctx.stroke();
  ctx.restore();
}

/** 守望結界: an open hexagon standing at a member's side. */
function openHex(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  if (r <= 0) return;
  stroke(ctx, color, 3, alpha, () => {
    for (let i = 0; i <= 4; i++) {
      const a = -Math.PI / 2 + Math.PI / 6 + (i * Math.PI) / 3;
      const px = x + Math.cos(a) * r * 0.55;
      const py = y + Math.sin(a) * r;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
  });
  if (alpha > 0.01) {
    ctx.save();
    ctx.globalAlpha = clamp01(alpha) * 0.25;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.5, r * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** A crystal of new work, rising out of the floor. */
function crystal(ctx: CanvasRenderingContext2D, x: number, y: number, hgt: number, alpha: number) {
  if (hgt <= 0.5 || alpha <= 0.01) return;
  hgt *= 1.3;
  const w = hgt * 0.36;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  const g = ctx.createLinearGradient(x - w, y - hgt, x + w, y);
  g.addColorStop(0, "#E6D6FF");
  g.addColorStop(0.45, "#A46BFF");
  g.addColorStop(1, "#5B2BC4");
  ctx.fillStyle = g;
  ctx.shadowColor = "#A46BFF";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(x, y - hgt);
  ctx.lineTo(x + w, y - hgt * 0.62);
  ctx.lineTo(x + w * 0.7, y);
  ctx.lineTo(x - w * 0.7, y);
  ctx.lineTo(x - w, y - hgt * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y - hgt);
  ctx.lineTo(x - w * 0.15, y);
  ctx.stroke();
  ctx.restore();
}

/** Where the counter will land: a warning on the floor. */
function floorMark(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.fillStyle = "rgba(255, 140, 70, 0.25)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.fillStyle = "#FFF1E6";
  ctx.textAlign = "center";
  ctx.fillText("!", x, y + 6);
  ctx.restore();
}

function dashed(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string, alpha: number) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function crack(ctx: CanvasRenderingContext2D, x: number, y: number, alpha: number) {
  stroke(ctx, "#FF8A8A", 3, alpha, () => {
    ctx.moveTo(x - 14, y - 10);
    ctx.lineTo(x - 4, y - 2);
    ctx.lineTo(x - 9, y + 4);
    ctx.lineTo(x + 3, y + 12);
    ctx.moveTo(x - 4, y - 2);
    ctx.lineTo(x + 12, y - 8);
  }, 0);
}

/** A thin ring of runes, turning: the seal closing round the core. */
function runeRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, turn: number, color: string, alpha: number) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.rotate(turn + (i * Math.PI) / 3);
    ctx.translate(r, 0);
    ctx.rotate(Math.PI / 4);
    ctx.strokeRect(-3, -3, 6, 6);
    ctx.restore();
  }
  ctx.restore();
}

/** 三曜協奏: a three-petalled mark. */
function trefoil(ctx: CanvasRenderingContext2D, c: Pt, r: number, pal: string[], alpha: number, turn: number) {
  for (let i = 0; i < 3; i++) {
    const a = turn + (i * Math.PI * 2) / 3;
    const p = { x: c.x + Math.cos(a) * r * 0.45, y: c.y + Math.sin(a) * r * 0.45 };
    stroke(ctx, pal[i % pal.length], 2.5, alpha, () => ctx.arc(p.x, p.y, r * 0.5, 0, Math.PI * 2));
  }
  glow(ctx, c.x, c.y, r * 0.5, pal[1], alpha * 0.6);
}
