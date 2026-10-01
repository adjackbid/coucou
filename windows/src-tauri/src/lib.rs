// Coucou for Windows — app wiring and the commands the island calls.

mod acp;
mod files;
mod hooks;
mod integrations;
mod island;
mod llm;
mod log;
mod pipe;
mod secrets;
mod settings;
mod tray;
mod win_user;

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use acp::{AcpOutcome, AgentProfile, Agents};
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
    llm::send(&chat, &provider, query, context).await
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
    let text = text.trim();
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
    agents: State<'_, Agents>,
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
    agents.prompt(&app, &profile, text).await
}

/// The island's answer to an agent's permission request: one of the option
/// ids the agent offered, or nothing for "cancelled".
#[tauri::command]
async fn acp_permission(
    agents: State<'_, Agents>,
    agent_id: String,
    request_id: serde_json::Value,
    option_id: Option<String>,
) -> Result<(), String> {
    agents.answer_permission(&agent_id, request_id, option_id).await
}

#[tauri::command]
async fn acp_cancel(agents: State<'_, Agents>, agent_id: String) -> Result<(), String> {
    agents.cancel(&agent_id).await
}

/// "New" in the chat while an agent is the target: the next prompt starts a
/// fresh session.
#[tauri::command]
async fn acp_reset(agents: State<'_, Agents>, agent_id: String) -> Result<(), String> {
    agents.reset(&agent_id).await;
    Ok(())
}

/// The settings window's "Test": start the agent as the form describes it,
/// shake hands, open a session, stop it.
#[tauri::command]
async fn acp_test(app: AppHandle, agents: State<'_, Agents>, profile: AgentProfile) -> Result<String, String> {
    agents.test(&app, &profile).await
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

pub fn run() {
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

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
        .manage(Agents::default())
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
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

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
                let agents = app.state::<Agents>();
                tauri::async_runtime::block_on(agents.shutdown());
            }
        });
}
