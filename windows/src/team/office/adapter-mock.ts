// 示範資料: the contract's company (feature/contracts) for looking at the
// Office without a team at work — four rooms, and the four events after the
// snapshot played one by one. Every screen showing it says so. Commands are
// answered the way a server would: accepted at once, applied by a later event.
// The fixture is in Chinese; in English its words come from demo-en.json.

import type { Capabilities, CommandAck, CommandRecord, CommandRequest, CompanySnapshot, DomainEvent, EntityMap, TeamRun } from "./contracts";
import { lang, tr } from "../../core/i18n";
import { keyOf } from "./store";
import snapshotJson from "./fixtures/company.snapshot.json";
import eventsJson from "./fixtures/events.json";
import demoEn from "./fixtures/demo-en.json";

const EN = demoEn as Record<string, string>;

/** A copy of the demo's data in the language in use: the fixture's words, and "Name 2" for a copied team. */
function localize<T>(x: T): T {
  const copy = structuredClone(x);
  if (lang() !== "en") return copy;
  const word = (s: string) => {
    if (EN[s]) return EN[s];
    const n = /^(.*) (\d+)$/.exec(s);
    return n && EN[n[1]] ? `${EN[n[1]]} ${n[2]}` : s;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return word(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, walk(w)]));
    return v;
  };
  return walk(copy) as T;
}

/** Where each kind of entity lives in a snapshot. */
const LISTS: { [K in keyof EntityMap]: keyof CompanySnapshot } = {
  agent: "agents", team: "teams", run: "runs", member: "members", task: "tasks",
  message: "messages", artifact: "artifacts", layout: "layouts", command: "commands",
};

const PALETTE: Record<string, string> = {
  "agent-claude": "#F59E0B", "agent-codex": "#34D399", "agent-codex2": "#A78BFA",
  "agent-ai1": "#3B9EFF", "agent-ai2": "#34D399", "agent-ai3": "#A78BFA", "agent-ai4": "#F5A524",
  "agent-ai5": "#F472B6", "agent-ai6": "#A78BFA", "agent-ai7": "#22D3EE",
};

export class MockAdapter {
  readonly demo = true;
  private snap = structuredClone(snapshotJson) as unknown as CompanySnapshot;
  private events = structuredClone(eventsJson) as unknown as DomainEvent[];
  private seq: number;
  private next = 0;
  private commands = new Map<string, CommandRecord>();
  private emit: (e: DomainEvent) => void = () => {};
  /** Every event sent so far, as recorded: a snapshot in another language includes them. */
  private played: DomainEvent[] = [];

  /** `rooms` > 4 copies the demo teams, for checking a busy company (`?office=mock&rooms=20`). */
  constructor(rooms = 4) {
    // Names and colours, Coucou's extension, from the agents of the fixture.
    for (const m of this.snap.members) this.dress(m);
    this.seq = Math.max(this.snap.asOfSeq, ...this.events.map((e) => e.seq));
    for (let n = 1; this.snap.teams.length < rooms; n++) {
      const s = this.snap;
      const base = { teams: [...s.teams], runs: [...s.runs], members: [...s.members], tasks: [...s.tasks], messages: [...s.messages], artifacts: [...s.artifacts] };
      for (const t of base.teams) {
        if (s.teams.length >= rooms) break;
        const id = (x: string) => `${x}~${n}`;
        s.teams.push({ ...t, teamId: id(t.teamId), name: `${t.name} ${n + 1}`, currentRunId: id(t.currentRunId) });
        s.runs.push(...base.runs.filter((r) => r.teamId === t.teamId).map((r) => ({ ...r, runId: id(r.runId), teamId: id(t.teamId) })));
        s.members.push(...base.members.filter((m) => m.teamId === t.teamId).map((m) => ({ ...m, teamId: id(t.teamId), runId: id(m.runId) })));
        s.tasks.push(...base.tasks.filter((x) => x.teamId === t.teamId).map((x) => ({ ...x, taskId: id(x.taskId), teamId: id(t.teamId), runId: id(x.runId) })));
        s.messages.push(...base.messages.filter((x) => x.teamId === t.teamId).map((x) => ({ ...x, messageId: id(x.messageId), teamId: id(t.teamId), runId: id(x.runId) })));
        s.artifacts.push(...base.artifacts.filter((x) => x.teamId === t.teamId).map((x) => ({ ...x, artifactId: id(x.artifactId), teamId: id(t.teamId), runId: id(x.runId) })));
      }
    }
  }

  /** A member's name and colour, from its agent: the recorded events carry neither. */
  private dress(m: CompanySnapshot["members"][number]) {
    const agent = this.snap.agents.find((a) => a.agentId === m.agentId);
    m.displayName = agent?.name ?? m.agentId;
    m.color = PALETTE[agent?.avatarKey ?? ""] ?? "#3B9EFF";
  }

  /** The company as it stands now — the fixture and every event sent since — in the language in use. */
  snapshot(): CompanySnapshot {
    const s = structuredClone(this.snap);
    for (const e of this.played) {
      for (const c of e.changes ?? []) {
        const list = s[LISTS[c.entityKind]] as unknown as EntityMap[keyof EntityMap][];
        const at = list.findIndex((v) => keyOf(c.entityKind, v as never) === c.entityKey);
        if (c.op === "upsert") {
          if (at < 0) list.push(c.value);
          else list[at] = c.value;
        } else if (at >= 0) list.splice(at, 1);
      }
      s.asOfSeq = Math.max(s.asOfSeq, e.seq);
    }
    return localize(s);
  }

  /** An event to the Office, in the language in use; kept as recorded for the next snapshot. */
  private send(e: DomainEvent) {
    this.played.push(e);
    this.emit(localize(e));
  }

  subscribe(onEvent: (e: DomainEvent) => void) {
    this.emit = onEvent;
  }

  /** The next recorded event, if any is left. */
  step(): boolean {
    const e = this.events[this.next++];
    if (!e) return false;
    const copy = structuredClone(e);
    for (const c of copy.changes ?? []) if (c.entityKind === "member" && c.op === "upsert") this.dress(c.value);
    this.send(copy);
    return true;
  }

  capabilities(run: TeamRun | undefined): Capabilities {
    const live = run?.status === "running" || run?.status === "needs_attention";
    return {
      canPause: live, canResume: run?.status === "paused", canSendInstruction: !!run,
      pauseMode: "cooperative",
      unavailableReasons: {
        ...(live ? {} : { pause: tr("團隊沒有在執行", "The team isn't running") }),
        ...(run?.status === "paused" ? {} : { resume: tr("團隊沒有暫停", "The team isn't paused") }),
        ...(run ? {} : { instruction: tr("團隊還沒有開始", "The team hasn't started yet") }),
      },
    };
  }

  async sendCommand(req: CommandRequest): Promise<CommandAck> {
    const known = [...this.commands.values()].find((c) => c.clientRequestId === req.clientRequestId);
    if (known) return { commandId: known.commandId, clientRequestId: known.clientRequestId, status: "accepted", acceptedAt: known.createdAt };
    const now = new Date().toISOString();
    const rec: CommandRecord = { commandId: `demo-cmd-${this.commands.size + 1}`, clientRequestId: req.clientRequestId, teamId: req.teamId, runId: req.runId,
      kind: req.kind, status: "accepted", createdAt: now, errorCode: null, errorMessage: null, revision: 1, updatedAt: now };
    this.commands.set(rec.commandId, rec);
    // A server would apply it a moment later and say so on the stream.
    window.setTimeout(() => {
      // The recorded events come first: the stream stays in order.
      while (this.step());
      const applied = { ...rec, status: "applied" as const, revision: 2, updatedAt: new Date().toISOString() };
      this.commands.set(rec.commandId, applied);
      const changes: DomainEvent["changes"] = [{ entityKind: "command", entityKey: rec.commandId, revision: 2, op: "upsert", value: applied }];
      const finished = this.snap.runs.find((r) => r.runId === req.runId && r.status === "completed");
      if (req.kind === "instruction" && finished) {
        // Like Coucou: words to a finished team start it again.
        changes.push({ entityKind: "run", entityKey: finished.runId, revision: 100 + this.seq, op: "upsert", value: { ...finished, status: "running", revision: 100 + this.seq, updatedAt: applied.updatedAt } });
      }
      if (req.kind === "pause" || req.kind === "resume") {
        const run = this.snap.runs.find((r) => r.runId === req.runId);
        if (run) changes.push({ entityKind: "run", entityKey: run.runId, revision: 100 + this.seq, op: "upsert", value: { ...run, status: req.kind === "pause" ? "paused" : "running", revision: 100 + this.seq, updatedAt: applied.updatedAt } });
      }
      if (req.kind === "instruction") {
        const leader = this.snap.teams.find((t) => t.teamId === req.teamId)?.leaderMemberId;
        changes.push({ entityKind: "message", entityKey: `demo-msg-${rec.commandId}`, revision: 1, op: "upsert", value: {
          messageId: `demo-msg-${rec.commandId}`, teamId: req.teamId, runId: req.runId, threadId: "general", taskId: null,
          from: { kind: "user", userId: "you", displayName: tr("你", "You") }, toMemberIds: leader ? [leader] : [], kind: "instruction",
          text: req.payload.text, deliveryStatus: "delivered", artifactIds: [], occurredAt: applied.updatedAt, revision: 1, updatedAt: applied.updatedAt } });
      }
      this.send({ schemaVersion: 1, streamId: this.snap.streamId, eventId: `demo-${rec.commandId}`, seq: ++this.seq, occurredAt: applied.updatedAt, type: "command.updated", changes });
    }, 1200);
    return { commandId: rec.commandId, clientRequestId: rec.clientRequestId, status: "accepted", acceptedAt: now };
  }
}
