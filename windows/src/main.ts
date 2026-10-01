// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";

/**
 * Makes one CSS pixel equal one window-logical pixel, whatever the webview
 * thinks. Rust sizes the window from the display scale (125 % → a 900 px
 * window for a 720 pt panel), but Windows' accessibility "Text size" setting
 * scales WebView2 content on top of that: at 150 % text size the page renders
 * at 1.875× and a 640 pt island overflows a 720 pt window on both sides, Mochi
 * cut off at the left edge. The whole UI is laid out in the same logical pixels
 * the cursor poll and the island rect use, so the fix is one zoom on the root
 * that cancels the extra factor.
 */
function fitToWindow(windowScale: number | null) {
  const root = document.getElementById("root");
  if (!root || !windowScale) return;
  const zoom = windowScale / (window.devicePixelRatio || 1);
  const want = Math.abs(zoom - 1) < 0.01 ? "" : zoom.toFixed(4);
  if (root.style.zoom !== want) {
    root.style.zoom = want;
    State.zoom = want ? zoom : 1;
    State.notify();
  }
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  fitToWindow(boot?.screen.scale ?? null);
  island.applySettings();
  State.loadIntegrationTasks();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => {
    void Bridge.reposition();
    // A display with another scale, or a changed text size, lands here too.
    void Bridge.boot().then((b) => fitToWindow(b?.screen.scale ?? null));
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
