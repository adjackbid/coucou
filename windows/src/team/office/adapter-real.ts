// Coucou's own Teamwork as the Office contract (feature/OFFICE-整合規劃.md §2).
//
// Coucou has no event stream with sequence numbers: the orchestrator sends a
// team's whole snapshot whenever anything changes (`team-changed`). This
// adapter turns each new picture into one contract event — every entity that
// changed, upserted with a higher revision, and every one that went away,
// deleted — so the Office runs on the same store and rules as any server
// would give it. Commands go through the existing team_* calls.

import type {
  Agent, Artifact, CommandAck, CommandRecord, CompanySnapshot, DomainEvent, EntityChange, EntityMap, Id,
  Message, MemberSnapshot, RunStatus, Task, TaskStatus, Team, TeamRun, WorkStatus, Capabilities, CommandRequest,
} from "./contracts";
import { calculateProgress } from "./contracts";
import type { MemberView, Snapshot, TeamFile, Task as CTask } from "../types";

const YOU = "you";
const SYSTEM = "system";
const iso = (ms: number) => new Date(ms || 0).toISOString();

/** A team's run: one per events.jsonl, named after when it started. */
export const runIdOf = (teamId: Id, snap: Snapshot | undefined) => (snap && snap.startedAt ? `${teamId}@${snap.startedAt}` : `${teamId}@setup`);

function taskStatus(t: CTask, snap: Snapshot): TaskStatus {
  if (t.blocked) return t.blocked.on === YOU ? "waiting_input" : "blocked";
  switch (t.status) {
    case "done": return "completed";
    case "delivered": return "reviewing";
    case "doing": return "running";
    default: {
      const ready = t.dependsOn.every((d) => {
        const dep = snap.tasks.find((x) => x.id.toLowerCase() === d.toLowerCase());
        return !dep || dep.status === "delivered" || dep.status === "done";
      });
      return ready ? "ready" : "pending";
    }
  }
}

function runStatus(snap: Snapshot | undefined): RunStatus {
  if (!snap) return "idle";
  const needsYou = snap.members.some((m) => m.status === "waitingYou" || m.status === "lost");
  switch (snap.status) {
    case "running": return needsYou ? "needs_attention" : "running";
    // Coucou's pause lets the turns under way run to their end: until they have, it is pausing.
    case "paused": return !snap.detached && snap.members.some((m) => m.status === "working") ? "pausing" : "paused";
    case "finished": return "completed";
    default: return "idle";
  }
}

function workStatus(m: MemberView, snap: Snapshot): WorkStatus {
  // A team loaded from an earlier run has no agent behind it (engineStatus
  // says so), but its record is whole: Coucou ended its open turns when it
  // read the log, so each member's state is what the run left.
  switch (m.status) {
    case "lost": return "error";
    case "waitingYou": return "waiting_input";
    case "waitingReply": return "blocked";
    case "waitingDelivery": return snap.status === "paused" ? "paused" : "waiting_dependency";
    case "done": return "completed";
    // Coucou reads planning and reviewing from the board, never from what the agent wrote.
    case "working": return m.phase ?? "working";
    default: return snap.status === "paused" ? "paused" : "idle";
  }
}

const NEXT: Partial<Record<WorkStatus, string>> = {
  waiting_dependency: "收到交付後繼續",
  waiting_input: "等你回覆或批准",
  blocked: "等對方回覆",
};

/** A team file as an earlier run recorded it: who was in it then, who led. */
export function fileFromSnapshot(snap: Snapshot): TeamFile {
  const leader = snap.members.find((m) => m.isLeader)?.id ?? snap.members[0]?.id ?? "";
  return {
    file: `${snap.id}.json`,
    problems: [],
    config: {
      id: snap.id, name: snap.name, goal: snap.goal, scope: [], workDir: snap.workDir, leader, autoApprove: false,
      members: snap.members.map((m) => ({ id: m.id, name: m.name, role: m.role, duty: m.duty, agent: m.agent, model: m.model, color: m.color })),
      links: [], expected: [], directTalk: true, sharedBoard: true, maxTurns: snap.maxTurns,
    },
  };
}

/** One team, as contract entities. */
export function teamEntities(file: TeamFile, snap: Snapshot | undefined, revision: number) {
  const cfg = file.config!;
  const teamId = cfg.id;
  const runId = runIdOf(teamId, snap);
  const at = iso(snap?.finishedAt || snap?.startedAt || 0);
  const v = { revision, updatedAt: at };
  const people = snap?.members ?? [];
  const tasks: Task[] = (snap?.tasks ?? []).map((t) => ({
    ...v, taskId: `${teamId}:${t.id}`, teamId, runId, title: t.title, assigneeMemberId: t.owner || null,
    status: taskStatus(t, snap!), parentTaskId: null, dependencyTaskIds: t.dependsOn.map((d) => `${teamId}:${d}`),
    includeInProgress: true, acceptanceCriteria: t.criteria.map((c, i) => ({ id: String(i), text: c.text, passed: c.claimed })),
    updatedAt: iso(t.updatedAt),
  }));
  const members: MemberSnapshot[] = cfg.members.map((c, i) => {
    const m = people.find((p) => p.id === c.id);
    const ws: WorkStatus = m && snap ? workStatus(m, snap) : "idle";
    const open = (snap?.tasks ?? []).filter((t) => t.owner === c.id && (t.status === "todo" || t.status === "doing"));
    const dep = m?.waiting?.task ? snap!.tasks.find((t) => t.id === m.waiting!.task) : undefined;
    const depOn = dep?.dependsOn.map((d) => snap!.tasks.find((t) => t.id === d)).find((t) => t && t.status !== "done" && t.status !== "delivered");
    return {
      ...v, memberId: c.id, agentId: c.agent || c.id, teamId, runId, roleLabel: c.role,
      workStatus: ws, engineStatus: !snap || snap.detached || m?.status === "lost" ? (snap ? "offline" : "unknown") : "online",
      primaryTaskId: m?.task ? `${teamId}:${m.task}` : null,
      activeTaskIds: open.map((t) => `${teamId}:${t.id}`),
      lastCompletedTaskId: null,
      summary: m?.activity || (m?.task ? snap!.tasks.find((t) => t.id === m.task)?.title ?? "" : ""),
      waitingFor: m?.waiting ? {
        reason: m.waiting.what,
        memberIds: m.waiting.on && m.waiting.on !== YOU ? [m.waiting.on] : [],
        taskIds: m.waiting.task ? [`${teamId}:${m.waiting.task}`] : [],
        expectedArtifact: depOn?.title ?? null,
        nextAction: NEXT[ws] ?? "",
      } : null,
      lastActivityAt: iso(Math.max(0, ...(m?.screen ?? []).map((l) => l.at))),
      displayName: c.name || c.id,
      color: m?.color || c.color || ["#3B9EFF", "#34D399", "#A78BFA", "#F5A524", "#F472B6", "#22D3EE"][i % 6],
    };
  });
  const msgs: Message[] = (snap?.messages ?? []).map((m) => ({
    ...v, messageId: `${teamId}:${m.id}`, teamId, runId, threadId: m.task ? `${teamId}:${m.task}` : `${teamId}:general`,
    taskId: m.task ? `${teamId}:${m.task}` : null,
    from: m.from === YOU ? { kind: "user", userId: YOU, displayName: "你" } : m.from === SYSTEM ? { kind: "system" } : { kind: "member", memberId: m.from },
    toMemberIds: m.to && m.to !== YOU && m.to !== SYSTEM ? [m.to] : [],
    kind: m.from === YOU ? "instruction" : "message", text: m.text, deliveryStatus: m.heard ? "delivered" : "sent",
    artifactIds: [], occurredAt: iso(m.at),
  }));
  for (const q of snap?.questions ?? []) {
    msgs.push({
      ...v, messageId: `${teamId}:${q.id}`, teamId, runId, threadId: q.task ? `${teamId}:${q.task}` : `${teamId}:general`,
      taskId: q.task ? `${teamId}:${q.task}` : null, from: { kind: "member", memberId: q.by }, toMemberIds: [],
      kind: "question", text: q.question, deliveryStatus: "delivered", artifactIds: [], occurredAt: iso(q.at),
    });
  }
  const versions = new Map<string, number>();
  const artifacts: Artifact[] = (snap?.deliverables ?? []).map((d) => {
    const n = (versions.get(d.task) ?? 0) + 1;
    versions.set(d.task, n);
    const kind = /\.(png|jpe?g|gif|webp|svg)$/i.test(d.locator) ? "image" : /^https?:/i.test(d.locator) ? "website" : /\.(md|txt|pdf|docx?)$/i.test(d.locator) ? "document" : d.kind === "code" ? "code" : "bundle";
    return { ...v, artifactId: `${teamId}:${d.id}`, teamId, runId, taskId: `${teamId}:${d.task}`, authorMemberId: d.by, name: d.summary || d.locator, kind, artifactVersion: n, resourceRef: d.locator, updatedAt: iso(d.at) };
  });
  const team: Team = { ...v, teamId, name: cfg.name || "未命名的團隊", goal: cfg.goal, memberIds: cfg.members.map((m) => m.id), leaderMemberId: cfg.leader, currentRunId: runId, officeLayoutId: teamId };
  const run: TeamRun = { ...v, runId, teamId, status: runStatus(snap), progress: calculateProgress(tasks, runId) };
  const agents: Agent[] = cfg.members.map((c) => ({ ...v, agentId: c.agent || c.id, name: c.agent || c.id, avatarKey: c.agent || c.id }));
  return { agents, team, run, members, tasks, messages: msgs, artifacts };
}

type Bag = { [K in keyof EntityMap]: Map<string, EntityMap[K]> };
const keyOf = (kind: keyof EntityMap, v: any): string =>
  kind === "member" ? `${v.runId}/${v.memberId}` : v[{ agent: "agentId", team: "teamId", run: "runId", task: "taskId", message: "messageId", artifact: "artifactId", layout: "layoutId", command: "commandId" }[kind as Exclude<keyof EntityMap, "member">]];

/**
 * Keeps the last picture of every entity and turns the next picture into an
 * event: what changed and what went. Revisions only grow.
 */
export class RealAdapter {
  readonly streamId = `local:${Date.now()}`;
  private seq = 0;
  private last: Partial<Bag> = {};
  private revisions = new Map<string, number>();
  private commands = new Map<Id, CommandRecord>();
  /** Each instruction's message, once Coucou has recorded it. */
  private messageOf = new Map<Id, string>();

  constructor(
    private send: {
      pause: (team: Id) => Promise<unknown>;
      resume: (team: Id) => Promise<unknown>;
      instruct: (team: Id, text: string, request: string) => Promise<string>;
    },
  ) {}

  private collect(files: TeamFile[], runs: Map<string, Snapshot>): Bag {
    const bag = Object.fromEntries((["agent", "team", "run", "member", "task", "message", "artifact", "layout", "command"] as const).map((k) => [k, new Map()])) as unknown as Bag;
    for (const f of files) {
      if (!f.config) continue;
      const e = teamEntities(f, runs.get(f.config.id), 0);
      for (const a of e.agents) bag.agent.set(keyOf("agent", a), a);
      bag.team.set(e.team.teamId, e.team);
      bag.run.set(e.run.runId, e.run);
      for (const m of e.members) bag.member.set(keyOf("member", m), m);
      for (const t of e.tasks) bag.task.set(t.taskId, t);
      for (const m of e.messages) bag.message.set(m.messageId, m);
      for (const a of e.artifacts) bag.artifact.set(a.artifactId, a);
    }
    for (const c of this.commands.values()) bag.command.set(c.commandId, c);
    return bag;
  }

  /** The company as it stands, for a store starting out. */
  snapshot(files: TeamFile[], runs: Map<string, Snapshot>): CompanySnapshot {
    this.diff(files, runs); // brings revisions up to date
    const b = this.last as Bag;
    return {
      schemaVersion: 1, companyId: "local", streamId: this.streamId, asOfSeq: this.seq, serverTime: new Date().toISOString(),
      agents: [...b.agent.values()], teams: [...b.team.values()], runs: [...b.run.values()], members: [...b.member.values()],
      tasks: [...b.task.values()], messages: [...b.message.values()], artifacts: [...b.artifact.values()], layouts: [], commands: [...b.command.values()],
    };
  }

  /** The next picture, as an event; null when nothing changed. */
  diff(files: TeamFile[], runs: Map<string, Snapshot>): DomainEvent | null {
    const next = this.collect(files, runs);
    const changes: EntityChange[] = [];
    for (const kind of Object.keys(next) as (keyof EntityMap)[]) {
      const before = (this.last[kind] ?? new Map()) as Map<string, any>;
      const now = next[kind] as Map<string, any>;
      for (const [key, value] of now) {
        const old = before.get(key);
        const strip = (x: any) => JSON.stringify({ ...x, revision: 0, updatedAt: "" });
        const rk = `${kind}:${key}`;
        if (old && strip(old) === strip(value)) {
          value.revision = old.revision;
          continue;
        }
        const revision = (this.revisions.get(rk) ?? 0) + 1;
        this.revisions.set(rk, revision);
        value.revision = revision;
        changes.push({ entityKind: kind, entityKey: key, revision, op: "upsert", value } as EntityChange);
      }
      for (const [key, old] of before) {
        if (now.has(key)) continue;
        const rk = `${kind}:${key}`;
        const revision = (this.revisions.get(rk) ?? 0) + 1;
        this.revisions.set(rk, revision);
        changes.push({ entityKind: kind, entityKey: key, revision, op: "delete", teamId: old.teamId, runId: old.runId } as EntityChange);
      }
    }
    this.last = next;
    if (!changes.length) return null;
    this.seq += 1;
    return { schemaVersion: 1, streamId: this.streamId, eventId: `${this.streamId}#${this.seq}`, seq: this.seq, occurredAt: new Date().toISOString(), type: "entities.changed", changes };
  }

  capabilities(run: TeamRun | undefined): Capabilities {
    const status = run?.status;
    const live = status === "running" || status === "needs_attention";
    return {
      canPause: live,
      canResume: status === "paused",
      canSendInstruction: live || status === "paused" || status === "pausing",
      pauseMode: "cooperative",
      unavailableReasons: {
        ...(live ? {} : { pause: status === "pausing" ? "正在暫停:還在做的成員會把這一輪做完" : "團隊沒有在執行" }),
        ...(status === "paused" ? {} : { resume: "團隊沒有暫停" }),
        ...(live || status === "paused" || status === "pausing" ? {} : { instruction: "團隊啟動後才能補充指示" }),
      },
    };
  }

  /**
   * Coucou's calls answer once the command is taken: that is `accepted`.
   * `applied` comes only when a later picture shows its effect (see settle).
   * A retry with the same clientRequestId is the same command.
   */
  async sendCommand(req: CommandRequest): Promise<CommandAck> {
    const known = [...this.commands.values()].find((c) => c.clientRequestId === req.clientRequestId);
    if (known && known.status !== "failed") return { commandId: known.commandId, clientRequestId: req.clientRequestId, status: "accepted", acceptedAt: known.createdAt };
    const commandId = known?.commandId ?? `cmd-${req.clientRequestId}`;
    const createdAt = new Date().toISOString();
    const record: CommandRecord = {
      commandId, clientRequestId: req.clientRequestId, teamId: req.teamId, runId: req.runId, kind: req.kind,
      status: "accepted", createdAt, errorCode: null, errorMessage: null, revision: (known?.revision ?? 0) + 1, updatedAt: createdAt,
    };
    this.commands.set(commandId, record);
    try {
      if (req.kind === "pause") await this.send.pause(req.teamId);
      else if (req.kind === "resume") await this.send.resume(req.teamId);
      else if (req.payload) this.messageOf.set(commandId, await this.send.instruct(req.teamId, req.payload.text, req.clientRequestId));
    } catch (err) {
      const failed = { ...record, status: "failed" as const, errorCode: "rejected", errorMessage: String(err instanceof Error ? err.message : err), revision: record.revision + 1 };
      this.commands.set(commandId, failed);
      throw Object.assign(new Error(failed.errorMessage), { command: failed });
    }
    return { commandId, clientRequestId: req.clientRequestId, status: "accepted", acceptedAt: createdAt };
  }

  /** Commands whose effect shows in the newest pictures become applied. */
  settle(runs: Map<string, Snapshot>) {
    for (const c of this.commands.values()) {
      if (c.status !== "accepted" && c.status !== "applying") continue;
      const snap = runs.get(c.teamId);
      if (!snap) continue;
      let status: CommandRecord["status"] = c.status;
      if (c.kind === "pause") status = snap.status === "paused" ? (snap.members.some((m) => m.status === "working") ? "applying" : "applied") : status;
      else if (c.kind === "resume") status = snap.status === "running" ? "applied" : status;
      else if (c.kind === "instruction") {
        // Recorded is applying; the leader having heard it is applied.
        const msg = snap.messages.find((m) => m.id === this.messageOf.get(c.commandId));
        status = msg?.heard ? "applied" : msg ? "applying" : status;
      }
      if (status !== c.status) this.commands.set(c.commandId, { ...c, status, revision: c.revision + 1, updatedAt: new Date().toISOString() });
    }
  }
}
