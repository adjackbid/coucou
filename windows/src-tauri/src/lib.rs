// Coucou for Windows — app wiring and the commands the island calls.

mod acp;
mod agy;
mod claude;
mod codex;
mod files;
mod folder;
mod glass;
mod hooks;
mod integrations;
mod island;
mod llm;
mod log;
mod meter;
mod pipe;
mod policy;
mod cost;
mod pricing;
mod secrets;
mod secretary;
mod settings;
mod team;
mod tray;
mod usage;
mod win_user;

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use acp::{AcpOutcome, AgentProfile, Agents, Launch};
use team::orchestrator::{AcpDrive, Teams};
use team::state::Snapshot;
use team::TeamConfig;
use files::DroppedFile;
use llm::{Chat, ChatContext, ChatReply, Provider};
use hooks::{Agent, HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
    /// Why the global shortcut is not active, for the settings window to show.
    pub hotkey_error: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of the hook files wins over whatever we stored.
    settings.hooks_installed = hooks::status(Agent::Claude).installed;
    settings.copilot_hooks_installed = hooks::status(Agent::Copilot).installed;
    settings.antigravity_hooks_installed = hooks::status(Agent::Antigravity).installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
    }
}

/// Registers the island's global shortcut, replacing whatever was registered
/// before. The window never has focus, so this is the one key that always
/// reaches it. A key that cannot be parsed or is taken by another app is
/// logged and left unregistered rather than crashing or stealing anything.
fn apply_hotkey(app: &AppHandle, hotkey: &str) {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let hotkey = hotkey.trim();
    let result = if hotkey.is_empty() {
        Ok(())
    } else {
        hotkey
            .parse::<Shortcut>()
            .map_err(|err| format!("'{hotkey}' is not a shortcut I understand: {err}"))
            .and_then(|parsed| {
                shortcuts.register(parsed).map_err(|err| {
                    // The plugin's wording names its own types; say it plainly.
                    let taken = err.to_string().contains("already registered");
                    if taken {
                        format!("{hotkey} is already taken by another program.")
                    } else {
                        format!("{hotkey} could not be registered: {err}")
                    }
                })
            })
    };
    match &result {
        Ok(()) => log::line(format!("hotkey {}", if hotkey.is_empty() { "off" } else { hotkey })),
        Err(err) => log::line(format!("hotkey: {err}")),
    }
    if let Some(shared) = app.try_state::<Shared>() {
        *shared.hotkey_error.lock().unwrap() = result.err();
    }
}

/// Why the shortcut is not active — `None` when it is.
#[tauri::command]
fn hotkey_status(shared: State<Shared>) -> Option<String> {
    shared.hotkey_error.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed, hotkey_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        let hotkey_changed = current.hotkey != settings.hotkey;
        *current = settings.clone();
        (screen_changed, autostart_changed, hotkey_changed)
    };
    if hotkey_changed {
        apply_hotkey(&app, &settings.hotkey);
    }
    if let Err(err) = settings::save(&settings) {
        eprintln!("[coucou] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::set_ignore_cursor(&app, false);
    shared.gate.forget_ignore_state();
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    island::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    let _ = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to Explorer otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No `cmd /C` anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and cmd would happily read `&`, `^` and `%`
    // in a folder name as syntax. Finding the launcher ourselves and handing the
    // path over as a separate argument keeps it a path.
    if let Some(code) = find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
            cmd.arg(p);
        }
        if cmd.creation_flags(CREATE_NO_WINDOW).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
        let _ = Command::new("explorer").arg(p).spawn();
    }
    false
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
pub(crate) fn find_on_path(stem: &str) -> Option<std::path::PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

fn agent(name: &str) -> Result<Agent, String> {
    Agent::parse(name).ok_or_else(|| format!("unknown agent {name}"))
}

#[tauri::command]
fn hooks_status(agent_name: String) -> Result<HookStatus, String> {
    Ok(hooks::status(agent(&agent_name)?))
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(agent_name: String, install: bool) -> Result<HookPreview, String> {
    hooks::preview(agent(&agent_name)?, install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    agent_name: String,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    let which = agent(&agent_name)?;
    // The fingerprint comes from the preview the user actually looked at, so a
    // file that changed in between is refused rather than overwritten.
    let backup = hooks::write(which, install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        match which {
            Agent::Claude => current.hooks_installed = install,
            Agent::Copilot => current.copilot_hooks_installed = install,
            Agent::Antigravity => current.antigravity_hooks_installed = install,
        }
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn. The API key and any file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let provider = shared
        .settings
        .lock()
        .unwrap()
        .active()
        .cloned()
        .ok_or_else(|| "No provider configured. Open settings.".to_string())?;
    // The reply reaches the island piece by piece as it is written; the
    // command's own result is the whole of it, for the history.
    let emit = move |piece: &str| {
        let _ = app.emit_to(island::WINDOW_LABEL, "chat-delta", piece.to_string());
    };
    llm::send(&chat, &provider, query, context, Some(&emit)).await
}

/// The settings window's "Test" button. The provider comes from the form as
/// it is right now, saved or not; the key is still read from the Credential
/// Manager, never passed in.
#[tauri::command]
async fn provider_test(provider: Provider) -> Result<String, String> {
    llm::test(&provider).await
}

/// The models an endpoint offers, for the drop-down next to the model field.
#[tauri::command]
async fn provider_models(provider: Provider) -> Result<Vec<String>, String> {
    llm::models(&provider).await
}

// ── Terminals wrapped by coucou-pty ───────────────────────────────────────────

/// Only ever a pipe coucou-pty made: `\\.\pipe\coucou-pty-<pid>`. The name
/// arrives from a hook payload, so it is checked rather than trusted.
fn is_pty_pipe(name: &str) -> bool {
    name.strip_prefix(r"\\.\pipe\coucou-pty-")
        .map(|pid| !pid.is_empty() && pid.len() <= 10 && pid.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(false)
}

/// Types `text` into the terminal behind `pipe` and submits it. Only ever
/// called from an explicit send in the island's session view.
#[tauri::command]
fn pty_send(pipe: String, text: String) -> Result<(), String> {
    use std::io::Write;
    if !is_pty_pipe(&pipe) {
        return Err("That is not a Coucou terminal.".into());
    }
    // A bare "\r" is a deliberate Enter (accept the highlighted choice,
    // skip an optional field); anything else is typed, trimmed.
    let text = if text == "\r" { text.as_str() } else { text.trim() };
    if text.is_empty() {
        return Ok(());
    }
    if text.len() > 16 * 1024 {
        return Err("That is too long to type into a terminal.".into());
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(&pipe)
        .map_err(|_| "That terminal is gone, or was not started through coucou-pty.".to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    log::line(format!("pty {pipe}: sent {} characters", text.chars().count()));
    Ok(())
}

// ── ACP agents ────────────────────────────────────────────────────────────────

/// One prompt to the agent named in settings, starting it if need be. The
/// reply streams in as `acp-update` events; this returns when the turn ends.
#[tauri::command]
async fn acp_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    agents: State<'_, Arc<Agents>>,
    agent_id: String,
    text: String,
) -> Result<AcpOutcome, String> {
    let profile = shared
        .settings
        .lock()
        .unwrap()
        .agent(&agent_id)
        .cloned()
        .ok_or_else(|| "That agent is not in settings any more.".to_string())?;
    // The chat's agent: one session per profile, and a card for every request.
    agents.prompt(&acp::to_island(&app), &agent_id, &profile, &Launch::default(), text).await
}

/// The island's answer to an agent's permission request: one of the option
/// ids the agent offered, or nothing for "cancelled".
#[tauri::command]
async fn acp_permission(
    agents: State<'_, Arc<Agents>>,
    agent_id: String,
    request_id: serde_json::Value,
    option_id: Option<String>,
) -> Result<(), String> {
    agents.answer_permission(&agent_id, request_id, option_id).await
}

#[tauri::command]
async fn acp_cancel(agents: State<'_, Arc<Agents>>, agent_id: String) -> Result<(), String> {
    agents.cancel(&agent_id).await
}

/// "New" in the chat while an agent is the target: the next prompt starts a
/// fresh session.
#[tauri::command]
async fn acp_reset(agents: State<'_, Arc<Agents>>, agent_id: String) -> Result<(), String> {
    agents.reset(&agent_id).await;
    Ok(())
}

/// The settings window's "Test": start the agent as the form describes it,
/// shake hands, open a session, stop it.
#[tauri::command]
async fn acp_test(agents: State<'_, Arc<Agents>>, profile: AgentProfile) -> Result<String, String> {
    agents.test(&profile).await
}

// ── Teams ─────────────────────────────────────────────────────────────────────

/// A team file as the Teamwork window lists it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamFile {
    file: String,
    config: Option<TeamConfig>,
    /// Why it cannot start as it is; empty when it can.
    problems: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamFiles {
    dir: String,
    files: Vec<TeamFile>,
}

/// A team file is named, never addressed: `shop.json`, in the teams folder.
fn team_file_path(file: &str) -> Result<std::path::PathBuf, String> {
    let plain = file.strip_suffix(".json").map(team::is_plain_id).unwrap_or(false);
    if !plain {
        return Err("That is not a team file.".into());
    }
    Ok(settings::team_configs_dir().join(file))
}

fn read_team_file(file: &str) -> Result<TeamConfig, String> {
    let bytes = std::fs::read(team_file_path(file)?).map_err(|e| format!("Could not read {file}: {e}"))?;
    // PowerShell 5 and Notepad both write a BOM; it is not part of the JSON.
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).map_err(|e| format!("{file} is not a team file Coucou can read: {e}"))
}

/// An example to start from, written once into an empty teams folder.
const EXAMPLE_TEAM: &str = include_str!("team/example.json");

/// The team files in %APPDATA%\Coucou\teams, each with what stops it from starting.
#[tauri::command]
fn team_files(shared: State<Shared>) -> TeamFiles {
    let dir = settings::team_configs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|entries| entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(".json")).collect())
        .unwrap_or_default();
    // Only into a folder never used: after the last team is deleted, none comes back.
    if names.is_empty() && !dir.join(".deleted").exists() && std::fs::write(dir.join("example-shop.json"), EXAMPLE_TEAM).is_ok() {
        names.push("example-shop.json".into());
    }
    names.sort();
    let agents: Vec<String> = shared.settings.lock().unwrap().agents.iter().map(|a| a.id.clone()).collect();
    let files = names
        .into_iter()
        .map(|file| match read_team_file(&file) {
            Ok(config) => {
                let problems = config.problems(&agents);
                TeamFile { file, config: Some(config), problems }
            }
            Err(why) => TeamFile { file, config: None, problems: vec![why] },
        })
        .collect();
    TeamFiles { dir: dir.to_string_lossy().to_string(), files }
}

/// Every team this run knows, and the last run of each team that has a log.
#[tauri::command]
fn team_snapshots(teams: State<Arc<Teams>>) -> Vec<Snapshot> {
    if let Ok(entries) = std::fs::read_dir(settings::team_logs_dir()) {
        for entry in entries.filter_map(|e| e.ok()) {
            let id = entry.file_name().to_string_lossy().to_string();
            if team::is_plain_id(&id) {
                let _ = teams.load(&id);
            }
        }
    }
    teams.snapshots()
}

/// Starts the team a file describes. Only ever called from an explicit click.
#[tauri::command]
async fn team_start(shared: State<'_, Shared>, teams: State<'_, Arc<Teams>>, file: String) -> Result<Snapshot, String> {
    let config = read_team_file(&file)?;
    let profiles = shared.settings.lock().unwrap().agents.clone();
    if !settings::team_mcp_exe_path().is_file() {
        return Err("coucou-team-mcp.exe is missing from Coucou's bin folder, so members could not report. Reinstall or rebuild Coucou.".into());
    }
    teams.start(config, &profiles)
}

/// The person writes to the leader (`to` empty) or to one member.
#[tauri::command]
async fn team_instruct(shared: State<'_, Shared>, teams: State<'_, Arc<Teams>>, team: String, to: String, text: String, request: Option<String>) -> Result<String, String> {
    // A finished team is not closed: the person's next words start it again.
    if teams.is_finished(&team) {
        let profiles = shared.settings.lock().unwrap().agents.clone();
        return teams.reopen(&team, &to, &text, request.as_deref(), &profiles);
    }
    teams.instruct(&team, &to, &text, request.as_deref())
}

#[tauri::command]
fn team_answer(teams: State<Arc<Teams>>, team: String, question: String, text: String) -> Result<(), String> {
    teams.answer(&team, &question, &text)
}

/// The person's answer to the card a member's agent is holding: one of the
/// agent's own options, or nothing for "cancelled".
#[tauri::command]
async fn team_permit(teams: State<'_, Arc<Teams>>, team: String, member: String, option_id: Option<String>, all: Option<bool>) -> Result<(), String> {
    teams.permit(&team, &member, option_id, all.unwrap_or(false)).await
}

#[tauri::command]
fn team_pause(teams: State<Arc<Teams>>, team: String) -> Result<(), String> {
    teams.pause(&team)
}

#[tauri::command]
async fn team_resume(shared: State<'_, Shared>, teams: State<'_, Arc<Teams>>, team: String) -> Result<(), String> {
    let profiles = shared.settings.lock().unwrap().agents.clone();
    teams.resume(&team, &profiles)
}

/// Pause, and interrupt every turn under way.
#[tauri::command]
async fn team_interrupt(teams: State<'_, Arc<Teams>>, team: String) -> Result<(), String> {
    teams.interrupt(&team).await
}

/// More hands while the team runs: the members the team file has and the
/// running team does not join it now. Returns their names.
#[tauri::command]
fn team_join(shared: State<Shared>, teams: State<Arc<Teams>>, file: String) -> Result<Vec<String>, String> {
    let config = read_team_file(&file)?;
    let profiles = shared.settings.lock().unwrap().agents.clone();
    teams.join(file.trim_end_matches(".json"), &config, &profiles)
}

/// Interrupts one member's turn; the team carries on.
#[tauri::command]
async fn team_interrupt_member(teams: State<'_, Arc<Teams>>, team: String, member: String) -> Result<(), String> {
    teams.interrupt_member(&team, &member).await
}

#[tauri::command]
async fn team_recover(teams: State<'_, Arc<Teams>>, team: String, member: String) -> Result<(), String> {
    teams.recover(&team, &member).await
}

// ── Pictures with an instruction ───────────────────────────────────────────
//
// An instruction to a member can carry images: they are copied into the
// team's own folder, under .coucou/attachments, and the message names them
// by full path. Every agent can open an image file there (Claude Code's
// Read, Codex's view_image, Copilot's view), whatever its protocol.

/// Largest file an instruction takes.
const ATTACHMENT_MAX: usize = 30 * 1024 * 1024;

fn attachment_path(teams: &Teams, team: &str, name: &str) -> Result<std::path::PathBuf, String> {
    let work_dir = teams.get(team).and_then(|t| t.config()).map(|c| c.work_dir).ok_or("There is no such team.")?;
    let dir = std::path::Path::new(&work_dir).join(".coucou").join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not make {}: {e}", dir.display()))?;
    // A name that stays a name: no folders, nothing Windows refuses.
    let clean: String = std::path::Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let clean = if clean.trim().is_empty() { "image.png".to_string() } else { clean };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    Ok(dir.join(format!("{stamp}-{clean}")))
}

/// An image pasted or picked in the Teamwork window: its bytes as the request
/// body, the team and the file name (URL-encoded) in headers. Returns where
/// it now is.
#[tauri::command]
fn team_attach_bytes(teams: State<Arc<Teams>>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(percent_decode);
    let team = header("x-team").ok_or("Which team is this for?")?;
    let name = header("x-file-name").unwrap_or_else(|| "image.png".into());
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected the file's bytes".into()) };
    if bytes.len() > ATTACHMENT_MAX {
        return Err(format!("{name} is larger than {} MB.", ATTACHMENT_MAX / 1024 / 1024));
    }
    let path = attachment_path(&teams, &team, &name)?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save {name}: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// A file dragged onto the Teamwork window: copied in the same way.
#[tauri::command]
fn team_attach_path(teams: State<Arc<Teams>>, team: String, path: String) -> Result<String, String> {
    let from = std::path::Path::new(&path);
    let size = std::fs::metadata(from).map_err(|e| format!("Could not read {path}: {e}"))?.len() as usize;
    if !from.is_file() {
        return Err(format!("{path} is not a file."));
    }
    if size > ATTACHMENT_MAX {
        return Err(format!("{path} is larger than {} MB.", ATTACHMENT_MAX / 1024 / 1024));
    }
    let to = attachment_path(&teams, &team, &from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())?;
    std::fs::copy(from, &to).map_err(|e| format!("Could not copy {path}: {e}"))?;
    Ok(to.to_string_lossy().to_string())
}

/// Opens something a member handed in: a URL in the browser, a path in
/// Explorer. No shell: the locator is an argument, never a command line.
#[tauri::command]
fn team_open(teams: State<Arc<Teams>>, team: String, locator: String) -> Result<(), String> {
    if locator.starts_with("http://") || locator.starts_with("https://") {
        open_url(locator);
        return Ok(());
    }
    let work_dir = teams.get(&team).and_then(|t| t.config()).map(|c| c.work_dir).ok_or("There is no such team.")?;
    let path = std::path::Path::new(&locator);
    let full = if path.is_absolute() { path.to_path_buf() } else { std::path::Path::new(&work_dir).join(path) };
    if !full.exists() {
        return Err(format!("{} is no longer there.", full.display()));
    }
    let mut cmd = Command::new("explorer");
    if full.is_dir() {
        cmd.arg(&full);
    } else {
        cmd.arg("/select,").arg(&full);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// A team's earlier runs, newest first.
#[tauri::command]
fn team_history(teams: State<Arc<Teams>>, team: String) -> Vec<team::orchestrator::PastRun> {
    if !team::is_plain_id(&team) {
        return Vec::new();
    }
    teams.history(&team)
}

/// One earlier run, as it ended. Read only.
#[tauri::command]
fn team_past(teams: State<Arc<Teams>>, team: String, archived_at: u64) -> Result<Snapshot, String> {
    if !team::is_plain_id(&team) {
        return Err("There is no such team.".into());
    }
    teams.past(&team, archived_at).ok_or_else(|| "That run's log is no longer there.".into())
}

/// The bytes of a deliverable that is a picture in the team's work folder,
/// for the Office's wall and drawer. See team::preview_path for what is refused.
#[tauri::command]
fn team_preview(teams: State<Arc<Teams>>, team: String, locator: String) -> Result<tauri::ipc::Response, String> {
    let work_dir = teams.get(&team).and_then(|t| t.config()).map(|c| c.work_dir).ok_or("There is no such team.")?;
    let path = team::preview_path(&work_dir, &locator)?;
    std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Writes a team file from the Teamwork window's form. The file is named
/// after the team's id, and only ever inside the teams folder.
#[tauri::command]
fn team_save(file: String, mut config: TeamConfig) -> Result<(), String> {
    let path = team_file_path(&file)?;
    config.id = file.trim_end_matches(".json").to_string();
    let json = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(settings::team_configs_dir()).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Could not save {file}: {e}"))
}

/// A new team file with one member, the leader, to fill in. Returns its name.
#[tauri::command]
fn team_new(shared: State<Shared>) -> Result<String, String> {
    let dir = settings::team_configs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = (1..1000)
        .map(|n| if n == 1 { "team".to_string() } else { format!("team-{n}") })
        .find(|id| !dir.join(format!("{id}.json")).exists())
        .ok_or("There are too many team files.")?;
    let agent = shared.settings.lock().unwrap().agents.first().map(|a| a.id.clone()).unwrap_or_default();
    let config = serde_json::json!({
        "id": id, "name": "", "goal": "", "workDir": "", "leader": "ai1", "autoApprove": true,
        "members": [{ "id": "ai1", "name": "AI 1", "role": "", "duty": "", "agent": agent, "color": "" }],
    });
    let file = format!("{id}.json");
    std::fs::write(dir.join(&file), serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Could not create {file}: {e}"))?;
    Ok(file)
}

/// A copy of a team file, to start a similar team from: same goal and
/// members, its own id and name. Returns the new file's name.
#[tauri::command]
fn team_duplicate(file: String) -> Result<String, String> {
    let mut config = read_team_file(&file)?;
    let dir = settings::team_configs_dir();
    let base = file.trim_end_matches(".json");
    let id = (1..1000)
        .map(|n| if n == 1 { format!("{base}-copy") } else { format!("{base}-copy-{n}") })
        .find(|id| !dir.join(format!("{id}.json")).exists())
        .ok_or("There are too many copies of this team.")?;
    config.id = id.clone();
    config.name = if config.name.trim().is_empty() { String::new() } else { format!("{} (複本)", config.name.trim()) };
    let copy = format!("{id}.json");
    std::fs::write(dir.join(&copy), serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Could not create {copy}: {e}"))?;
    Ok(copy)
}

/// Takes a team off the list — only ever from an explicit click. Nothing is
/// destroyed: the file moves to the teams folder's `.deleted`, and the run's
/// log stays where it is. A team with agents at work is refused.
#[tauri::command]
fn team_delete(teams: State<Arc<Teams>>, file: String) -> Result<(), String> {
    let path = team_file_path(&file)?;
    let id = file.trim_end_matches(".json");
    if teams.is_live(id) {
        return Err("This team is running. Stop it before deleting it.".into());
    }
    let bin = settings::team_configs_dir().join(".deleted");
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    std::fs::rename(&path, bin.join(format!("{id}-{stamp}.json"))).map_err(|e| format!("Could not delete {file}: {e}"))?;
    teams.forget(id);
    log::line(format!("team {id}: file moved to .deleted"));
    Ok(())
}

/// Puts a team away (or takes it out again): its file is kept, marked
/// `archived`, and the Teamwork window leaves it out of the list and the
/// company map. A running team is not put away.
#[tauri::command]
fn team_archive(teams: State<Arc<Teams>>, file: String, archived: bool) -> Result<(), String> {
    let path = team_file_path(&file)?;
    let mut config = read_team_file(&file)?;
    if archived && teams.is_live(&config.id) {
        return Err("This team is running. Stop it before putting it away.".into());
    }
    config.archived = archived;
    let json = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Could not save {file}: {e}"))?;
    log::line(format!("team {}: {}", config.id, if archived { "archived" } else { "taken out of the archive" }));
    Ok(())
}

/// The system's folder dialog, over the Teamwork window. `None` when cancelled.
#[tauri::command]
async fn pick_folder(app: AppHandle, start: String, title: String) -> Result<Option<String>, String> {
    let owner = app.get_webview_window("team").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    let picked = tauri::async_runtime::spawn_blocking(move || folder::pick(owner, &start, &title))
        .await
        .map_err(|e| e.to_string())?;
    match &picked {
        Ok(Some(_)) => log::line("folder dialog: a folder was chosen"),
        Ok(None) => log::line("folder dialog: cancelled"),
        Err(err) => log::line(format!("folder dialog: {err}")),
    }
    picked
}

/// The Teamwork window has no title bar of its own: its page draws the
/// buttons, and these are what they do.
#[tauri::command]
fn team_window(app: AppHandle, action: String) {
    let Some(win) = app.get_webview_window("team") else { return };
    let _ = match action.as_str() {
        "minimize" => win.minimize(),
        "maximize" => {
            if win.is_maximized().unwrap_or(false) {
                win.unmaximize()
            } else {
                win.maximize()
            }
        }
        "drag" => win.start_dragging(),
        _ => win.hide(),
    };
}

/// Opens the folder the team files live in.
#[tauri::command]
fn team_open_configs() {
    let dir = settings::team_configs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = Command::new("explorer").arg(dir).spawn();
}

/// Usage and its estimated cost between two moments (ms), across every team log.
#[tauri::command]
async fn usage_report(from: u64, to: u64) -> Result<cost::Report, String> {
    // Every team log is read: off the window's thread.
    tauri::async_runtime::spawn_blocking(move || cost::report(&settings::team_logs_dir(), from, to)).await.map_err(|e| e.to_string())
}

/// The price each model would be charged at now (for the cost shown beside
/// members at work), with the person's currency.
#[tauri::command]
fn pricing_quote(models: Vec<String>) -> (std::collections::BTreeMap<String, Option<pricing::Found>>, pricing::Choices) {
    let choices = pricing::load_choices();
    let table = pricing::load_table();
    let found = models.into_iter().map(|m| {
        let f = pricing::lookup(&m, &choices, &table);
        (m, f)
    }).collect();
    (found, choices)
}

/// The person's prices, billing modes and currency.
#[tauri::command]
fn pricing_save(choices: pricing::Choices) -> Result<(), String> {
    pricing::save_choices(&choices)
}

/// Fetches LiteLLM's public price list (only on the person's click). Returns how many models it prices.
#[tauri::command]
async fn pricing_fetch_list() -> Result<usize, String> {
    let table = cost::fetch_list().await?;
    pricing::save_table(&table)?;
    log::line(format!("prices: {} models from the public list", table.models.len()));
    Ok(table.models.len())
}

/// Reads the prices an agent's own endpoint (a LiteLLM proxy) gives, with
/// the agent's own key. Returns how many models it priced.
#[tauri::command]
async fn pricing_from_agent(shared: State<'_, Shared>, agent: String) -> Result<usize, String> {
    let profile = shared.settings.lock().unwrap().agents.iter().find(|a| a.id == agent).cloned().ok_or("There is no such agent.")?;
    let base = profile.env.get("COPILOT_PROVIDER_BASE_URL").map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && !s.contains('…'));
    let base = base.ok_or("This agent has no endpoint of its own to ask for prices.")?;
    let secret = secrets::get(&profile.secret_key()).unwrap_or_default();
    let key = profile.env.get("COPILOT_PROVIDER_API_KEY").map(|v| v.replace("{secret}", &secret)).filter(|k| !k.trim().is_empty());
    let label = base.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or(&base).to_string();
    let found = cost::proxy_prices(&base, key, &label).await?;
    let mut choices = pricing::load_choices();
    let n = found.len();
    choices.proxy.extend(found);
    pricing::save_choices(&choices)?;
    log::line(format!("prices: {n} models from {label}"));
    Ok(n)
}

/// What an agent's own endpoint (a LiteLLM proxy) has billed the agent's key.
#[tauri::command]
async fn endpoint_spend(shared: State<'_, Shared>, agent: String) -> Result<cost::KeySpend, String> {
    let profile = shared.settings.lock().unwrap().agents.iter().find(|a| a.id == agent).cloned().ok_or("There is no such agent.")?;
    let base = profile.env.get("COPILOT_PROVIDER_BASE_URL").map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && !s.contains('…'));
    let base = base.ok_or("This agent has no endpoint of its own.")?;
    let secret = secrets::get(&profile.secret_key()).unwrap_or_default();
    let key = profile.env.get("COPILOT_PROVIDER_API_KEY").map(|v| v.replace("{secret}", &secret)).filter(|k| !k.trim().is_empty());
    cost::key_spend(&base, key).await
}

/// The chat providers the secretary can think with: (id, name, model), the
/// one in use for the island's chat first.
#[tauri::command]
fn secretary_providers(shared: State<Shared>) -> Vec<(String, String, String)> {
    let settings = shared.settings.lock().unwrap();
    let mut out: Vec<(String, String, String)> = settings.providers.iter().map(|p| (p.id.clone(), p.name.clone(), p.model.clone())).collect();
    if let Some(i) = out.iter().position(|p| p.0 == settings.active_provider) {
        let first = out.remove(i);
        out.insert(0, first);
    }
    out
}

/// The person asks the secretary something. Steps are told to the Teamwork
/// window as they happen (`secretary-step`).
#[tauri::command]
async fn secretary_ask(
    app: AppHandle,
    shared: State<'_, Shared>,
    teams: State<'_, Arc<Teams>>,
    agents: State<'_, Arc<Agents>>,
    secretary: State<'_, Arc<secretary::Secretary>>,
    text: String,
    provider: Option<String>,
    tz_minutes: i64,
) -> Result<secretary::Reply, String> {
    let (provider, profiles) = {
        let settings = shared.settings.lock().unwrap();
        let wanted = provider.unwrap_or_default();
        let found = settings
            .providers
            .iter()
            .find(|p| p.id == wanted)
            .or_else(|| settings.providers.iter().find(|p| p.id == settings.active_provider))
            .or_else(|| settings.providers.first())
            .cloned();
        (found, settings.agents.clone())
    };
    let provider = provider.ok_or("The secretary needs a chat model: add one in Settings → Chat providers.")?;
    let office = secretary::Office { teams: teams.inner().clone(), agents: profiles, driver: agents.inner().clone(), tz_minutes };
    let window = app.clone();
    secretary
        .ask(&provider, &office, &text, &move |step| {
            let _ = window.emit_to("team", "secretary-step", step.clone());
        })
        .await
}

/// The person clicked 確認 on one of the secretary's proposals — the only way any of them happens.
#[tauri::command]
async fn secretary_confirm(
    shared: State<'_, Shared>,
    teams: State<'_, Arc<Teams>>,
    agents: State<'_, Arc<Agents>>,
    secretary: State<'_, Arc<secretary::Secretary>>,
    id: String,
    tz_minutes: i64,
) -> Result<secretary::Proposal, String> {
    let profiles = shared.settings.lock().unwrap().agents.clone();
    let office = secretary::Office { teams: teams.inner().clone(), agents: profiles, driver: agents.inner().clone(), tz_minutes };
    secretary.confirm(&id, &office).await
}

#[tauri::command]
fn secretary_decline(secretary: State<Arc<secretary::Secretary>>, id: String) -> Option<secretary::Proposal> {
    secretary.decline(&id)
}

/// A new conversation.
#[tauri::command]
fn secretary_reset(secretary: State<Arc<secretary::Secretary>>) {
    secretary.reset();
}

/// The models an agent offers, for the drop-downs in Settings and Teamwork.
#[tauri::command]
async fn agent_models(agents: State<'_, Arc<Agents>>, profile: AgentProfile) -> Result<Vec<claude::ModelChoice>, String> {
    agents.models(&profile).await
}

#[tauri::command]
fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// Writes a file the page received through an HTML5 drop into the inbox. The
/// bytes travel as the raw request body; the name rides in a header, URL-
/// encoded by the page so any Unicode file name survives the trip.
#[tauri::command]
fn ingest_bytes(request: tauri::ipc::Request<'_>) -> Result<DroppedFile, String> {
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| "file".into());
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => files::ingest_bytes(&name, bytes),
        _ => Err("expected the file's bytes".into()),
    }
}

/// `%XX` → byte, for the file name header. Anything malformed is kept as is.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::{is_pty_pipe, percent_decode};

    #[test]
    fn only_a_coucou_pty_pipe_is_ever_written_to() {
        assert!(is_pty_pipe(r"\\.\pipe\coucou-pty-12345"));
        assert!(!is_pty_pipe(r"\\.\pipe\coucou-pty-"));
        assert!(!is_pty_pipe(r"\\.\pipe\coucou-pty-12a"));
        assert!(!is_pty_pipe(r"\\.\pipe\something-else"));
        assert!(!is_pty_pipe(r"C:\Users\x\notes.txt"));
        assert!(!is_pty_pipe(r"\\server\pipe\coucou-pty-1"));
    }

    #[test]
    fn file_names_survive_the_header() {
        assert_eq!(percent_decode("note.txt"), "note.txt");
        assert_eq!(percent_decode("%E5%9C%96%E7%89%87.png"), "圖片.png");
        assert_eq!(percent_decode("a%20b%"), "a b%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings — Coucou")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

/// #0B0C0E at 45 %, as 0xAABBGGRR: dark enough that light text reads over
/// a white window behind, thin enough that the desktop still shows.
const GLASS_TINT: u32 = 0x730E_0C0B;

/// The Teamwork window: like the settings window, made hidden before the
/// island's webview exists and only shown and hidden afterwards.
fn create_team_window(app: &AppHandle) {
    #[cfg(dev)]
    let url = match app.config().build.dev_url.clone() {
        Some(mut base) => {
            base.set_path("/team.html");
            WebviewUrl::External(base)
        }
        None => WebviewUrl::App("team.html".into()),
    };
    #[cfg(not(dev))]
    let url = WebviewUrl::App("team.html".into());
    // Four members side by side, a board and a timeline: this screen wants
    // room, and Windows' text-size setting takes its share of every pixel
    // (at 150 % a 1180 pt window lays out like a 790 pt one). So it opens as
    // large as the display comfortably allows, up to a size where the whole
    // screen fits even then.
    let (width, height) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let scale = m.scale_factor().max(1.0);
            let (w, h) = (m.size().width as f64 / scale, m.size().height as f64 / scale);
            ((w * 0.9).min(1680.0), (h * 0.86).min(1040.0))
        })
        .unwrap_or((1280.0, 820.0));
    match WebviewWindowBuilder::new(app, "team", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Teamwork — Coucou")
        .inner_size(width, height)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        // A sheet of glass, not a framed window: no title bar (the page has
        // its own), and nothing painted behind the page.
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Coucou's black, thin enough for the desktop to show through.
            glass::apply(&win, GLASS_TINT);
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("team window failed: {err}")),
    }
}

pub fn show_team_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("team") else {
        log::line("team window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_team_window(app: AppHandle) {
    show_team_window(&app);
}

pub fn run() {
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());
    let agents = Arc::new(Agents::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Only the one key is ever registered, so no need to match it.
                    if event.state() == ShortcutState::Pressed {
                        let _ = app.emit_to(island::WINDOW_LABEL, "hotkey", ());
                    }
                })
                .build(),
        )
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
            hotkey_error: Mutex::new(None),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(agents.clone())
        .manage(Arc::new(secretary::Secretary::default()))
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_reset,
            ingest_file,
            ingest_bytes,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
            hotkey_status,
            provider_test,
            provider_models,
            pty_send,
            acp_send,
            acp_permission,
            acp_cancel,
            acp_reset,
            acp_test,
            agent_models,
            team_files,
            team_snapshots,
            team_start,
            team_instruct,
            team_attach_bytes,
            team_duplicate,
            team_delete,
            team_attach_path,
            team_answer,
            team_permit,
            team_pause,
            team_resume,
            team_interrupt,
            team_recover,
            team_interrupt_member,
            team_join,
            team_open,
            team_archive,
            team_preview,
            team_history,
            usage_report,
            pricing_quote,
            pricing_save,
            pricing_fetch_list,
            pricing_from_agent,
            endpoint_spend,
            secretary_providers,
            secretary_ask,
            secretary_confirm,
            secretary_decline,
            secretary_reset,
            team_past,
            team_open_configs,
            team_save,
            team_new,
            pick_folder,
            team_window,
            open_team_window,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            create_team_window(&handle);

            // Teams: their members run through the same agents as the chat's,
            // and every change is told to both windows.
            let emit: team::orchestrator::Emit = {
                let app = handle.clone();
                Arc::new(move |snapshot| {
                    let _ = app.emit("team-changed", snapshot.clone());
                })
            };
            // Each member's live screen goes to the Teamwork window alone.
            let show: team::orchestrator::Show = {
                let app = handle.clone();
                Arc::new(move |patch| {
                    let _ = app.emit_to("team", "team-screen", patch.clone());
                })
            };
            let teams = Arc::new(
                Teams::new(Arc::new(AcpDrive(agents.clone())), emit, Some(settings::team_logs_dir()), settings::team_mcp_exe_path())
                    .with_screens(show),
            );
            app.manage(teams.clone());
            // Copilot members on their own endpoint are metered (meter.rs).
            match tauri::async_runtime::block_on(meter::Meter::start()) {
                Ok(m) => {
                    let teams = teams.clone();
                    m.set_report(Arc::new(move |key, usage| teams.metered(key, usage)));
                    meter::install(m);
                }
                Err(e) => log::line(format!("meter: could not listen: {e}")),
            }
            team::mcp::start(teams);

            if let Some(win) = island::window(&handle) {
                island::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            apply_hotkey(&handle, &loaded.hotkey);
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Coucou")
        .run(|app, event| {
            // Agents the island started must not outlive it.
            if let tauri::RunEvent::Exit = event {
                if let Some(teams) = app.try_state::<Arc<Teams>>() {
                    tauri::async_runtime::block_on(teams.shutdown());
                }
                let agents = app.state::<Arc<Agents>>();
                tauri::async_runtime::block_on(agents.shutdown());
            }
        });
}
