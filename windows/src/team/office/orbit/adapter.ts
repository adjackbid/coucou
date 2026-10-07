// OfficeStore → the 星域 scene and its transfer events. Pure reads of the
// store the Office already keeps: teams are clusters, members are rings, the
// leader's ties and the team file's links are the standing lines, and a new
// message or delivery in the record is one light travelling along them.
//
// Nothing is made up for looks: no cross-team lines unless a message really
// crossed, no demo routes, no replay of what was already there when the scene
// opened.

import type { MemberSnapshot } from "../contracts";
import type { OfficeStore } from "../store";
import { agentKey, type AgentStatus, type OrbitAgent, type OrbitEvent, type OrbitRelation, type OrbitScene, type OrbitTeam } from "./contracts";

/** A team's standing links from its file (TeamConfig.links), by team id. */
export type TeamLinks = Map<string, readonly { from: string; to: string; kind: string }[]>;

const TEAM_PALETTE = ["#82d7f8", "#b69cec", "#83dec1", "#e9c48d", "#f0a3c4", "#9fd38a", "#f5b86e", "#8fb8ff", "#d7a8f0", "#7fd9e6"];
const AGENT_PALETTE = ["#65b5f2", "#53d5ae", "#aa8ae9", "#fac455", "#ed96c6", "#7fd1ff"];

/** FNV-1a: the same id always gives the same number, whatever the list order. */
export function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A team's colour: fixed by its id, so a team never changes colour when the list is reordered. */
export const teamColor = (teamId: string) => TEAM_PALETTE[hashOf(teamId) % TEAM_PALETTE.length];

const HEX = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;

/** A member's own colour when it has a usable one, else one fixed by its id. */
export function agentColor(m: Pick<MemberSnapshot, "color" | "memberId" | "teamId">): string {
  if (m.color && HEX.test(m.color.trim())) return m.color.trim();
  return AGENT_PALETTE[hashOf(agentKey(m.teamId, m.memberId)) % AGENT_PALETTE.length];
}

/** The store's work status, in the scene's words. Unknown stays unknown: never guessed as done. */
export function agentStatus(m: Pick<MemberSnapshot, "workStatus" | "engineStatus">): AgentStatus {
  switch (m.workStatus) {
    case "error": return "error";
    case "completed": return "done";
    case "unknown": return "unknown";
  }
  if (m.engineStatus === "offline") return "offline";
  switch (m.workStatus) {
    case "working":
    case "planning":
    case "reviewing":
      return "busy";
    case "waiting_dependency":
    case "waiting_input":
    case "blocked":
      return "waiting";
    default:
      return "idle";
  }
}

/** The member a team's lines meet at: its leader, else the member with the smallest id (a layout choice, not a role). */
export function hubOf(team: { leaderMemberId: string }, members: readonly { memberId: string }[]): string | null {
  if (!members.length) return null;
  if (members.some((m) => m.memberId === team.leaderMemberId)) return team.leaderMemberId;
  return [...members].sort((a, b) => a.memberId.localeCompare(b.memberId))[0].memberId;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The company as it stands, as the scene reads it. */
export function sceneFrom(store: OfficeStore, links: TeamLinks, mode: OrbitScene["mode"]): OrbitScene {
  const teams: OrbitTeam[] = [];
  const agents: OrbitAgent[] = [];
  const relations: OrbitRelation[] = [];
  for (const t of store.teams()) {
    if (t.archived) continue;
    const members = store.members(t.teamId);
    const hub = hubOf(t, members);
    teams.push({ id: t.teamId, name: t.name, color: teamColor(t.teamId), leaderAgentId: members.some((m) => m.memberId === t.leaderMemberId) ? agentKey(t.teamId, t.leaderMemberId) : undefined });
    // The hub first: the cluster is laid out around it.
    const ordered = hub ? [members.find((m) => m.memberId === hub)!, ...members.filter((m) => m.memberId !== hub)] : members;
    for (const m of ordered) {
      agents.push({ id: agentKey(t.teamId, m.memberId), teamId: t.teamId, name: m.displayName ?? m.memberId, role: m.roleLabel, status: agentStatus(m), color: agentColor(m) });
    }
    // One standing line from the hub to each other member; a two-member team has one, a five-member team four.
    const seen = new Set<string>();
    if (hub) {
      for (const m of members) {
        if (m.memberId === hub) continue;
        const from = agentKey(t.teamId, hub), to = agentKey(t.teamId, m.memberId);
        seen.add(pairKey(from, to));
        relations.push({ id: `${t.teamId}:core:${hub}>${m.memberId}`, fromAgentId: from, toAgentId: to, kind: "team_connection", directed: false });
      }
    }
    // The team file's own delivery/talk links, between members that exist; the same pair is one line.
    const ids = new Set(members.map((m) => m.memberId));
    for (const l of links.get(t.teamId) ?? []) {
      if (!ids.has(l.from) || !ids.has(l.to) || l.from === l.to) continue;
      const from = agentKey(t.teamId, l.from), to = agentKey(t.teamId, l.to);
      const key = pairKey(from, to);
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push({ id: `${t.teamId}:link:${l.from}>${l.to}`, fromAgentId: from, toAgentId: to, kind: "workflow", directed: true });
    }
  }
  return { schemaVersion: "1.0.0", teams, agents, relations, mode };
}

const SUMMARY_MAX = 36;
const brief = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX)}…` : t;
};

/**
 * What moved since the last look: each message a member sent to another
 * (once per recipient), each delivery handed to the team's hub, and each
 * message the recipient has now read. The first look only takes note of what
 * is already there — the scene opens quiet, and nothing is played twice: a
 * message id is remembered for good.
 */
export class OrbitFeed {
  private sent = new Set<string>();
  private received = new Set<string>();
  private primed = false;

  /**
   * `maxAgeMs`: anything older is remembered but not played — coming back to
   * a hidden window does not replay what happened while it was away.
   */
  pull(store: OfficeStore, now = Date.now(), maxAgeMs = 20_000): OrbitEvent[] {
    const out: OrbitEvent[] = [];
    const fresh = (iso: string) => {
      const t = Date.parse(iso);
      return !Number.isFinite(t) || now - t <= maxAgeMs;
    };
    for (const team of store.teams()) {
      if (team.archived) continue;
      const members = store.members(team.teamId);
      const ids = new Set(members.map((m) => m.memberId));
      const hub = hubOf(team, members);
      for (const m of store.messages(team.teamId, team.currentRunId)) {
        if (m.from.kind !== "member" || !ids.has(m.from.memberId)) continue;
        const to = m.toMemberIds.filter((id) => ids.has(id) && id !== (m.from as { memberId: string }).memberId);
        if (!to.length) continue;
        const from = agentKey(team.teamId, m.from.memberId);
        if (!this.sent.has(m.messageId)) {
          this.sent.add(m.messageId);
          if (this.primed && fresh(m.occurredAt)) {
            for (const r of to) out.push({ id: `${m.messageId}:sent:${r}`, type: "message_sent", messageId: m.messageId, fromAgentId: from, toAgentId: agentKey(team.teamId, r), summary: brief(m.text), occurredAt: m.occurredAt });
          }
        }
        if (m.deliveryStatus === "delivered" && !this.received.has(m.messageId)) {
          this.received.add(m.messageId);
          if (this.primed && fresh(m.updatedAt || m.occurredAt)) {
            for (const r of to) out.push({ id: `${m.messageId}:received:${r}`, type: "message_received", messageId: m.messageId, fromAgentId: from, toAgentId: agentKey(team.teamId, r), summary: brief(m.text), occurredAt: m.updatedAt || m.occurredAt });
          }
        }
      }
      // A deliverable goes to the member the team's lines meet at.
      if (hub) {
        for (const a of store.artifacts(team.teamId, team.currentRunId)) {
          if (this.sent.has(a.artifactId)) continue;
          this.sent.add(a.artifactId);
          if (!this.primed || !fresh(a.updatedAt) || a.authorMemberId === hub || !ids.has(a.authorMemberId)) continue;
          out.push({ id: `${a.artifactId}:delivered`, type: "message_sent", messageId: a.artifactId, fromAgentId: agentKey(team.teamId, a.authorMemberId), toAgentId: agentKey(team.teamId, hub), summary: `交付 · ${brief(a.name)}`, occurredAt: a.updatedAt });
        }
      }
    }
    this.primed = true;
    // Memory stays bounded even on a very long run.
    if (this.sent.size > 5000) this.sent = new Set([...this.sent].slice(-2500));
    if (this.received.size > 5000) this.received = new Set([...this.received].slice(-2500));
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }
}
