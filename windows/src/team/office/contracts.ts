/** Agent Office contract v1. Proposed adapter boundary; not an existing server API.
 * Copied from feature/contracts/office-contracts.ts; Coucou's additions are marked. */
export type Id = string;
export type ISODateTime = string;
export type WorkStatus = 'planning' | 'working' | 'reviewing' | 'waiting_dependency' | 'waiting_input' | 'blocked' | 'completed' | 'paused' | 'error' | 'idle' | 'unknown';
export type RunStatus = 'idle' | 'running' | 'pausing' | 'paused' | 'needs_attention' | 'completed' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'ready' | 'running' | 'waiting_dependency' | 'waiting_input' | 'blocked' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
export interface Versioned { revision: number; updatedAt: ISODateTime }
export interface Agent extends Versioned { agentId: Id; name: string; avatarKey: string }
export interface Team extends Versioned {
  teamId: Id; name: string; goal: string; memberIds: Id[]; leaderMemberId: Id;
  currentRunId: Id; officeLayoutId: Id;
}
export interface Progress {
  completed: number; total: number;
  /** round(completed / total * 100); null when total === 0. */
  percent: number | null;
}
export interface TeamRun extends Versioned { runId: Id; teamId: Id; status: RunStatus; progress: Progress }
export interface WaitingFor {
  reason: string; memberIds: Id[]; taskIds: Id[]; expectedArtifact: string | null; nextAction: string;
}
export interface MemberSnapshot extends Versioned {
  memberId: Id; agentId: Id; teamId: Id; runId: Id; roleLabel: string;
  workStatus: WorkStatus; engineStatus: 'online' | 'offline' | 'unknown';
  primaryTaskId: Id | null; activeTaskIds: Id[]; lastCompletedTaskId: Id | null;
  summary: string; waitingFor: WaitingFor | null; lastActivityAt: ISODateTime;
  /** Coucou: the member's own name and colour. A Coucou agent is a profile several members may share. */
  displayName?: string; color?: string;
}
export interface Task extends Versioned {
  taskId: Id; teamId: Id; runId: Id; title: string; assigneeMemberId: Id | null;
  status: TaskStatus; parentTaskId: Id | null; dependencyTaskIds: Id[];
  includeInProgress: boolean; acceptanceCriteria: { id: Id; text: string; passed: boolean }[];
}
export type Actor = { kind: 'member'; memberId: Id } | { kind: 'user'; userId: Id; displayName: string } | { kind: 'system' };
export interface Message extends Versioned {
  messageId: Id; teamId: Id; runId: Id; threadId: Id; taskId: Id | null;
  from: Actor; toMemberIds: Id[]; kind: 'message' | 'question' | 'decision' | 'handoff' | 'instruction';
  text: string; deliveryStatus: 'sent' | 'delivered' | 'failed';
  artifactIds: Id[]; occurredAt: ISODateTime;
}
export interface Artifact extends Versioned {
  artifactId: Id; teamId: Id; runId: Id; taskId: Id; authorMemberId: Id;
  name: string; kind: 'image' | 'document' | 'code' | 'website' | 'bundle';
  artifactVersion: number; resourceRef: string;
}
export interface Anchor { x: number; y: number }
export interface OfficeLayout extends Versioned {
  layoutId: Id; logicalWidth: number; logicalHeight: number;
  workstations: { memberId: Id; anchor: Anchor; facing: 'S'|'SW'|'W'|'NW'|'N'|'NE'|'E'|'SE' }[];
  furniture: { id: Id; assetKey: string; anchor: Anchor; layer: 'floor'|'back'|'depth'|'front' }[];
  navPoints: Anchor[];
}
export interface CommandRecord extends Versioned {
  commandId: Id; clientRequestId: Id; teamId: Id; runId: Id;
  kind: 'pause' | 'resume' | 'instruction'; status: 'accepted' | 'applying' | 'applied' | 'failed';
  createdAt: ISODateTime; errorCode: string | null; errorMessage: string | null;
}
export interface CompanySnapshot {
  schemaVersion: 1; companyId: Id; streamId: Id; asOfSeq: number; serverTime: ISODateTime;
  agents: Agent[]; teams: Team[]; runs: TeamRun[]; members: MemberSnapshot[];
  tasks: Task[]; messages: Message[]; artifacts: Artifact[]; layouts: OfficeLayout[]; commands: CommandRecord[];
}
export interface EntityMap {
  agent: Agent; team: Team; run: TeamRun; member: MemberSnapshot; task: Task;
  message: Message; artifact: Artifact; layout: OfficeLayout; command: CommandRecord;
}
/** entityKey: member = `${runId}/${memberId}`; others = their corresponding entity ID. */
export type EntityChange = {
  [K in keyof EntityMap]:
    | { entityKind: K; entityKey: string; revision: number; op: 'upsert'; value: EntityMap[K] }
    | { entityKind: K; entityKey: string; revision: number; op: 'delete'; teamId?: Id; runId?: Id }
}[keyof EntityMap];
export interface DomainEvent {
  schemaVersion: 1; streamId: Id; eventId: Id; seq: number; occurredAt: ISODateTime;
  type: 'task.updated' | 'member.updated' | 'team.updated' | 'message.created' | 'artifact.created' | 'command.updated' | 'layout.updated' | 'entities.changed';
  /** Apply all changes atomically, then derive UI summaries. */
  changes: EntityChange[];
}
interface CommandBase { teamId: Id; runId: Id; clientRequestId: Id; expectedRunRevision: number }
export type CommandRequest = CommandBase & (
  | { kind: 'pause' | 'resume'; payload: null }
  | { kind: 'instruction'; payload: { text: string; target: 'leader' } }
);
export interface CommandAck { commandId: Id; clientRequestId: Id; status: 'accepted'; acceptedAt: ISODateTime }
export interface Capabilities {
  canPause: boolean; canResume: boolean; canSendInstruction: boolean;
  pauseMode: 'cooperative' | 'immediate' | 'unsupported';
  unavailableReasons: Partial<Record<'pause'|'resume'|'instruction', string>>;
}
export interface ConnectionState {
  status: 'connecting' | 'live' | 'reconnecting' | 'stale' | 'closed';
  lastAppliedSeq: number; lastServerTime: ISODateTime | null;
}
export interface OfficeDataAdapter {
  getSnapshot(input: { companyId: Id }): Promise<CompanySnapshot>;
  subscribe(input: {
    streamId: Id; afterSeq: number;
    onEvent(event: DomainEvent): void;
    onConnection(state: ConnectionState): void;
    onResyncRequired(reason: 'expired_cursor'|'scope_changed'|'unsupported_schema'): void;
  }): () => void;
  getThread(input: { teamId: Id; runId: Id; threadId: Id; cursor: string | null }): Promise<{ items: Message[]; nextCursor: string | null }>;
  getArtifact(input: { artifactId: Id }): Promise<Artifact>;
  getCapabilities(input: { teamId: Id; runId: Id }): Promise<Capabilities>;
  sendCommand(input: CommandRequest): Promise<CommandAck>;
}

/** One shared calculation for board and Office. completed means accepted under the host app's policy. */
export function calculateProgress(tasks: readonly Task[], runId: Id): Progress {
  const parents = new Set(tasks.filter(t => t.runId === runId && t.parentTaskId !== null).map(t => t.parentTaskId!));
  const scoped = tasks.filter(t => t.runId === runId && t.includeInProgress && t.status !== 'cancelled' && !parents.has(t.taskId));
  const completed = scoped.filter(t => t.status === 'completed').length;
  return { completed, total: scoped.length, percent: scoped.length ? Math.round(completed / scoped.length * 100) : null };
}
