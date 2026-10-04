// How each of the bosses' thirty moves is drawn (feature2 kit v4:
// boss-moves.json's geometry families). Pure drawing: a telegraph on the
// floor first — a shape and never colour alone — then the cast, then it
// settles. Nothing here chooses a move, owns a clock, or touches the work.

import type { BossMove } from "./bossMoves";

type Pt = { x: number; y: number };
type Ctx = CanvasRenderingContext2D;

export interface BossFxPoints {
  /** Where the move starts: its sourceAnchor on the boss. */
  origin: Pt;
  core: Pt;
  feet: Pt;
  hit: Pt;
  top: Pt;
  scale: number;
}

export interface BossFxFrame {
  move: BossMove;
  ms: number;
  pts: BossFxPoints;
  /** Who it is aimed at (their feet), else a marked empty patch of floor. */
  targets: Pt[];
  /** Sparks, within the move's own small share. */
  spark(x: number, y: number, n: number, color: string, opts?: { speed?: number; to?: Pt; size?: number; up?: number }): void;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (p: Pt, q: Pt, t: number): Pt => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const span = (ms: number, a: number, b: number) => clamp01((ms - a) / Math.max(1, b - a));
const dist = (p: Pt, q: Pt) => Math.hypot(q.x - p.x, q.y - p.y);
const side = (p: Pt, q: Pt, d: number): Pt => {
  const n = dist(p, q) || 1;
  return { x: p.x - ((q.y - p.y) / n) * d, y: p.y + ((q.x - p.x) / n) * d };
};

const lights = new Map<string, HTMLCanvasElement>();
function lightOf(color: string): HTMLCanvasElement {
  let c = lights.get(color);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d")!;
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.18, color);
    g.addColorStop(0.5, color + "66");
    g.addColorStop(1, color + "00");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    lights.set(color, c);
  }
  return c;
}

function glow(x: Ctx, p: Pt, r: number, color: string, alpha: number) {
  if (alpha <= 0.01 || r <= 0) return;
  x.save();
  x.globalAlpha = clamp01(alpha);
  x.globalCompositeOperation = "lighter";
  x.drawImage(lightOf(color), p.x - r, p.y - r, r * 2, r * 2);
  x.restore();
}

function stroke(x: Ctx, color: string, width: number, alpha: number, draw: () => void, blur = 14) {
  if (alpha <= 0.01) return;
  x.save();
  x.globalAlpha = clamp01(alpha);
  x.strokeStyle = color;
  x.lineWidth = width;
  x.lineCap = "round";
  x.lineJoin = "round";
  x.shadowColor = color;
  x.shadowBlur = blur;
  x.beginPath();
  draw();
  x.stroke();
  x.restore();
}

function fill(x: Ctx, color: string, alpha: number, draw: () => void, blur = 12) {
  if (alpha <= 0.01) return;
  x.save();
  x.globalAlpha = clamp01(alpha);
  x.globalCompositeOperation = "lighter";
  x.fillStyle = color;
  x.shadowColor = color;
  x.shadowBlur = blur;
  x.beginPath();
  draw();
  x.fill();
  x.restore();
}

/** The floor's ellipse, flat in the room's view. */
const flat = 0.42;
function floorRing(x: Ctx, p: Pt, r: number, color: string, alpha: number, width = 3) {
  stroke(x, color, width, alpha, () => x.ellipse(p.x, p.y, r, r * flat, 0, 0, Math.PI * 2), 14);
}

/** A telegraph: the shape of what is coming, orange-warm, with an !. */
function warn(x: Ctx, p: Pt, r: number, color: string, alpha: number, pulse: number) {
  if (alpha <= 0.01) return;
  floorRing(x, p, r, color, alpha * (0.7 + 0.3 * Math.sin(pulse / 55)), 2.5);
  x.save();
  x.globalAlpha = clamp01(alpha) * 0.22;
  x.globalCompositeOperation = "lighter";
  x.fillStyle = color;
  x.beginPath();
  x.ellipse(p.x, p.y, r, r * flat, 0, 0, Math.PI * 2);
  x.fill();
  x.restore();
  x.save();
  x.globalAlpha = clamp01(alpha);
  x.font = "bold 22px system-ui, sans-serif";
  x.fillStyle = "#FFF1E6";
  x.textAlign = "center";
  x.fillText("!", p.x, p.y + 7);
  x.restore();
}

function zig(from: Pt, to: Pt, k: number, seed: number): Pt[] {
  const rnd = (i: number) => {
    const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    return v - Math.floor(v) - 0.5;
  };
  const pts: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    const p = mix(from, to, i / 8);
    pts.push(i === 0 || i === 8 ? p : side(p, to, rnd(i) * k));
  }
  return pts;
}

function diamond(x: Ctx, p: Pt, r: number, color: string, alpha: number, ang = 0) {
  if (alpha <= 0.01) return;
  x.save();
  x.globalAlpha = clamp01(alpha);
  x.globalCompositeOperation = "lighter";
  x.translate(p.x, p.y);
  x.rotate(ang);
  x.fillStyle = color;
  x.shadowColor = color;
  x.shadowBlur = 14;
  x.beginPath();
  x.moveTo(r * 1.3, 0);
  x.lineTo(0, -r * 0.5);
  x.lineTo(-r * 1.3, 0);
  x.lineTo(0, r * 0.5);
  x.closePath();
  x.fill();
  x.restore();
}

/** A short pillar of light out of the floor. */
function pillar(x: Ctx, p: Pt, w: number, hgt: number, color: string, hot: string, alpha: number) {
  if (alpha <= 0.01 || hgt <= 1) return;
  x.save();
  x.globalAlpha = clamp01(alpha);
  x.globalCompositeOperation = "lighter";
  const g = x.createLinearGradient(p.x, p.y - hgt, p.x, p.y);
  g.addColorStop(0, color + "00");
  g.addColorStop(0.5, color);
  g.addColorStop(1, hot);
  x.fillStyle = g;
  x.shadowColor = color;
  x.shadowBlur = 18;
  x.fillRect(p.x - w / 2, p.y - hgt, w, hgt);
  x.restore();
  glow(x, p, w * 1.6, hot, alpha * 0.8);
}

/** One move, one frame. The telegraph is drawn before the blow, always. */
export function drawBossMove(x: Ctx, f: BossFxFrame) {
  const { move, ms, pts } = f;
  const [a, c, end] = move.phases;
  const [c0, c1, c2] = move.palette;
  const wcol = move.warningColor;
  const k = pts.scale;
  const t0 = f.targets[0] ?? { x: pts.feet.x - 260 * k, y: pts.feet.y + 60 * k };
  const after = span(ms, c, end);
  const castU = ease(span(ms, a, c));
  switch (move.geometryId) {
    // ── lava ──
    case "cone_breath": {
      const ang = Math.atan2(t0.y - pts.origin.y, t0.x - pts.origin.x);
      const reach = Math.min(dist(pts.origin, t0) + 60, 420 * k);
      if (ms < c + 100) {
        // the fan's edges first, then thin tongues of flame
        const edge = (da: number, u: number) => {
          const e = { x: pts.origin.x + Math.cos(ang + da) * reach * u, y: pts.origin.y + Math.sin(ang + da) * reach * u * 0.7 };
          stroke(x, ms < a ? wcol : c0, ms < a ? 2.5 : 4, ms < a ? 0.9 : 1 - span(ms, c, c + 100), () => {
            x.moveTo(pts.origin.x, pts.origin.y);
            x.lineTo(e.x, e.y);
          });
        };
        edge(-0.5, ms < a ? span(ms, 0, a) : 1);
        edge(0.5, ms < a ? span(ms, 0, a) : 1);
        if (ms >= a) {
          for (let i = 0; i < 5; i++) {
            const da = -0.4 + 0.2 * i;
            const u = castU * (0.75 + 0.25 * Math.sin(i * 2.1 + ms / 70));
            const e = { x: pts.origin.x + Math.cos(ang + da) * reach * u, y: pts.origin.y + Math.sin(ang + da) * reach * u * 0.7 };
            stroke(x, i % 2 ? c1 : c0, 7, 0.9 * (1 - span(ms, c, c + 100)), () => {
              x.moveTo(pts.origin.x, pts.origin.y);
              x.lineTo(e.x, e.y);
            }, 18);
          }
          glow(x, pts.origin, 40 * k, c0, 1 - after);
        }
      }
      if (ms >= c) {
        glow(x, t0, lerp(30, 90, ease(after)), c0, 1 - after);
        f.spark(t0.x, t0.y, 2, c2, { speed: 120, up: 60 });
      }
      break;
    }
    case "semicircle_tail": {
      const r = Math.min(dist(pts.feet, t0), 300 * k);
      const base = Math.atan2(t0.y - pts.feet.y, t0.x - pts.feet.x);
      if (ms < a) {
        stroke(x, wcol, 2.5, 0.9, () => x.ellipse(pts.feet.x, pts.feet.y, r, r * flat, 0, base - 1.1, base + 1.1), 10);
        warn(x, t0, 42 * k, wcol, span(ms, 0, a), ms);
      } else {
        const sweep = -1.1 + 2.2 * castU;
        for (let i = 0; i < 5; i++) {
          const u = Math.max(-1.1, sweep - i * 0.14);
          const p = { x: pts.feet.x + Math.cos(base + u) * r, y: pts.feet.y + Math.sin(base + u) * r * flat };
          glow(x, p, (26 - i * 4) * k, i < 2 ? c1 : c0, (1 - i / 5) * (1 - after));
        }
        stroke(x, c0, 5, 0.9 * (1 - after), () => x.ellipse(pts.feet.x, pts.feet.y, r, r * flat, 0, base - 1.1, base + Math.max(-1.09, sweep)), 16);
      }
      break;
    }
    case "staggered_zigzag": {
      // three broken vents lighting up in turn, floor colour only
      for (let i = 0; i < 3; i++) {
        const from = mix(pts.feet, t0, 0.2 + i * 0.27);
        const to = mix(pts.feet, t0, 0.42 + i * 0.27);
        const at = a + i * 140;
        if (ms < at) {
          if (ms > at - 300) stroke(x, wcol, 2, 0.8, () => zig(from, to, 26, i + 3).forEach((p, j) => (j ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))), 8);
        } else {
          const u = 1 - span(ms, c + i * 60, end);
          stroke(x, c0, 6, u, () => zig(from, to, 26, i + 3).forEach((p, j) => (j ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))), 18);
          stroke(x, c1, 2, u, () => zig(from, to, 26, i + 3).forEach((p, j) => (j ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))), 0);
        }
      }
      break;
    }
    case "three_vent_pillars": {
      for (let i = 0; i < 3; i++) {
        const p = f.targets[i] ?? mix(pts.feet, t0, 0.5 + i * 0.22);
        const at = c - 200 + i * 200;
        if (ms < at) warn(x, p, 40 * k, wcol, span(ms, i * 80, a), ms + i * 300);
        else {
          const u = span(ms, at, at + 160);
          pillar(x, p, 26 * k, lerp(10, 120 * k, ease(u)), c0, c1, 1 - span(ms, at + 220, at + 500));
          if (u >= 1) f.spark(p.x, p.y, 1, c2, { speed: 140, up: 90 });
        }
      }
      break;
    }
    case "folding_basalt_plates": {
      // three dark plates folding over the core
      for (let i = 0; i < 3; i++) {
        const u = ease(span(ms, i * 60, a + 150 + i * 60));
        const off = lerp(60, 16, u) * k;
        const ang = -0.8 + i * 0.8;
        const p = { x: pts.core.x + Math.cos(ang) * off, y: pts.core.y + Math.sin(ang) * off };
        const fade = 1 - span(ms, c + 80, end);
        x.save();
        x.globalAlpha = clamp01(fade);
        x.translate(p.x, p.y);
        x.rotate(ang * 0.3);
        x.fillStyle = "#241C2E";
        x.strokeStyle = c0;
        x.lineWidth = 2;
        x.shadowColor = c0;
        x.shadowBlur = 8;
        x.beginPath();
        x.moveTo(-18 * k, -24 * k);
        x.lineTo(18 * k, -16 * k);
        x.lineTo(14 * k, 24 * k);
        x.lineTo(-14 * k, 18 * k);
        x.closePath();
        x.fill();
        x.stroke();
        x.restore();
      }
      glow(x, pts.core, 30 * k, c0, 0.5 * (1 - after));
      break;
    }
    case "molten_shards_inward": {
      if (ms < c && ms % 90 < 30) f.spark(pts.feet.x + (Math.random() - 0.5) * 200 * k, pts.feet.y + (Math.random() - 0.3) * 60 * k, 2, c0, { to: pts.core, size: 4 });
      // back ridge lighting bottom-up
      const u = ease(span(ms, a, c));
      stroke(x, c0, 4, 0.9 * (1 - after), () => {
        x.moveTo(pts.feet.x - 30 * k, pts.feet.y - 10);
        x.lineTo(pts.core.x - 20 * k, lerp(pts.feet.y - 10, pts.top.y, u));
      }, 14);
      glow(x, pts.core, lerp(20, 55, u) * k, c0, 0.9 * (1 - after));
      break;
    }
    // ── frost ──
    case "two_mirror_bends": {
      const m1 = mix(pts.origin, t0, 0.38);
      const m2 = mix(pts.origin, t0, 0.7);
      const b1 = side(m1, t0, 70 * k);
      const b2 = side(m2, t0, -50 * k);
      const path = [pts.origin, b1, b2, t0];
      if (ms < a) {
        stroke(x, wcol, 2, 0.85, () => path.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))), 6);
        diamond(x, b1, 16 * k, c1, span(ms, 0, a), 0.6);
        diamond(x, b2, 16 * k, c1, span(ms, 0, a), -0.5);
      } else {
        const total = dist(pts.origin, b1) + dist(b1, b2) + dist(b2, t0);
        let left = castU * total;
        for (let i = 0; i < 3 && left > 0; i++) {
          const seg = dist(path[i], path[i + 1]);
          const u = Math.min(1, left / seg);
          const e = mix(path[i], path[i + 1], u);
          stroke(x, c0, 5, 1 - after, () => {
            x.moveTo(path[i].x, path[i].y);
            x.lineTo(e.x, e.y);
          }, 16);
          stroke(x, "#ffffff", 1.5, 1 - after, () => {
            x.moveTo(path[i].x, path[i].y);
            x.lineTo(e.x, e.y);
          }, 0);
          left -= seg;
        }
        diamond(x, b1, 16 * k, c1, 1 - after, 0.6);
        diamond(x, b2, 16 * k, c1, 1 - after, -0.5);
        if (castU >= 1) glow(x, t0, 40 * k, c0, 1 - after);
      }
      break;
    }
    case "diamond_l_grid": {
      const cells = [t0, { x: t0.x + 64 * k, y: t0.y + 20 * k }, { x: t0.x + 50 * k, y: t0.y - 44 * k }];
      cells.forEach((p, i) => {
        if (ms < a + i * 90) {
          stroke(x, wcol, 2, 0.85 * span(ms, i * 60, a), () => {
            x.moveTo(p.x, p.y - 20 * k);
            x.lineTo(p.x + 26 * k, p.y);
            x.lineTo(p.x, p.y + 20 * k);
            x.lineTo(p.x - 26 * k, p.y);
            x.closePath();
          }, 6);
        } else {
          const u = ease(span(ms, a + i * 90, a + i * 90 + 200));
          const fade = 1 - span(ms, c + i * 60, end);
          for (const dx of [-12, 0, 12]) {
            diamond(x, { x: p.x + dx * k, y: p.y - 14 * k * u - Math.abs(dx) * 0.3 }, 9 * k * u, c1, fade, Math.PI / 2);
          }
        }
      });
      break;
    }
    case "expanding_hollow_annulus": {
      if (ms < a) floorRing(x, pts.feet, 60 * k, wcol, 0.9 * span(ms, 0, a), 2.5);
      else {
        const r = lerp(60 * k, 320 * k, castU);
        floorRing(x, pts.feet, r, c0, 1 - after, 5);
        floorRing(x, pts.feet, r - 14, c1, 0.7 * (1 - after), 2);
      }
      break;
    }
    case "crown_three_shard_paths": {
      for (let i = 0; i < 3; i++) {
        const p = f.targets[i] ?? mix(pts.feet, t0, 0.45 + i * 0.25);
        const at = c - 220 + i * 160;
        if (ms < at) warn(x, p, 36 * k, wcol, span(ms, i * 90, a), ms + i * 200);
        else {
          const u = ease(span(ms, at, at + 180));
          const from = { x: pts.top.x, y: pts.top.y - 10 };
          const e = mix(from, p, u);
          stroke(x, c1, 3, 1 - span(ms, at + 240, at + 520), () => {
            x.moveTo(from.x, from.y);
            x.lineTo(e.x, e.y);
          }, 10);
          diamond(x, e, 14 * k, c0, 1 - span(ms, at + 240, at + 520), Math.PI / 2);
          if (u >= 1) f.spark(p.x, p.y, 1, c1, { speed: 120 });
        }
      }
      break;
    }
    case "tilted_core_pane": {
      const u = ease(span(ms, 0, a + 150));
      const fade = 1 - span(ms, c, end);
      const p = { x: pts.core.x + 26 * k, y: pts.core.y };
      x.save();
      x.globalAlpha = clamp01(fade) * 0.85;
      x.translate(p.x, p.y);
      x.rotate(-0.3);
      const g = x.createLinearGradient(-30 * k, -40 * k, 30 * k, 40 * k);
      g.addColorStop(0, "rgba(216,245,255,0.55)");
      g.addColorStop(1, "rgba(144,165,230,0.25)");
      x.fillStyle = g;
      x.strokeStyle = c0;
      x.lineWidth = 2.5;
      x.shadowColor = c0;
      x.shadowBlur = 12;
      x.beginPath();
      x.rect(-26 * k * u, -44 * k * u, 52 * k * u, 88 * k * u);
      x.fill();
      x.stroke();
      x.restore();
      if (ms >= a) {
        // the waiting light split in two harmless glints
        glow(x, { x: p.x + 20 * k, y: p.y - 30 * k }, 12, c1, 0.8 * fade);
        glow(x, { x: p.x + 26 * k, y: p.y + 24 * k }, 10, c1, 0.7 * fade);
      }
      break;
    }
    case "ascending_crown_facets": {
      if (ms < c) {
        for (let i = 0; i < 4; i++) {
          const u = span(ms - i * 120, 0, c - a);
          if (u <= 0 || u >= 1) continue;
          const p = mix({ x: pts.core.x - 20 * k, y: pts.core.y + 40 * k }, pts.top, ease(u));
          diamond(x, p, 11 * k, c1, 1 - u * 0.4, Math.PI / 2);
        }
      }
      glow(x, pts.top, lerp(16, 40, castU) * k, c1, 0.9 * (1 - after));
      break;
    }
    // ── root ──
    case "connected_open_root_loops": {
      const p2 = f.targets[1] ?? { x: t0.x + 110 * k, y: t0.y + 30 * k };
      for (const [p, ga] of [[t0, 1.2], [p2, -0.8]] as [Pt, number][]) {
        if (ms < a) stroke(x, wcol, 2.5, 0.9 * span(ms, 0, a), () => x.ellipse(p.x, p.y, 40 * k, 40 * k * flat, 0, ga, ga + 4.6), 8);
        else {
          const fade = 1 - after;
          stroke(x, c0, 5, fade, () => x.ellipse(p.x, p.y, 40 * k, 40 * k * flat, 0, ga, ga + 4.6 * castU), 14);
          stroke(x, c2, 2, fade, () => x.ellipse(p.x, p.y, 32 * k, 32 * k * flat, 0, ga + 0.4, ga + 0.4 + 4.0 * castU), 8);
        }
      }
      if (ms >= a) stroke(x, c2, 3, 0.8 * (1 - after), () => {
        x.moveTo(t0.x + 36 * k, t0.y + 8);
        x.lineTo(p2.x - 36 * k, p2.y - 8);
      }, 8);
      break;
    }
    case "braided_double_curve": {
      for (const pass of [0, 1]) {
        const at = a + pass * 220;
        const from = pts.origin;
        const lift = (pass ? -36 : -64) * k;
        if (ms < at) {
          if (ms > at - 260) stroke(x, wcol, 2, 0.8, () => {
            x.moveTo(from.x, from.y);
            x.quadraticCurveTo((from.x + t0.x) / 2, (from.y + t0.y) / 2 + lift, t0.x + pass * 30, t0.y + pass * 10);
          }, 6);
        } else {
          const u = ease(span(ms, at, at + 200));
          const fade = 1 - span(ms, at + 260, at + 500);
          x.save();
          x.globalAlpha = clamp01(fade);
          x.strokeStyle = pass ? c2 : c0;
          x.lineWidth = 6;
          x.lineCap = "round";
          x.shadowColor = c0;
          x.shadowBlur = 14;
          x.setLineDash([dist(from, t0) * 1.2 * u, 4000]);
          x.beginPath();
          x.moveTo(from.x, from.y);
          x.quadraticCurveTo((from.x + t0.x) / 2, (from.y + t0.y) / 2 + lift, t0.x + pass * 30, t0.y + pass * 10);
          x.stroke();
          x.restore();
        }
      }
      break;
    }
    case "back_to_front_thorn_points": {
      for (let i = 0; i < 3; i++) {
        const p = mix(pts.feet, t0, 0.35 + i * 0.3);
        const at = a + i * 150;
        if (ms < at) {
          if (ms > i * 100) stroke(x, wcol, 2, 0.85, () => {
            x.moveTo(p.x, p.y - 14 * k);
            x.lineTo(p.x + 12 * k, p.y + 8 * k);
            x.lineTo(p.x - 12 * k, p.y + 8 * k);
            x.closePath();
          }, 6);
        } else {
          const u = ease(span(ms, at, at + 140));
          const fade = 1 - span(ms, at + 220, at + 460);
          fill(x, c2, fade, () => {
            x.moveTo(p.x, p.y - 36 * k * u);
            x.lineTo(p.x + 10 * k, p.y);
            x.lineTo(p.x - 10 * k, p.y);
            x.closePath();
          });
        }
      }
      break;
    }
    case "branching_three_node_pulses": {
      const nodes = [0, 1, 2].map((i) => f.targets[i] ?? mix(pts.feet, t0, 0.4 + i * 0.25));
      for (const [i, p] of nodes.entries()) {
        if (ms < a) {
          // leaf-vein telegraph
          stroke(x, wcol, 2, 0.8 * span(ms, i * 80, a), () => {
            x.moveTo(pts.feet.x, pts.feet.y);
            x.quadraticCurveTo((pts.feet.x + p.x) / 2, (pts.feet.y + p.y) / 2 - 30, p.x, p.y);
          }, 6);
        } else {
          const at = a + i * 180;
          if (ms >= at) {
            const u = span(ms, at, at + 240);
            floorRing(x, p, lerp(12, 54, ease(u)) * k, c0, 1 - u, 4);
            glow(x, p, 24 * k, c2, 0.8 * (1 - u));
          }
        }
      }
      break;
    }
    case "braided_core_cage": {
      const u = ease(span(ms, 0, a + 160));
      const fade = 1 - span(ms, c + 60, end);
      for (let i = 0; i < 4; i++) {
        stroke(x, i % 2 ? c2 : c0, 3, fade * u, () => x.ellipse(pts.core.x, pts.core.y, 30 * k, 44 * k, (i * Math.PI) / 4, 0, Math.PI * 2), 10);
      }
      glow(x, pts.core, 26 * k, c0, 0.5 * fade);
      break;
    }
    case "seed_stream_crown_bud": {
      if (ms < c && ms % 120 < 40) {
        for (let i = 0; i < 2; i++) f.spark(pts.feet.x + (Math.random() - 0.5) * 220 * k, pts.feet.y + (Math.random() - 0.2) * 50, 1, c0, { to: pts.core, size: 4 });
      }
      glow(x, pts.top, lerp(14, 36, castU) * k, c0, 0.9 * (1 - after));
      if (ms >= c) {
        // a bud of new leaves opening at the crown
        for (let i = 0; i < 3; i++) {
          const ang = -Math.PI / 2 + (i - 1) * 0.7;
          fill(x, c0, 0.8 * (1 - after), () => {
            x.ellipse(pts.top.x + Math.cos(ang) * 16 * k, pts.top.y + Math.sin(ang) * 16 * k, 12 * k, 6 * k, ang, 0, Math.PI * 2);
          });
        }
      }
      break;
    }
    // ── thunder ──
    case "parallel_polarity_lanes": {
      const o1 = side(pts.origin, t0, 20 * k);
      const o2 = side(pts.origin, t0, -20 * k);
      const e1 = side(t0, pts.origin, -20 * k);
      const e2 = side(t0, pts.origin, 20 * k);
      if (ms < a) {
        for (const [o, e, sgn] of [[o1, e1, "+"], [o2, e2, "−"]] as [Pt, Pt, string][]) {
          stroke(x, wcol, 2, 0.85 * span(ms, 0, a), () => {
            x.moveTo(o.x, o.y);
            x.lineTo(e.x, e.y);
          }, 6);
          x.save();
          x.globalAlpha = span(ms, 0, a);
          x.font = "bold 20px system-ui";
          x.fillStyle = "#FFF4E0";
          x.fillText(sgn, e.x + 8, e.y);
          x.restore();
        }
      } else {
        for (const [o, e, col] of [[o1, e1, c0], [o2, e2, c2]] as [Pt, Pt, string][]) {
          const zz = zig(o, mix(o, e, castU), 10, Math.floor(ms / 70));
          stroke(x, col, 4, 1 - after, () => zz.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))), 14);
          stroke(x, "#ffffff", 1.5, 1 - after, () => zz.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))), 0);
        }
      }
      break;
    }
    case "three_beacon_relay": {
      const n1 = mix(pts.origin, t0, 0.35);
      const n2 = side(mix(pts.origin, t0, 0.68), t0, 50 * k);
      const path = [pts.origin, n1, n2, t0];
      [n1, n2, t0].forEach((p, i) => {
        const at = i * (a / 3);
        glow(x, p, 10 * k, ms > at ? c0 : wcol, ms < c ? 0.85 : 1 - after);
      });
      if (ms >= a) {
        const total = 3;
        const u = castU * total;
        const seg = Math.min(2, Math.floor(u));
        const su = u - seg;
        const p = mix(path[seg], path[seg + 1], Math.min(1, su));
        for (let i = seg; i > 0 && i <= seg; i--) {
          stroke(x, c0, 3, 0.6 * (1 - after), () => {
            x.moveTo(path[i - 1].x, path[i - 1].y);
            x.lineTo(path[i].x, path[i].y);
          }, 8);
        }
        const zz = zig(path[seg], p, 8, Math.floor(ms / 60));
        stroke(x, c2, 3.5, 1 - after, () => zz.forEach((q, i) => (i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y))), 12);
        glow(x, p, 16 * k, "#ffffff", 1 - after);
      }
      break;
    }
    case "paired_short_coil_waves": {
      for (const [i, o] of [pts.origin, { x: pts.core.x - 40 * k, y: pts.origin.y }].entries()) {
        const at = a + i * 180;
        if (ms < at) floorRing(x, o, 26 * k, wcol, 0.8 * span(ms, i * 80, a), 2);
        else {
          const u = ease(span(ms, at, at + 240));
          stroke(x, c0, 4, 1 - span(ms, at + 240, at + 480), () => x.ellipse(o.x, o.y, lerp(20, 90, u) * k, lerp(20, 90, u) * k * 0.5, 0, Math.PI * 0.75, Math.PI * 1.9), 14);
        }
      }
      break;
    }
    case "orthogonal_grid_scan": {
      const cx = t0.x;
      const cy = t0.y - 10 * k;
      const w2 = 90 * k;
      const lines: [Pt, Pt][] = [];
      for (let i = -1; i <= 1; i++) {
        lines.push([{ x: cx - w2, y: cy + i * 30 * k }, { x: cx + w2, y: cy + i * 30 * k }]);
        lines.push([{ x: cx + i * 40 * k - 20 * k, y: cy - w2 * flat - 20 }, { x: cx + i * 40 * k + 20 * k, y: cy + w2 * flat + 20 }]);
      }
      lines.forEach(([p, q], i) => {
        const horiz = i % 2 === 0;
        const at = horiz ? a + (i / 2) * 90 : c - 160 + ((i - 1) / 2) * 90;
        if (ms < at) stroke(x, wcol, 1.5, 0.75 * span(ms, 0, a), () => {
          x.moveTo(p.x, p.y);
          x.lineTo(q.x, q.y);
        }, 4);
        else {
          const u = span(ms, at, at + 140);
          stroke(x, horiz ? c0 : c2, 3.5, 1 - span(ms, at + 180, at + 420), () => {
            x.moveTo(p.x, p.y);
            x.lineTo(lerp(p.x, q.x, ease(u)), lerp(p.y, q.y, ease(u)));
          }, 12);
        }
      });
      if (ms >= c) glow(x, { x: cx, y: cy }, lerp(10, 40, after) * k, c1, 1 - after);
      break;
    }
    case "counter_rotating_core_rings": {
      const u = ease(span(ms, 0, a + 180));
      const fade = 1 - span(ms, c + 50, end);
      stroke(x, c0, 3.5, fade, () => x.ellipse(pts.core.x, pts.core.y, 36 * k * u, 24 * k * u, ms / 300, 0, Math.PI * 2), 14);
      stroke(x, c1, 2.5, fade, () => x.ellipse(pts.core.x, pts.core.y, 28 * k * u, 40 * k * u, -ms / 260, 0, Math.PI * 2), 10);
      glow(x, pts.core, 24 * k, c0, 0.5 * fade);
      break;
    }
    case "gear_cell_insertions": {
      for (let i = 0; i < 3; i++) {
        const at = i * 180;
        const u = ease(span(ms, at, at + 240));
        if (u <= 0) continue;
        const from = { x: pts.core.x + (60 + i * 14) * k, y: pts.core.y - (70 + i * 16) * k };
        const p = mix(from, pts.core, u);
        const fade = 1 - span(ms, c + 100, end);
        x.save();
        x.globalAlpha = clamp01(fade);
        x.translate(p.x, p.y);
        x.rotate(ms / 220 + i);
        x.strokeStyle = c1;
        x.lineWidth = 3;
        x.shadowColor = c1;
        x.shadowBlur = 8;
        for (let tth = 0; tth < 6; tth++) {
          x.rotate(Math.PI / 3);
          x.strokeRect(-3 * k, 8 * k, 6 * k, 5 * k);
        }
        x.beginPath();
        x.arc(0, 0, 9 * k, 0, Math.PI * 2);
        x.stroke();
        x.restore();
      }
      glow(x, pts.core, lerp(18, 44, castU) * k, c0, 0.9 * (1 - after));
      if (ms >= c) floorRing(x, pts.feet, lerp(30, 80, after) * k, c0, 0.7 * (1 - after), 3);
      break;
    }
    // ── astral ──
    case "local_inward_spiral": {
      const p = t0;
      if (ms < a) {
        stroke(x, wcol, 2, 0.85 * span(ms, 0, a), () => {
          for (let i = 0; i <= 26; i++) {
            const u = i / 26;
            const ang = u * Math.PI * 2.2;
            const r = 54 * k * (1 - u * 0.75);
            const q = { x: p.x + Math.cos(ang) * r, y: p.y + Math.sin(ang) * r * flat };
            if (i) x.lineTo(q.x, q.y);
            else x.moveTo(q.x, q.y);
          }
        }, 6);
      } else {
        const fade = 1 - after;
        for (let arm = 0; arm < 2; arm++) {
          stroke(x, arm ? c1 : c0, 3.5, fade, () => {
            for (let i = 0; i <= 22; i++) {
              const u = i / 22;
              const ang = arm * Math.PI + ms / 260 + u * Math.PI * 1.8;
              const r = 50 * k * (1 - u * 0.85) * (1 - 0.3 * castU);
              const q = { x: p.x + Math.cos(ang) * r, y: p.y + Math.sin(ang) * r * flat };
              if (i) x.lineTo(q.x, q.y);
              else x.moveTo(q.x, q.y);
            }
          }, 12);
        }
        if (ms % 100 < 40) f.spark(p.x + (Math.random() - 0.5) * 100 * k, p.y + (Math.random() - 0.5) * 40 * k, 1, c1, { to: p, size: 3 });
        glow(x, p, 18 * k, c2, fade);
      }
      break;
    }
    case "two_tangent_orbit_cuts": {
      for (const [i, sgn] of [[0, 1], [1, -1]] as [number, number][]) {
        const at = a + i * 200;
        const p = side(mix(pts.origin, t0, 0.65), t0, sgn * 40 * k);
        const ang = Math.atan2(t0.y - pts.origin.y, t0.x - pts.origin.x) + sgn * 0.35;
        if (ms < at) {
          if (ms > i * 120) stroke(x, wcol, 2, 0.8, () => x.ellipse(p.x, p.y, 60 * k, 60 * k * flat, ang, -0.9, 0.9), 6);
        } else {
          const u = ease(span(ms, at, at + 220));
          const fade = 1 - span(ms, at + 260, at + 520);
          stroke(x, c0, 5, fade, () => x.ellipse(p.x, p.y, 60 * k, 60 * k * flat, ang, -0.9, -0.9 + 1.8 * u), 16);
          diamond(x, { x: p.x + Math.cos(ang) * 60 * k, y: p.y + Math.sin(ang) * 60 * k * flat }, 10 * k, c2, fade, ang);
        }
      }
      break;
    }
    case "paired_portal_fold": {
      const r1 = mix(pts.origin, t0, 0.3);
      const r2 = mix(pts.origin, t0, 0.78);
      for (const [p, u0] of [[r1, 0], [r2, 90]] as [Pt, number][]) {
        const u = ease(span(ms, u0, a));
        stroke(x, ms < a ? wcol : c0, 3, ms < c + 100 ? 0.9 : 1 - after, () => x.ellipse(p.x, p.y, 26 * k * u, 44 * k * u, -0.3, 0, Math.PI * 2), 12);
        glow(x, p, 20 * k * u, c2, 0.5 * (1 - after));
      }
      if (ms >= a && ms < c + 60) {
        // in one gate, out the other — one light, one blow
        const seg = castU;
        if (seg < 0.5) {
          const e = mix(pts.origin, r1, seg * 2);
          stroke(x, c1, 4, 1, () => {
            x.moveTo(pts.origin.x, pts.origin.y);
            x.lineTo(e.x, e.y);
          }, 12);
        } else {
          const e = mix(r2, t0, (seg - 0.5) * 2);
          stroke(x, c1, 4, 1, () => {
            x.moveTo(r2.x, r2.y);
            x.lineTo(e.x, e.y);
          }, 12);
        }
      }
      if (ms >= c) glow(x, t0, lerp(20, 50, after) * k, c1, 1 - after);
      break;
    }
    case "inward_eclipse_arcs": {
      const r = lerp(170 * k, 46 * k, castU);
      for (const sgn of [1, -1]) {
        stroke(x, ms < a ? wcol : c0, ms < a ? 2.5 : 5, ms < a ? 0.85 * span(ms, 0, a) : 1 - after, () => x.ellipse(pts.core.x, pts.core.y, r, r, 0, sgn > 0 ? -0.9 : Math.PI - 0.9, sgn > 0 ? 0.9 : Math.PI + 0.9), 16);
      }
      if (ms >= c) {
        // a small local eclipse: dark core, bright rim — never the screen
        x.save();
        x.globalAlpha = 0.7 * (1 - after);
        x.fillStyle = "rgba(10,8,24,0.85)";
        x.beginPath();
        x.arc(pts.core.x, pts.core.y, 34 * k, 0, Math.PI * 2);
        x.fill();
        x.restore();
        stroke(x, c1, 4, 1 - after, () => x.arc(pts.core.x, pts.core.y, 36 * k, 0, Math.PI * 2), 20);
      }
      break;
    }
    case "orbital_shard_deflection": {
      const u = ease(span(ms, 0, a + 160));
      const fade = 1 - span(ms, c + 60, end);
      for (let i = 0; i < 3; i++) {
        const ang = ms / 500 + (i * Math.PI * 2) / 3;
        const p = { x: pts.core.x + Math.cos(ang) * 44 * k * u, y: pts.core.y + Math.sin(ang) * 30 * k * u };
        diamond(x, p, 10 * k, c0, fade, ang);
      }
      // the waiting light nudged aside into two star glints
      if (ms >= a) {
        glow(x, { x: pts.core.x - 40 * k, y: pts.core.y - 34 * k }, 10, c1, 0.8 * fade);
        glow(x, { x: pts.core.x - 52 * k, y: pts.core.y - 10 * k }, 8, c1, 0.7 * fade);
      }
      break;
    }
    case "outer_orbit_accretion": {
      if (ms < c && ms % 110 < 40) f.spark(pts.core.x + (Math.random() - 0.5) * 240 * k, pts.core.y + (Math.random() - 0.5) * 100 * k, 1, c1, { to: pts.core, size: 3.5 });
      glow(x, pts.core, lerp(16, 40, castU) * k, c2, 0.9 * (1 - after));
      if (ms >= c) stroke(x, c1, 3.5, 1 - after, () => x.ellipse(pts.core.x, pts.core.y, lerp(60, 86, after) * k, lerp(40, 56, after) * k, -0.3, -0.6, 2.2), 14);
      break;
    }
    default: {
      // a family with no drawing yet: the warning, the reason, nothing made up
      warn(x, t0, 40 * k, wcol, 1 - after, ms);
      break;
    }
  }
}
