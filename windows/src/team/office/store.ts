// The Office's one record: a company snapshot, then the events after it, in
// order. Whatever the screens show is read from here — a member's pose, a
// bubble, a progress bar — never guessed from timers or where a Mochi stands.
//
// The rules are the contract's (feature/Agent_Office_Spec §08):
//   · a snapshot is applied whole, and sets the cursor to its asOfSeq;
//   · an event already seen (by eventId, or seq ≤ cursor) is dropped;
//   · an event past a gap waits, and the store asks for what is missing;
//   · a change never replaces a newer revision, and a deleted entity stays
//     deleted (a tombstone) against older events that would bring it back.

import { calculateProgress } from "./contracts";
import type {
  Agent,
  Artifact,
  CommandRecord,
  CompanySnapshot,
  ConnectionState,
  DomainEvent,
  EntityChange,
  EntityMap,
  Id,
  Message,
  MemberSnapshot,
  OfficeLayout,
  Progress,
  Task,
  Team,
  TeamRun,
} from "./contracts";

type Kind = keyof EntityMap;
const KINDS: Kind[] = ["agent", "team", "run", "member", "task", "message", "artifact", "layout", "command"];

export const memberKey = (runId: Id, memberId: Id) => `${runId}/${memberId}`;

function keyOf<K extends Kind>(kind: K, v: EntityMap[K]): string {
  switch (kind) {
    case "agent": return (v as Agent).agentId;
    case "team": return (v as Team).teamId;
    case "run": return (v as TeamRun).runId;
    case "member": return memberKey((v as MemberSnapshot).runId, (v as MemberSnapshot).memberId);
    case "task": return (v as Task).taskId;
    case "message": return (v as Message).messageId;
    case "artifact": return (v as Artifact).artifactId;
    case "layout": return (v as OfficeLayout).layoutId;
    default: return (v as CommandRecord).commandId;
  }
}

export type Received = "applied" | "duplicate" | "buffered" | "rejected";
export type ResyncReason = "gap" | "expired_cursor" | "scope_changed" | "unsupported_schema";

export class OfficeStore {
  streamId: Id = "";
  companyId: Id = "";
  /** The last event applied in order. */
  cursor = -1;
  serverTime: string | null = null;
  /** Waiting for what is missing before the buffered events can go in. */
  syncing = false;
  connection: ConnectionState = { status: "connecting", lastAppliedSeq: -1, lastServerTime: null };
  /** Events applied since the snapshot, newest last: what the scenes animate. */
  readonly recent: DomainEvent[] = [];

  private maps = new Map<Kind, Map<string, EntityMap[Kind]>>(KINDS.map((k) => [k, new Map()]));
  private tombstones = new Map<string, number>();
  private seen = new Set<string>();
  private buffer = new Map<number, DomainEvent>();
  private listeners = new Set<() => void>();
  private resync: (reason: ResyncReason, cursor: number) => void;

  constructor(resync: (reason: ResyncReason, cursor: number) => void = () => {}) {
    this.resync = resync;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** A whole company, replacing everything. Events already buffered past it stay. */
  loadSnapshot(s: CompanySnapshot) {
    if (s.schemaVersion !== 1) {
      this.resync("unsupported_schema", this.cursor);
      return;
    }
    // An older snapshot of the same stream never replaces a newer picture.
    if (s.streamId === this.streamId && s.asOfSeq < this.cursor) return;
    for (const m of this.maps.values()) m.clear();
    this.tombstones.clear();
    if (s.streamId !== this.streamId) this.seen.clear();
    const put = <K extends Kind>(kind: K, list: EntityMap[K][]) => {
      const m = this.maps.get(kind)!;
      for (const v of list) m.set(keyOf(kind, v), v);
    };
    put("agent", s.agents);
    put("team", s.teams);
    put("run", s.runs);
    put("member", s.members);
    put("task", s.tasks);
    put("message", s.messages);
    put("artifact", s.artifacts);
    put("layout", s.layouts);
    put("command", s.commands);
    this.streamId = s.streamId;
    this.companyId = s.companyId;
    this.cursor = s.asOfSeq;
    this.serverTime = s.serverTime;
    this.syncing = false;
    this.recent.length = 0;
    for (const seq of [...this.buffer.keys()]) if (seq <= this.cursor) this.buffer.delete(seq);
    this.drain();
    this.connection = { ...this.connection, lastAppliedSeq: this.cursor, lastServerTime: this.serverTime };
    this.changed();
  }

  /** One event from the stream. */
  receive(e: DomainEvent): Received {
    if (e.schemaVersion !== 1) {
      this.resync("unsupported_schema", this.cursor);
      return "rejected";
    }
    if (e.streamId !== this.streamId) {
      this.resync("scope_changed", this.cursor);
      return "rejected";
    }
    if (this.seen.has(e.eventId) || e.seq <= this.cursor) return "duplicate";
    if (e.seq > this.cursor + 1) {
      // Not past a gap: wait for what is missing, and ask for it once.
      const first = !this.syncing;
      this.buffer.set(e.seq, e);
      this.syncing = true;
      if (first) this.resync("gap", this.cursor);
      this.changed();
      return "buffered";
    }
    this.apply(e);
    this.drain();
    this.changed();
    return "applied";
  }

  private drain() {
    for (let next = this.buffer.get(this.cursor + 1); next; next = this.buffer.get(this.cursor + 1)) {
      this.buffer.delete(next.seq);
      if (!this.seen.has(next.eventId)) this.apply(next);
      else this.cursor = next.seq;
    }
    if (!this.buffer.size) this.syncing = false;
  }

  private apply(e: DomainEvent) {
    for (const c of e.changes) this.change(c);
    this.seen.add(e.eventId);
    this.cursor = e.seq;
    this.serverTime = e.occurredAt;
    this.connection = { ...this.connection, lastAppliedSeq: this.cursor, lastServerTime: e.occurredAt };
    this.recent.push(e);
    if (this.recent.length > 50) this.recent.shift();
  }

  private change(c: EntityChange) {
    const m = this.maps.get(c.entityKind)!;
    const tomb = `${c.entityKind}:${c.entityKey}`;
    const dead = this.tombstones.get(tomb);
    const now = m.get(c.entityKey) as { revision: number } | undefined;
    if (c.op === "delete") {
      if (now && now.revision > c.revision) return;
      m.delete(c.entityKey);
      this.tombstones.set(tomb, Math.max(dead ?? 0, c.revision));
      return;
    }
    if (dead !== undefined && dead >= c.revision) return;
    if (now && now.revision >= c.revision) return;
    m.set(c.entityKey, c.value);
  }

  setConnection(state: ConnectionState) {
    this.connection = state;
    this.changed();
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  private all<K extends Kind>(kind: K): EntityMap[K][] {
    return [...(this.maps.get(kind)!.values() as Iterable<EntityMap[K]>)];
  }

  teams(): Team[] {
    return this.all("team");
  }
  team(id: Id): Team | undefined {
    return this.maps.get("team")!.get(id) as Team | undefined;
  }
  run(id: Id): TeamRun | undefined {
    return this.maps.get("run")!.get(id) as TeamRun | undefined;
  }
  agent(id: Id): Agent | undefined {
    return this.maps.get("agent")!.get(id) as Agent | undefined;
  }
  task(id: Id): Task | undefined {
    return this.maps.get("task")!.get(id) as Task | undefined;
  }
  artifact(id: Id): Artifact | undefined {
    return this.maps.get("artifact")!.get(id) as Artifact | undefined;
  }
  layout(id: Id): OfficeLayout | undefined {
    return this.maps.get("layout")!.get(id) as OfficeLayout | undefined;
  }
  command(id: Id): CommandRecord | undefined {
    return this.maps.get("command")!.get(id) as CommandRecord | undefined;
  }
  /** A seat in the team's current run: another run's state never stands in for it. */
  member(teamId: Id, memberId: Id): MemberSnapshot | undefined {
    const team = this.team(teamId);
    if (!team) return undefined;
    return this.maps.get("member")!.get(memberKey(team.currentRunId, memberId)) as MemberSnapshot | undefined;
  }
  members(teamId: Id): MemberSnapshot[] {
    const team = this.team(teamId);
    if (!team) return [];
    return team.memberIds.map((id) => this.member(teamId, id)).filter((m): m is MemberSnapshot => !!m);
  }
  tasks(teamId: Id, runId?: Id): Task[] {
    const run = runId ?? this.team(teamId)?.currentRunId;
    return this.all("task").filter((t) => t.teamId === teamId && t.runId === run);
  }
  messages(teamId: Id, runId?: Id): Message[] {
    const run = runId ?? this.team(teamId)?.currentRunId;
    return this.all("message")
      .filter((m) => m.teamId === teamId && m.runId === run)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
  artifacts(teamId: Id, runId?: Id): Artifact[] {
    const run = runId ?? this.team(teamId)?.currentRunId;
    return this.all("artifact").filter((a) => a.teamId === teamId && a.runId === run);
  }
  commands(teamId: Id): CommandRecord[] {
    return this.all("command").filter((c) => c.teamId === teamId);
  }
  /** The board's and the Office's progress: one calculation, over the run's tasks. */
  progress(teamId: Id): Progress {
    const team = this.team(teamId);
    if (!team) return { completed: 0, total: 0, percent: null };
    return calculateProgress(this.all("task"), team.currentRunId);
  }
  /** Distinct agents across the company, and seats across its teams. */
  headcount(): { agents: number; seats: number } {
    const agents = new Set<Id>();
    let seats = 0;
    for (const t of this.teams()) {
      for (const m of this.members(t.teamId)) agents.add(m.agentId);
      seats += t.memberIds.length;
    }
    return { agents: agents.size, seats };
  }

  /** A command the person sent, known to the page before the stream says so. */
  noteCommand(c: CommandRecord) {
    const m = this.maps.get("command")!;
    const now = m.get(c.commandId) as CommandRecord | undefined;
    if (!now || now.revision < c.revision) m.set(c.commandId, c);
    this.changed();
  }
}
