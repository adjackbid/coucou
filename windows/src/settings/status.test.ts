import { describe, expect, it } from "vitest";
import type { CliInfo, HookStatus } from "../core/bridge";
import { DEFAULT_AGENT, DEFAULT_PROVIDER, DEFAULT_SETTINGS, type Settings } from "../core/state";
import { agentLink, leftCount, pageBadges, shouldAutoShowGuide, todoList, type HookRead, type StatusInput } from "./status";

const status = (over: Partial<HookStatus> = {}): HookStatus => ({
  installed: false, settingsPath: "s", hookPath: "h", hookReady: true, ...over,
});
const read = (over: Partial<HookStatus> = {}, diff: string | null = "No change.", error: string | null = null): HookRead => ({
  status: status(over), diff, error,
});
const cli = (id: string, found: boolean): CliInfo => ({
  id, name: id, command: id, purpose: "", docs: "", methods: [], found: found ? `C:\\${id}.exe` : null, version: null,
});
const ALL_CLIS = [cli("claude", true), cli("copilot", true), cli("agy", true)];

function input(over: Partial<StatusInput> = {}, settings: Partial<Settings> = {}): StatusInput {
  return {
    hooks: { claude: read({ installed: true }), copilot: read({ installed: true }), antigravity: read({ installed: true }) },
    clis: ALL_CLIS,
    settings: { ...DEFAULT_SETTINGS, activeIntegrations: [], ...settings },
    present: { "provider:anthropic": true },
    hotkeyError: null,
    integrations: [],
    ...over,
  };
}

describe("agentLink", () => {
  it("is checking until the file has been read", () => {
    expect(agentLink(undefined, ALL_CLIS, "claude")).toBe("checking");
    expect(agentLink({ status: null, diff: null, error: null }, ALL_CLIS, "claude")).toBe("checking");
  });
  it("puts a missing relay before everything else", () => {
    expect(agentLink(read({ installed: true, hookReady: false }), ALL_CLIS, "claude")).toBe("relay");
  });
  it("says when the file cannot be read", () => {
    expect(agentLink(read({}, null, "settings.json is not valid JSON"), ALL_CLIS, "claude")).toBe("unreadable");
  });
  it("needs an update when a reinstall would change something", () => {
    expect(agentLink(read({ installed: true }, "+ a\n- b\n"), ALL_CLIS, "claude")).toBe("update");
    expect(agentLink(read({ installed: true }, "No change."), ALL_CLIS, "claude")).toBe("connected");
    expect(agentLink(read({ installed: true }, null), ALL_CLIS, "claude")).toBe("connected");
  });
  it("tells a missing CLI from a missing hook", () => {
    expect(agentLink(read(), [cli("agy", false)], "antigravity")).toBe("nocli");
    expect(agentLink(read(), [cli("agy", true)], "antigravity")).toBe("unconnected");
    // Still looking for the CLIs: not connected, nothing more.
    expect(agentLink(read(), null, "antigravity")).toBe("unconnected");
  });
});

describe("todoList", () => {
  it("is empty when everything is set up", () => {
    expect(todoList(input())).toEqual([]);
    expect(leftCount(todoList(input()))).toBe(0);
  });

  it("does not ask to connect an agent whose CLI is not installed", () => {
    const i = input({ hooks: { claude: read({ installed: true }), copilot: read({ installed: true }), antigravity: read() }, clis: [cli("claude", true), cli("copilot", true), cli("agy", false)] });
    expect(todoList(i)).toEqual([]);
  });

  it("asks to connect an installed CLI, and counts updates too", () => {
    const i = input({ hooks: { claude: read(), copilot: read({ installed: true }, "+ x"), antigravity: read({ installed: true }) } });
    const t = todoList(i);
    expect(t.map((x) => x.kind)).toEqual(["agent-unconnected", "agent-update"]);
    expect(t[0].anchor).toBe("agent-claude");
    expect(leftCount(t)).toBe(2);
  });

  it("says a missing relay once, not three times", () => {
    const off = read({ installed: true, hookReady: false });
    const t = todoList(input({ hooks: { claude: off, copilot: off, antigravity: off } }));
    expect(t.map((x) => x.kind)).toEqual(["relay"]);
  });

  it("wants a key for the chat model in use, unless it takes none", () => {
    expect(todoList(input({ present: {} })).map((x) => x.kind)).toEqual(["chat-no-key"]);
    const local = { ...DEFAULT_PROVIDER, id: "ollama", name: "Ollama", kind: "openai" as const, baseUrl: "http://localhost:11434/v1", model: "qwen3", auth: "none" };
    expect(todoList(input({ present: {} }, { providers: [local], activeProvider: "ollama" }))).toEqual([]);
  });

  it("wants an endpoint and a model", () => {
    const custom = { ...DEFAULT_PROVIDER, id: "custom", name: "Custom", kind: "openai" as const, baseUrl: "", model: "" };
    const t = todoList(input({ present: { "provider:custom": true } }, { providers: [custom], activeProvider: "custom" }));
    expect(t.map((x) => x.kind)).toEqual(["chat-incomplete"]);
  });

  it("with an agent in the chat bar, still wants one provider for the secretary", () => {
    const s = { activeProvider: "agent:copilot", agents: [{ ...DEFAULT_AGENT }] };
    expect(todoList(input({ present: {} }, s)).map((x) => x.kind)).toEqual(["chat-no-key"]);
    expect(todoList(input({}, s))).toEqual([]);
  });

  it("wants an agent's key only when its environment names {secret}", () => {
    const plain = { ...DEFAULT_AGENT, id: "copilot", env: {} };
    const byok = { ...DEFAULT_AGENT, id: "cg", name: "cg", env: { COPILOT_PROVIDER_API_KEY: "{secret}" } };
    expect(todoList(input({}, { agents: [plain] }))).toEqual([]);
    expect(todoList(input({}, { agents: [byok] })).map((x) => x.kind)).toEqual(["agent-profile-no-key"]);
    expect(todoList(input({ present: { "provider:anthropic": true, "agent:cg": true } }, { agents: [byok] }))).toEqual([]);
  });

  it("does not count pills that are on without a key", () => {
    const i = input({ integrations: [{ id: "integration_github", name: "GitHub", keys: ["github-token"] }] }, { activeIntegrations: ["integration_github"] });
    expect(todoList(i)).toEqual([]);
  });

  it("says when the shortcut is taken", () => {
    expect(todoList(input({ hotkeyError: "taken" })).map((x) => x.kind)).toEqual(["hotkey"]);
  });
});

describe("pageBadges", () => {
  it("shows a number for to-dos, ! for updates only, ✓ when set up", () => {
    const i = input({ hooks: { claude: read(), copilot: read({ installed: true }), antigravity: read({ installed: true }) } });
    const b = pageBadges(i);
    expect(b.connect.todo).toBe(1);
    expect(b.overview.todo).toBe(1);
    expect(b.chat.ok).toBe(true);
    const u = pageBadges(input({ hooks: { claude: read({ installed: true }, "+ x"), copilot: read({ installed: true }), antigravity: read({ installed: true }) } }));
    expect(u.connect).toEqual({ todo: 0, update: true, ok: false });
    expect(pageBadges(input()).connect.ok).toBe(true);
  });
});

describe("shouldAutoShowGuide", () => {
  const none = { claude: read(), copilot: read(), antigravity: read() };
  it("opens for someone with nothing connected", () => {
    expect(shouldAutoShowGuide(null, none)).toBe(true);
  });
  it("stays shut once finished or put off", () => {
    expect(shouldAutoShowGuide("done", none)).toBe(false);
    expect(shouldAutoShowGuide("later", none)).toBe(false);
  });
  it("stays shut when any agent is connected", () => {
    expect(shouldAutoShowGuide(null, { ...none, copilot: read({ installed: true }) })).toBe(false);
  });
  it("waits until all three files are read", () => {
    expect(shouldAutoShowGuide(null, { claude: read() })).toBe(false);
  });
});
