// The no-installer hand-off: the four exes a user actually needs, zipped as
// windows/release/AgentCenter-Windows-<version>-portable.zip. coucou.exe embeds the
// whole frontend; the three helpers only have to sit beside it (on launch the
// app copies them into %LOCALAPPDATA%\Coucou\bin itself). Used by
// `npm run pack:portable` after any `tauri build`.

import { readFileSync, mkdirSync, copyFileSync, rmSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "target", "release");
const outDir = join(root, "release");

const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const FILES = ["coucou.exe", "coucou-hook.exe", "coucou-pty.exe", "coucou-team-mcp.exe"];

for (const f of FILES) {
  if (!existsSync(join(bin, f))) {
    console.error(`Missing ${join(bin, f)} — run \`npm run tauri build\` first.`);
    process.exit(1);
  }
}

// Staged under the folder name the user will see after unzipping.
const stage = join(outDir, "Agent Center");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of FILES) copyFileSync(join(bin, f), join(stage, f));

const zip = join(outDir, `AgentCenter-Windows-${version}-portable.zip`);
rmSync(zip, { force: true });
execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}' -DestinationPath '${zip}'`], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });

const mb = (statSync(zip).size / 1024 / 1024).toFixed(2);
console.log(`\n  Portable zip ready — ${mb} MB\n`);
console.log(`  ${zip}`);
console.log("  Unzip anywhere and run Agent Center\\coucou.exe (needs the WebView2 runtime, built into Windows 10/11).");
