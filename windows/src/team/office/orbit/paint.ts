// Painting a light ring, and the sky behind it: shared by the WebGL engine
// (which paints a ring once into a texture) and the Canvas fallback (which
// paints it every frame). All numbers from the spec's visual-config.json.

import type { Vec3 } from "./layout";

const FALLBACK = "#65b5f2";

/** `#rgb` or `#rrggbb` → [r, g, b] in 0–255; a colour the scene cannot read becomes blue. */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return parseHex(FALLBACK);
  let s = m[1];
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function colour(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** The same colour for a shader: 0–1 with alpha. */
export function rgb(hex: string, alpha: number): [number, number, number, number] {
  const [r, g, b] = parseHex(hex);
  return [r / 255, g / 255, b / 255, alpha];
}

export interface RingLook {
  /** World size of the ring quad (1.5 breathing by 2.4 %). */
  size: number;
  rotation: number;
  intensity: number;
}

/** A ring's breath and turn at this moment; each node has its own offset. */
export function ringAppearance(phase: number, slot: number, index: number, glow: number): RingLook {
  const offset = slot * 1.4 + index * 0.9;
  return {
    size: 1.5 * (1 + 0.024 * Math.sin(phase * 0.64 + offset)),
    rotation: phase * 0.13 * (index % 2 ? -1 : 1) + offset,
    intensity: Math.max(0.5, Math.min(1, (0.88 + 0.09 * Math.sin(phase * 0.64 + offset)) * (0.7 + 0.3 * glow))),
  };
}

/**
 * One light ring in a 128 × 128 local space centred on (x, y): soft mist, a
 * fine main ring (radius 38) with a pale inner edge, three outer arcs (49)
 * ending in bright points, a dotted inner ring (27) and a transparent core
 * (soft radius 17, white point 2). `dashed` is the offline look: a broken,
 * dim main ring.
 */
export function paintEnergyRing(c: CanvasRenderingContext2D, color: string, x: number, y: number, scale: number, rotation: number, intensity: number, dashed = false) {
  c.save();
  c.translate(x, y);
  c.rotate(rotation);
  c.scale(scale, scale);
  c.globalAlpha = intensity;
  const mist = c.createRadialGradient(0, 0, 8, 0, 0, 61);
  mist.addColorStop(0, colour(color, 0.09));
  mist.addColorStop(0.5, colour(color, 0.025));
  mist.addColorStop(0.67, colour(color, 0.16));
  mist.addColorStop(1, colour(color, 0));
  c.fillStyle = mist;
  c.fillRect(-64, -64, 128, 128);
  c.lineCap = "round";
  if (dashed) c.setLineDash([9, 7]);
  c.shadowColor = color;
  c.shadowBlur = 9;
  c.strokeStyle = colour(color, dashed ? 0.22 : 0.38);
  c.lineWidth = 5;
  c.beginPath();
  c.arc(0, 0, 38, 0, Math.PI * 2);
  c.stroke();
  c.shadowBlur = 4;
  c.strokeStyle = dashed ? colour(color, 0.7) : color;
  c.lineWidth = 1.9;
  c.beginPath();
  c.arc(0, 0, 38, 0, Math.PI * 2);
  c.stroke();
  c.shadowBlur = 0;
  c.strokeStyle = dashed ? "rgba(239,250,255,0.5)" : "#effaff";
  c.lineWidth = 0.65;
  c.beginPath();
  c.arc(0, 0, 37.2, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  for (let i = 0; i < 3; i++) {
    const start = (i * Math.PI * 2) / 3 + 0.15;
    c.strokeStyle = colour(color, 0.58);
    c.lineWidth = 1.1;
    c.beginPath();
    c.arc(0, 0, 49, start, start + 0.86);
    c.stroke();
    const a = start + 0.86;
    c.shadowColor = color;
    c.shadowBlur = 5;
    c.fillStyle = "#e7f8ff";
    c.beginPath();
    c.arc(Math.cos(a) * 49, Math.sin(a) * 49, 1.25, 0, Math.PI * 2);
    c.fill();
    c.shadowBlur = 0;
  }
  c.setLineDash([1, 5]);
  c.lineWidth = 0.7;
  c.strokeStyle = colour(color, 0.33);
  c.beginPath();
  c.arc(0, 0, 27, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  const core = c.createRadialGradient(0, 0, 0, 0, 0, 17);
  core.addColorStop(0, "#ffffff");
  core.addColorStop(0.13, "#f3fcff");
  core.addColorStop(0.3, colour(color, 0.84));
  core.addColorStop(0.6, colour(color, 0.23));
  core.addColorStop(1, colour(color, 0));
  c.fillStyle = core;
  c.fillRect(-17, -17, 34, 34);
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.arc(0, 0, 2, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/** A soft round glow on a 2D canvas. */
export function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  if (r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, colour(color, alpha));
  g.addColorStop(0.32, colour(color, alpha * 0.35));
  g.addColorStop(1, colour(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// ── The sky ─────────────────────────────────────────────────────────────────

export interface Star {
  p: Vec3;
  r: number;
  a: number;
}

/** 780 stars on a shell 21–48 out, from a fixed seed: the same sky every time. */
export function makeStars(seed = 92, count = 780): Star[] {
  let s = seed >>> 0;
  const random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Array.from({ length: count }, () => {
    const a = random() * Math.PI * 2, z = random() * 2 - 1, r = 21 + random() * 27, k = Math.sqrt(1 - z * z);
    return { p: [Math.cos(a) * r * k, z * r, Math.sin(a) * r * k], r: 0.5 + random(), a: 0.15 + random() * 0.42 };
  });
}

/**
 * Where a point of the sky is at this moment: the whole shell turns at
 * 0.0025 rad/s (a round in ~42 minutes) and breathes up and down 0.7 over
 * ~251 s. The WebGL point shader applies exactly this formula.
 */
export function backgroundPoint(p: Vec3, phase: number): Vec3 {
  const a = phase * 0.0025, c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1] + Math.sin(phase * 0.025) * 0.7, p[2] * c - p[0] * s];
}

export interface Nebula {
  p: Vec3;
  color: string;
  radius: number;
  alpha: number;
  angle: number;
}

/** Three wide, soft clouds far behind the clusters. */
export const NEBULAE: readonly Nebula[] = [
  { p: [-8, 4, -13], color: "#507cae", radius: 10, alpha: 0.085, angle: -0.35 },
  { p: [9, -5, -17], color: "#8270b6", radius: 12, alpha: 0.065, angle: 0.4 },
  { p: [-5, -8, -9], color: "#3c9e99", radius: 9, alpha: 0.035, angle: -0.6 },
];
