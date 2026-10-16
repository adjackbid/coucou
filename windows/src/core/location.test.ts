import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT, isLocalAddress, locationOf } from "./state";

// The same cases as acp.rs `an_agent_is_cloud_unless_it_is_set_local_…`:
// the settings window and Rust must sort an agent the same way.
describe("Cloud Agent or Local Agent", () => {
  it("tells a host on this machine or a private network", () => {
    for (const local of ["http://localhost:11434/v1", "http://127.0.0.1:8080", "https://192.168.1.20/v1", "http://10.0.0.5:4000", "http://172.20.1.1", "http://[::1]:1234/v1", "http://gpu-box.lan/v1"]) {
      expect(isLocalAddress(local), local).toBe(true);
    }
    for (const cloud of ["https://llm-share.duotify.com/v1", "https://172.32.0.1", "https://api.openai.com/v1", "https://user@10.example.com"]) {
      expect(isLocalAddress(cloud), cloud).toBe(false);
    }
  });

  it("guesses from the endpoint, keeps what the person chose, and makes an n8n node local", () => {
    expect(locationOf(DEFAULT_AGENT)).toBe("cloud");
    expect(locationOf({ ...DEFAULT_AGENT, env: { COPILOT_PROVIDER_BASE_URL: "http://localhost:11434/v1" } })).toBe("local");
    // Only Copilot over ACP has an endpoint of its own to judge by.
    expect(locationOf({ protocol: "claude", env: { COPILOT_PROVIDER_BASE_URL: "http://localhost:1" } })).toBe("cloud");
    expect(locationOf({ ...DEFAULT_AGENT, location: "local" })).toBe("local");
    expect(locationOf({ ...DEFAULT_AGENT, env: { COPILOT_PROVIDER_BASE_URL: "http://localhost:1" }, location: "cloud" })).toBe("cloud");
    expect(locationOf({ protocol: "n8n", location: "cloud", env: {} })).toBe("local");
    expect(locationOf({ ...DEFAULT_AGENT, location: null })).toBe("cloud");
  });
});
