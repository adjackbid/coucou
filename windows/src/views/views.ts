// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { MAX_PILLS, SOURCE_LABELS, State, isAgentSource, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  /** `terminal` gives the request back unanswered, for Claude Code to ask itself. */
  decide(d: "allow" | "deny" | "terminal"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));
  // Always there, on every view: the island must never have to be waited out.
  const closeBtn = h("button", { title: "Close", onclick: () => actions.collapse() }, svg(ICONS.xmark, 12));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    h("div", { class: "header-actions" }, gearBtn, soundBtn, closeBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  // The ticker shows one line at a time; the card opens the whole session.
  left.title = "Show the whole conversation";
  left.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const task = State.focusTask;
    if (task && isAgentSource(task.source) && task.transcript.length > 0) actions.setView("session");
  });
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);
  // One card per unread session beside the focused one; the island widens for them.
  const extras = h("div", { class: "extras" });

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    extras,
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let extrasKey = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // An agent pill with a live session keeps the ticker; every other pill
      // shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task != null && isAgentSource(task.source) &&
        (task.isSession || task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: SOURCE_LABELS[task.source] }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const cards = State.extraCards;
      const cardsKey = cards.map((t) => `${t.id}:${t.transcript.length}:${t.state}`).join("|");
      if (cardsKey !== extrasKey) {
        extrasKey = cardsKey;
        clear(extras);
        for (const t of cards) extras.append(sessionCard(t, actions));
        pruneMiniBots();
      }
      extras.style.display = cards.length ? "" : "none";

      const others = State.pillTasks.slice(0, MAX_PILLS);
      const pillKey = others.map((t) => `${t.id}:${t.pillBadge ?? ""}:${t.unread ? 1 : 0}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        pruneMiniBots();
      }
    },
  };
}

/**
 * A finished session that has not been looked at, as a card of its own: its
 * Mochi, its name, what it said. A click makes it the focused one.
 */
function sessionCard(task: AgentTask, actions: ViewActions): HTMLElement {
  const reply = [...task.transcript].reverse().find((e) => e.role === "assistant")?.text
    ?? task.steps.at(-1) ?? "Finished.";
  const body = h("div", { class: "session-card" },
    createMiniBot(task, 40),
    h("div", { class: "session-text" },
      h("div", { class: "who-row" },
        dot(task.color, 7),
        h("span", { class: "n", text: task.name }),
        // The colour and the Mochi already say which agent; the width is short.
        h("span", { text: "finished" }),
      ),
      h("div", { class: "session-reply", title: SOURCE_LABELS[task.source], text: reply.replace(/\s+/g, " ").trim() }),
    ),
  );
  const el = card("green", body);
  el.classList.add("session-card-shell");
  el.title = "Show this session";
  el.addEventListener("click", () => actions.setFocus(task.id));
  return el;
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  // A session pill is named after its project folder — with several sessions
  // open that is the one thing telling them apart. Standing pills keep theirs.
  const label = task.isSession ? task.name
    : task.id === "integration_claude" ? "VS Code"
    : task.source === "copilot" ? "Copilot" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = task.unread ? `${task.color}b3` : `${task.color}24`;
    pill.style.boxShadow = task.unread ? `0 0 10px ${task.color}66` : "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.unread) {
    // Lit up until looked at — the badge alone was easy to miss.
    pill.classList.add("unread");
    pill.style.borderColor = `${task.color}b3`;
    pill.style.boxShadow = `0 0 10px ${task.color}66`;
  }

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const head = h("div", { class: "code-head" });
  const body = h("div", { class: "code" });
  const note = h("div", { class: "sub" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, head, body, note, row)));
  // Null so the first sync always lays the body out, even with no request.
  let bodyKey: string | null = null;
  let rowKey = "";
  return {
    el,
    sync() {
      const req = State.pendingApproval;
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: the
      // headline is the file, the URL or the pattern being authorised, and the
      // body is the rest of the request in full — the command, the content a
      // Write will put on disk, the strings an Edit swaps — never cut to one
      // line with an ellipsis over the part that mattered.
      head.textContent = req?.command || req?.tool || "…";
      const key = req ? `${req.requestId}|${req.truncated}` : "";
      if (key !== bodyKey) {
        bodyKey = key;
        clear(body);
        const sections = req?.sections ?? [];
        for (const s of sections) {
          // One section needs no label: it is obviously the command or the content.
          if (sections.length > 1) {
            body.append(h("div", { class: "code-k", text: s.label.replace(/_/g, " ") }));
          }
          body.append(h("div", { class: "code-v", text: s.value }));
        }
        body.style.display = sections.length ? "" : "none";
        body.scrollTop = 0;
        note.textContent = req?.truncated
          ? "Too long to show in full here. The terminal has all of it."
          : "";
        note.style.display = req?.truncated ? "" : "none";
      }
      // Built once per shape. Rebuilding the buttons between a mouse-down and a
      // mouse-up would swallow the click, and the shape only changes with the
      // request: Deny / Allow, or Deny / Ask in terminal when the relay had to
      // cut the request — nobody can allow what nobody could read. "Always" is
      // gone until the remembered-rules list exists to back it.
      const shape = req?.truncated ? "terminal" : "allow";
      if (rowKey === shape) return;
      rowKey = shape;
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        shape === "terminal"
          ? btn("Ask in terminal", "primary", () => actions.decide("terminal"))
          : btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code is asking a question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Coucou can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  // The agent's last words, wrapped to a few lines rather than one.
  const title = h("div", { class: "title reply-text" });
  // The sessions that replied meanwhile; OK becomes Next while there are any.
  const more = h("div", { class: "sub" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, more, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      const task = State.focusTask;
      // Being on screen is being read.
      if (task) State.markRead(task);
      clear(who);
      who.append(agentWho(task, `${task ? SOURCE_LABELS[task.source] : "Claude Code"} finished`));
      title.textContent = task?.steps.at(-1) ?? "Session finished";

      const others = State.unreadTasks.filter((t) => t.id !== task?.id);
      more.textContent = others.length === 0 ? ""
        : others.length === 1 ? `${others[0].name} also replied`
        : `${others.length} more replied: ${others.map((t) => t.name).join(", ")}`;
      more.style.display = others.length ? "" : "none";

      // Rebuilt only when the choice changes, never between a press and a release.
      const key = others[0]?.id ?? "";
      if (key === rowKey) return;
      rowKey = key;
      clear(row);
      row.append(btn("Open terminal", "primary", () => actions.openTerminal()));
      if (others.length) {
        const next = others[0];
        row.append(btn("Next", "secondary", () => {
          actions.setFocus(next.id);
          actions.setView("finished");
        }, "→"));
      } else {
        row.append(btn("OK", "secondary", () => actions.collapse()));
      }
    },
  };
}

// ── Session ───────────────────────────────────────────────────────────────────

/** Everything the focused agent said and did this session, in full. */
function buildSession(actions: ViewActions): ViewHost {
  const who = h("div");
  const log = h("div", { class: "chat-log session-log" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("Back", "secondary", () => actions.setView("overview")),
  );
  const body = h("div", { class: "stack session-stack" }, who, log, row);
  body.style.padding = "4px 16px 4px 100px";
  const el = h("div", { class: "view" }, card(null, body));
  let renderedKey = "";
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task ? SOURCE_LABELS[task.source] : ""));
      const entries = task?.transcript ?? [];
      const key = `${task?.id}|${entries.length}|${entries.at(-1)?.text.length ?? 0}`;
      if (key === renderedKey) return;
      renderedKey = key;
      clear(log);
      for (const entry of entries) {
        if (entry.role === "user") {
          log.append(h("div", { class: "chat-row user" }, h("div", { class: "bubble", text: entry.text })));
        } else if (entry.role === "assistant") {
          log.append(h("div", { class: "chat-row" }, h("div", { class: "reply", text: entry.text })));
        } else {
          log.append(h("div", { class: "session-tool", text: entry.text }));
        }
      }
      if (entries.length === 0) log.append(h("div", { class: "sub", text: "Nothing yet this session." }));
      log.scrollTop = log.scrollHeight;
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("session", buildSession(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
