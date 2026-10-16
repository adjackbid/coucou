// The marks of where an agent works, shared by the settings window and
// Teamwork: a Cloud Agent is a cloud with eyes, a Local Agent a little house
// with eyes, and an n8n node — a kind of Local Agent — three linked nodes.
// Drawn like the settings icons (settings/icons.ts): duotone on a 24×24
// grid, `--a` the accent, `--s` the accent at 22 % for soft fills, white
// for the detail.

import { tr } from "../core/i18n";
import { locationOf, type AgentLocation, type AgentProfile } from "../core/state";

export type KindMark = AgentLocation | "n8n";

const MARKS: Record<KindMark, { a: string; svg: string }> = {
  cloud: {
    a: "#4FB3FF",
    svg: `<path d="M7 19H17.5A4 4 0 0 0 18.2 11.06A6 6 0 0 0 6.6 10.5A4.3 4.3 0 0 0 7 19Z" fill="var(--s)" stroke="var(--a)"/>
<circle cx="10" cy="14.6" r="1.25" fill="#fff" stroke="none"/><circle cx="14.4" cy="14.6" r="1.25" fill="#fff" stroke="none"/>`,
  },
  local: {
    a: "#34D399",
    svg: `<path d="M3.5 11 12 4l8.5 7v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" fill="var(--s)" stroke="var(--a)"/>
<circle cx="9.6" cy="14.6" r="1.25" fill="#fff" stroke="none"/><circle cx="14.4" cy="14.6" r="1.25" fill="#fff" stroke="none"/>`,
  },
  n8n: {
    a: "#F472B6",
    svg: `<circle cx="5" cy="12" r="2.4" fill="var(--s)" stroke="var(--a)"/><circle cx="19" cy="6.5" r="2.4" fill="var(--s)" stroke="var(--a)"/><circle cx="19" cy="17.5" r="2.4" fill="var(--s)" stroke="var(--a)"/>
<path d="M7.4 12H11M11 12c2.6 0 3-5.5 5.6-5.5M11 12c2.6 0 3 5.5 5.6 5.5" stroke="#fff"/>`,
  },
};

const NS = "http://www.w3.org/2000/svg";

/** The accent of a mark, for borders and tints beside it. */
export function markColor(mark: KindMark): string {
  return MARKS[mark].a;
}

/** One mark as an <svg>, `size` px square, titled for whoever cannot see it. */
export function kindIcon(mark: KindMark, size = 16): SVGSVGElement {
  const { a, svg } = MARKS[mark];
  const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${svg}</svg>`, "image/svg+xml");
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke-width", "1.6");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.setAttribute("role", "img");
  el.setAttribute("class", `kind-mark ${mark}`);
  el.style.setProperty("--a", a);
  el.style.setProperty("--s", `color-mix(in srgb, ${a} 22%, transparent)`);
  const title = document.createElementNS(NS, "title");
  title.textContent = markName(mark);
  el.append(title);
  for (const child of [...doc.documentElement.childNodes]) el.append(document.importNode(child, true));
  return el;
}

/** "Cloud Agent", "Local Agent" or "n8n 節點". */
export function markName(mark: KindMark): string {
  if (mark === "n8n") return tr("n8n 節點", "n8n node");
  return mark === "cloud" ? "Cloud Agent" : "Local Agent"; // i18n-ok: the same in both
}

/** One line on what the kind means, for hints and titles. */
export function markHint(mark: KindMark): string {
  switch (mark) {
    case "cloud": return tr("在雲端服務上工作:資料會送到那個服務。", "Works on a cloud service: the work is sent to it.");
    case "local": return tr("在地端服務上工作:資料留在你的電腦或公司網路裡。", "Works on an on-premises service: the work stays on your own machine or network.");
    case "n8n": return tr("n8n 工作流程,透過 Webhook 呼叫;接一件任務、交一份結果,不能當 Leader。", "An n8n workflow, called through its webhook: it takes one task and hands back one result, and cannot lead.");
  }
}

/** The mark an agent's place earns: its location, or n8n for a workflow. */
export function markOf(a: Pick<AgentProfile, "protocol" | "location" | "env">): KindMark {
  return a.protocol === "n8n" ? "n8n" : locationOf(a);
}
