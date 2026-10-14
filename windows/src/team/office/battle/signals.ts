// What happened between two pictures of a team, told as the raid: a task
// accepted is a hit, a hand-in waits behind the shield, new tasks are
// requirement crystals, a question is the boss's counter, the leader's
// report is the victory. Every signal says which tasks, members or
// questions it came from; nothing is made up between two pictures.
//
// The first picture of a run — or of a team just opened, a history, a
// resync — is a baseline: what is already done is not replayed.

import { tr, trf } from "../../../core/i18n";
import type { Id, TaskStatus } from "../contracts";
import { DESIGN, type BattleSignal, type Observation, type SignalKind, type TaskInput } from "./contracts";

const WAITING = new Set<TaskStatus>(["blocked", "waiting_input"]);
const WORKING = new Set<TaskStatus>(["running"]);
// Waiting for another member's hand-in is the normal course of work, not a block: when it comes, the task starts.
const NOT_STARTED = new Set<TaskStatus>(["pending", "ready", "waiting_dependency"]);

export interface Diff {
  signals: BattleSignal[];
  /** Live completions seen in this run so far: each victory is the next one. */
  completionOrdinal: number;
}

const sameScope = (a: Observation, b: Observation) => a.vm.teamId === b.vm.teamId && a.vm.runId === b.vm.runId && a.streamId === b.streamId;

export function diff(prev: Observation | null, next: Observation, ctx: { completionOrdinal: number; observedAt: string }): Diff {
  const vm = next.vm;
  const make = (kind: SignalKind, fields: Partial<Omit<BattleSignal, "reasonLabel">> & { reason: () => string; key: string }): BattleSignal => {
    // `source` is merged over the defaults below, never spread back over them.
    const { key, source, reason, ...rest } = fields;
    const signal = {
      teamId: vm.teamId,
      runId: vm.runId,
      signalId: `${vm.runId}|${kind}|${key}`,
      kind,
      source: { teamId: vm.teamId, runId: vm.runId, kind: "snapshot_diff", streamId: next.streamId, domainSeq: vm.asOfSeq, taskIds: [], memberIds: [], questionIds: [], ...(source ?? {}) },
      hpBefore: prev?.vm.hp ?? null,
      hpAfter: vm.hp,
      maxHpBefore: prev?.vm.maxHp ?? null,
      maxHpAfter: vm.maxHp,
      displayDelta: null,
      actorMemberId: null,
      observedAt: ctx.observedAt,
      evidence: "observed_transition",
      replay: false,
      reasonLabel: "",
      ...rest,
    } as BattleSignal;
    // The words are read when shown: the 戰鬥紀錄 follows the language.
    Object.defineProperty(signal, "reasonLabel", { get: reason, enumerable: true, configurable: true });
    return signal;
  };

  // A new run, a team just opened, history, or data still arriving: the picture as it is, nothing replayed.
  if (!prev || !sameScope(prev, next) || vm.isHistory || vm.bossState === "syncing" || prev.vm.bossState === "syncing") {
    return { signals: [make("baseline", { reason: () => tr("目前的狀態", "Where things stand"), key: `baseline@${vm.asOfSeq}` })], completionOrdinal: prev && sameScope(prev, next) ? ctx.completionOrdinal : 0 };
  }

  const out: BattleSignal[] = [];
  const counted = (o: Observation) => new Set(o.vm.countedTaskIds);
  const before = counted(prev);
  const after = counted(next);
  const task = (id: Id) => next.tasks.get(id) ?? prev.tasks.get(id);
  const revs = (ids: Id[]) => ids.map((id) => `${id}@${next.tasks.get(id)?.revision ?? 0}`).join(",");
  const titles = (ids: Id[]) => ids.map((id) => task(id)?.title ?? id);
  const actor = (ids: Id[]) => {
    const who = [...new Set(ids.map((id) => task(id)?.assigneeMemberId).filter((m): m is Id => !!m))];
    return who.length === 1 ? who[0] : null;
  };
  const group = (kind: SignalKind, ids: Id[], label: (n: number, names: string[]) => string, extra: Partial<BattleSignal> = {}) => {
    if (!ids.length) return;
    const names = titles(ids);
    out.push(make(kind, { key: revs(ids), reason: () => label(ids.length, names), actorMemberId: actor(ids), source: { taskIds: ids, memberIds: [] } as never, ...extra }));
  };

  // ── The scope: tasks that came in or went out of progress ──
  const added: Id[] = [];
  const removed: Id[] = [];
  for (const id of after) {
    if (!before.has(id) && next.tasks.get(id)?.status !== "completed") added.push(id);
  }
  for (const id of before) if (!after.has(id)) removed.push(id);
  group("scope_added", added, (n, names) => (n === 1 ? trf("新增任務:{name}", "New task: {name}", { name: names[0] }) : trf("新增 {n} 項任務", "{n} new tasks", { n })), { displayDelta: DESIGN.hpPerTask * added.length });
  group("scope_adjusted", removed, (n, names) => (n === 1 ? trf("範圍調整:{name} 不再計入", "Scope change: {name} no longer counts", { name: names[0] }) : trf("範圍調整:{n} 項任務不再計入", "Scope change: {n} tasks no longer count", { n })));

  // ── Each counted task that was there before: how it moved ──
  const accepted: Id[] = [];
  const reopened: Id[] = [];
  const handedIn: Id[] = [];
  const returned: Id[] = [];
  const returnedExplicit: Id[] = [];
  const started: Id[] = [];
  const stuck: Id[] = [];
  const freed: Id[] = [];
  for (const id of after) {
    if (!before.has(id)) continue;
    const was = prev.tasks.get(id)?.status;
    const now = next.tasks.get(id)?.status;
    if (!was || !now || was === now) continue;
    if (now === "completed") accepted.push(id);
    else if (was === "completed") reopened.push(id);
    else if (now === "reviewing") handedIn.push(id);
    else if (was === "reviewing" && (WORKING.has(now) || NOT_STARTED.has(now))) {
      const sentBack = (next.rejections?.get(id) ?? 0) > (prev.rejections?.get(id) ?? 0);
      (sentBack ? returnedExplicit : returned).push(id);
    } else if (WAITING.has(now) && !WAITING.has(was)) stuck.push(id);
    else if (WAITING.has(was) && !WAITING.has(now)) freed.push(id);
    else if (NOT_STARTED.has(was) && WORKING.has(now)) started.push(id);
  }
  group("acceptance_hit", accepted, (n, names) => (n === 1 ? trf("{name} 驗收通過", "{name} accepted", { name: names[0] }) : trf("驗收 {n} 項", "{n} accepted", { n })), { displayDelta: -DESIGN.hpPerTask * accepted.length });
  group("scope_adjusted", reopened, (n, names) => (n === 1 ? trf("任務重新開啟:{name}", "Task reopened: {name}", { name: names[0] }) : trf("{n} 項任務重新開啟", "{n} tasks reopened", { n })));
  group("delivery_waiting", handedIn, (n, names) => (n === 1 ? trf("{name} 交付,等待驗收", "{name} handed in, waiting for review", { name: names[0] }) : trf("{n} 項交付,等待驗收", "{n} handed in, waiting for review", { n })));
  group("review_returned", returnedExplicit, (n, names) => (n === 1 ? trf("{name} 被退回,需要修改", "{name} sent back for changes", { name: names[0] }) : trf("{n} 項被退回,需要修改", "{n} sent back for changes", { n })), { evidence: "explicit_event" });
  group("review_returned", returned, (n, names) => (n === 1 ? trf("{name} 返回執行", "{name} is back in progress", { name: names[0] }) : trf("{n} 項返回執行", "{n} back in progress", { n })), { evidence: "unknown" });
  group("task_started", started, (n, names) => (n === 1 ? trf("開始 {name}", "Started {name}", { name: names[0] }) : trf("開始 {n} 項任務", "Started {n} tasks", { n })));
  group("boss_counter", stuck, (n, names) => (n === 1 ? trf("{name} 卡住了", "{name} is stuck", { name: names[0] }) : trf("{n} 項任務卡住", "{n} tasks stuck", { n })));
  group("unblock_support", freed, (n, names) => (n === 1 ? trf("{name} 解除阻塞", "{name} unblocked", { name: names[0] }) : trf("{n} 項任務解除阻塞", "{n} tasks unblocked", { n })));

  // ── Members gone wrong ──
  for (const [id, status] of next.members) {
    if (status === "error" && prev.members.get(id) !== "error") {
      out.push(make("member_interrupted", { key: `${id}@${vm.asOfSeq}`, reason: () => tr("成員中斷", "Member interrupted"), actorMemberId: id, source: { memberIds: [id] } as never }));
    }
  }

  // ── The person: a question, then its answer ──
  const asked = !stuck.length && next.vm.needsHuman && !prev.vm.needsHuman;
  if (asked) out.push(make("boss_counter", { key: `human@${next.runRevision}`, reason: () => tr("等你回覆或批准", "Waiting for your reply or approval"), source: { questionIds: next.questionIds ?? [] } as never }));
  if (!next.vm.needsHuman && prev.vm.needsHuman) out.push(make("unblock_support", { key: `human@${next.runRevision}`, reason: () => tr("你回覆了,團隊繼續", "You replied, the team carries on") }));

  // ── The run: paused, reopened, sealed, won ──
  let ordinal = ctx.completionOrdinal;
  const was = prev.vm.bossState;
  const now = vm.bossState;
  if (now === "paused" && was !== "paused") out.push(make("pause", { key: `pause@${next.runRevision}`, reason: () => tr("團隊暫停", "Team paused") }));
  if (prev.runStatus === "completed" && next.runStatus !== "completed" && next.runStatus !== "failed" && next.runStatus !== "cancelled") {
    out.push(make("reopen", { key: `reopen@${next.runRevision}`, reason: () => tr("收到新指示,Leader 處理中", "New instructions in, the Leader is on it") }));
  }
  if (now === "sealing" && was !== "sealing" && was !== "defeated") out.push(make("seal_wait", { key: `seal@${vm.progress.total}@${next.runRevision}`, reason: () => tr("工作都已驗收,等待 Leader 結案", "All work accepted, waiting for the Leader to close it out") }));
  if (now === "defeated" && was !== "defeated") {
    ordinal += 1;
    out.push(make("victory", { key: `victory#${ordinal}`, reason: () => tr("Leader 結案,需求魔王被擊敗", "The Leader closed it out: the Requirements Overlord is defeated") }));
  }
  return { signals: out, completionOrdinal: ordinal };
}

/** A task list as a map, for an observation. */
export function byId(tasks: readonly TaskInput[]): Map<Id, TaskInput> {
  return new Map(tasks.map((t) => [t.taskId, t]));
}
