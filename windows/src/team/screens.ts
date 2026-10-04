// The two screens beside the monitor:
//
//   協作關係  who hands what to whom, who talks to whom — the team as a map,
//            and, for one member, where its work comes from and goes to.
//   溝通紀錄  every exchange, gathered by the task it is about, with the
//            task itself beside it.
//
// Both read what the window already has: the team file being edited (its
// links) and, once the team runs, its snapshot (tasks, messages, feed).

import { Bridge } from "../core/bridge";
import { h } from "../views/dom";
import { heardWords } from "./live";
import { dropdown } from "./ui";
import type { FeedItem, MemberStatus, Message, Snapshot, Task, TeamConfig } from "./types";

/** What these screens borrow from the page. */
export interface Page {
  render: () => void;
  act: (what: () => Promise<unknown>, after?: () => void) => Promise<void>;
  save: () => Promise<boolean>;
  said: (text: string) => string;
  colorOf: (team: { members: { id: string; color: string }[] }, id: string) => string;
  blob: (color: string, size?: number) => HTMLElement;
  composer: (snap: Snapshot) => HTMLElement;
  /** The form's copy changed: the save button lights up. */
  touched: () => void;
}

const YOU = "you";
const SYSTEM = "system";

const STATUS_WORD: Record<MemberStatus, string> = {
  working: "工作中",
  waitingDelivery: "等待交付",
  waitingReply: "等待回覆",
  waitingYou: "等你處理",
  idle: "待命",
  done: "已完成",
  lost: "失聯",
};

const TASK_WORD: Record<Task["status"], string> = { todo: "待處理", doing: "進行中", delivered: "待驗收", done: "已完成" };

const short = (text: string, keep: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > keep ? `${flat.slice(0, keep)}…` : flat;
};

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function nameIn(config: TeamConfig, snap: Snapshot | undefined, id: string): string {
  if (id === YOU) return "你";
  if (id === SYSTEM) return "Coucou";
  return config.members.find((m) => m.id === id)?.name ?? snap?.members.find((m) => m.id === id)?.name ?? id;
}

// ── 協作關係 ──────────────────────────────────────────────────────────────────

/** The member looked at on the map, per team. */
const focus = new Map<string, string>();

interface Edge {
  from: string;
  to: string;
  kind: "delivery" | "talk" | "lead";
  label: string;
  /** Work is moving along it right now. */
  live: boolean;
}

/** Every line on the map: the file's links, the leader's hand-outs, the tasks' hand-overs. */
function edges(config: TeamConfig, snap: Snapshot | undefined): Edge[] {
  const out: Edge[] = [];
  const has = (from: string, to: string) => out.some((e) => e.from === from && e.to === to && e.kind !== "lead");
  for (const l of config.links) {
    if (!config.members.some((m) => m.id === l.from) || !config.members.some((m) => m.id === l.to)) continue;
    out.push({ from: l.from, to: l.to, kind: l.kind === "talk" ? "talk" : "delivery", label: l.what, live: false });
  }
  // What the tasks hand over: the owner's result goes to its `deliverTo`.
  for (const t of snap?.tasks ?? []) {
    if (!t.deliverTo || t.deliverTo === t.owner) continue;
    const live = t.status === "doing" || t.status === "delivered";
    const known = out.find((e) => e.from === t.owner && e.to === t.deliverTo && e.kind === "delivery");
    if (known) {
      known.live ||= live;
      if (!known.label) known.label = t.title;
    } else if (!has(t.owner, t.deliverTo)) {
      out.push({ from: t.owner, to: t.deliverTo, kind: "delivery", label: t.title, live });
    }
  }
  // The leader hands out every task and reviews every result.
  for (const m of config.members) {
    if (m.id === config.leader || has(config.leader, m.id) || has(m.id, config.leader)) continue;
    const working = snap?.tasks.some((t) => t.owner === m.id && t.status === "doing") ?? false;
    out.push({ from: config.leader, to: m.id, kind: "lead", label: "", live: working });
  }
  return out;
}

/** Where each member sits: the leader on top, the others in an arc below. */
function places(config: TeamConfig): Map<string, { x: number; y: number }> {
  const at = new Map<string, { x: number; y: number }>();
  const others = config.members.filter((m) => m.id !== config.leader);
  at.set(config.leader, { x: 50, y: 16 });
  const n = others.length;
  others.forEach((m, i) => {
    if (n === 1) return at.set(m.id, { x: 50, y: 74 });
    if (n === 2) return at.set(m.id, { x: i === 0 ? 24 : 76, y: 66 });
    // An arc from left to right, lower in the middle.
    const t = i / (n - 1);
    const angle = Math.PI * (1 - t);
    at.set(m.id, { x: 50 + Math.cos(angle) * 40, y: 56 + Math.sin(angle) * 28 });
  });
  return at;
}

/** Draws the lines once the nodes are in place: from border to border, curved apart when they run both ways. */
function drawEdges(map: HTMLElement, svg: SVGSVGElement, list: Edge[], config: TeamConfig, snap: Snapshot | undefined, page: Page) {
  const box = map.getBoundingClientRect();
  if (!box.width) return;
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  while (svg.lastChild && svg.lastChild.nodeName !== "defs") svg.removeChild(svg.lastChild);
  const rect = (id: string) => map.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  const ns = "http://www.w3.org/2000/svg";
  // Where a line from a box's centre towards a point leaves the box.
  const exit = (r: DOMRect, tx: number, ty: number) => {
    const cx = r.left + r.width / 2 - box.left;
    const cy = r.top + r.height / 2 - box.top;
    const dx = tx - cx;
    const dy = ty - cy;
    const s = Math.min(Math.abs((r.width / 2 + 6) / (dx || 1e-6)), Math.abs((r.height / 2 + 6) / (dy || 1e-6)));
    return { x: cx + dx * s, y: cy + dy * s };
  };
  for (const e of list) {
    const a = rect(e.from);
    const b = rect(e.to);
    if (!a || !b) continue;
    const ac = { x: a.left + a.width / 2 - box.left, y: a.top + a.height / 2 - box.top };
    const bc = { x: b.left + b.width / 2 - box.left, y: b.top + b.height / 2 - box.top };
    const both = list.some((o) => o !== e && o.from === e.to && o.to === e.from);
    const p = exit(a, bc.x, bc.y);
    const q = exit(b, ac.x, ac.y);
    // Bend the line: a little always, more when another runs the other way.
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const bend = both ? 34 : 14;
    const cx = mx + (-(q.y - p.y) / len) * bend;
    const cy = my + ((q.x - p.x) / len) * bend;
    const color = e.kind === "lead" ? "rgba(245,246,248,0.32)" : page.colorOf(config, e.from);
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", `M ${p.x} ${p.y} Q ${cx} ${cy} ${q.x} ${q.y}`);
    path.setAttribute("class", `edge ${e.kind}${e.live ? " live" : ""}`);
    path.setAttribute("stroke", color);
    path.setAttribute("marker-end", e.kind === "talk" ? "" : `url(#arrow-${e.kind === "lead" ? "lead" : e.from})`);
    svg.append(path);
    if (e.label) {
      const lx = 0.25 * p.x + 0.5 * cx + 0.25 * q.x;
      const ly = 0.25 * p.y + 0.5 * cy + 0.25 * q.y;
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", String(lx));
      label.setAttribute("y", String(ly - 6));
      label.setAttribute("class", "edge-label");
      label.textContent = short(e.label, 16);
      svg.append(label);
    }
  }
  // An arrowhead in each member's colour.
  const defs = svg.querySelector("defs")!;
  defs.replaceChildren();
  const marker = (id: string, color: string) => {
    const m = document.createElementNS(ns, "marker");
    m.setAttribute("id", id);
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", "8");
    m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "7");
    m.setAttribute("markerHeight", "7");
    m.setAttribute("orient", "auto-start-reverse");
    const tip = document.createElementNS(ns, "path");
    tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    tip.setAttribute("fill", color);
    m.append(tip);
    defs.append(m);
  };
  marker("arrow-lead", "rgba(245,246,248,0.4)");
  for (const m of config.members) marker(`arrow-${m.id}`, page.colorOf(config, m.id));
  void snap;
}

export function linksScreen(config: TeamConfig, snap: Snapshot | undefined, page: Page): HTMLElement {
  const list = edges(config, snap);
  const at = places(config);
  let chosen = focus.get(config.id) ?? config.leader;
  if (!config.members.some((m) => m.id === chosen)) chosen = config.members[0]?.id ?? "";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "map-lines");
  svg.append(document.createElementNS("http://www.w3.org/2000/svg", "defs"));
  const map = h("div", { class: "map" });
  map.append(svg);
  for (const m of config.members) {
    const p = at.get(m.id)!;
    const view = snap?.members.find((x) => x.id === m.id);
    const node = h(
      "button",
      {
        type: "button",
        class: `map-node${m.id === chosen ? " on" : ""}${view ? ` ${view.status}` : ""}`,
        "data-node": m.id,
        style: `left:${p.x}%;top:${p.y}%;--c:${page.colorOf(config, m.id)}`,
        title: m.duty,
        onClick: () => {
          focus.set(config.id, m.id);
          page.render();
        },
      },
      m.id === config.leader ? h("i", { class: "crown-mini", text: "♛" }) : null,
      page.blob(page.colorOf(config, m.id), 40),
      h("span", { class: "map-name", text: m.id === config.leader ? `${m.name} · Leader` : m.name }),
      h("span", { class: "map-role", text: m.role || "未設定角色" }),
      view ? h("span", { class: `map-state ${view.status}`, text: STATUS_WORD[view.status] }) : null,
    );
    map.append(node);
  }
  // The lines need the nodes laid out; and again whenever the map changes size.
  const redraw = () => drawEdges(map, svg, list, config, snap, page);
  requestAnimationFrame(redraw);
  const watch = new ResizeObserver(() => (map.isConnected ? redraw() : watch.disconnect()));
  watch.observe(map);

  const mapPanel = h(
    "section",
    { class: "panel map-panel" },
    h(
      "div",
      { class: "panel-head" },
      h("h2", { text: "協作地圖" }),
      h(
        "span",
        { class: "legend" },
        h("i", { class: "key solid" }),
        "交付",
        h("i", { class: "key dashed" }),
        "溝通",
        h("i", { class: "key lead" }),
        "Leader 指派與審核",
        snap ? h("i", { class: "key live" }) : null,
        snap ? "正在進行" : null,
      ),
    ),
    h("p", { class: "hint", text: "點一位成員,看它的輸入、交付對象與完成條件。交付關係也可以在右邊調整。" }),
    map,
  );

  return h("div", { class: "links-screen" }, mapPanel, memberPanel(config, snap, chosen, page));
}

function memberPanel(config: TeamConfig, snap: Snapshot | undefined, id: string, page: Page): HTMLElement {
  const m = config.members.find((x) => x.id === id);
  if (!m) return h("section", { class: "panel" });
  const view = snap?.members.find((x) => x.id === id);
  const color = page.colorOf(config, id);
  const who = (other: string, what: string, removable?: () => void) =>
    h(
      "div",
      { class: "rel-row" },
      page.blob(page.colorOf(config, other), 20),
      h("span", { class: "rel-name", text: nameIn(config, snap, other) }),
      h("span", { class: "rel-what", text: what || "—" }),
      removable ? h("button", { type: "button", class: "icon-btn", title: "拿掉這個關係", "aria-label": "拿掉這個關係", onClick: removable }, "×") : null,
    );

  const drop = (link: TeamConfig["links"][number]) => () => {
    config.links = config.links.filter((l) => l !== link);
    page.touched();
    page.render();
  };

  // Where its work comes from: the links into it, and the tasks handed to it.
  const inputs = h("div", { class: "rel-list" });
  for (const l of config.links.filter((l) => l.to === id && l.kind === "delivery")) inputs.append(who(l.from, l.what, drop(l)));
  for (const t of snap?.tasks ?? []) {
    if (t.deliverTo === id && t.owner !== id && !config.links.some((l) => l.from === t.owner && l.to === id)) inputs.append(who(t.owner, `${t.id} · ${t.title}`));
  }
  if (id !== config.leader) inputs.append(who(config.leader, "任務與審核"));
  if (!inputs.childElementCount) inputs.append(h("p", { class: "hint", text: "沒有固定的輸入來源。" }));

  // Where its work goes.
  const outputs = h("div", { class: "rel-list" });
  for (const l of config.links.filter((l) => l.from === id && l.kind === "delivery")) outputs.append(who(l.to, l.what, drop(l)));
  for (const t of snap?.tasks ?? []) {
    if (t.owner === id && t.deliverTo && t.deliverTo !== id && !config.links.some((l) => l.from === id && l.to === t.deliverTo)) outputs.append(who(t.deliverTo, `${t.id} · ${t.title}`));
  }
  if (!outputs.childElementCount) outputs.append(h("p", { class: "hint", text: id === config.leader ? "Leader 的成果交給你。" : "沒有指定交付對象時,成果交給 Leader 驗收。" }));

  // A new hand-over, from this member to another.
  const others = config.members.filter((x) => x.id !== id);
  let target = others[0]?.id ?? "";
  const what = h("input", { class: "field", type: "text", placeholder: "交付什麼,例如:圖片素材", spellcheck: "false" }) as HTMLInputElement;
  const add = others.length
    ? h(
        "div",
        { class: "rel-add" },
        dropdown({ value: target, choices: others.map((x) => ({ value: x.id, label: `交給 ${x.name}`, hint: x.role })), onChange: (v) => (target = v), className: "narrow" }),
        what,
        h("button", {
          type: "button",
          class: "btn plain",
          onClick: () => {
            if (!target) return;
            config.links = [...config.links, { from: id, to: target, kind: "delivery", what: what.value.trim() }];
            page.touched();
            page.render();
          },
        }, "加入"),
      )
    : null;

  // Its current task's conditions, as claimed so far.
  const task = view?.task ? snap?.tasks.find((t) => t.id === view.task) : snap?.tasks.find((t) => t.owner === id && t.status !== "done");
  const criteria = task?.criteria.length
    ? h("div", { class: "checks" }, ...task.criteria.map((c) => h("div", { class: `check${c.claimed ? " on" : ""}` }, h("i", { text: c.claimed ? "✓" : "" }), c.text)))
    : h("p", { class: "hint", text: task ? "這個任務沒有列出完成條件。" : "目前沒有任務;Leader 指派時會寫上完成條件。" });

  const toggle = (label: string, hint: string, on: boolean, set: (v: boolean) => void) =>
    h(
      "button",
      {
        type: "button",
        class: `switch-row${on ? " on" : ""}`,
        role: "switch",
        "aria-checked": String(on),
        onClick: () => {
          set(!on);
          page.touched();
          page.render();
        },
      },
      h("span", { class: "switch-text" }, h("b", { text: label }), h("small", { text: hint })),
      h("i", { class: "switch" }),
    );

  return h(
    "section",
    { class: "panel member-panel", style: `--c:${color}` },
    h(
      "div",
      { class: "member-card" },
      page.blob(color, 44),
      h(
        "div",
        {},
        h("div", { class: "member-card-name", text: `${m.name}${m.role ? ` · ${m.role}` : ""}` }),
        h("div", { class: `member-card-state ${view?.status ?? "idle"}`, text: view ? STATUS_WORD[view.status] : id === config.leader ? "Leader" : "尚未啟動" }),
      ),
    ),
    h("label", { text: "角色職責" }),
    h("p", { class: "duty", text: m.duty || "還沒有寫職責(在「團隊設定」填寫)。" }),
    h("label", { text: "輸入來源" }),
    inputs,
    h("label", { text: "交付給" }),
    outputs,
    add,
    h("label", { text: task ? `完成條件 · ${task.id}` : "完成條件" }),
    criteria,
    h("label", { text: "溝通設定(整個團隊)" }),
    toggle("成員可直接溝通", "關掉時,成員只能透過 Leader 傳話", config.directTalk, (v) => (config.directTalk = v)),
    toggle("共用任務與成果", "每位成員都看得到整個任務看板與交付成果", config.sharedBoard, (v) => (config.sharedBoard = v)),
    h(
      "div",
      { class: "row end" },
      snap && snap.status !== "finished" ? h("span", { class: "hint", text: "執行中的團隊下次啟動才會套用。" }) : null,
      h("button", { type: "button", class: "btn primary", onClick: () => void page.act(page.save) }, "儲存"),
    ),
  );
}

// ── 溝通紀錄 ──────────────────────────────────────────────────────────────────

interface Thread {
  key: string;
  title: string;
  task: Task | null;
  people: string[];
  messages: Message[];
  events: FeedItem[];
  last: number;
  blocked: boolean;
  delivered: boolean;
}

const OTHER = "_other";
const chosenThread = new Map<string, string>();
let filter: "all" | "blocked" | "delivered" = "all";
let query = "";

/** Opens the log on a task's thread, with nothing filtering it out. */
export function openThread(team: string, task: string) {
  chosenThread.set(team, task);
  filter = "all";
  query = "";
}

/** Every exchange of the team, gathered by the task it is about. */
function threads(snap: Snapshot): Thread[] {
  const byKey = new Map<string, Thread>();
  const thread = (key: string) => {
    let t = byKey.get(key);
    if (!t) {
      const task = key === OTHER ? null : snap.tasks.find((x) => x.id === key) ?? null;
      t = { key, title: task?.title ?? (key === OTHER ? "團隊對話" : key), task, people: [], messages: [], events: [], last: 0, blocked: false, delivered: false };
      byKey.set(key, t);
    }
    return t;
  };
  const meet = (t: Thread, who: string) => {
    if (who && who !== SYSTEM && !t.people.includes(who)) t.people.push(who);
  };
  for (const m of snap.messages) {
    const t = thread(m.task ?? OTHER);
    t.messages.push(m);
    meet(t, m.from);
    meet(t, m.to);
    t.last = Math.max(t.last, m.at);
  }
  for (const f of snap.feed) {
    if (f.kind === "message" || !f.task) continue;
    const t = thread(f.task);
    t.events.push(f);
    meet(t, f.from);
    t.last = Math.max(t.last, f.at);
    if (f.kind === "blocked") t.blocked = true;
    if (f.kind === "delivered" || f.kind === "accepted") t.delivered = true;
  }
  for (const t of byKey.values()) {
    if (t.task?.blocked) t.blocked = true;
    if (t.task && (t.task.status === "delivered" || t.task.status === "done")) t.delivered = true;
  }
  return [...byKey.values()].sort((a, b) => b.last - a.last);
}

const EVENT_WORD: Partial<Record<FeedItem["kind"], string>> = {
  task: "建立任務",
  delivered: "交付成果",
  accepted: "驗收通過",
  rejected: "退回修改",
  blocked: "被卡住",
  asked: "向你提問",
  answered: "你的回覆",
  lost: "失聯",
  joined: "加入團隊",
};

export function logScreen(config: TeamConfig, snap: Snapshot, page: Page): HTMLElement {
  const all = threads(snap);
  const shown = all.filter((t) => {
    if (filter === "blocked" && !t.blocked) return false;
    if (filter === "delivered" && !t.delivered) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return t.title.toLowerCase().includes(q) || (t.task?.id.toLowerCase().includes(q) ?? false) || t.messages.some((m) => m.text.toLowerCase().includes(q));
  });
  let key = chosenThread.get(snap.id);
  if (!key || !all.some((t) => t.key === key)) key = shown[0]?.key ?? all[0]?.key;
  const current = all.find((t) => t.key === key);

  // ── Left: the threads ──
  const search = h("input", { class: "field", type: "search", placeholder: "搜尋訊息或任務", value: query, "data-key": "log-search", spellcheck: "false" }) as HTMLInputElement;
  search.addEventListener("input", () => {
    query = search.value;
    page.render();
  });
  const chip = (id: typeof filter, label: string) =>
    h("button", { type: "button", class: `filter${filter === id ? " on" : ""}`, onClick: () => ((filter = id), page.render()) }, label);
  const list = h("div", { class: "threads" });
  for (const t of shown) {
    const count = t.messages.filter((m) => m.from !== SYSTEM).length;
    list.append(
      h(
        "button",
        { type: "button", class: `thread${t.key === key ? " on" : ""}`, onClick: () => (chosenThread.set(snap.id, t.key), page.render()) },
        h("span", { class: "thread-faces" }, ...t.people.filter((p) => p !== YOU).slice(0, 3).map((p) => page.blob(page.colorOf(snap, p), 22))),
        h(
          "span",
          { class: "thread-body" },
          h("span", { class: "thread-title" }, t.blocked ? h("i", { class: "flag blocked", text: "!" }) : null, t.title),
          h("span", { class: "thread-sub", text: `${t.people.map((p) => nameIn(config, snap, p)).join("、") || "Coucou"} · ${count} 則訊息` }),
        ),
        h("time", { text: t.last ? clock(t.last) : "" }),
      ),
    );
  }
  if (!shown.length) list.append(h("p", { class: "hint", text: all.length ? "沒有符合的對話。" : "團隊還沒有任何對話。" }));
  const left = h("section", { class: "panel log-threads" }, search, h("div", { class: "filters" }, chip("all", "全部"), chip("blocked", "阻塞"), chip("delivered", "交付")), list);

  // ── Middle: the conversation ──
  const convo = h("div", { class: "convo" });
  if (current) {
    const items: ({ at: number; message: Message } | { at: number; event: FeedItem })[] = [
      ...current.messages.map((m) => ({ at: m.at, message: m })),
      ...current.events.map((e) => ({ at: e.at, event: e })),
    ].sort((a, b) => a.at - b.at);
    for (const item of items) {
      if ("message" in item) {
        const m = item.message;
        if (m.from === SYSTEM) {
          // What Coucou handed over, in a line.
          convo.append(h("div", { class: "convo-note" }, h("b", { text: "Coucou" }), ` → ${nameIn(config, snap, m.to)}:${short(heardWords(m.text), 120)}`, h("time", { text: clock(m.at) })));
          continue;
        }
        const mine = m.from === YOU;
        const member = config.members.find((x) => x.id === m.from);
        convo.append(
          h(
            "div",
            { class: `convo-msg${mine ? " mine" : ""}`, style: `--c:${mine ? "#f5f6f8" : page.colorOf(snap, m.from)}` },
            mine ? null : page.blob(page.colorOf(snap, m.from), 30),
            h(
              "div",
              { class: "convo-bubble-wrap" },
              h("div", { class: "convo-head" }, h("b", { text: nameIn(config, snap, m.from) }), member?.role ? h("span", { text: member.role }) : null, h("span", { text: `→ ${nameIn(config, snap, m.to)}` }), h("time", { text: clock(m.at) })),
              h("div", { class: "convo-bubble", text: m.text }),
              !m.heard && m.to !== YOU ? h("div", { class: "convo-unread", text: "對方下一輪才會讀到" }) : null,
            ),
          ),
        );
      } else {
        const e = item.event;
        convo.append(
          h(
            "div",
            { class: `convo-event ev-${e.kind}` },
            page.blob(page.colorOf(snap, e.from), 22),
            h("span", {}, h("b", { text: `${nameIn(config, snap, e.from)} ${EVENT_WORD[e.kind] ?? e.kind}` }), e.text ? ` · ${short(page.said(e.text), 140)}` : ""),
            h("time", { text: clock(e.at) }),
          ),
        );
      }
    }
    if (!items.length) convo.append(h("p", { class: "hint", text: "這裡還沒有對話。" }));
  }
  const mid = h(
    "section",
    { class: "panel log-convo" },
    current
      ? h(
          "div",
          { class: "convo-top" },
          h("h2", { text: current.title }),
          current.task ? h("span", { class: "chip", text: current.task.id }) : null,
          h("span", { class: "convo-people" }, ...current.people.filter((p) => p !== YOU).map((p) => page.blob(page.colorOf(snap, p), 20)), h("span", { class: "hint", text: current.people.map((p) => nameIn(config, snap, p)).join("、") })),
        )
      : h("h2", { text: "溝通紀錄" }),
    convo,
    snap.status === "finished" ? null : page.composer(snap),
  );
  requestAnimationFrame(() => (convo.scrollTop = convo.scrollHeight));

  return h("div", { class: "log-screen" }, left, mid, taskPanel(config, snap, current?.task ?? null, page));
}

function taskPanel(config: TeamConfig, snap: Snapshot, task: Task | null, page: Page): HTMLElement {
  if (!task) {
    return h("section", { class: "panel log-task" }, h("h2", { text: "關聯任務" }), h("p", { class: "hint", text: "這段對話沒有綁定任務。選左邊一個任務,這裡會列出它的負責人、完成條件、依賴與成果。" }));
  }
  const person = (label: string, id: string | null) =>
    id
      ? h("div", { class: "fact" }, h("span", { class: "fact-k", text: label }), h("span", { class: "fact-v" }, page.blob(page.colorOf(snap, id), 18), nameIn(config, snap, id), h("small", { text: config.members.find((m) => m.id === id)?.role ?? "" })))
      : null;
  const met = task.criteria.filter((c) => c.claimed).length;
  const deps = task.dependsOn.map((d) => snap.tasks.find((t) => t.id === d)).filter(Boolean) as Task[];
  const handed = snap.deliverables.filter((d) => d.task === task.id);
  return h(
    "section",
    { class: "panel log-task" },
    h("h2", { text: "關聯任務" }),
    h(
      "div",
      { class: "task-card-big" },
      h("span", { class: "chip", text: task.id }),
      h("b", { text: task.title }),
      h("span", { class: `chip state ${task.status}`, text: task.blocked ? "被卡住" : TASK_WORD[task.status] }),
    ),
    task.detail ? h("p", { class: "duty", text: short(task.detail, 220) }) : null,
    person("負責人", task.owner),
    person("Leader", config.leader),
    person("交付給", task.deliverTo),
    task.blocked ? h("p", { class: "problem", text: `卡住:${task.blocked.reason}(等 ${nameIn(config, snap, task.blocked.on)})` }) : null,
    h("label", { text: `完成條件 ${task.criteria.length ? `${met} / ${task.criteria.length}` : ""}` }),
    task.criteria.length
      ? h("div", { class: "checks" }, ...task.criteria.map((c) => h("div", { class: `check${c.claimed ? " on" : ""}` }, h("i", { text: c.claimed ? "✓" : "" }), c.text)))
      : h("p", { class: "hint", text: "沒有列出完成條件。" }),
    deps.length ? h("label", { text: `依賴項目 ${deps.filter((d) => d.status === "delivered" || d.status === "done").length} / ${deps.length}` }) : null,
    deps.length
      ? h("div", { class: "checks" }, ...deps.map((d) => h("div", { class: `check${d.status === "delivered" || d.status === "done" ? " on" : ""}` }, h("i", { text: d.status === "delivered" || d.status === "done" ? "✓" : "" }), `${d.id} · ${d.title}`)))
      : null,
    h("label", { text: "關聯成果" }),
    handed.length
      ? h(
          "div",
          { class: "rel-list" },
          ...handed.map((d) =>
            h(
              "button",
              { type: "button", class: "deliverable small", title: `開啟 ${d.locator}`, onClick: () => void page.act(() => Bridge.teamOpen(snap.id, d.locator)) },
              h("span", { class: "deliverable-body" }, h("span", { class: "deliverable-name", text: d.locator }), h("span", { class: "dim", text: `${nameIn(config, snap, d.by)} · ${clock(d.at)} · ${short(d.summary, 60)}` })),
              h("span", { class: `chip ${d.accepted === true ? "ok" : d.accepted === false ? "warn" : "pending"}`, text: d.accepted === true ? "已驗收" : d.accepted === false ? "已退回" : "待驗收" }),
            ),
          ),
        )
      : h("p", { class: "hint", text: "還沒有交付成果。" }),
  );
}
