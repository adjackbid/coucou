import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCK, cornerRadii, dockedRect, edgeDistance, isVertical, sideOffset, snapDock, wakeStripRect, windowSize,
  type Dock, type Rect,
} from "./dock";
import { botPosition, islandSize } from "./layout";

/** 1920×1080 with a 48 px taskbar at the bottom. The same cases as island.rs. */
const WA: Rect = { x: 0, y: 0, w: 1920, h: 1032 };
const dock = (edge: Dock["edge"], anchor: Dock["anchor"] = "center", offset = 0.5): Dock =>
  ({ edge, anchor, offset, monitor: "" });

describe("snapDock", () => {
  it("splits the top into three", () => {
    expect(snapDock({ x: 100, y: 5 }, WA, null)).toMatchObject({ edge: "top", anchor: "start" });
    expect(snapDock({ x: 960, y: 5 }, WA, null)).toMatchObject({ edge: "top", anchor: "center" });
    expect(snapDock({ x: 1800, y: 5 }, WA, null)).toMatchObject({ edge: "top", anchor: "end" });
  });

  it("docks to the sides with an offset that keeps the capsule on screen", () => {
    expect(snapDock({ x: 3, y: 300 }, WA, null)).toMatchObject({ edge: "left", offset: 300 / 1032 });
    expect(snapDock({ x: 1915, y: 700 }, WA, null)).toMatchObject({ edge: "right", offset: 700 / 1032 });
    expect(snapDock({ x: 3, y: 100 }, WA, null).offset).toBeCloseTo(156 / 1032, 9);
  });

  it("never docks to the bottom", () => {
    expect(snapDock({ x: 960, y: 1000 }, WA, null).edge).not.toBe("bottom");
    expect(snapDock({ x: 900, y: 1000 }, WA, null).edge).toBe("left");
    const corner = snapDock({ x: 1910, y: 1030 }, WA, null);
    expect(corner.edge).toBe("right");
    expect(corner.offset).toBeCloseTo((1032 - 156) / 1032);
    expect(snapDock({ x: 10, y: 1030 }, WA, null).edge).toBe("left");
  });

  it("keeps the top until a side is clearly nearer", () => {
    const top = { edge: "top", anchor: "start" } as const;
    expect(snapDock({ x: 40, y: 50 }, WA, top).edge).toBe("top");
    expect(snapDock({ x: 20, y: 50 }, WA, top).edge).toBe("left");
    const left = { edge: "left", anchor: "center" } as const;
    expect(snapDock({ x: 50, y: 40 }, WA, left).edge).toBe("left");
    expect(snapDock({ x: 50, y: 20 }, WA, left).edge).toBe("top");
  });

  it("keeps the third it is in until well past the line", () => {
    const start = { edge: "top", anchor: "start" } as const;
    expect(snapDock({ x: 650, y: 5 }, WA, start).anchor).toBe("start");
    expect(snapDock({ x: 670, y: 5 }, WA, start).anchor).toBe("center");
    const centre = { edge: "top", anchor: "center" } as const;
    expect(snapDock({ x: 630, y: 5 }, WA, centre).anchor).toBe("center");
    expect(snapDock({ x: 610, y: 5 }, WA, centre).anchor).toBe("start");
    expect(snapDock({ x: 1290, y: 5 }, WA, centre).anchor).toBe("center");
    expect(snapDock({ x: 1310, y: 5 }, WA, centre).anchor).toBe("end");
    const end = { edge: "top", anchor: "end" } as const;
    expect(snapDock({ x: 1270, y: 5 }, WA, end).anchor).toBe("end");
    expect(snapDock({ x: 1250, y: 5 }, WA, end).anchor).toBe("center");
  });

  it("goes to the exact middle when close to it", () => {
    expect(snapDock({ x: 3, y: 516 + 20 }, WA, null).offset).toBe(0.5);
    expect(snapDock({ x: 3, y: 516 - 24 }, WA, null).offset).toBe(0.5);
    expect(snapDock({ x: 3, y: 516 + 30 }, WA, null).offset).toBeCloseTo(546 / 1032);
  });

  it("works on a display that does not start at 0,0", () => {
    const wa = { x: -1920, y: -300, w: 1920, h: 1040 };
    expect(snapDock({ x: -1900, y: 100 }, wa, null)).toMatchObject({ edge: "left", offset: 400 / 1040 });
    expect(snapDock({ x: -100, y: -295 }, wa, null)).toMatchObject({ edge: "top", anchor: "end" });
    expect(snapDock({ x: -5, y: 200 }, wa, null).edge).toBe("right");
  });

  it("gives the middle on a display too short to choose", () => {
    expect(sideOffset(100, 250)).toBe(0.5);
  });
});

describe("edgeDistance", () => {
  it("measures from the dock's edge", () => {
    expect(edgeDistance({ x: 50, y: 30 }, WA, "top")).toBe(30);
    expect(edgeDistance({ x: 50, y: 30 }, WA, "left")).toBe(50);
    expect(edgeDistance({ x: 1900, y: 30 }, WA, "right")).toBe(20);
  });
});

describe("dockedRect", () => {
  it("puts the top island where it always was", () => {
    expect(dockedRect(DEFAULT_DOCK, 288, 32, 16)).toEqual({ x: 516, y: 0, w: 288, h: 32 });
    expect(dockedRect(DEFAULT_DOCK, 640, 160, 16)).toEqual({ x: 340, y: 0, w: 640, h: 160 });
  });

  it("grows from the corner it is docked in", () => {
    expect(dockedRect(dock("top", "start"), 288, 32, 16).x).toBe(24);
    expect(dockedRect(dock("top", "start"), 640, 160, 16).x).toBe(24);
    expect(dockedRect(dock("top", "end"), 288, 32, 16).x).toBe(1320 - 288 - 24);
    expect(dockedRect(dock("top", "end"), 1200, 160, 16).x).toBe(1320 - 1200 - 24);
  });

  it("hugs a side, centred on the anchor and inside the window", () => {
    // The side window is 320 wide and `len` long.
    expect(dockedRect(dock("left"), 32, 288, 660, false, 1320)).toEqual({ x: 0, y: 516, w: 32, h: 288 });
    expect(dockedRect(dock("right"), 32, 288, 660, false, 1320)).toEqual({ x: 288, y: 516, w: 32, h: 288 });
    // The panel turned on its side grows inwards from the side, centred on the anchor.
    expect(dockedRect(dock("left"), 160, 640, 660, false, 1320)).toEqual({ x: 0, y: 340, w: 160, h: 640 });
    expect(dockedRect(dock("right"), 160, 640, 660, false, 1320)).toEqual({ x: 160, y: 340, w: 160, h: 640 });
    // A window clamped at an end of the screen: the anchor is near that end, the shapes stay in.
    expect(dockedRect(dock("left"), 32, 288, 12, false, 1320).y).toBe(0);
    expect(dockedRect(dock("left"), 160, 640, 12, false, 1320).y).toBe(0);
    expect(dockedRect(dock("right"), 160, 640, 1300, false, 1320).y).toBe(680);
    expect(dockedRect(dock("right"), 32, 288, 1310, false, 1032).y).toBe(744);
    expect(dockedRect(dock("left"), 0, 184, 660, false, 1320)).toEqual({ x: 0, y: 568, w: 0, h: 184 });
  });

  it("knows the window's shape", () => {
    expect(windowSize(DEFAULT_DOCK, 1320)).toEqual({ w: 1320, h: 320 });
    expect(windowSize(dock("left"), 1032)).toEqual({ w: 320, h: 1032 });
    expect(windowSize(dock("left"), 1032, true)).toEqual({ w: 1320, h: 320 });
  });

  it("floats in the middle while dragged", () => {
    expect(dockedRect(dock("left"), 32, 288, 12, true)).toEqual({ x: 644, y: 16, w: 32, h: 288 });
    expect(dockedRect(DEFAULT_DOCK, 288, 32, 16, true)).toEqual({ x: 516, y: 144, w: 288, h: 32 });
  });
});

describe("cornerRadii", () => {
  it("is flat against the edge", () => {
    expect(cornerRadii(dock("top"), 14)).toBe("0 0 14.00px 14.00px");
    expect(cornerRadii(dock("left"), 14)).toBe("0 14.00px 14.00px 0");
    expect(cornerRadii(dock("right"), 14)).toBe("14.00px 0 0 14.00px");
    expect(cornerRadii(dock("right"), 14, true)).toBe("14.00px 14.00px 14.00px 14.00px");
  });
});

describe("wakeStripRect", () => {
  it("lies along the edge across from the capsule", () => {
    expect(wakeStripRect(DEFAULT_DOCK, 16)).toEqual({ x: 540, y: 0, w: 240, h: 6 });
    expect(wakeStripRect(dock("top", "start"), 16)).toEqual({ x: 24 + 144 - 120, y: 0, w: 240, h: 6 });
    expect(wakeStripRect(dock("left"), 660, 1320)).toEqual({ x: 0, y: 540, w: 6, h: 240 });
    expect(wakeStripRect(dock("right"), 660, 1320)).toEqual({ x: 314, y: 540, w: 6, h: 240 });
  });
});

describe("vertical sizes", () => {
  it("stands the capsule on end and turns the panel on its side", () => {
    expect(isVertical(dock("left"))).toBe(true);
    expect(isVertical(DEFAULT_DOCK)).toBe(false);
    expect(islandSize("compact", "overview")).toEqual({ w: 288, h: 32 });
    expect(islandSize("compact", "overview", 0, 0, 0, 0, null, false, false, true)).toEqual({ w: 32, h: 288 });
    expect(islandSize("hidden", "overview", 0, 0, 0, 0, null, false, false, true)).toEqual({ w: 0, h: 184 });
    const v = (view: Parameters<typeof islandSize>[1], extra = 0) =>
      islandSize("expanded", view, 0, 0, 0, extra, null, false, false, true);
    expect(islandSize("expanded", "overview")).toEqual({ w: 640, h: 160 });
    expect(v("overview")).toEqual({ w: 160, h: 640 });
    expect(v("overview", 1)).toEqual({ w: 160, h: 920 });
    expect(v("session")).toEqual({ w: 300, h: 640 });
    // The canvases keep a width they can be shrunk into.
    expect(v("greeting")).toEqual({ w: 300, h: 640 });
    expect(v("uploading")).toEqual({ w: 300, h: 640 });
    // Mochi sits on top of a side card, centred.
    expect(botPosition("expanded", "approval", 640, 0, true, 160)).toEqual({ cx: 80, cy: 68 + 14 + 23, diameter: 46, opacity: 1 });
    expect(botPosition("compact", "overview", 288, 0, true)).toEqual({ cx: 16, cy: 40, diameter: 20, opacity: 1 });
    expect(botPosition("compact", "overview", 32)).toEqual({ cx: 40, cy: 16, diameter: 20, opacity: 1 });
  });
});
