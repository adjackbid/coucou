// 中二模式's painted effects: 42 single textures (feature2/特效貼圖生成結果),
// animated here. ADD textures are painted on black and drawn with additive
// blending, so the black vanishes; SOLID ones carry real alpha. The white
// general ones are tinted to each move's colours. Until every texture has
// loaded, the fight keeps its drawn-in-code effects.

type Pt = { x: number; y: number };

interface Tex {
  file: string;
  type: "ADD" | "SOLID";
  size: [number, number];
  pivot: [number, number];
  img?: HTMLImageElement;
  /** What is drawn: for ADD, the picture with its brightness turned into alpha. */
  src?: CanvasImageSource;
}

/**
 * Additive blending on a transparent canvas adds alpha too, so a texture's
 * black would turn opaque. Brightness becomes alpha instead (black → fully
 * transparent, colour un-premultiplied), and that is drawn additively.
 */
function lumaToAlpha(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const a = Math.max(p[i], p[i + 1], p[i + 2]);
    if (a === 0) {
      p[i + 3] = 0;
      continue;
    }
    const k = 255 / a;
    p[i] = Math.min(255, p[i] * k);
    p[i + 1] = Math.min(255, p[i + 1] * k);
    p[i + 2] = Math.min(255, p[i + 2] * k);
    p[i + 3] = a;
  }
  g.putImageData(d, 0, 0);
  return c;
}

/** Called once every texture is ready (the scene's frame loop wakes on it). */
let onReady: (() => void) | null = null;
export function whenVfxReady(fn: () => void) {
  onReady = fn;
  load();
}

let textures: Record<string, Tex> | null = null;
let loaded = 0;
let total = -1;
let asked = false;

function load() {
  if (asked || typeof window === "undefined") return;
  asked = true;
  fetch("/office/battle/vfx/vfx.json")
    .then((r) => r.json())
    .then((j: { textures: Record<string, Tex> }) => {
      textures = j.textures;
      const list = Object.values(textures);
      total = list.length;
      for (const t of list) {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => {
          t.src = t.type === "ADD" ? lumaToAlpha(img) : img;
          loaded += 1;
          if (loaded >= total) onReady?.();
        };
        img.src = `/office/${t.file}`;
        t.img = img;
      }
    })
    .catch(() => {
      total = -2;
    });
}

/** Every texture is in: the painted effects play. */
export function vfxReady(): boolean {
  load();
  return total > 0 && loaded >= total;
}

/** A tinted copy of a texture, made once per colour. */
const tinted = new Map<string, HTMLCanvasElement>();
function tintOf(id: string, t: Tex, colour: string): CanvasImageSource {
  const key = `${id}|${colour}`;
  let c = tinted.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = t.size[0];
    c.height = t.size[1];
    const g = c.getContext("2d")!;
    g.drawImage(t.src!, 0, 0);
    // White becomes the colour, then the texture's own shape is kept.
    g.globalCompositeOperation = "multiply";
    g.fillStyle = colour;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(t.src!, 0, 0);
    tinted.set(key, c);
  }
  return c;
}

export interface TexOpts {
  /** Drawn width in room pixels (height follows the texture's shape). */
  w: number;
  rot?: number;
  alpha?: number;
  tint?: string;
  /** Flatten to the floor (rings, circles): vertical scale. */
  sy?: number;
  /** Stretch along the texture's length (bolts, breath). */
  sx?: number;
}

/** One texture, its pivot on `at`. */
export function tex(ctx: CanvasRenderingContext2D, id: string, at: Pt, o: TexOpts) {
  const t = textures?.[id];
  if (!t?.src) return;
  const alpha = Math.max(0, Math.min(1, o.alpha ?? 1));
  if (alpha <= 0.01 || o.w <= 1) return;
  const k = o.w / t.size[0];
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (t.type === "ADD") ctx.globalCompositeOperation = "lighter";
  ctx.translate(at.x, at.y);
  if (o.sy !== undefined) ctx.scale(1, o.sy);
  if (o.rot) ctx.rotate(o.rot);
  ctx.scale(k * (o.sx ?? 1), k);
  ctx.drawImage(o.tint ? tintOf(id, t, o.tint) : t.src, -t.pivot[0], -t.pivot[1]);
  ctx.restore();
}

/** The drawn width that makes a texture reach `length` from its pivot (a bolt from a to b). */
export function widthToReach(id: string, length: number): number {
  const t = textures?.[id];
  if (!t) return length;
  return (length * t.size[0]) / Math.max(1, t.size[0] - t.pivot[0]);
}
