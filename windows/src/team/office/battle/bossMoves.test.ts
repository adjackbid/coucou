// The kit's 62 boss-move cases (feature2 kit v4: boss-move-event-examples.json):
// which move answers which real cause, and all the things that must never make
// the boss move — old blocks, consumed sources, another skin, a hidden page,
// chat, a sealed or beaten boss. Then the director's own clock and memory.

import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/boss-move-event-examples.json";
import type { BossState } from "./contracts";
import { BossDirector, chooseBossCue, resolvesWholeCast, BOSS_MOVES, BOSS_KIT, type BossBlockCause, type BossCueContext, type WorldBossId } from "./bossMoves";

type Raw = (typeof fixtures.cases)[number];

function contextOf(c: Raw): BossCueContext {
  const s = c.session as Record<string, unknown>;
  return {
    bossId: c.bossId as WorldBossId,
    signalKind: c.signalKind,
    sourceSignalIds: c.sourceSignalIds,
    evidence: c.evidence as BossCueContext["evidence"],
    cause: c.cause as BossBlockCause,
    newlyBlockedTaskIds: c.newlyBlockedTaskIds,
    addedCountedUncompletedTaskIds: c.addedCountedUncompletedTaskIds,
    scopeGrowthContributionHp: c.scopeGrowthContributionHp,
    bossStateAfterApply: s.bossStateAfterApply as BossState,
    live: s.live as boolean,
    visible: s.visible as boolean,
    modeEnabled: s.modeEnabled as boolean,
    history: s.history as boolean,
    syncing: s.syncing as boolean,
    paused: s.paused as boolean,
    reducedMotion: s.reducedMotion as boolean,
    ultimateCooldownActive: s.ultimateCooldownActive as boolean,
    consumedSourceSignalIds: new Set(c.alreadyConsumedSourceSignalIds),
    poseAnchorsVerified: (c as { poseAnchorsVerified?: boolean }).poseAnchorsVerified,
  };
}

describe("魔王招式 — the kit's 62 cases", () => {
  for (const c of fixtures.cases as Raw[]) {
    it(c.caseId, () => {
      const e = c.expected as Record<string, unknown>;
      if (c.signalKind === "unblock_support") {
        // A real unblock: the cast is cancelled only when every blocked source is resolved.
        const extra = c as unknown as { activePlanSourceTaskIds: string[]; verifiedResolvedTaskIds: string[] };
        expect(chooseBossCue(contextOf(c))).toBeNull();
        if ("cancelPendingCast" in e) expect(resolvesWholeCast(extra.activePlanSourceTaskIds, extra.verifiedResolvedTaskIds)).toBe(e.cancelPendingCast);
        return;
      }
      const cue = chooseBossCue(contextOf(c));
      if (e.moveId === null) {
        expect(cue).toBeNull();
        return;
      }
      expect(cue).not.toBeNull();
      expect(cue!.moveId).toBe(e.moveId);
      expect(cue!.heroHpDelta).toBe(0);
      expect(cue!.extraBossDamage).toBe(0);
      expect(cue!.animated).toBe(e.animated);
      if ("scopeGrowthLabelHp" in e) expect(cue!.scopeGrowthLabelHp).toBe(e.scopeGrowthLabelHp);
    });
  }

  it("names every move of every boss once", () => {
    const ids = Object.values(BOSS_KIT).flatMap((k) => [...k.attacks, k.ultimate, k.guard, k.regen]);
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
    for (const id of ids) expect(BOSS_MOVES[id].moveId).toBe(id);
  });
});

describe("魔王招式 — the director", () => {
  const base = {
    bossId: "lava-dragon" as WorldBossId,
    signalKind: "boss_counter",
    evidence: "observed_transition" as const,
    cause: "dependency_wait" as BossBlockCause,
    addedCountedUncompletedTaskIds: [] as string[],
    scopeGrowthContributionHp: 0,
    bossStateAfterApply: "engaged" as BossState,
    live: true, visible: true, modeEnabled: true, history: false, syncing: false, paused: false, reducedMotion: false,
  };

  it("an ultimate is followed by 12 s of plain moves, and a source is never shown twice", () => {
    let now = 0;
    const d = new BossDirector(() => now);
    d.setRun("R1");
    expect(d.choose({ ...base, sourceSignalIds: ["s1"], newlyBlockedTaskIds: ["A", "B"] })!.moveId).toBe("lava_crater_core");
    now = 5000;
    expect(d.choose({ ...base, sourceSignalIds: ["s2"], newlyBlockedTaskIds: ["C", "D"] })!.moveId).toBe("lava_flame_breath");
    // The same source again (a redraw): nothing.
    expect(d.choose({ ...base, sourceSignalIds: ["s2"], newlyBlockedTaskIds: ["C", "D"] })).toBeNull();
    now = 20000;
    expect(d.choose({ ...base, sourceSignalIds: ["s3"], newlyBlockedTaskIds: ["E", "F"] })!.moveId).toBe("lava_crater_core");
  });

  it("a new skin keeps the memory; a new run starts afresh", () => {
    const d = new BossDirector(() => 0);
    d.setRun("R1");
    expect(d.choose({ ...base, sourceSignalIds: ["s1"], newlyBlockedTaskIds: ["A"] })).not.toBeNull();
    expect(d.choose({ ...base, bossId: "frost-queen", sourceSignalIds: ["s1"], newlyBlockedTaskIds: ["A"] })).toBeNull();
    d.setRun("R1");
    expect(d.choose({ ...base, sourceSignalIds: ["s1"], newlyBlockedTaskIds: ["A"] })).toBeNull();
    d.setRun("R2");
    expect(d.choose({ ...base, sourceSignalIds: ["s1"], newlyBlockedTaskIds: ["A"] })).not.toBeNull();
  });
});
