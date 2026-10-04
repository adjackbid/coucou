// 成本分析: one team's cost taken apart, to see why it is high or low and
// what would bring it down. Charts drawn here from the usage records — the
// cost piling up member by member, the context each call carried, what kind
// of token the money went on — the members' work beside their spend, and
// findings worked out from those numbers. The secretary can then be asked
// to read the same numbers (its cost_analysis tool) and explain them.

import { h } from "../views/dom";
import type { Activity, Found, UsageReport, UsageRow } from "./types";

export interface AnalysisHost {
  render(): void;
  /** Formats an amount (US dollars) the way the page shows money. */
  money(usd: number): string;
  tokens(n: number): string;
  /** "近 30 天", "2026-10-01 ~ 2026-10-04". */
  periodLabel(): string;
  /** The person asks the secretary; resolves to its words, or why not. */
  consult(text: string): Promise<string>;
  openSecretary(): void;
}

const PALETTE = ["#3b9eff", "#a78bfa", "#34d399", "#f5a524", "#f472b6", "#22d3ee"];
const KIND_COLORS = { input: "#3b9eff", output: "#f5a524", cacheRead: "#34d399", cacheWrite: "#a78bfa" };
const KIND_NAMES = { input: "輸入(未快取)", output: "輸出", cacheRead: "快取讀取", cacheWrite: "快取寫入" };

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
  const series: Series[] = [{ label: "全隊", color: "#f5f6f8", points: pile(rows), width: 3 }, ...ms.slice(0, 6).map((m) => ({ label: m.name, color: m.color, points: pile(m.rows) }))];
  return chart(series, host.money, "這段期間沒有可以估價的用量。");
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
  return chart(series, host.tokens, "沒有用量紀錄。");
}

/** What kind of token the money went on, member by member. */
function composition(ms: Member[], host: AnalysisHost): HTMLElement {
  const most = Math.max(...ms.map((m) => Object.values(m.kinds).reduce((a, b) => a + b, 0)), 0) || 1;
  const keys = Object.keys(KIND_COLORS) as (keyof typeof KIND_COLORS)[];
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
          ...keys.filter((k) => m.kinds[k] > 0).map((k) => h("i", { style: `flex:${m.kinds[k]} 0 0;background:${KIND_COLORS[k]}`, title: `${KIND_NAMES[k]} ${host.money(m.kinds[k])}(${Math.round((m.kinds[k] / (total || 1)) * 100)}%)` })),
        ),
        h("em", { text: host.money(total) }),
      );
    }),
    h("div", { class: "cost-legend" }, ...keys.map((k) => h("span", {}, h("i", { style: `background:${KIND_COLORS[k]}` }), KIND_NAMES[k]))),
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
      title: `成本集中在 ${top.name}:${Math.round((top.usd / usd) * 100)}%(${host.money(top.usd)})`,
      advice:
        ratio >= 3 && cheapest
          ? `它用的 ${top.models.join("、")} 輸出單價是 ${cheapest.name} 的 ${ratio.toFixed(1)} 倍。只把需要強模型的工作(規劃、驗收、只有它做得到的事)留給它,寫文件、整理報告這類交給便宜的模型。`
          : `${top.did?.turns ?? 0} 個回合、${top.did?.reviews ?? 0} 次驗收都在它身上。可以把部分工作拆給其他成員,或請它回覆精簡一點。`,
    });
  }
  // The money went on output.
  if (kinds.output / priced > 0.4) {
    out.push({ tone: "warn", title: `輸出佔成本 ${Math.round((kinds.output / priced) * 100)}%`, advice: "輸出單價通常是輸入的 4–5 倍。請成員回覆、報告寫精簡,不要整段貼回程式碼;長文件改成交付檔案、訊息只寫摘要。" });
  }
  // Input not read from the cache.
  const inputSide = rows.reduce((a, r) => a + contextOf(r), 0);
  const cached = rows.reduce((a, r) => a + r.usage.cacheRead, 0);
  const hit = inputSide ? cached / inputSide : 0;
  if (kinds.input / priced > 0.4 && hit < 0.5) {
    out.push({ tone: "warn", title: `輸入佔成本 ${Math.round((kinds.input / priced) * 100)}%,快取命中只有 ${Math.round(hit * 100)}%`, advice: "同樣的內容每次都重新計費。讓成員在同一個 session 裡連續工作(Coucou 會沿用),避免一直換模型或重開;端點若支援提示快取,確認有開。" });
  } else if (hit >= 0.8) {
    const saved = rows.reduce((a, r) => {
      const p = priceOf(report, r.usage.model)?.price;
      return p ? a + (r.usage.cacheRead * Math.max(0, p.input - p.cacheRead)) / 1e6 : a;
    }, 0);
    out.push({ tone: "good", title: `快取命中 ${Math.round(hit * 100)}%,省下約 ${host.money(saved)}`, advice: "重複的內容大多從快取讀取,這部分已經很省。" });
  }
  // A context that keeps growing.
  for (const m of ms) {
    if (m.rows.length < 6) continue;
    const third = Math.max(1, Math.floor(m.rows.length / 3));
    const avg = (s: UsageRow[]) => s.reduce((a, r) => a + contextOf(r), 0) / s.length;
    const early = avg(m.rows.slice(0, third));
    const late = avg(m.rows.slice(-third));
    if (early > 0 && late / early >= 2) {
      out.push({ tone: "warn", title: `${m.name} 每次呼叫帶的內容越來越大:${host.tokens(early)} → ${host.tokens(late)}`, advice: "對話越長,每一輪都要重送更多內容。把大任務拆成幾個小任務,做完一段就交付,下一段讓它重新開始(新任務會帶新的工作說明)。" });
    }
  }
  // Work done twice.
  const rejected = ms.reduce((a, m) => a + (m.did?.rejected ?? 0), 0);
  const accepted = ms.reduce((a, m) => a + (m.did?.accepted ?? 0), 0);
  if (rejected > 0) {
    const who = ms.filter((m) => (m.did?.rejected ?? 0) > 0).map((m) => `${m.name} ${m.did!.rejected} 次`).join("、");
    out.push({ tone: "warn", title: `退回重做 ${rejected} 次(${who})`, advice: "每次退回都是再跑一輪。開任務時把驗收標準寫清楚(要哪些檔案、要通過哪些測試),或請成員交付前先自己對一次標準。" });
  }
  const failed = ms.reduce((a, m) => a + (m.did?.failedTurns ?? 0), 0);
  if (failed > 0) {
    out.push({ tone: "warn", title: `${failed} 個回合執行失敗`, advice: "失敗的回合也會花 token。到看板看是哪位成員、什麼錯誤(端點、權限或模型名稱)。" });
  }
  if (accepted > 0) {
    out.push({ tone: "good", title: `每個驗收的任務平均 ${host.money(usd / accepted)}`, advice: `${accepted} 個任務已驗收。拿這個數字比較不同團隊、不同模型組合的效率。` });
  }
  const unpriced = rows.filter((r) => r.estimatedUsd == null).reduce((a, r) => a + tokensOf(r), 0);
  if (unpriced > 0) {
    out.push({ tone: "warn", title: `有 ${host.tokens(unpriced)} tokens 沒有價格`, advice: "這部分沒算進成本。到「總覽」下方的價格表補上。" });
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
  if (!teams.length) return h("section", { class: "panel cost-empty" }, h("p", { class: "dim", text: "這段期間沒有團隊用量,換一個期間看看。" }));
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
    const text = await host.consult(`幫我分析「${team.name}」在${host.periodLabel()}的成本:為什麼這麼高(或這麼低)?怎麼優化、改善?請用具體數字說明,並給可以直接照做的建議。`);
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
      tile("預估成本", host.money(usd), `${host.tokens(rows.reduce((a, r) => a + tokensOf(r), 0))} tokens · ${rows.length} 次呼叫`),
      tile("每個驗收任務", accepted ? host.money(usd / accepted) : "—", accepted ? `${accepted} 個任務驗收通過` : "這段期間還沒有驗收的任務"),
      tile("每回合", turns ? host.money(usd / turns) : "—", `${turns} 個回合`),
      tile("快取命中", `${Math.round(hit * 100)}%`, "輸入中從快取讀取的比例"),
    ),
    h(
      "section",
      { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", { text: "診斷與建議" }), h("span", { class: "dim", text: "依這段期間的數字算出來的" })),
      found.length ? h("ul", { class: "ca-findings" }, ...found.map((f) => h("li", { class: f.tone }, h("b", { text: f.title }), h("span", { text: f.advice })))) : h("p", { class: "dim", text: "沒有看到明顯的問題。" }),
      h(
        "div",
        { class: "ca-ask" },
        h("button", { class: "btn primary", type: "button", disabled: asking, onClick: () => void ask() }, asking ? "秘書分析中…" : "請秘書分析原因與優化方式"),
        h("span", { class: "hint", text: "秘書會讀同一份數字(成員、模型、回合、退件、快取),用你的聊天模型寫成說明與建議。" }),
      ),
      answer && answer.team === picked
        ? h(
            "div",
            { class: "ca-answer" },
            wordsOf(answer.text),
            h("button", { class: "link", type: "button", onClick: () => host.openSecretary() }, "到秘書頁繼續問 →"),
          )
        : null,
    ),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: "累積成本" }), h("span", { class: "dim", text: "曲線越陡,那段時間花得越快" })), cumulative(ms, rows, host)),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: "每次呼叫帶的內容" }), h("span", { class: "dim", text: "點是每一次呼叫的輸入量(含快取),線是趨勢;一路往上代表對話越滾越大" })), context(ms, host)),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: "成本花在哪種 token" }), h("span", { class: "dim", text: "滑過色塊看金額" })), composition(ms, host)),
    h(
      "section",
      { class: "panel cost-tree" },
      h("div", { class: "panel-head" }, h("h2", { text: "成員效率" })),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ...["成員", "模型", "成本", "占比", "回合", "每回合", "交付", "退回", "驗收"].map((t, i) => h("th", { class: i > 1 ? "num" : "", text: t })))),
          h(
            "tbody",
            {},
            ...ms.map((m) =>
              h(
                "tr",
                {},
                h("td", { class: "name" }, h("span", { class: "name-in" }, h("i", { class: "ca-dot", style: `background:${m.color}` }), h("span", { class: "label", text: m.name }), m.did?.leader ? h("span", { class: "chip", text: "Leader" }) : null)),
                h("td", { class: "mono", text: m.models.join("、") }),
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

/** The secretary's words: paragraphs, lists, headings and **bold**. */
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
