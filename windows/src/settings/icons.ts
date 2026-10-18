// The settings window's own icons: duotone drawings on a 24×24 grid, one
// accent per page. `--a` is the accent, `--s` the accent at 22 % for soft
// fills, white is the detail. Source of truth: feature/ui/設定畫面-圖示預覽.html.

export type IconKey =
  | "overview" | "connect" | "install" | "chat" | "agents" | "integrations"
  | "island" | "team" | "general" | "guide" | "language" | "skills";

const ICONS: Record<IconKey, { a: string; svg: string }> = {
  overview: {
    a: "#8AB4F8",
    svg: `<rect x="3" y="3" width="8" height="8" rx="2.2" fill="var(--s)" stroke="var(--a)"/>
<rect x="13" y="3" width="8" height="5" rx="2" stroke="var(--a)"/>
<rect x="13" y="10" width="8" height="11" rx="2.2" fill="var(--s)" stroke="var(--a)"/>
<rect x="3" y="13" width="8" height="8" rx="2.2" stroke="var(--a)"/>
<path d="M15.5 16.2l1.6 1.6 2.6-3" stroke="#fff"/>`,
  },
  connect: {
    a: "#7EE787",
    svg: `<path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" stroke="var(--a)"/>
<path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" stroke="#fff"/>
<circle cx="19.2" cy="19.2" r="2.4" fill="var(--a)" stroke="none"/>`,
  },
  install: {
    a: "#C9956A",
    svg: `<path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" fill="var(--s)" stroke="var(--a)"/>
<path d="M4 8.5 12 13l8-4.5M12 13v7" stroke="var(--a)"/>
<path d="M12 2.5v6m-2.4-2.4L12 8.5l2.4-2.4" stroke="#fff"/>`,
  },
  chat: {
    a: "#C084FC",
    svg: `<path d="M4 5.5h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z" fill="var(--s)" stroke="var(--a)"/>
<path d="M18 9.5h1.8a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-.8v2.6l-3-2.6h-3.5a2 2 0 0 1-1.7-1" stroke="var(--a)"/>
<circle cx="6" cy="10" r=".9" fill="#fff" stroke="none"/><circle cx="9" cy="10" r=".9" fill="#fff" stroke="none"/><circle cx="12" cy="10" r=".9" fill="#fff" stroke="none"/>`,
  },
  agents: {
    a: "#22C55E",
    svg: `<rect x="4" y="7.5" width="16" height="12" rx="4.5" fill="var(--s)" stroke="var(--a)"/>
<path d="M12 7.5V4.5" stroke="var(--a)"/><circle cx="12" cy="3.6" r="1.4" fill="var(--a)" stroke="none"/>
<path d="M2 12.5v3M22 12.5v3" stroke="var(--a)"/>
<circle cx="9" cy="13" r="1.5" fill="#fff" stroke="none"/><circle cx="15" cy="13" r="1.5" fill="#fff" stroke="none"/>
<path d="M10 16.4c1.2.8 2.8.8 4 0" stroke="#fff"/>`,
  },
  integrations: {
    a: "#F29B38",
    svg: `<path d="M5 7h3.2a2.3 2.3 0 1 1 4.6 0H16v3.2a2.3 2.3 0 1 1 0 4.6V18h-3.2a2.3 2.3 0 1 0-4.6 0H5v-3.2a2.3 2.3 0 1 0 0-4.6z" fill="var(--s)" stroke="var(--a)"/>
<circle cx="19.5" cy="5" r="1.6" fill="#fff" stroke="none"/><circle cx="21" cy="9.5" r="1" fill="var(--a)" stroke="none"/>`,
  },
  island: {
    a: "#F5F6F8",
    svg: `<rect x="2.5" y="4" width="19" height="13" rx="2.5" stroke="#9398a1"/>
<rect x="8" y="4" width="8" height="3.6" rx="1.8" fill="#fff" stroke="none"/>
<circle cx="9.9" cy="5.8" r=".9" fill="#22C55E" stroke="none"/>
<path d="M9 20.5h6M12 17v3.5" stroke="#9398a1"/>`,
  },
  skills: {
    a: "#F5A524",
    svg: `<path d="M5 4.5h9.5A2.5 2.5 0 0 1 17 7v13.5H7.5A2.5 2.5 0 0 0 5 22.5Z" fill="var(--s)" stroke="var(--a)"/>
<path d="M5 4.5v18M7.5 20.5H17" stroke="var(--a)"/>
<path d="M9 9.5h5M9 13h5" stroke="#fff"/>
<path d="M19.5 2.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z" fill="#fff"/>`,
  },
  team: {
    a: "#F4505E",
    svg: `<circle cx="12" cy="7.5" r="3" fill="var(--s)" stroke="var(--a)"/>
<path d="M6.5 19.5a5.5 5.5 0 0 1 11 0" fill="var(--s)" stroke="var(--a)"/>
<circle cx="5" cy="9.5" r="2.2" stroke="#fff"/><circle cx="19" cy="9.5" r="2.2" stroke="#fff"/>
<path d="M1.8 18a3.6 3.6 0 0 1 4.2-3.4M22.2 18a3.6 3.6 0 0 0-4.2-3.4" stroke="#fff"/>`,
  },
  general: {
    a: "#9398A1",
    svg: `<path d="M4 6.5h16M4 12h16M4 17.5h16" stroke="#6b7079"/>
<circle cx="15" cy="6.5" r="2.3" fill="#0b0c0e" stroke="#fff"/>
<circle cx="8" cy="12" r="2.3" fill="#0b0c0e" stroke="var(--a)"/>
<circle cx="13" cy="17.5" r="2.3" fill="#0b0c0e" stroke="#fff"/>`,
  },
  guide: {
    a: "#FBBF24",
    svg: `<path d="M4 20V4.5" stroke="#9398a1"/>
<path d="M4 5h12.5l-2.5 3.8 2.5 3.8H4" fill="var(--s)" stroke="var(--a)"/>
<path d="M19 15.5l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" fill="#fff" stroke="none"/>`,
  },
  language: {
    a: "#38BDF8",
    svg: `<circle cx="12" cy="12" r="9" fill="var(--s)" stroke="var(--a)"/>
<path d="M3 12h18M12 3c2.6 2.5 3.8 5.5 3.8 9s-1.2 6.5-3.8 9M12 3C9.4 5.5 8.2 8.5 8.2 12s1.2 6.5 3.8 9" stroke="var(--a)"/>`,
  },
};

const NS = "http://www.w3.org/2000/svg";

/** One icon as an <svg>, `size` px square. */
export function icon(key: IconKey, size = 20): SVGSVGElement {
  const { a, svg } = ICONS[key];
  const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${svg}</svg>`, "image/svg+xml");
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke-width", "1.6");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("class", "icon");
  el.style.setProperty("--a", a);
  el.style.setProperty("--s", `color-mix(in srgb, ${a} 22%, transparent)`);
  for (const child of [...doc.documentElement.childNodes]) el.append(document.importNode(child, true));
  return el;
}
