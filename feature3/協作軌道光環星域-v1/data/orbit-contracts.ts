/** 前端 adapter 建議契約，並非 CouCou 現有 API；參考範例尚未接入此契約。 */
export type AgentStatus = 'busy' | 'waiting' | 'done' | 'idle' | 'error' | 'offline';
export type RelationKind = 'team_connection' | 'workflow' | 'communication';

export interface OrbitTeam {
  id: string;
  name: string;
  color: string;
  leaderAgentId?: string;
}

export interface OrbitAgent {
  /** 全場景唯一且穩定，不用 AI 1 這類顯示名稱作 ID。 */
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
  /** 關係可無方向；訊息方向一律由 event 指定。 */
  directed: boolean;
}

export interface OrbitScene {
  schemaVersion: '1.0.0';
  mode: 'demo' | 'live';
  teams: OrbitTeam[];
  agents: OrbitAgent[];
  relations: OrbitRelation[];
}

interface EventBase {
  id: string;
  occurredAt: string;
}

export interface OrbitMessageEvent extends EventBase {
  type: 'message_sent' | 'message_received';
  messageId: string;
  fromAgentId: string;
  toAgentId: string;
  /** 短摘要，避免把完整對話放進 UI 偏好或渲染 state。 */
  summary: string;
}

export interface OrbitStatusEvent extends EventBase {
  type: 'agent_status_changed';
  agentId: string;
  status: AgentStatus;
}

export type OrbitEvent = OrbitMessageEvent | OrbitStatusEvent;

export interface OrbitViewState {
  yaw: number;
  pitch: number;
  zoom: number;
  paused: boolean;
  reduceMotion: boolean;
  selectedAgentId: string | null;
  view: 'oblique' | 'top' | 'side' | 'custom';
}

/** 正式元件須實作清理；目前單頁參考並未提供此 adapter。 */
export interface OrbitSceneAdapter {
  setSnapshot(scene: OrbitScene): void;
  applyEvent(event: OrbitEvent): void;
  setViewState(state: Partial<OrbitViewState>): void;
  dispose(): void;
}
