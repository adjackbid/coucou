// The effects waiting to be played, and those playing: short, limited, and
// never holding anything up. The HP and the work are already on screen when a
// signal comes here; an effect only shows how it happened. Too many at once
// are merged ("驗收 3 項 -300"), and one that waited too long is let go.

import type { Id } from "../contracts";
import { DESIGN, type BattleSignal, type SignalKind } from "./contracts";
import type { HitPlan } from "./skills";

/** How long each effect plays, in ms (the design's table). */
export const DURATION: Record<SignalKind, number> = {
  scope_added: 900,
  task_started: 450,
  delivery_waiting: 650,
  acceptance_hit: 850,
  review_returned: 700,
  boss_counter: 1000,
  unblock_support: 650,
  member_interrupted: 400,
  pause: 200,
  seal_wait: 700,
  victory: 1800,
  reopen: 600,
  scope_adjusted: 250,
  baseline: 0,
};

/** The effects that take the stage; the others are small and play beside them. */
export const PRIMARY = new Set<SignalKind>(["scope_added", "delivery_waiting", "acceptance_hit", "review_returned", "boss_counter", "seal_wait", "victory"]);

/** Hits and new tasks waiting together become one effect with every task named. */
const MERGES = new Set<SignalKind>(["acceptance_hit", "scope_added", "task_started", "delivery_waiting"]);

/** At most this many play at once, small ones included. */
const MAX_ACTIVE = 4;

export interface Effect {
  signal: BattleSignal;
  kind: SignalKind;
  primary: boolean;
  duration: number;
  queuedAt: number;
  startedAt: number | null;
  /** The HP the effect shows moving: the sum over what it merged. */
  delta: number | null;
  taskIds: Id[];
  /** For an accepted task: the move chosen for it (one member's skill, or a combo). */
  plan?: HitPlan;
}

export class EffectQueue {
  pending: Effect[] = [];
  active: Effect[] = [];

  constructor(private now: () => number = () => performance.now()) {}

  push(signal: BattleSignal) {
    if (signal.kind === "baseline") return;
    const at = this.now();
    // New work told to the leader: a win still waiting is no longer this one's.
    if (signal.kind === "reopen") this.pending = this.pending.filter((e) => e.kind !== "victory");
    const same = MERGES.has(signal.kind) ? this.pending.find((e) => e.kind === signal.kind && e.signal.actorMemberId === signal.actorMemberId) : undefined;
    if (same) {
      same.taskIds = [...new Set([...same.taskIds, ...signal.source.taskIds])];
      same.delta = same.delta === null && signal.displayDelta === null ? null : (same.delta ?? 0) + (signal.displayDelta ?? 0);
      return;
    }
    this.pending.push({
      signal,
      kind: signal.kind,
      primary: PRIMARY.has(signal.kind),
      duration: DURATION[signal.kind],
      queuedAt: at,
      startedAt: null,
      delta: signal.displayDelta,
      taskIds: [...signal.source.taskIds],
    });
    this.trim();
  }

  /** An accepted task's move: never merged with another, its number shown once. */
  pushPlan(signal: BattleSignal, plan: HitPlan) {
    this.pending.push({
      signal,
      kind: "acceptance_hit",
      primary: true,
      duration: plan.durationMs,
      queuedAt: this.now(),
      startedAt: null,
      delta: -plan.displayDamage,
      taskIds: [...plan.taskIds],
      plan,
    });
    this.trim();
  }

  /** A full queue lets a small effect go first, else the oldest. */
  private trim() {
    while (this.pending.length > DESIGN.queueLimit) {
      const minor = this.pending.findIndex((e) => !e.primary);
      this.pending.splice(minor >= 0 ? minor : 0, 1);
    }
  }

  /** Brings the queue to now: finished effects leave, waiting ones start while there is room. */
  tick(): Effect[] {
    const at = this.now();
    this.active = this.active.filter((e) => at - e.startedAt! < e.duration);
    // Waited too long: only a win is still worth showing late.
    this.pending = this.pending.filter((e) => e.kind === "victory" || at - e.queuedAt <= DESIGN.maxQueueDelayMs);
    const rest: Effect[] = [];
    for (const e of this.pending) {
      const primaries = this.active.filter((a) => a.primary).length;
      const room = this.active.length < MAX_ACTIVE && (!e.primary || primaries < DESIGN.maxPrimaryEffects);
      // The victory waits for the stage to itself.
      const alone = e.kind !== "victory" || this.active.every((a) => !a.primary);
      if (room && alone && !this.active.some((a) => a.kind === "victory")) {
        e.startedAt = at;
        this.active.push(e);
      } else rest.push(e);
    }
    this.pending = rest;
    return this.active;
  }

  /** How far an effect has played, 0–1. */
  progress(e: Effect): number {
    return e.startedAt === null ? 0 : Math.min(1, (this.now() - e.startedAt) / e.duration);
  }

  get busy(): boolean {
    return this.pending.length > 0 || this.active.length > 0;
  }

  clear() {
    this.pending = [];
    this.active = [];
  }
}
