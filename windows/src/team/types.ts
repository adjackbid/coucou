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
  /** What Agent Center told this member to keep throughout its work. */
  brief?: string;
  /** Skills from Agent Center's library this member gets the text of, by name. */
  skills?: string[];
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
  /** Agent Center's plan for the leader, read with its first message. */
  kickoff?: string;
  /** Fast mode: the smallest team that does the job, one review per task, no second round. */
  fast?: boolean;
  /** A time limit in minutes from the start (0 or absent for none); the leader keeps the end of it for assembling. */
  timeLimitMin?: number;
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
  /** The check "allow this for the whole team" would waive: a constitution rule's id. */
  ruleId?: string;
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
  reviewer: string | null;
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
    | "ended"
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
  /** Finished because the person ended it (結束團隊), not because the work was done. */
  ended?: boolean;
  done: number;
  total: number;
  totalTurns: number;
  maxTurns: number;
  startedAt: number;
  finishedAt: number;
  /** The time limit in minutes (0 for none), its reserve, and where it stands. */
  timeLimitMin: number;
  timeReserveMin: number;
  timeWarned: boolean;
  timeUp: boolean;
  members: MemberView[];
  tasks: Task[];
  deliverables: Deliverable[];
  messages: Message[];
  questions: Question[];
  feed: FeedItem[];
  /** Constitution asks the person waived for this team, by rule id. */
  waived?: string[];
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

// ── Agent Center — mirrors of secretary.rs ─────────────────────────────────

/** A look-up or a preparation Agent Center made on the way to its answer. */
export interface SecretaryStep {
  tool: string;
  label: string;
  /** The agent it looks at (agent_models): lit in the picking animation. */
  agent?: string;
}

// ── A team's knowledge base — mirror of team/knowledge.rs ─────────────────────

export type KnowledgeVisibility = "leader" | "shared";
/** text and image are read to members by Coucou; any other file is handed over as a path. */
export type KnowledgeKind = "text" | "image" | "file";

export interface KnowledgeDoc {
  id: string;
  name: string;
  kind: KnowledgeKind;
  bytes: number;
  visibility: KnowledgeVisibility;
  addedAt: number;
  /** Where it was copied from (empty for a paste). */
  source: string;
  note: string;
  /** Its copy is no longer in the knowledge folder. */
  missing: boolean;
  /** The original is still there, to import again. */
  sourceExists: boolean;
  /** A program, script or shortcut: kept, never opened. */
  program: boolean;
}

export interface KnowledgeView {
  docs: KnowledgeDoc[];
  bytes: number;
  limits: { maxDocs: number; maxBytes: number; maxText: number; maxImage: number; maxFile: number };
}

/** Added, or held back: it looks like it holds a key, and needs the person's yes. */
export interface KnowledgeAdded {
  doc: KnowledgeDoc | null;
  keyLike: { line: number; sample: string } | null;
}

/** Something Agent Center prepared; it happens only when the person clicks `confirm`. */
export interface SecretaryProposal {
  id: string;
  kind: "team" | "instruction" | "action" | "knowledge";
  title: string;
  lines: string[];
  confirm: string;
  state: "open" | "done" | "declined" | "failed";
  outcome: string;
  /** The attached files it would put in a knowledge base. */
  uses?: string[];
  /** A new team's members as picked from Agent Pool (secretary.rs Pick), for the picking animation. */
  picks?: { agent: string; name: string; role: string; leader: boolean }[];
}

/** A saved Agent Center conversation (secretary.rs ChatInfo). */
export interface SecretaryChat {
  id: string;
  title: string;
  updatedMs: number;
  /** The one on screen now. */
  current: boolean;
}

/** A file attached in Agent Center's conversation (secretary.rs UploadView). */
export interface SecretaryUpload {
  id: string;
  name: string;
  kind: KnowledgeKind;
  bytes: number;
  /** It looks like it holds a key… */
  keyLike: { line: number; sample: string } | null;
  /** …and the person said to keep it. */
  force: boolean;
}

/** A skill in Agent Center's library (team_agents.rs `LibrarySkill`). */
export interface LibrarySkill {
  name: string;
  description: string;
  path: string;
  /** `for: agent-center` in its front matter: Agent Center's own, never handed to a member. */
  forCenter: boolean;
}

export interface SecretaryReply {
  text: string;
  steps: SecretaryStep[];
  proposals: SecretaryProposal[];
  /** A question asked with options to click (secretary.rs Choices). */
  choices?: SecretaryChoices;
}

/** Options to click; the one clicked is sent as the person's answer. */
export interface SecretaryChoices {
  question: string;
  options: string[];
  multiple: boolean;
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

// ── Team agents — mirror of team_agents.rs ───────────────────────────────────

export interface TeamAgentMcp {
  name: string;
  /** A command to start (stdio)… */
  command: string;
  args: string[];
  /** …or a URL to connect to (streamable HTTP). */
  url: string;
}

/**
 * An agent of the person's own making, built on a native agent of Settings →
 * Agents; a Cloud Agent or a Local Agent as its base is.
 */
export interface TeamAgent {
  id: string;
  name: string;
  /** The native agent it runs on: its command (or webhook), environment and key. */
  base: string;
  /** Empty: the base's model. */
  model: string;
  systemPrompt: string;
  mcp: TeamAgentMcp[];
  /** Skill folders (each with a SKILL.md) or skill names. */
  skills: string[];
  /** What it is good for: Agent Center picks members by it. */
  description: string;
  /** The person's own grouping in Agent Pool (程式開發, 文案製作…); empty for none. */
  category: string;
  /** How hard it thinks: low, medium, high, xhigh, max; empty for the provider's own default. */
  effort: string;
}

/** New teams are built from these only; an older file's `source` is read past. */
export interface TeamAgents {
  agents: TeamAgent[];
}

/** How a protocol takes one part of a team agent. */
export type TeamAgentSupport = "native" | "brief" | "no";

export interface TeamAgentSupports {
  systemPrompt: TeamAgentSupport;
  mcp: TeamAgentSupport;
  skills: TeamAgentSupport;
  /** Reasoning effort: a flag of the provider's (or, for n8n, a field of each call). */
  effort: TeamAgentSupport;
}

export interface TeamAgentsView {
  doc: TeamAgents;
  /** Native agent id → what its protocol can take. */
  supports: Record<string, TeamAgentSupports>;
}
