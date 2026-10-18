// Integrations: the service pills next to Mochi, and their keys.

import { Bridge } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import { h, clear } from "../../views/dom";
import type { Page } from "../nav";
import { integrationKeys, present, save, setPresent, settings } from "../store";
import { badge, disclosure, errText, field, notice, pageHeader } from "../ui";

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: () => string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: () => tr("私密金鑰", "Secret key"), placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: () => "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: () => "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: () => tr("站台網址", "Instance URL"), placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: () => tr("API 金鑰", "API key"), placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: () => tr("API 金鑰", "API key"), placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: () => tr("整合 token", "Integration token"), placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: () => tr("API 金鑰", "API key"), placeholder: "cal_…", secret: true }] },
];

// The overview counts a pill that is on without its keys.
integrationKeys.splice(0, integrationKeys.length, ...INTEGRATIONS.map((d) => ({ id: d.id, name: d.name, keys: d.fields.map((f) => f.key) })));

const MAX_ACTIVE = 4;

export const integrationsPage: Page = {
  id: "integrations",
  icon: "integrations",
  name: () => tr("整合", "Integrations"),
  render() {
    const note = h("p", { class: "hint" });
    const list = h("div", { class: "card integrations" });
    const switches: { def: IntegrationDef; sw: HTMLButtonElement }[] = [];

    const sync = () => {
      const used = settings.activeIntegrations.length;
      note.textContent = trf("已使用 {used} / {max} 個膠囊。", "{used} of {max} pills in use.", { used, max: MAX_ACTIVE });
      for (const { def, sw } of switches) {
        const on = settings.activeIntegrations.includes(def.id);
        const full = !on && used >= MAX_ACTIVE;
        sw.disabled = full;
        sw.title = full ? tr("先關掉一個（最多 4 個）。", "Turn one off first (up to 4).") : "";
      }
    };

    for (const def of INTEGRATIONS) {
      const row = h("div", { class: "integration", "data-anchor": def.id });
      const draw = () => {
        clear(row);
        const on = settings.activeIntegrations.includes(def.id);
        const sw = h("button", { type: "button", class: on ? "switch on" : "switch", "aria-pressed": on, "aria-label": def.name }) as HTMLButtonElement;
        sw.addEventListener("click", () => {
          if (sw.disabled) return;
          const now = settings.activeIntegrations.includes(def.id);
          if (now) settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
          else {
            if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
            settings.activeIntegrations = [...settings.activeIntegrations, def.id];
          }
          void save();
          draw();
          sync();
        });
        const idx = switches.findIndex((s) => s.def.id === def.id);
        if (idx >= 0) switches[idx].sw = sw;
        else switches.push({ def, sw });

        const missing = def.fields.some((f) => !present[f.key]);
        const state = !on ? badge("off", tr("關閉", "Off")) : missing ? badge("todo", tr("需要金鑰", "Needs a key")) : badge("ok", tr("金鑰已存", "Key saved"));
        const fields = () => h("div", { class: "stack" }, ...def.fields.map((f) => keyField(f, draw)));
        row.append(
          h("div", { class: "integration-head" },
            sw,
            h("i", { class: "dot", style: `background:${def.color}` }),
            h("span", { class: "integration-name", text: def.name }),
            h("span", { class: "grow" }),
            state,
          ),
          on ? fields() : disclosure(tr("設定", "Set up"), fields, false, "details"),
        );
      };
      draw();
      list.append(row);
    }
    sync();

    return h(
      "div",
      { class: "page-body" },
      pageHeader(
        "integrations",
        tr("整合", "Integrations"),
        tr("在 Mochi 旁邊顯示你用的服務狀態小膠囊：GitHub、Vercel、Stripe……", "Small status pills next to Mochi for services you use: GitHub, Vercel, Stripe…"),
        () => tr(
          "最多開 4 個。每個膠囊需要那個服務的金鑰，存在 Windows 認證管理員。Agent Center 只會連到你在這裡打開的服務。",
          "Turn on up to 4. Each pill needs that service's key, stored in the Windows Credential Manager. Agent Center only talks to services you turn on here.",
        ),
      ),
      note,
      list,
    );
  },
};

function keyField(f: IntegrationDef["fields"][number], redraw: () => void): HTMLElement {
  const stored = present[f.key] ?? false;
  const input = h("input", {
    type: f.secret ? "password" : "text",
    placeholder: stored ? tr("••••••••（已存）", "••••••••  (stored)") : f.placeholder,
    autocomplete: "off",
    spellcheck: "false",
    class: "grow-input",
  }) as HTMLInputElement;
  const feedback = h("div", {});
  const saveBtn = h("button", {
    type: "button",
    text: tr("儲存", "Save"),
    onclick: async () => {
      const value = input.value.trim();
      try {
        await Bridge.secretSet(f.key, value);
        setPresent(f.key, value.length > 0);
        redraw();
      } catch (err) {
        clear(feedback);
        feedback.append(notice("err", errText(err)));
      }
    },
  });
  return h("div", {}, field(f.label(), [input, saveBtn]), feedback);
}
