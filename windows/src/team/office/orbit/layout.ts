// Where things are in the universe. Clusters keep the place they were given:
// a new team takes the first free slot, a team that leaves frees its slot and
// no one else moves. Members circle their hub slowly, each on its own phase.
// Numbers are the spec's reference values (data/visual-config.json); the
// scene unit is not a metre.

export type Vec3 = [number, number, number];

export interface ClusterInput {
  id: string;
  /** How many members, the hub included. */
  size: number;
}

export interface ClusterLayoutOptions {
  /** Narrow scene: clusters stacked top to bottom instead of spread left to right. */
  vertical: boolean;
}

const COL_SPACING = 7.8;
const ROW_SPACING = 7;
const ROW_DROP = 2.2;
const VERTICAL_SPACING = 5.6;

/** The cluster's own radius: how far members sit from the hub. */
export function clusterRadius(size: number, vertical: boolean): number {
  const base = vertical ? (size >= 5 ? 1.75 : 1.55) : size >= 5 ? 2.35 : size === 4 ? 2.05 : 1.62;
  return base + Math.max(0, size - 5) * 0.28;
}

/** The faint ellipse drawn around a cluster. */
export function orbitRadius(size: number): number {
  return size >= 5 ? 2.75 + Math.max(0, size - 5) * 0.3 : 2.15;
}

/** The angles the members other than the hub start at: spread out, never all on one side. */
export function memberAngles(size: number): number[] {
  const n = Math.max(0, size - 1);
  if (n === 1) return [0];
  if (n === 2) return [2.8, 0.1];
  if (n === 4) return [0.18, 1.65, 3.13, 4.7];
  return Array.from({ length: n }, (_, i) => 0.18 + (i * Math.PI * 2) / n);
}

/** A small, fixed wobble per slot so a grid never reads as a table. */
const jitter = (slot: number, salt: number) => {
  const x = Math.sin(slot * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x) - 0.5;
};

export class ClusterLayout {
  /** Slot → team id; a freed slot is null until the next team takes it. */
  private order: (string | null)[] = [];
  private sizes = new Map<string, number>();

  /** The teams as they are now: newcomers get the first free slot, the gone free theirs. */
  update(teams: readonly ClusterInput[]) {
    const ids = new Set(teams.map((t) => t.id));
    this.order = this.order.map((id) => (id && ids.has(id) ? id : null));
    for (const t of teams) {
      this.sizes.set(t.id, t.size);
      if (this.order.includes(t.id)) continue;
      const free = this.order.indexOf(null);
      if (free >= 0) this.order[free] = t.id;
      else this.order.push(t.id);
    }
    for (const id of [...this.sizes.keys()]) if (!ids.has(id)) this.sizes.delete(id);
    while (this.order.length && this.order[this.order.length - 1] === null) this.order.pop();
  }

  slot(teamId: string): number {
    return this.order.indexOf(teamId);
  }

  /** How many slots are in use, holes included. */
  get count(): number {
    return this.order.length;
  }

  /** The grid the slots are laid on: as many columns as rows, roughly. */
  columns(vertical: boolean): number {
    const n = this.order.length;
    if (vertical || n <= 1) return 1;
    if (n <= 4) return 2;
    if (n <= 9) return 3;
    return Math.ceil(Math.sqrt(n));
  }

  /** Clusters spread further when one of them is large, so orbits never overlap. */
  private spacing(): number {
    let r = 0;
    for (const s of this.sizes.values()) r = Math.max(r, orbitRadius(s));
    return Math.max(COL_SPACING, r * 2 + 3.3);
  }

  /** The centre a team's cluster is placed at (its target; the view may glide there). */
  centre(teamId: string, opts: ClusterLayoutOptions): Vec3 {
    const i = this.slot(teamId);
    if (i < 0) return [0, 0, 0];
    const n = this.order.length;
    if (opts.vertical) {
      const y = ((n - 1) / 2 - i) * VERTICAL_SPACING;
      return [jitter(i, 1) * 1, y, jitter(i, 2) * 1.8];
    }
    const cols = this.columns(false);
    const rows = Math.ceil(n / cols);
    const col = i % cols, row = Math.floor(i / cols);
    const sx = this.spacing();
    // Back rows sit a little higher and shifted, like the reference's four.
    const x = (col - (cols - 1) / 2) * sx + (row % 2 ? 0.75 : -0.6);
    const y = -(row - (rows - 1) / 2) * ROW_DROP + jitter(i, 3) * 0.8;
    const z = (row - (rows - 1) / 2) * ROW_SPACING;
    return [x, y, z];
  }

  /** Every centre, for fitting the camera. */
  centres(opts: ClusterLayoutOptions): { id: string; p: Vec3; r: number }[] {
    return this.order.flatMap((id) => (id ? [{ id, p: this.centre(id, opts), r: orbitRadius(this.sizes.get(id) ?? 1) }] : []));
  }
}

export interface MotionOptions {
  /** The scene clock, in seconds; still while paused. */
  phase: number;
  /** 0 stops every drift; 1 is the reference. */
  drift: number;
  vertical: boolean;
}

/**
 * Where a member is at this moment: the hub roams a little at the centre, the
 * others circle at their own angles and bob on their own phase.
 */
export function memberPosition(centre: Vec3, index: number, size: number, slot: number, o: MotionOptions): Vec3 {
  const dir = slot % 2 ? -1 : 1;
  let angle = 0, radius = 0, depthRadius = 0, dy = 0;
  if (index > 0) {
    const angles = memberAngles(size);
    angle = angles[(index - 1) % angles.length] + o.phase * 0.022 * o.drift * dir;
    radius = clusterRadius(size, o.vertical);
    depthRadius = o.vertical ? 0.8 : radius;
    // Members behind the hub sit a little higher, so the camera's tilt never stacks them on it.
    dy = -Math.sin(angle) * (o.vertical ? 1.4 : size >= 5 ? 0.9 : size === 4 ? 0.7 : 0.15);
  }
  const bob = Math.sin(o.phase * 0.78 + slot * 1.7 + index * 1.4) * 0.22 * o.drift;
  const roam = index ? 0 : Math.sin(o.phase * 0.12 + slot) * 0.17 * o.drift;
  return [centre[0] + Math.cos(angle) * radius + roam, centre[1] + dy + bob + (index ? 0 : 0.18), centre[2] + Math.sin(angle) * depthRadius];
}

/** A point on one of a cluster's two faint orbit ellipses. */
export function orbitPoint(centre: Vec3, size: number, theta: number, layer: 0 | 1, vertical: boolean): Vec3 {
  const r = orbitRadius(size) * (vertical ? 0.8 : 1);
  const tilt = (vertical ? -0.6 : size >= 5 ? -0.38 : -0.13) + (layer === 1 ? 0.26 : 0);
  return [centre[0] + Math.cos(theta) * r, centre[1] - 0.3 + Math.sin(theta) * r * tilt + (layer === 1 ? 0.14 : 0), centre[2] + Math.sin(theta) * r * (vertical ? 0.5 : layer === 1 ? 0.72 : 1)];
}

/** The arc a line between two members follows: P(u) = a(1−u) + b·u + (0, sin(πu)·0.8, 0). */
export function curve(a: Vec3, b: Vec3, u: number): Vec3 {
  const q = 1 - u;
  return [a[0] * q + b[0] * u, a[1] * q + b[1] * u + Math.sin(u * Math.PI) * 0.8, a[2] * q + b[2] * u];
}

export const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
