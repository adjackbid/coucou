// Agent Center picking a team, shown: every agent of Agent Pool round
// Agent Center (Local Agents inside, Cloud Agents outside, as on Agent Pool's
// ring). Two phases. While Agent Center looks the agents over, the sweep
// keeps going round and each agent it looks at lights up (`picks` null).
// When its proposal comes, the sweep goes round once more and each member it
// picked locks on as the sweep passes it — lit, drawn to the centre, added to
// the list beside — while the rest dim. Drawn again later, each phase carries
// on from where it was. Off unless the person turns it on (Agent Center's ⚙),
// where it can also be previewed.

import "./pick-show.css";
import { tr, trf } from "../core/i18n";
import { kindIcon, markColor, type KindMark } from "../views/agent-kind";
import { h } from "../views/dom";

/** One agent of Agent Pool, as the show draws it. */
export interface PoolAgent {
  id: string;
  name: string;
  category: string;
  where: "cloud" | "local";
  mark: KindMark;
  face: string;
}

/** One member of the proposed team (secretary.rs Pick). */
export interface Pick {
  agent: string;
  name: string;
  role: string;
  leader: boolean;
}

/** When the sweep starts, and how long it takes to go round. */
const LEAD = 450;
const SWEEP = 2600;
/** How long the picking takes, from its proposal to the last lock. */
export const SHOW_MS = LEAD + SWEEP;
/** One turn of the sweep while Agent Center is still looking: as fast as the last one, so the change is not seen. */
const SPIN = SWEEP;

/** When each show began, by proposal: a redraw carries on from there. */
const began = new Map<string, number>();

const HUB =
  '<svg viewBox="0 0 64 64" width="40" height="40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><path d="M32 5 55.4 18.5v27L32 59 8.6 45.5v-27Z"/><circle cx="32" cy="32" r="11.5" stroke-width="1.6" opacity=".7"/><circle cx="32" cy="32" r="4.6" fill="currentColor" stroke="none"/><circle cx="32" cy="20.5" r="2.1" fill="currentColor" stroke="none"/><circle cx="42" cy="37.8" r="2.1" fill="currentColor" stroke="none"/><circle cx="22" cy="37.8" r="2.1" fill="currentColor" stroke="none"/></svg>';

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function forgetShow(id: string) {
  began.delete(id);
}

/** How long until the looking's sweep is back at the top, where the picking's starts. */
export function turnLeft(id: string): number {
  const at = began.get(id);
  return at === undefined ? 0 : SPIN - ((performance.now() - at) % SPIN);
}

/** A breathing that goes on across redraws: its phase from the clock, not from when it was drawn. */
function phase(period: number): string {
  return `--b:${-(performance.now() % period)}ms`;
}

/**
 * `picks` null: still looking; `seenAt` the agents looked at so far, by when
 * (performance.now()). `continued`: the looking was on screen just before and
 * its sweep has just come back to the top, so the picking carries straight on.
 */
export function pickShow(id: string, picks: Pick[] | null, pool: PoolAgent[], opts: { seenAt?: Record<string, number>; continued?: boolean } = {}): HTMLElement {
  if (!began.has(id)) began.set(id, performance.now());
  const now = performance.now();
  const since = now - began.get(id)!;
  const lead = opts.continued ? 0 : LEAD;
  const end = lead + SWEEP;
  const scanning = picks === null;
  const seenAt = opts.seenAt ?? {};
  const seen = new Set(Object.keys(seenAt));
  picks = picks ?? [];

  // Local Agents on the inner ring, Cloud Agents on the outer; each ring far enough out for its names.
  const rings = (["local", "cloud"] as const).map((w) => pool.filter((p) => p.where === w)).filter((r) => r.length);
  const room = (n: number) => (n * 92) / (2 * Math.PI);
  const radii: number[] = [];
  for (const r of rings) radii.push(Math.max(radii.length ? radii[radii.length - 1] + 105 : 140, room(r.length)));
  const R = radii[radii.length - 1] ?? 160;
  const S = 2 * R + 150;
  const c = S / 2;
  const chosen = new Set(picks.map((p) => p.agent));

  const nodes: { p: PoolAgent; x: number; y: number; t: number }[] = [];
  // The inner ring turned to stand as far as it can from the outer agents, so no two names meet.
  let inner = 0;
  if (rings.length > 1) {
    const outer = rings[1].map((_, j) => (j * 2 * Math.PI) / rings[1].length);
    const step = (2 * Math.PI) / rings[0].length;
    const gap = (turn: number) =>
      Math.min(...rings[0].flatMap((_, j) => outer.map((o) => {
        const d = Math.abs((((j * step + turn - o) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
        return Math.min(d, 2 * Math.PI - d);
      })));
    for (let n = 0; n < 24; n++) if (gap((n / 24) * step) > gap(inner) + 1e-6) inner = (n / 24) * step;
  }
  rings.forEach((ring, k) => {
    const step = (2 * Math.PI) / ring.length;
    const turn = k === 0 && rings.length > 1 ? inner : 0;
    ring.forEach((p, j) => {
      const a = -Math.PI / 2 + j * step + turn;
      // The sweep starts at the top and goes clockwise: it reaches this one at…
      const frac = (((a + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
      nodes.push({ p, x: c + radii[k] * Math.cos(a), y: c + radii[k] * Math.sin(a), t: lead + SWEEP * frac });
    });
  });
  const lockAt = (agent: string) => (nodes.find((n) => n.p.id === agent)?.t ?? end) + 150;
  const order = [...picks].sort((a, b) => lockAt(a.agent) - lockAt(b.agent));

  const lines = svgEl("svg", { class: "ps-lines", viewBox: `0 0 ${S} ${S}`, "aria-hidden": "true" });
  for (const r of radii) lines.append(svgEl("circle", { class: "ps-orbit", cx: c, cy: c, r }));
  for (const n of scanning ? [] : nodes.filter((n) => chosen.has(n.p.id))) {
    const line = svgEl("line", { class: "ps-link", x1: c, y1: c, x2: n.x, y2: n.y, pathLength: 1 });
    line.setAttribute("style", `animation-delay:${n.t + 150 - since}ms`);
    lines.append(line);
    const knot = svgEl("circle", { class: "ps-knot", cx: (c + n.x) / 2, cy: (c + n.y) / 2, r: 4 });
    knot.setAttribute("style", `animation-delay:${n.t + 350 - since}ms`);
    lines.append(knot);
  }

  const node = (n: (typeof nodes)[number], i: number) => {
    const picked = chosen.has(n.p.id);
    // An agent looked at stays lit until the picking locks it on or dims it.
    const state = `${scanning ? " scanning" : picked ? " picked" : ""}${seen.has(n.p.id) ? " seen" : ""}`;
    return h(
      "div",
      {
        class: `ps-node${state}`,
        style: `left:${(n.x / S) * 100}%;top:${(n.y / S) * 100}%;--m:${markColor(n.p.mark)};--c:${n.p.face};--in:${opts.continued ? -9999 : i * 22 - since}ms;--d:${n.t - since}ms;--e:${end - since}ms;--s:${(seenAt[n.p.id] ?? now) - now}ms`,
        title: n.p.category ? `${n.p.name} · ${n.p.category}` : n.p.name,
      },
      h("span", { class: "ps-ring" }, h("i", { class: "blob", style: `--c:${n.p.face};--s:20px`, "aria-hidden": "true" })),
      h("span", { class: "ps-name" }, kindIcon(n.p.mark, 11), h("span", { text: n.p.name })),
      n.p.category ? h("span", { class: "ps-cat", text: n.p.category }) : null,
    );
  };

  // How many are picked so far: counted up as each locks on, while it is on screen.
  const total = pool.length;
  const count = h("b", { text: String(scanning ? seen.size : order.filter((p) => lockAt(p.agent) <= since).length) });
  for (const p of scanning ? [] : order) {
    const wait = lockAt(p.agent) - since;
    if (wait > 0) setTimeout(() => count.isConnected && (count.textContent = String(order.filter((q) => lockAt(q.agent) <= performance.now() - began.get(id)!).length)), wait + 10);
  }

  const name = (agent: string) => pool.find((p) => p.id === agent);
  return h(
    "section",
    {
      class: `ps${scanning ? " scanning" : ""}`,
      role: "img",
      "aria-label": scanning ? trf("Agent Center 正在從 {n} 位 Agent 裡挑人", "Agent Center is looking over {n} agents", { n: total }) : trf("Agent Center 從 {n} 位 Agent 裡挑出 {k} 位", "Agent Center picks {k} of {n} agents", { n: total, k: picks.length }),
    },
    h(
      "div",
      { class: "ps-title" },
      h("b", { text: tr("Agent Center 挑人", "Agent Center picks a team") }),
      // The looking's words stay through the picking and give way to its outcome: one place, no jump.
      h(
        "span",
        { class: "ps-subs" },
        scanning || opts.continued
          ? h("span", { class: `ps-sub live${scanning ? "" : " going"}`, style: `${phase(1600)};--o:${end - since}ms`, text: trf("正在看 Agent Pool 裡的 {n} 位…", "Looking over the {n} agents in Agent Pool…", { n: total }) })
          : null,
        scanning ? null : h("span", { class: "ps-sub", style: `animation-delay:${end - since}ms`, text: trf("從 {n} 位裡選出 {k} 位", "{k} picked of {n}", { n: total, k: picks.length }) }),
      ),
    ),
    h(
      "div",
      { class: "ps-body" },
      h(
        "div",
        { class: "ps-stage" },
        h(
          "div",
          { class: "ps-field" },
          lines,
          h("div", {
            class: `ps-sweep${scanning ? " spin" : opts.continued ? " cont" : ""}`,
            style: `width:${((2 * (R + 40)) / S) * 100}%;height:${((2 * (R + 40)) / S) * 100}%;animation-delay:${scanning ? -(since % SPIN) : lead - since}ms`,
          }),
          h("div", { class: "ps-hub" }, h("span", { class: "ps-core", html: HUB }), h("b", { text: "Agent Center" })),
          ...nodes.map(node),
        ),
        h("div", { class: "ps-count" }, h("span", { text: scanning ? tr("看過", "Looked at") : tr("已挑選", "Picked") }), h("div", { class: "ps-count-n" }, count, h("span", { text: ` / ${total}` }))),
      ),
      h(
        "ol",
        { class: "ps-list" },
        ...order.map((p) => {
          const a = name(p.agent);
          return h(
            "li",
            { class: "ps-row", style: `--c:${a?.face ?? "#8b7cff"};animation-delay:${lockAt(p.agent) + 60 - since}ms` },
            h("i", { class: "blob", style: `--c:${a?.face ?? "#8b7cff"};--s:18px`, "aria-hidden": "true" }),
            h("b", { text: a?.name ?? p.agent }),
            h("span", { class: "ps-role", text: [p.name, p.role, p.leader ? "Leader" : ""].filter(Boolean).join(" · ") }), // i18n-ok: the same in both
          );
        }),
        // "Picking…" under the members as they come, gone once the last is in.
        scanning || opts.continued
          ? h(
              "li",
              { class: `ps-row wait${scanning ? "" : " going"}`, style: `--o:${(order.length ? lockAt(order[order.length - 1].agent) + 200 : end) - since}ms` },
              h("span", { text: tr("挑選中", "Picking") }),
              h("span", { class: "ps-dots", style: `--t:${-(performance.now() % 1000)}ms`, "aria-hidden": "true" }, h("i"), h("i"), h("i")),
            )
          : null,
      ),
    ),
  );
}
