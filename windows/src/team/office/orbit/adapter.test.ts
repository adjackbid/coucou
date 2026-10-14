// The scene is read from the store, and only from it: the leader's ties,
// the team file's links, real messages once each, nothing invented.

import { describe, expect, it } from "vitest";
import { setLang } from "../../../core/i18n";
import type { CompanySnapshot, DomainEvent, Message, Artifact } from "../contracts";
import { OfficeStore } from "../store";
import { OrbitFeed, agentStatus, hubOf, sceneFrom, teamColor } from "./adapter";
import { agentKey } from "./contracts";

const now = "2026-10-07T00:00:00.000Z";
const v = { revision: 1, updatedAt: now };

function company(): CompanySnapshot {
  const member = (teamId: string, id: string, extra: Partial<CompanySnapshot["members"][number]> = {}) => ({
    ...v, memberId: id, agentId: id, teamId, runId: `${teamId}@r`, roleLabel: "開發", workStatus: "working" as const, engineStatus: "online" as const,
    primaryTaskId: null, activeTaskIds: [], lastCompletedTaskId: null, summary: "", waitingFor: null, lastActivityAt: now, displayName: id.toUpperCase(), color: "#65b5f2", ...extra,
  });
  return {
    schemaVersion: 1, companyId: "c", streamId: "s", asOfSeq: 0, serverTime: now, agents: [], layouts: [], commands: [], tasks: [], messages: [], artifacts: [],
    teams: [
      { ...v, teamId: "t1", name: "測試用", goal: "", memberIds: ["ai1", "ai2"], leaderMemberId: "ai1", currentRunId: "t1@r", officeLayoutId: "auto" },
      { ...v, teamId: "t2", name: "五人", goal: "", memberIds: ["ai1", "ai2", "ai3", "ai4", "ai5"], leaderMemberId: "ai1", currentRunId: "t2@r", officeLayoutId: "auto" },
      { ...v, teamId: "t3", name: "無隊長", goal: "", memberIds: ["b", "a"], leaderMemberId: "nobody", currentRunId: "t3@r", officeLayoutId: "auto" },
      { ...v, teamId: "t4", name: "封存", goal: "", memberIds: ["x"], leaderMemberId: "x", currentRunId: "t4@r", officeLayoutId: "auto", archived: true },
    ],
    runs: ["t1", "t2", "t3", "t4"].map((t) => ({ ...v, runId: `${t}@r`, teamId: t, status: "running" as const, progress: { completed: 0, total: 0, percent: null } })),
    members: [
      member("t1", "ai1"), member("t1", "ai2", { workStatus: "completed" }),
      member("t2", "ai1"), member("t2", "ai2"), member("t2", "ai3", { workStatus: "waiting_dependency" }), member("t2", "ai4", { workStatus: "error" }), member("t2", "ai5", { engineStatus: "offline", workStatus: "idle" }),
      member("t3", "b"), member("t3", "a", { workStatus: "unknown" }),
      member("t4", "x"),
    ],
  };
}

function store(snapshot = company()) {
  const s = new OfficeStore();
  s.loadSnapshot(snapshot);
  return s;
}

const event = (seq: number, changes: DomainEvent["changes"]): DomainEvent => ({ schemaVersion: 1, streamId: "s", eventId: `e${seq}`, seq, occurredAt: now, type: "entities.changed", changes });
// As the real adapter builds them: `updatedAt` is the run's start, never when the message was read.
const runStart = "2026-10-06T20:00:00.000Z";
const message = (id: string, from: string, to: string[], extra: Partial<Message> = {}): Message => ({
  ...v, updatedAt: runStart, messageId: `t2:${id}`, teamId: "t2", runId: "t2@r", threadId: "t2:general", taskId: null, from: { kind: "member", memberId: from }, toMemberIds: to,
  kind: "message", text: "功能規格寫好了,請看一下這份很長很長的文字會被截短", deliveryStatus: "sent", artifactIds: [], occurredAt: now, ...extra,
});

describe("sceneFrom", () => {
  it("maps teams, members and their real statuses; archived teams stay out", () => {
    const scene = sceneFrom(store(), new Map(), "live");
    expect(scene.teams.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(scene.agents.filter((a) => a.teamId === "t4")).toHaveLength(0);
    const by = (id: string) => scene.agents.find((a) => a.id === id)!;
    expect(by(agentKey("t1", "ai2")).status).toBe("done");
    expect(by(agentKey("t2", "ai3")).status).toBe("waiting");
    expect(by(agentKey("t2", "ai4")).status).toBe("error");
    expect(by(agentKey("t2", "ai5")).status).toBe("offline");
    expect(by(agentKey("t3", "a")).status).toBe("unknown");
    expect(by(agentKey("t1", "ai1")).name).toBe("AI1");
    // The same member id in two teams is two agents.
    expect(by(agentKey("t1", "ai1")).id).not.toBe(by(agentKey("t2", "ai1")).id);
  });

  it("ties the leader to every member: one line for two, four for five", () => {
    const scene = sceneFrom(store(), new Map(), "live");
    const core = scene.relations.filter((r) => r.kind === "team_connection");
    expect(core.filter((r) => r.fromAgentId.startsWith("t1/"))).toHaveLength(1);
    expect(core.filter((r) => r.fromAgentId.startsWith("t2/"))).toHaveLength(4);
    expect(core.every((r) => r.fromAgentId.split("/")[0] === r.toAgentId.split("/")[0])).toBe(true);
  });

  it("uses the smallest id as the hub of a team without a leader, without naming it leader", () => {
    const scene = sceneFrom(store(), new Map(), "live");
    const t3 = scene.teams.find((t) => t.id === "t3")!;
    expect(t3.leaderAgentId).toBeUndefined();
    expect(scene.relations.filter((r) => r.fromAgentId.startsWith("t3/"))).toEqual([expect.objectContaining({ fromAgentId: "t3/a", toAgentId: "t3/b", kind: "team_connection" })]);
    expect(scene.agents.filter((a) => a.teamId === "t3")[0].id).toBe("t3/a");
  });

  it("adds the team file's links as workflow lines, once per pair, only between members that exist", () => {
    const links = new Map([["t2", [
      { from: "ai2", to: "ai3", kind: "delivery" },
      { from: "ai3", to: "ai2", kind: "talk" },
      { from: "ai1", to: "ai2", kind: "delivery" },
      { from: "ai2", to: "ghost", kind: "delivery" },
    ]]]);
    const scene = sceneFrom(store(), links, "live");
    const flow = scene.relations.filter((r) => r.kind === "workflow");
    expect(flow).toEqual([expect.objectContaining({ fromAgentId: "t2/ai2", toAgentId: "t2/ai3" })]);
  });

  it("gives a team the same colour whatever the order of the list", () => {
    expect(teamColor("t1")).toBe(teamColor("t1"));
    expect(hubOf({ leaderMemberId: "z" }, [{ memberId: "k" }, { memberId: "c" }])).toBe("c");
    expect(agentStatus({ workStatus: "completed", engineStatus: "offline" })).toBe("done");
    expect(agentStatus({ workStatus: "paused", engineStatus: "online" })).toBe("idle");
  });
});

describe("OrbitFeed", () => {
  it("opens quiet: what is already in the record is noted, not played", () => {
    const snap = company();
    snap.messages.push(message("m0", "ai1", ["ai2"]));
    const s = store(snap);
    const feed = new OrbitFeed();
    expect(feed.pull(s, Date.parse(now))).toEqual([]);
    expect(feed.pull(s, Date.parse(now))).toEqual([]);
  });

  it("plays a new message once per recipient, then its reading, and never again", () => {
    const s = store();
    const feed = new OrbitFeed();
    feed.pull(s, Date.parse(now));
    s.receive(event(1, [{ entityKind: "message", entityKey: "t2:m1", revision: 2, op: "upsert", value: message("m1", "ai1", ["ai2", "ai3"]) }]));
    const first = feed.pull(s, Date.parse(now));
    expect(first.map((e) => e.type)).toEqual(["message_sent", "message_sent"]);
    expect(first.map((e) => (e.type === "message_sent" ? e.toAgentId : ""))).toEqual(["t2/ai2", "t2/ai3"]);
    expect((first[0] as { summary: string }).summary.length).toBeLessThanOrEqual(37);
    expect(feed.pull(s, Date.parse(now))).toEqual([]);
    // Read an hour later: the reading has no time of its own in the record, so it is "now".
    const later = Date.parse(now) + 3_600_000;
    s.receive(event(2, [{ entityKind: "message", entityKey: "t2:m1", revision: 3, op: "upsert", value: message("m1", "ai1", ["ai2", "ai3"], { deliveryStatus: "delivered" }) }]));
    const read = feed.pull(s, later);
    expect(read.map((e) => e.type)).toEqual(["message_received", "message_received"]);
    expect(read.every((e) => Date.parse(e.occurredAt) === later)).toBe(true);
    expect(feed.pull(s, later)).toEqual([]);
  });

  it("plays the same message id again when the team was started over: a new run numbers from 1", () => {
    const snap = company();
    snap.messages.push(message("m1", "ai1", ["ai2"]));
    const s = store(snap);
    const feed = new OrbitFeed();
    feed.pull(s, Date.parse(now));
    // 重新開始: a new run, the same members, and t2:m1 is a brand-new message.
    const team = snap.teams.find((t) => t.teamId === "t2")!;
    const run2 = "t2@r2";
    s.receive(event(1, [
      { entityKind: "team", entityKey: "t2", revision: 2, op: "upsert", value: { ...team, revision: 2, currentRunId: run2 } },
      { entityKind: "run", entityKey: run2, revision: 1, op: "upsert", value: { ...v, runId: run2, teamId: "t2", status: "running", progress: { completed: 0, total: 0, percent: null } } },
      ...snap.members.filter((m) => m.teamId === "t2").map((m) => ({ entityKind: "member" as const, entityKey: `${run2}/${m.memberId}`, revision: 1, op: "upsert" as const, value: { ...m, runId: run2 } })),
      { entityKind: "message", entityKey: "t2:m1", revision: 2, op: "upsert", value: message("m1", "ai1", ["ai2"], { runId: run2, text: "新的一輪的第一句" }) },
    ]));
    const out = feed.pull(s, Date.parse(now));
    expect(out).toEqual([expect.objectContaining({ type: "message_sent", fromAgentId: "t2/ai1", toAgentId: "t2/ai2", summary: "新的一輪的第一句" })]);
    expect(feed.pull(s, Date.parse(now))).toEqual([]);
  });

  it("notes but does not play what happened long before this look", () => {
    const s = store();
    const feed = new OrbitFeed();
    feed.pull(s, Date.parse(now));
    s.receive(event(1, [{ entityKind: "message", entityKey: "t2:old", revision: 2, op: "upsert", value: message("old", "ai1", ["ai2"], { occurredAt: "2026-10-06T00:00:00.000Z" }) }]));
    expect(feed.pull(s, Date.parse(now))).toEqual([]);
  });

  it("skips what the person or Coucou sent, and a message to oneself", () => {
    const s = store();
    const feed = new OrbitFeed();
    feed.pull(s, Date.parse(now));
    s.receive(event(1, [
      { entityKind: "message", entityKey: "t2:u", revision: 2, op: "upsert", value: message("u", "ai1", ["ai1"], { from: { kind: "user", userId: "you", displayName: "你" } }) },
      { entityKind: "message", entityKey: "t2:self", revision: 2, op: "upsert", value: message("self", "ai2", ["ai2"]) },
    ]));
    expect(feed.pull(s, Date.parse(now))).toEqual([]);
  });

  it("plays a new deliverable as a transfer from its author to the hub", () => {
    const s = store();
    const feed = new OrbitFeed();
    feed.pull(s, Date.parse(now));
    const a: Artifact = { ...v, artifactId: "t2:d1", teamId: "t2", runId: "t2@r", taskId: "t2:k", authorMemberId: "ai3", name: "商品頁設計.png", kind: "image", artifactVersion: 1, resourceRef: "x.png" };
    s.receive(event(1, [{ entityKind: "artifact", entityKey: "t2:d1", revision: 2, op: "upsert", value: a }]));
    const out = feed.pull(s, Date.parse(now));
    setLang("zh-TW");
    expect(out).toEqual([expect.objectContaining({ type: "message_sent", fromAgentId: "t2/ai3", toAgentId: "t2/ai1", summary: "交付 · 商品頁設計.png", delivery: true })]);
    // Its words are read when shown: the same event, in English.
    setLang("en");
    expect(out[0]).toEqual(expect.objectContaining({ summary: "Delivered · 商品頁設計.png" }));
    expect(feed.pull(s, Date.parse(now))).toEqual([]);
  });
});
