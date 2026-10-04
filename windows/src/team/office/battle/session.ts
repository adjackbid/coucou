// Each team's raid as the window has watched it: the last picture, the
// completions seen live, the signals since the window opened (the 戰鬥紀錄),
// and who listens for new ones (the effects). Watching is cheap and happens
// whether 中二模式 is on or not, so the log is there when it is turned on;
// effects are played only where a battle scene is on screen.

import type { Id } from "../contracts";
import type { OfficeStore } from "../store";
import type { BattleSignal, BattleViewModel, HeroClass, Observation, PresentationMode } from "./contracts";
import { inputFrom, project } from "./projector";
import { byId, diff } from "./signals";
import { defaultSkill, HIT_SKILLS, type SkillId } from "./skills";

const LOG_LIMIT = 60;

interface Watch {
  prev: Observation | null;
  ordinal: number;
  log: BattleSignal[];
  /** Signals already handed to listeners: a redraw never plays one twice. */
  played: Set<Id>;
}

/** Extra facts from the raw record the store does not keep: rejections, open questions. */
export type Extras = (teamId: Id) => { rejections?: Map<Id, number>; questionIds?: Id[] };

export class Battle {
  private watches = new Map<Id, Watch>();
  private listeners = new Set<(s: BattleSignal) => void>();

  constructor(private store: () => OfficeStore, private extras: Extras = () => ({})) {}

  /** The boss of a team's current run, as the store has it now. */
  vm(teamId: Id): BattleViewModel | null {
    const input = inputFrom(this.store(), teamId);
    return input ? project(input) : null;
  }

  /** Look at every team again; new signals go to the log and the listeners. */
  observeAll() {
    for (const t of this.store().teams()) this.observe(t.teamId);
  }

  observe(teamId: Id): BattleSignal[] {
    const store = this.store();
    const input = inputFrom(store, teamId);
    if (!input) return [];
    const x = this.extras(teamId);
    const now: Observation = {
      vm: project(input),
      streamId: input.streamId,
      tasks: byId(input.tasks),
      members: new Map(store.members(teamId).map((m) => [m.memberId, m.workStatus])),
      rejections: x.rejections,
      questionIds: x.questionIds,
      runStatus: input.runStatus,
      runRevision: store.run(input.runId)?.revision ?? 0,
    };
    let w = this.watches.get(teamId);
    if (!w) this.watches.set(teamId, (w = { prev: null, ordinal: 0, log: [], played: new Set() }));
    const d = diff(w.prev, now, { completionOrdinal: w.ordinal, observedAt: new Date().toISOString() });
    w.prev = now;
    w.ordinal = d.completionOrdinal;
    const fresh = d.signals.filter((s) => s.kind !== "baseline" && !w.played.has(s.signalId));
    for (const s of fresh) {
      w.played.add(s.signalId);
      w.log.unshift(s);
    }
    if (w.log.length > LOG_LIMIT) w.log.length = LOG_LIMIT;
    if (w.played.size > 400) w.played = new Set([...w.played].slice(-200));
    for (const s of fresh) for (const fn of this.listeners) fn(s);
    return fresh;
  }

  /** The signals seen for a team since the window opened, newest first. */
  log(teamId: Id): readonly BattleSignal[] {
    return this.watches.get(teamId)?.log ?? [];
  }

  onSignal(fn: (s: BattleSignal) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// ── The person's choices: the mode and each hero's look, kept on this machine ──

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* kept until the window closes */
  }
}

export function savedMode(): PresentationMode {
  // A browser opened at `?mode=battle` starts in 中二模式, to look at it.
  if (import.meta.env?.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "battle") return "battle";
  return read("coucou.office.mode") === "battle" ? "battle" : "office";
}

/** Whether the company map plays each room's fight too (it costs more to draw); on unless turned off. */
export function companyLive(): boolean {
  return read("coucou.battle.companyLive") !== "off";
}

export function saveCompanyLive(on: boolean) {
  write("coucou.battle.companyLive", on ? null : "off");
}

/** How smoothly the company map plays each room's fight, in frames per second. */
export function companyFps(): number {
  const n = Number(read("coucou.battle.companyFps"));
  return n === 30 || n === 60 ? n : 20;
}

export function saveCompanyFps(fps: number) {
  write("coucou.battle.companyFps", fps === 30 || fps === 60 ? String(fps) : null);
}

export function saveMode(mode: PresentationMode) {
  write("coucou.office.mode", mode);
}

export const HERO_LABELS: Record<HeroClass, string> = { captain: "隊長", mage: "法師", guardian: "守護者", warrior: "戰士", support: "支援者" };

/**
 * A member's hero look: the person's choice, else one read from its role —
 * a look only, never a duty or a power.
 */
export function heroOf(teamId: Id, memberId: Id, role: string, leader: boolean, index: number): HeroClass {
  const chosen = read(`coucou.battle.hero.${teamId}.${memberId}`) as HeroClass | null;
  if (chosen && chosen in HERO_LABELS) return chosen;
  if (leader) return "captain";
  if (/測試|驗收|檢查|審核|品質|QA|test/i.test(role)) return "guardian";
  if (/圖|設計|美術|影像|生成|視覺|動畫|art|design/i.test(role)) return "mage";
  if (/開發|工程|前端|後端|程式|網站|實作|dev|code/i.test(role)) return "warrior";
  if (/整合|支援|文件|整理|翻譯|研究|資料|support|doc/i.test(role)) return "support";
  return (["mage", "guardian", "warrior", "support"] as HeroClass[])[index % 4];
}

export function setHero(teamId: Id, memberId: Id, hero: HeroClass | null) {
  write(`coucou.battle.hero.${teamId}.${memberId}`, hero);
}

/** A member's move when its work is accepted: the person's choice, else one from its look. A look only — every task is still 100 HP. */
export function skillOf(teamId: Id, memberId: Id, hero: HeroClass, index: number): SkillId {
  const chosen = read(`coucou.battle.skill.${teamId}.${memberId}`) as SkillId | null;
  if (chosen && HIT_SKILLS.includes(chosen)) return chosen;
  return defaultSkill(hero, index);
}

export function setSkill(teamId: Id, memberId: Id, skill: SkillId | null) {
  write(`coucou.battle.skill.${teamId}.${memberId}`, skill);
}
