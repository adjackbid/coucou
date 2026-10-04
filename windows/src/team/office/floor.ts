// The company floor's layout, kept apart from the page so it can be tested.

/**
 * How many columns the company floor has: the count whose packed shape (as
 * CSS grid's dense flow packs it, a large office taking 2 × 2) is closest to
 * a frame a little wider than tall. Sizes are the rooms' spans, in order.
 */
export function floorColumns(spans: number[], aspect = 1.3): number {
  if (!spans.length) return 1;
  const min = Math.max(...spans);
  const cells = spans.reduce((n, s) => n + s * s, 0);
  let best = min, score = Infinity;
  for (let cols = min; cols <= Math.max(min, cells); cols++) {
    const used: boolean[][] = [];
    const free = (r: number, c: number, s: number) => {
      for (let i = r; i < r + s; i++) for (let j = c; j < c + s; j++) if (j >= cols || used[i]?.[j]) return false;
      return true;
    };
    let rows = 0;
    for (const s of spans) {
      for (let r = 0, placed = false; !placed; r++) {
        for (let c = 0; c + s <= cols && !placed; c++) {
          if (!free(r, c, s)) continue;
          for (let i = r; i < r + s; i++) for (let j = c; j < c + s; j++) (used[i] ??= [])[j] = true;
          rows = Math.max(rows, r + s);
          placed = true;
        }
      }
    }
    // A room is about 330 × 300; empty cells count against a layout.
    const shape = Math.abs(Math.log((cols * 330) / (rows * 300) / aspect));
    const waste = (cols * rows - cells) / (cols * rows);
    const total = shape + waste;
    if (total < score - 1e-9) {
      score = total;
      best = cols;
    }
  }
  return best;
}
