// 示範資料: the contract's company (feature/contracts) for looking at the
// Office without a team at work — four rooms, and the four events after the
// snapshot played one by one. Every screen showing it says so. Commands are
// answered the way a server would: accepted at once, applied by a later event.

import type { Capabilities, CommandAck, CommandRecord, CommandRequest, CompanySnapshot, DomainEvent, TeamRun } from "./contracts";
import snapshotJson from "./fixtures/company.snapshot.json";
import eventsJson from "./fixtures/events.json";

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

  constructor() {
    // Names and colours, Coucou's extension, from the agents of the fixture.
    for (const m of this.snap.members) {
      const agent = this.snap.agents.find((a) => a.agentId === m.agentId);
      m.displayName = agent?.name ?? m.agentId;
      m.color = PALETTE[agent?.avatarKey ?? ""] ?? "#3B9EFF";
    }
    this.seq = Math.max(this.snap.asOfSeq, ...this.events.map((e) => e.seq));
  }

  snapshot(): CompanySnapshot {
    return structuredClone(this.snap);
  }

  subscribe(onEvent: (e: DomainEvent) => void) {
    this.emit = onEvent;
  }

  /** The next recorded event, if any is left. */
  step(): boolean {
    const e = this.events[this.next++];
    if (!e) return false;
    this.emit(structuredClone(e));
    return true;
  }

  capabilities(run: TeamRun | undefined): Capabilities {
    const live = run?.status === "running" || run?.status === "needs_attention";
    return {
      canPause: live, canResume: run?.status === "paused", canSendInstruction: !!run && run.status !== "completed",
      pauseMode: "cooperative",
      unavailableReasons: {
        ...(live ? {} : { pause: "團隊沒有在執行" }),
        ...(run?.status === "paused" ? {} : { resume: "團隊沒有暫停" }),
        ...(run && run.status !== "completed" ? {} : { instruction: "團隊已結束" }),
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
      if (req.kind === "pause" || req.kind === "resume") {
        const run = this.snap.runs.find((r) => r.runId === req.runId);
        if (run) changes.push({ entityKind: "run", entityKey: run.runId, revision: 100 + this.seq, op: "upsert", value: { ...run, status: req.kind === "pause" ? "paused" : "running", revision: 100 + this.seq, updatedAt: applied.updatedAt } });
      }
      if (req.kind === "instruction") {
        const leader = this.snap.teams.find((t) => t.teamId === req.teamId)?.leaderMemberId;
        changes.push({ entityKind: "message", entityKey: `demo-msg-${rec.commandId}`, revision: 1, op: "upsert", value: {
          messageId: `demo-msg-${rec.commandId}`, teamId: req.teamId, runId: req.runId, threadId: "general", taskId: null,
          from: { kind: "user", userId: "you", displayName: "你" }, toMemberIds: leader ? [leader] : [], kind: "instruction",
          text: req.payload.text, deliveryStatus: "delivered", artifactIds: [], occurredAt: applied.updatedAt, revision: 1, updatedAt: applied.updatedAt } });
      }
      this.emit({ schemaVersion: 1, streamId: this.snap.streamId, eventId: `demo-${rec.commandId}`, seq: ++this.seq, occurredAt: applied.updatedAt, type: "command.updated", changes });
    }, 1200);
    return { commandId: rec.commandId, clientRequestId: rec.clientRequestId, status: "accepted", acceptedAt: now };
  }
}
