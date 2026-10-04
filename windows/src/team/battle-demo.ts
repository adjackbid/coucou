// `npm run dev` only, to look at 中二模式 in a browser; the app never loads this.
//
// `team.html?view=office&mode=battle&battle=play` — the demo team works
// through a raid on its own: a hand-in, an acceptance, new work, a combo of
// two, the same two again inside the combo's cool-down (single moves), a
// question and its answer, a combo of three that seals the boss, the
// leader's report.
//
// `…&pose=combo_fire_wind:520` — one move held still at that many ms.

import type { Snapshot } from "./types";
import type { Office } from "./office/office";
import type { BattleSignal, HeroClass, SignalKind } from "./office/battle/contracts";
import { SKILLS, type HitPlan, type SkillId } from "./office/battle/skills";

function look(team: string, member: string, hero: HeroClass | null, skill: SkillId | null) {
  try {
    if (hero) localStorage.setItem(`coucou.battle.hero.${team}.${member}`, hero);
    if (skill) localStorage.setItem(`coucou.battle.skill.${team}.${member}`, skill);
  } catch {
    /* the defaults then */
  }
}

export function playBattle(snap: Snapshot, apply: (next: Snapshot) => void) {
  // Two members whose moves make a combo: fire and wind.
  look(snap.id, "ai4", null, "fire_ember");
  look(snap.id, "ai2", null, "wind_crescent");
  const task = (id: string) => snap.tasks.find((t) => t.id === id)!;
  const accept = (ids: string[], at = Date.now()) => {
    for (const id of ids) {
      const t = task(id);
      t.status = "done";
      t.updatedAt = at;
      snap.feed = [...snap.feed, { at, kind: "accepted", from: "ai1", to: t.owner, text: "", task: id }];
    }
  };
  const member = (id: string) => snap.members.find((m) => m.id === id)!;
  const added = (id: string, title: string, owner: string) => ({ ...task("TASK-07"), id, title, owner, status: "todo" as const, dependsOn: [], rejections: 0, createdAt: Date.now(), updatedAt: Date.now() });
  const steps: [number, () => void][] = [
    // AI 3 hands in the cart: it waits behind the review shield.
    [1500, () => { task("TASK-04").status = "delivered"; }],
    // Accepted: AI 3's blade.
    [4000, () => accept(["TASK-04"])],
    // The leader adds four tasks: the boss regains 400.
    [6500, () => {
      snap.tasks = [...snap.tasks, added("TASK-08", "優惠券", "ai4"), added("TASK-09", "會員登入", "ai3"), added("TASK-10", "訂單查詢", "ai2"), added("TASK-11", "商品評價", "ai4")];
      task("TASK-06").status = "doing";
    }],
    // AI 4 and AI 2 accepted together: fire and wind, one blow of -200.
    [9000, () => {
      task("TASK-05").owner = "ai4";
      accept(["TASK-05", "TASK-06"]);
    }],
    // The same two again, inside the 12 s after a combo: each its own move.
    [13500, () => accept(["TASK-08", "TASK-10"])],
    // The leader asks the person: the boss counters, a guard goes up.
    [16000, () => {
      const m = member("ai1");
      m.status = "waitingYou";
      m.waiting = { on: "you", what: "首版要支援手機版嗎?", task: "TASK-07" };
      snap.questions = [...snap.questions, { id: "Q-battle", by: "ai1", question: "首版要支援手機版嗎?", task: "TASK-07", at: Date.now(), answer: null }];
    }],
    // Answered: freed.
    [18500, () => {
      const m = member("ai1");
      m.status = "working";
      m.waiting = null;
      snap.questions = snap.questions.map((q) => (q.id === "Q-battle" ? { ...q, answer: "要" } : q));
    }],
    // Three members' work accepted together: 三曜協奏, and every task is done — sealed, not won.
    [23000, () => {
      task("TASK-07").owner = "ai1";
      accept(["TASK-07", "TASK-09", "TASK-11"]);
    }],
    // The leader's report: the boss is defeated.
    [27000, () => {
      snap.status = "finished";
      snap.finishedAt = Date.now();
      for (const m of snap.members) {
        m.status = "done";
        m.task = null;
      }
    }],
  ];
  for (const [at, step] of steps) {
    window.setTimeout(() => {
      step();
      snap.done = snap.tasks.filter((t) => t.status === "done").length;
      snap.total = snap.tasks.length;
      snap.seq += 1;
      apply({ ...snap });
    }, at);
  }
}

/** Who shows each move in a held picture, and how they must look for it. */
const CAST: Record<string, { members: string[]; looks?: [string, HeroClass | null, SkillId | null][] }> = {
  fire_ember: { members: ["ai4"], looks: [["ai4", "mage", "fire_ember"]] },
  ice_lance: { members: ["ai4"], looks: [["ai4", "mage", "ice_lance"]] },
  wind_crescent: { members: ["ai4"], looks: [["ai4", "mage", "wind_crescent"]] },
  lightning_chain: { members: ["ai4"], looks: [["ai4", "mage", "lightning_chain"]] },
  blade_crescent: { members: ["ai3"], looks: [["ai3", "warrior", "blade_crescent"]] },
  blade_pierce: { members: ["ai3"], looks: [["ai3", "warrior", "blade_pierce"]] },
  blade_counter: { members: ["ai3"], looks: [["ai3", "warrior", "blade_counter"]] },
  blade_heavy: { members: ["ai3"], looks: [["ai3", "warrior", "blade_heavy"]] },
  combo_fire_wind: { members: ["ai4", "ai2"], looks: [["ai4", "mage", "fire_ember"], ["ai2", "support", "wind_crescent"]] },
  combo_ice_lightning: { members: ["ai4", "ai2"], looks: [["ai4", "mage", "ice_lance"], ["ai2", "support", "lightning_chain"]] },
  combo_ward_blade: { members: ["ai2", "ai3"], looks: [["ai2", "guardian", "blade_counter"], ["ai3", "warrior", "blade_crescent"]] },
  combo_trinity: { members: ["ai1", "ai3", "ai4"] },
};

export function poseBattle(office: Office, teamId: string, spec: string) {
  const [move, at] = spec.split(":");
  const ms = Number(at) || 0;
  const vm = office.battle.vm(teamId);
  const layer = office.debugLayer(teamId);
  if (!vm || !layer) return;
  const cast = CAST[move];
  for (const [m, hero, skill] of cast?.looks ?? []) look(teamId, m, hero, skill);
  const members = cast?.members ?? [];
  const kind: SignalKind = cast ? "acceptance_hit" : (move as SignalKind);
  const actor = { delivery_waiting: "ai3", review_returned: "ai3", task_started: "ai3", boss_counter: "ai1", unblock_support: "ai1", member_interrupted: "ai2" }[move as string] ?? members[0] ?? null;
  const signal: BattleSignal = {
    teamId, runId: vm.runId, signalId: `pose|${move}`, kind,
    source: { teamId, runId: vm.runId, kind: "manual_replay", streamId: null, domainSeq: null, taskIds: members.map((m) => `${teamId}:pose-${m}`), memberIds: [], questionIds: [] },
    reasonLabel: "", hpBefore: null, hpAfter: null, maxHpBefore: null, maxHpAfter: null,
    displayDelta: kind === "scope_added" ? 200 : null, actorMemberId: actor, observedAt: new Date().toISOString(),
    evidence: move === "review_returned" ? "explicit_event" : "observed_transition", replay: true,
  };
  const skillId = cast ? (move as SkillId) : null;
  const plan: HitPlan | null = skillId
    ? {
        planId: `pose|${move}`, teamId, runId: vm.runId, skillId, kind: members.length > 1 ? "combo" : "solo",
        acceptanceKeys: members.map((m) => `pose-${m}`), sourceSignalIds: [signal.signalId], taskIds: signal.source.taskIds.slice(),
        memberIds: members, displayDamage: 100 * members.length, damageLabelCount: 1, durationMs: SKILLS[skillId].durationMs,
      }
    : null;
  layer.pose(signal, plan, ms);
}
