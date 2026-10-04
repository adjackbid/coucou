// What the Teamwork window is told — mirrors of team::state and team::TeamConfig.

export interface MemberConfig {
  id: string;
  name: string;
  role: string;
  duty: string;
  agent: string;
  /** Instead of the agent's own; empty for its default. */
  model?: string;
  color: string;
}

export interface TeamConfig {
  id: string;
  name: string;
  goal: string;
  scope: string[];
  workDir: string;
  leader: string;
  autoApprove: boolean;
  members: MemberConfig[];
  links: { from: string; to: string; kind: "delivery" | "talk"; what: string }[];
  expected: { name: string; detail: string }[];
  directTalk: boolean;
  sharedBoard: boolean;
  maxTurns: number;
  /** The Office's look: warm, nordic, studio, premium; absent or empty for Coucou's choice. */
  officeTheme?: string;
}

export interface TeamFile {
  file: string;
  config: TeamConfig | null;
  /** Why it cannot start as it is; empty when it can. */
  problems: string[];
}

export type TeamStatus = "idle" | "running" | "paused" | "finished";
export type TaskStatus = "todo" | "doing" | "delivered" | "done";
export type MemberStatus = "working" | "waitingDelivery" | "waitingReply" | "waitingYou" | "idle" | "done" | "lost";

export type Danger =
  | "deletes-folder"
  | "deletes-many"
  | "installs"
  | "downloads"
  | "destructive-git"
  | "sends-out"
  | "outside-work-dir"
  | "system"
  | "opaque";

export interface Permission {
  requestId: unknown;
  title: string;
  kind: string;
  rawInput: unknown;
  options: { optionId: string; name: string; kind: string }[];
  danger: Danger | null;
}

export interface MemberView {
  id: string;
  name: string;
  role: string;
  duty: string;
  agent: string;
  model: string;
  color: string;
  isLeader: boolean;
  status: MemberStatus;
  /** While it works: planning (a leader before any task) or reviewing hand-ins. */
  phase?: "planning" | "reviewing" | null;
  /** The task it is on, if any. */
  task: string | null;
  waiting: { on: string; what: string; task: string | null } | null;
  /** The tool it is using right now. */
  activity: string;
  turns: number;
  /** The oldest request waiting for the person… */
  permission: Permission | null;
  /** …and the ones behind it (an agent may ask for several steps at once). */
  morePermissions: Permission[];
  lostWhy: string;
  /** The last lines of its live screen. */
  screen: Line[];
}

/** One line of a member's live screen — mirror of team::screen::Line. */
export interface Line {
  /** Its number on the screen; a changed line comes again under the same number. */
  n: number;
  /** When it appeared. */
  since: number;
  /** When it last changed: the member's last sign of life is read from it. */
  at: number;
  kind: "say" | "think" | "tool" | "turn";
  /** Say/think: the text so far. Tool: its title. Turn: the turn's number. */
  text: string;
  /** Tool: read, edit, execute… */
  tool: string;
  /** Tool: which of Coucou's team tools, else "". */
  teamTool: string;
  /** Tool: what it was called with. Turn: what was heard, [{from, text}]. */
  input: unknown;
  /** Tool: running/done/failed. Turn: start/end/failed. */
  status: string;
  /** Tool: the end of what it printed. Turn: why it failed. */
  output: string;
}

/** Lines of one member's screen that changed — `team-screen`. */
export interface ScreenPatch {
  team: string;
  member: string;
  lines: Line[];
}

export interface Task {
  id: string;
  title: string;
  detail: string;
  owner: string;
  status: TaskStatus;
  priority: "high" | "medium" | "low";
  criteria: { text: string; claimed: boolean }[];
  dependsOn: string[];
  deliverTo: string | null;
  blocked: { reason: string; on: string } | null;
  note: string;
  rejections: number;
  dispatched: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Deliverable {
  id: string;
  task: string;
  kind: string;
  locator: string;
  summary: string;
  by: string;
  at: number;
  accepted: boolean | null;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  text: string;
  task: string | null;
  at: number;
  heard: boolean;
}

export interface Question {
  id: string;
  by: string;
  question: string;
  task: string | null;
  at: number;
  answer: string | null;
}

export interface FeedItem {
  at: number;
  kind:
    | "message"
    | "task"
    | "delivered"
    | "accepted"
    | "rejected"
    | "blocked"
    | "asked"
    | "answered"
    | "lost"
    | "paused"
    | "finished"
    | "joined"
    | "reopened";
  from: string;
  to: string;
  text: string;
  task: string | null;
}

/** An earlier run of a team — mirror of team::orchestrator::PastRun. */
export interface PastRun {
  archivedAt: number;
  startedAt: number;
  finishedAt: number;
  done: number;
  total: number;
  status: TeamStatus;
}

export interface Snapshot {
  id: string;
  /** The last event of the team's log in this picture; never smaller in a later picture of the same run. */
  seq: number;
  /** Loaded from an earlier run: no agent stands behind it until it is picked up again. */
  detached: boolean;
  name: string;
  goal: string;
  workDir: string;
  status: TeamStatus;
  pausedWhy: string;
  done: number;
  total: number;
  totalTurns: number;
  maxTurns: number;
  startedAt: number;
  finishedAt: number;
  members: MemberView[];
  tasks: Task[];
  deliverables: Deliverable[];
  messages: Message[];
  questions: Question[];
  feed: FeedItem[];
}
