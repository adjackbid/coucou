// The effect queue: limited, never late by more than 2 s, the win kept for
// last and dropped when the leader is given new work.

import { describe, expect, it } from "vitest";
import type { BattleSignal, SignalKind } from "./contracts";
import { EffectQueue } from "./effects";

let n = 0;
const sig = (kind: SignalKind, extra: Partial<BattleSignal> = {}): BattleSignal => ({
  teamId: "T", runId: "R", signalId: `s${n++}`, kind,
  source: { teamId: "T", runId: "R", kind: "snapshot_diff", streamId: "x", domainSeq: 1, taskIds: [`t${n}`], memberIds: [], questionIds: [] },
  reasonLabel: "", hpBefore: null, hpAfter: null, maxHpBefore: null, maxHpAfter: null, displayDelta: null, actorMemberId: null,
  observedAt: "", evidence: "observed_transition", replay: false, ...extra,
});

describe("中二模式 effects", () => {
  it("plays at most two primary effects at once, the rest wait", () => {
    let now = 0;
    const q = new EffectQueue(() => now);
    q.push(sig("delivery_waiting", { actorMemberId: "a" }));
    q.push(sig("delivery_waiting", { actorMemberId: "b" }));
    q.push(sig("scope_added"));
    expect(q.tick().length).toBe(2);
    now = 700;
    expect(q.tick().map((e) => e.kind)).toEqual(["scope_added"]);
  });

  it("merges new work waiting together, every task still named", () => {
    const q = new EffectQueue(() => 0);
    q.push(sig("scope_added", { displayDelta: 100 }));
    q.push(sig("scope_added", { displayDelta: 200 }));
    expect(q.pending.length).toBe(1);
    expect(q.pending[0].delta).toBe(300);
    expect(q.pending[0].taskIds.length).toBe(2);
  });

  it("keeps at most eight, letting small ones go first", () => {
    const q = new EffectQueue(() => 0);
    for (let i = 0; i < 6; i++) q.push(sig("task_started", { actorMemberId: `m${i}` }));
    for (let i = 0; i < 4; i++) q.push(sig("boss_counter", { actorMemberId: `m${i}` }));
    expect(q.pending.length).toBe(8);
    expect(q.pending.filter((e) => e.kind === "boss_counter").length).toBe(4);
  });

  it("lets go of what waited more than 2 s, but not the win", () => {
    let now = 0;
    const q = new EffectQueue(() => now);
    q.push(sig("delivery_waiting", { actorMemberId: "a" }));
    q.push(sig("delivery_waiting", { actorMemberId: "b" }));
    q.push(sig("scope_added"));
    q.push(sig("victory"));
    q.tick();
    now = 2600;
    const active = q.tick();
    expect(active.map((e) => e.kind)).toEqual(["victory"]);
  });

  it("a reopen drops the win still waiting", () => {
    const q = new EffectQueue(() => 0);
    q.push(sig("victory"));
    q.push(sig("reopen"));
    expect(q.pending.map((e) => e.kind)).toEqual(["reopen"]);
  });
});
