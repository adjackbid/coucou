// 成本分析: one team's cost taken apart, to see why it is high or low and
// what would bring it down. Charts drawn here from the usage records — the
// cost piling up member by member, the context each call carried, what kind
// of token the money went on — the members' work beside their spend, and
// findings worked out from those numbers. Agent Center can then be asked
// to read the same numbers (its cost_analysis tool) and explain them.

import { tr, trf } from "../core/i18n";
import { h } from "../views/dom";
import type { Activity, Found, UsageReport, UsageRow } from "./types";

export interface AnalysisHost {
  render(): void;
  /** Formats an amount (US dollars) the way the page shows money. */
  money(usd: number): string;
  tokens(n: number): string;
  /** "近 30 天" / "the last 30 days", "2026-10-01 ~ 2026-10-04". */
  periodLabel(): string;
  /** The person asks Agent Center; resolves to its words, or why not. */
  consult(text: string): Promise<string>;
  openSecretary(): void;
}

const PALETTE = ["#3b9eff", "#a78bfa", "#34d399", "#f5a524", "#f472b6", "#22d3ee"];
const KIND_COLORS = { input: "#3b9eff", output: "#f5a524", cacheRead: "#34d399", cacheWrite: "#a78bfa" };
const kindNames = (): Record<keyof typeof KIND_COLORS, string> => ({ input: tr("輸入(未快取)", "Input (not cached)"), output: tr("輸出", "Output"), cacheRead: tr("快取讀取", "Cache reads"), cacheWrite: tr("快取寫入", "Cache writes") });

let picked = "";
let asking = false;
let answer: { team: string; text: string } | null = null;

interface Member {
  id: string;
  name: string;
  rows: UsageRow[];
  usd: number;
  tokens: number;
  models: string[];
  /** Cost by kind of token, US dollars. */
  kinds: Record<keyof typeof KIND_COLORS, number>;
  did: Activity | undefined;
  color: string;
}

const tokensOf = (r: UsageRow) => r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
const contextOf = (r: UsageRow) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;

function priceOf(report: UsageReport, model: string): Found | null {
  return report.models.find((m) => m.model === model)?.found ?? null;
}

function members(report: UsageReport, rows: UsageRow[], team: string): Member[] {
  const ids = [...new Set(rows.map((r) => r.member))];
  const out = ids.map((id) => {
    const mine = rows.filter((r) => r.member === id);
    const kinds = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const r of mine) {
      const p = priceOf(report, r.usage.model)?.price;
      if (!p) continue;
      kinds.input += (r.usage.input * p.input) / 1e6;
      kinds.output += (r.usage.output * p.output) / 1e6;
      kinds.cacheRead += (r.usage.cacheRead * p.cacheRead) / 1e6;
      kinds.cacheWrite += (r.usage.cacheWrite * p.cacheWrite) / 1e6;
    }
    return {
      id,
      name: mine[mine.length - 1]?.memberName || id,
      rows: mine,
      usd: mine.reduce((a, r) => a + (r.estimatedUsd ?? 0), 0),
      tokens: mine.reduce((a, r) => a + tokensOf(r), 0),
      models: [...new Set(mine.map((r) => r.usage.model))],
      kinds,
      did: report.activity.find((a) => a.team === team && a.member === id),
      color: "",
    };
  });
  out.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  out.forEach((m, i) => (m.color = PALETTE[i % PALETTE.length]));
  return out;
}

// ── Charts (SVG, drawn from the numbers) ─────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function clock(t: number, span: number): string {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return span <= 36 * 3_600_000 ? hm : `${d.getMonth() + 1}/${d.getDate()}${span <= 7 * 86_400_000 ? ` ${hm}` : ""}`;
}

interface Series {
  label: string;
  color: string;
  points: [number, number][];
  /** Drawn as dots (each call) rather than a line. */
  dots?: boolean;
  width?: number;
}

/** A line (or dot) chart over time, with its axes. */
function chart(series: Series[], fmt: (v: number) => string, emptyText: string): HTMLElement {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return h("p", { class: "dim", text: emptyText });
  const W = 860, H = 240, L = 64, R = 12, T = 14, B = 28;
  let t0 = Math.min(...all.map((p) => p[0]));
  let t1 = Math.max(...all.map((p) => p[0]));
  if (t1 === t0) {
    t0 -= 30 * 60_000;
    t1 += 30 * 60_000;
  }
  const top = Math.max(...all.map((p) => p[1])) * 1.08 || 1;
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => `<line x1="${L}" x2="${W - R}" y1="${y(top * f)}" y2="${y(top * f)}" class="grid"/><text x="${L - 8}" y="${y(top * f) + 4}" text-anchor="end">${esc(fmt(top * f))}</text>`)
    .join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const t = t0 + (t1 - t0) * f;
    return `<text x="${x(t)}" y="${H - 8}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${esc(clock(t, t1 - t0))}</text>`;
  }).join("");
  const body = series
    .map((s) => {
      if (s.dots) {
        return s.points.map((p) => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="3" fill="${s.color}" opacity="0.75"><title>${esc(`${s.label} · ${clock(p[0], 0)} · ${fmt(p[1])}`)}</title></circle>`).join("");
      }
      const d = s.points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
      const last = s.points[s.points.length - 1];
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" stroke-linejoin="round"/>${last ? `<circle cx="${x(last[0])}" cy="${y(last[1])}" r="3.5" fill="${s.color}"><title>${esc(`${s.label} · ${fmt(last[1])}`)}</title></circle>` : ""}`;
    })
    .join("");
  const svg = h("div", { class: "ca-chart" });
  svg.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${ticks}${body}</svg>`;
  return h(
    "div",
    {},
    svg,
    // One entry a name: a member's calls and its trend share one.
    h("div", { class: "cost-legend" }, ...[...new Map(series.filter((s) => s.points.length).map((s) => [s.label, s.color])).entries()].map(([label, color]) => h("span", {}, h("i", { style: `background:${color}` }), label))),
  );
}

/** Cost piling up: the team's, and each member's. */
function cumulative(ms: Member[], rows: UsageRow[], host: AnalysisHost): HTMLElement {
  const pile = (list: UsageRow[]) => {
    let sum = 0;
    return list.filter((r) => r.estimatedUsd != null).map((r) => [r.at, (sum += r.estimatedUsd!)] as [number, number]);
  };
  // The whole team in the page's own ink: white on dark glass, near-black on light.
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "#f5f6f8";
  const series: Series[] = [{ label: tr("全隊", "Whole team"), color: ink, points: pile(rows), width: 3 }, ...ms.slice(0, 6).map((m) => ({ label: m.name, color: m.color, points: pile(m.rows) }))];
  return chart(series, host.money, tr("這段期間沒有可以估價的用量。", "No usage that can be priced in this period."));
}

/** What each call carried in: a context that keeps growing costs more every turn. */
function context(ms: Member[], host: AnalysisHost): HTMLElement {
  const series: Series[] = [];
  for (const m of ms.slice(0, 6)) {
    series.push({ label: m.name, color: m.color, points: m.rows.map((r) => [r.at, contextOf(r)]), dots: true });
    // A running average of the last five calls, to show the trend.
    const avg: [number, number][] = m.rows.map((r, i) => {
      const w = m.rows.slice(Math.max(0, i - 4), i + 1);
      return [r.at, w.reduce((a, x) => a + contextOf(x), 0) / w.length];
    });
    if (avg.length > 2) series.push({ label: m.name, color: m.color, points: avg, width: 2 });
  }
  return chart(series, host.tokens, tr("沒有用量紀錄。", "No usage recorded."));
}

/** What kind of token the money went on, member by member. */
function composition(ms: Member[], host: AnalysisHost): HTMLElement {
  const most = Math.max(...ms.map((m) => Object.values(m.kinds).reduce((a, b) => a + b, 0)), 0) || 1;
  const keys = Object.keys(KIND_COLORS) as (keyof typeof KIND_COLORS)[];
  const names = kindNames();
  return h(
    "div",
    { class: "ca-bars" },
    ...ms.map((m) => {
      const total = keys.reduce((a, k) => a + m.kinds[k], 0);
      return h(
        "div",
        { class: "ca-bar-row" },
        h("span", { class: "ca-bar-name" }, h("i", { style: `background:${m.color}` }), m.name),
        h(
          "span",
          { class: "ca-bar", style: `width:${Math.max((total / most) * 100, 0.5)}%` },
          ...keys.filter((k) => m.kinds[k] > 0).map((k) => h("i", { style: `flex:${m.kinds[k]} 0 0;background:${KIND_COLORS[k]}`, title: trf("{kind} {usd}({pct}%)", "{kind} {usd} ({pct}%)", { kind: names[k], usd: host.money(m.kinds[k]), pct: Math.round((m.kinds[k] / (total || 1)) * 100) }) })),
        ),
        h("em", { text: host.money(total) }),
      );
    }),
    h("div", { class: "cost-legend" }, ...keys.map((k) => h("span", {}, h("i", { style: `background:${KIND_COLORS[k]}` }), names[k]))),
  );
}

// ── Findings ─────────────────────────────────────────────────────────────────

interface Finding {
  tone: "bad" | "warn" | "good";
  title: string;
  advice: string;
}

function findings(report: UsageReport, ms: Member[], rows: UsageRow[], host: AnalysisHost): Finding[] {
  const out: Finding[] = [];
  const usd = ms.reduce((a, m) => a + m.usd, 0);
  if (!usd) return out;
  const kinds = ms.reduce((a, m) => ({ input: a.input + m.kinds.input, output: a.output + m.kinds.output, cacheRead: a.cacheRead + m.kinds.cacheRead, cacheWrite: a.cacheWrite + m.kinds.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const priced = kinds.input + kinds.output + kinds.cacheRead + kinds.cacheWrite || 1;

  // One member, most of the money.
  const top = ms[0];
  if (top && ms.length > 1 && top.usd / usd > 0.5) {
    const price = (m: Member) => Math.max(...m.models.map((x) => priceOf(report, x)?.price.output ?? 0));
    const cheapest = ms.filter((m) => price(m) > 0).sort((a, b) => price(a) - price(b))[0];
    const ratio = cheapest && price(cheapest) > 0 ? price(top) / price(cheapest) : 1;
    out.push({
      tone: "bad",
      title: trf("成本集中在 {name}:{pct}%({usd})", "Most of the cost is {name}: {pct}% ({usd})", { name: top.name, pct: Math.round((top.usd / usd) * 100), usd: host.money(top.usd) }),
      advice:
        ratio >= 3 && cheapest
          ? trf(
              "它用的 {models} 輸出單價是 {cheapest} 的 {ratio} 倍。只把需要強模型的工作(規劃、驗收、只有它做得到的事)留給它,寫文件、整理報告這類交給便宜的模型。",
              "Its {models} costs {ratio} times as much per output token as {cheapest}'s. Keep only the work that needs a strong model for it (planning, reviews, what only it can do) and give writing docs or tidying reports to a cheaper model.",
              { models: top.models.join(tr("、", ", ")), cheapest: cheapest.name, ratio: ratio.toFixed(1) },
            )
          : trf(
              "{turns} 個回合、{reviews} 次驗收都在它身上。可以把部分工作拆給其他成員,或請它回覆精簡一點。",
              "{turns} turns and {reviews} reviews are all on it. Split some of the work off to other members, or ask it for shorter replies.",
              { turns: top.did?.turns ?? 0, reviews: top.did?.reviews ?? 0 },
            ),
    });
  }
  // The money went on output.
  if (kinds.output / priced > 0.4) {
    out.push({ tone: "warn", title: trf("輸出佔成本 {pct}%", "Output is {pct}% of the cost", { pct: Math.round((kinds.output / priced) * 100) }), advice: tr("輸出單價通常是輸入的 4–5 倍。請成員回覆、報告寫精簡,不要整段貼回程式碼;長文件改成交付檔案、訊息只寫摘要。", "Output usually costs 4–5 times as much as input. Ask members for short replies and reports, not whole blocks of code pasted back; deliver long documents as files and keep messages to a summary.") });
  }
  // Input not read from the cache.
  const inputSide = rows.reduce((a, r) => a + contextOf(r), 0);
  const cached = rows.reduce((a, r) => a + r.usage.cacheRead, 0);
  const hit = inputSide ? cached / inputSide : 0;
  if (kinds.input / priced > 0.4 && hit < 0.5) {
    out.push({ tone: "warn", title: trf("輸入佔成本 {pct}%,快取命中只有 {hit}%", "Input is {pct}% of the cost, with only {hit}% from the cache", { pct: Math.round((kinds.input / priced) * 100), hit: Math.round(hit * 100) }), advice: tr("同樣的內容每次都重新計費。讓成員在同一個 session 裡連續工作(Agent Center 會沿用),避免一直換模型或重開;端點若支援提示快取,確認有開。", "The same content is billed again every time. Let members keep working in one session (Agent Center keeps it), avoid switching models or restarting; if the endpoint supports prompt caching, make sure it is on.") });
  } else if (hit >= 0.8) {
    const saved = rows.reduce((a, r) => {
      const p = priceOf(report, r.usage.model)?.price;
      return p ? a + (r.usage.cacheRead * Math.max(0, p.input - p.cacheRead)) / 1e6 : a;
    }, 0);
    out.push({ tone: "good", title: trf("快取命中 {hit}%,省下約 {usd}", "{hit}% from the cache, about {usd} saved", { hit: Math.round(hit * 100), usd: host.money(saved) }), advice: tr("重複的內容大多從快取讀取,這部分已經很省。", "Repeated content is mostly read from the cache: this part is already cheap.") });
  }
  // A context that keeps growing.
  for (const m of ms) {
    if (m.rows.length < 6) continue;
    const third = Math.max(1, Math.floor(m.rows.length / 3));
    const avg = (s: UsageRow[]) => s.reduce((a, r) => a + contextOf(r), 0) / s.length;
    const early = avg(m.rows.slice(0, third));
    const late = avg(m.rows.slice(-third));
    if (early > 0 && late / early >= 2) {
      out.push({ tone: "warn", title: trf("{name} 每次呼叫帶的內容越來越大:{early} → {late}", "{name} carries more into every call: {early} → {late}", { name: m.name, early: host.tokens(early), late: host.tokens(late) }), advice: tr("對話越長,每一輪都要重送更多內容。把大任務拆成幾個小任務,做完一段就交付,下一段讓它重新開始(新任務會帶新的工作說明)。", "The longer the conversation, the more is sent again every turn. Split big tasks into small ones, deliver each part when done, and let the next part start fresh (a new task comes with a new brief).") });
    }
  }
  // Work done twice.
  const rejected = ms.reduce((a, m) => a + (m.did?.rejected ?? 0), 0);
  const accepted = ms.reduce((a, m) => a + (m.did?.accepted ?? 0), 0);
  if (rejected > 0) {
    const who = ms.filter((m) => (m.did?.rejected ?? 0) > 0).map((m) => trf("{name} {n} 次", "{name} {n}×", { name: m.name, n: m.did!.rejected })).join(tr("、", ", "));
    out.push({ tone: "warn", title: trf("退回重做 {n} 次({who})", "Sent back for rework {n} times ({who})", { n: rejected, who }), advice: tr("每次退回都是再跑一輪。開任務時把驗收標準寫清楚(要哪些檔案、要通過哪些測試),或請成員交付前先自己對一次標準。", "Every send-back is another round. Write clear acceptance criteria when a task starts (which files, which tests must pass), or ask members to check against them before delivering.") });
  }
  const failed = ms.reduce((a, m) => a + (m.did?.failedTurns ?? 0), 0);
  if (failed > 0) {
    out.push({ tone: "warn", title: failed === 1 ? tr("1 個回合執行失敗", "1 turn failed") : trf("{n} 個回合執行失敗", "{n} turns failed", { n: failed }), advice: tr("失敗的回合也會花 token。到看板看是哪位成員、什麼錯誤(端點、權限或模型名稱)。", "Failed turns cost tokens too. Check the board for which member and what error (endpoint, permission or model name).") });
  }
  if (accepted > 0) {
    out.push({ tone: "good", title: trf("每個驗收的任務平均 {usd}", "{usd} per accepted task on average", { usd: host.money(usd / accepted) }), advice: accepted === 1 ? tr("1 個任務已驗收。拿這個數字比較不同團隊、不同模型組合的效率。", "1 task accepted. Use this number to compare teams and model mixes.") : trf("{n} 個任務已驗收。拿這個數字比較不同團隊、不同模型組合的效率。", "{n} tasks accepted. Use this number to compare teams and model mixes.", { n: accepted }) });
  }
  const unpriced = rows.filter((r) => r.estimatedUsd == null).reduce((a, r) => a + tokensOf(r), 0);
  if (unpriced > 0) {
    out.push({ tone: "warn", title: trf("有 {n} tokens 沒有價格", "{n} tokens have no price", { n: host.tokens(unpriced) }), advice: tr("這部分沒算進成本。到「總覽」下方的價格表補上。", "They are not in the cost. Add the prices in the price table under Overview.") });
  }
  return out;
}

// ── The view ─────────────────────────────────────────────────────────────────

export function analysisView(report: UsageReport, host: AnalysisHost): HTMLElement {
  const teams = [...new Set(report.rows.map((r) => r.team))]
    .map((id) => {
      const rows = report.rows.filter((r) => r.team === id);
      return { id, name: rows[rows.length - 1]?.teamName || id, usd: rows.reduce((a, r) => a + (r.estimatedUsd ?? 0), 0) };
    })
    .sort((a, b) => b.usd - a.usd);
  if (!teams.length) return h("section", { class: "panel cost-empty" }, h("p", { class: "dim", text: tr("這段期間沒有團隊用量,換一個期間看看。", "No team usage in this period: try another period.") }));
  if (!teams.some((t) => t.id === picked)) picked = teams[0].id;
  const team = teams.find((t) => t.id === picked)!;
  const rows = report.rows.filter((r) => r.team === picked);
  const ms = members(report, rows, picked);
  const usd = ms.reduce((a, m) => a + m.usd, 0);
  const turns = ms.reduce((a, m) => a + (m.did?.turns ?? 0), 0);
  const accepted = ms.reduce((a, m) => a + (m.did?.accepted ?? 0), 0);
  const inputSide = rows.reduce((a, r) => a + contextOf(r), 0);
  const hit = inputSide ? rows.reduce((a, r) => a + r.usage.cacheRead, 0) / inputSide : 0;
  const tile = (title: string, big: string, sub: string) => h("div", { class: "kpi" }, h("span", { class: "kpi-title", text: title }), h("b", { class: "kpi-big", text: big }), h("span", { class: "kpi-sub", text: sub }));

  const ask = async () => {
    asking = true;
    answer = null;
    host.render();
    // Sent as the person's own question, so in their language: Agent Center answers in it.
    const text = await host.consult(
      trf(
        "幫我分析「{team}」在{period}的成本:為什麼這麼高(或這麼低)?怎麼優化、改善?請用具體數字說明,並給可以直接照做的建議。",
        "Analyse the cost of “{team}” over {period}: why is it this high (or low), and how can it be brought down? Use concrete numbers and give advice I can act on right away.",
        { team: team.name, period: host.periodLabel() },
      ),
    );
    asking = false;
    answer = { team: picked, text };
    host.render();
  };

  const found = findings(report, ms, rows, host);
  return h(
    "div",
    { class: "ca" },
    h(
      "section",
      { class: "ca-teams" },
      ...teams.map((t) =>
        h("button", { class: `chip pick${t.id === picked ? " on" : ""}`, type: "button", onClick: () => ((picked = t.id), (answer = null), host.render()) }, `${t.name} · ${host.money(t.usd)}`),
      ),
    ),
    h(
      "section",
      { class: "kpis" },
      tile(tr("預估成本", "Estimated cost"), host.money(usd), trf("{tokens} tokens · {n} 次呼叫", "{tokens} tokens · {n} calls", { tokens: host.tokens(rows.reduce((a, r) => a + tokensOf(r), 0)), n: rows.length })),
      tile(tr("每個驗收任務", "Per accepted task"), accepted ? host.money(usd / accepted) : "—", accepted === 1 ? tr("1 個任務驗收通過", "1 task accepted") : accepted ? trf("{n} 個任務驗收通過", "{n} tasks accepted", { n: accepted }) :
 tr("這段期間還沒有驗收的任務", "No task accepted in this period yet")),
      tile(tr("每回合", "Per turn"), turns ? host.money(usd / turns) : "—", trf("{n} 個回合", "{n} turns", { n: turns })),
      tile(tr("快取命中", "Cache hits"), `${Math.round(hit * 100)}%`, tr("輸入中從快取讀取的比例", "Share of the input read from the cache")),
    ),
    h(
      "section",
      { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", { text: tr("診斷與建議", "Findings and advice") }), h("span", { class: "dim", text: tr("依這段期間的數字算出來的", "Worked out from this period's numbers") })),
      found.length ? h("ul", { class: "ca-findings" }, ...found.map((f) => h("li", { class: f.tone }, h("b", { text: f.title }), h("span", { text: f.advice })))) : h("p", { class: "dim", text: tr("沒有看到明顯的問題。", "Nothing stands out.") }),
      h(
        "div",
        { class: "ca-ask" },
        h("button", { class: "btn primary", type: "button", disabled: asking, onClick: () => void ask() }, asking ? tr("Agent Center 分析中…", "Agent Center is analysing…") : tr("請 Agent Center 分析原因與優化方式", "Ask Agent Center why, and how to cut it")),
        h("span", { class: "hint", text: tr("Agent Center 會讀同一份數字(成員、模型、回合、退件、快取),用你的聊天模型寫成說明與建議。", "Agent Center reads the same numbers (members, models, turns, send-backs, cache) and explains them with advice, using your chat model.") }),
      ),
      answer && answer.team === picked
        ? h(
            "div",
            { class: "ca-answer" },
            wordsOf(answer.text),
            h("button", { class: "link", type: "button", onClick: () => host.openSecretary() }, tr("到 Agent Center 頁繼續問 →", "Keep asking on Agent Center's page →")),
          )
        : null,
    ),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: tr("累積成本", "Cost over time") }), h("span", { class: "dim", text: tr("曲線越陡,那段時間花得越快", "The steeper the curve, the faster the money went") })), cumulative(ms, rows, host)),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: tr("每次呼叫帶的內容", "What each call carries") }), h("span", { class: "dim", text: tr("點是每一次呼叫的輸入量(含快取),線是趨勢;一路往上代表對話越滾越大", "Dots are each call's input (cache included), lines the trend; climbing all the way means the conversation keeps growing") })), context(ms, host)),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: tr("成本花在哪種 token", "Which tokens the cost went on") }), h("span", { class: "dim", text: tr("滑過色塊看金額", "Hover a block for the amount") })), composition(ms, host)),
    h(
      "section",
      { class: "panel cost-tree" },
      h("div", { class: "panel-head" }, h("h2", { text: tr("成員效率", "Member efficiency") })),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ...[tr("成員", "Member"), tr("模型", "Model"), tr("成本", "Cost"), tr("占比", "Share"), tr("回合", "Turns"), tr("每回合", "Per turn"), tr("交付", "Delivered"), tr("退回", "Sent back"), tr("驗收", "Accepted")].map((t, i) => h("th", { class: i > 1 ? "num" : "", text: t })))),
          h(
            "tbody",
            {},
            ...ms.map((m) =>
              h(
                "tr",
                {},
                h("td", { class: "name" }, h("span", { class: "name-in" }, h("i", { class: "ca-dot", style: `background:${m.color}` }), h("span", { class: "label", text: m.name }), m.did?.leader ? h("span", { class: "chip", text: "Leader" }) : null)),
                h("td", { class: "mono", text: m.models.join(tr("、", ", ")) }),

                h("td", { class: "num strong", text: host.money(m.usd) }),
                h("td", { class: "num", text: `${usd ? Math.round((m.usd / usd) * 100) : 0}%` }),
                h("td", { class: "num", text: String(m.did?.turns ?? 0) }),
                h("td", { class: "num", text: m.did?.turns ? host.money(m.usd / m.did.turns) : "—" }),
                h("td", { class: "num", text: String(m.did?.delivered ?? 0) }),
                h("td", { class: `num${(m.did?.rejected ?? 0) > 0 ? " warn-text" : ""}`, text: String(m.did?.rejected ?? 0) }),
                h("td", { class: "num", text: String(m.did?.accepted ?? 0) }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Agent Center's words: paragraphs, lists, headings and **bold**. */
function wordsOf(text: string): HTMLElement {
  const box = h("div", { class: "sec-words" });
  let list: HTMLElement | null = null;
  const inline = (el: HTMLElement, t: string) => {
    for (const part of t.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (part.startsWith("**") && part.endsWith("**")) el.append(h("b", { text: part.slice(2, -2) }));
      else if (part.startsWith("`") && part.endsWith("`")) el.append(h("code", { text: part.slice(1, -1) }));
      else el.append(part);
    }
    return el;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      list = null;
      box.append(inline(h("h4"), heading[1]));
    } else if (item) {
      if (!list) box.append((list = h("ul")));
      list.append(inline(h("li"), item[1]));
    } else if (line.trim()) {
      list = null;
      box.append(inline(h("p"), line));
    } else list = null;
  }
  return box;
}
