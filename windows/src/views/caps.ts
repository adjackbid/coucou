// What an agent can do, in a row of small marks: how dear it is ($ … $$$$),
// how much it reads, and whether it sees images, thinks, makes images
// (caps.rs). Shown on Agent Pool's cards and form and on Settings → Agent
// Provider. Asked of Rust once per agent and model; the row fills in when
// the answer comes, wherever it is on screen.

import { Bridge, IS_TAURI } from "../core/bridge";
import { tr, trf } from "../core/i18n";
import type { AgentCaps, AgentProfile } from "../core/state";
import { h } from "./dom";

const known = new Map<string, AgentCaps>();
const waiting = new Map<string, { profile: AgentProfile; slots: HTMLElement[] }>();
let queued = false;

/** What decides an agent's abilities: its kind, its model, the person's tick. */
function keyOf(p: AgentProfile): string {
  return [p.id, p.protocol ?? "acp", p.command, p.model ?? "", p.env?.COPILOT_MODEL ?? "", p.imageGen ? 1 : 0, p.web ?? "", p.code ?? ""].join("|");
}

/** In a plain browser: a guess from the model's name, to see the row. */
function guess(p: AgentProfile): AgentCaps {
  const m = (p.model || p.env?.COPILOT_MODEL || "").toLowerCase();
  const claude = p.protocol === "claude" || m.includes("claude") || m === "opus" || m === "sonnet";
  const big = /opus|sol|pro|argon/.test(m);
  return {
    model: m,
    vision: claude || /gpt|gemini|deepseek/.test(m) ? true : undefined,
    thinking: claude || /gpt|gemini|deepseek|qwen/.test(m) ? true : undefined,
    context: m.includes("deepseek") || m.includes("gemini") ? 1_000_000 : claude ? 200_000 : undefined,
    tier: m ? (big ? 4 : /flash|luna|haiku|mini/.test(m) ? 1 : 2) : undefined,
    price: m ? (big ? { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } : { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 }) : undefined,
    priceFrom: m ? "list" : "",
    image: !!p.imageGen,
    web: p.web ?? p.protocol !== "n8n",
    code: p.code ?? p.protocol !== "n8n",
  };
}

function flush() {
  queued = false;
  const batch = [...waiting.entries()];
  waiting.clear();
  const ask = batch.map(([key, w]) => ({ ...w.profile, id: key }));
  const answer = IS_TAURI ? Bridge.agentCaps(ask) : Promise.resolve(Object.fromEntries(ask.map((p) => [p.id, guess(p)])));
  void answer.then((got) => {
    for (const [key, w] of batch) {
      const caps = got?.[key];
      if (!caps) continue;
      known.set(key, caps);
      for (const slot of w.slots) if (slot.isConnected) fill(slot, caps);
    }
  });
}

/** "1M", "200K". */
function size(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

/** "$2", "$0.03": a price per million tokens, as short as it stays exact. */
const usd = (v: number) => `$${+v.toFixed(3)}`;

/** The model's price beside its tier: "輸入 $2 · 輸出 $10 /M", with ≈ when it is the family's price, not this version's. */
function priceMark(c: AgentCaps): HTMLElement | null {
  if (!c.price) return null;
  const about = c.priceFrom === "alias" || c.priceFrom === "family";
  const from =
    c.priceFrom === "override" ? tr("你自訂的價格", "your own price")
    : c.priceFrom === "proxy" ? tr("代理端點給的價格", "the agent endpoint's price")
    : about ? tr("價目表沒有這個版本,先用同系列最新版的價格(約略)", "The list lacks this version, so this is the family's newest price (about)")
    : tr("公開價目表", "the public price list");
  return h("span", {
    class: `caps-price${about ? " about" : ""}`,
    title: trf("每百萬 tokens:輸入 {i}、輸出 {o}、快取讀取 {r}(美元;{from})。團隊的費用就是用這個價格乘上它用掉的 tokens。", "Per million tokens: input {i}, output {o}, cache read {r} (US$; {from}). A team's cost is this price times the tokens it used.", { i: usd(c.price.input), o: usd(c.price.output), r: usd(c.price.cacheRead), from }),
    text: `${about ? "≈ " : ""}${trf("輸入 {i} · 輸出 {o} /M", "{i} in · {o} out /M", { i: usd(c.price.input), o: usd(c.price.output) })}`,
  });
}

function fill(slot: HTMLElement, c: AgentCaps) {
  // Settings → Agent Provider shows only what the price list says; the rest are its own chips.
  const auto = slot.classList.contains("auto");
  const parts: (HTMLElement | null)[] = [
    c.tier ? h("span", { class: "caps-tier", title: tr("價位:依模型每百萬 token 的價格分成四級", "Price: four steps by the model's price per million tokens") }, h("b", { text: "$".repeat(c.tier) }), h("span", { text: "$".repeat(4 - c.tier) })) : null,
    priceMark(c),
    !c.price && c.model ? h("span", { class: "caps-pill warn", title: tr("價目表沒有這個模型,它的費用會算不出來。到「成本與用量」更新公開價目或自訂價格;模型名稱請寫完整(例如 claude-opus-5-5,不要只寫 opus)。", "The price list lacks this model, so its cost can't be worked out. Update the public list or set a price in Cost & usage, and write the model's full name (claude-opus-5-5, not just opus)."), text: tr("無價格", "no price") }) : null,
    c.context ? h("span", { class: "caps-context", text: trf("{n} 上下文", "{n} context", { n: size(c.context) }) }) : null,
    c.vision ? h("span", { class: "caps-pill", title: tr("看得懂圖片", "Understands images"), text: tr("看圖", "vision") }) : null,
    c.thinking ? h("span", { class: "caps-pill", title: tr("回答前會先思考(可以調 Effort)", "Thinks before answering (Effort applies)"), text: tr("思考", "thinking") }) : null,
    c.image && !auto ? h("span", { class: "caps-pill image", title: tr("會產生圖片(在 設定 → Agent Provider 勾選的)", "Makes images (ticked in Settings → Agent Provider)"), text: tr("生圖", "image gen") }) : null,
    c.web && !auto ? h("span", { class: "caps-pill", title: tr("能用自己的工具上網查資料、讀網頁", "Searches and reads the web with its own tools"), text: tr("上網", "web") }) : null,
    c.code && !auto ? h("span", { class: "caps-pill", title: tr("能在自己的機器上執行指令和程式", "Runs commands and code on its machine"), text: tr("Code", "code") }) : null,
  ];
  const shown = parts.filter((x): x is HTMLElement => !!x);
  slot.replaceChildren(...shown);
  slot.classList.toggle("empty", !shown.length);
  slot.classList.toggle("guessed", !!c.guessed);
  slot.title = shown.length
    ? c.guessed
      ? tr("部分能力是依模型名稱推測的;到「成本與用量」下載新的價格表後會更準。", "Some of this is guessed from the model's name; downloading the price list again in Cost & usage makes it exact.")
      : ""
    : tr("價目表沒寫這個模型能做什麼;到「成本與用量」更新價格表後會補上。", "The price list says nothing about what this model can do; updating it in Cost & usage fills this in.");
}

/** A row of the agent's abilities: filled now if known, else when Rust answers. `auto` shows only what the price list says. */
export function capsView(profile: AgentProfile, opts: { auto?: boolean } = {}): HTMLElement {
  const slot = h("div", { class: `caps-row empty${opts.auto ? " auto" : ""}` });
  const key = keyOf(profile);
  const had = known.get(key);
  if (had) {
    fill(slot, had);
    return slot;
  }
  const w = waiting.get(key) ?? { profile, slots: [] };
  w.slots.push(slot);
  waiting.set(key, w);
  if (!queued) {
    queued = true;
    queueMicrotask(flush);
  }
  return slot;
}

/** Abilities change when the price list is fetched again or a tick changes: ask afresh. */
export function forgetCaps() {
  known.clear();
}
