<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Coucou icon">

# Coucou for Windows

**Mochi doesn't get a notch on a PC — so it lives at the top of your screen instead.**

Approve Claude Code permissions, watch your session work, drop a file, chat with Claude, keep an eye on your services — without leaving what you're doing.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

</div>

<img src="screenshots/greeting.png" width="640" alt="Mochi waving hello at launch">

---

## Install

The downloadable installer is **temporarily unavailable**. Microsoft Defender
wrongly flags the unsigned installer as malware (`Trojan:Win32/Wacatac.H!ml`, a
machine-learning false positive). A report is under review at Microsoft, and the
installer will be published again once it is cleared and code-signed.

Until then, [build it yourself](#build-it-yourself): it takes a few minutes and
installs for the current user only — no admin prompt.

## Using it

<img src="screenshots/compact.png" width="292" alt="The compact island, with the integration pills as mini Mochis">
<img src="screenshots/overview.png" width="640" alt="The overview: the focused integration on the left, the other pills on the right">
<img src="screenshots/approval.png" width="640" alt="A Claude Code permission request, with Deny and Allow">
<img src="screenshots/chat.png" width="640" alt="Chatting with Claude from the island">
<img src="screenshots/drop.png" width="640" alt="Mochi turned into a box, waiting for a file">

| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | Mochi peeks out |
| Click the small island | It opens |
| Click Mochi | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on Mochi for two seconds | Hearts |
| Drag a file onto the island | Mochi turns into a box, swallows it, then offers to answer questions about it |
| Click anywhere else, or the × in the corner | The island shuts at once |
| `Ctrl+Shift+Space` (changeable in Settings) | Opens or hides the island from any app |
| `Esc` | Closes the island (chat view) |
| Tray icon | Open, Settings…, Pause, Quit |

A Mochi that only peeked out because the mouse brushed the top edge goes away
1.5 s after the mouse leaves; one you opened on purpose waits for the auto-close
countdown instead.

Everything else happens on its own: a Claude Code permission request opens the
island with **Deny / Allow**, a finished session shows what it did, and
your integrations sit in the coloured pills next to Mochi.

The permission card shows the whole request, not a headline: the full command,
the content a Write will put on disk, the old and new strings of an Edit, the
arguments of an MCP tool. The card grows to fit and scrolls past 300 px. If a
request is too large for the relay to carry whole (over 64 KB in a single
field), the card says so and offers **Ask in terminal** instead of Allow — you
can always deny from the island, but never approve something you could not read.

## Claude Code

<img src="screenshots/settings.png" width="562" alt="The settings window">

Open **Settings… → Claude Code → Install hooks…**. You get the exact diff of what
will change in `%USERPROFILE%\.claude\settings.json`, the path of the dated backup
that will be taken, and nothing is written until you click. Your own hooks are
never touched, and uninstalling removes only Coucou's entries.

The relay is a tiny executable, `coucou-hook.exe`, copied to
`%LOCALAPPDATA%\Coucou\bin\` at launch. It is given 300 ms to reach Coucou and
exits cleanly if the app is closed, slow or crashed — **a Claude Code session is
never blocked or slowed down by Coucou.** If nobody answers a permission request
in time, Coucou stays quiet and Claude Code asks in the terminal as usual.

It works from any terminal — Windows Terminal, PowerShell, VS Code, Git Bash.

## Copilot CLI

**Settings… → Copilot CLI → Install hooks…** does the same for GitHub Copilot
CLI (`copilot`, or a wrapper function around it): it writes one file of
Coucou's own, `%USERPROFILE%\.copilot\hooks\coucou.json`, and nothing else.
Copilot's PascalCase hook events send the same payloads as Claude Code, so the
same relay serves both; `--agent copilot` on the command line tells the island
which CLI is talking, and Copilot sessions get their own pill next to Mochi.
Permission requests reach the island too, unless the session runs with
`--yolo`, which approves everything before any hook sees it.

## Agents you drive from the island

**Settings… → Agents** lists coding agents Coucou starts itself and talks to
over the [Agent Client Protocol](https://agentclientprotocol.com): Copilot CLI
(`copilot --acp --stdio`) out of the box, with a BYOK preset for a provider of
your own, or any other ACP-speaking agent by command. Pick one in the chat
bar (the chip at the left cycles through providers and agents) and your
question goes to it: the reply streams in as it speaks, its tool calls show
as small lines, and whatever it needs permission for asks on the island, like
a hook's request. **New** starts a fresh session. The agent's process is
stopped when you reset it and when Coucou quits.

## Chat and keys

**Settings… → Chat providers** is where the chat sends its questions. Out of the
box there is one provider, Claude at `api.anthropic.com`; add as many as you
like and pick which one is in use:

| Kind | Covers |
|---|---|
| Anthropic Messages API | Claude, or a proxy that speaks it |
| OpenAI-compatible, Chat Completions wire | OpenAI, OpenRouter, Azure OpenAI, Ollama, LM Studio, vLLM, most proxies |
| OpenAI-compatible, Responses wire | endpoints built on `/v1/responses` |

Each provider has its own endpoint, model, way of carrying the key (Bearer,
`x-api-key`, a custom header such as Azure's `api-key`, or none for a local
server), optional extra headers, and three capability switches — images, PDFs,
web search — that default to what the kind usually supports. **Test connection**
sends one tiny question and shows the reply, so a wrong URL or key is caught
before the island ever shows an error. Web search is Anthropic's server-side
tool and only runs there.

Keys live in the **Windows Credential Manager** under `provider:<id>`, never on
disk and never in the interface — the island can only ask whether a key exists.
Same for every integration key.

No telemetry. The only network requests Coucou makes are to the services you
configure yourself.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the
**MSVC build tools** (Visual Studio Build Tools with "Desktop development with
C++"). WebView2 ships with Windows 10/11.

```powershell
cd windows
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # builds the installer and drops it in windows/release/
```

`npm run dev` alone serves the front end in an ordinary browser, which is enough
to work on the island's looks. It also serves `dev/upload-preview.html`, which
replays the whole file-drop choreography on a loop — the one part of the UI that
otherwise needs a real drag from Explorer to see. Neither page ships in the app.

`npm run pack` leaves two files in `windows/release/`, the same names the release
workflow publishes:

```
Coucou-Windows-X.Y.Z-setup.exe    the versioned installer
Coucou-Windows-setup.exe          the same file under the rolling name
```

Installing is optional — `target/release/coucou.exe` runs on its own. There is no
window in the taskbar and no console: the island at the top of the screen and the
Mochi in the notification area are the whole app, and Quit lives in its menu.

The 28 sounds are the macOS app's own files; they are never duplicated in this
folder. The path is declared once, in `SOUNDS_DIR` at the top of
`vite.config.ts` — when they move to `shared/sounds/`, change that one line.

The app icon and the tray icon are drawn in code, like Mochi itself:

```powershell
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
```

### Layout

```
windows/
  src/                 island front end (TypeScript, no framework)
    mochi/             Mochi and the launch greeting, in Canvas 2D
    island/            state machine, hooks, integrations
    views/             every island view
    settings/          the settings window
  src-tauri/           Rust backend: window, named pipe, Claude API, pollers
  hook/                coucou-hook.exe, the Claude Code relay
  scripts/             icon generator
```

### Log

`%LOCALAPPDATA%\Coucou\coucou.log` — hook events, permission decisions, poller
problems. It stays on your machine.

## What's different from the Mac version

- No notch, so the island lives at the top centre of the screen and retracts into
  the top edge instead of hiding in a notch.
- Permission approval works from **any** terminal; the Mac build only listens to
  VS Code sessions.
- Not in this version: sending a file by email, dragging Mochi onto a window to
  attach it as context, and jumping to a specific terminal window — "Open
  terminal" opens the working folder in VS Code when `code` is on your `PATH`.
- Cal.com shows the next bookings as a list rather than the Mac's calendar.
