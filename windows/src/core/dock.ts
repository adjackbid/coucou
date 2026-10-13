// Where the island sits on its display: the top edge (left / centre / right)
// or the left or right edge, where the compact capsule stands on end.
// Mirror of `Dock` in src-tauri/src/settings.rs.
//
// The numbers below are shared with src-tauri/src/island.rs (snap_dock,
// capsule_in_window, window_rect): change one side, change the other, and the
// tests on both sides pin the same cases.

import { COMPACT_W, NOTCH_H, PANEL_H, PANEL_W } from "./layout";

export type DockEdge = "top" | "left" | "right";
export type DockAnchor = "start" | "center" | "end";

export interface Dock {
  edge: DockEdge;
  /** Top only: left / middle / right. */
  anchor: DockAnchor;
  /** Left/right only: the capsule's centre as a fraction of the work area's height. */
  offset: number;
  /** The display it was dropped on; only used while `screen` is "docked". */
  monitor: string;
}

export const DEFAULT_DOCK: Dock = { edge: "top", anchor: "center", offset: 0.5, monitor: "" };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gap between the capsule and the screen corner when docked top left / top right. */
export const TOP_INSET = 24;
/** Room kept above and below a capsule on its side. */
export const SIDE_MARGIN = 12;
/** How much nearer another edge (or third of the top) must be before the preview flips. */
export const SNAP_HYSTERESIS = 24;
/** A side capsule dropped this close to the middle goes exactly to the middle. */
export const CENTRE_SNAP = 24;
/** The landing hint shows only while the cursor is this close to the edge. */
export const HINT_DISTANCE = 96;

export function isVertical(dock: { edge: DockEdge }): boolean {
  return dock.edge === "left" || dock.edge === "right";
}

/**
 * Where a capsule let go at `p` docks, in the logical coordinates of its
 * display's work area. There is no bottom edge: the nearest of the other
 * three wins, so a drop low on the screen springs back to a side or the top.
 * `prev` is the preview so far — nearly-equal choices keep it, which stops the
 * capsule flipping back and forth around a corner.
 */
export function snapDock(
  p: { x: number; y: number },
  wa: Rect,
  prev: { edge: DockEdge; anchor: DockAnchor } | null,
): Dock {
  const dTop = p.y - wa.y;
  const dLeft = p.x - wa.x;
  const dRight = wa.x + wa.w - p.x;
  const side: DockEdge = dLeft <= dRight ? "left" : "right";
  const dSide = Math.min(dLeft, dRight);

  let edge: DockEdge;
  if (prev?.edge === "top") edge = dSide < dTop - SNAP_HYSTERESIS ? side : "top";
  else if (prev && isVertical(prev)) edge = dTop < dSide - SNAP_HYSTERESIS ? "top" : side;
  else edge = dSide < dTop ? side : "top";

  if (edge === "top") {
    const rx = p.x - wa.x;
    const b1 = wa.w / 3;
    const b2 = (wa.w * 2) / 3;
    let anchor: DockAnchor = rx < b1 ? "start" : rx > b2 ? "end" : "center";
    if (prev?.edge === "top") {
      const h = SNAP_HYSTERESIS;
      if (prev.anchor === "start" && rx < b1 + h) anchor = "start";
      else if (prev.anchor === "end" && rx > b2 - h) anchor = "end";
      else if (prev.anchor === "center" && rx >= b1 - h && rx <= b2 + h) anchor = "center";
    }
    return { edge, anchor, offset: 0.5, monitor: "" };
  }

  return { edge, anchor: "center", offset: sideOffset(p.y - wa.y, wa.h), monitor: "" };
}

/** The capsule's centre `oy` px down a work area `height` px tall, as a dock offset. */
export function sideOffset(oy: number, height: number): number {
  const lo = COMPACT_W / 2 + SIDE_MARGIN;
  const hi = height - lo;
  if (hi <= lo || height <= 0) return 0.5;
  if (Math.abs(oy - height / 2) <= CENTRE_SNAP) return 0.5;
  return Math.min(hi, Math.max(lo, oy)) / height;
}

/** How far `p` is from the edge a dock lies against. */
export function edgeDistance(p: { x: number; y: number }, wa: Rect, edge: DockEdge): number {
  switch (edge) {
    case "top":
      return p.y - wa.y;
    case "left":
      return p.x - wa.x;
    case "right":
      return wa.x + wa.w - p.x;
  }
}

/**
 * The full window, logical px: the landscape panel along the top, the same
 * turned on its side along a side (`len` long, shorter on a short display).
 * A dragged island always gets the landscape one.
 */
export function windowSize(dock: { edge: DockEdge }, len: number, dragging = false): { w: number; h: number } {
  if (!dragging && isVertical(dock)) return { w: PANEL_H, h: len };
  return { w: PANEL_W, h: PANEL_H };
}

/**
 * The island in the full window (logical px), `w`×`h` being its current size.
 * Against the edge it is docked to; while being dragged, floating in the
 * middle of the window, which Rust keeps centred under the cursor.
 * `anchorInWindow` is where a side island's centre wants to be and `len` the
 * window's length along that side (both from Rust).
 */
export function dockedRect(
  dock: Dock, w: number, h: number, anchorInWindow: number, dragging = false, len = PANEL_W,
): Rect {
  if (dragging) return { x: (PANEL_W - w) / 2, y: (PANEL_H - h) / 2, w, h };
  if (isVertical(dock)) {
    const y = Math.min(Math.max(0, anchorInWindow - h / 2), Math.max(0, len - h));
    return { x: dock.edge === "left" ? 0 : PANEL_H - w, y, w, h };
  }
  const x =
    dock.anchor === "start" ? TOP_INSET
    : dock.anchor === "end" ? PANEL_W - w - TOP_INSET
    : (PANEL_W - w) / 2;
  return { x, y: 0, w, h };
}

/**
 * CSS border-radius (top-left, top-right, bottom-right, bottom-left): flat
 * against the screen edge, round towards the inside; round all over while
 * floating under the cursor.
 */
export function cornerRadii(dock: { edge: DockEdge }, r: number, dragging = false): string {
  const v = `${r.toFixed(2)}px`;
  if (dragging) return `${v} ${v} ${v} ${v}`;
  switch (dock.edge) {
    case "left":
      return `0 ${v} ${v} 0`;
    case "right":
      return `${v} 0 0 ${v}`;
    default:
      return `0 0 ${v} ${v}`;
  }
}

/** Invisible strip that wakes the hidden island, in the full window (logical px). */
export const WAKE_STRIP_LEN = 240;
export const WAKE_STRIP_THICK = 6;

/** Where the wake strip lies in the full window: along the edge, across from the capsule's centre. */
export function wakeStripRect(dock: Dock, anchorInWindow: number, len = PANEL_W): Rect {
  if (isVertical(dock)) {
    const c = dockedRect(dock, NOTCH_H, COMPACT_W, anchorInWindow, false, len);
    return {
      x: dock.edge === "left" ? 0 : PANEL_H - WAKE_STRIP_THICK,
      y: c.y + c.h / 2 - WAKE_STRIP_LEN / 2,
      w: WAKE_STRIP_THICK,
      h: WAKE_STRIP_LEN,
    };
  }
  const c = dockedRect(dock, COMPACT_W, NOTCH_H, anchorInWindow);
  return { x: c.x + c.w / 2 - WAKE_STRIP_LEN / 2, y: 0, w: WAKE_STRIP_LEN, h: WAKE_STRIP_THICK };
}
