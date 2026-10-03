// Coucou's snapshots as Office entities: the same numbers as the board, and
// commands that are accepted before they are applied.

import { describe, expect, it, vi } from "vitest";
import { RealAdapter, teamEntities } from "./adapter-real";
import { OfficeStore } from "./store";
import { demoFiles, demoSnapshot } from "../demo";
import type { Snapshot } from "../types";

// The demo reads the page's query string; there is no page here.
vi.stubGlobal("location", { search: "" });

const shopFile = demoFiles.files[0];
const docsFile = demoFiles.files[1];

function company() {
  const runs = new Map<string, Snapshot>([["shop", demoSnapshot()]]);
  return { files: [shopFile, docsFile], runs };
}

describe("teamEntities", () => {
  it("keeps the board's progress and waits", () => {
    const snap = demoSnapshot();
    const e = teamEntities(shopFile, snap, 1);
    expect(e.run.progress.completed).toBe(snap.done);
    expect(e.run.progress.total).toBe(snap.total);
    const ai2 = e.members.find((m) => m.memberId === "ai2")!;
    expect(ai2.workStatus).toBe("waiting_dependency");
    expect(ai2.waitingFor?.memberIds).toEqual(["ai3"]);
    const done = e.members.find((m) => m.memberId === "ai4")!;
    expect(done.workStatus).toBe("completed");
  });

  it("planning and reviewing come from Coucou's own reading of the board", () => {
    const snap = demoSnapshot();
    snap.members[0] = { ...snap.members[0], status: "working", phase: "planning" };
    snap.members[1] = { ...snap.members[1], status: "working", phase: "reviewing" };
    const e = teamEntities(shopFile, snap, 1);
    expect(e.members[0].workStatus).toBe("planning");
    expect(e.members[1].workStatus).toBe("reviewing");
  });

  it("a team that never ran has a room, idle, with no progress yet", () => {
    const e = teamEntities(docsFile, undefined, 1);
    expect(e.run.status).toBe("idle");
    expect(e.run.progress.percent).toBeNull();
    expect(e.members.every((m) => m.workStatus === "idle")).toBe(true);
  });

  it("a paused team with turns still under way is pausing, then paused", () => {
    const snap = { ...demoSnapshot(), status: "paused" as const };
    expect(teamEntities(shopFile, snap, 1).run.status).toBe("pausing");
    snap.members = snap.members.map((m) => ({ ...m, status: m.status === "working" ? "idle" : m.status }));
    expect(teamEntities(shopFile, snap, 1).run.status).toBe("paused");
  });
});

describe("RealAdapter", () => {
  it("the same picture twice is no event; a change is one, with a higher revision", () => {
    const a = new RealAdapter({ pause: vi.fn(), resume: vi.fn(), instruct: vi.fn() });
    const { files, runs } = company();
    const store = new OfficeStore();
    store.loadSnapshot(a.snapshot(files, runs));
    expect(a.diff(files, runs)).toBeNull();
    const next = structuredClone(runs.get("shop")!);
    next.members[1].status = "working";
    runs.set("shop", next);
    const e = a.diff(files, runs)!;
    expect(e.seq).toBe(store.cursor + 1);
    expect(store.receive(e)).toBe("applied");
    expect(store.member("shop", "ai2")?.workStatus).toBe("working");
    expect(store.progress("shop")).toEqual(teamEntities(shopFile, next, 1).run.progress);
  });

  it("a removed member is deleted, and its drawer can close", () => {
    const a = new RealAdapter({ pause: vi.fn(), resume: vi.fn(), instruct: vi.fn() });
    const { files, runs } = company();
    const store = new OfficeStore();
    store.loadSnapshot(a.snapshot(files, runs));
    const fewer = structuredClone(shopFile);
    fewer.config!.members = fewer.config!.members.filter((m) => m.id !== "ai4");
    store.receive(a.diff([fewer, docsFile], runs)!);
    expect(store.member("shop", "ai4")).toBeUndefined();
    expect(store.members("shop").map((m) => m.memberId)).toEqual(["ai1", "ai2", "ai3"]);
  });

  it("an instruction is accepted at once, applied when the leader has it, and a retry is the same command", async () => {
    const instruct = vi.fn().mockResolvedValue("m-you");
    const a = new RealAdapter({ pause: vi.fn(), resume: vi.fn(), instruct });
    const req = { kind: "instruction" as const, teamId: "shop", runId: "r", clientRequestId: "c1", expectedRunRevision: 1, payload: { text: "先做結帳", target: "leader" as const } };
    const ack = await a.sendCommand(req);
    expect(ack.status).toBe("accepted");
    expect((await a.sendCommand(req)).commandId).toBe(ack.commandId);
    expect(instruct).toHaveBeenCalledTimes(1);
    const { files, runs } = company();
    let snap = a.snapshot(files, runs);
    expect(snap.commands.find((c) => c.commandId === ack.commandId)?.status).toBe("accepted");
    const shop = structuredClone(runs.get("shop")!);
    // Recorded, not yet read by the leader: applying.
    shop.messages.push({ id: "m-you", from: "you", to: "ai1", text: "先做結帳", task: null, at: Date.now(), heard: false });
    runs.set("shop", shop);
    a.settle(runs);
    snap = a.snapshot(files, runs);
    expect(snap.commands.find((c) => c.commandId === ack.commandId)?.status).toBe("applying");
    // The leader's next turn heard it: applied.
    shop.messages[shop.messages.length - 1].heard = true;
    a.settle(runs);
    snap = a.snapshot(files, runs);
    expect(snap.commands.find((c) => c.commandId === ack.commandId)?.status).toBe("applied");
  });

  it("a failed command says why and can be retried", async () => {
    const instruct = vi.fn().mockRejectedValueOnce(new Error("There is no such team.")).mockResolvedValue("m-2");
    const a = new RealAdapter({ pause: vi.fn(), resume: vi.fn(), instruct });
    const req = { kind: "instruction" as const, teamId: "shop", runId: "r", clientRequestId: "c2", expectedRunRevision: 1, payload: { text: "hi", target: "leader" as const } };
    await expect(a.sendCommand(req)).rejects.toThrow("no such team");
    expect((await a.sendCommand(req)).status).toBe("accepted");
    expect(instruct).toHaveBeenCalledTimes(2);
  });
});
