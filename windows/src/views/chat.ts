// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type AcpUpdate, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, activeAgentId, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  if (message.kind === "tool") {
    return h("div", { class: "chat-row" }, h("div", { class: "chat-tool", text: message.content }));
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
}

/** The chat's targets, in the order the chip cycles through them. */
function targets(): { id: string; name: string }[] {
  return [
    ...State.settings.providers.map((p) => ({ id: p.id, name: p.name })),
    ...State.settings.agents.map((a) => ({ id: `agent:${a.id}`, name: a.name })),
  ];
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

let toolId = 0;

/**
 * A `session/update` from the agent the chat is talking to: text chunks grow
 * the streaming reply, tool calls become small lines, the rest is ignored.
 */
export function onAcpUpdate(update: AcpUpdate["update"]) {
  const last = State.chatHistory.at(-1);
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = update.content?.type === "text" ? update.content.text ?? "" : "";
      if (!text) return;
      if (last?.kind === "streaming") last.content += text;
      else State.chatHistory.push({ id: 1e9 + toolId++, role: "assistant", content: text, kind: "streaming" });
      break;
    }
    case "tool_call": {
      const line = `⚙ ${update.title ?? update.kind ?? "tool"}`;
      // The streaming reply stays last so chunks keep landing in it.
      const streaming = last?.kind === "streaming" ? State.chatHistory.pop() : undefined;
      State.chatHistory.push({ id: 1e9 + toolId++, role: "assistant", content: line, kind: "tool" });
      if (streaming) State.chatHistory.push(streaming);
      break;
    }
    default:
      return;
  }
  State.notify();
}

/** A piece of a provider's reply, as it is written. */
export function onChatDelta(piece: string) {
  const last = State.chatHistory.at(-1);
  if (last?.kind !== "streaming") return;
  last.content += piece;
  State.notify();
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  // Which provider the next question goes to; a click moves to the next one.
  // Spelled out here because a filled-in card in Settings is not necessarily
  // the one in use, and "builder error" from the wrong endpoint says nothing.
  const provider = h("button", { class: "provider-btn", title: "Switch provider" });
  provider.addEventListener("click", () => {
    const list = targets();
    if (list.length < 2) return;
    const idx = list.findIndex((p) => p.id === State.settings.activeProvider);
    State.settings.activeProvider = list[(idx + 1) % list.length].id;
    void Bridge.saveSettings(State.settings);
    Sound.play("blip");
    State.notify();
  });
  // A fresh conversation: the history, the file and the context all go, so a
  // long chat does not drag its whole past into every next question.
  const fresh = h("button", { class: "chat-new", title: "Start a new conversation", text: "New" });
  fresh.addEventListener("click", () => {
    if (sending) return;
    State.chatHistory = [];
    State.droppedFile = null;
    State.promptContext = null;
    void Bridge.chatReset();
    const agent = activeAgentId(State.settings);
    if (agent) void Bridge.acpReset(agent);
    Sound.play("blip");
    State.notify();
    onHeightChange();
    input.focus();
  });
  const bar = h("div", { class: "chat-bar" }, provider, input, fresh, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const agent = activeAgentId(State.settings);
      if (agent) {
        // An agent: the reply streams in through acp-update (see main.ts),
        // into the message opened here; the call returns when the turn ends.
        const text = file && State.chatHistory.length === 1 ? `${query}\n\n(File: ${file.path})` : query;
        State.chatHistory.push({ id: nextId++, role: "assistant", content: "", kind: "streaming" });
        const outcome = await Bridge.acpSend(agent, text);
        const last = State.chatHistory.at(-1);
        if (last?.kind === "streaming") {
          last.kind = undefined;
          if (!last.content.trim()) last.content = `(${outcome.stopReason})`;
        }
      } else {
        // A provider: the reply streams in through chat-delta (see main.ts)
        // into the message opened here; the call returns the whole of it.
        const open: ChatMessage = { id: nextId++, role: "assistant", content: "", kind: "streaming" };
        State.chatHistory.push(open);
        const reply = await Bridge.chatSend(query, context);
        open.content = reply.text;
        open.kind = undefined;
      }
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      // A turn that failed leaves no empty bubble behind.
      if (State.chatHistory.at(-1)?.kind === "streaming") State.chatHistory.pop();
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      // Re-rendered when a message is added and while the last one streams.
      const thinking = State.stateOverride === "thinking";
      const last = State.chatHistory.at(-1);
      const streaming = last?.kind === "streaming";
      const count = State.chatHistory.length + (thinking && !streaming ? 0.5 : 0) + (last?.content.length ?? 0) / 1e6;
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) {
          if (m.kind === "streaming" && !m.content) continue;
          log.append(bubble(m));
        }
        if (thinking && (!streaming || !last?.content)) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = sending;
      fresh.style.display = State.chatHistory.length > 0 || State.droppedFile ? "" : "none";

      const list = targets();
      const active = list.find((t) => t.id === State.settings.activeProvider) ?? list[0];
      provider.textContent = active ? active.name : "No provider";
      provider.title = active
        ? `${active.name}${list.length > 1 ? " — click to switch" : ""}`
        : "Add a provider in Settings";
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
