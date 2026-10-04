// The design's own examples (feature2/ui/battle-mode/event-example.json),
// replayed step by step: the HP, the boss's state and the signals each step
// must give, and the edge cases that must never look like a win.

import { describe, expect, it } from "vitest";
import example from "./fixtures/event-example.json";
import { calculateProgress, type RunStatus, type Task } from "../contracts";
import type { Observation, ProjectionInput, TaskInput } from "./contracts";
import { project } from "./projector";
import { byId, diff } from "./signals";

interface Expected {
  completed: number;
  total: number;
  percent: number | null;
  hp: number | null;
  maxHp: number | null;
  bossState: string;
  autoVictory: boolean;
}

const RUN = example.scope.runId;
const TEAM = example.scope.teamId;

function input(tasks: TaskInput[], runStatus: RunStatus, needsHuman: boolean, extra: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    teamId: TEAM,
    runId: RUN,
    streamId: example.streamId,
    asOfSeq: 0,
    runStatus,
    progress: calculateProgress(tasks as unknown as Task[], RUN),
    tasks,
    needsHuman,
    blockedTaskIds: [],
    isHistory: false,
    isSyncing: false,
    ...extra,
  };
}

function observe(i: ProjectionInput, runRevision: number, rejections = new Map<string, number>()): Observation {
  return { vm: project(i), streamId: i.streamId, tasks: byId(i.tasks), members: new Map(), rejections, runStatus: i.runStatus, runRevision };
}

function check(o: Observation, e: Expected) {
  expect({ completed: o.vm.progress.completed, total: o.vm.progress.total, percent: o.vm.progress.percent, hp: o.vm.hp, maxHp: o.vm.maxHp, bossState: o.vm.bossState }).toEqual({
    completed: e.completed,
    total: e.total,
    percent: e.percent,
    hp: e.hp,
    maxHp: e.maxHp,
    bossState: e.bossState,
  });
}

describe("中二模式 — the design's example, step by step", () => {
  it("gives every step's HP, state and signals, and each completion its own victory", () => {
    let tasks = example.baseline.tasks.map((t) => ({ ...t })) as TaskInput[];
    let runStatus = example.baseline.runStatus as RunStatus;
    let needsHuman = example.baseline.needsHuman;
    const rejections = new Map<string, number>();
    let rev = 1;
    let prev = observe(input(tasks, runStatus, needsHuman, { asOfSeq: example.baseline.asOfSeq }), rev, new Map(rejections));
    check(prev, example.baseline.expected as Expected);
    // The first picture is a baseline: nothing replayed.
    const first = diff(null, prev, { completionOrdinal: 0, observedAt: "" });
    expect(first.signals.map((s) => s.kind)).toEqual(["baseline"]);
    let ordinal = first.completionOrdinal;

    for (const step of example.steps as Array<Record<string, unknown>>) {
      if (!step.duplicate) {
        for (const p of (step.patchTasks as { taskId: string; status: TaskInput["status"] }[] | undefined) ?? []) {
          const t = tasks.find((x) => x.taskId === p.taskId)!;
          if (step.backendFact === "reviewed(accepted=false)") rejections.set(t.taskId, (rejections.get(t.taskId) ?? 0) + 1);
          tasks = tasks.map((x) => (x.taskId === p.taskId ? { ...x, status: p.status, revision: x.revision + 1 } : x));
        }
        tasks = [...tasks, ...(((step.addTasks as TaskInput[]) ?? []).map((t) => ({ ...t })))];
        if (step.runStatus) runStatus = step.runStatus as RunStatus;
        if (typeof step.needsHuman === "boolean") needsHuman = step.needsHuman;
        rev += 1;
      }
      const next = observe(input(tasks, runStatus, needsHuman, { asOfSeq: step.seq as number }), rev, new Map(rejections));
      check(next, step.expected as Expected);
      const d = diff(prev, next, { completionOrdinal: ordinal, observedAt: "" });
      expect(d.signals.map((s) => s.kind), `step ${step.seq} ${step.why}`).toEqual(step.signals);
      if (step.completionOrdinal) expect(d.completionOrdinal).toBe(step.completionOrdinal);
      expect(d.signals.some((s) => s.kind === "victory")).toBe((step.expected as Expected).autoVictory);
      // A rejection is called one only when the record says so.
      const back = d.signals.find((s) => s.kind === "review_returned");
      if (back) expect(back.evidence).toBe("explicit_event");
      // Five accepted at once: one hit of -500, every task still named.
      if (step.seq === 108) {
        const hit = d.signals.find((s) => s.kind === "acceptance_hit")!;
        expect(hit.displayDelta).toBe(-500);
        expect(hit.source.taskIds).toHaveLength(5);
      }
      ordinal = d.completionOrdinal;
      prev = next;
    }
  });
});

describe("中二模式 — what must never look like a win", () => {
  for (const e of example.edgeCases as Array<Record<string, unknown>>) {
    it(e.name as string, () => {
      const exp = e.expected as Expected;
      const now = observe(input(e.tasks as TaskInput[], e.runStatus as RunStatus, false, { isHistory: !!e.isHistory }), 2);
      check(now, exp);
      const before = e.before as { tasks: TaskInput[]; runStatus: RunStatus } | undefined;
      const prevObs = before ? observe(input(before.tasks, before.runStatus, false), 1) : null;
      const d = diff(prevObs, now, { completionOrdinal: 0, observedAt: "" });
      expect(d.signals.some((s) => s.kind === "victory")).toBe(false);
      if (e.expectedSignals) expect(d.signals.map((s) => s.kind)).toEqual(e.expectedSignals);
    });
  }

  it("a same-run reopen with no new task keeps the boss sealed, and only a new task wakes it", () => {
    const done = { teamId: TEAM, runId: RUN, taskId: "t1", revision: 2, title: "a", status: "completed", assigneeMemberId: "ai1", includeInProgress: true, parentTaskId: null } as TaskInput;
    const won = observe(input([done], "completed", false), 5);
    const back = observe(input([done], "running", false), 6);
    const d = diff(won, back, { completionOrdinal: 1, observedAt: "" });
    expect(d.signals.map((s) => s.kind)).toEqual(["reopen"]);
    expect(back.vm.bossState).toBe("sealing");
    expect(back.vm.hp).toBe(0);
  });

  it("a different run is a new boss: a baseline, no hit replayed", () => {
    const t = { teamId: TEAM, runId: RUN, taskId: "t1", revision: 1, title: "a", status: "completed", assigneeMemberId: "ai1", includeInProgress: true, parentTaskId: null } as TaskInput;
    const old = observe(input([{ ...t, status: "running" }], "running", false), 1);
    const other = { ...input([{ ...t, runId: "demo-team@run-2" }], "running", false), runId: "demo-team@run-2" };
    const d = diff(old, observe(other, 1), { completionOrdinal: 3, observedAt: "" });
    expect(d.signals.map((s) => s.kind)).toEqual(["baseline"]);
    expect(d.completionOrdinal).toBe(0);
  });
});
