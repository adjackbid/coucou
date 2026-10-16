import { describe, expect, it } from "vitest";
import { guessChoices } from "./secretary";

describe("a multiple-choice question in words", () => {
  it("becomes options when a question meets a short list at the end", () => {
    expect(guessChoices("兩種組合都可以。\n你要哪一種?\n1. 省錢組合\n2. **品質組合**")).toEqual({ question: "你要哪一種?", options: ["省錢組合", "品質組合"], multiple: false });
    expect(guessChoices("Pick one:\n- A cheaper team\n- A stronger team\nTell me which.")?.options).toEqual(["A cheaper team", "A stronger team"]);
    expect(guessChoices("要做哪些頁面?(可複選)\nA. 首頁\nB. 產品頁\nC. 聯絡我們")?.multiple).toBe(true);
  });

  it("leaves a plain list or a long answer alone", () => {
    expect(guessChoices("目前有 2 個團隊:\n- 購物網站團隊:執行中\n- 文件翻譯團隊:未啟動")).toBeUndefined();
    expect(guessChoices("你要哪一種?\n- 只有一個")).toBeUndefined();
    expect(guessChoices("各團隊現在狀況如何?")).toBeUndefined();
  });
});
