// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import {
  Bridge, IS_TAURI, onDragDrop,
  type AcpPermission, type DockDrop, type DockPlacement, type DockPreview, type DroppedFile,
} from "../core/bridge";
import { cornerRadii, dockedRect, isVertical, wakeStripRect, type Dock, type Rect } from "../core/dock";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, SESSION_CARD_W, VERTICAL_CANVAS_W, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition,
  chatPromptHeight, islandSize,
  type BotStateName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { MAX_PILLS, State, isAgentSource } from "../core/state";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { nextTeamCard, teamTaskId } from "./team";
import type { Danger, MemberView, Snapshot } from "../team/types";

const BOT_OVERHANG = 40;

/** Largest file taken through an HTML5 drop; the bytes cross the IPC bridge. */
const MAX_DROP_BYTES = 64 * 1024 * 1024;

/** Reads a dropped File and hands it to Rust, which writes it into the inbox. */
async function readDropped(file: File): Promise<DroppedFile> {
  if (file.size > MAX_DROP_BYTES) {
    throw new Error(`${file.name} is over 64 MB — too big to drop here.`);
  }
  const bytes = await file.arrayBuffer();
  return Bridge.ingestBytes(file.name, bytes);
}
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** A press that moves this far (logical px) is a drag, not a click. */
const DRAG_THRESHOLD = 5;
/** A press held this long without moving picks the island up too (touchpads). */
const LONG_PRESS_MS = 600;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

/** Why a team member's request waits for the person, in the island's words. */
const DANGER_WORDS: Record<Danger, string> = {
  "deletes-folder": "Deletes a folder",
  "deletes-many": "Deletes several files at once",
  installs: "Installs a package or a program",
  downloads: "Downloads something from the internet",
  "destructive-git": "This git command throws changes away",
  "sends-out": "Sends or publishes something outside",
  "outside-work-dir": "Touches something outside the team's folder",
  system: "Changes the system or other programs",
  opaque: "Coucou cannot tell what this command does",
};

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;
  private dockHint!: HTMLElement;
  private compactStatus!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  /**
   * Added to the docked position: zero at rest, the gap between where the
   * capsule was let go and where it docks right after a drop, springing back
   * to zero so the capsule slides into its edge.
   */
  private slideX = new Spring(0, 0.22, 0.86);
  private slideY = new Spring(0, 0.22, 0.86);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /**
   * A press on the island that may still become a click or a drag, in
   * window-logical px. `header` = pressed on the open island's title bar.
   */
  private press: { x: number; y: number; timer: number; header: boolean; starting: boolean } | null = null;
  /** The island is being dragged; `preview` is where it would dock now. */
  private drag: { preview: Pick<Dock, "edge" | "anchor"> } | null = null;
  /**
   * Where the 640-wide canvases (drop sequence, greeting) sit and how much
   * they are shrunk: a side panel is narrower than they are.
   */
  private canvasAt = { x: 0, y: 0, s: 1 };
  /** A side wake strip only wakes the island after the mouse rests on it (D5). */
  private wakeTimer: number | null = null;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A pill whose session is waiting on an answer opens on the question.
        if (State.focusTask?.question && State.view === "overview") this.setView("question");
      },
      openTerminal: () => {
        const cwd = State.focusTask?.sessionCwd ?? null;
        void Bridge.openInVSCode(cwd);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.source === "team") {
          void Bridge.openTeamWindow();
          // A finished team that has been looked at has nothing more to say here.
          if (task.state === "finished") State.endSession(task.id);
        } else if (isAgentSource(task.source)) void Bridge.openInVSCode(task.sessionCwd ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      // Only the hook's own requests are kept for explaining; team and ACP cards are not (yet).
      explain: (requestId) => {
        State.approvalExplaining = true;
        this.animateGeometry(false);
        // ACP chat sessions are not kept for explaining; hook and team cards are.
        return requestId.startsWith("acp:") ? null : Bridge.explainRequest(requestId);
      },
      relayout: () => this.animateGeometry(!State.approvalExplaining),
      decide: (choice) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${choice} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        // Nothing gets allowed from here that could not be read here. The card
        // never offers Allow for a cut request, but a stale click must not
        // become one either.
        const d = choice === "allow" && req.truncated ? "terminal" : choice;
        if (req.team) {
          // A team member's: answered through the team. The next request it
          // holds, if any, comes up with the team's next picture.
          Sound.play(d === "deny" ? "blip" : "approve");
          const option = d === "deny" ? req.team.denyOption : req.team.allowOption;
          void Bridge.teamPermit(req.team.team, req.team.member, option, d === "allow-all").catch(() => {});
        } else if (req.acp) {
          // An agent the island started: the answer goes back down its own
          // connection, as one of the options it offered.
          Sound.play(d === "allow" ? "approve" : "blip");
          const option = d === "allow" ? req.acp.allowOption : req.acp.denyOption;
          void Bridge.acpPermission(req.acp.agentId, req.acp.requestId, option);
        } else if (d === "terminal") {
          // Hand the request back untouched: the relay prints nothing and
          // Claude Code asks in the terminal, exactly as if Coucou were closed.
          Sound.play("blip");
          void Bridge.approvalDecline(req.requestId);
        } else {
          Sound.play(d === "deny" ? "blip" : "approve");
          // A hook's request is always one: "all" is just it.
          void Bridge.approvalDecision(req.requestId, d === "deny" ? "deny" : "allow");
        }
        State.pendingApproval = null;
        State.isPinned = false;
        this.fsm.pinned = false;
        State.updateTask(req.taskId, "working");
        State.setPillBadge(req.taskId, null);
        this.setView(State.defaultView());
        // A team member's request that waited behind this card comes up now.
        if (!req.team) nextTeamCard(this);
      },
      answerQuestion: async (answer) => {
        // The answer is keystrokes into the session's own terminal, the way
        // the person would have typed them: Copilot's form takes one field at
        // a time — a list to move through with the arrows and accept with
        // Enter, "Other (type your answer)" at its end, a free-text line for a
        // field with no choices. Its PostToolUse takes the card down.
        const task = State.focusTask;
        const q = task?.question;
        const field = q?.fields[q.current];
        if (!task?.pty || !q || !field || q.answered) return;
        const DOWN = "\x1b[B";
        const UP = "\x1b[A";
        const moves = (to: number) => {
          const delta = to - (field.defaultIndex ?? 0);
          return delta > 0 ? DOWN.repeat(delta) : UP.repeat(-delta);
        };
        // Each entry is one write; the wrapper follows every write with Enter.
        const writes: string[] = [];
        let said = "";
        if ("choice" in answer) {
          said = field.choices[answer.choice] ?? "";
          writes.push(moves(answer.choice) || "\r");
        } else if ("text" in answer) {
          said = answer.text;
          if (field.choices.length) writes.push(moves(field.choices.length) || "\r");
          writes.push(answer.text);
        } else {
          writes.push("\r");
        }
        const label = field.title ? `${field.title}: ${said || "(skipped)"}` : said || "(skipped)";
        try {
          for (const [i, w] of writes.entries()) {
            if (i > 0) await new Promise((r) => window.setTimeout(r, 400));
            await Bridge.ptySend(task.pty, w);
          }
          Sound.play("blip");
          State.appendTranscript(task.id, { role: "user", text: label });
          q.current += 1;
          if (q.current >= q.fields.length) q.answered = said || label;
        } catch (err) {
          task.pty = null;
          State.appendTranscript(task.id, { role: "tool", text: String(err).replace(/^Error:\s*/, "") });
        }
        State.notify();
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      openTeamWindow: () => void Bridge.openTeamWindow(),
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.dockHint = h("div", { id: "dock-hint" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });
    this.compactStatus = h("div", { id: "compact-status" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.compactStatus,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.dockHint, this.islandEl);
    this.placeWakeStrip();
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from, to) => {
      // One line per transition in coucou.log: the island's whole life, for
      // when "it did not close" has to be answered after the fact.
      void Bridge.log(`island ${from} → ${to}`);
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          // A request still waiting for an answer comes back first.
          this.expand(State.pendingApproval ? "approval" : State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /**
   * The user clicked somewhere else: shut the island like any popup, instead of
   * leaving it open across the top of the screen until the countdown runs out.
   * A pending approval is not lost — the island reopens on that card, and the
   * request keeps waiting for the terminal's own timeout.
   */
  clickOutside() {
    if (State.mode !== "expanded") return;
    // A file drag starts with a press elsewhere — on the file, in Explorer —
    // so while the drop zone is up a press outside is the drag beginning, not
    // a dismissal. The × and the shortcut still close it.
    if (State.fileDragOver || UPLOAD_VIEWS.has(State.view)) return;
    void Bridge.log("click outside — shutting the island");
    this.collapse();
  }

  /**
   * The global shortcut: open the island, or put it away entirely. It is the
   * one input that reaches a window which never has keyboard focus.
   */
  toggle() {
    void Bridge.log(`hotkey mode=${State.mode} fsm=${this.fsm.state}`);
    if (this.drag) return;
    if (State.mode === "expanded") {
      State.isPinned = false;
      this.fsm.pinned = false;
      // "Always visible" means never gone: the shortcut then only shuts it.
      if (State.settings.alwaysVisible) this.fsm.forcePetit();
      else this.fsm.forceHidden();
    } else {
      this.alert(State.pendingApproval ? "approval" : State.defaultView());
    }
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  /**
   * A team member waits for the person: the same card as a hook's request,
   * on the team's pill, with everything the member asked for.
   */
  askTeamPermission(snap: Snapshot, m: MemberView, quiet = false) {
    const p = m.permission;
    if (!p) return;
    const pick = (kinds: string[]) =>
      kinds.map((k) => p.options.find((o) => o.kind === k)?.optionId).find((id) => id != null) ?? null;
    const input = (p.rawInput && typeof p.rawInput === "object" ? p.rawInput : {}) as Record<string, unknown>;
    const sections = Object.entries(input)
      .filter(([, v]) => v != null)
      .map(([label, v]) => ({ label, value: typeof v === "string" ? v : JSON.stringify(v, null, 2) }));
    if (p.danger) sections.unshift({ label: "why", value: DANGER_WORDS[p.danger] });
    if (p.rule) sections.unshift({ label: "憲法", value: p.rule });
    if (m.morePermissions.length) {
      const queued = m.morePermissions.map((x) => {
        const raw = (x.rawInput && typeof x.rawInput === "object" ? x.rawInput : {}) as Record<string, unknown>;
        return typeof raw.command === "string" ? raw.command : x.title;
      });
      sections.push({ label: `${queued.length} more waiting`, value: queued.join("\n") });
    }
    const taskId = teamTaskId(snap.id);
    State.pendingApproval = {
      requestId: `team:${snap.id}:${m.id}:${JSON.stringify(p.requestId)}`,
      sessionId: "",
      taskId,
      tool: p.title,
      command: `${m.name} · ${p.title}`,
      sections,
      lines: 2 + sections.reduce((n, s) => n + s.value.split("\n").length, 0),
      truncated: false,
      team: { team: snap.id, member: m.id, requestId: p.requestId, allowOption: pick(["allow_once", "allow_always"]), denyOption: pick(["reject_once", "reject_always"]), more: m.morePermissions.length },
    };
    State.setFocus(taskId);
    State.isPinned = true;
    if (!quiet) {
      Sound.play("approval");
      this.alert("approval");
    }
    State.notify();
  }

  /** A team's card was answered elsewhere (the Teamwork window): off the island. */
  dropTeamApproval() {
    if (!State.pendingApproval?.team) return;
    State.pendingApproval = null;
    State.isPinned = false;
    this.fsm.pinned = false;
    if (State.view === "approval") this.setView(State.defaultView());
    State.notify();
  }

  /**
   * An agent the island started asks before a tool call. Same card as a
   * hook's permission request; the answer is one of the agent's own options.
   */
  askAcpPermission(p: AcpPermission) {
    const pick = (kinds: string[]) =>
      kinds.map((k) => p.options.find((o) => o.kind === k)?.optionId).find((id) => id != null) ?? null;
    const allowOption = pick(["allow_once", "allow_always"]);
    const denyOption = pick(["reject_once", "reject_always"]);
    if (State.pendingApproval) {
      // One card at a time; a second request is declined rather than hidden.
      void Bridge.acpPermission(p.agentId, p.requestId, denyOption);
      return;
    }
    const agent = State.settings.agents.find((a) => a.id === p.agentId);
    const input = (p.rawInput && typeof p.rawInput === "object" ? p.rawInput : {}) as Record<string, unknown>;
    const sections = Object.entries(input)
      .filter(([, v]) => v != null)
      .map(([label, v]) => ({ label, value: typeof v === "string" ? v : JSON.stringify(v, null, 2) }));
    if (p.rule) sections.unshift({ label: "憲法", value: p.rule });
    const command = `${agent?.name ?? p.agentId} · ${p.title}`;
    State.pendingApproval = {
      requestId: `acp:${p.agentId}`,
      sessionId: "",
      taskId: `acp:${p.agentId}`,
      tool: p.title,
      command,
      sections,
      lines: 2 + sections.reduce((n, s) => n + s.value.split("\n").length, 0),
      truncated: false,
      acp: { agentId: p.agentId, requestId: p.requestId, allowOption, denyOption },
    };
    State.isPinned = true;
    Sound.play("approval");
    this.alert("approval");
    State.notify();
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path.split(/[\\/]/).pop() || "file", Bridge.ingestFile(path));
        break;
      }
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(name: string, ingest: Promise<DroppedFile>) {
    const path = "";
    State.fileDragOver = false;
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void ingest
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(
      State.mode, State.view, State.chatHistory.length, State.pendingApproval?.lines ?? 0,
      Math.min(State.pillTasks.length, MAX_PILLS), State.extraCards.length,
      State.focusTask?.question ?? null, !!State.focusTask?.pty,
      State.approvalExplaining, this.vertical,
    );
    // A side window can be shorter than the island would like to be.
    if (this.vertical && State.mode === "expanded") return { w, h: Math.min(h, State.windowLen), r: EXPANDED_CORNER };
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  /** The dock the island is drawn for right now: while dragged, the preview. */
  private get dock(): Dock {
    return this.drag ? { ...State.dock, ...this.drag.preview } : State.dock;
  }

  /** Docked left or right: the capsule stands on end (the panel never turns). */
  private get vertical(): boolean {
    return isVertical(this.dock);
  }

  /** Rust placed the window for a dock (boot, `dock-changed`). */
  setPlacement(p: DockPlacement) {
    if (this.drag) return;
    State.dock = p.dock;
    State.anchorInWindow = p.anchorInWindow;
    State.windowLen = p.windowLen;
    this.syncDockClasses();
    this.placeWakeStrip();
    this.animateGeometry(false);
    this.dirty = true;
    this.ensureRunning();
  }

  private syncDockClasses() {
    this.islandEl.classList.toggle("vertical", this.vertical);
    this.islandEl.classList.toggle("dock-right", this.dock.edge === "right");
    // Every session card makes a side island 280 px longer; only what fits.
    State.maxExtraCards = this.vertical
      ? Math.max(0, Math.floor((State.windowLen - EXPANDED_W) / SESSION_CARD_W))
      : Infinity;
  }

  private applyGeometry() {
    const rect = this.islandRect();
    const { w, h: hh } = rect;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = cornerRadii(this.dock, r, !!this.drag);
    this.islandEl.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync. On its side the mini grid goes under Mochi.
    if (this.vertical) {
      this.miniGrid.style.left = `${w / 2 - 14.5}px`;
      this.miniGrid.style.top = `${hh - 40 - 14.5}px`;
    } else {
      this.miniGrid.style.left = `${w - 40 - 14.5}px`;
      this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    }
    // The 640-wide canvases: centred above a landscape island; on a side,
    // shrunk to the panel's width and centred down its length.
    const s = this.vertical ? VERTICAL_CANVAS_W / EXPANDED_W : 1;
    const cx = (w - EXPANDED_W * s) / 2;
    this.canvasAt = { x: cx, y: this.vertical ? (hh - 176 * s) / 2 : 0, s };
    for (const [el, ch] of [[this.greetingCanvas, 150], [this.uploadCanvas.el, 176]] as const) {
      el.style.left = `${cx}px`;
      el.style.top = this.vertical ? `${(hh - ch * s) / 2}px` : "0px";
      el.style.transformOrigin = "0 0";
      el.style.scale = s === 1 ? "" : String(s);
    }

    const p = this.pushedRect;
    if (
      Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.y - rect.y) > 0.5 ||
      Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5
    ) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 1320x320 window). */
  private islandRect(): Rect {
    const r = dockedRect(
      this.dock, this.width.value, this.height.value, State.anchorInWindow, !!this.drag, State.windowLen,
    );
    return { ...r, x: r.x + this.slideX.value, y: r.y + this.slideY.value };
  }

  /**
   * The wake strip: once the window has shrunk to it, the whole window; before
   * that, the same strip along the docked edge of the full window.
   */
  private placeWakeStrip() {
    const st = this.wakeStrip.style;
    if (this.collapsed) {
      st.left = "0px";
      st.top = "0px";
      st.width = "100%";
      st.height = "100%";
      return;
    }
    const r = wakeStripRect(this.dock, State.anchorInWindow, State.windowLen);
    st.left = `${r.x}px`;
    st.top = `${r.y}px`;
    st.width = `${r.w}px`;
    st.height = `${r.h}px`;
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        this.placeWakeStrip();
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      this.placeWakeStrip();
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    // On a side it lies over the edge of whatever window is maximised there,
    // its scroll bar say, so a cursor merely passing by must not wake it.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (this.wakeTimer != null) window.clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
      const wake = () => {
        this.wakeTimer = null;
        if (State.mode === "hidden") this.fsm.mouseEntered();
      };
      if (this.vertical) this.wakeTimer = window.setTimeout(wake, 250);
      else wake();
    });
    this.wakeStrip.addEventListener("mouseleave", () => {
      if (this.wakeTimer != null) window.clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        // The capsule opens on release now: a press that moves is a drag.
        if (e.button === 0 && this.canDrag()) this.startPress(e, false);
        else this.fsm.click();
        return;
      }
      // The open island's title bar, away from its buttons, drags it too.
      if (
        e.button === 0 && this.canDrag() &&
        (e.target as Element).closest("#header") && !(e.target as Element).closest("button")
      ) {
        this.startPress(e, true);
      }
      // A click on the open island is a look at what it shows.
      if (State.focusTask?.unread) {
        State.markRead(State.focusTask);
        State.notify();
      }
      if (this.isBotHit(e.clientX / State.zoom, e.clientY / State.zoom)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    window.addEventListener("mousemove", (e) => this.pressMoved(e.clientX / State.zoom, e.clientY / State.zoom));
    window.addEventListener("mouseup", (e) => {
      if (e.button !== 0 || !this.press) return;
      // Rust is being asked to take the drag: its answer decides click or drag.
      if (this.press.starting) return;
      const header = this.press.header;
      this.endPress();
      if (!header) this.fsm.click();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Files arrive through the webview's own HTML5 drag and drop: WebView2
    // keeps the window OLE finds first in its own process, where wry's drop
    // target cannot reach, so Tauri's drag events never fire here. The page
    // sees enter/over/leave/drop instead, and the file comes as bytes.
    let depth = 0;
    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (depth++ === 0) this.onDragDrop({ type: "enter" });
    });
    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (e) => {
      e.preventDefault();
      if (--depth <= 0) {
        depth = 0;
        this.onDragDrop({ type: "leave" });
      }
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      const file = e.dataTransfer?.files?.[0];
      void Bridge.log(`drop (html5) ${file ? file.name : "no file"}`);
      if (!file) {
        this.onDragDrop({ type: "drop" });
        return;
      }
      this.swallow(file.name, readDropped(file));
    });

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) {
      window.addEventListener("mousemove", (e) =>
        this.onCursor(e.clientX / State.zoom, e.clientY / State.zoom),
      );
    }
  }

  // ── Dragging the island ─────────────────────────────────────────────────────

  /** Not while it waits for an answer, greets, or eats a file. */
  private canDrag(): boolean {
    if (!IS_TAURI || this.drag || State.fileDragOver || UploadSeq.isActive) return false;
    if (State.mode === "expanded") return this.fsm.state === "home" && !State.isPinned && !UPLOAD_VIEWS.has(State.view);
    return this.fsm.state === "petit";
  }

  private startPress(e: MouseEvent, header: boolean) {
    this.endPress();
    const x = e.clientX / State.zoom;
    const y = e.clientY / State.zoom;
    const timer = window.setTimeout(() => void this.startDrag(true), LONG_PRESS_MS);
    this.press = { x, y, timer, header, starting: false };
  }

  private endPress() {
    if (this.press) window.clearTimeout(this.press.timer);
    this.press = null;
    this.islandEl.classList.remove("lifted");
  }

  /** The cursor moved while pressed (DOM or Rust's poll): past the threshold it is a drag. */
  private pressMoved(x: number, y: number) {
    const p = this.press;
    if (!p || p.starting) return;
    if (Math.hypot(x - p.x, y - p.y) > DRAG_THRESHOLD) void this.startDrag(false);
  }

  private async startDrag(longPress: boolean) {
    const p = this.press;
    if (!p || p.starting) return;
    p.starting = true;
    window.clearTimeout(p.timer);
    if (longPress && !p.header) this.islandEl.classList.add("lifted");
    const rect = this.islandRect();
    // From the title bar the island shuts to the capsule first, centred under the cursor.
    const grab = p.header ? { x: 0, y: 0 } : { x: p.x - (rect.x + rect.w / 2), y: p.y - (rect.y + rect.h / 2) };
    const ok = await Bridge.beginIslandDrag(grab.x, grab.y);
    if (this.press !== p) return;
    this.endPress();
    if (!ok) {
      // The button was already up: it was a click after all.
      if (!p.header) this.fsm.click();
      return;
    }
    void Bridge.log(`island drag ${longPress ? "(long press)" : ""} from ${State.dock.edge}/${State.dock.anchor}`);
    if (p.header) this.collapse();
    this.drag = { preview: { edge: State.dock.edge, anchor: State.dock.anchor } };
    this.fsm.hold();
    this.cancelBotHover();
    this.engine.triggerEmote("surprised");
    this.islandEl.classList.add("dragging");
    // Picked up without moving: it stays a little larger while carried.
    if (longPress && !p.header) this.islandEl.classList.add("lifted");
    this.syncDockClasses();
    this.animateGeometry(false);
    this.dirty = true;
    this.ensureRunning();
  }

  /** Rust: where the dragged capsule would dock now. */
  dockPreview(p: DockPreview) {
    if (!this.drag) return;
    const turned = isVertical(p) !== isVertical(this.drag.preview);
    this.drag.preview = { edge: p.edge, anchor: p.anchor };
    if (turned) {
      this.syncDockClasses();
      const { w, h } = this.targetSize();
      this.width.springTo(w, 0.16, 0.86);
      this.height.springTo(h, 0.16, 0.86);
      this.ensureRunning();
    }
    if (p.hint) {
      const st = this.dockHint.style;
      st.left = `${p.hint.x}px`;
      st.top = `${p.hint.y}px`;
      st.width = `${p.hint.w}px`;
      st.height = `${p.hint.h}px`;
    }
    this.dockHint.classList.toggle("on", !!p.hint);
  }

  /**
   * Rust: let go (or Escape). The capsule is drawn where it was let go in the
   * coordinates of the window's new place, the window moves, and the capsule
   * slides into its edge. Hidden for the frame or two in between, so it never
   * shows at the old place in the new window or the other way round.
   */
  async dockDrop(d: DockDrop) {
    const wasDragging = !!this.drag;
    this.drag = null;
    this.dockHint.classList.remove("on");
    this.islandEl.classList.remove("dragging", "lifted");
    State.dock = d.dock;
    State.anchorInWindow = d.anchorInWindow;
    State.windowLen = d.windowLen;
    this.syncDockClasses();
    this.placeWakeStrip();
    this.islandEl.style.visibility = "hidden";
    const { w, h } = this.targetSize();
    this.width.jump(d.from.w);
    this.height.jump(d.from.h);
    this.width.springTo(w);
    this.height.springTo(h);
    const at = dockedRect(d.dock, d.from.w, d.from.h, d.anchorInWindow, false, d.windowLen);
    this.slideX.set(d.from.x - at.x);
    this.slideY.set(d.from.y - at.y);
    this.slideX.target = 0;
    this.slideY.target = 0;
    await Bridge.commitDockGeometry();
    // Two frames: the window has moved by the time the capsule shows again.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.islandEl.style.visibility = "";
    }));
    if (wasDragging && !d.cancelled) Sound.play("blip");
    this.fsm.release();
    this.dirty = true;
    this.ensureRunning();
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    this.pressMoved(x, y);
    State.mouse = { x, y };
    const rect = this.islandRect();
    // In the drop sequence's own coordinates, which a side panel shrinks.
    const c = this.canvasAt;
    State.mouseInIsland = { x: (x - rect.x - c.x) / c.s, y: (y - rect.y - c.y) / c.s };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
      // Coming onto the open island counts as looking at what it shows.
      if (State.mode === "expanded" && State.focusTask?.unread) {
        State.markRead(State.focusTask);
        State.notify();
      }
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    // The status label of a capsule on its side shows on hover.
    if (inIsland !== this.wasInIsland) this.dirty = true;
    this.wasInIsland = inIsland;

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.slideX.step(dt);
    this.slideY.step(dt);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating ||
      !this.slideX.settled || !this.slideY.settled;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive ||
        // A ticker step stopped halfway would leave two rows on one line.
        !!this.views.get(State.view)?.animating?.();

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(
      State.mode, State.view, this.height.value, State.uploadProgress, this.vertical, this.width.value,
    );
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    const botScreenY = this.islandRect().y + this.botCy.value;
    return -Math.tanh((State.mouse.y - botScreenY) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    // The island's size follows its contents, not only its view: a session
    // card read and gone, a pill row added, a reply making the approval card
    // taller. Whatever changed the state, the shape catches up here.
    if (expanded) {
      const { w, h } = this.targetSize();
      if (Math.abs(w - this.width.target) > 0.5 || Math.abs(h - this.height.target) > 0.5) {
        this.animateGeometry(w < this.width.target || h < this.height.target);
      }
    }

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // Only a view with a text field may take keyboard focus: the chat, and a
    // session whose terminal the island can type into.
    const typing = (v: IslandViewName | null) =>
      v === "prompt" || (v === "session" && !!State.focusTask?.pty);
    if (this.lastSyncedView !== State.view) {
      const wasTyping = typing(this.lastSyncedView);
      this.lastSyncedView = State.view;
      if (typing(State.view)) {
        const view = State.view;
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get(view)?.focus?.(), 120);
      } else if (wasTyping) {
        void Bridge.focusWindow(false);
      }
    }

    this.syncKeepVisible();

    // A reply nobody has looked at lights the shut island up: a breathing
    // ring in that session's colour, until somebody opens it. Otherwise a
    // finished session was easy to miss once the island had closed again.
    const unread = State.unreadTasks;
    const ring = State.mode === "compact" && unread.length > 0;
    this.islandEl.classList.toggle("unread", ring);
    if (ring) this.islandEl.style.setProperty("--ring", unread[0].color);

    // Compact mini grid, and the one line that says what Mochi is up to —
    // without it a shut island showed nothing of a session at work.
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    // On its side the line is a label beside the capsule, shown on hover — not
    // while the capsule is carried around, and never as an empty black pill.
    const label = !this.vertical || (this.wasInIsland && !this.drag);
    this.compactStatus.style.opacity = showGrid && label ? "1" : "0";
    if (showGrid) {
      const t = State.focusTask;
      const words: Partial<Record<BotStateName, string>> = {
        working: "is working…", thinking: "is thinking…", searching: "is searching…",
        approval: "needs permission", question: "has a question", finished: "replied",
        error: "stopped on an error", ratelimit: "hit a rate limit",
      };
      const word = t ? words[t.state] : undefined;
      const key = `${t?.id}|${t?.name}|${word ?? ""}`;
      if (this.compactStatus.dataset.key !== key) {
        this.compactStatus.dataset.key = key;
        this.compactStatus.replaceChildren();
        if (t && word) {
          this.compactStatus.append(h("span", { class: "n", text: t.name }), h("span", { text: word }));
        }
      }
    }
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.petitToHiddenDelay = Math.max(3, State.settings.hideAfter || 60);
    this.syncKeepVisible();
    // Switching it on brings a hidden island out; it then stays.
    if (State.settings.alwaysVisible && this.fsm.state !== "home") this.fsm.reveal();
    State.notify();
  }

  /** The island stays at least compact while it is wanted or has news. */
  private syncKeepVisible() {
    const keep = State.settings.alwaysVisible || State.unreadTasks.length > 0;
    if (keep === this.fsm.keepVisible) return;
    this.fsm.keepVisible = keep;
    // News arriving while compact cancels the countdown already running.
    if (keep && this.fsm.state === "petit") this.fsm.reveal();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
