// The bosses' own moves (feature2 kit v4: boss-moves.json): each of the five
// world bosses answers the work with six moves of its own — three attacks,
// one ultimate, a guard and a regain — chosen only from real, newly observed
// causes: a member newly waiting on the person, a new dependency wait, a
// tool error, a hand-in waiting for review, tasks truly added. Never from a
// timer, never from chat, never twice for the same source signal, and never
// anything but looks: a move hurts no hero, writes no task, moves no HP.

import { tr } from "../../../core/i18n";
import type { Id } from "../contracts";
import type { BossState } from "./contracts";

export type WorldBossId = "lava-dragon" | "frost-queen" | "root-king" | "thunder-emperor" | "astral-devourer";
export type BossBlockCause = "human_input" | "dependency_wait" | "tool_error" | "unknown";
export type BossMoveKind = "attack" | "ultimate" | "guard" | "regen";

export interface BossMove {
  moveId: string;
  bossId: WorldBossId;
  name: string;
  kind: BossMoveKind;
  geometryId: string;
  /** Where the telegraph and the cast end, and the whole move's length, in ms. */
  phases: [number, number, number];
  palette: [string, string, string];
  warningColor: string;
  /** The boss's point its path starts from (an anchor name of its art). */
  sourceAnchor: string;
}

const P = {
  lava: ["#FF9B34", "#FFD272", "#A94C32"] as [string, string, string],
  frost: ["#91DBFF", "#D8F5FF", "#90A5E6"] as [string, string, string],
  root: ["#81C678", "#D3B981", "#369D79"] as [string, string, string],
  thunder: ["#76CEFA", "#D9B268", "#9F99FF"] as [string, string, string],
  astral: ["#B693F0", "#E0B76F", "#6D69BB"] as [string, string, string],
};

/** A move; its name is read when drawn, so it follows the language. */
const move = (moveId: string, bossId: WorldBossId, name: () => string, kind: BossMoveKind, geometryId: string, phases: [number, number, number], palette: [string, string, string], sourceAnchor: string, warningColor = "#EFB052"): BossMove => ({ moveId, bossId, get name() { return name(); }, kind, geometryId, phases, palette, warningColor, sourceAnchor });

export const BOSS_MOVES: Record<string, BossMove> = Object.fromEntries(
  [
    move("lava_flame_breath", "lava-dragon", () => tr("扇焰吐息", "Fanfire Breath"), "attack", "cone_breath", [320, 740, 1250], P.lava, "breathOrigin"),
    move("lava_tail_sweep", "lava-dragon", () => tr("熔尾橫掃", "Molten Tail Sweep"), "attack", "semicircle_tail", [260, 640, 1100], P.lava, "tailTip"),
    move("lava_fissure_chain", "lava-dragon", () => tr("裂地熔脈", "Fissure Veins"), "attack", "staggered_zigzag", [380, 920, 1400], P.lava, "counterOrigin"),
    move("lava_crater_core", "lava-dragon", () => tr("龍巢爆芯", "Lair Core Burst"), "ultimate", "three_vent_pillars", [450, 1050, 1500], P.lava, "coreCenter"),
    move("lava_obsidian_guard", "lava-dragon", () => tr("岩甲熔盾", "Obsidian Guard"), "guard", "folding_basalt_plates", [100, 350, 650], P.lava, "coreCenter"),
    move("lava_core_reforge", "lava-dragon", () => tr("熔晶回鑄", "Core Reforge"), "regen", "molten_shards_inward", [200, 600, 900], P.lava, "coreCenter"),
    move("frost_mirror_refract", "frost-queen", () => tr("霜鏡折射", "Mirror Refraction"), "attack", "two_mirror_bends", [360, 780, 1200], P.frost, "mirrorOrigin", "#9CC8E8"),
    move("frost_spike_grid", "frost-queen", () => tr("冰刺棋陣", "Ice Spike Grid"), "attack", "diamond_l_grid", [420, 900, 1350], P.frost, "counterOrigin", "#9CC8E8"),
    move("frost_ring_tide", "frost-queen", () => tr("凝霜環潮", "Rime Ring Tide"), "attack", "expanding_hollow_annulus", [350, 850, 1250], P.frost, "groundPivot", "#9CC8E8"),
    move("frost_crown_shatter", "frost-queen", () => tr("冰冠碎星", "Crown Shatter"), "ultimate", "crown_three_shard_paths", [500, 1000, 1500], P.frost, "crownTip", "#9CC8E8"),
    move("frost_mirror_guard", "frost-queen", () => tr("霜鏡反幕", "Mirror Veil"), "guard", "tilted_core_pane", [150, 500, 700], P.frost, "coreCenter", "#9CC8E8"),
    move("frost_crown_rebuild", "frost-queen", () => tr("冰冠重結", "Crown Reforged"), "regen", "ascending_crown_facets", [200, 700, 1000], P.frost, "crownTip", "#9CC8E8"),
    move("root_loop_bind", "root-king", () => tr("盤根束陣", "Root Snare"), "attack", "connected_open_root_loops", [400, 750, 1250], P.root, "rootOrigin", "#C8B06A"),
    move("root_vine_whip", "root-king", () => tr("藤鞭連掃", "Vine Lash"), "attack", "braided_double_curve", [350, 700, 1150], P.root, "vineTip", "#C8B06A"),
    move("root_thorn_return", "root-king", () => tr("荊棘回刺", "Thorn Return"), "attack", "back_to_front_thorn_points", [450, 850, 1300], P.root, "rootOrigin", "#C8B06A"),
    move("root_canopy_resonance", "root-king", () => tr("枝海共振", "Canopy Resonance"), "ultimate", "branching_three_node_pulses", [450, 1050, 1500], P.root, "canopyCenter", "#C8B06A"),
    move("root_vine_guard", "root-king", () => tr("藤籠護核", "Vine Cage"), "guard", "braided_core_cage", [160, 420, 700], P.root, "coreCenter", "#C8B06A"),
    move("root_bud_regrowth", "root-king", () => tr("新芽續枝", "Budding Regrowth"), "regen", "seed_stream_crown_bud", [250, 750, 1100], P.root, "canopyCenter", "#C8B06A"),
    move("thunder_polarity_lanes", "thunder-emperor", () => tr("極性導雷", "Polarity Lanes"), "attack", "parallel_polarity_lanes", [330, 780, 1150], P.thunder, "coilLeft", "#E8B860"),
    move("thunder_orb_relay", "thunder-emperor", () => tr("雷球接力", "Orb Relay"), "attack", "three_beacon_relay", [420, 900, 1300], P.thunder, "coilRight", "#E8B860"),
    move("thunder_coil_pulse", "thunder-emperor", () => tr("線圈脈衝", "Coil Pulse"), "attack", "paired_short_coil_waves", [280, 680, 1100], P.thunder, "coilLeft", "#E8B860"),
    move("thunder_matrix_overload", "thunder-emperor", () => tr("矩陣超載", "Matrix Overload"), "ultimate", "orthogonal_grid_scan", [450, 1100, 1500], P.thunder, "coreCenter", "#E8B860"),
    move("thunder_magnetic_guard", "thunder-emperor", () => tr("磁場輪盾", "Magnetic Ring Shield"), "guard", "counter_rotating_core_rings", [120, 420, 650], P.thunder, "coreCenter", "#E8B860"),
    move("thunder_cell_expand", "thunder-emperor", () => tr("電芯增容", "Cell Overcharge"), "regen", "gear_cell_insertions", [200, 650, 1000], P.thunder, "coreCenter", "#E8B860"),
    move("astral_gravity_well", "astral-devourer", () => tr("重力渦井", "Gravity Well"), "attack", "local_inward_spiral", [400, 800, 1300], P.astral, "orbitOrigin", "#C9A6E8"),
    move("astral_orbit_cut", "astral-devourer", () => tr("碎環切線", "Orbit Cut"), "attack", "two_tangent_orbit_cuts", [350, 800, 1200], P.astral, "orbitOrigin", "#C9A6E8"),
    move("astral_rift_fold", "astral-devourer", () => tr("裂隙折躍", "Rift Fold"), "attack", "paired_portal_fold", [420, 850, 1300], P.astral, "riftOrigin", "#C9A6E8"),
    move("astral_eclipse_convergence", "astral-devourer", () => tr("蝕星收束", "Eclipse Convergence"), "ultimate", "inward_eclipse_arcs", [500, 1100, 1500], P.astral, "coreCenter", "#C9A6E8"),
    move("astral_orbit_deflect", "astral-devourer", () => tr("軌道偏折", "Orbit Deflect"), "guard", "orbital_shard_deflection", [180, 500, 750], P.astral, "orbitOrigin", "#C9A6E8"),
    move("astral_ring_expand", "astral-devourer", () => tr("星環增軌", "Ring Accretion"), "regen", "outer_orbit_accretion", [240, 740, 1100], P.astral, "orbitOrigin", "#C9A6E8"),
  ].map((m) => [m.moveId, m]),
);

/** Each boss's six moves: three attacks (person / dependency / tool error), the ultimate, the guard, the regain. */
export const BOSS_KIT: Record<WorldBossId, { attacks: [string, string, string]; ultimate: string; guard: string; regen: string }> = {
  "lava-dragon": { attacks: ["lava_flame_breath", "lava_tail_sweep", "lava_fissure_chain"], ultimate: "lava_crater_core", guard: "lava_obsidian_guard", regen: "lava_core_reforge" },
  "frost-queen": { attacks: ["frost_mirror_refract", "frost_spike_grid", "frost_ring_tide"], ultimate: "frost_crown_shatter", guard: "frost_mirror_guard", regen: "frost_crown_rebuild" },
  "root-king": { attacks: ["root_loop_bind", "root_vine_whip", "root_thorn_return"], ultimate: "root_canopy_resonance", guard: "root_vine_guard", regen: "root_bud_regrowth" },
  "thunder-emperor": { attacks: ["thunder_polarity_lanes", "thunder_orb_relay", "thunder_coil_pulse"], ultimate: "thunder_matrix_overload", guard: "thunder_magnetic_guard", regen: "thunder_cell_expand" },
  "astral-devourer": { attacks: ["astral_gravity_well", "astral_orbit_cut", "astral_rift_fold"], ultimate: "astral_eclipse_convergence", guard: "astral_orbit_deflect", regen: "astral_ring_expand" },
};

export const ULTIMATE_COOLDOWN_MS = 12000;

/** What the selection looks at: one signal, after one atomic apply, as the kit's contract has it. */
export interface BossCueContext {
  bossId: WorldBossId;
  signalKind: string;
  sourceSignalIds: readonly Id[];
  evidence: "observed_transition" | "explicit_event" | "unknown";
  /** Checked against the real record; unknown when it cannot be. */
  cause: BossBlockCause;
  /** Tasks newly blocked (or questions newly waiting) in this apply — never the standing total. */
  newlyBlockedTaskIds: readonly Id[];
  addedCountedUncompletedTaskIds: readonly Id[];
  /** The projector's own scope growth; never the net HP change of a mixed batch. */
  scopeGrowthContributionHp: number;
  bossStateAfterApply: BossState;
  live: boolean;
  visible: boolean;
  modeEnabled: boolean;
  history: boolean;
  syncing: boolean;
  paused: boolean;
  reducedMotion: boolean;
  ultimateCooldownActive: boolean;
  /** Raw source signal ids already shown, shared across bosses, moves and themes. */
  consumedSourceSignalIds: ReadonlySet<Id>;
  /** False while the boss's own anchors are not measured: the move is a still label. */
  poseAnchorsVerified?: boolean;
}

export interface BossCue {
  moveId: string;
  kind: BossMoveKind;
  consumedSourceSignalIds: Id[];
  sourceTaskIds: Id[];
  heroHpDelta: 0;
  extraBossDamage: 0;
  /** Only words for the DOM beside the real growth; never written back. */
  scopeGrowthLabelHp: number;
  durationMs: number;
  animated: boolean;
}

/**
 * One signal, at most one cue (boss-moves.json's rules). Pure: the same
 * context gives the same cue, and a null is a null for good — nothing is
 * kept to be played later.
 */
export function chooseBossCue(ctx: BossCueContext): BossCue | null {
  const kit = BOSS_KIT[ctx.bossId];
  if (!kit) return null;
  // Not live, not watched, not this run's own present: no move, and no debt of one.
  if (!ctx.live || !ctx.visible || !ctx.modeEnabled || ctx.history || ctx.syncing || ctx.paused) return null;
  if (ctx.bossStateAfterApply !== "engaged") return null;
  if (ctx.sourceSignalIds.some((id) => ctx.consumedSourceSignalIds.has(id))) return null;
  const blocked = [...new Set(ctx.newlyBlockedTaskIds)];
  let moveId: string | null = null;
  let label = 0;
  switch (ctx.signalKind) {
    case "scope_added":
      // Only tasks truly added and counted regain the boss; words alone never do.
      if (!ctx.addedCountedUncompletedTaskIds.length || ctx.scopeGrowthContributionHp <= 0) return null;
      moveId = kit.regen;
      label = ctx.scopeGrowthContributionHp;
      break;
    case "delivery_waiting":
      moveId = kit.guard;
      break;
    case "review_returned":
      // Only a rejection the record states; an unknown return is words, not a counter.
      if (ctx.evidence !== "explicit_event") return null;
      moveId = kit.attacks[2];
      break;
    case "boss_counter": {
      if (!blocked.length) return null;
      if (blocked.length >= 2) moveId = ctx.ultimateCooldownActive ? kit.attacks[0] : kit.ultimate;
      else if (ctx.cause === "dependency_wait") moveId = kit.attacks[1];
      else if (ctx.cause === "tool_error") moveId = kit.attacks[2];
      else moveId = kit.attacks[0];
      break;
    }
    default:
      return null;
  }
  const m = BOSS_MOVES[moveId];
  return {
    moveId,
    kind: m.kind,
    consumedSourceSignalIds: [...ctx.sourceSignalIds],
    sourceTaskIds: blocked,
    heroHpDelta: 0,
    extraBossDamage: 0,
    scopeGrowthLabelHp: label,
    durationMs: m.phases[2],
    // Still anchors or 減少動態: the move is its name and its reason, nothing moving.
    animated: !ctx.reducedMotion && ctx.poseAnchorsVerified !== false,
  };
}

/**
 * A real unblock cancels what has not been cast — only when the record says
 * every one of the move's blocked sources is resolved. A part is never told
 * as the whole.
 */
export function resolvesWholeCast(activePlanSourceTaskIds: readonly Id[], verifiedResolvedTaskIds: readonly Id[]): boolean {
  const resolved = new Set(verifiedResolvedTaskIds);
  return activePlanSourceTaskIds.length > 0 && activePlanSourceTaskIds.every((t) => resolved.has(t));
}

/** The clock and the memory round chooseBossCue: the 12 s after an ultimate, the sources already shown. */
export class BossDirector {
  private consumed = new Set<Id>();
  private ultimateAt = -1e9;
  private runId: Id | null = null;

  constructor(private now: () => number = () => performance.now()) {}

  /** Another run starts afresh; the same run keeps what was shown — a new skin never replays. */
  setRun(runId: Id) {
    if (this.runId === runId) return;
    this.runId = runId;
    this.consumed.clear();
    this.ultimateAt = -1e9;
  }

  choose(ctx: Omit<BossCueContext, "consumedSourceSignalIds" | "ultimateCooldownActive">): BossCue | null {
    const cue = chooseBossCue({
      ...ctx,
      consumedSourceSignalIds: this.consumed,
      ultimateCooldownActive: this.now() - this.ultimateAt < ULTIMATE_COOLDOWN_MS,
    });
    if (!cue) return null;
    for (const id of cue.consumedSourceSignalIds) this.consumed.add(id);
    if (cue.kind === "ultimate") this.ultimateAt = this.now();
    if (this.consumed.size > 600) this.consumed = new Set([...this.consumed].slice(-300));
    return cue;
  }
}
