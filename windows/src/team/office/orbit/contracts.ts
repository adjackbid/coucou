// 星域: the company as one universe of light rings — what the scene reads.
// The shape is feature3/協作軌道光環星域-v1/data/orbit-contracts.ts, with the
// spec's 狀態未知 added. Everything here is a projection over OfficeStore
// (see adapter.ts); nothing in the scene writes back to the work.

export type AgentStatus = "busy" | "waiting" | "done" | "idle" | "error" | "offline" | "unknown";
export type RelationKind = "team_connection" | "workflow" | "communication";

export interface OrbitTeam {
  id: string;
  name: string;
  color: string;
  leaderAgentId?: string;
}

export interface OrbitAgent {
  /** Unique in the whole scene and stable: `${teamId}/${memberId}`, never a display name. */
  id: string;
  teamId: string;
  name: string;
  role: string;
  status: AgentStatus;
  color: string;
}

export interface OrbitRelation {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  kind: RelationKind;
  /** A relation may have no direction; a message's direction always comes from its event. */
  directed: boolean;
}

export interface OrbitScene {
  schemaVersion: "1.0.0";
  mode: "demo" | "live";
  teams: OrbitTeam[];
  agents: OrbitAgent[];
  relations: OrbitRelation[];
}

interface EventBase {
  id: string;
  occurredAt: string;
}

export interface OrbitMessageEvent extends EventBase {
  type: "message_sent" | "message_received";
  messageId: string;
  fromAgentId: string;
  toAgentId: string;
  /** A short summary: the conversation itself never goes into the scene. */
  summary: string;
}

export interface OrbitStatusEvent extends EventBase {
  type: "agent_status_changed";
  agentId: string;
  status: AgentStatus;
}

export type OrbitEvent = OrbitMessageEvent | OrbitStatusEvent;

export type OrbitPreset = "oblique" | "top" | "side" | "custom";

export interface OrbitViewState {
  yaw: number;
  pitch: number;
  zoom: number;
  paused: boolean;
  reduceMotion: boolean;
  selectedAgentId: string | null;
  view: OrbitPreset;
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  busy: "工作中",
  waiting: "等待協作",
  done: "已完成",
  idle: "待命",
  error: "錯誤",
  offline: "離線",
  unknown: "狀態未知",
};

/** The scene's id for a team member. */
export const agentKey = (teamId: string, memberId: string) => `${teamId}/${memberId}`;

/** The team and member a scene id names. */
export function splitAgentKey(id: string): { teamId: string; memberId: string } {
  const i = id.indexOf("/");
  return i < 0 ? { teamId: "", memberId: id } : { teamId: id.slice(0, i), memberId: id.slice(i + 1) };
}
