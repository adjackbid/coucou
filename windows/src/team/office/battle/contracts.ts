// 中二模式: the same work as the Office, told as a raid. The team's goal is
// a boss (需求魔王); every task counted in progress is 100 of its HP; members
// are heroes whose real work — deliveries, acceptances, blocks, questions,
// the leader's report — becomes hits, shields, counters, seals and victory.
//
// A presentation over what OfficeStore has already applied, and nothing
// more: nothing here writes back to the work, decides anything, or holds
// numbers of its own. HP is always worked out again from the real tasks.
// (feature2/ui/battle-mode/中二模式-設計架構.txt is the design.)

import type { Id, RunStatus, TaskStatus, WorkStatus } from "../contracts";

/** How the same work is shown: rooms, a raid, or the 星域 (one universe of light rings; see ../orbit). */
export type PresentationMode = "office" | "battle" | "orbit" | "space";
export type HeroClass = "captain" | "mage" | "guardian" | "warrior" | "support";

export interface BattleScope {
  teamId: Id;
  runId: Id;
}

/** What the projector needs of a task: OfficeStore's own, nothing guessed. */
export interface TaskInput extends BattleScope {
  taskId: Id;
  revision: number;
  title: string;
  status: TaskStatus;
  assigneeMemberId: Id | null;
  includeInProgress: boolean;
  parentTaskId: Id | null;
}

export interface ProgressInput {
  completed: number;
  total: number;
  percent: number | null;
}

export interface ProjectionInput extends BattleScope {
  /** OfficeStore's stream and cursor — never a team log's own seq. */
  streamId: Id;
  asOfSeq: number;
  runStatus: RunStatus;
  /** From the shared calculateProgress; the projector checks it covers the same tasks. */
  progress: ProgressInput;
  tasks: readonly TaskInput[];
  needsHuman: boolean;
  blockedTaskIds: readonly Id[];
  isHistory: boolean;
  isSyncing: boolean;
}

export type BossState = "planning" | "engaged" | "sealing" | "paused" | "defeated" | "stopped" | "syncing" | "inconsistent";

export interface BattleViewModel extends BattleScope {
  asOfSeq: number;
  bossKey: "requirements-golem";
  bossState: BossState;
  /** Null with no counted task: there is nothing to fight yet. */
  hp: number | null;
  maxHp: number | null;
  progress: ProgressInput;
  /** Counted tasks handed in and waiting for review: the boss's shield. */
  reviewingCount: number;
  blockedTaskIds: readonly Id[];
  needsHuman: boolean;
  isHistory: boolean;
  countedTaskIds: readonly Id[];
  /** How the boss looks, by the HP left — never a state of the work. */
  phase: "core" | "rage" | "last_seal" | null;
  /** The tasks and the progress the board shows disagree: say why, play nothing. */
  consistencyIssue: string | null;
}

export type SignalKind =
  | "scope_added"
  | "scope_adjusted"
  | "task_started"
  | "delivery_waiting"
  | "acceptance_hit"
  | "review_returned"
  | "boss_counter"
  | "unblock_support"
  | "member_interrupted"
  | "pause"
  | "seal_wait"
  | "victory"
  | "reopen"
  | "baseline";

export interface SignalSource extends BattleScope {
  /** Coucou's adapter sends whole pictures: every signal is a difference between two. */
  kind: "snapshot_diff" | "manual_replay";
  streamId: Id | null;
  /** OfficeStore's cursor the later picture was at. */
  domainSeq: number | null;
  taskIds: readonly Id[];
  memberIds: readonly Id[];
  questionIds: readonly Id[];
}

export interface BattleSignal extends BattleScope {
  signalId: Id;
  kind: SignalKind;
  source: SignalSource;
  /** What really happened, in the window's words. */
  reasonLabel: string;
  hpBefore: number | null;
  hpAfter: number | null;
  maxHpBefore: number | null;
  maxHpAfter: number | null;
  /** How the HP moved, for the floating number; never written back anywhere. */
  displayDelta: number | null;
  actorMemberId: Id | null;
  observedAt: string;
  /** A rejection is said to be one only when the record says so. */
  evidence: "observed_transition" | "explicit_event" | "unknown";
  replay: boolean;
}

/** One picture of a team, as the signals compare them. */
export interface Observation {
  vm: BattleViewModel;
  streamId: Id;
  tasks: ReadonlyMap<Id, TaskInput>;
  /** Members' work status, by member id. */
  members: ReadonlyMap<Id, WorkStatus>;
  /** How many times each task was sent back, when the raw record says (Coucou's Task.rejections). */
  rejections?: ReadonlyMap<Id, number>;
  /** Open questions to the person, by id. */
  questionIds?: readonly Id[];
  runStatus: RunStatus;
  /** The run's revision: a signal about the run is named after it. */
  runRevision: number;
}

export const DESIGN = {
  hpPerTask: 100,
  queueLimit: 8,
  maxPrimaryEffects: 2,
  particleLimit: 80,
  maxQueueDelayMs: 2000,
} as const;
