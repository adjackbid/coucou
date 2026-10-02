// A running team on the island: one pill, one line.
//
// The Teamwork window has the whole picture. The island only has to make
// sure nothing that waits for the person is missed: the pill says how far the
// team is, and when a member needs an answer or has gone quiet the pill is
// badged, a sound plays and the island shows itself. A click on the card
// opens the Teamwork window.

import { onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Snapshot } from "../team/types";
import type { Island } from "./island";

/** What each team last looked like, to tell news from a repeat. */
const last = new Map<string, { line: string; waiting: number; lost: number; status: Snapshot["status"] }>();

export const teamTaskId = (team: string) => `team:${team}`;

export function registerTeamHandlers(island: Island) {
  void onEvent<Snapshot>("team-changed", (snap) => handle(island, snap));
}

/** One line for the ticker: how far the team is, and who needs the person. */
function summary(snap: Snapshot): string {
  const names = (status: string) => snap.members.filter((m) => m.status === status).map((m) => m.name);
  const progress = snap.total ? `${snap.done}/${snap.total} done` : "planning";
  if (snap.status === "finished") return `Finished · ${snap.done}/${snap.total} tasks`;
  const waiting = names("waitingYou");
  if (waiting.length) return `${progress} · ${waiting.join(", ")} ${waiting.length > 1 ? "need" : "needs"} you`;
  const lost = names("lost");
  if (lost.length) return `${progress} · ${lost.join(", ")} went quiet`;
  if (snap.status === "paused") return `Paused · ${progress}`;
  const working = names("working");
  return working.length ? `${progress} · ${working.join(", ")} working` : progress;
}

function handle(island: Island, snap: Snapshot) {
  if (State.paused) return;
  const id = teamTaskId(snap.id);
  const before = last.get(snap.id);
  if (!State.tasks.some((t) => t.id === id)) {
    // A run from another day, opened in the window to look at, makes no pill.
    if (snap.status !== "running") return;
    State.addTeamTask(id, snap.name, snap.workDir);
  }

  const waiting = snap.members.filter((m) => m.status === "waitingYou").length;
  const lost = snap.members.filter((m) => m.status === "lost").length;
  const line = summary(snap);
  last.set(snap.id, { line, waiting, lost, status: snap.status });

  State.updateTask(id, snap.status === "finished" ? "finished" : waiting ? "approval" : lost ? "error" : snap.status === "running" ? "working" : "idle");
  if (line !== before?.line) State.appendStep(id, line);

  // Only news is announced: one more member waiting, one more gone quiet, the end.
  const finished = snap.status === "finished" && before?.status !== "finished";
  const moreWaiting = waiting > (before?.waiting ?? 0);
  const moreLost = lost > (before?.lost ?? 0);
  if (finished || moreWaiting || moreLost) {
    if (State.focusId !== id || State.mode !== "expanded") {
      State.setPillBadge(id, finished ? "finished" : moreWaiting ? "approval" : "error");
    }
    Sound.play(finished ? "finish" : moreWaiting ? "approval" : "error");
    State.followActivity(id);
    island.reveal();
  } else if (!waiting && !lost && snap.status !== "finished") {
    State.setPillBadge(id, null);
  }
}
