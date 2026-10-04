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
  /** At most this many tokens in a run; absent for no limit. */
  maxTokens?: number;
  /** At most this estimated cost in a run, US dollars; absent for no limit. */
  maxCostUsd?: number;
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
  /** Put away: out of the team list and the company map, not deleted. */
  archived?: boolean;
  /** Steps approved by themselves may also touch each member's own agent folder. */
  agentFolders?: boolean;
  /** More folders trusted like the work folder, for steps approved by themselves. */
  trustedDirs?: string[];
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
  /** The constitution's rule that asks about it, when one does. */
  rule?: string;
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
  /** Tokens it has used this run, by model. */
  usage?: Usage[];
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

// ── Usage and cost — mirrors of usage::Usage, pricing.rs and cost.rs ──────────

/** What a member's model used: tokens by kind (input without the cached part). */
export interface Usage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
  /** The agent's own figure, in US dollars, when it gives one. */
  costUsd?: number;
}

/** US dollars per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PriceSource = "override" | "proxy" | "list";

export interface Found {
  price: Price;
  source: PriceSource;
  listedAs: string;
}

export interface Listed {
  price: Price;
  listedAs: string;
  provider: string;
}

export type Billing = "metered" | "subscription";

export interface PricingChoices {
  overrides: Record<string, Price>;
  proxy: Record<string, Listed>;
  billing: Record<string, Billing>;
  currency: string;
  rate: number;
}

export interface UsageRow {
  at: number;
  team: string;
  teamName: string;
  run: number;
  member: string;
  memberName: string;
  agent: string;
  usage: Usage;
  estimatedUsd: number | null;
  /** "override", "proxy", "list", "reported" — or "" when nothing priced it. */
  pricedBy: string;
}

/** What a member did in the period — mirror of cost::Activity. */
export interface Activity {
  team: string;
  member: string;
  memberName: string;
  role: string;
  leader: boolean;
  turns: number;
  failedTurns: number;
  delivered: number;
  rejected: number;
  accepted: number;
  reviews: number;
  messages: number;
}

export interface UsageReport {
  rows: UsageRow[];
  activity: Activity[];
  models: { model: string; found: Found | null }[];
  choices: PricingChoices;
  tableSource: string;
  tableFetchedAt: number;
  tableSize: number;
}

/** What an agent's endpoint (a LiteLLM proxy) billed its key — mirror of cost::KeySpend. */
export interface KeySpend {
  spend: number;
  maxBudget: number | null;
  budgetDuration: string | null;
  budgetResetAt: string | null;
  modelSpend: Record<string, number>;
  askedAt: number;
}

// ── The secretary — mirrors of secretary.rs ─────────────────────────────────

/** A look-up or a preparation the secretary made on the way to its answer. */
export interface SecretaryStep {
  tool: string;
  label: string;
}

/** Something the secretary prepared; it happens only when the person clicks `confirm`. */
export interface SecretaryProposal {
  id: string;
  kind: "team" | "instruction" | "action";
  title: string;
  lines: string[];
  confirm: string;
  state: "open" | "done" | "declined" | "failed";
  outcome: string;
}

export interface SecretaryReply {
  text: string;
  steps: SecretaryStep[];
  proposals: SecretaryProposal[];
}

// ── The constitution — mirror of constitution.rs ─────────────────────────────

export type ConstitutionLevel = "off" | "ask" | "never";

export interface ConstitutionRule {
  id: string;
  /** What the rule is about, in the person's words. */
  text: string;
  level: ConstitutionLevel;
  /** One of Coucou's own checks; empty for the person's own rule. */
  check: string;
  /** The person's own rule: words in the command or a path, `*` for anything. */
  patterns: string[];
}

export interface Constitution {
  rules: ConstitutionRule[];
}
