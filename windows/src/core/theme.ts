// Light or dark: the settings window and Teamwork wear the person's choice
// (Settings → 一般 → 外觀) as <html data-theme>, and their CSS redefines its
// colours under [data-theme="light"]. The island stays dark, as a notch is.
// In a plain browser, `?theme=light` tries the light look.

export type Theme = "dark" | "light";

export function applyTheme(theme: string | undefined | null) {
  const asked = new URLSearchParams(location.search).get("theme");
  const pick = import.meta.env.DEV && (asked === "light" || asked === "dark") ? asked : theme;
  document.documentElement.dataset.theme = pick === "light" ? "light" : "dark";
  // The settings page paints its body dark inline, against a white flash while it loads: from here the CSS decides.
  document.body?.style.removeProperty("background");
  document.body?.style.removeProperty("color");
}
