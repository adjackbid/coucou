// How the painted textures move: the heroes' moves and the bosses' thirty.
// Timings come from each move's own phases; nothing here decides what
// happens, only how it looks while it does.

import { tex, widthToReach } from "./vfx";

type Pt = { x: number; y: number };

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const span = (ms: number, a: number, b: number) => clamp01((ms - a) / Math.max(1, b - a));
const ease = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeIn = (t: number) => Math.pow(clamp01(t), 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (p: Pt, q: Pt, t: number): Pt => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });
const angle = (p: Pt, q: Pt) => Math.atan2(q.y - p.y, q.x - p.x);
const dist = (p: Pt, q: Pt) => Math.hypot(q.x - p.x, q.y - p.y);
const bell = (t: number) => Math.sin(Math.PI * clamp01(t));
const FLOOR = 0.42;

/** Which element a skill throws. */
export type Element = "fire" | "ice" | "wind" | "lightning" | "crescent" | "pierce" | "counter" | "heavy" | "support";
export const ELEMENT_OF: Record<string, Element> = {
  fire_ember: "fire", ice_lance: "ice", wind_crescent: "wind", lightning_chain: "lightning",
  blade_crescent: "crescent", blade_pierce: "pierce", blade_counter: "counter", blade_heavy: "heavy",
  support_ward: "support", support_cleanse: "support", support_seal: "support",
};

export interface HeroArgs {
  ms: number;
  phases: [number, number, number, number];
  /** Each striker: where it stands, its element, its colour. */
  casters: { at: Pt; element: Element; colour: string }[];
  target: Pt;
  feet: Pt;
  palette: string[];
  scale: number;
  combo: boolean;
  trinity: boolean;
}

/** The projectile (or the strike itself) of one caster. */
function throwOf(ctx: CanvasRenderingContext2D, c: HeroArgs["casters"][number], target: Pt, ms: number, a: number, hitAt: number, s: number) {
  // Out of the hand slowly, into the target fast: the flight is seen.
  const u = Math.pow(span(ms, a, hitAt), 1.35);
  const on = ms >= a && ms < hitAt + 40;
  const ang = angle(c.at, target);
  const head = mix(c.at, target, u);
  switch (c.element) {
    case "fire":
      if (on) {
        tex(ctx, "trail_streak", head, { w: Math.min(320, dist(c.at, head) + 60) * s, rot: ang, tint: "#FF9A32", alpha: 0.9 });
        tex(ctx, "fire_ball", head, { w: 190 * s, rot: ang });
      }
      break;
    case "ice":
      if (on) {
        tex(ctx, "trail_streak", head, { w: Math.min(220, dist(c.at, head)) * s, rot: ang, tint: "#80DBFF", alpha: 0.7 });
        // Pale ice over a pale floor: a deep-blue body under it keeps it readable anywhere.
        const at = mix(c.at, target, Math.max(0, u - 0.1));
        tex(ctx, "ice_lance", at, { w: 290 * s, rot: ang, tint: "#2F5FA8", alpha: 0.9 });
        tex(ctx, "ice_lance", at, { w: 270 * s, rot: ang });
      }
      break;
    case "wind":
      if (on) tex(ctx, "wind_blade", head, { w: 240 * s, rot: ang + Math.sin(ms / 60) * 0.12 });
      break;
    case "lightning":
      if (ms >= a && ms < hitAt + 160) {
        const flick = 0.6 + 0.4 * Math.abs(Math.sin(ms / 23));
        const len = dist(c.at, target);
        tex(ctx, "lightning_bolt", c.at, { w: widthToReach("lightning_bolt", len), rot: ang, alpha: flick * (ms < hitAt ? ease(span(ms, a, a + 90)) : 1 - span(ms, hitAt, hitAt + 160)) });
      }
      break;
    case "crescent":
    case "counter":
      if (c.element === "counter" && ms < hitAt) tex(ctx, "hex_shield", { x: c.at.x, y: c.at.y - 20 * s }, { w: 120 * s, tint: "#A9B9FF", alpha: ease(span(ms, 0, a)) * 0.9 });
      if (ms >= hitAt - 120 && ms < hitAt + 260) {
        const k = span(ms, hitAt - 120, hitAt + 260);
        tex(ctx, "blade_crescent", target, { w: lerp(180, 320, ease(k)) * s, rot: ang - 0.6 + k * 1.2, alpha: bell(k) });
      }
      break;
    case "pierce":
      if (ms >= a && ms < hitAt + 120) {
        const k = span(ms, a, hitAt);
        tex(ctx, "trail_streak", mix(c.at, target, ease(k)), { w: Math.max(40, dist(c.at, target) * ease(k)) * s, rot: ang, tint: "#FFF2CF", alpha: 1 - span(ms, hitAt, hitAt + 120) });
      }
      break;
    case "heavy":
      if (ms >= a && ms < hitAt + 60) {
        const k = easeIn(span(ms, a, hitAt));
        tex(ctx, "glow_soft", { x: target.x, y: lerp(target.y - 300 * s, target.y, k) }, { w: 160 * s, tint: "#FFCE65", alpha: 0.6 });
        tex(ctx, "sword_falling", { x: target.x, y: lerp(target.y - 300 * s, target.y + 20 * s, k) }, { w: 140 * s, alpha: ease(span(ms, a, a + 100)) });
      }
      break;
    case "support":
      if (ms < hitAt) tex(ctx, "heal_motes", { x: c.at.x, y: c.at.y - 40 * s }, { w: 150 * s, alpha: ease(span(ms, 0, a)) });
      break;
  }
}

/** The landing: the element's own hit, then the burst, the ring and the dust. */
function hitOf(ctx: CanvasRenderingContext2D, element: Element, target: Pt, ms: number, hitAt: number, end: number, s: number, colour: string) {
  const k = span(ms, hitAt, end);
  if (ms < hitAt) return;
  const fade = 1 - k;
  switch (element) {
    case "fire": tex(ctx, "fire_burst", target, { w: lerp(140, 300, ease(k)) * s, alpha: fade }); break;
    case "ice": tex(ctx, "ice_shatter", target, { w: lerp(150, 290, ease(k)) * s, alpha: fade, rot: k * 0.4 }); break;
    case "wind": tex(ctx, "wind_swirl", target, { w: lerp(150, 280, ease(k)) * s, alpha: fade, rot: -k * 3 }); break;
    case "lightning": tex(ctx, "lightning_hit", target, { w: lerp(170, 300, ease(k)) * s, alpha: fade * (0.7 + 0.3 * Math.abs(Math.sin(ms / 19))) }); break;
    case "pierce": tex(ctx, "slash_arc", target, { w: lerp(160, 260, ease(k)) * s, rot: -0.9, tint: colour, alpha: fade }); break;
    case "heavy": tex(ctx, "impact_burst", target, { w: lerp(220, 420, ease(k)) * s, tint: "#FFCE65", alpha: fade }); break;
    default: break;
  }
}

/** A hero's move (or a combo), painted. Returns nothing: it only draws. */
export function heroTex(ctx: CanvasRenderingContext2D, h: HeroArgs) {
  const [a, c, , end] = h.phases;
  const s = h.scale;
  const after = span(h.ms, c, end);
  // Under each striker its circle, in its colour.
  for (const cs of h.casters) {
    const on = ease(span(h.ms, 0, a + 60)) * (1 - span(h.ms, c, end));
    tex(ctx, "magic_circle_base", { x: cs.at.x, y: cs.at.y + 22 * s }, { w: (h.combo ? 170 : 150) * s, sy: FLOOR, rot: h.ms / 900, tint: cs.colour, alpha: on });
    tex(ctx, "glow_soft", cs.at, { w: 130 * s, tint: cs.colour, alpha: 0.5 * bell(span(h.ms, 0, c)) });
  }
  if (h.trinity) {
    tex(ctx, "seal_runes", { x: h.feet.x, y: h.feet.y }, { w: lerp(200, 380, ease(span(h.ms, 0, c))) * s, sy: FLOOR, rot: -h.ms / 700, alpha: (1 - after) * ease(span(h.ms, 0, a)) });
    throwOf(ctx, { at: h.target, element: "heavy", colour: "#FFD690" }, h.target, h.ms, a, c, s * 1.6);
  }
  for (const cs of h.casters) throwOf(ctx, cs, h.target, h.ms, a, c, s);
  // The landing.
  if (h.ms >= c) {
    const big = h.combo ? 1.45 : 1;
    tex(ctx, "impact_burst", h.target, { w: lerp(140, 300, ease(after)) * s * big, tint: h.palette[1] ?? "#ffffff", alpha: 1 - span(h.ms, c, c + 260) });
    tex(ctx, "shockwave_ring", { x: h.feet.x, y: h.feet.y }, { w: lerp(120, 520, ease(after)) * s * big, sy: FLOOR, tint: h.palette[0], alpha: 0.85 * (1 - after) });
    tex(ctx, "smoke_puff", { x: h.feet.x, y: h.feet.y - 10 * s }, { w: lerp(120, 260, ease(after)) * s, tint: "#C9C3B8", alpha: 0.55 * (1 - after) });
    for (const [i, cs] of h.casters.entries()) hitOf(ctx, cs.element, { x: h.target.x + (i - (h.casters.length - 1) / 2) * 30 * s, y: h.target.y }, h.ms, c, end, s * big, cs.colour);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + h.ms / 400;
      const r = lerp(30, 150, ease(after)) * s * big;
      tex(ctx, "spark_star", { x: h.target.x + Math.cos(ang) * r, y: h.target.y + Math.sin(ang) * r * 0.6 }, { w: 60 * s, tint: h.palette[0], alpha: 1 - after, rot: ang });
    }
  }
}

// ── The bosses ────────────────────────────────────────────────────────────────

export interface BossArgs {
  moveId: string;
  ms: number;
  phases: [number, number, number];
  palette: [string, string, string];
  origin: Pt;
  core: Pt;
  feet: Pt;
  top: Pt;
  targets: Pt[];
  scale: number;
}

/** True when this move has a painted version. */
export function bossTex(ctx: CanvasRenderingContext2D, b: BossArgs): boolean {
  const [tele, cast, total] = b.phases;
  const s = b.scale;
  const k = span(b.ms, tele, cast); // the cast
  const out = 1 - span(b.ms, cast, total); // the fade after it
  const live = b.ms >= tele ? out : 0;
  const t0 = b.targets[0] ?? b.feet;
  const tg = b.targets.slice(0, 3);
  const land = b.ms >= cast;
  const hit = (p: Pt, w = 200) => land && tex(ctx, "impact_burst", p, { w: lerp(w * 0.6, w, ease(span(b.ms, cast, total))) * s, tint: b.palette[0], alpha: out });
  switch (b.moveId) {
    // 熔核龍王
    case "lava_flame_breath": {
      const len = dist(b.origin, t0) * 1.08;
      tex(ctx, "lava_breath_cone", b.origin, { w: widthToReach("lava_breath_cone", len) * ease(k + 0.2), rot: angle(b.origin, t0), alpha: live });
      hit(t0, 240);
      return true;
    }
    case "lava_tail_sweep":
      tex(ctx, "slash_arc", b.feet, { w: 420 * s, sy: FLOOR, rot: Math.PI + k * 1.4, tint: b.palette[0], alpha: live });
      for (const p of tg) hit(p, 180);
      return true;
    case "lava_fissure_chain":
      for (const p of tg) {
        const mid = mix(b.feet, p, 0.5);
        tex(ctx, "lava_fissure", mid, { w: dist(b.feet, p) * ease(k), rot: angle(b.feet, p), alpha: live });
        hit(p, 170);
      }
      return true;
    case "lava_crater_core":
      for (const [i, p] of tg.entries()) {
        const kk = span(b.ms, tele + i * 120, cast + i * 60);
        tex(ctx, "lava_pillar", { x: p.x, y: p.y + 10 * s }, { w: 110 * s, sx: 1, alpha: Math.min(live, ease(kk * 3)), rot: 0 });
        tex(ctx, "glow_soft", p, { w: 180 * s, tint: "#FF9B34", alpha: 0.7 * bell(kk) });
      }
      return true;
    case "lava_obsidian_guard":
      for (let i = 0; i < 3; i++) {
        const a = b.ms / 500 + (i * Math.PI * 2) / 3;
        tex(ctx, "obsidian_plate", { x: b.core.x + Math.cos(a) * 90 * s, y: b.core.y + Math.sin(a) * 40 * s }, { w: 90 * s, alpha: Math.min(1, ease(k * 2)) * out, rot: a * 0.3 });
      }
      return true;
    case "lava_core_reforge":
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const from = { x: b.core.x + Math.cos(a) * 260 * s, y: b.core.y + Math.sin(a) * 140 * s };
        tex(ctx, "spark_star", mix(from, b.core, ease(k)), { w: 70 * s, tint: "#FFD272", alpha: live, rot: a });
      }
      tex(ctx, "glow_soft", b.core, { w: 200 * s, tint: "#FF9B34", alpha: 0.8 * bell(k) });
      return true;
    // 霜鏡女王
    case "frost_mirror_refract":
      tex(ctx, "frost_mirror_pane", { x: b.core.x - 70 * s, y: b.core.y - 20 * s }, { w: 120 * s, alpha: Math.min(1, ease(k * 2)) * out });
      for (const p of tg) tex(ctx, "trail_streak", mix(b.core, p, ease(k)), { w: dist(b.core, p) * ease(k), rot: angle(b.core, p), tint: "#9FD8FF", alpha: live });
      for (const p of tg) hit(p, 180);
      return true;
    case "frost_spike_grid":
      for (const p of tg) for (const dx of [-40, 0, 40]) {
        tex(ctx, "frost_spike", { x: p.x + dx * s, y: p.y + 18 * s }, { w: 60 * s, alpha: live, sx: 1 });
      }
      return true;
    case "frost_ring_tide":
      tex(ctx, "frost_ring", b.feet, { w: lerp(120, 700, ease(k)) * s, sy: FLOOR, alpha: live });
      return true;
    case "frost_crown_shatter":
      for (const [i, p] of tg.entries()) {
        tex(ctx, "crown_shard", mix(b.top, p, ease(k)), { w: 80 * s, rot: k * 4 + i, alpha: b.ms < cast ? live : 0 });
        if (land) tex(ctx, "ice_shatter", p, { w: 220 * s, alpha: out });
      }
      return true;
    case "frost_mirror_guard":
      tex(ctx, "frost_mirror_pane", { x: b.core.x - 60 * s, y: b.core.y }, { w: 170 * s, alpha: Math.min(1, ease(k * 2)) * out });
      return true;
    case "frost_crown_rebuild":
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + b.ms / 600;
        const from = { x: b.top.x + Math.cos(a) * 200 * s, y: b.top.y + 160 * s };
        tex(ctx, "crown_shard", mix(from, b.top, ease(k)), { w: 60 * s, rot: a, alpha: live });
      }
      return true;
    // 纏根古王
    case "root_loop_bind":
      for (const p of tg) tex(ctx, "root_loop", { x: p.x, y: p.y + 20 * s }, { w: lerp(90, 170, ease(k)) * s, sy: FLOOR, alpha: live });
      return true;
    case "root_vine_whip":
      for (const p of tg.slice(0, 2)) tex(ctx, "vine_whip", b.origin, { w: widthToReach("vine_whip", dist(b.origin, p)) * ease(k), rot: angle(b.origin, p) + Math.sin(b.ms / 90) * 0.06, alpha: live });
      for (const p of tg.slice(0, 2)) hit(p, 160);
      return true;
    case "root_thorn_return":
      for (const p of tg) tex(ctx, "thorn_spike", { x: p.x, y: p.y + 18 * s }, { w: 64 * s, alpha: live });
      return true;
    case "root_canopy_resonance":
      tex(ctx, "root_loop", b.feet, { w: lerp(200, 520, ease(k)) * s, sy: FLOOR, alpha: live });
      for (const p of tg) tex(ctx, "bud_glow", p, { w: 140 * s, alpha: live * bell(k + 0.3) });
      return true;
    case "root_vine_guard":
      tex(ctx, "root_loop", { x: b.feet.x, y: b.feet.y }, { w: 300 * s, sy: FLOOR, alpha: Math.min(1, ease(k * 2)) * out });
      tex(ctx, "hex_shield", b.core, { w: 160 * s, tint: "#8FDB6A", alpha: 0.7 * out });
      return true;
    case "root_bud_regrowth":
      tex(ctx, "bud_glow", b.top, { w: lerp(80, 200, ease(k)) * s, alpha: live });
      return true;
    // 雷霆機皇
    case "thunder_polarity_lanes":
    case "thunder_coil_pulse":
      for (const p of tg) tex(ctx, "coil_wave", b.origin, { w: widthToReach("coil_wave", dist(b.origin, p)) * ease(k), rot: angle(b.origin, p), alpha: live });
      for (const p of tg) land && tex(ctx, "lightning_hit", p, { w: 200 * s, alpha: out });
      return true;
    case "thunder_orb_relay":
      for (const [i, p] of tg.entries()) tex(ctx, "energy_orb", mix(b.origin, p, ease(span(b.ms, tele + i * 90, cast))), { w: 100 * s, alpha: live });
      for (const p of tg) land && tex(ctx, "lightning_hit", p, { w: 200 * s, alpha: out });
      return true;
    case "thunder_matrix_overload":
      tex(ctx, "grid_scan", b.feet, { w: lerp(200, 720, ease(k)) * s, sy: FLOOR, alpha: live });
      for (const p of tg) land && tex(ctx, "lightning_hit", p, { w: 240 * s, alpha: out });
      return true;
    case "thunder_magnetic_guard":
      tex(ctx, "gear_cell", b.core, { w: 130 * s, rot: b.ms / 400, alpha: Math.min(1, ease(k * 2)) * out });
      tex(ctx, "shockwave_ring", b.feet, { w: 300 * s, sy: FLOOR, tint: "#5BB8FF", alpha: 0.6 * out });
      return true;
    case "thunder_cell_expand":
      for (const dx of [-1, 1]) tex(ctx, "gear_cell", mix({ x: b.core.x + dx * 220 * s, y: b.core.y }, b.core, ease(k)), { w: 70 * s, rot: dx * b.ms / 300, alpha: live });
      return true;
    // 星噬之主
    case "astral_gravity_well":
      for (const p of tg.slice(0, 2)) tex(ctx, "gravity_spiral", { x: p.x, y: p.y + 10 * s }, { w: lerp(120, 240, ease(k)) * s, sy: FLOOR, rot: -b.ms / 300, alpha: live });
      return true;
    case "astral_orbit_cut":
      for (const p of tg.slice(0, 2)) tex(ctx, "orbit_arc", p, { w: 260 * s, rot: -0.5 + k * 1.2, alpha: live });
      return true;
    case "astral_rift_fold":
      tex(ctx, "rift_portal", b.origin, { w: 110 * s, alpha: live });
      tex(ctx, "rift_portal", t0, { w: lerp(60, 130, ease(k)) * s, alpha: live });
      hit(t0, 180);
      return true;
    case "astral_eclipse_convergence":
      tex(ctx, "eclipse_ring", b.core, { w: lerp(380, 180, ease(k)) * s, rot: b.ms / 800, alpha: live });
      for (const p of tg) tex(ctx, "gravity_spiral", { x: p.x, y: p.y + 10 * s }, { w: 150 * s, sy: FLOOR, rot: -b.ms / 260, alpha: live * 0.8 });
      return true;
    case "astral_orbit_deflect":
      tex(ctx, "orbit_arc", b.core, { w: 260 * s, rot: b.ms / 300, alpha: Math.min(1, ease(k * 2)) * out });
      return true;
    case "astral_ring_expand":
      tex(ctx, "orbit_arc", b.top, { w: lerp(120, 300, ease(k)) * s, rot: b.ms / 500, alpha: live });
      return true;
    default:
      return false;
  }
}
