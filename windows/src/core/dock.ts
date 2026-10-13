// Where the island sits on its display: the top edge (left / centre / right)
// or the left or right edge, where the compact capsule stands on end.
// Mirror of `Dock` in src-tauri/src/settings.rs.

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
