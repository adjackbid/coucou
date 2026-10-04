// How the company floor is laid out: a shape that fits the frame, big
// offices side by side when they can be.

import { describe, expect, it } from "vitest";
import { floorColumns } from "./floor";

describe("floorColumns", () => {
  it("lays small rooms out as a near square, a little wide", () => {
    expect(floorColumns([1])).toBe(1);
    expect(floorColumns([1, 1, 1, 1])).toBe(2);
    expect(floorColumns([1, 1, 1, 1, 1, 1])).toBe(3);
  });

  it("puts two large offices side by side", () => {
    expect(floorColumns([2, 2])).toBe(4);
  });

  it("keeps a large office with its small neighbours beside it", () => {
    expect(floorColumns([1, 2, 1])).toBe(3);
  });
});
