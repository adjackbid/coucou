import { describe, expect, it } from "vitest";
import { imagePaths, isImage } from "./images";

describe("the pictures a text names", () => {
  it("finds absolute, relative and file:/// paths, each once", () => {
    const text = [
      "已完成 `D:\\JK-photos\\01_photoreal_school_gate.png`,另見 out/02.jpg。",
      "- **成品路徑**:[03_magazine_illust_konbini.png](file:///D:/JK-photos/03_magazine_illust_konbini.png)",
      "再讀一次 D:\\JK-photos\\01_photoreal_school_gate.png",
    ].join("\n");
    expect(imagePaths(text)).toEqual(["D:\\JK-photos\\01_photoreal_school_gate.png", "out/02.jpg", "D:/JK-photos/03_magazine_illust_konbini.png"]);
  });

  it("reads a path stuck to the words before it and leaves web addresses and other files alone", () => {
    expect(imagePaths("路徑:D:\\out\\a.webp。")).toEqual(["D:\\out\\a.webp"]);
    expect(imagePaths("https://example.com/a.png README.md D:\\x\\notes.txt")).toEqual([]);
    expect(imagePaths("Copy-Item -Path \"C:\\Users\\me\\.gemini\\brain\\x.PNG\" -Destination 'D:\\JK\\y.jpeg'")).toEqual(["C:\\Users\\me\\.gemini\\brain\\x.PNG", "D:\\JK\\y.jpeg"]);
  });

  it("keeps to a handful", () => {
    const many = Array.from({ length: 10 }, (_, i) => `D:\\p\\${i}.png`).join(" ");
    expect(imagePaths(many, 3)).toHaveLength(3);
    expect(isImage("a.GIF") && !isImage("a.svg")).toBe(true);
  });
});
