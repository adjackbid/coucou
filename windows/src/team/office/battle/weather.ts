// 場地微動 (kit: environment effects, M3): each world's own light weather —
// embers, snow, leaves, sparks, stardust — drawn sparsely outside the
// platform, never over the HUD, and stirred by a blow that lands near it.
// It is decoration only: no event, no number, no rule depends on it.

import type { WorldId } from "./worlds";

type Pt = { x: number; y: number };

interface Kind {
  /** How many at most, and how many while the fight is busy. */
  n: number;
  busy: number;
  colors: string[];
  /** Drift in px/s: horizontal base, vertical base (negative rises), sway amplitude. */
  vx: number;
  vy: number;
  sway: number;
  size: [number, number];
  life: [number, number];
  draw: (ctx: CanvasRenderingContext2D, s: number, color: string) => void;
  /** Spins as it goes. */
  spin?: number;
  /** Flickers rather than fades. */
  flicker?: boolean;
}

const dot = (ctx: CanvasRenderingContext2D, s: number, color: string) => {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s);
  g.addColorStop(0, "#FFFFFF");
  g.addColorStop(0.25, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, s, 0, Math.PI * 2);
  ctx.fill();
};

const flake = (ctx: CanvasRenderingContext2D, s: number, color: string) => {
  // A cold halo, so a flake still reads against a white sky.
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, s);
  halo.addColorStop(0, "rgba(90,160,255,0.45)");
  halo.addColorStop(1, "rgba(90,160,255,0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, s * 0.16);
  ctx.lineCap = "round";
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const ex = Math.cos(a) * s * 0.8;
    const ey = Math.sin(a) * s * 0.8;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(ex, ey);
    // a small barb on each arm
    const bx = Math.cos(a) * s * 0.5;
    const by = Math.sin(a) * s * 0.5;
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + Math.cos(a + 0.8) * s * 0.22, by + Math.sin(a + 0.8) * s * 0.22);
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + Math.cos(a - 0.8) * s * 0.22, by + Math.sin(a - 0.8) * s * 0.22);
    ctx.stroke();
  }
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.14, 0, Math.PI * 2);
  ctx.fill();
};

const leaf = (ctx: CanvasRenderingContext2D, s: number, color: string) => {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-s, 0);
  ctx.quadraticCurveTo(0, -s * 0.62, s, 0);
  ctx.quadraticCurveTo(0, s * 0.62, -s, 0);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = Math.max(0.8, s * 0.09);
  ctx.beginPath();
  ctx.moveTo(-s * 0.85, 0);
  ctx.lineTo(s * 0.85, 0);
  ctx.stroke();
};

const spark = (ctx: CanvasRenderingContext2D, s: number, color: string) => {
  ctx.shadowColor = color;
  ctx.shadowBlur = s * 1.4;
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.32, 0);
  ctx.lineTo(0, s);
  ctx.lineTo(-s * 0.32, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  ctx.globalAlpha *= 0.7;
  ctx.beginPath();
  ctx.moveTo(-s, 0);
  ctx.lineTo(0, s * 0.22);
  ctx.lineTo(s, 0);
  ctx.lineTo(0, -s * 0.22);
  ctx.closePath();
  ctx.fill();
};

const star = (ctx: CanvasRenderingContext2D, s: number, color: string) => {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.9);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 ? s * 0.18 : s;
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
};

const KINDS: Partial<Record<WorldId, Kind>> = {
  lava_crater: { n: 12, busy: 5, colors: ["#FF9B34", "#FFD272", "#FF6A2A"], vx: 4, vy: -26, sway: 10, size: [4, 7], life: [3.2, 5.4], draw: dot },
  frost_court: { n: 12, busy: 5, colors: ["#E6F6FF", "#BFE3FF", "#9FD8FF"], vx: -6, vy: 16, sway: 14, size: [6, 10], life: [4.5, 7], draw: flake, spin: 0.9 },
  verdant_ruins: { n: 11, busy: 5, colors: ["#8FDB6A", "#C8E86A", "#5FBF5A"], vx: 14, vy: 10, sway: 18, size: [6, 9.5], life: [4.5, 7], draw: leaf, spin: 1.6 },
  thunder_foundry: { n: 10, busy: 4, colors: ["#8CD3FF", "#C9ECFF", "#5BB8FF"], vx: 0, vy: -6, sway: 6, size: [5, 8.5], life: [0.7, 1.4], draw: spark, flicker: true },
  astral_rift: { n: 12, busy: 5, colors: ["#D9B8FF", "#FFD39A", "#B58CFF"], vx: 2, vy: -9, sway: 8, size: [5, 9], life: [4, 6.5], draw: star, spin: 0.25, flicker: true },
};

/** Each look drawn once at a fixed size and reused: the particle "texture". */
const SPRITES = new Map<string, HTMLCanvasElement>();
const SPRITE_PX = 48;
function sprite(world: WorldId, kind: Kind, color: string): HTMLCanvasElement {
  const key = `${world}|${color}`;
  let c = SPRITES.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = SPRITE_PX;
    const ctx = c.getContext("2d")!;
    ctx.translate(SPRITE_PX / 2, SPRITE_PX / 2);
    kind.draw(ctx, SPRITE_PX * 0.36, color);
    SPRITES.set(key, c);
  }
  return c;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  rot: number;
  vr: number;
  phase: number;
  color: string;
}

/** The world's weather over one battlefield. */
export class Weather {
  private motes: Mote[] = [];
  private spawnIn = 0;

  constructor(private world: WorldId) {}

  get kind(): Kind | undefined {
    return KINDS[this.world];
  }

  get count(): number {
    return this.motes.length;
  }

  clear() {
    this.motes = [];
  }

  /**
   * Advance and draw. `area` is the visible room (stage px); `keepOut` the
   * walkable floor's rough box and the HUD, where nothing is born or lingers.
   */
  tick(ctx: CanvasRenderingContext2D, dt: number, area: { x: number; y: number; w: number; h: number }, keepOut: (x: number, y: number) => boolean, busy: boolean) {
    const k = this.kind;
    if (!k) return;
    const cap = busy ? k.busy : k.n;
    // Births: spread out in time, never a burst.
    this.spawnIn -= dt;
    if (this.motes.length < cap && this.spawnIn <= 0) {
      this.spawnIn = (k.life[0] / k.n) * (0.6 + Math.random() * 0.8);
      for (let tries = 0; tries < 8; tries++) {
        const x = area.x + Math.random() * area.w;
        // Rising weather is born low in the backdrop, falling weather high.
        const y = k.vy < 0 ? area.y + area.h * (0.12 + Math.random() * 0.6) : area.y + area.h * (0.02 + Math.random() * 0.5);
        if (keepOut(x, y)) continue;
        const max = k.life[0] + Math.random() * (k.life[1] - k.life[0]);
        this.motes.push({
          x, y, vx: k.vx * (0.6 + Math.random() * 0.8), vy: k.vy * (0.7 + Math.random() * 0.6),
          life: max, max, size: k.size[0] + Math.random() * (k.size[1] - k.size[0]),
          rot: Math.random() * Math.PI * 2, vr: (k.spin ?? 0) * (Math.random() - 0.5) * 2,
          phase: Math.random() * Math.PI * 2, color: k.colors[Math.floor(Math.random() * k.colors.length)],
        });
        break;
      }
    }
    // Over cap (the fight got busy): the oldest fade out first.
    if (this.motes.length > cap) this.motes.sort((a, b) => a.life - b.life).slice(0, this.motes.length - cap).forEach((m) => (m.life = Math.min(m.life, 0.4)));
    for (const m of this.motes) {
      m.life -= dt;
      m.phase += dt * 1.7;
      m.x += (m.vx + Math.sin(m.phase) * k.sway) * dt;
      m.y += m.vy * dt;
      m.rot += m.vr * dt;
      // A stirred mote slows back to its drift.
      m.vx += (k.vx - m.vx) * Math.min(1, dt * 1.2);
      m.vy += (k.vy - m.vy) * Math.min(1, dt * 1.2);
      // Into the floor box: it fades rather than crossing the fight.
      if (keepOut(m.x, m.y)) m.life = Math.min(m.life, 0.35);
    }
    this.motes = this.motes.filter((m) => m.life > 0);
    for (const m of this.motes) {
      const t = m.life / m.max;
      let alpha = Math.min(1, (1 - t) * 4, t * 3);
      if (k.flicker) alpha *= 0.55 + 0.45 * Math.abs(Math.sin(m.phase * 2.3));
      if (alpha <= 0.01) continue;
      const im = sprite(this.world, k, m.color);
      // The sprite's drawing has radius SPRITE_PX·0.36; shown at m.size·1.7.
      const s = (SPRITE_PX * m.size * 1.7) / (SPRITE_PX * 0.36);
      ctx.save();
      ctx.globalAlpha = alpha * 0.9;
      ctx.translate(m.x, m.y);
      if (m.rot) ctx.rotate(m.rot);
      ctx.drawImage(im, -s / 2, -s / 2, s, s);
      ctx.restore();
    }
  }

  /** 元素反應: a blow that lands pushes the nearby weather away, and lets a few more loose. */
  stir(at: Pt, strength = 1) {
    const k = this.kind;
    if (!k) return;
    for (const m of this.motes) {
      const dx = m.x - at.x;
      const dy = m.y - at.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > 320) continue;
      const push = (1 - d / 320) * 220 * strength;
      m.vx += (dx / d) * push;
      m.vy += (dy / d) * push * 0.7;
      m.life = Math.max(m.life, 0.8);
    }
  }
}
