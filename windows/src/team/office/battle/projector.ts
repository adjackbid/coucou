// The boss as the work stands: HP from the counted tasks, its state from the
// run. Pure — the same input gives the same picture — and shared by the
// company map and the team's office, so they can never disagree.

import { calculateProgress, type Id, type Task, type WorkStatus } from "../contracts";
import type { OfficeStore } from "../store";
import { DESIGN, type BattleViewModel, type BossState, type ProjectionInput, type TaskInput } from "./contracts";

/** The tasks progress counts: this run, counted, not cancelled, not a parent of others (calculateProgress's rule). */
export function countedTasks(tasks: readonly TaskInput[], runId: Id): TaskInput[] {
  const parents = new Set(tasks.filter((t) => t.runId === runId && t.parentTaskId !== null).map((t) => t.parentTaskId!));
  return tasks.filter((t) => t.runId === runId && t.includeInProgress && t.status !== "cancelled" && !parents.has(t.taskId));
}

export function project(input: ProjectionInput): BattleViewModel {
  const counted = countedTasks(input.tasks, input.runId);
  const N = counted.length;
  const D = counted.filter((t) => t.status === "completed").length;
  const hp = N ? DESIGN.hpPerTask * (N - D) : null;
  const maxHp = N ? DESIGN.hpPerTask * N : null;
  const reviewingCount = counted.filter((t) => t.status === "reviewing").length;
  // The board's progress and these tasks must be the same count, or something is still arriving.
  const consistencyIssue =
    input.progress.total !== N || input.progress.completed !== D
      ? `進度(${input.progress.completed}/${input.progress.total})和任務(${D}/${N})對不上,資料更新中`
      : null;

  let bossState: BossState;
  if (input.isSyncing || consistencyIssue) bossState = "syncing";
  else if (N === 0) bossState = "planning";
  else if (input.runStatus === "completed") bossState = D === N ? "defeated" : "inconsistent";
  else if (input.runStatus === "failed" || input.runStatus === "cancelled") bossState = "stopped";
  else if (input.runStatus === "paused" || input.runStatus === "pausing") bossState = "paused";
  else if (D === N) bossState = "sealing";
  else bossState = "engaged";

  const ratio = hp !== null && maxHp ? hp / maxHp : null;
  return {
    teamId: input.teamId,
    runId: input.runId,
    asOfSeq: input.asOfSeq,
    bossKey: "requirements-golem",
    bossState,
    hp,
    maxHp,
    progress: { completed: D, total: N, percent: N ? Math.round((D / N) * 100) : null },
    reviewingCount,
    blockedTaskIds: input.blockedTaskIds,
    needsHuman: input.needsHuman,
    isHistory: input.isHistory,
    countedTaskIds: counted.map((t) => t.taskId),
    phase: ratio === null ? null : ratio > 0.65 ? "core" : ratio > 0.3 ? "rage" : "last_seal",
    consistencyIssue,
  };
}

const asInput = (t: Task): TaskInput => ({
  teamId: t.teamId,
  runId: t.runId,
  taskId: t.taskId,
  revision: t.revision,
  title: t.title,
  status: t.status,
  assigneeMemberId: t.assigneeMemberId,
  includeInProgress: t.includeInProgress,
  parentTaskId: t.parentTaskId,
});

/** A team as OfficeStore holds it now, put to the projector. */
export function inputFrom(store: OfficeStore, teamId: Id, opts: { isHistory?: boolean } = {}): ProjectionInput | null {
  const team = store.team(teamId);
  if (!team) return null;
  const run = store.run(team.currentRunId);
  const tasks = store.tasks(teamId, team.currentRunId).map(asInput);
  const members = store.members(teamId);
  const waitsForYou = (s: WorkStatus) => s === "waiting_input";
  return {
    teamId,
    runId: team.currentRunId,
    streamId: store.streamId,
    asOfSeq: store.connection.lastAppliedSeq,
    runStatus: run?.status ?? "idle",
    progress: calculateProgress(store.tasks(teamId, team.currentRunId), team.currentRunId),
    tasks,
    needsHuman: run?.status === "needs_attention" || members.some((m) => waitsForYou(m.workStatus)),
    blockedTaskIds: tasks.filter((t) => t.status === "blocked" || t.status === "waiting_input").map((t) => t.taskId),
    isHistory: !!opts.isHistory,
    isSyncing: store.syncing,
  };
}
