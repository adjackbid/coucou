import { describe, expect, it } from "vitest";
import { dropTarget, kbSaid, kindHint, sizeText, usageLine } from "./knowledge";
import type { KnowledgeDoc, KnowledgeView } from "./types";

const doc = (over: Partial<KnowledgeDoc>): KnowledgeDoc => ({
  id: "k1",
  name: "a.md",
  kind: "text",
  bytes: 1,
  visibility: "leader",
  addedAt: 0,
  source: "",
  note: "",
  missing: false,
  sourceExists: false,
  program: false,
  ...over,
});

describe("the knowledge panel's words", () => {
  it("says sizes and how full the knowledge base is", () => {
    expect(sizeText(1)).toBe("1 KB");
    expect(sizeText(18_234)).toBe("18 KB");
    expect(sizeText(3_250_000)).toBe("3.1 MB");
    const view: KnowledgeView = {
      docs: [doc({}), doc({ id: "k2" }), doc({ id: "k3" })],
      bytes: 1_258_291,
      limits: { maxDocs: 50, maxBytes: 200 * 1024 * 1024, maxText: 1, maxImage: 1, maxFile: 1 },
    };
    expect(usageLine(view)).toBe("3 份 · 1.2 MB / 200 MB");
  });

  it("says what a member gets of each kind of file", () => {
    expect(kindHint(doc({ kind: "file" }))).toContain("成員拿到檔案路徑");
    expect(kindHint(doc({ kind: "file" }))).toContain("沒有檢查是否含金鑰");
    expect(kindHint(doc({ kind: "file", name: "setup.bat", program: true }))).toContain("不會執行");
    expect(kindHint(doc({ kind: "image" }))).toBe("圖片");
  });

  it("puts the backend's refusals in the window's language", () => {
    expect(kbSaid("Error: movie.mp4 is larger than 20 MB.")).toBe("movie.mp4:超過 20 MB");
    expect(kbSaid("b.md is already in the knowledge base, as a.md.")).toBe("b.md:已經在知識庫裡了(a.md)");
    expect(kbSaid("A team keeps at most 50 documents. Remove one first.")).toBe("一個團隊最多 50 份文件,請先移除一些");
    expect(kbSaid("The knowledge base would be larger than 200 MB (it holds 199 MB).")).toBe("知識庫會超過 200 MB(目前 199 MB)");
    expect(kbSaid("The original is no longer at D:\\Docs\\a.md.")).toBe("原檔已不在 D:\\Docs\\a.md");
    expect(kbSaid("Something else entirely")).toBe("Something else entirely");
  });
});

describe("where a dropped file goes", () => {
  it("follows what the window shows", () => {
    expect(dropTarget("team", "setup")).toBe("knowledge");
    expect(dropTarget("team", "monitor")).toBe("attachment");
    expect(dropTarget("secretary", "monitor")).toBe("secretary");
    expect(dropTarget("team", "links")).toBeNull();
    expect(dropTarget("company", "setup")).toBeNull();
    expect(dropTarget("cost", "monitor")).toBeNull();
  });
});

describe("files attached to a question for the secretary", () => {
  it("are left over when no card of the answer uses them", async () => {
    const { unusedUploads } = await import("./secretary");
    const file = (id: string) => ({ id, name: `${id}.md`, kind: "text" as const, bytes: 1, keyLike: null, force: false });
    const card = (uses?: string[]) => ({ id: "P-1", kind: "team" as const, title: "", lines: [], confirm: "", state: "open" as const, outcome: "", uses });
    expect(unusedUploads([file("u1"), file("u2")], [card(["u1"])]).map((f) => f.id)).toEqual(["u2"]);
    expect(unusedUploads([file("u1")], [card()]).map((f) => f.id)).toEqual(["u1"]);
    expect(unusedUploads([file("u1")], [card(["u1"]), card()])).toEqual([]);
    expect(unusedUploads([], [])).toEqual([]);
  });
});
