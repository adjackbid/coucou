// Hook installation for the CLIs the island watches.
//
// The rule from CLAUDE.md is strict and is followed to the letter:
// read the config, take a dated backup, merge without touching anybody else's
// hooks, show the diff, and write only after an explicit click. Uninstall
// removes Coucou's entries and nothing else.
//
// Claude Code: %USERPROFILE%\.claude\settings.json, merged entry by entry. The
// command is only the quoted exe path in forward slashes plus the event name:
// on Windows Claude Code runs hook commands through Git Bash, and anything
// with PowerShell or cmd in it breaks.
//
// Copilot CLI: %USERPROFILE%\.copilot\hooks\coucou.json, a file of our own in
// a folder Copilot reads whole, so there is nothing to merge — install writes
// it, uninstall removes it. Its PascalCase event names make Copilot send the
// same snake_case payloads as Claude Code, with the tool names mapped, which
// is why one relay serves both; the `--agent copilot` argument is what tells
// the island (and the relay's answer shape) apart.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::settings;

/// Every event the island reacts to, with the hook timeout written to settings.json.
/// PermissionRequest waits for a human, so it gets the decision timeout + 10 s.
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 10),
    ("StopFailure", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

/// Copilot CLI's PascalCase events — the Claude-compatible ones — plus the
/// lowercase `notification`, whose `message` field is all the island reads.
/// Copilot kills a hook at its timeout and carries on (fail-open), so the
/// permission one gets the decision budget with room to spare.
pub const COPILOT_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("notification", 10),
    ("Stop", 10),
    ("SubagentStop", 10),
    ("ErrorOccurred", 10),
];

/// Marker that identifies a Coucou entry inside settings.json.
const MARKER: &str = "coucou-hook";

/// Antigravity's events that cannot change what the agent does: no
/// PreToolUse (its answer decides permissions) and no PostInvocation (its
/// answer can force the loop on). The relay prints `{}` for each of these.
pub const ANTIGRAVITY_EVENTS: &[&str] = &["PreInvocation", "PostToolUse", "Stop"];

/// The name of Coucou's entry in Antigravity's hooks.json.
const ANTIGRAVITY_KEY: &str = "coucou";

/// The CLIs whose hooks Coucou can install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Copilot,
    Antigravity,
}

impl Agent {
    pub fn parse(name: &str) -> Option<Agent> {
        match name {
            "claude" | "" => Some(Agent::Claude),
            "copilot" => Some(Agent::Copilot),
            "antigravity" => Some(Agent::Antigravity),
            _ => None,
        }
    }

    /// The file this agent's hooks live in.
    pub fn config_path(self) -> PathBuf {
        match self {
            Agent::Claude => settings_path(),
            Agent::Copilot => home().join(".copilot").join("hooks").join("coucou.json"),
            // The global customization root, shared by the CLI, the app and the IDE.
            Agent::Antigravity => home().join(".gemini").join("config").join("hooks.json"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    pub settings_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    /// Identifies the bytes this diff was computed from; handed back to `write`
    /// so we only ever apply what the user actually looked at.
    pub fingerprint: String,
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn settings_path() -> PathBuf {
    home().join(".claude").join("settings.json")
}

/// Reads `~/.claude/settings.json`.
///
/// The only error that means "start from nothing" is the file not being there.
/// Everything else — a lock held by another process, a permission problem, JSON
/// we cannot parse — is reported, because the alternative is treating somebody's
/// unreadable settings as an empty object and then writing that back over them.
fn read_settings() -> Result<Value, String> {
    let path = settings_path();
    match std::fs::read(&path) {
        Ok(bytes) => parse_settings(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        // A lock, a permission problem, a bad drive: all of them mean we do not
        // know what is in there, and not knowing is not the same as empty.
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

/// The parsing half of `read_settings`, split out so it can be tested without a
/// home directory.
fn parse_settings(bytes: &[u8], path: &str) -> Result<Value, String> {
    // PowerShell writes a UTF-8 BOM with `Set-Content -Encoding utf8`, and
    // serde_json refuses it. Stripping it is safe and well defined; guessing at
    // anything else is not.
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{path} isn't a JSON object — Coucou won't touch it.")),
        Err(err) => Err(format!(
            "{path} isn't valid JSON ({err}). Fix or move it, then try again — Coucou won't overwrite it."
        )),
    }
}

/// The settings as they are, or an empty object when we cannot tell. Only for
/// read-only paths like `status()`, which must never fail loudly; anything that
/// writes uses `read_settings()` and surfaces the error instead.
fn read_settings_lossy() -> Value {
    read_settings().unwrap_or_else(|_| json!({}))
}

fn hook_command(event: &str) -> String {
    let exe = settings::hook_exe_path().to_string_lossy().replace('\\', "/");
    format!("\"{exe}\" {event}")
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .map(|c| c.contains(MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Settings with Coucou's hooks added; everything else is left untouched.
fn merged(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);

    for (event, timeout) in HOOK_EVENTS {
        let mut list = hooks
            .get(*event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        list.retain(|entry| !entry_is_ours(entry));
        list.push(json!({
            "hooks": [{
                "type": "command",
                "command": hook_command(event),
                "timeout": timeout,
            }]
        }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }

    root.insert("hooks".into(), Value::Object(hooks));
    Value::Object(root)
}

/// Settings with every Coucou entry removed, and nothing else changed.
fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() else {
        return Value::Object(root);
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        match value.as_array() {
            Some(list) => {
                let kept: Vec<Value> =
                    list.iter().filter(|e| !entry_is_ours(e)).cloned().collect();
                if !kept.is_empty() {
                    out.insert(event, Value::Array(kept));
                }
            }
            None => {
                out.insert(event, value);
            }
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Value::Object(root)
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// Down to the second: installing then uninstalling in the same minute must not
/// quietly overwrite the first backup.
fn stamp() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

fn backup_path(agent: Agent) -> PathBuf {
    let p = agent.config_path();
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    p.with_file_name(format!("{name}.bak-{}", stamp()))
}

/// The whole of Copilot's hook file: one entry per event, `exec` + `args` so
/// no shell ever sees the path.
fn copilot_file() -> Value {
    let exe = settings::hook_exe_path().to_string_lossy().to_string();
    let mut hooks = Map::new();
    for (event, timeout) in COPILOT_EVENTS {
        hooks.insert(
            (*event).to_string(),
            json!([{
                "type": "command",
                "exec": exe,
                "args": ["--agent", "copilot", event],
                "timeoutSec": timeout,
            }]),
        );
    }
    json!({ "version": 1, "hooks": hooks })
}

/// Coucou's named hook in Antigravity's hooks.json. The command runs through
/// `cmd /c`, so it is the quoted path and plain arguments, nothing a shell
/// could read as syntax. Tool events are grouped under a matcher; the others
/// are flat lists.
fn antigravity_entry() -> Value {
    let exe = settings::hook_exe_path().to_string_lossy().to_string();
    let handler = |event: &str| {
        json!({
            "type": "command",
            "command": format!("\"{exe}\" --agent antigravity {event}"),
            "timeout": 10,
        })
    };
    let mut entry = Map::new();
    for event in ANTIGRAVITY_EVENTS {
        let value = if *event == "PostToolUse" {
            json!([{ "matcher": "*", "hooks": [handler(event)] }])
        } else {
            json!([handler(event)])
        };
        entry.insert((*event).to_string(), value);
    }
    Value::Object(entry)
}

/// Antigravity's hooks.json with Coucou's entry set or removed; every other
/// named hook is left exactly as it was. Empty text means "no file".
fn antigravity_file(current: &str, install: bool) -> Result<String, String> {
    let path = Agent::Antigravity.config_path().display().to_string();
    let mut root = parse_settings(current.as_bytes(), &path)?
        .as_object()
        .cloned()
        .unwrap_or_default();
    if install {
        root.insert(ANTIGRAVITY_KEY.into(), antigravity_entry());
    } else {
        root.remove(ANTIGRAVITY_KEY);
    }
    if root.is_empty() {
        return Ok(String::new());
    }
    Ok(pretty(&Value::Object(root)))
}

/// A hook file of the kind Coucou may create or remove, as text; empty when
/// it is not there. Unreadable is an error, for the same reason as
/// `read_settings`.
fn read_hook_file(agent: Agent) -> Result<String, String> {
    let path = agent.config_path();
    match std::fs::read(&path) {
        Ok(bytes) => {
            let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
            Ok(String::from_utf8_lossy(text).to_string())
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

/// Identifies the exact bytes a preview was computed from. FNV-1a is plenty:
/// the question is only "is this still the file I showed the user?".
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn current_fingerprint(agent: Agent) -> String {
    match std::fs::read(agent.config_path()) {
        Ok(bytes) => fingerprint(&bytes),
        Err(_) => fingerprint(b""),
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn status(agent: Agent) -> HookStatus {
    let installed = match agent {
        Agent::Claude => read_settings_lossy()
            .get("hooks")
            .and_then(Value::as_object)
            .map(|hooks| {
                hooks
                    .values()
                    .filter_map(Value::as_array)
                    .flatten()
                    .any(entry_is_ours)
            })
            .unwrap_or(false),
        Agent::Copilot => read_hook_file(agent).map(|t| t.contains(MARKER)).unwrap_or(false),
        Agent::Antigravity => read_hook_file(agent)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .map(|v| v.get(ANTIGRAVITY_KEY).is_some())
            .unwrap_or(false),
    };
    let hook_path = settings::hook_exe_path();
    HookStatus {
        installed,
        settings_path: agent.config_path().to_string_lossy().to_string(),
        hook_ready: hook_path.exists(),
        hook_path: hook_path.to_string_lossy().to_string(),
    }
}

/// The file's text before and after, which is all a preview or a write needs.
fn before_and_after(agent: Agent, install: bool) -> Result<(String, String), String> {
    match agent {
        Agent::Claude => {
            let current = read_settings()?;
            let next = if install { merged(&current) } else { without_ours(&current) };
            Ok((pretty(&current), pretty(&next)))
        }
        Agent::Copilot => {
            let current = read_hook_file(agent)?;
            let next = if install { pretty(&copilot_file()) } else { String::new() };
            Ok((current, next))
        }
        Agent::Antigravity => {
            let current = read_hook_file(agent)?;
            let next = antigravity_file(&current, install)?;
            Ok((current, next))
        }
    }
}

pub fn preview(agent: Agent, install: bool) -> Result<HookPreview, String> {
    let (before, after) = before_and_after(agent, install)?;
    Ok(HookPreview {
        diff: unified_diff(&before, &after),
        backup: backup_path(agent).to_string_lossy().to_string(),
        settings_path: agent.config_path().to_string_lossy().to_string(),
        fingerprint: current_fingerprint(agent),
    })
}

/// Writes the merged (or cleaned) config after taking a dated backup. For
/// Copilot, "cleaned" means the file is gone.
///
/// `fingerprint` is the one the preview was computed from. If the file changed
/// in between — another tool, another window, the user's own editor — we stop
/// and make them look at a fresh diff, because the only thing worse than not
/// installing the hooks is silently reverting somebody else's edit.
pub fn write(agent: Agent, install: bool, fingerprint: &str) -> Result<String, String> {
    let path = agent.config_path();
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // Read before the backup: an unreadable file must abort before we touch
    // anything at all.
    let (_, after) = before_and_after(agent, install)?;
    if current_fingerprint(agent) != fingerprint {
        return Err(format!(
            "{} changed since the preview. Nothing was written — review the new diff.",
            path.display()
        ));
    }

    let backup = backup_path(agent);
    if path.exists() {
        std::fs::copy(&path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    }

    if after.is_empty() {
        // Nothing of anyone's is left in it: the file goes (Copilot's was
        // ours alone; Antigravity's held only our entry).
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("remove failed: {err}")),
        }
        return Ok(backup.to_string_lossy().to_string());
    }

    let mut text = after;
    text.push('\n');

    // Write beside the target and rename over it: a crash or a full disk leaves
    // the original file intact rather than half a file.
    let temp = path.with_extension(format!("json.coucou-{}", std::process::id()));
    std::fs::write(&temp, text.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    if let Err(err) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(backup.to_string_lossy().to_string())
}

/// Copies coucou-hook.exe into %LOCALAPPDATA%\Coucou\bin on launch.
/// In a bundled install it comes from the app resources; in `tauri dev` it sits
/// next to coucou.exe in the workspace target directory.
///
/// Every candidate is tried rather than just the first, because getting this
/// wrong is silent and fatal: `resources` used to be a glob, which made NSIS
/// mirror the source path into `_up_\target\release\`, no candidate matched, and
/// the relay was simply never installed. It only looked healthy on a developer
/// machine, where a leftover copy from `tauri dev` was already sitting in bin/.
pub fn ensure_hook_exe(app: &AppHandle) {
    ensure_exe(app, "coucou-hook.exe", "hooks cannot work");
    // The terminal wrapper rides along the same way: `coucou-pty -- copilot …`.
    ensure_exe(app, "coucou-pty.exe", "the island cannot type into terminals");
}

fn ensure_exe(app: &AppHandle, name: &str, consequence: &str) {
    let dest = settings::local_dir().join("bin").join(name);
    let Some(dir) = dest.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve(name, tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Installed build, then `tauri dev` (target/debug) next to the
            // release build the pre-build step produces.
            candidates.push(parent.join(name));
            candidates.push(parent.join("../release").join(name));
            // Belt and braces: where the old glob form used to land it.
            candidates.push(parent.join("_up_/target/release").join(name));
        }
    }

    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    let Some(src) = candidates.into_iter().find(|p| p.exists()) else {
        crate::log::line(format!("{name} not found — {consequence}. Looked in: {}", tried.join(", ")));
        return;
    };

    let same = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() == b.modified().ok(),
        _ => false,
    };
    if same {
        return;
    }
    // It may be running right now and hold the file open; keeping the old
    // copy is fine, it is the same program.
    if let Err(err) = std::fs::copy(&src, &dest) {
        if !dest.exists() {
            crate::log::line(format!("could not install {name}: {err}"));
        }
    }
}

// ── Minimal unified diff (LCS) ────────────────────────────────────────────────

/// settings.json is short, so a plain O(n·m) LCS is the simplest honest diff.
fn unified_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());

    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut out: Vec<String> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(format!("  {}", a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(format!("- {}", a[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(format!("- {}", a[i]));
        i += 1;
    }
    while j < m {
        out.push(format!("+ {}", b[j]));
        j += 1;
    }

    // Keep three lines of context around each change so the panel stays readable.
    let changed: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with('+') || l.starts_with('-'))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return "No change.".into();
    }
    let mut keep = vec![false; out.len()];
    for idx in changed {
        let lo = idx.saturating_sub(3);
        let hi = (idx + 4).min(out.len());
        for k in lo..hi {
            keep[k] = true;
        }
    }
    let mut result = String::new();
    let mut gap = false;
    for (idx, line) in out.iter().enumerate() {
        if keep[idx] {
            result.push_str(line);
            result.push('\n');
            gap = false;
        } else if !gap {
            result.push_str("  …\n");
            gap = true;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHERE: &str = "settings.json";

    #[test]
    fn a_utf8_bom_is_stripped_not_treated_as_corruption() {
        // PowerShell 5's `Set-Content -Encoding utf8` produces exactly this.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"{"model":"opus","hooks":{}}"#);
        let parsed = parse_settings(&bytes, WHERE).expect("a BOM must not defeat the parser");
        assert_eq!(parsed["model"], "opus");
    }

    #[test]
    fn unreadable_content_is_an_error_never_an_empty_object() {
        // This is the whole bug: returning {} here meant `merged()` produced a
        // file containing nothing but Coucou's hooks, and the write replaced
        // everything the user had.
        for bad in [&b"{ not json"[..], &b"[1,2,3]"[..], &b"\"a string\""[..]] {
            assert!(
                parse_settings(bad, WHERE).is_err(),
                "content we cannot use must refuse, not come back empty"
            );
        }
    }

    #[test]
    fn empty_and_whitespace_files_start_from_nothing() {
        assert_eq!(parse_settings(b"", WHERE).unwrap(), json!({}));
        assert_eq!(parse_settings(b"  
	 ", WHERE).unwrap(), json!({}));
    }

    #[test]
    fn merging_keeps_every_other_setting_and_every_foreign_hook() {
        let existing = serde_json::json!({
            "model": "claude-opus-5",
            "theme": "dark",
            "enabledPlugins": ["a", "b"],
            "hooks": {
                "PreToolUse": [
                    { "hooks": [{ "type": "command", "command": "someone-elses-tool.exe" }] }
                ],
                "SomeEventWeDoNotTouch": [
                    { "hooks": [{ "type": "command", "command": "keep-me.exe" }] }
                ]
            }
        });

        let after = merged(&existing);
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["enabledPlugins"], serde_json::json!(["a", "b"]));

        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(
            pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("someone-elses-tool.exe")),
            "another tool's hook was dropped"
        );
        assert!(pre.iter().any(entry_is_ours), "our own hook was not added");
        assert!(after["hooks"]["SomeEventWeDoNotTouch"].is_array());

        // And removing ours puts it back exactly as it was.
        let cleaned = without_ours(&after);
        assert_eq!(cleaned, existing);
    }

    #[test]
    fn a_fingerprint_notices_any_change() {
        assert_eq!(fingerprint(b"{}"), fingerprint(b"{}"));
        assert_ne!(fingerprint(b"{}"), fingerprint(b"{ }"));
        assert_ne!(fingerprint(b""), fingerprint(b"{}"));
    }

    /// Everything filesystem-shaped lives in one test on purpose: it points
    /// USERPROFILE at a temp directory, and that is process-wide.
    #[test]
    fn writing_backs_up_preserves_and_refuses_a_changed_file() {
        let tmp = std::env::temp_dir().join(format!("coucou-hooks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        std::env::set_var("USERPROFILE", &tmp);

        let path = settings_path();
        assert!(path.starts_with(&tmp), "the test must not touch the real home");

        // A real-shaped file, written the way PowerShell 5 would: UTF-8 with BOM.
        let original = r#"{"model":"claude-opus-5","theme":"dark","tui":{"x":1},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"other-tool.exe"}]}]}}"#;
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(original.as_bytes());
        std::fs::write(&path, &bytes).unwrap();

        // Install.
        let plan = preview(Agent::Claude, true).expect("a BOM must not stop the preview");
        assert!(plan.diff.contains("coucou-hook"), "the diff must show what changes");
        let backup = write(Agent::Claude, true, &plan.fingerprint).expect("install should succeed");

        // The backup holds the original bytes, BOM and all.
        assert_eq!(std::fs::read(&backup).unwrap(), bytes);

        // Everything else survived, and so did the other tool's hook.
        let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["tui"]["x"], 1);
        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("other-tool.exe")));
        assert!(status(Agent::Claude).installed);

        // A file that moved since the preview is refused, and left alone.
        let stale = preview(Agent::Claude, false).unwrap();
        std::fs::write(&path, br#"{"model":"someone-else-edited-this"}"#).unwrap();
        let err = write(Agent::Claude, false, &stale.fingerprint).unwrap_err();
        assert!(err.contains("changed since the preview"), "got: {err}");
        let untouched: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(untouched["model"], "someone-else-edited-this");

        // Content we cannot parse is refused before anything is written.
        std::fs::write(&path, b"{ broken").unwrap();
        assert!(preview(Agent::Claude, true).is_err());
        assert!(write(Agent::Claude, true, "whatever").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");

        // Copilot: a file of our own, created, then removed, in the hooks folder.
        assert!(!status(Agent::Copilot).installed);
        let plan = preview(Agent::Copilot, true).unwrap();
        assert!(plan.diff.contains("--agent"), "the diff must show the relay entries");
        write(Agent::Copilot, true, &plan.fingerprint).expect("copilot install should succeed");
        let file = Agent::Copilot.config_path();
        assert!(file.starts_with(&tmp));
        let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(written["version"], 1);
        assert_eq!(written["hooks"]["PermissionRequest"][0]["args"], json!(["--agent", "copilot", "PermissionRequest"]));
        assert_eq!(written["hooks"]["PermissionRequest"][0]["timeoutSec"], 120);
        assert!(status(Agent::Copilot).installed);
        let plan = preview(Agent::Copilot, false).unwrap();
        write(Agent::Copilot, false, &plan.fingerprint).expect("copilot uninstall should succeed");
        assert!(!file.exists());
        assert!(!status(Agent::Copilot).installed);

        // Antigravity: one named entry merged into a hooks.json that may hold
        // other people's hooks, which survive both install and uninstall.
        let agy = Agent::Antigravity.config_path();
        assert!(agy.starts_with(&tmp));
        std::fs::create_dir_all(agy.parent().unwrap()).unwrap();
        let theirs = r#"{"lint-checker":{"PostToolUse":[{"matcher":"run_command","hooks":[{"command":"./lint.sh"}]}]}}"#;
        std::fs::write(&agy, theirs).unwrap();
        assert!(!status(Agent::Antigravity).installed);
        let plan = preview(Agent::Antigravity, true).unwrap();
        assert!(plan.diff.contains("--agent antigravity"));
        write(Agent::Antigravity, true, &plan.fingerprint).expect("antigravity install should succeed");
        let written: Value = serde_json::from_slice(&std::fs::read(&agy).unwrap()).unwrap();
        assert!(written["lint-checker"].is_object(), "another hook was dropped");
        assert!(written["coucou"]["PreToolUse"].is_null(), "PreToolUse decides permissions and must not be hooked");
        assert_eq!(written["coucou"]["PostToolUse"][0]["matcher"], "*");
        assert!(written["coucou"]["Stop"][0]["command"].as_str().unwrap().ends_with("--agent antigravity Stop"));
        assert!(status(Agent::Antigravity).installed);
        let plan = preview(Agent::Antigravity, false).unwrap();
        write(Agent::Antigravity, false, &plan.fingerprint).expect("antigravity uninstall should succeed");
        let cleaned: Value = serde_json::from_slice(&std::fs::read(&agy).unwrap()).unwrap();
        assert_eq!(cleaned, serde_json::from_str::<Value>(theirs).unwrap());
        // With only our entry in it, uninstalling removes the file.
        std::fs::write(&agy, "{}").unwrap();
        let plan = preview(Agent::Antigravity, true).unwrap();
        write(Agent::Antigravity, true, &plan.fingerprint).unwrap();
        let plan = preview(Agent::Antigravity, false).unwrap();
        write(Agent::Antigravity, false, &plan.fingerprint).unwrap();
        assert!(!agy.exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
