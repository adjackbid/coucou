// Clusters keep their place: a newcomer takes a free slot, a leaver frees one,
// and nobody else moves. Members spread around the hub, never stacked.

import { describe, expect, it } from "vitest";
import { ClusterLayout, clusterRadius, curve, memberAngles, memberPosition, orbitRadius } from "./layout";

const desktop = { vertical: false };

describe("ClusterLayout", () => {
  it("keeps every existing cluster where it was when a team is added", () => {
    const l = new ClusterLayout();
    l.update([{ id: "a", size: 2 }, { id: "b", size: 5 }, { id: "c", size: 3 }]);
    const before = ["a", "b", "c"].map((id) => l.centre(id, desktop));
    l.update([{ id: "a", size: 2 }, { id: "b", size: 5 }, { id: "c", size: 3 }, { id: "d", size: 1 }]);
    // Four fit the same 2-column grid as three: the first three do not move.
    expect(["a", "b", "c"].map((id) => l.centre(id, desktop))).toEqual(before);
    expect(l.slot("d")).toBe(3);
  });

  it("gives a new team the slot a gone team left, and the order of the list changes nothing", () => {
    const l = new ClusterLayout();
    l.update([{ id: "a", size: 2 }, { id: "b", size: 3 }, { id: "c", size: 3 }]);
    l.update([{ id: "c", size: 3 }, { id: "a", size: 2 }]);
    expect(l.slot("a")).toBe(0);
    expect(l.slot("c")).toBe(2);
    expect(l.slot("b")).toBe(-1);
    l.update([{ id: "c", size: 3 }, { id: "a", size: 2 }, { id: "d", size: 4 }]);
    expect(l.slot("d")).toBe(1);
  });

  it("spaces clusters at least two orbit radii apart, further when one is large", () => {
    const l = new ClusterLayout();
    l.update([{ id: "a", size: 2 }, { id: "b", size: 9 }]);
    const [a, b] = [l.centre("a", desktop), l.centre("b", desktop)];
    const gap = Math.hypot(a[0] - b[0], a[2] - b[2]);
    expect(gap).toBeGreaterThan(orbitRadius(2) + orbitRadius(9) + 2);
  });

  it("stacks clusters top to bottom on a narrow scene", () => {
    const l = new ClusterLayout();
    l.update([{ id: "a", size: 2 }, { id: "b", size: 3 }, { id: "c", size: 3 }]);
    const ys = ["a", "b", "c"].map((id) => l.centre(id, { vertical: true })[1]);
    expect(ys[0]).toBeGreaterThan(ys[1]);
    expect(ys[1]).toBeGreaterThan(ys[2]);
    expect(Math.abs(l.centre("a", { vertical: true })[0])).toBeLessThan(1);
  });

  it("works for one team alone", () => {
    const l = new ClusterLayout();
    l.update([{ id: "solo", size: 1 }]);
    expect(l.centre("solo", desktop)).toEqual([expect.any(Number), expect.any(Number), 0]);
    expect(Math.abs(l.centre("solo", desktop)[0])).toBeLessThan(1);
  });
});

describe("members", () => {
  it("spreads the members other than the hub at distinct angles", () => {
    for (const size of [2, 3, 4, 5, 6, 9]) {
      const angles = memberAngles(size);
      expect(angles).toHaveLength(size - 1);
      const sorted = [...angles].map((a) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(0.5);
    }
  });

  it("puts the hub at the centre and the others on the cluster radius", () => {
    const c: [number, number, number] = [3, 1, -2];
    const hub = memberPosition(c, 0, 4, 0, { phase: 0, drift: 0, vertical: false });
    expect(hub[0]).toBeCloseTo(3);
    expect(hub[2]).toBeCloseTo(-2);
    const m = memberPosition(c, 2, 4, 0, { phase: 0, drift: 0, vertical: false });
    expect(Math.hypot(m[0] - 3, m[2] + 2)).toBeCloseTo(clusterRadius(4, false), 5);
  });

  it("does not move while the drift is 0, whatever the clock says", () => {
    const c: [number, number, number] = [0, 0, 0];
    const a = memberPosition(c, 1, 3, 1, { phase: 10, drift: 0, vertical: false });
    const b = memberPosition(c, 1, 3, 1, { phase: 90, drift: 0, vertical: false });
    expect(a).toEqual(b);
  });

  it("bobs each member on its own phase", () => {
    const c: [number, number, number] = [0, 0, 0];
    const ys = [1, 2, 3, 4].map((i) => memberPosition(c, i, 5, 0, { phase: 2, drift: 1, vertical: false })[1] + Math.sin(memberAngles(5)[i - 1] + 2 * 0.022) * 0.9);
    expect(new Set(ys.map((y) => y.toFixed(3))).size).toBe(4);
  });
});

describe("curve", () => {
  it("starts at a, ends at b, and lifts 0.8 in the middle", () => {
    const a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [4, 2, 2];
    expect(curve(a, b, 0)).toEqual([0, 0, 0]);
    expect(curve(a, b, 1)[0]).toBeCloseTo(4);
    expect(curve(a, b, 1)[1]).toBeCloseTo(2);
    expect(curve(a, b, 0.5)[1]).toBeCloseTo(1 + 0.8);
  });
});
