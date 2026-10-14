// Settings window — the place where anything that writes to disk is confirmed.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import type { Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { glassify } from "../team/ui";
import { replaceSettings, setVersion, settings, version } from "./store";
import { AGENT_COPY, agentSection, terminalSection } from "./pages/connect";
import { providerKey, providersSection } from "./pages/chat";
import { agentKey, agentsSection } from "./pages/agents";
import { cliSection } from "./pages/install";
import { integrationsSection } from "./pages/integrations";
import { generalSection } from "./pages/general";

const root = document.getElementById("settings-root")!;

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  // Native dropdowns and model lists are drawn by Windows as a white list: the window's own instead.
  glassify(root);
  const boot = await Bridge.boot();
  if (boot) {
    replaceSettings({ ...settings, ...boot.settings });
    setVersion(boot.version);
  }
  const statuses: HookStatus[] = [];
  for (const copy of AGENT_COPY) {
    statuses.push((await Bridge.hooksStatus(copy.agent)) ?? {
      installed: false, settingsPath: "", hookPath: "", hookReady: false,
    });
  }

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;
  for (const p of settings.providers) {
    let has = (await Bridge.secretPresent(providerKey(p))) ?? false;
    // The default Claude entry still honours the key saved before providers existed.
    if (!has && p.id === "anthropic") has = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    present[providerKey(p)] = has;
  }
  for (const a of settings.agents) present[agentKey(a)] = (await Bridge.secretPresent(agentKey(a))) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    ...AGENT_COPY.map((copy, i) => agentSection(copy, statuses[i])),
    terminalSection(statuses[0]?.hookPath ?? ""),
    providersSection(present),
    agentsSection(present),
    cliSection(),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    replaceSettings({ ...settings, ...s });
  });
}

void main();
