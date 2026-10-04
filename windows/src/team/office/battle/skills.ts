// How an accepted task is shown: each member's chosen skill — one of four
// elements or four blades — and, when two or three members' work is accepted
// together, a combined move. Only the showing is chosen here: every accepted
// task is still exactly 100 HP, a combo of two is -200, of three -300, and
// nothing is ever counted twice (feature2 kit v2: 技能與特效規格, skills.json).
//
// The plan is pure: the same contributions, the same keys already shown and
// the same session give the same plans. SkillDirector adds the clock — the
// 250 ms it waits for others, the 12 s before the next combo.

import type { Id } from "../contracts";
import type { HeroClass } from "./contracts";

export type Element = "fire" | "ice" | "wind" | "lightning" | "physical" | "support" | "any";
export type SkillId =
  | "fire_ember" | "ice_lance" | "wind_crescent" | "lightning_chain"
  | "blade_crescent" | "blade_pierce" | "blade_counter" | "blade_heavy"
  | "support_ward" | "support_cleanse" | "support_seal"
  | "combo_fire_wind" | "combo_ice_lightning" | "combo_ward_blade" | "combo_trinity";

export interface Skill {
  id: SkillId;
  name: string;
  family: "elemental" | "weapon" | "support" | "combo";
  element: Element;
  durationMs: number;
  /** Anticipation, cast, impact, settle: where each ends, in ms. */
  phases: [number, number, number, number];
  palette: string[];
}

const SOLO: [number, number, number, number] = [120, 340, 500, 850];
const COMBO: [number, number, number, number] = [160, 480, 650, 1200];

export const SKILLS: Record<SkillId, Skill> = {
  fire_ember: { id: "fire_ember", name: "燼火彈", family: "elemental", element: "fire", durationMs: 850, phases: SOLO, palette: ["#FF9A32", "#FFD474", "#D95428"] },
  ice_lance: { id: "ice_lance", name: "霜晶槍", family: "elemental", element: "ice", durationMs: 850, phases: SOLO, palette: ["#80DBFF", "#D5F5FF", "#5B9CDE"] },
  wind_crescent: { id: "wind_crescent", name: "迴風刃", family: "elemental", element: "wind", durationMs: 850, phases: SOLO, palette: ["#54D9B1", "#B7FFDA", "#2B9E9A"] },
  lightning_chain: { id: "lightning_chain", name: "星鏈雷", family: "elemental", element: "lightning", durationMs: 850, phases: SOLO, palette: ["#9292FF", "#64CCFF", "#FFE59A"] },
  blade_crescent: { id: "blade_crescent", name: "月牙斬", family: "weapon", element: "physical", durationMs: 850, phases: SOLO, palette: ["#F5B641", "#FFF0A8"] },
  blade_pierce: { id: "blade_pierce", name: "破陣刺", family: "weapon", element: "physical", durationMs: 850, phases: SOLO, palette: ["#E6B269", "#FFF2CF"] },
  blade_counter: { id: "blade_counter", name: "盾返斬", family: "weapon", element: "physical", durationMs: 950, phases: [160, 400, 560, 950], palette: ["#A9B9FF", "#FFD78D"] },
  blade_heavy: { id: "blade_heavy", name: "星落重擊", family: "weapon", element: "physical", durationMs: 1050, phases: [220, 450, 620, 1050], palette: ["#FFCE65", "#FFEEC4"] },
  support_ward: { id: "support_ward", name: "守望結界", family: "support", element: "support", durationMs: 650, phases: [100, 300, 300, 650], palette: ["#B5A8FF", "#DFDAFF"] },
  support_cleanse: { id: "support_cleanse", name: "回復清輝", family: "support", element: "support", durationMs: 650, phases: [100, 300, 300, 650], palette: ["#8DE9C5", "#F5BDD9"] },
  support_seal: { id: "support_seal", name: "共鳴封印", family: "support", element: "support", durationMs: 700, phases: [100, 300, 300, 700], palette: ["#B99CFF", "#E2C58F"] },
  combo_fire_wind: { id: "combo_fire_wind", name: "焰風雙奏", family: "combo", element: "any", durationMs: 1200, phases: COMBO, palette: ["#FFAA4A", "#66DBB1"] },
  combo_ice_lightning: { id: "combo_ice_lightning", name: "霜雷共振", family: "combo", element: "any", durationMs: 1200, phases: COMBO, palette: ["#9FE9FF", "#AFA2FF"] },
  combo_ward_blade: { id: "combo_ward_blade", name: "盾刃同盟", family: "combo", element: "any", durationMs: 1200, phases: COMBO, palette: ["#A7B5FF", "#FFD66A"] },
  combo_trinity: { id: "combo_trinity", name: "三曜協奏", family: "combo", element: "any", durationMs: 1500, phases: [200, 600, 800, 1500], palette: ["#C5A1FF", "#FFD690", "#95E7FF"] },
};

/** What a member can show when its work is accepted: four elements, four blades. */
export const HIT_SKILLS: SkillId[] = ["fire_ember", "ice_lance", "wind_crescent", "lightning_chain", "blade_crescent", "blade_pierce", "blade_counter", "blade_heavy"];

export const RULES = {
  hpPerTask: 100,
  collectMs: 250,
  sourceSpanMs: 1200,
  comboCooldownMs: 12000,
  comboParticleLimit: 32,
  maxHitLabels: 2,
} as const;

/** A member's skill when the person has not chosen one: from its look, then its place in the team. */
export function defaultSkill(hero: HeroClass, index: number): SkillId {
  switch (hero) {
    case "warrior": return "blade_crescent";
    case "guardian": return "blade_counter";
    case "captain": return "blade_heavy";
    case "support": return index % 2 ? "lightning_chain" : "wind_crescent";
    default: return (["fire_ember", "ice_lance", "wind_crescent", "lightning_chain"] as SkillId[])[index % 4];
  }
}

/** One accepted task, as the skills see it. */
export interface Contribution {
  teamId: Id;
  runId: Id;
  signalId: Id;
  kind: "acceptance_hit" | string;
  live: boolean;
  countedByCurrentProgress: boolean;
  /** One completed transition of one task: team/run/task/revision. Never an animation's id. */
  acceptanceKey: string;
  taskId: Id;
  memberId: Id | null;
  /** The member's look and skill; null when no one is assigned. */
  skillId: SkillId | null;
  heroClass: HeroClass | null;
  /** The store's atomic apply it came in. */
  batchId: string;
  /** When it really happened, if the record says; never guessed from when it was seen. */
  sourceTimeMs: number | null;
}

export interface HitPlan {
  planId: string;
  teamId: Id;
  runId: Id;
  skillId: SkillId | null;
  kind: "solo" | "combo" | "text_only";
  acceptanceKeys: string[];
  sourceSignalIds: Id[];
  taskIds: Id[];
  memberIds: Id[];
  /** The tasks it shows, 100 each; shown once, never written back. */
  displayDamage: number;
  damageLabelCount: 0 | 1;
  durationMs: number;
}

export interface PlanSession {
  /** Visible, mode on, live, not paused, syncing or inconsistent. */
  animate: boolean;
  reducedMotion: boolean;
  /** No combo shown in the last 12 s. */
  comboAllowed: boolean;
}

export interface PlanResult {
  plans: HitPlan[];
  /** Unique accepted tasks of this scope in what was offered (those already shown included). */
  newUnique: number;
  displayDamage: number;
  /** Keys shown now — or let go, when nothing could be shown: they are never shown later. */
  consumed: string[];
}

const elementOf = (c: Contribution): Element => (c.skillId ? SKILLS[c.skillId].element : "any");

/** Close enough to be one move: real times within 1.2 s, else the same atomic apply. */
function together(group: Contribution[]): boolean {
  const times = group.map((c) => c.sourceTimeMs);
  if (times.every((t): t is number => t !== null)) return Math.max(...times) - Math.min(...times) <= RULES.sourceSpanMs;
  return group.every((c) => c.batchId === group[0].batchId);
}

const distinct = (group: Contribution[]) =>
  new Set(group.map((c) => c.memberId)).size === group.length && new Set(group.map((c) => c.taskId)).size === group.length;

function pick<T>(items: T[], n: number, ok: (g: T[]) => boolean): T[] | null {
  const walk = (from: number, got: T[]): T[] | null => {
    if (got.length === n) return ok(got) ? got : null;
    for (let i = from; i < items.length; i++) {
      const r = walk(i + 1, [...got, items[i]]);
      if (r) return r;
    }
    return null;
  };
  return walk(0, []);
}

export function planHits(scope: { teamId: Id; runId: Id }, offered: readonly Contribution[], shown: ReadonlySet<string>, session: PlanSession): PlanResult {
  const seen = new Set<string>();
  const unique: Contribution[] = [];
  for (const c of offered) {
    if (c.kind !== "acceptance_hit" || !c.live || !c.countedByCurrentProgress) continue;
    if (c.teamId !== scope.teamId || c.runId !== scope.runId) continue;
    if (seen.has(c.acceptanceKey)) continue;
    seen.add(c.acceptanceKey);
    unique.push(c);
  }
  const fresh = unique.filter((c) => !shown.has(c.acceptanceKey));
  const consumed = fresh.map((c) => c.acceptanceKey);
  if (!session.animate) return { plans: [], newUnique: unique.length, displayDamage: 0, consumed };

  const plans: HitPlan[] = [];
  const make = (group: Contribution[], skillId: SkillId | null, kind: HitPlan["kind"]): HitPlan => ({
    planId: `${scope.runId}|${skillId ?? "neutral"}|${group.map((c) => c.acceptanceKey).join("+")}`,
    teamId: scope.teamId,
    runId: scope.runId,
    skillId,
    kind: session.reducedMotion ? "text_only" : kind,
    acceptanceKeys: group.map((c) => c.acceptanceKey),
    sourceSignalIds: [...new Set(group.map((c) => c.signalId))],
    taskIds: group.map((c) => c.taskId),
    memberIds: group.map((c) => c.memberId).filter((m): m is Id => !!m),
    displayDamage: RULES.hpPerTask * group.length,
    damageLabelCount: 1,
    durationMs: skillId ? SKILLS[skillId].durationMs : 850,
  });

  let rest = fresh;
  if (session.comboAllowed) {
    // Only members' own work, by different members on different tasks, close together.
    const able = fresh.filter((c) => c.memberId !== null && c.skillId !== null);
    const ok = (g: Contribution[]) => distinct(g) && together(g);
    const pair = (test: (a: Contribution, b: Contribution) => boolean) => pick(able, 2, (g) => ok(g) && (test(g[0], g[1]) || test(g[1], g[0])));
    const both = (x: Element, y: Element) => (a: Contribution, b: Contribution) => elementOf(a) === x && elementOf(b) === y;
    const choices: [SkillId, Contribution[] | null][] = [
      ["combo_trinity", pick(able, 3, ok)],
      ["combo_fire_wind", pair(both("fire", "wind"))],
      ["combo_ice_lightning", pair(both("ice", "lightning"))],
      ["combo_ward_blade", pair((a, b) => a.heroClass === "guardian" && b.heroClass === "warrior")],
    ];
    const found = choices.find(([, g]) => g);
    if (found) {
      const group = found[1]!;
      plans.push(make(group, found[0], "combo"));
      rest = fresh.filter((c) => !group.includes(c));
    }
  }
  for (const c of rest) plans.push(make([c], c.skillId, c.memberId ? "solo" : "text_only"));
  return { plans, newUnique: unique.length, displayDamage: plans.reduce((n, p) => n + p.displayDamage, 0), consumed };
}

/**
 * The clock around planHits: accepted tasks wait at most 250 ms for others,
 * a combo is followed by 12 s of single moves, and a key once shown (or let
 * go) is never shown again in this run — cancelling an effect never re-shows it.
 */
export class SkillDirector {
  private shown = new Set<string>();
  private scope: { teamId: Id; runId: Id } | null = null;
  private waiting: Contribution[] = [];
  private openedAt: number | null = null;
  private nextComboAt = 0;

  constructor(private now: () => number = () => performance.now()) {}

  /** Another run is another session: what was shown before does not carry over. */
  setScope(teamId: Id, runId: Id) {
    if (this.scope?.teamId === teamId && this.scope.runId === runId) return;
    this.scope = { teamId, runId };
    this.shown.clear();
    this.cancel();
  }

  offer(contributions: Contribution[]) {
    if (!contributions.length) return;
    this.waiting.push(...contributions);
    this.openedAt ??= this.now();
  }

  /** When the window has closed (or `force`), the plans; else null. */
  take(session: Omit<PlanSession, "comboAllowed">, force = false): PlanResult | null {
    if (this.openedAt === null || !this.scope) return null;
    if (!force && this.now() - this.openedAt < RULES.collectMs) return null;
    const result = planHits(this.scope, this.waiting, this.shown, { ...session, comboAllowed: this.now() >= this.nextComboAt });
    for (const k of result.consumed) this.shown.add(k);
    if (result.plans.some((p) => p.skillId && SKILLS[p.skillId].family === "combo")) this.nextComboAt = this.now() + RULES.comboCooldownMs;
    this.waiting = [];
    this.openedAt = null;
    return result;
  }

  get collecting(): boolean {
    return this.openedAt !== null;
  }

  /** Let go of what is waiting; what was shown stays shown. */
  cancel() {
    this.waiting = [];
    this.openedAt = null;
  }
}
