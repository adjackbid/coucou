// Settings window — the place where anything that writes to disk is confirmed.
// A sidebar of pages (each with a badge for what is left), the page, and a
// setup guide for someone who has not connected anything yet.

import "./settings.css";
import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import { onLangChange, setLang } from "../core/i18n";
import { applyTheme } from "../core/theme";
import type { Settings } from "../core/state";
import { glassify } from "../team/ui";
import { Nav } from "./nav";
import { guideFlag, openGuide, redrawGuide } from "./guide";
import { shouldAutoShowGuide, type PageId } from "./status";
import {
  hooks, refreshClis, refreshHooks, refreshHotkey, refreshPresent, refreshTeamAgents, relabelClis,
  replaceSettings, setVersion, settings,
} from "./store";
import { overviewPage } from "./pages/overview";
import { connectPage } from "./pages/connect";
import { installPage } from "./pages/install";
import { chatPage } from "./pages/chat";
import { agentsPage } from "./pages/agents";
import { integrationsPage } from "./pages/integrations";
import { islandPage } from "./pages/island";
import { teamPage } from "./pages/team";
import { generalPage } from "./pages/general";

const root = document.getElementById("settings-root")!;

const PAGES = [overviewPage, connectPage, installPage, chatPage, agentsPage, integrationsPage, islandPage, teamPage, generalPage];

async function main() {
  applyTheme(settings.theme);
  // Native dropdowns and model lists are drawn by Windows as a white list: the window's own instead.
  glassify(root);
  const boot = await Bridge.boot();
  if (boot) {
    setLang(boot.lang);
    replaceSettings({ ...settings, ...boot.settings });
    setVersion(boot.version);
  }

  // What the first page needs before it is drawn; the CLIs (slow) come later.
  await Promise.all([refreshHooks(), refreshPresent(), refreshHotkey()]);

  const nav = new Nav(root, PAGES, (n) => openGuide(n, root));
  nav.start();
  void refreshClis();
  void refreshTeamAgents();

  onLangChange(() => {
    nav.redraw();
    redrawGuide();
    void relabelClis();
    // Rust words the shortcut's error again in the new language.
    void refreshHotkey();
  });
  void onEvent<string>("lang-changed", (l) => setLang(l));
  void onEvent<Settings>("settings-changed", (s) => replaceSettings({ ...settings, ...s }));
  // Another window asked for a page ("Settings → Agent Provider" in Teamwork, an integration's card).
  void onEvent<{ page: PageId; anchor: string | null; action: string | null }>("settings-goto", (g) =>
    nav.go(g.page, g.anchor ?? undefined, g.action ?? undefined),
  );

  // Coming back to the window: the files may have changed outside it.
  window.addEventListener("focus", () => {
    void refreshHooks();
    void refreshHotkey();
  });

  // A plain-browser preview can open a page or the guide from the address:
  // settings.html?page=connect&guide=1.
  const asked = new URLSearchParams(location.search);
  if (!IS_TAURI && asked.get("page")) nav.go(asked.get("page") as PageId);
  if (!IS_TAURI && asked.get("guide")) {
    openGuide(nav, root);
    return;
  }

  // The guide opens by itself only for someone who has connected nothing yet,
  // once per start of the app (this window is made hidden at start).
  if (shouldAutoShowGuide(guideFlag(), hooks)) {
    openGuide(nav, root);
    if (IS_TAURI) window.setTimeout(() => void Bridge.openSettingsWindow(), 1500);
  }
}

void main();
