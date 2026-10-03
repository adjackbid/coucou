// The contract's replay cases (feature/contracts/replay-cases.json), run
// against the store the Office reads from.

import { describe, expect, it } from "vitest";
import { calculateProgress, type CompanySnapshot, type DomainEvent, type Task } from "./contracts";
import { OfficeStore, type ResyncReason } from "./store";
import snapshotJson from "./fixtures/company.snapshot.json";
import eventsJson from "./fixtures/events.json";

const snapshot = snapshotJson as unknown as CompanySnapshot;
const events = eventsJson as unknown as DomainEvent[];
const bySeq = (seq: number) => structuredClone(events.find((e) => e.seq === seq)!);

function fresh() {
  const asked: { reason: ResyncReason; cursor: number }[] = [];
  const store = new OfficeStore((reason, cursor) => asked.push({ reason, cursor }));
  store.loadSnapshot(structuredClone(snapshot));
  return { store, asked };
}

function expectNormal(store: OfficeStore) {
  expect(store.cursor).toBe(104);
  expect(store.progress("shop")).toEqual({ completed: 4, total: 7, percent: 57 });
  expect(store.member("shop", "member-ai2")?.workStatus).toBe("working");
  expect(store.member("shop", "member-ai3")?.workStatus).toBe("completed");
  expect(store.messages("shop")).toHaveLength(4);
}

describe("replay cases", () => {
  it("normal: 101–104 in order", () => {
    const { store } = fresh();
    for (const seq of [101, 102, 103, 104]) expect(store.receive(bySeq(seq))).toBe("applied");
    expectNormal(store);
  });

  it("duplicate: the same events twice change nothing", () => {
    const { store } = fresh();
    const got = [101, 102, 102, 103, 104, 104].map((seq) => store.receive(bySeq(seq)));
    expect(got).toEqual(["applied", "applied", "duplicate", "applied", "applied", "duplicate"]);
    expectNormal(store);
    expect(store.recent.filter((e) => e.seq === 102)).toHaveLength(1);
  });

  it("gap: the cursor stays and the store asks for what is missing", () => {
    const { store, asked } = fresh();
    store.receive(bySeq(101));
    expect(store.receive(bySeq(103))).toBe("buffered");
    expect(store.cursor).toBe(101);
    expect(store.syncing).toBe(true);
    expect(asked).toEqual([{ reason: "gap", cursor: 101 }]);
    // 103 has not touched AI 2 yet.
    expect(store.member("shop", "member-ai2")?.workStatus).toBe("waiting_dependency");
  });

  it("out of order: the gap fills and ends where normal ends", () => {
    const { store } = fresh();
    for (const seq of [101, 103, 102, 104]) store.receive(bySeq(seq));
    expect(store.syncing).toBe(false);
    expectNormal(store);
  });

  it("an older revision never replaces a newer one", () => {
    const { store } = fresh();
    for (const seq of [101, 102, 103, 104]) store.receive(bySeq(seq));
    const stale = bySeq(103);
    stale.eventId = "evt-stale";
    stale.seq = 105;
    const change = stale.changes[1];
    if (change.op === "upsert" && change.entityKind === "member") {
      change.revision = 1;
      change.value = { ...change.value, revision: 1, workStatus: "blocked" };
    }
    store.receive(stale);
    expect(store.cursor).toBe(105);
    expect(store.member("shop", "member-ai2")?.workStatus).toBe("working");
  });

  it("a deleted entity is not brought back by an older event", () => {
    const { store } = fresh();
    store.receive({ schemaVersion: 1, streamId: snapshot.streamId, eventId: "del", seq: 101, occurredAt: "2026-10-03T15:00:00Z", type: "entities.changed",
      changes: [{ entityKind: "artifact", entityKey: "art-website-v1", revision: 5, op: "delete", teamId: "shop" }] });
    const late = bySeq(101);
    late.eventId = "late";
    late.seq = 102;
    store.receive(late);
    expect(store.artifact("art-website-v1")).toBeUndefined();
  });

  it("new run: the last run's seat does not overwrite the new one", () => {
    const { store } = fresh();
    const team = store.team("shop")!;
    store.receive({ schemaVersion: 1, streamId: snapshot.streamId, eventId: "run2", seq: 101, occurredAt: "2026-10-03T15:00:00Z", type: "entities.changed",
      changes: [
        { entityKind: "team", entityKey: "shop", revision: team.revision + 1, op: "upsert", value: { ...team, revision: team.revision + 1, currentRunId: "run-shop-2" } },
        { entityKind: "member", entityKey: "run-shop-2/member-ai2", revision: 1, op: "upsert",
          value: { ...store.members("shop")[0], memberId: "member-ai2", runId: "run-shop-2", workStatus: "idle", revision: 1 } },
      ] });
    // An event for the old run arrives afterwards.
    const old = bySeq(103);
    old.seq = 102;
    store.receive(old);
    expect(store.member("shop", "member-ai2")?.workStatus).toBe("idle");
    expect(store.member("shop", "member-ai2")?.runId).toBe("run-shop-2");
  });

  it("a stream with another scope or schema asks for a new snapshot", () => {
    const { store, asked } = fresh();
    expect(store.receive({ ...bySeq(101), streamId: "other" })).toBe("rejected");
    expect(store.receive({ ...bySeq(101), schemaVersion: 2 as 1 })).toBe("rejected");
    expect(asked.map((a) => a.reason)).toEqual(["scope_changed", "unsupported_schema"]);
  });
});

describe("progress", () => {
  const t = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({
    taskId: id, teamId: "t", runId: "r", title: id, assigneeMemberId: null, status, parentTaskId: null,
    dependencyTaskIds: [], includeInProgress: true, acceptanceCriteria: [], revision: 1, updatedAt: "", ...extra,
  });

  it("3 of 7 is 43%", () => {
    const tasks = [...Array(3)].map((_, i) => t(`d${i}`, "completed")).concat([...Array(4)].map((_, i) => t(`o${i}`, "running")));
    expect(calculateProgress(tasks, "r")).toEqual({ completed: 3, total: 7, percent: 43 });
  });

  it("cancelled tasks and parents leave the denominator", () => {
    const tasks = [t("a", "completed"), t("b", "cancelled"), t("p", "running"), t("c", "running", { parentTaskId: "p" }), t("x", "running", { includeInProgress: false })];
    expect(calculateProgress(tasks, "r")).toEqual({ completed: 1, total: 2, percent: 50 });
  });

  it("no tasks is no percentage", () => {
    expect(calculateProgress([], "r")).toEqual({ completed: 0, total: 0, percent: null });
  });

  it("people are counted once, seats per team", () => {
    const { store } = fresh();
    expect(store.headcount()).toEqual({ agents: 10, seats: 10 });
  });
});
