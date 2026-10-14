// What 中二模式 adds to the page, in real DOM: the boss's name, its HP and
// shield over the scene, the 戰鬥紀錄 beside it, the badges on the company
// map. Every line says what really happened next to how the raid tells it.

import { h } from "../../../views/dom";
import { tr, trf } from "../../../core/i18n";
import type { Id } from "../contracts";
import type { BattleSignal, BattleViewModel, BossState, SignalKind } from "./contracts";
import { WORLDS, type World } from "./worlds";
import "./battle.css";

const ICONS: Record<string, string> = {
  hit: '<path d="M14.5 3.5 20.5 9.5 10 20 4 20 4 14Z"/><path d="M13 5 19 11"/>',
  shield: '<path d="M12 3 20 6v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6Z"/>',
  crystal: '<path d="M12 2 18 9 12 22 6 9Z"/><path d="M6 9h12M12 2v20"/>',
  counter: '<path d="M12 3 22 20H2Z"/><path d="M12 10v4M12 17v.5"/>',
  heal: '<path d="M12 21s-8-4.8-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.2-8 11-8 11Z"/>',
  spark: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4"/>',
  crack: '<path d="M4 4l6 6-3 3 6 6M14 4l-2 6 6 2-2 8"/>',
  freeze: '<path d="M12 2v20M3.5 7l17 10M20.5 7l-17 10"/>',
  seal: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5Z"/>',
  wake: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M21 3v6h-6"/>',
  adjust: '<path d="M4 12h16M14 6l6 6-6 6"/>',
};

const icon = (name: string, cls = "") =>
  h("span", { class: `bt-icon ${cls}`, "aria-hidden": "true", html: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.spark}</svg>` });

/** How the raid tells each kind of signal: its icon, its tone, its words. */
const TELL: Record<SignalKind, { icon: string; tone: string; title: (s: BattleSignal) => string }> = {
  acceptance_hit: { icon: "hit", tone: "hit", title: (s) => trf("驗收命中 HP {d}", "Accepted! HP {d}", { d: s.displayDelta ?? "" }) },
  scope_added: { icon: "crystal", tone: "regen", title: (s) => trf("需求增加 HP +{d}", "More asks HP +{d}", { d: s.displayDelta ?? 0 }) },
  scope_adjusted: { icon: "adjust", tone: "quiet", title: () => tr("範圍調整", "Scope adjusted") },
  delivery_waiting: { icon: "shield", tone: "shield", title: () => tr("攻擊被驗收護盾擋下", "Blocked by the review shield") },
  review_returned: { icon: "shield", tone: "counter", title: (s) => (s.evidence === "explicit_event" ? tr("護盾反彈:需要修改", "Shield bounce: changes needed") : tr("返回執行", "Back in progress")) },
  task_started: { icon: "spark", tone: "quiet", title: () => tr("英雄蓄力", "Hero charging up") },
  boss_counter: { icon: "counter", tone: "counter", title: () => tr("魔王反擊", "Boss strikes back") },
  unblock_support: { icon: "heal", tone: "heal", title: () => tr("解除封印,支援抵達", "Unsealed, backup has arrived") },
  member_interrupted: { icon: "crack", tone: "counter", title: () => tr("英雄受創", "Hero wounded") },
  pause: { icon: "freeze", tone: "quiet", title: () => tr("戰場冰封", "Battlefield frozen") },
  seal_wait: { icon: "seal", tone: "seal", title: () => tr("魔王被封印", "Boss sealed") },
  victory: { icon: "crown", tone: "win", title: () => tr("需求魔王 被擊敗!", "Requirements Overlord defeated!") },
  reopen: { icon: "wake", tone: "regen", title: () => tr("魔王蠢蠢欲動", "The boss stirs again") },
  baseline: { icon: "spark", tone: "quiet", title: () => tr("目前戰況", "Battle so far") },
};

/** The boss's line under its name, by how the fight stands — in its world's own words. */
function line(vm: BattleViewModel, world: World): string {
  const lines: Record<BossState, string> = {
    planning: tr("Leader 還在拆解任務,魔王尚未現身", "The Leader is still breaking down the tasks, the boss hasn't shown up yet"),
    engaged: vm.phase === "last_seal" ? tr("只剩最後的封印,再加把勁!", "Only the last seal left, one more push!") : vm.phase === "rage" ? tr("魔王開始焦躁了,繼續推進!", "The boss is getting rattled, keep pushing!") : world.line,
    sealing: world.sealedLine,
    paused: tr("戰場冰封:團隊已暫停", "Battlefield frozen: the team is paused"),
    defeated: world.defeatedLine,
    stopped: tr("團隊已停止,魔王沒有被擊敗", "The team stopped, the boss wasn't defeated"),
    inconsistent: tr("團隊已結案,但還有任務沒完成", "The team closed out, but some tasks aren't done"),
    syncing: vm.consistencyIssue ?? tr("資料更新中…", "Updating…"),
  };
  return lines[vm.bossState];
}

/** Over the scene: the boss's name, HP and line; its shield and what waits on the person. */
/** 封印中 the boss keeps a sliver of HP: the last blow is the Leader's to strike. */
export function shownHp(vm: BattleViewModel): number | null {
  if (vm.hp === null) return null;
  if (vm.bossState === "sealing" && vm.maxHp) return Math.max(1, Math.round(vm.maxHp * 0.02));
  return vm.hp;
}

export function teamBar(team: { used: number; max: number } | null | undefined): HTMLElement | null {
  if (!team || !team.max) return null;
  const left = Math.max(0, team.max - team.used);
  const share = left / team.max;
  return h(
    "div",
    { class: "bt-team-hp", title: tr("我方生命=剩下的回合數。每用一回合扣一點;短時間用掉太多,魔王會放絕招。", "Your party's HP = the turns left. Each turn costs one point; burn too many too fast and the boss unleashes its ultimate.") },
    h("span", { class: "bt-team-word", text: tr("我方", "Party") }),
    h("div", { class: `bt-bar team${share <= 0.2 ? " low" : ""}` }, h("i", { style: `width:${share ? Math.max(1.5, share * 100).toFixed(1) : 0}%` })),
    h("span", { class: "bt-team-n" }, h("b", { text: String(left) }), h("small", { text: trf(" / {max} 回合", " / {max} turns", { max: team.max }) })),
  );
}

export function bossHud(vm: BattleViewModel, world: World = WORLDS.office): HTMLElement {
  const won = vm.bossState === "defeated";
  const hp = shownHp(vm);
  const share = hp !== null && vm.maxHp ? hp / vm.maxHp : 0;
  return h(
    "div",
    { class: `bt-hud ${vm.bossState}`, role: "group", "aria-label": world.bossName },
    h(
      "div",
      { class: "bt-boss" },
      h("b", { class: "bt-name" }, world.bossName, won ? h("span", { class: "bt-won", text: tr(" 已擊敗", " defeated") }) : null,
        h("span", { class: "bt-arena", text: ` ${world.arenaName}` })),
      h("span", { class: "bt-line", text: line(vm, world) }),
      h(
        "div",
        { class: "bt-hp", "aria-label": hp === null ? tr("HP 尚未出現", "No HP yet") : `HP ${hp} / ${vm.maxHp}` }, // i18n-ok: HP is the same in both languages
        h("span", { class: "bt-hp-label", text: "HP" }), // i18n-ok: HP is the same in both languages
        h("b", { text: hp === null ? "—" : String(hp) }),
        h("small", { text: vm.maxHp === null ? "" : ` / ${vm.maxHp}` }),
      ),
      h("div", { class: `bt-bar ${vm.phase ?? ""}` }, h("i", { style: `width:${share ? Math.max(1.5, share * 100).toFixed(1) : 0}%` })),
    ),
    h(
      "div",
      { class: "bt-flags" },
      vm.reviewingCount > 0 ? h("span", { class: "bt-shield", title: tr("交付了、等待驗收的任務:驗收通過才扣 HP", "Tasks handed in and waiting for review: HP drops only once they're accepted") }, icon("shield"), tr("待驗收 ", "In review "), h("b", { text: String(vm.reviewingCount) }), tr(" 項", "")) : null,
      vm.needsHuman ? h("span", { class: "bt-flag alert", title: tr("有成員在等你回覆或批准", "A member is waiting for your reply or approval") }, icon("counter"), tr("等你決定", "Your call")) : null,
      vm.blockedTaskIds.length ? h("span", { class: "bt-flag", title: tr("卡住、等別人的任務", "Tasks stuck or waiting on someone") }, trf("{n} 項受阻", "{n} blocked", { n: vm.blockedTaskIds.length })) : null,
    ),
  );
}

/** The 戰鬥紀錄: how the raid told it, and what really happened, newest first. */
export function battleLog(signals: readonly BattleSignal[], opts: { name: (memberId: Id) => string; open: (s: BattleSignal) => void; moves?: (signalId: Id) => string[] | undefined }): HTMLElement {
  if (!signals.length) {
    return h("p", { class: "dim bt-empty", text: tr("打開這個畫面之後,成員的交付、驗收、提問和結案,都會在這裡變成戰況。", "From now on, the members' hand-ins, acceptances, questions and close-outs turn into the battle here.") });
  }
  return h(
    "ol",
    { class: "bt-log" },
    ...signals.map((s) => {
      const t = TELL[s.kind];
      const at = new Date(s.observedAt);
      const who = s.actorMemberId ? trf(" · 來自 {name}", " · from {name}", { name: opts.name(s.actorMemberId) }) : "";
      // The moves an acceptance was shown with: a combo names its two or three members.
      const moves = opts.moves?.(s.signalId);
      return h(
        "li",
        {},
        h(
          "button",
          { class: `bt-log-row t-${t.tone}`, type: "button", title: tr("看真實的任務或成員", "See the real task or member"), onClick: () => opts.open(s) },
          h("time", { text: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` }),
          icon(t.icon, `t-${t.tone}`),
          h("span", { class: "bt-log-text" }, h("b", { text: t.title(s) }), h("small", { text: `${s.reasonLabel}${who}` }), moves?.length ? h("small", { class: "bt-move", text: moves.join(tr("、", ", ")) }) : null),
        ),
      );
    }),
  );
}

/** The picked room's boss, on the company map: still, its numbers, the way in. */
export function bossCard(vm: BattleViewModel, opts: { added: number; board: () => void; world?: World }): HTMLElement {
  const hp = shownHp(vm);
  const share = hp !== null && vm.maxHp ? hp / vm.maxHp : 0;
  const state = companyState(vm);
  const world = opts.world ?? WORLDS.office;
  return h(
    "div",
    { class: "office-card bt-boss-card" },
    h("div", { class: "row" }, icon("crystal", "t-seal"), h("h3", { class: "grow", text: world.bossName }), h("span", { class: `bt-room-state ${state.tone}`, style: "position:static" }, state.label)),
    h("p", { class: "dim", text: line(vm, world) }),
    h(
      "div",
      { class: "bt-boss-figures" },
      h("span", { title: tr("這次開窗之後新增進度的任務", "Tasks added to the progress since this window opened") }, h("small", { text: tr("新增需求", "New asks") }), h("b", { text: opts.added ? `+${opts.added}` : "0" })),
      h("span", {}, h("small", { text: tr("目前 HP", "HP now") }), h("b", { text: hp === null ? "—" : `${hp} / ${vm.maxHp}` }), h("i", { class: "bt-mini-bar" }, h("i", { style: `width:${share ? Math.max(1.5, share * 100).toFixed(1) : 0}%` }))),
    ),
    vm.reviewingCount ? h("p", { class: "dim" }, icon("shield", "t-shield"), trf(" 待驗收 {n} 項", " {n} in review", { n: vm.reviewingCount })) : null,
    h("div", { class: "bt-actions" }, h("button", { class: "btn plain", type: "button", onClick: opts.board }, tr("查看任務", "See tasks"))),
  );
}

/** On a room of the company map: the boss's state and HP, still. */
export function roomBadge(vm: BattleViewModel | null): HTMLElement | null {
  if (!vm) return null;
  const state = companyState(vm);
  const hp = shownHp(vm);
  const share = hp !== null && vm.maxHp ? hp / vm.maxHp : 0;
  return h(
    "div",
    { class: `bt-room ${state.tone}` },
    h("span", { class: `bt-room-state ${state.tone}` }, state.tone === "won" ? icon("crown") : null, state.label),
    vm.maxHp !== null ? h("span", { class: "bt-room-hp" }, `HP ${hp} / ${vm.maxHp}`, h("i", { class: "bt-mini-bar" }, h("i", { style: `width:${share ? Math.max(1.5, share * 100).toFixed(1) : 0}%` }))) : null,
  );
}

/** The company map's words for a boss: 討伐中, 需介入, 已擊敗, 待命 — and paused, stopped, never counted as won. */
export function companyState(vm: BattleViewModel): { label: string; tone: "fight" | "alert" | "won" | "idle" } {
  if (vm.bossState === "defeated") return { label: tr("已擊敗", "Defeated"), tone: "won" };
  if (vm.needsHuman || vm.bossState === "inconsistent") return { label: tr("需介入", "Needs you"), tone: "alert" };
  if (vm.bossState === "engaged" || vm.bossState === "sealing") return { label: vm.bossState === "sealing" ? tr("封印中", "Sealing") : tr("討伐中", "Fighting"), tone: "fight" };
  if (vm.bossState === "paused") return { label: tr("冰封", "Frozen"), tone: "idle" };
  if (vm.bossState === "stopped") return { label: tr("已停止", "Stopped"), tone: "idle" };
  return { label: tr("待命", "Standing by"), tone: "idle" };
}
