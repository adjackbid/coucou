// 成本與用量: what the teams' agents used, and what it would cost.
//
// Every member's tokens are in its team's record, by model, as the agent
// reported them (usage.rs). This page asks for the records of a period
// (cost.rs prices them), adds them up by team, agent or model, and shows a
// day-by-day chart, a tree to open team → member → model, and the prices
// used — which the person can correct, refresh from the public list, or read
// from an agent's own endpoint.
//
// The page keeps its own state here; main.ts draws it inside the window.

import "./cost.css";
import { Bridge, IS_TAURI } from "../core/bridge";
import type { AgentProfile } from "../core/state";
import { h } from "../views/dom";
import type { Billing, Found, KeySpend, Price, PricingChoices, Usage, UsageReport, UsageRow } from "./types";
import { analysisView } from "./cost-analysis";
import { consult } from "./secretary";

export interface CostHost {
  render(): void;
  agents(): AgentProfile[];
  openSecretary(): void;
}

type Period = "today" | "yesterday" | "7d" | "30d" | "month" | "custom";
type Group = "team" | "agent" | "model";
type Measure = "cost" | "tokens";

const DAY = 86_400_000;
const PERIODS: [Period, string][] = [
  ["today", "今天"],
  ["yesterday", "昨天"],
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
  ["month", "本月"],
  ["custom", "自訂"],
];
const GROUPS: [Group, string][] = [
  ["team", "依團隊"],
  ["agent", "依代理"],
  ["model", "依模型"],
];
const SOURCE: Record<string, string> = { override: "自訂", proxy: "端點", list: "公開價目", reported: "代理回報" };
const PALETTE = ["#3b9eff", "#a78bfa", "#34d399", "#f5a524", "#f472b6", "#22d3ee"];
const OTHER = "#6b7079";
const CARET = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

let period: Period = "7d";
let customFrom = dateText(Date.now() - 6 * DAY);
let customTo = dateText(Date.now());
let group: Group = "team";
/** The page: the numbers, or one team taken apart. */
let view: "overview" | "analysis" = "overview";
let measure: Measure = "cost";
/** Which currency is shown large: US dollars or the person's own. */
let primary: "usd" | "local" = stored("coucou.cost.primary") === "usd" ? "usd" : "local";

let report: UsageReport | null = null;
let loadedFor = "";
let loading = false;
let failed = "";
let notice = "";
let busy = "";
/** Open rows of the tree, by their path. */
const open = new Set<string>();
/** The model whose price is being edited, and what is typed. */
let editing: string | null = null;
let draft: Record<keyof Price, string> = { input: "", output: "", cacheRead: "", cacheWrite: "" };
let showHelp = false;
let refreshTimer = 0;
/** What each endpoint said its key spent, by agent id (or why it could not say). Asked on a click only. */
const billed = new Map<string, KeySpend | string>();
/** Everything opened once the report is in (`?open=all` in a browser, to look at the page). */
let openAll = false;

// A browser at `?view=cost&period=30d&group=agent&open=all` starts there, to look at the page.
if (import.meta.env.DEV && !IS_TAURI && typeof location !== "undefined") {
  const q = new URLSearchParams(location.search);
  const p = q.get("period") as Period | null;
  if (p && PERIODS.some(([v]) => v === p)) period = p;
  const g = q.get("group") as Group | null;
  if (g && GROUPS.some(([v]) => v === g)) group = g;
  if (q.get("measure") === "tokens") measure = "tokens";
  if (q.get("tab") === "analysis") view = "analysis";
  openAll = q.get("open") === "all";
  showHelp = q.has("help");
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a page without storage keeps the choice until it closes */
  }
}

// ── The period ───────────────────────────────────────────────────────────────

function midnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dateText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDate(text: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Days are added as calendar days, so a change of daylight saving time stays on midnight. */
function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** [from, to) in ms, local time. */
function range(): [number, number] {
  const today = midnight(Date.now());
  switch (period) {
    case "today":
      return [today, addDays(today, 1)];
    case "yesterday":
      return [addDays(today, -1), today];
    case "7d":
      return [addDays(today, -6), addDays(today, 1)];
    case "30d":
      return [addDays(today, -29), addDays(today, 1)];
    case "month": {
      const d = new Date(today);
      d.setDate(1);
      return [d.getTime(), addDays(today, 1)];
    }
    case "custom": {
      const a = parseDate(customFrom) ?? addDays(today, -6);
      const b = parseDate(customTo) ?? today;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return [lo, addDays(hi, 1)];
    }
  }
}

async function load(host: CostHost) {
  const [from, to] = range();
  const key = `${from}-${to}`;
  loading = true;
  loadedFor = key;
  try {
    report = IS_TAURI ? await Bridge.usageReport(from, to) : (await import("./demo")).demoReport(from, to);
    failed = "";
  } catch (err) {
    failed = String(err instanceof Error ? err.message : err);
  }
  loading = false;
  host.render();
}

/** A team changed (tokens may have been added): the page asks again, at most every few seconds. */
export function refreshSoon(host: CostHost) {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    loadedFor = "";
    void load(host);
  }, 4000);
}

// ── Sums ─────────────────────────────────────────────────────────────────────

interface Sum {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  /** The part of `usd` that a plan already pays for. */
  planUsd: number;
  /** Tokens no price was found for. */
  unpriced: number;
  /** What reading from the cache saved, against the full input price. */
  saved: number;
}

const zero = (): Sum => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, planUsd: 0, unpriced: 0, saved: 0 });
const tokensOf = (s: { input: number; output: number; cacheRead: number; cacheWrite: number }) => s.input + s.output + s.cacheRead + s.cacheWrite;

function billing(agent: string): Billing {
  return report?.choices.billing[agent] ?? "metered";
}

function priceOf(model: string): Found | null {
  return report?.models.find((m) => m.model === model)?.found ?? null;
}

function addRow(sum: Sum, r: UsageRow) {
  const u = r.usage;
  sum.input += u.input;
  sum.output += u.output;
  sum.cacheRead += u.cacheRead;
  sum.cacheWrite += u.cacheWrite;
  if (r.estimatedUsd == null) sum.unpriced += tokensOf(u);
  else {
    sum.usd += r.estimatedUsd;
    if (billing(r.agent) === "subscription") sum.planUsd += r.estimatedUsd;
  }
  const p = priceOf(u.model)?.price;
  if (p && p.input > p.cacheRead) sum.saved += (u.cacheRead * (p.input - p.cacheRead)) / 1e6;
}

function total(rows: UsageRow[]): Sum {
  const s = zero();
  for (const r of rows) addRow(s, r);
  return s;
}

const value = (s: Sum) => (measure === "cost" ? s.usd : tokensOf(s));

// ── Numbers ──────────────────────────────────────────────────────────────────

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function fmtUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function fmtLocal(usd: number, choices: PricingChoices): string {
  const x = usd * (choices.rate || 0);
  const code = (choices.currency || "TWD").toUpperCase();
  const sign = code === "TWD" ? "NT$" : code === "JPY" ? "¥" : code === "EUR" ? "€" : `${code} `;
  if (x === 0) return `${sign}0`;
  const digits = x < 1 ? 2 : x < 100 ? 1 : 0;
  return `${sign}${x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function money(usd: number): [string, string] {
  const choices = report?.choices;
  if (!choices || !choices.rate) return [fmtUsd(usd), ""];
  const local = fmtLocal(usd, choices);
  return primary === "usd" ? [fmtUsd(usd), local] : [local, fmtUsd(usd)];
}

const moneyText = (usd: number) => money(usd)[0];
const shown = (v: number) => (measure === "cost" ? moneyText(v) : fmtTokens(v));

// ── Who is who ───────────────────────────────────────────────────────────────

function agentName(host: CostHost, id: string): string {
  return host.agents().find((a) => a.id === id)?.name || id || "未知代理";
}

interface Level {
  key: (r: UsageRow) => string;
  label: (r: UsageRow) => string;
  /** Small things beside the label: an agent, a plan, a missing price. */
  extra?: (r: UsageRow) => (HTMLElement | null)[];
}

function levels(host: CostHost): Level[] {
  const team: Level = { key: (r) => r.team, label: (r) => r.teamName || r.team };
  const member: Level = {
    key: (r) => `${r.team}/${r.member}`,
    label: (r) => r.memberName || r.member,
    extra: (r) => [h("span", { class: "chip agent", text: agentName(host, r.agent) })],
  };
  // Under an agent, the member's agent goes without saying.
  const memberInTeam: Level = { key: member.key, label: (r) => `${r.teamName} · ${r.memberName || r.member}` };
  const agent: Level = {
    key: (r) => r.agent,
    label: (r) => agentName(host, r.agent),
    extra: (r) => [billing(r.agent) === "subscription" ? h("span", { class: "chip plan", title: "訂閱方案:金額是同樣用量換算成 API 價格的等值,不會另外收費", text: "訂閱" }) : null],
  };
  const model: Level = {
    key: (r) => r.usage.model,
    label: (r) => r.usage.model || "未知模型",
    extra: (r) => [r.estimatedUsd == null ? h("span", { class: "chip warn", title: "找不到這個模型的價格;到下方「價格表」填上", text: "無價格" }) : r.pricedBy === "reported" ? h("span", { class: "chip", title: "依代理自己回報的費用", text: "代理回報" }) : null],
  };
  if (group === "agent") return [agent, model, memberInTeam];
  if (group === "model") return [model, team, member];
  return [team, member, model];
}

/** The first level's groups, largest first: the chart's series. */
function topGroups(rows: UsageRow[], level: Level): { key: string; label: string; sum: Sum }[] {
  const by = new Map<string, { key: string; label: string; sum: Sum }>();
  for (const r of rows) {
    const k = level.key(r);
    let g = by.get(k);
    if (!g) by.set(k, (g = { key: k, label: level.label(r), sum: zero() }));
    addRow(g.sum, r);
  }
  return [...by.values()].sort((a, b) => value(b.sum) - value(a.sum) || a.label.localeCompare(b.label));
}

// ── The page ─────────────────────────────────────────────────────────────────

export function costPage(host: CostHost): HTMLElement {
  const [from, to] = range();
  if (loadedFor !== `${from}-${to}` && !loading) void load(host);
  const rows = report?.rows ?? [];
  const page = h("div", { class: "cost" }, toolbar(host));
  if (failed) page.append(h("div", { class: "problem", role: "alert", text: `讀不到用量紀錄:${failed}` }));
  if (notice) page.append(h("div", { class: "cost-notice", role: "status" }, h("span", { text: notice }), h("button", { class: "link", type: "button", onClick: () => ((notice = ""), host.render()) }, "知道了")));
  if (!report) {
    page.append(h("section", { class: "panel cost-empty" }, h("p", { class: "dim", text: "讀取用量中…" })));
    return page;
  }
  if (view === "analysis") {
    const [from, to] = range();
    page.append(
      analysisView(report, {
        render: () => host.render(),
        money: moneyText,
        tokens: fmtTokens,
        periodLabel: () => (period === "custom" ? `${dateText(from)} ~ ${dateText(to - 1)}` : PERIODS.find(([p]) => p === period)?.[1] ?? ""),
        consult: (text) => consult(text, () => host.render()),
        openSecretary: () => host.openSecretary(),
      }),
    );
    return page;
  }
  page.append(kpis(rows));
  if (!rows.length) {
    page.append(
      h(
        "section",
        { class: "panel cost-empty" },
        h("h2", { text: "這段期間沒有用量紀錄" }),
        h("p", { class: "dim", text: "團隊成員工作時,Coucou 會記下每個模型用了多少 token。換一個期間看看,或讓團隊跑一輪。" }),
        coverage(),
      ),
    );
  } else {
    page.append(chart(rows, host, from, to), breakdown(rows, host));
  }
  const actual = actualPanel(rows, host);
  if (actual) page.append(actual);
  page.append(prices(rows, host));
  return page;
}

function segmented<T extends string>(items: [T, string][], current: T, pick: (v: T) => void, label: string): HTMLElement {
  return h(
    "div",
    { class: "cost-seg", role: "group", "aria-label": label },
    ...items.map(([v, text]) =>
      h("button", { class: v === current ? "on" : "", type: "button", "aria-pressed": String(v === current), onClick: () => pick(v) }, text),
    ),
  );
}

function toolbar(host: CostHost): HTMLElement {
  const date = (key: string, value: string, set: (v: string) => void) => {
    const el = h("input", { class: "field date", type: "date", "data-key": key, value }) as HTMLInputElement;
    el.addEventListener("change", () => {
      set(el.value);
      host.render();
    });
    return el;
  };
  const [from, to] = range();
  const days = Math.round((to - from) / DAY);
  return h(
    "section",
    { class: "cost-toolbar" },
    segmented<"overview" | "analysis">([["overview", "總覽"], ["analysis", "分析"]], view, (v) => ((view = v), host.render()), "總覽或分析"),
    segmented(PERIODS, period, (p) => ((period = p), host.render()), "期間"),
    period === "custom"
      ? h("div", { class: "cost-dates" }, date("cost-from", customFrom, (v) => (customFrom = v)), h("span", { class: "dim", text: "到" }), date("cost-to", customTo, (v) => (customTo = v)))
      : h("span", { class: "cost-range dim", text: days <= 1 ? dateText(from) : `${dateText(from)} ~ ${dateText(to - 1)}` }),
    h("span", { class: "grow" }),
    view === "overview" ? segmented(GROUPS, group, (g) => ((group = g), open.clear(), host.render()), "分組") : null,
    report?.choices.rate
      ? segmented<"local" | "usd">([["local", report.choices.currency || "TWD"], ["usd", "USD"]], primary, (v) => ((primary = v), store("coucou.cost.primary", v), host.render()), "幣別")
      : null,
    h("button", { class: "btn plain", type: "button", disabled: loading, onClick: () => ((loadedFor = ""), host.render()) }, loading ? "讀取中…" : "重新整理"),
  );
}

function kpi(title: string, big: string, small: string, sub: (HTMLElement | string | null)[], extra = ""): HTMLElement {
  return h("div", { class: `kpi ${extra}` }, h("span", { class: "kpi-title", text: title }), h("b", { class: "kpi-big" }, big, small ? h("small", { text: ` ≈ ${small}` }) : null), h("span", { class: "kpi-sub" }, ...sub));
}

function kpis(rows: UsageRow[]): HTMLElement {
  const s = total(rows);
  const [big, small] = money(s.usd);
  const tokens = tokensOf(s);
  const inputSide = s.input + s.cacheRead + s.cacheWrite;
  const hit = inputSide ? Math.round((s.cacheRead / inputSide) * 100) : 0;
  const models = new Set(rows.map((r) => r.usage.model));
  const unpricedModels = new Set(rows.filter((r) => r.estimatedUsd == null).map((r) => r.usage.model));
  const teams = new Set(rows.map((r) => r.team));
  const members = new Set(rows.map((r) => `${r.team}/${r.member}`));
  const agents = new Set(rows.map((r) => r.agent));
  return h(
    "section",
    { class: "kpis" },
    kpi("預估成本", big, small, [
      s.planUsd > 0 ? `按用量計費 ${moneyText(s.usd - s.planUsd)} · 訂閱方案等值 ${moneyText(s.planUsd)}` : "依各模型的每百萬 token 價格估算",
    ]),
    kpi("Token 用量", fmtTokens(tokens), "", [`輸入 ${fmtTokens(s.input)} · 輸出 ${fmtTokens(s.output)} · 快取 ${fmtTokens(s.cacheRead + s.cacheWrite)}`]),
    kpi("快取命中", `${hit}%`, "", [s.saved > 0 ? `快取讀取省下約 ${moneyText(s.saved)}` : "輸入中從快取讀取的比例"]),
    kpi(
      "參與",
      `${teams.size} 隊 · ${members.size} 人`,
      "",
      [
        `${agents.size} 個代理 · ${models.size} 個模型`,
        unpricedModels.size
          ? h(
              "button",
              { class: "link warn-link", type: "button", onClick: () => document.getElementById("cost-prices")?.scrollIntoView({ behavior: "smooth", block: "start" }) },
              ` · ${unpricedModels.size} 個沒有價格`,
            )
          : null,
      ],
      unpricedModels.size ? "has-warn" : "",
    ),
  );
}

/** Day by day (hour by hour for a single day), stacked by the biggest groups. */
function chart(rows: UsageRow[], host: CostHost, from: number, to: number): HTMLElement {
  const hourly = to - from <= DAY + 3_600_000;
  const starts: number[] = [];
  if (hourly) for (let t = from; t < to; t += 3_600_000) starts.push(t);
  else for (let t = from; t < to; t = addDays(t, 1)) starts.push(t);
  const bucket = (at: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const level = levels(host)[0];
  const top = topGroups(rows, level);
  const series = top.slice(0, 5).map((g, i) => ({ key: g.key, label: g.label, color: PALETTE[i] }));
  if (top.length > 5) series.push({ key: "", label: "其他", color: OTHER });
  const seriesOf = (r: UsageRow) => {
    const k = level.key(r);
    return series.findIndex((s) => s.key === k) >= 0 ? series.findIndex((s) => s.key === k) : series.length - 1;
  };

  const cells = starts.map(() => series.map(() => zero()));
  for (const r of rows) addRow(cells[bucket(r.at)][seriesOf(r)], r);
  const totals = cells.map((c) => c.reduce((a, s) => a + value(s), 0));
  const max = Math.max(...totals, 0) || 1;
  const every = Math.max(1, Math.ceil(starts.length / (hourly ? 8 : 10)));
  const label = (t: number) => {
    const d = new Date(t);
    return hourly ? `${d.getHours()}:00` : `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const cols = starts.map((t, i) => {
    const col = h("div", { class: `bar-col${totals[i] ? "" : " empty"}` });
    const stack = h("div", { class: "bar-stack", style: `height:${(totals[i] / max) * 100}%` });
    cells[i].forEach((s, k) => {
      const v = value(s);
      if (v > 0) stack.append(h("i", { style: `flex:${v} 0 0;background:${series[k].color}` }));
    });
    col.append(stack);
    if (totals[i]) {
      const when = hourly ? `${dateText(t)} ${label(t)}` : dateText(t);
      col.append(
        h(
          "div",
          // Just above the bar (over it, for a tall one), so it stays in view.
          { class: "bar-tip", role: "tooltip", style: `bottom:calc(${Math.min((totals[i] / max) * 100, 45)}% + 8px)` },
          h("b", { text: `${when} · ${shown(totals[i])}` }),
          ...cells[i]
            .map((s, k) => ({ s, k }))
            .filter(({ s }) => value(s) > 0)
            .sort((a, b) => value(b.s) - value(a.s))
            .map(({ s, k }) => h("span", {}, h("i", { style: `background:${series[k].color}` }), `${series[k].label}`, h("em", { text: shown(value(s)) }))),
        ),
      );
    }
    col.append(h("span", { class: "bar-label", text: i % every === 0 ? label(t) : "" }));
    return col;
  });

  return h(
    "section",
    { class: "panel cost-chart" },
    h(
      "div",
      { class: "panel-head" },
      h("h2", { text: hourly ? "每小時" : "每日" }),
      segmented<Measure>([["cost", "成本"], ["tokens", "Token"]], measure, (m) => ((measure = m), host.render()), "看成本或 token"),
    ),
    h("div", { class: "bars", style: `--n:${starts.length}` }, h("span", { class: "bars-max dim", text: shown(max) }), ...cols),
    h("div", { class: "cost-legend" }, ...series.map((s) => h("span", {}, h("i", { style: `background:${s.color}` }), s.label))),
  );
}

interface Node {
  path: string;
  label: string;
  extra: (HTMLElement | null)[];
  sum: Sum;
  children: Node[];
}

function tree(rows: UsageRow[], ls: Level[], depth = 0, parent = ""): Node[] {
  if (depth >= ls.length) return [];
  const level = ls[depth];
  const by = new Map<string, { node: Node; rows: UsageRow[] }>();
  for (const r of rows) {
    const k = level.key(r);
    let g = by.get(k);
    if (!g) {
      const path = `${parent}/${k}`;
      g = { node: { path, label: level.label(r), extra: level.extra?.(r) ?? [], sum: zero(), children: [] }, rows: [] };
      by.set(k, g);
    }
    addRow(g.node.sum, r);
    g.rows.push(r);
  }
  const nodes = [...by.values()].map(({ node, rows }) => ({ ...node, children: tree(rows, ls, depth + 1, node.path) }));
  return nodes.sort((a, b) => value(b.sum) - value(a.sum) || a.label.localeCompare(b.label));
}

function breakdown(rows: UsageRow[], host: CostHost): HTMLElement {
  const all = total(rows);
  const whole = value(all) || 1;
  const body = h("tbody");
  const draw = (nodes: Node[], depth: number) => {
    for (const n of nodes) {
      const can = n.children.length > 0;
      const isOpen = open.has(n.path);
      const share = value(n.sum) / whole;
      const cost = n.sum.usd > 0 || n.sum.unpriced === 0 ? moneyText(n.sum.usd) : "—";
      const tr = h(
        "tr",
        {
          class: `depth-${depth}${can ? " can-open" : ""}${isOpen ? " open" : ""}`,
          onClick: can ? () => (isOpen ? open.delete(n.path) : open.add(n.path), host.render()) : undefined,
        },
        h(
          "td",
          { class: "name" },
          h("span", { class: "name-in", style: `padding-left:${depth * 18}px` }, h("i", { class: "caret", "aria-hidden": "true", html: can ? CARET : "" }), h("span", { class: "label", text: n.label, title: n.label }), ...n.extra),
        ),
        h("td", { class: "num", text: fmtTokens(n.sum.input) }),
        h("td", { class: "num", text: fmtTokens(n.sum.output) }),
        h("td", { class: "num", text: fmtTokens(n.sum.cacheRead + n.sum.cacheWrite) }),
        h("td", { class: "num strong", text: fmtTokens(tokensOf(n.sum)) }),
        h("td", { class: "num strong", text: cost, title: n.sum.planUsd > 0 ? `其中訂閱方案等值 ${moneyText(n.sum.planUsd)}` : "" }),
        h("td", { class: "share" }, h("span", { class: "share-bar" }, h("i", { style: `width:${Math.max(share * 100, share > 0 ? 1.5 : 0)}%` })), h("em", { text: `${Math.round(share * 100)}%` })),
      );
      if (can) {
        tr.setAttribute("tabindex", "0");
        tr.setAttribute("aria-expanded", String(isOpen));
        tr.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isOpen) open.delete(n.path);
            else open.add(n.path);
            host.render();
          }
        });
      }
      body.append(tr);
      if (can && isOpen) draw(n.children, depth + 1);
    }
  };
  const nodes = tree(rows, levels(host));
  const walk = (ns: Node[]) => ns.forEach((n) => n.children.length && (open.add(n.path), walk(n.children)));
  if (openAll) {
    openAll = false;
    walk(nodes);
  }
  draw(nodes, 0);
  const allOpen = () => {
    walk(nodes);
    host.render();
  };
  const names = group === "team" ? "團隊 › 成員 › 模型" : group === "agent" ? "代理 › 模型 › 成員" : "模型 › 團隊 › 成員";
  return h(
    "section",
    { class: "panel cost-tree" },
    h(
      "div",
      { class: "panel-head" },
      h("h2", { text: "明細" }),
      h("div", { class: "row" }, h("span", { class: "dim", text: names }), h("button", { class: "link", type: "button", onClick: allOpen }, "全部展開"), h("button", { class: "link", type: "button", onClick: () => (open.clear(), host.render()) }, "全部收合")),
    ),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", { text: "名稱" }), h("th", { class: "num", text: "輸入" }), h("th", { class: "num", text: "輸出" }), h("th", { class: "num", text: "快取" }), h("th", { class: "num", text: "合計 tokens" }), h("th", { class: "num", text: "預估成本" }), h("th", { class: "share", text: measure === "cost" ? "成本占比" : "用量占比" }))),
        body,
        h(
          "tfoot",
          {},
          h(
            "tr",
            {},
            h("td", { text: "合計" }),
            h("td", { class: "num", text: fmtTokens(all.input) }),
            h("td", { class: "num", text: fmtTokens(all.output) }),
            h("td", { class: "num", text: fmtTokens(all.cacheRead + all.cacheWrite) }),
            h("td", { class: "num strong", text: fmtTokens(tokensOf(all)) }),
            h("td", { class: "num strong", text: moneyText(all.usd) }),
            h("td", {}),
          ),
        ),
      ),
    ),
  );
}

// ── What the endpoints billed ────────────────────────────────────────────────

/** Agents on an endpoint of their own: the ones whose bill can be asked for. */
function endpointAgents(host: CostHost): AgentProfile[] {
  return host.agents().filter((a) => /^https?:\/\//.test(a.env?.COPILOT_PROVIDER_BASE_URL?.trim() ?? ""));
}

function durationText(d: string | null): string {
  const m = /^(\d+)\s*(mo|[smhdwy])$/i.exec(d ?? "");
  if (!m) return d ?? "";
  const unit: Record<string, string> = { s: "秒", m: "分鐘", h: "小時", d: "天", w: "週", mo: "個月", y: "年" };
  return `每 ${m[1]} ${unit[m[2].toLowerCase()] ?? m[2]}`;
}

function whenText(ms: number): string {
  const d = new Date(ms);
  return `${dateText(ms)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function askBill(host: CostHost, agent: AgentProfile) {
  busy = `bill:${agent.id}`;
  host.render();
  try {
    billed.set(agent.id, IS_TAURI ? await Bridge.endpointSpend(agent.id) : (await import("./demo")).demoKeySpend());
  } catch (err) {
    billed.set(agent.id, String(err instanceof Error ? err.message : err));
  }
  busy = "";
  host.render();
}

function actualPanel(rows: UsageRow[], host: CostHost): HTMLElement | null {
  const agents = endpointAgents(host);
  if (!agents.length) return null;
  return h(
    "section",
    { class: "panel cost-actual" },
    h("div", { class: "panel-head" }, h("h2", { text: "端點實際花費" }), h("span", { class: "dim", text: "向代理自己的端點(LiteLLM proxy)查詢這把金鑰被計了多少錢,和上面的預估對照" })),
    ...agents.map((a) => {
      const got = billed.get(a.id);
      const estimate = total(rows.filter((r) => r.agent === a.id)).usd;
      const asking = busy === `bill:${a.id}`;
      const button = h("button", { class: "btn plain", type: "button", disabled: !!busy, onClick: () => void askBill(host, a) }, asking ? "查詢中…" : got ? "重新查詢" : "查詢");
      const head = h("div", { class: "actual-head" }, h("div", {}, h("b", { text: a.name }), h("span", { class: "dim", text: ` ${a.env.COPILOT_PROVIDER_BASE_URL}` })), button);
      if (!got) return h("div", { class: "actual" }, head, h("p", { class: "hint", text: `按「查詢」才會連線。Coucou 在所選期間估計這個代理花了 ${moneyText(estimate)}。` }));
      if (typeof got === "string") return h("div", { class: "actual" }, head, h("p", { class: "problem", text: got }));
      const [big, small] = money(got.spend);
      const share = got.maxBudget ? Math.min(1, got.spend / got.maxBudget) : 0;
      const models = Object.entries(got.modelSpend).sort((x, y) => y[1] - x[1]);
      const most = models[0]?.[1] || 1;
      const reset = got.budgetResetAt ? Date.parse(got.budgetResetAt) : NaN;
      return h(
        "div",
        { class: "actual" },
        head,
        h(
          "div",
          { class: "actual-body" },
          h(
            "div",
            { class: "actual-total" },
            h("span", { class: "kpi-title", text: got.budgetDuration ? "這個預算週期已花費" : "這把金鑰已花費" }),
            h("b", { class: "kpi-big" }, big, small ? h("small", { text: ` ≈ ${small}` }) : null),
            got.maxBudget
              ? h(
                  "div",
                  { class: "budget" },
                  h("span", { class: "share-bar wide" }, h("i", { class: share > 0.8 ? "hot" : "", style: `width:${Math.max(share * 100, 1)}%` })),
                  h("span", { class: "dim", text: `預算 ${moneyText(got.maxBudget)} · 已用 ${Math.round(share * 100)}%${got.budgetDuration ? ` · ${durationText(got.budgetDuration)}重置` : ""}${Number.isNaN(reset) ? "" : `(下次 ${whenText(reset)})`}` }),
                )
              : null,
            h("span", { class: "hint", text: `端點的數字也包含這把金鑰在 Coucou 以外的使用。Coucou 在所選期間估計:${moneyText(estimate)}。查詢於 ${whenText(got.askedAt)}。` }),
          ),
          models.length
            ? h(
                "div",
                { class: "actual-models" },
                h("span", { class: "kpi-title", text: "依模型" }),
                ...models.slice(0, 8).map(([m, v]) =>
                  h("div", { class: "actual-model" }, h("span", { class: "label", text: m, title: m }), h("span", { class: "share-bar" }, h("i", { style: `width:${Math.max((v / most) * 100, 1.5)}%` })), h("em", { text: moneyText(v) })),
                ),
              )
            : null,
        ),
      );
    }),
  );
}

// ── Prices ───────────────────────────────────────────────────────────────────

const perM = (v: number) => (v ? `$${v < 0.1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(1)}` : "—");

async function saveChoices(host: CostHost, change: (c: PricingChoices) => void, after = "") {
  if (!report) return;
  const next = structuredClone(report.choices);
  change(next);
  busy = "save";
  host.render();
  try {
    if (IS_TAURI) await Bridge.pricingSave(next);
    else Object.assign((await import("./demo")).demoChoices, next);
    forgetQuotes();
    notice = after;
    loadedFor = "";
  } catch (err) {
    notice = `存不起來:${String(err instanceof Error ? err.message : err)}`;
  }
  busy = "";
  host.render();
}

async function run(host: CostHost, what: string, task: () => Promise<string>) {
  busy = what;
  notice = "";
  host.render();
  try {
    notice = await task();
    forgetQuotes();
    loadedFor = "";
  } catch (err) {
    notice = `沒有成功:${String(err instanceof Error ? err.message : err)}`;
  }
  busy = "";
  host.render();
}

function priceRow(model: string, found: Found | null, tokens: number, host: CostHost): HTMLElement {
  if (editing === model) {
    const input = (k: keyof Price, label: string) => {
      const el = h("input", { class: "field narrow", type: "number", min: "0", step: "0.01", "data-key": `price-${model}-${k}`, "aria-label": label, value: draft[k] }) as HTMLInputElement;
      el.addEventListener("input", () => (draft[k] = el.value));
      return h("td", { class: "num" }, el);
    };
    const own = !!report?.choices.overrides[model];
    return h(
      "tr",
      { class: "editing" },
      h("td", { class: "name" }, h("span", { class: "label", text: model })),
      h("td", { class: "dim", text: "自訂價格(美元 / 每百萬 tokens)" }),
      input("input", "輸入"),
      input("output", "輸出"),
      input("cacheRead", "快取讀取"),
      input("cacheWrite", "快取寫入"),
      h(
        "td",
        { class: "actions" },
        h(
          "button",
          {
            class: "btn primary",
            type: "button",
            onClick: () => {
              const n = (k: keyof Price) => Math.max(0, Number(draft[k]) || 0);
              const price: Price = { input: n("input"), output: n("output"), cacheRead: n("cacheRead"), cacheWrite: n("cacheWrite") };
              editing = null;
              void saveChoices(host, (c) => (c.overrides[model] = price), `已用你的價格計算 ${model}。`);
            },
          },
          "儲存",
        ),
        own
          ? h(
              "button",
              {
                class: "link",
                type: "button",
                title: "移除自訂價格,改回端點或公開價目的價格",
                onClick: () => {
                  editing = null;
                  void saveChoices(host, (c) => delete c.overrides[model], `${model} 改回用公開價目或端點的價格。`);
                },
              },
              "改回預設",
            )
          : null,
        h("button", { class: "link", type: "button", onClick: () => ((editing = null), host.render()) }, "取消"),
      ),
    );
  }
  const p = found?.price;
  return h(
    "tr",
    {},
    h("td", { class: "name" }, h("span", { class: "label", text: model, title: model }), h("small", { class: "dim", text: ` ${fmtTokens(tokens)} tokens` })),
    h(
      "td",
      { class: "matched" },
      found ? h("span", { class: `chip src-${found.source}`, text: SOURCE[found.source] ?? found.source }) : h("span", { class: "chip warn", text: "無價格" }),
      found ? h("span", { class: "dim", text: ` ${found.listedAs}` }) : h("span", { class: "dim", text: " 公開價目和端點都找不到,請自訂" }),
    ),
    h("td", { class: "num", text: p ? perM(p.input) : "—" }),
    h("td", { class: "num", text: p ? perM(p.output) : "—" }),
    h("td", { class: "num", text: p ? perM(p.cacheRead) : "—" }),
    h("td", { class: "num", text: p ? perM(p.cacheWrite) : "—" }),
    h(
      "td",
      { class: "actions" },
      h(
        "button",
        {
          class: "link",
          type: "button",
          onClick: () => {
            editing = model;
            const s = (v: number | undefined) => (v ? String(v) : "");
            draft = { input: s(p?.input), output: s(p?.output), cacheRead: s(p?.cacheRead), cacheWrite: s(p?.cacheWrite) };
            host.render();
          },
        },
        found?.source === "override" ? "修改" : "自訂",
      ),
    ),
  );
}

function prices(rows: UsageRow[], host: CostHost): HTMLElement {
  const r = report!;
  const used = new Map<string, number>();
  for (const row of rows) used.set(row.usage.model, (used.get(row.usage.model) ?? 0) + tokensOf(row.usage));
  const models = [...r.models].sort((a, b) => Number(!!a.found) - Number(!!b.found) || (used.get(b.model) ?? 0) - (used.get(a.model) ?? 0));
  const endpoints = endpointAgents(host);
  const fetched = r.tableFetchedAt ? `更新於 ${dateText(r.tableFetchedAt)}` : "隨 Coucou 附帶";

  const rateField = h("input", { class: "field narrow", type: "number", min: "0", step: "0.1", "data-key": "cost-rate", value: String(r.choices.rate || "") }) as HTMLInputElement;
  rateField.addEventListener("change", () => {
    const rate = Math.max(0, Number(rateField.value) || 0);
    void saveChoices(host, (c) => (c.rate = rate));
  });
  const currencyField = h("input", { class: "field narrow", type: "text", maxlength: "3", "data-key": "cost-currency", value: r.choices.currency || "TWD", spellcheck: "false" }) as HTMLInputElement;
  currencyField.addEventListener("change", () => {
    const code = currencyField.value.trim().toUpperCase().slice(0, 3) || "TWD";
    void saveChoices(host, (c) => (c.currency = code));
  });

  return h(
    "section",
    { class: "panel cost-prices", id: "cost-prices" },
    h(
      "div",
      { class: "panel-head" },
      h("h2", { text: "價格表" }),
      h("span", { class: "dim", text: "美元 / 每百萬 tokens · 優先順序:自訂 > 代理端點 > 公開價目" }),
    ),
    models.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", { text: "這段期間用到的模型" }), h("th", { text: "價格來源" }), h("th", { class: "num", text: "輸入" }), h("th", { class: "num", text: "輸出" }), h("th", { class: "num", text: "快取讀取" }), h("th", { class: "num", text: "快取寫入" }), h("th", {}))),
            h("tbody", {}, ...models.map((m) => priceRow(m.model, m.found, used.get(m.model) ?? 0, host))),
          ),
        )
      : h("p", { class: "dim", text: "這段期間沒有用到任何模型。" }),
    h(
      "div",
      { class: "price-sources" },
      h(
        "div",
        { class: "source" },
        h("div", {}, h("b", { text: "公開價目" }), h("span", { class: "dim", text: ` ${r.tableSource || "LiteLLM"} · ${r.tableSize.toLocaleString("en-US")} 個模型 · ${fetched}` })),
        h(
          "button",
          { class: "btn plain", type: "button", disabled: !!busy, title: "從 GitHub 下載 LiteLLM 的公開價目表(只在你按下時連線)", onClick: () => void run(host, "list", async () => (IS_TAURI ? `公開價目已更新:${(await Bridge.pricingFetchList()).toLocaleString("en-US")} 個模型。` : "瀏覽器預覽不會連線。")) },
          busy === "list" ? "更新中…" : "更新公開價目",
        ),
      ),
      ...endpoints.map((a) =>
        h(
          "div",
          { class: "source" },
          h("div", {}, h("b", { text: a.name }), h("span", { class: "dim", text: ` ${a.env.COPILOT_PROVIDER_BASE_URL} · 端點是 LiteLLM proxy 時,讀它自己的價格(用這個代理的金鑰)` })),
          h(
            "button",
            { class: "btn plain", type: "button", disabled: !!busy, onClick: () => void run(host, `agent:${a.id}`, async () => (IS_TAURI ? `從「${a.name}」的端點讀到 ${await Bridge.pricingFromAgent(a.id)} 個模型的價格。` : "瀏覽器預覽不會連線。")) },
            busy === `agent:${a.id}` ? "讀取中…" : "讀取端點價格",
          ),
        ),
      ),
      h(
        "div",
        { class: "source" },
        h("div", {}, h("b", { text: "幣別" }), h("span", { class: "dim", text: " 美元以外,也用這個幣別顯示" })),
        h("div", { class: "row nowrap" }, h("span", { class: "dim", text: "1 USD =" }), rateField, currencyField),
      ),
    ),
    billingPanel(host),
    h(
      "div",
      { class: "help-row" },
      h("button", { class: `help-toggle${showHelp ? " on" : ""}`, type: "button", "aria-expanded": String(showHelp), onClick: () => ((showHelp = !showHelp), host.render()) }, h("b", { text: "?" }), "用量是怎麼來的"),
    ),
    showHelp ? coverage() : null,
  );
}

function billingPanel(host: CostHost): HTMLElement {
  const r = report!;
  const agents = host.agents();
  return h(
    "div",
    { class: "billing" },
    h("div", { class: "billing-head" }, h("b", { text: "計費方式" }), h("span", { class: "dim", text: " 訂閱方案(例如 Claude Max、ChatGPT Plus、GitHub Copilot)不依 token 收費,金額是同樣用量換算成 API 價格的等值,在總額裡分開列出。" })),
    h(
      "div",
      { class: "billing-list" },
      ...agents.map((a) =>
        h(
          "div",
          { class: "billing-item" },
          h("span", { class: "label", text: a.name, title: a.id }),
          segmented<Billing>(
            [
              ["metered", "按用量"],
              ["subscription", "訂閱"],
            ],
            r.choices.billing[a.id] ?? "metered",
            (b) => void saveChoices(host, (c) => (c.billing[a.id] = b)),
            `${a.name} 的計費方式`,
          ),
        ),
      ),
    ),
  );
}

function coverage(): HTMLElement {
  const item = (term: string, text: string) => h("div", { class: "help-item" }, h("dt", { text: term }), h("dd", { text }));
  return h(
    "div",
    { class: "member-help cost-help", role: "note" },
    h(
      "dl",
      {},
      item("Claude Code", "每一輪結束時回報各模型的 token(含快取),也附上它自己估的費用。"),
      item("Codex", "工作時即時回報整個對話串的 token,子代理的也算在內。"),
      item("Copilot(自備端點)", "像 cg 這樣接自己的 API 端點時,請求經過 Coucou 在本機的計量器轉送,逐筆讀出 token 和實際使用的模型;內容不保存。Copilot 自己每輪回報的累計值和計量器重複,不另外計算。"),
      item("Copilot(GitHub 登入)", "每一輪結束時回報整個 session 的累計用量(Coucou 換算成這一輪新增的部分),但不附模型名稱,以這位成員設定的模型記錄;費用以 GitHub 的方案為準,建議把計費方式設成「訂閱」。"),
      item("Antigravity", "它的結果有附用量時才會記錄。"),
      item("預估成本", "用量 × 價格表的每百萬 token 價格。實際帳單以各服務商為準(例如 LiteLLM 後台的 Spend)。"),
    ),
  );
}

// ── Beside members at work ───────────────────────────────────────────────────

const quotes = new Map<string, Found | null>();
let quoteChoices: PricingChoices | null = null;
let asking = false;

/** An amount in the currency the 成本 page shows large. */
export function fmtMoney(usd: number): string {
  const c = report?.choices ?? quoteChoices;
  return primary === "local" && c?.rate ? fmtLocal(usd, c) : fmtUsd(usd);
}

/** A member's (or a team's) tokens and their cost at today's prices; asks for prices it does not know yet. */
export function usageSummary(usage: Usage[] | undefined, redraw: () => void): { tokens: number; usd: number | null; priced: boolean } {
  let tokens = 0;
  let usd = 0;
  let priced = true;
  const missing: string[] = [];
  for (const u of usage ?? []) {
    tokens += tokensOf(u);
    if (!quotes.has(u.model)) {
      missing.push(u.model);
      priced = false;
      continue;
    }
    const f = quotes.get(u.model);
    if (f) usd += (u.input * f.price.input + u.output * f.price.output + u.cacheRead * f.price.cacheRead + u.cacheWrite * f.price.cacheWrite) / 1e6;
    else if (u.costUsd != null) usd += u.costUsd;
    else priced = false;
  }
  if (missing.length && !asking) {
    asking = true;
    void (async () => {
      const demo = IS_TAURI ? null : await import("./demo");
      const got = demo ? ([demo.demoQuote(missing), demo.demoChoices] as const) : await Bridge.pricingQuote(missing);
      for (const m of missing) quotes.set(m, got?.[0]?.[m] ?? null);
      if (got?.[1]) quoteChoices = got[1];
      asking = false;
      redraw();
    })();
  }
  return { tokens, usd: tokens && (priced || usd > 0) ? usd : null, priced };
}

/** Prices were changed on the 成本 page: what members show is worked out again. */
export function forgetQuotes() {
  quotes.clear();
}
