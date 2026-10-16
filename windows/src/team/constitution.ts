// 憲法: the rules every agent must keep, whatever a team's way of working.
// Coucou's own checks (a .git folder removed, a whole drive wiped, software
// installed…) and the person's own, each at 要問我 — a card, even in 自主協作
// — or 絕對不能做 — refused on the spot, no card to click by mistake, and the
// member told why. Judged by Coucou itself (constitution.rs), never a model.

import "./constitution.css";
import { Bridge, IS_TAURI } from "../core/bridge";
import { tr, trf } from "../core/i18n";
import { h } from "../views/dom";
import type { Constitution, ConstitutionLevel, ConstitutionRule } from "./types";

export interface ConstitutionHost {
  render(): void;
}

const LEVELS = (): [ConstitutionLevel, string][] => [
  ["off", tr("照一般規則", "Usual rules")],
  ["ask", tr("要問我", "Ask me")],
  ["never", tr("絕對不能做", "Never")],
];
const OWN_LEVELS = (): [ConstitutionLevel, string][] => [
  ["ask", tr("要問我", "Ask me")],
  ["never", tr("絕對不能做", "Never")],
  ["off", tr("暫停這條", "Paused")],
];

let doc: Constitution | null = null;
let loading = false;
/** How the last save went; the words are picked when drawn. */
let state: "" | "saving" | "saved" | "failed" = "";
let stateError = "";
let saveTimer = 0;
let tryText = "";
let tried: { level: ConstitutionLevel; text: string } | null | undefined;

async function load(host: ConstitutionHost) {
  if (doc || loading) return;
  loading = true;
  doc = IS_TAURI ? await Bridge.constitutionLoad() : (await import("./demo")).demoConstitution();
  loading = false;
  host.render();
}

/** Saved a moment after the last change (typing does not save every key). */
function changed(host: ConstitutionHost, now = false) {
  state = "saving";
  window.clearTimeout(saveTimer);
  const go = async () => {
    try {
      if (IS_TAURI && doc) await Bridge.constitutionSave(doc);
      state = "saved";
      tried = undefined;
    } catch (err) {
      state = "failed";
      stateError = String(err instanceof Error ? err.message : err);
    }
    host.render();
  };
  if (now) void go();
  else saveTimer = window.setTimeout(() => void go(), 600);
  host.render();
}

function stateText(): string {
  switch (state) {
    case "saving": return tr("儲存中…", "Saving…");
    case "saved": return tr("已儲存 · 下一個請求就照新的條文", "Saved · the next request follows the new rules");
    case "failed": return trf("存不起來:{why}", "Couldn't save: {why}", { why: stateError });
    default: return "";
  }
}

function seg(items: [ConstitutionLevel, string][], current: ConstitutionLevel, pick: (v: ConstitutionLevel) => void): HTMLElement {
  return h(
    "div",
    { class: "law-seg", role: "group" },
    ...items.map(([v, label]) => h("button", { type: "button", class: `lv-${v}${v === current ? " on" : ""}`, "aria-pressed": String(v === current), onClick: () => pick(v) }, label)),
  );
}

function builtinRow(host: ConstitutionHost, r: ConstitutionRule): HTMLElement {
  return h(
    "div",
    { class: `law-row lv-${r.level}` },
    h("span", { class: "law-text", text: r.text }),
    seg(LEVELS(), r.level, (v) => {
      r.level = v;
      changed(host, true);
    }),
  );
}

function ownRow(host: ConstitutionHost, r: ConstitutionRule, at: number): HTMLElement {
  const text = h("input", { class: "field", type: "text", "data-key": `law-text-${r.id}`, value: r.text, placeholder: tr("這條規定什麼(會顯示在卡片上,也會告訴成員)", "What this rule says (shown on the card and told to members)") }) as HTMLInputElement;
  text.addEventListener("input", () => {
    r.text = text.value;
    changed(host);
  });
  const words = h("input", { class: "field mono", type: "text", "data-key": `law-words-${r.id}`, value: r.patterns.join(", "), placeholder: tr("指令或路徑裡出現這些字時套用,逗號分隔,* 代表任意字,例如 D:\\重要資料\\*, docker *", "Applies when a command or path contains these words; comma-separated, * matches anything, e.g. D:\\Important\\*, docker *") }) as HTMLInputElement;
  words.addEventListener("input", () => {
    r.patterns = words.value.split(/[,,\n]/).map((w) => w.trim()).filter(Boolean);
    changed(host);
  });
  return h(
    "div",
    { class: `law-row own lv-${r.level}` }, // i18n-ok: CSS classes
    h("div", { class: "law-fields" }, text, words),
    h(
      "div",
      { class: "law-side" },
      seg(OWN_LEVELS(), r.level, (v) => {
        r.level = v;
        changed(host, true);
      }),
      h(
        "button",
        {
          class: "link quiet-danger",
          type: "button",
          onClick: () => {
            doc!.rules.splice(at, 1);
            changed(host, true);
          },
        },
        tr("刪除", "Delete"),
      ),
    ),
  );
}

async function tryIt(host: ConstitutionHost) {
  const command = tryText.trim();
  if (!command) return;
  if (IS_TAURI) {
    const got = await Bridge.constitutionTry(command);
    tried = got ? { level: got[0], text: got[1] } : null;
  } else {
    tried = /\.git|rd \/s|format /i.test(command) ? { level: "never", text: tr("不能刪除或搬走 .git 資料夾(整個版本紀錄會不見)", "Don't delete or move a .git folder (the whole version history would be lost)") } : /install/i.test(command) ? { level: "ask", text: tr("安裝軟體或套件之前要先問我", "Ask me before installing software or packages") } : null;
  }
  host.render();
}

export function constitutionPage(host: ConstitutionHost): HTMLElement {
  void load(host);
  if (!doc) return h("div", { class: "law" }, h("p", { class: "dim", text: tr("讀取中…", "Loading…") }));
  const builtins = doc.rules.filter((r) => r.check);
  const own = doc.rules.map((r, i) => ({ r, i })).filter(({ r }) => !r.check);

  const probe = h("input", { class: "field mono", type: "text", "data-key": "law-try", value: tryText, placeholder: tr("貼一行指令試試看,例如 Remove-Item -Recurse .git", "Paste a command to try, e.g. Remove-Item -Recurse .git") }) as HTMLInputElement;
  probe.addEventListener("input", () => {
    tryText = probe.value;
    tried = undefined;
  });
  probe.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) void tryIt(host);
  });
  const verdict =
    tried === undefined
      ? null
      : tried === null
        ? h("div", { class: "law-verdict lv-off", text: tr("沒有條文管到它:照一般規則(自主協作下安全的步驟直接做,危險的會問你)。", "No rule covers it: the usual rules apply (in Autonomous mode safe steps just run, risky ones ask you).") })
        : h("div", { class: `law-verdict lv-${tried.level}` }, h("b", { text: tried.level === "never" ? tr("絕對不能做", "Never") : tr("要問我", "Ask me") }), ` · ${tried.text}`);

  return h(
    "div",
    { class: "law" },
    h(
      "section",
      { class: "panel law-intro" },
      h("p", {}, tr("所有團隊、所有成員都要遵守的規則,不管團隊是「自主協作」還是「逐步確認」。", "Rules every team and every member must follow, whether the team works in Autonomous or Step-by-step mode.")),
      h(
        "ul",
        {},
        h("li", {}, h("b", { class: "never-text", text: tr("絕對不能做", "Never") }), tr(":Agent Center 直接拒絕,", ": Agent Center refuses on the spot, "), h("b", { text: tr("不會跳卡片給你", "no card pops up for you") }), tr("(不怕誤點),並告訴那位成員這是憲法禁止的,請它換個做法。", " (nothing to click by mistake), and tells the member the constitution forbids it and to find another way.")),
        h("li", {}, h("b", { class: "ask-text", text: tr("要問我", "Ask me") }), tr(":一定跳卡片問你,卡片上寫著是哪一條。就算是「自主協作」也一樣。", ": a card always asks you and names the rule. Even in Autonomous mode.")),
        h("li", {}, h("b", { text: tr("照一般規則", "Usual rules") }), tr(":不額外限制;自主協作下危險的動作本來就會問你。", ": no extra limits; in Autonomous mode risky steps ask you anyway.")),
      ),
      h("p", { class: "hint", text: tr("成員開工時會先讀到這些條文。判斷由 Agent Center 依條文比對,不是讓 AI 猜,所以「絕對不能做」一定擋得住。", "Members read these rules when they start. Agent Center checks them itself, an AI does not guess, so a “Never” rule always holds.") }),
    ),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: tr("內建條文", "Built-in rules") }), h("span", { class: "law-state dim", role: "status", text: stateText() })), h("div", { class: "law-list" }, ...builtins.map((r) => builtinRow(host, r)))),
    h(
      "section",
      { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", { text: tr("我的條文", "My rules") }), h("span", { class: "dim", text: tr("指令或路徑裡出現你寫的字,就套用這條", "A rule applies when a command or path contains the words you wrote") })),
      own.length ? h("div", { class: "law-list" }, ...own.map(({ r, i }) => ownRow(host, r, i))) : h("p", { class: "dim", text: tr("還沒有。例如:「不能動 D:\\重要資料」寫成 D:\\重要資料\\*,選「絕對不能做」。", "None yet. For example, to keep D:\\Important off limits, write D:\\Important\\* and pick “Never”.") }),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn plain",
            type: "button",
            onClick: () => {
              doc!.rules.push({ id: `mine-${Date.now().toString(36)}`, text: "", level: "never", check: "", patterns: [] });
              changed(host, true);
            },
          },
          tr("+ 新增條文", "+ Add rule"),
        ),
      ),
    ),
    h(
      "section",
      { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", { text: tr("試試看", "Try it") }), h("span", { class: "dim", text: tr("某個指令會碰到哪一條", "Which rule a command would hit") })),
      h("div", { class: "row nowrap" }, probe, h("button", { class: "btn plain", type: "button", onClick: () => void tryIt(host) }, tr("檢查", "Check"))
),
      verdict,
    ),
  );
}
