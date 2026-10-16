// Coucou for Windows — app wiring and the commands the island calls.

#[macro_use]
mod i18n;
mod acp;
mod cli_install;
mod agy;
mod claude;
mod codex;
mod files;
mod folder;
mod glass;
mod history;
mod hooks;
mod integrations;
mod island;
mod llm;
mod log;
mod meter;
mod pipe;
mod policy;
mod caps;
mod constitution;
mod explain;
mod cost;
mod pricing;
mod secrets;
mod secretary;
mod settings;
mod team;
mod team_agents;
mod n8n;
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
use team::knowledge::{self, Added, DocView, Kb, KnowledgeView, Visibility};
use team::orchestrator::{AcpDrive, KnowledgeChange, Teams};
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
    /// "zh-TW" or "en": the language every window draws in.
    lang: &'static str,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of the hook files wins over whatever we stored.
    settings.hooks_installed = hooks::status(Agent::Claude).installed;
    settings.copilot_hooks_installed = hooks::status(Agent::Copilot).installed;
    settings.antigravity_hooks_installed = hooks::status(Agent::Antigravity).installed;
    let screen = island::screen_info(&app, &settings);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        lang: i18n::current(),
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
    let result: Result<(), String> = if hotkey.is_empty() {
        Ok(())
    } else {
        hotkey
            .parse::<Shortcut>()
            .map_err(|err| -> String {
                tr!(format!("看不懂「{hotkey}」這個快速鍵：{err}"), format!("'{hotkey}' is not a shortcut I understand: {err}"))
            })
            .and_then(|parsed| {
                shortcuts.register(parsed).map_err(|err| -> String {
                    // The plugin's wording names its own types; say it plainly.
                    // (The plugin's own English text, not ours: kept as it is.)
                    let taken = err.to_string().contains("already registered");
                    if taken {
                        tr!(format!("{hotkey} 已經被別的程式占用了。"), format!("{hotkey} is already taken by another program."))
                    } else {
                        tr!(format!("無法註冊 {hotkey}：{err}"), format!("{hotkey} could not be registered: {err}"))
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

/// The longest quitting waits for the agents to stop: their 4 s to close
/// properly, side by side, and the kill after it.
const QUIT_WAIT: std::time::Duration = std::time::Duration::from_secs(7);

/// The app used to be called Coucou, and its sign-in entry (HKCU\…\Run) is
/// named after the app: the old "Coucou" one would start whatever is still at
/// its path. It is removed, and Agent Center's own is written when start at
/// sign-in is on.
fn renamed_autostart(app: &AppHandle, on: bool) {
    #[cfg(windows)]
    unsafe {
        use windows::core::w;
        use windows::Win32::System::Registry::{RegDeleteKeyValueW, HKEY_CURRENT_USER};
        // Not there is the usual answer, and fine.
        let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"), w!("Coucou"));
    }
    if on {
        if let Err(err) = app.autolaunch().enable() {
            log::line(format!("autostart under the new name: {err}"));
        }
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (settings, screen_changed, autostart_changed, hotkey_changed, theme_changed) = {
        let mut current = shared.settings.lock().unwrap();
        // The page's copy of the dock is stale next to a drag: Rust's is kept.
        let settings = current.from_page(settings);
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        let hotkey_changed = current.hotkey != settings.hotkey;
        let theme_changed = current.light() != settings.light();
        *current = settings.clone();
        (settings, screen_changed, autostart_changed, hotkey_changed, theme_changed)
    };
    let lang_changed = i18n::set(&settings.language);
    // A new language also rewrites why the shortcut is not active.
    if hotkey_changed || lang_changed {
        apply_hotkey(&app, &settings.hotkey);
    }
    if let Err(err) = settings::save(&settings) {
        eprintln!("[coucou] could not save settings: {err}");
    }
    if lang_changed {
        // Every window redraws in the new language; the tray menu is relabelled.
        let _ = app.emit("lang-changed", i18n::current());
        tray::relabel(&app);
        window_titles(&app);
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
        island::apply_geometry(&app, &settings, collapsed);
    }
    if theme_changed {
        apply_theme(&app, settings.light());
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Light or dark, for what Windows draws: the settings window's title bar,
/// and the tint of Teamwork's glass. The pages switch their own colours.
fn apply_theme(app: &AppHandle, light: bool) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.set_theme(Some(if light { tauri::Theme::Light } else { tauri::Theme::Dark }));
    }
    if let Some(win) = app.get_webview_window("team") {
        glass::apply(&win, if light { GLASS_TINT_LIGHT } else { GLASS_TINT });
    }
}

/// Whether the person picked the light look (read before the windows exist, too).
fn light_theme(app: &AppHandle) -> bool {
    app.try_state::<Shared>().map(|s| s.settings.lock().unwrap().light()).unwrap_or_else(|| settings::load().light())
}

/// Puts the island on another edge. A drag writes the dock itself (island.rs);
/// this is for everything else that moves it.
#[tauri::command]
fn set_dock(app: AppHandle, dock: settings::Dock) {
    store_dock(&app, dock.normalized(), None);
}

/// Back to the top centre of the screen the "Island lives on" setting picks.
#[tauri::command]
fn reset_dock(app: AppHandle) {
    reset_island_position(&app);
}

pub fn reset_island_position(app: &AppHandle) {
    let screen = app
        .try_state::<Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_default();
    // The display the island was dropped on goes with the position.
    let screen = if screen == "docked" { Some("primary".to_string()) } else { None };
    store_dock(app, settings::Dock::default(), screen);
}

/// Writes the dock (and, when it changed, the screen), saves, tells both
/// windows and puts the window where the dock says.
pub fn store_dock(app: &AppHandle, dock: settings::Dock, screen: Option<String>) {
    let Some(shared) = app.try_state::<Shared>() else { return };
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.dock = dock;
        if let Some(screen) = screen {
            current.screen = screen;
        }
        if let Err(err) = settings::save(&current) {
            eprintln!("[coucou] could not save settings: {err}");
        }
        current.clone()
    };
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(app, &updated, collapsed);
    let _ = app.emit("settings-changed", updated);
}

/// The front end saw the capsule pulled past the click threshold: Rust's
/// cursor poll takes the drag from here. False when the button is already up.
#[tauri::command]
fn begin_island_drag(app: AppHandle, shared: State<Shared>, grab_x: f64, grab_y: f64) -> bool {
    island::begin_drag(&app, &shared.gate, (grab_x, grab_y))
}

/// The front end drew the dropped capsule at its new coordinates: move the window.
#[tauri::command]
fn commit_dock_geometry(app: AppHandle, shared: State<Shared>) {
    island::commit_drop(&app, &shared.gate);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let settings = shared.settings.lock().unwrap().clone();
    if collapsed {
        shared.gate.abandon_drag();
    }
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &settings, collapsed);
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
    // Mid-drag the poll owns the window.
    if shared.gate.dragging() {
        return;
    }
    let settings = shared.settings.lock().unwrap().clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &settings, collapsed);
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
    Agent::parse(name).ok_or_else(|| tr!(format!("不認得的 agent：{name}"), format!("unknown agent {name}")))
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
        .ok_or_else(|| -> String { tr!("還沒設定聊天模型。請打開設定。", "No chat model is set up. Open Settings.") })?;
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
        return Err(tr!("這不是 Agent Center 的終端機。", "That is not a Agent Center terminal."));
    }
    // A bare "\r" is a deliberate Enter (accept the highlighted choice,
    // skip an optional field); anything else is typed, trimmed.
    let text = if text == "\r" { text.as_str() } else { text.trim() };
    if text.is_empty() {
        return Ok(());
    }
    if text.len() > 16 * 1024 {
        return Err(tr!("太長了，沒辦法打進終端機。", "That is too long to type into a terminal."));
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(&pipe)
        .map_err(|_| -> String { tr!("這個終端機已經關了，或不是透過 coucou-pty 啟動的。", "That terminal is gone, or was not started through coucou-pty.") })?;
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
        .ok_or_else(|| -> String { tr!("設定裡已經沒有這個 agent 了。", "That agent is not in settings any more.") })?;
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

fn no_such_team() -> String {
    tr!("沒有這個團隊。", "There is no such team.")
}

fn expected_bytes() -> String {
    tr!("沒有收到檔案的內容。", "expected the file's bytes")
}

/// A team file is named, never addressed: `shop.json`, in the teams folder.
fn team_file_path(file: &str) -> Result<std::path::PathBuf, String> {
    let plain = file.strip_suffix(".json").map(team::is_plain_id).unwrap_or(false);
    if !plain {
        return Err(tr!("這不是團隊檔。", "That is not a team file."));
    }
    Ok(settings::team_configs_dir().join(file))
}

fn read_team_file(file: &str) -> Result<TeamConfig, String> {
    let bytes = std::fs::read(team_file_path(file)?).map_err(|e| -> String { tr!(format!("讀不到 {file}：{e}"), format!("Could not read {file}: {e}")) })?;
    // PowerShell 5 and Notepad both write a BOM; it is not part of the JSON.
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).map_err(|e| tr!(format!("{file} 不是 Agent Center 讀得懂的團隊檔：{e}"), format!("{file} is not a team file Agent Center can read: {e}")))
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
    let agents: Vec<String> = runnable(&shared).iter().map(|a| a.id.clone()).collect();
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
    let profiles = runnable(&shared);
    if !settings::team_mcp_exe_path().is_file() {
        return Err(tr!(
            "Agent Center 的 bin 資料夾裡少了 coucou-team-mcp.exe，成員沒辦法回報。請重新安裝或重新建置 Agent Center。",
            "coucou-team-mcp.exe is missing from Agent Center's bin folder, so members could not report. Reinstall or rebuild Agent Center."
        ));
    }
    teams.start(config, &profiles)
}

/// The person writes to the leader (`to` empty) or to one member.
#[tauri::command]
async fn team_instruct(shared: State<'_, Shared>, teams: State<'_, Arc<Teams>>, team: String, to: String, text: String, request: Option<String>) -> Result<String, String> {
    // A finished team is not closed: the person's next words start it again.
    if teams.is_finished(&team) {
        let profiles = runnable(&shared);
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
    let profiles = runnable(&shared);
    teams.resume(&team, &profiles)
}

/// The person ends the team now, done or not: every member's agent stops.
#[tauri::command]
async fn team_end(teams: State<'_, Arc<Teams>>, team: String) -> Result<(), String> {
    teams.end(&team).await
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
    let profiles = runnable(&shared);
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
    let work_dir = teams.get(team).and_then(|t| t.config()).map(|c| c.work_dir).ok_or_else(no_such_team)?;
    let dir = std::path::Path::new(&work_dir).join(".coucou").join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| -> String { tr!(format!("無法建立 {}：{e}", dir.display()), format!("Could not make {}: {e}", dir.display())) })?;
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

fn too_large(name: &str) -> String {
    let mb = ATTACHMENT_MAX / 1024 / 1024;
    tr!(format!("{name} 超過 {mb} MB。"), format!("{name} is larger than {mb} MB."))
}

/// An image pasted or picked in the Teamwork window: its bytes as the request
/// body, the team and the file name (URL-encoded) in headers. Returns where
/// it now is.
#[tauri::command]
fn team_attach_bytes(teams: State<Arc<Teams>>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(percent_decode);
    let team = header("x-team").ok_or_else(|| -> String { tr!("不知道這是給哪個團隊的。", "Which team is this for?") })?;
    let name = header("x-file-name").unwrap_or_else(|| "image.png".into());
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err(expected_bytes()) };
    if bytes.len() > ATTACHMENT_MAX {
        return Err(too_large(&name));
    }
    let path = attachment_path(&teams, &team, &name)?;
    std::fs::write(&path, bytes).map_err(|e| -> String { tr!(format!("無法儲存 {name}：{e}"), format!("Could not save {name}: {e}")) })?;
    Ok(path.to_string_lossy().to_string())
}

/// A file dragged onto the Teamwork window: copied in the same way.
#[tauri::command]
fn team_attach_path(teams: State<Arc<Teams>>, team: String, path: String) -> Result<String, String> {
    let from = std::path::Path::new(&path);
    let size = std::fs::metadata(from).map_err(|e| -> String { tr!(format!("讀不到 {path}：{e}"), format!("Could not read {path}: {e}")) })?.len() as usize;
    if !from.is_file() {
        return Err(tr!(format!("{path} 不是檔案。"), format!("{path} is not a file.")));
    }
    if size > ATTACHMENT_MAX {
        return Err(too_large(&path));
    }
    let to = attachment_path(&teams, &team, &from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())?;
    std::fs::copy(from, &to).map_err(|e| -> String { tr!(format!("無法複製 {path}：{e}"), format!("Could not copy {path}: {e}")) })?;
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
    let work_dir = teams.get(&team).and_then(|t| t.config()).map(|c| c.work_dir).ok_or_else(no_such_team)?;
    let path = std::path::Path::new(&locator);
    let full = if path.is_absolute() { path.to_path_buf() } else { std::path::Path::new(&work_dir).join(path) };
    if !full.exists() {
        return Err(tr!(format!("{} 已經不在了。", full.display()), format!("{} is no longer there.", full.display())));
    }
    let mut cmd = Command::new("explorer");
    if full.is_dir() {
        cmd.arg(&full);
    } else {
        cmd.arg("/select,").arg(&full);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// A picture a member made, in the system's own viewer. Only pictures:
/// a locator comes from an agent, and opening it starts whatever is
/// registered for its kind of file.
#[tauri::command]
fn team_open_image(teams: State<Arc<Teams>>, team: String, locator: String) -> Result<(), String> {
    let lower = locator.trim().to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp"].iter().any(|ext| lower.ends_with(&format!(".{ext}"))) {
        return Err(tr!("這不是圖片。", "Not a picture."));
    }
    let work_dir = teams.get(&team).and_then(|t| t.config()).map(|c| c.work_dir).ok_or_else(no_such_team)?;
    let path = std::path::Path::new(locator.trim());
    let full = if path.is_absolute() { path.to_path_buf() } else { std::path::Path::new(&work_dir).join(path) };
    if !full.is_file() {
        return Err(tr!(format!("{} 已經不在了。", full.display()), format!("{} is no longer there.", full.display())));
    }
    // Explorer hands a file to the program registered for it, as a double-click does.
    Command::new("explorer").arg(&full).spawn().map(|_| ()).map_err(|e| e.to_string())
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
        return Err(no_such_team());
    }
    teams.past(&team, archived_at).ok_or_else(|| tr!("那一次執行的紀錄已經不在了。", "That run's log is no longer there."))
}

/// The bytes of a deliverable that is a picture in the team's work folder,
/// for the Office's wall and drawer. See team::preview_path for what is refused.
#[tauri::command]
fn team_preview(teams: State<Arc<Teams>>, team: String, locator: String) -> Result<tauri::ipc::Response, String> {
    let work_dir = teams.get(&team).and_then(|t| t.config()).map(|c| c.work_dir).ok_or_else(no_such_team)?;
    let path = team::preview_path(&work_dir, &locator)?;
    std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Writes a team file from the Teamwork window's form. The file is named
/// after the team's id, and only ever inside the teams folder.
#[tauri::command]
fn team_save(teams: State<Arc<Teams>>, file: String, mut config: TeamConfig) -> Result<(), String> {
    let path = team_file_path(&file)?;
    config.id = file.trim_end_matches(".json").to_string();
    let json = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(settings::team_configs_dir()).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| -> String { tr!(format!("無法儲存 {file}：{e}"), format!("Could not save {file}: {e}")) })?;
    // Members' limits hold at once, even while the team runs.
    teams.update_limits(&config);
    Ok(())
}

/// A new team file with one member, the leader, to fill in. Returns its name.
#[tauri::command]
fn team_new(shared: State<Shared>) -> Result<String, String> {
    let dir = settings::team_configs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = (1..1000)
        .map(|n| if n == 1 { "team".to_string() } else { format!("team-{n}") })
        .find(|id| !dir.join(format!("{id}.json")).exists())
        .ok_or_else(|| -> String { tr!("團隊檔太多了。", "There are too many team files.") })?;
    let natives = shared.settings.lock().unwrap().agents.clone();
    // The leader: the first team agent that can lead (an n8n node cannot).
    let agent = team_agents::current().choices(&natives).iter().find(|a| a.protocol != acp::Protocol::N8n).map(|a| a.id.clone()).unwrap_or_default();
    let config = serde_json::json!({
        "id": id, "name": "", "goal": "", "workDir": "", "leader": "ai1", "autoApprove": true,
        "members": [{ "id": "ai1", "name": "AI 1", "role": "", "duty": "", "agent": agent, "color": "" }],
    });
    let file = format!("{id}.json");
    std::fs::write(dir.join(&file), serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| -> String { tr!(format!("無法建立 {file}：{e}"), format!("Could not create {file}: {e}")) })?;
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
        .ok_or_else(|| -> String { tr!("這個團隊的複本太多了。", "There are too many copies of this team.") })?;
    let from = config.id.clone();
    config.id = id.clone();
    let name = config.name.trim().to_string();
    config.name = if name.is_empty() { String::new() } else { tr!(format!("{name}(複本)"), format!("{name} (copy)")) };
    let copy = format!("{id}.json");
    std::fs::write(dir.join(&copy), serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| -> String { tr!(format!("無法建立 {copy}：{e}"), format!("Could not create {copy}: {e}")) })?;
    // The same documents, under a leader's folder of the copy's own.
    if team::is_plain_id(&from) {
        if let Err(err) = Kb::of(&from).copy_to(&Kb::of(&id)) {
            log::line(format!("team {id}: knowledge not copied from {from}: {err}"));
        }
    }
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
        return Err(tr!("這個團隊正在執行。請先停止再刪除。", "This team is running. Stop it before deleting it."));
    }
    // The knowledge base goes by the id the file says (the example's is not its name).
    let said = read_team_file(&file).map(|c| c.id).ok().filter(|i| team::is_plain_id(i)).unwrap_or_else(|| id.to_string());
    let bin = settings::team_configs_dir().join(".deleted");
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    std::fs::rename(&path, bin.join(format!("{id}-{stamp}.json"))).map_err(|e| -> String { tr!(format!("無法刪除 {file}：{e}"), format!("Could not delete {file}: {e}")) })?;
    // Its documents go aside with it, under the same time.
    let docs = knowledge::team_dir(&said);
    if docs.is_dir() {
        let aside = knowledge::root().join(".deleted");
        let moved = std::fs::create_dir_all(&aside).and_then(|_| std::fs::rename(&docs, aside.join(format!("{said}-{stamp}"))));
        if let Err(err) = moved {
            log::line(format!("team {id}: knowledge folder not moved aside: {err}"));
        }
    }
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
        return Err(tr!("這個團隊正在執行。請先停止再收起來。", "This team is running. Stop it before putting it away."));
    }
    config.archived = archived;
    let json = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| -> String { tr!(format!("無法儲存 {file}：{e}"), format!("Could not save {file}: {e}")) })?;
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

// ── A team's knowledge base (team::knowledge) ─────────────────────────────────
//
// Every change is written at once: the form's Save is not needed, and a new
// team (whose file `team_new` already made) can take documents before it is
// saved for the first time.

/// The team a knowledge call is about: a plain id with a team file — named
/// after it, or (a file not saved from the form yet, such as the example) saying it.
fn knowledge_of(team: &str) -> Result<Kb, String> {
    if !team::is_plain_id(team) {
        return Err(no_such_team());
    }
    let named = team_file_path(&format!("{team}.json"))?.is_file();
    let says = || {
        std::fs::read_dir(settings::team_configs_dir())
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".json"))
            .any(|n| read_team_file(&n).is_ok_and(|c| c.id == team))
    };
    if !named && !says() {
        return Err(no_such_team());
    }
    Ok(Kb::of(team))
}

/// Tells the window, and a running team's members (team::orchestrator), what changed.
fn knowledge_changed(app: &AppHandle, teams: &Teams, team: &str, change: KnowledgeChange) {
    let _ = app.emit_to("team", "team-knowledge-changed", serde_json::json!({ "team": team }));
    teams.knowledge_changed(team, change);
}

fn after_add(app: &AppHandle, teams: &Teams, team: &str, added: &Added) {
    if let Some(doc) = &added.doc {
        log::line(format!("team {team}: knowledge {} added ({:?}, {} bytes)", doc.id, doc.kind, doc.bytes));
        knowledge_changed(app, teams, team, KnowledgeChange::Added { doc: doc.id.clone() });
    }
}

#[tauri::command]
fn team_knowledge_list(team: String) -> Result<KnowledgeView, String> {
    Ok(knowledge_of(&team)?.view())
}

/// A file picked or dropped, copied in by its path — for the leader only, as
/// every new document is. `force`: it looked like it held a key, and the
/// person said to add it anyway.
#[tauri::command]
fn team_knowledge_add_path(app: AppHandle, teams: State<Arc<Teams>>, team: String, path: String, force: Option<bool>) -> Result<Added, String> {
    let kb = knowledge_of(&team)?;
    let (name, bytes) = knowledge::read_source(std::path::Path::new(&path))?;
    let added = kb.add(&name, bytes, &path, force.unwrap_or(false))?;
    after_add(&app, &teams, &team, &added);
    Ok(added)
}

/// A pasted picture (or any file) from its bytes: the team and the file name
/// (URL-encoded) in headers, as team_attach_bytes takes them.
#[tauri::command]
fn team_knowledge_add_bytes(app: AppHandle, teams: State<Arc<Teams>>, request: tauri::ipc::Request<'_>) -> Result<Added, String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(percent_decode);
    let team = header("x-team").ok_or_else(|| -> String { tr!("不知道這是給哪個團隊的。", "Which team is this for?") })?;
    let name = header("x-file-name").unwrap_or_else(|| "image.png".into());
    let force = header("x-force").as_deref() == Some("1");
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err(expected_bytes()) };
    let kb = knowledge_of(&team)?;
    let added = kb.add(&name, bytes.clone(), "", force)?;
    after_add(&app, &teams, &team, &added);
    Ok(added)
}

/// Who may read a document, and the person's line about it.
#[tauri::command]
fn team_knowledge_update(app: AppHandle, teams: State<Arc<Teams>>, team: String, doc: String, visibility: Option<Visibility>, note: Option<String>) -> Result<DocView, String> {
    let kb = knowledge_of(&team)?;
    let (updated, was) = kb.update(&doc, visibility, note.as_deref())?;
    if let Some(was) = was {
        log::line(format!("team {team}: knowledge {doc} {was:?} → {:?}", updated.visibility));
        knowledge_changed(&app, &teams, &team, KnowledgeChange::Visibility { doc: doc.clone(), now: updated.visibility });
    } else {
        let _ = app.emit_to("team", "team-knowledge-changed", serde_json::json!({ "team": team }));
    }
    let index = kb.load();
    Ok(kb.doc_view(&index, &updated))
}

/// The original copied in again.
#[tauri::command]
fn team_knowledge_reimport(app: AppHandle, team: String, doc: String, force: Option<bool>) -> Result<Added, String> {
    let added = knowledge_of(&team)?.reimport(&doc, force.unwrap_or(false))?;
    if added.doc.is_some() {
        log::line(format!("team {team}: knowledge {doc} imported again"));
        let _ = app.emit_to("team", "team-knowledge-changed", serde_json::json!({ "team": team }));
    }
    Ok(added)
}

/// Takes a document out (only ever from the second click on 移除).
#[tauri::command]
fn team_knowledge_remove(app: AppHandle, teams: State<Arc<Teams>>, team: String, doc: String) -> Result<(), String> {
    let removed = knowledge_of(&team)?.remove(&doc)?;
    log::line(format!("team {team}: knowledge {} removed", removed.id));
    knowledge_changed(&app, &teams, &team, KnowledgeChange::Removed { doc });
    Ok(())
}

/// A document's file, if it is still there.
fn knowledge_file(team: &str, doc: &str) -> Result<(knowledge::Doc, std::path::PathBuf), String> {
    let kb = knowledge_of(team)?;
    let index = kb.load();
    let found = Kb::find(&index, doc).cloned().ok_or_else(|| -> String { tr!("沒有這份文件。", "There is no such document.") })?;
    let path = kb.path_of(&index, &found);
    if !path.is_file() {
        return Err(tr!(format!("{} 已經不在知識庫資料夾裡了。", found.name), format!("{} is no longer in the knowledge folder.", found.name)));
    }
    Ok((found, path))
}

/// The bytes of a text or a picture in the knowledge base, for the preview.
#[tauri::command]
fn team_knowledge_preview(team: String, doc: String) -> Result<tauri::ipc::Response, String> {
    let (found, path) = knowledge_file(&team, &doc)?;
    if found.kind == knowledge::DocKind::File {
        return Err(tr!("這種檔案沒有預覽，請直接打開。", "This kind of file has no preview: open it instead."));
    }
    std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Shows a document in Explorer.
#[tauri::command]
fn team_knowledge_reveal(team: String, doc: String) -> Result<(), String> {
    let (_, path) = knowledge_file(&team, &doc)?;
    Command::new("explorer").arg("/select,").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens a document with the program the system has for it — on a click
/// only, and never a program, a script or a shortcut.
#[tauri::command]
fn team_knowledge_open(team: String, doc: String) -> Result<(), String> {
    let (found, path) = knowledge_file(&team, &doc)?;
    if knowledge::is_program(&found.name) {
        return Err(tr!(
            "Agent Center 不會打開程式、指令碼或捷徑。請改用「在檔案總管中顯示」。",
            "Agent Center does not open programs, scripts or shortcuts. Show it in Explorer instead."
        ));
    }
    Command::new("explorer").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The files copied in Explorer, for a paste in the Teamwork window.
#[tauri::command]
fn clipboard_files() -> Vec<String> {
    let files = folder::clipboard_files();
    if !files.is_empty() {
        log::line(format!("paste: {} file(s) from the clipboard", files.len()));
    }
    files
}

/// The system's file dialog for one or more files, over the Teamwork window. Empty when cancelled.
#[tauri::command]
async fn pick_files(app: AppHandle, title: String) -> Result<Vec<String>, String> {
    let owner = app.get_webview_window("team").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    let picked = tauri::async_runtime::spawn_blocking(move || folder::pick_files(owner, &title))
        .await
        .map_err(|e| e.to_string())?;
    match &picked {
        Ok(files) => log::line(format!("file dialog: {} file(s) chosen", files.len())),
        Err(err) => log::line(format!("file dialog: {err}")),
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
    let profile = shared.settings.lock().unwrap().agents.iter().find(|a| a.id == agent).cloned().ok_or_else(|| -> String { tr!("沒有這個 agent。", "There is no such agent.") })?;
    let base = profile.env.get("COPILOT_PROVIDER_BASE_URL").map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && !s.contains('…'));
    let base = base.ok_or_else(|| -> String { tr!("這個 agent 沒有自己的端點可以查價格。", "This agent has no endpoint of its own to ask for prices.") })?;
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
    let profile = shared.settings.lock().unwrap().agents.iter().find(|a| a.id == agent).cloned().ok_or_else(|| -> String { tr!("沒有這個 agent。", "There is no such agent.") })?;
    let base = profile.env.get("COPILOT_PROVIDER_BASE_URL").map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && !s.contains('…'));
    let base = base.ok_or_else(|| -> String { tr!("這個 agent 沒有自己的端點。", "This agent has no endpoint of its own.") })?;
    let secret = secrets::get(&profile.secret_key()).unwrap_or_default();
    let key = profile.env.get("COPILOT_PROVIDER_API_KEY").map(|v| v.replace("{secret}", &secret)).filter(|k| !k.trim().is_empty());
    cost::key_spend(&base, key).await
}

/// The chat providers Agent Center can think with: (id, name, model), the
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

fn needs_chat_model() -> String {
    tr!("Agent Center 需要一個聊天模型：請先在 設定 → 聊天模型 加入。", "Agent Center needs a chat model: add one in Settings → Chat models.")
}

/// 「Ask」on a permission card: Agent Center's model explains what the
/// waiting request is for and what it risks. No tools, nothing is decided.
#[tauri::command]
async fn explain_request(
    shared: State<'_, Shared>,
    teams: State<'_, Arc<Teams>>,
    asked: State<'_, explain::Asked>,
    request_id: String,
) -> Result<String, String> {
    let provider = {
        let settings = shared.settings.lock().unwrap();
        settings
            .providers
            .iter()
            .find(|p| p.id == settings.active_provider)
            .or_else(|| settings.providers.first())
            .cloned()
    };
    let provider = provider.ok_or_else(needs_chat_model)?;
    // A team member's card: `team:<team>:<member>:<request id as JSON>`.
    if let Some(rest) = request_id.strip_prefix("team:") {
        let mut parts = rest.splitn(3, ':');
        let (team, member, req) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or("null"));
        let snap = teams.snapshots().into_iter().find(|s| s.id == team).ok_or_else(|| -> String { tr!("這個團隊沒有在執行。", "That team is not running.") })?;
        return explain::explain_team(&provider, &snap, member, req).await;
    }
    let payload = asked.0.lock().unwrap().get(&request_id).cloned().ok_or_else(|| -> String { tr!("這個請求已經不在等待了。", "This request is no longer waiting.") })?;
    explain::explain(&provider, &payload, &teams.snapshots()).await
}

/// The person asks Agent Center something. Steps are told to the Teamwork
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
    name: Option<String>,
    uploads: Option<Vec<String>>,
    instructions: Option<String>,
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
    let provider = provider.ok_or_else(needs_chat_model)?;
    let mut office = secretary::Office::new(teams.inner().clone(), &profiles, agents.inner().clone(), tz_minutes, name.unwrap_or_default());
    office.instructions = instructions.unwrap_or_default();
    let window = app.clone();
    secretary
        .ask(&provider, &office, &text, &uploads.unwrap_or_default(), &move |step| {
            let _ = window.emit_to("team", "secretary-step", step.clone());
        })
        .await
}

/// The person clicked 確認 on one of Agent Center's proposals — the only way any of them happens.
#[tauri::command]
async fn secretary_confirm(
    app: AppHandle,
    shared: State<'_, Shared>,
    teams: State<'_, Arc<Teams>>,
    agents: State<'_, Arc<Agents>>,
    secretary: State<'_, Arc<secretary::Secretary>>,
    id: String,
    tz_minutes: i64,
    create_folder: Option<bool>,
) -> Result<secretary::Proposal, String> {
    let profiles = shared.settings.lock().unwrap().agents.clone();
    let office = secretary::Office::new(teams.inner().clone(), &profiles, agents.inner().clone(), tz_minutes, String::new());
    let done = secretary.confirm(&id, &office, create_folder.unwrap_or(false)).await;
    // A new team or new documents: the window reads every knowledge base again.
    if done.as_ref().is_ok_and(|p| p.kind == "team" || p.kind == "knowledge") {
        let _ = app.emit_to("team", "team-knowledge-changed", serde_json::json!({ "team": "*" }));
    }
    done
}

/// A file attached in Agent Center's conversation, by its path (picked or dropped).
#[tauri::command]
fn secretary_upload_path(secretary: State<Arc<secretary::Secretary>>, path: String) -> Result<secretary::UploadView, String> {
    let (name, bytes) = knowledge::read_source(std::path::Path::new(&path))?;
    secretary.upload(&name, bytes, &path)
}

/// The same from its bytes (a paste); the file name (URL-encoded) in a header.
#[tauri::command]
fn secretary_upload_bytes(secretary: State<Arc<secretary::Secretary>>, request: tauri::ipc::Request<'_>) -> Result<secretary::UploadView, String> {
    let name = request.headers().get("x-file-name").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_else(|| "image.png".into());
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err(expected_bytes()) };
    secretary.upload(&name, bytes.clone(), "")
}

/// The person keeps an attached file that looks like it holds a key.
#[tauri::command]
fn secretary_upload_force(secretary: State<Arc<secretary::Secretary>>, id: String) -> Result<secretary::UploadView, String> {
    secretary.upload_force(&id)
}

#[tauri::command]
fn secretary_upload_remove(secretary: State<Arc<secretary::Secretary>>, id: String) {
    secretary.upload_remove(&id);
}

/// Before confirming: the work folder proposal `id` needs that does not exist
/// yet, so the card can ask whether to create it.
#[tauri::command]
fn secretary_missing_folder(secretary: State<Arc<secretary::Secretary>>, id: String) -> Option<String> {
    secretary.missing_folder(&id)
}

#[tauri::command]
fn secretary_decline(secretary: State<Arc<secretary::Secretary>>, id: String) -> Option<secretary::Proposal> {
    secretary.decline(&id)
}

/// 安裝 CLI: the table, without looking anything up.
#[tauri::command]
fn cli_list() -> Vec<cli_install::Cli> {
    cli_install::list()
}

/// 安裝 CLI: which of them are installed, and their versions.
#[tauri::command]
async fn cli_status() -> Vec<cli_install::Cli> {
    cli_install::status().await
}

/// 安裝 CLI: 向官方確認 — reads the vendors' install pages, on the person's click.
#[tauri::command]
async fn cli_check_official() -> Result<Vec<cli_install::Cli>, String> {
    cli_install::check_official().await
}

/// 安裝 CLI: the person clicked 在終端機執行 on one install command.
#[tauri::command]
fn cli_run_install(id: String, method: usize) -> Result<String, String> {
    cli_install::run(&id, method)
}

/// A new conversation.
#[tauri::command]
fn secretary_reset(secretary: State<Arc<secretary::Secretary>>) {
    secretary.reset();
}

/// What there is to clear in Settings → 團隊與 Agent Center → 清除歷史紀錄.
#[tauri::command]
fn history_stats() -> history::Stats {
    history::stats()
}

/// Clears the teams' runs and what they cost, and with `all` the teams
/// themselves and Agent Center's conversation — only ever from an explicit
/// click, never while a team is at work. Agent Pool, the agents, the chat
/// models, the prices and the constitution stay. What goes is moved to the
/// Recycle Bin.
#[tauri::command]
fn history_clear(app: AppHandle, teams: State<Arc<Teams>>, secretary: State<Arc<secretary::Secretary>>, all: bool) -> Result<history::Stats, String> {
    let known = teams.ids();
    if known.iter().any(|id| teams.is_live(id)) {
        return Err(tr!(
            "還有團隊在執行或暫停中。請先在 Teamwork 停止所有團隊，再清除。",
            "A team is still running or paused. Stop every team in Teamwork first, then clear."
        ));
    }
    history::clear(all)?;
    for id in known {
        teams.forget(&id);
    }
    if all {
        secretary.reset();
    }
    log::line(if all { "history: teams, runs and Agent Center's conversation moved to the Recycle Bin" } else { "history: team runs moved to the Recycle Bin" });
    let _ = app.emit_to("team", "history-cleared", all);
    Ok(history::stats())
}

/// The person's constitution (Coucou's starting one until they save their own).
#[tauri::command]
fn constitution_load() -> constitution::Constitution {
    constitution::current()
}

#[tauri::command]
fn constitution_save(constitution: constitution::Constitution) -> Result<(), String> {
    constitution::save(constitution)?;
    log::line("constitution saved");
    Ok(())
}

/// Which rule a command would fall under, and at what level — for trying rules out.
#[tauri::command]
fn constitution_try(command: String) -> Option<(constitution::Level, String)> {
    let home = std::path::PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default());
    let request = policy::Request { kind: policy::Kind::Execute, command: Some(command), paths: vec![] };
    constitution::current().judge(&request, &home).map(|(level, rule)| (level, rule.text))
}

/// Every agent a team may run as: Settings → Agent Provider, and the team agents built on them.
fn runnable(shared: &Shared) -> Vec<AgentProfile> {
    let natives = shared.settings.lock().unwrap().agents.clone();
    team_agents::current().runnable(&natives)
}

/// The team agents (Teamwork → Agent Pool), and what each native agent's
/// protocol can take of a team agent.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamAgentsView {
    doc: team_agents::TeamAgents,
    /// Native agent id → what its protocol supports.
    supports: std::collections::BTreeMap<String, team_agents::Supports>,
}

#[tauri::command]
fn team_agents_load(shared: State<Shared>) -> TeamAgentsView {
    let natives = shared.settings.lock().unwrap().agents.clone();
    let supports = natives.iter().map(|a| (a.id.clone(), team_agents::supports_profile(a))).collect();
    TeamAgentsView { doc: team_agents::current(), supports }
}

#[tauri::command]
fn team_agents_save(app: AppHandle, shared: State<Shared>, doc: team_agents::TeamAgents) -> Result<(), String> {
    let natives = shared.settings.lock().unwrap().agents.clone();
    team_agents::save(doc, &natives)?;
    log::line("team agents saved");
    let _ = app.emit_to("team", "team-agents-changed", ());
    Ok(())
}

/// Each agent's own folder (agent id, path), for the team setup's "trust it" choice.
#[tauri::command]
fn team_agent_folders(shared: State<Shared>) -> Vec<(String, String)> {
    runnable(&shared).iter().filter_map(|a| Some((a.id.clone(), acp::agent_folder(a)?.to_string_lossy().to_string()))).collect()
}

/// The models an agent offers, for the drop-downs in Settings and Teamwork.
#[tauri::command]
async fn agents_doctor(profiles: Vec<AgentProfile>) -> Result<Vec<acp::AgentCheck>, String> {
    Ok(acp::doctor(profiles).await)
}

#[tauri::command]
async fn agent_models(agents: State<'_, Arc<Agents>>, profile: AgentProfile) -> Result<Vec<claude::ModelChoice>, String> {
    agents.models(&profile).await
}

/// Codex's model lists, by how Codex is started: asked once per run of the app (it starts an app server).
static CODEX_LISTS: std::sync::LazyLock<Mutex<std::collections::BTreeMap<String, Vec<claude::ModelChoice>>>> = std::sync::LazyLock::new(Default::default);

/// What each agent can do (caps.rs), by the id it was sent with: a provider, a team agent, or a form not yet saved.
#[tauri::command]
async fn agent_caps(agents: State<'_, Arc<Agents>>, profiles: Vec<AgentProfile>) -> Result<std::collections::BTreeMap<String, caps::Caps>, String> {
    let choices = pricing::load_choices();
    let table = pricing::cached_table();
    let mut out = std::collections::BTreeMap::new();
    for p in &profiles {
        // Codex says what each of its models takes and how it thinks: ask it, once.
        let offered = if p.protocol == acp::Protocol::Codex {
            let key = format!("{}|{:?}|{:?}", p.command, p.args, p.env);
            let had = CODEX_LISTS.lock().unwrap().get(&key).cloned();
            Some(match had {
                Some(list) => list,
                None => {
                    let list = agents.models(p).await.unwrap_or_default();
                    CODEX_LISTS.lock().unwrap().insert(key, list.clone());
                    list
                }
            })
        } else {
            None
        };
        out.insert(p.id.clone(), caps::of(p, &choices, &table, offered.as_deref()));
    }
    Ok(out)
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
        _ => Err(expected_bytes()),
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
    // Wide, like a normal settings page: 1100 × 880 pt (1650 × 1320 px at
    // 150 %), never more than the display comfortably holds.
    let (width, height) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let scale = m.scale_factor().max(1.0);
            let (w, h) = (m.size().width as f64 / scale, m.size().height as f64 / scale);
            ((w * 0.9).min(1100.0), (h * 0.88).min(880.0))
        })
        .unwrap_or((1000.0, 760.0));
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title(settings_title())
        // The page is dark (or light) whatever Windows is set to; the title
        // bar Windows draws around it has to be told the same.
        .theme(Some(if light_theme(app) { tauri::Theme::Light } else { tauri::Theme::Dark }))
        .inner_size(width, height)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Where the person left it last time, when that is still on a display.
            if let Some(place) = settings_place::load() {
                if settings_place::on_a_display(&win, &place) {
                    let _ = win.set_size(tauri::PhysicalSize::new(place.width, place.height));
                    let _ = win.set_position(tauri::PhysicalPosition::new(place.x, place.y));
                }
            }
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    settings_place::save(&hidden);
                    let _ = hidden.hide();
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => settings_place::save(&hidden),
                _ => {}
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

/// The settings window's last size and place, in %APPDATA%\Coucou\settings-window.json,
/// so it opens again the way the person left it.
mod settings_place {
    use serde::{Deserialize, Serialize};
    use tauri::WebviewWindow;

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
    pub struct Place {
        pub x: i32,
        pub y: i32,
        pub width: u32,
        pub height: u32,
    }

    fn file() -> std::path::PathBuf {
        crate::settings::config_dir().join("settings-window.json")
    }

    pub fn load() -> Option<Place> {
        let place: Place = serde_json::from_slice(&std::fs::read(file()).ok()?).ok()?;
        (place.width >= 200 && place.height >= 200).then_some(place)
    }

    /// Kept only while the window shows normally: a minimized or maximized
    /// window's numbers are not the size the person chose.
    pub fn save(win: &WebviewWindow) {
        if !win.is_visible().unwrap_or(false) || win.is_minimized().unwrap_or(false) || win.is_maximized().unwrap_or(false) {
            return;
        }
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else { return };
        let place = Place { x: pos.x, y: pos.y, width: size.width, height: size.height };
        if load() == Some(place) {
            return;
        }
        let _ = std::fs::create_dir_all(crate::settings::config_dir());
        if let Ok(bytes) = serde_json::to_vec(&place) {
            let _ = std::fs::write(file(), bytes);
        }
    }

    /// Is the window's title bar on one of today's displays? A monitor that
    /// was unplugged must not leave the window out of reach.
    pub fn on_a_display(win: &WebviewWindow, place: &Place) -> bool {
        let (x, y) = (place.x + 40, place.y + 10);
        win.available_monitors().unwrap_or_default().iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
        })
    }
}

fn settings_title() -> String {
    tr!("設定 — Agent Center", "Settings — Agent Center")
}

/// The settings window's title (taskbar, Alt+Tab) in the language of the
/// moment. Teamwork's is a name and stays as it is.
fn window_titles(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.set_title(&settings_title());
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

/// Opens the settings window on one page, scrolled to one card
/// (`settings-goto`). The window is made at start, so it is always listening.
#[tauri::command]
fn open_settings_page(app: AppHandle, page: String, anchor: Option<String>, action: Option<String>) {
    show_settings_window(&app);
    let _ = app.emit_to(
        "settings",
        "settings-goto",
        serde_json::json!({ "page": page, "anchor": anchor, "action": action }),
    );
}

/// #0B0C0E at 45 %, as 0xAABBGGRR: dark enough that light text reads over
/// a white window behind, thin enough that the desktop still shows.
const GLASS_TINT: u32 = 0x730E_0C0B;

/// The light look's glass: #F3F4F6 at 65 %, light enough that dark text reads
/// over a black window behind.
const GLASS_TINT_LIGHT: u32 = 0xA6F6_F4F3;

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
    let mut builder = WebviewWindowBuilder::new(app, "team", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Teamwork — Agent Center")
        .inner_size(width, height)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        // A sheet of glass, not a framed window: no title bar (the page has
        // its own), and nothing painted behind the page.
        .decorations(false)
        .transparent(true)
        // Windows 11 draws the shadow around the page. Windows 10 does not
        // (the window is cut to its rounded corners, which takes it away),
        // and the shadow would only leave a frame of resize borders outside
        // the page, which the blur makes visible: there the page is all of
        // the window, and its edges are what resizes it.
        .shadow(!glass::win10())
        .visible(false)
        // Files are dropped through the page's own HTML5 drag and drop, as on
        // the island: WebView2 keeps the window OLE finds first in its own
        // process, where wry's drop target does not reliably reach.
        .disable_drag_drop_handler()
        .center();
    // Windows 10 has no DWM rounding and gets no acrylic: the page is told to
    // paint its own dark sheet with rounded corners.
    if glass::win10() {
        // Only a flag: this runs as the document is created, before <html>
        // exists — the page applies its own classes once it loads.
        builder = builder.initialization_script("window.__coucouWin10 = true;");
    }
    match builder.build() {
        Ok(win) => {
            // Coucou's black, thin enough for the desktop to show through.
            glass::apply(&win, if light_theme(app) { GLASS_TINT_LIGHT } else { GLASS_TINT });
            glass::drop_caption(&win);
            glass::round_corners(&win);
            let hidden = win.clone();
            win.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
                // Maximized or restored, the window's styles were just rewritten.
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    glass::drop_caption(&hidden);
                    glass::round_corners(&hidden);
                }
                _ => {}
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
    // Shown, its styles were rewritten: no caption again (glass.rs).
    glass::drop_caption(&win);
    let _ = win.set_focus();
}

#[tauri::command]
fn open_team_window(app: AppHandle) {
    show_team_window(&app);
}

/// Opens Teamwork on one of its pages ("secretary", "agents"), or as it was.
#[tauri::command]
fn open_team_page(app: AppHandle, page: Option<String>) {
    show_team_window(&app);
    if let Some(page) = page {
        let _ = app.emit_to("team", "team-goto", page);
    }
}

pub fn run() {
    let loaded = settings::load();
    i18n::set(&loaded.language);
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
        .manage(explain::Asked::default())
        .manage(Chat::default())
        .manage(agents.clone())
        .manage(Arc::new(secretary::Secretary::fresh()))
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            set_dock,
            reset_dock,
            begin_island_drag,
            commit_dock_geometry,
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
            open_settings_page,
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
            agents_doctor,
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
            team_end,
            team_resume,
            team_interrupt,
            team_recover,
            team_interrupt_member,
            team_join,
            team_open,
            team_open_image,
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
            team_agent_folders,
            constitution_load,
            team_agents_load,
            team_agents_save,
            constitution_save,
            constitution_try,
            secretary_ask,
            explain_request,
            secretary_confirm,
            secretary_missing_folder,
            cli_list,
            cli_status,
            cli_check_official,
            cli_run_install,
            secretary_decline,
            secretary_upload_path,
            secretary_upload_bytes,
            secretary_upload_force,
            secretary_upload_remove,
            secretary_reset,
            agent_caps,
            history_stats,
            history_clear,
            team_past,
            team_open_configs,
            team_save,
            team_new,
            pick_folder,
            pick_files,
            clipboard_files,
            team_knowledge_list,
            team_knowledge_add_path,
            team_knowledge_add_bytes,
            team_knowledge_update,
            team_knowledge_reimport,
            team_knowledge_remove,
            team_knowledge_preview,
            team_knowledge_reveal,
            team_knowledge_open,
            team_window,
            open_team_window,
            open_team_page,
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
                    .with_screens(show)
                    .on_knowledge_shared({
                        let app = handle.clone();
                        Arc::new(move |team: &str| {
                            let _ = app.emit_to("team", "team-knowledge-changed", serde_json::json!({ "team": team }));
                        })
                    }),
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
                island::apply_geometry(&handle, &loaded, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            apply_hotkey(&handle, &loaded.hotkey);
            renamed_autostart(&handle, loaded.autostart);
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
                // This runs on the windows' own thread, and stopping agents
                // takes a moment: the windows go first, or the wait shows as
                // a frozen island marked "not responding".
                for window in app.webview_windows().values() {
                    let _ = window.hide();
                }
                let teams = app.try_state::<Arc<Teams>>().map(|t| t.inner().clone());
                let agents = app.state::<Arc<Agents>>().inner().clone();
                tauri::async_runtime::block_on(async move {
                    let all = async {
                        if let Some(teams) = teams {
                            teams.shutdown().await;
                        }
                        agents.shutdown().await;
                    };
                    // Every agent gets its moment side by side; quitting
                    // never waits past this, whatever an agent does.
                    if tokio::time::timeout(QUIT_WAIT, all).await.is_err() {
                        log::line("quit: some agents did not stop in time; leaving anyway");
                    }
                });
            }
        });
}
