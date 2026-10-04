// The kit's 28 skill cases (feature2 kit v2: skill-event-examples.json),
// each as its own session: which moves are planned, what they show, and that
// nothing is shown twice or made up. Then the clock: 250 ms, 12 s, a run.

import { describe, expect, it } from "vitest";
import cases from "./fixtures/skill-event-examples.json";
import { calculateProgress, type RunStatus, type Task } from "../contracts";
import type { HeroClass, ProjectionInput, TaskInput } from "./contracts";
import { project } from "./projector";
import { planHits, SkillDirector, type Contribution, type SkillId } from "./skills";

type Raw = (typeof cases.cases)[number];
type RawContribution = Raw["inputContributions"][number];

const ELEMENT_SKILL: Record<string, SkillId> = { fire: "fire_ember", ice: "ice_lance", wind: "wind_crescent", lightning: "lightning_chain" };

function contribution(c: RawContribution, scope: { teamId: string }): Contribution {
  const hero = c.heroClass as HeroClass;
  const skillId = ELEMENT_SKILL[c.element] ?? (hero === "guardian" ? "blade_counter" : "blade_crescent");
  return {
    teamId: (c as { teamId?: string }).teamId ?? scope.teamId,
    runId: c.runId,
    signalId: c.signalId,
    kind: c.kind,
    live: c.live,
    countedByCurrentProgress: c.countedByCurrentProgress,
    acceptanceKey: c.acceptanceKey,
    taskId: c.taskId,
    memberId: c.memberId,
    skillId,
    heroClass: hero,
    batchId: c.atomicApplyBatchId,
    sourceTimeMs: c.verifiedSourceTimeMs,
  };
}

describe("中二模式 skills — the kit's 28 cases", () => {
  for (const raw of cases.cases as Raw[]) {
    it(`${raw.caseId}: ${raw.description}`, () => {
      const s = raw.session;
      const animate = s.visible && s.modeEnabled && !s.history && !s.replay && !s.syncing && !s.paused && !s.inconsistent;
      const result = planHits(
        raw.scope,
        raw.inputContributions.map((c) => contribution(c, raw.scope)),
        new Set(raw.alreadyConsumedKeys),
        { animate, reducedMotion: s.reducedMotion, comboAllowed: !s.comboCooldownActive },
      );
      const e = raw.expected;
      expect(result.newUnique).toBe(e.newUniqueCountedAcceptances);
      expect(result.displayDamage).toBe(e.displayDamage);
      expect(result.plans.map((p) => ({ skillId: p.skillId, acceptanceKeys: p.acceptanceKeys, displayDamage: p.displayDamage, kind: p.kind, damageLabelCount: p.damageLabelCount }))).toEqual(e.plans);
      // No combo ever adds to what its tasks are worth.
      for (const p of result.plans) expect(p.displayDamage).toBe(100 * p.acceptanceKeys.length);
      // Nothing that could not be shown is kept to be shown later.
      if ((e as { noLaterReplay?: boolean }).noLaterReplay) expect(result.consumed.length).toBe(e.newUniqueCountedAcceptances);
    });
  }
});

/** The HP side of the cases that name it, from the projector. */
describe("中二模式 skills — HP is the tasks', never the moves'", () => {
  const RUN = "RUN-1";
  const task = (i: number, status: TaskInput["status"]): TaskInput => ({ teamId: "TEAM-1", runId: RUN, taskId: `T${i}`, revision: 1, title: `t${i}`, status, assigneeMemberId: "M1", includeInProgress: true, parentTaskId: null });
  const view = (tasks: TaskInput[], runStatus: RunStatus) => {
    const input: ProjectionInput = { teamId: "TEAM-1", runId: RUN, streamId: "s", asOfSeq: 1, runStatus, progress: calculateProgress(tasks as unknown as Task[], RUN), tasks, needsHuman: false, blockedTaskIds: [], isHistory: false, isSyncing: false };
    return project(input);
  };

  it("the last two accepted by a combo: sealed at 0 / 1200, not won", () => {
    const vm = view(Array.from({ length: 12 }, (_, i) => task(i, "completed")), "running");
    expect([vm.bossState, vm.hp, vm.maxHp]).toEqual(["sealing", 0, 1200]);
  });

  it("the leader's report: defeated, with no move of its own", () => {
    const vm = view(Array.from({ length: 12 }, (_, i) => task(i, "completed")), "completed");
    expect([vm.bossState, vm.hp, vm.maxHp]).toEqual(["defeated", 0, 1200]);
  });

  it("two tasks added and one accepted at once: 400 / 1000 → 500 / 1200", () => {
    const before = view([...Array.from({ length: 6 }, (_, i) => task(i, "completed")), ...Array.from({ length: 4 }, (_, i) => task(6 + i, "running"))], "running");
    const after = view([...Array.from({ length: 7 }, (_, i) => task(i, "completed")), ...Array.from({ length: 3 }, (_, i) => task(7 + i, "running")), task(10, "pending"), task(11, "pending")], "running");
    expect([before.hp, before.maxHp, after.hp, after.maxHp]).toEqual([400, 1000, 500, 1200]);
  });
});

describe("中二模式 skills — the clock", () => {
  const c = (key: string, member: string, skillId: SkillId, batch = "b1"): Contribution => ({
    teamId: "T", runId: "R", signalId: `s-${key}`, kind: "acceptance_hit", live: true, countedByCurrentProgress: true,
    acceptanceKey: key, taskId: `task-${key}`, memberId: member, skillId, heroClass: "mage", batchId: batch, sourceTimeMs: null,
  });
  const session = { animate: true, reducedMotion: false };

  it("waits 250 ms for others, then plans; a combo is followed by 12 s of single moves", () => {
    let now = 0;
    const d = new SkillDirector(() => now);
    d.setScope("T", "R");
    d.offer([c("A", "M1", "fire_ember")]);
    d.offer([c("B", "M2", "wind_crescent")]);
    now = 100;
    expect(d.take(session)).toBeNull();
    now = 260;
    expect(d.take(session)!.plans.map((p) => p.skillId)).toEqual(["combo_fire_wind"]);
    now = 5000;
    d.offer([c("C", "M1", "fire_ember", "b2"), c("D", "M2", "wind_crescent", "b2")]);
    now = 5300;
    expect(d.take(session)!.plans.map((p) => p.skillId)).toEqual(["fire_ember", "wind_crescent"]);
    now = 20000;
    d.offer([c("E", "M1", "fire_ember", "b3"), c("F", "M2", "wind_crescent", "b3")]);
    now = 20300;
    expect(d.take(session)!.plans.map((p) => p.skillId)).toEqual(["combo_fire_wind"]);
  });

  it("a cancelled move is not shown again; another run starts afresh", () => {
    let now = 0;
    const d = new SkillDirector(() => now);
    d.setScope("T", "R");
    d.offer([c("A", "M1", "fire_ember")]);
    now = 300;
    expect(d.take(session)!.displayDamage).toBe(100);
    // The same acceptance seen again (a redraw, a duplicate): nothing more.
    d.offer([c("A", "M1", "fire_ember")]);
    now = 600;
    expect(d.take(session)!.plans).toEqual([]);
    d.cancel();
    d.offer([c("A", "M1", "fire_ember")]);
    now = 900;
    expect(d.take(session)!.plans).toEqual([]);
    d.setScope("T", "R2");
    d.offer([{ ...c("A", "M1", "fire_ember"), runId: "R2" }]);
    now = 1200;
    expect(d.take(session)!.plans.length).toBe(1);
  });
});
