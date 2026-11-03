// Serves the app's front end with the deck's story in place of src/team/demo.ts.
// Untracked; run from windows/ with `npx vite --config dev/deck/vite.deck.config.ts`.
import { defineConfig, mergeConfig, type Plugin } from "vite";
import base from "../../vite.config";
import { resolve } from "node:path";

const deckStory = (): Plugin => ({
  name: "deck-story",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "./demo" && importer && /[\\/]src[\\/]team[\\/]/.test(importer)) return resolve(__dirname, "demo-deck.ts");
    return null;
  },
  transform(code, id) {
    if (/[\\/]src[\\/]team[\\/]secretary\.ts$/.test(id)) {
      // The browser's stand-in for confirming a card: the deck's team is created.
      return code.replace(
        /\{ \.\.\.p, state: "done" as const, outcome: tr\("\(瀏覽器預覽,沒有真的執行\)", "\(browser preview, nothing was really run\)"\) \}/,
        '(await import("./demo") as any).demoConfirm(p)',
      );
    }
    if (/[\\/]src[\\/]team[\\/]main\.ts$/.test(id)) {
      // No painted desktop behind the window: the app's own flat dark sheet.
      return code
        .replace('document.documentElement.classList.add("demo");', 'document.documentElement.classList.add("deck");')
        .replace('runs.has("shop")', 'runs.has("team")')
        .replace('runs.set("shop", snap)', 'runs.set("team", snap)')
        // The board's progress bar follows the run, as it does in the app.
        .replace(/live\.applySnapshot\(next\);(\r?\n\s+)if \(tab === "monitor"\) render\(\);/, 'live.applySnapshot(next);$1office.feed(files, runs);$1if (tab === "monitor") render();');
    }
    return null;
  },
});

export default mergeConfig(base, defineConfig({ root: resolve(__dirname, "../.."), plugins: [deckStory()], server: { port: 1421, strictPort: true, host: "127.0.0.1" } }));
