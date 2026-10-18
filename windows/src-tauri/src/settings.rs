// Preferences, stored as plain JSON in %APPDATA%\Coucou\settings.json.
// No secret ever lands here — API keys live in the Windows Credential Manager.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::acp::AgentProfile;
use crate::llm::Provider;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is
    /// on, "docked" = the display the island was last dragged onto
    /// (`dock.monitor`).
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    #[serde(default)]
    pub copilot_hooks_installed: bool,
    #[serde(default)]
    pub antigravity_hooks_installed: bool,
    /// The model of the pre-provider builds. Kept so an older settings.json
    /// still loads; `migrate` turns it into the first provider.
    #[serde(default = "default_model")]
    pub model: String,
    /// Global shortcut that opens and shuts the island, e.g. "Ctrl+Alt+Space".
    /// Empty disables it.
    #[serde(default = "default_hotkey")]
    pub hotkey: String,
    /// Every endpoint the chat can talk to, and which one it talks to now.
    #[serde(default)]
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub active_provider: String,
    /// Sessions shown as cards side by side in the overview, 1–3.
    #[serde(default = "default_max_cards")]
    pub max_session_cards: u32,
    /// Never hide: the island stays at least compact at the top of the screen.
    #[serde(default)]
    pub always_visible: bool,
    /// 勿擾: the island does not pop up or sound on its own (a request waits
    /// until the person opens it); the moon on its header switches it.
    #[serde(default)]
    pub do_not_disturb: bool,
    /// Copilot asks the island before every tool, --yolo or not (1.0.91 runs
    /// the PermissionRequest hook regardless). Off leaves that hook out, so a
    /// --yolo session runs without a card for each step.
    #[serde(default = "default_true")]
    pub copilot_permission_cards: bool,
    /// Seconds the compact bar stays after the mouse leaves before hiding.
    #[serde(default = "default_hide_after")]
    pub hide_after: f64,
    /// Coding agents the island can start and talk to over ACP.
    #[serde(default)]
    pub agents: Vec<AgentProfile>,
    /// Names the person gave to project folders, by lower-cased path.
    #[serde(default)]
    pub session_names: std::collections::BTreeMap<String, String>,
    /// Where the island sits on its display. Only Rust writes it (a drag, the
    /// tray's reset): see `from_page`.
    #[serde(default)]
    pub dock: Dock,
    /// "system" = the Windows display language, or "zh-TW" | "en". See i18n.rs.
    #[serde(default = "default_language")]
    pub language: String,
    /// Whether Teamwork offers 中二模式 (the raid view) at all. Off by default:
    /// the window then shows nothing of it, for a sober look.
    #[serde(default)]
    pub battle_mode: bool,
    /// "dark" (the default) or "light": the settings window and Teamwork.
    /// The island stays dark, as a notch is.
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    "dark".into()
}

impl Settings {
    /// Light only when asked for; anything else is the dark default.
    pub fn light(&self) -> bool {
        self.theme == "light"
    }
}

/// The edge the island is docked to. The bottom one is the work area's: the
/// island sits on the taskbar, never over it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dock {
    /// "top" | "bottom" | "left" | "right".
    pub edge: String,
    /// Top and bottom only: "start" | "center" | "end" (left / middle / right).
    pub anchor: String,
    /// Left/right only: the capsule's centre as a fraction of the work area's height.
    pub offset: f64,
    /// The display it was dropped on, `Monitor::name()` (e.g. `\\.\DISPLAY2`).
    /// Only used while `screen` is "docked"; empty otherwise.
    #[serde(default)]
    pub monitor: String,
}

impl Default for Dock {
    fn default() -> Self {
        Self { edge: "top".into(), anchor: "center".into(), offset: 0.5, monitor: String::new() }
    }
}

impl Dock {
    /// Whatever a hand-edited or older file says, a dock the island can use.
    pub fn normalized(mut self) -> Self {
        if !matches!(self.edge.as_str(), "top" | "bottom" | "left" | "right") {
            self.edge = "top".into();
        }
        if !matches!(self.anchor.as_str(), "start" | "center" | "end") {
            self.anchor = "center".into();
        }
        self.offset = if self.offset.is_finite() { self.offset.clamp(0.0, 1.0) } else { 0.5 };
        self
    }

    pub fn is_vertical(&self) -> bool {
        self.edge == "left" || self.edge == "right"
    }
}

fn default_language() -> String {
    "system".into()
}

fn default_true() -> bool {
    true
}

fn default_max_cards() -> u32 {
    2
}

fn default_hide_after() -> f64 {
    60.0
}

fn default_model() -> String {
    crate::llm::anthropic::DEFAULT_MODEL.to_string()
}

impl Settings {
    /// The provider the chat uses: the active one, else the first. An active
    /// target naming an agent (`agent:<id>`) is not a provider.
    pub fn active(&self) -> Option<&Provider> {
        self.providers
            .iter()
            .find(|p| p.id == self.active_provider)
            .or_else(|| self.providers.first())
    }

    /// The agent the chat talks to, when `active_provider` is `agent:<id>`.
    pub fn active_agent(&self) -> Option<&AgentProfile> {
        let id = self.active_provider.strip_prefix("agent:")?;
        self.agents.iter().find(|a| a.id == id)
    }

    pub fn agent(&self, id: &str) -> Option<&AgentProfile> {
        self.agents.iter().find(|a| a.id == id)
    }

    /// Brings a settings.json from before providers existed up to date: the
    /// one Claude endpoint it implied becomes a real provider entry.
    fn migrate(&mut self) {
        self.dock = std::mem::take(&mut self.dock).normalized();
        if self.providers.is_empty() {
            self.providers.push(Provider::anthropic(&self.model));
        }
        if self.agents.is_empty() {
            self.agents.push(AgentProfile::copilot());
        }
        let is_agent = self.active_agent().is_some();
        if !is_agent && !self.providers.iter().any(|p| p.id == self.active_provider) {
            self.active_provider = self.providers[0].id.clone();
        }
    }
}

impl Settings {
    /// What the settings window or the island sent, applied over `self`. Both
    /// windows hold their own copy, so the page's `dock` is always stale next to
    /// a drag that just happened: it is ignored, and Rust's kept. Going back to
    /// "primary" or "cursor" forgets the display the island was dropped on.
    pub fn from_page(&self, mut incoming: Settings) -> Settings {
        incoming.dock = self.dock.clone();
        if incoming.screen == "docked" && incoming.dock.monitor.is_empty() {
            incoming.screen = "primary".into();
        }
        if incoming.screen != "docked" {
            incoming.dock.monitor.clear();
        }
        incoming
    }
}

/// Ctrl+Alt+Space and Ctrl+Alt+M looked obvious but were both already taken on
/// the first machine this ran on (input-method switchers, among others), and
/// a key that fails to register is a key that silently does nothing. The
/// settings window says so when it happens.
pub fn default_hotkey() -> String {
    "Ctrl+Shift+Space".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            copilot_hooks_installed: false,
            antigravity_hooks_installed: false,
            model: default_model(),
            hotkey: default_hotkey(),
            providers: vec![Provider::anthropic(&default_model())],
            active_provider: "anthropic".into(),
            max_session_cards: default_max_cards(),
            always_visible: false,
            do_not_disturb: false,
            copilot_permission_cards: true,
            hide_after: default_hide_after(),
            agents: vec![AgentProfile::copilot()],
            session_names: Default::default(),
            dock: Dock::default(),
            language: default_language(),
            battle_mode: false,
            theme: default_theme(),
        }
    }
}

/// %APPDATA%\Coucou
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

/// %LOCALAPPDATA%\Coucou — where coucou-hook.exe and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join("coucou-hook.exe")
}

/// The relay a team member's CLI starts as its MCP server.
pub fn team_mcp_exe_path() -> PathBuf {
    local_dir().join("bin").join("coucou-team-mcp.exe")
}

/// %APPDATA%\Coucou\teams — one JSON file per team, written by the person.
pub fn team_configs_dir() -> PathBuf {
    config_dir().join("teams")
}

/// %LOCALAPPDATA%\Coucou\secretary-uploads — files the person attached in
/// Agent Center's conversation, until a confirmed proposal copies them into
/// a team's knowledge base. Emptied when Coucou starts and when the
/// conversation is cleared: the conversation itself is not kept.
pub fn secretary_uploads_dir() -> PathBuf {
    local_dir().join("secretary-uploads")
}

/// %APPDATA%\Coucou\team-knowledge — one folder per team, holding the
/// documents the person gave it (team::knowledge). Not inside `teams`, where
/// every .json is read as a team file.
pub fn team_knowledge_dir() -> PathBuf {
    config_dir().join("team-knowledge")
}

/// %LOCALAPPDATA%\Coucou\teams — one folder per team, holding its log.
pub fn team_logs_dir() -> PathBuf {
    local_dir().join("teams")
}

/// %APPDATA%\Coucou\skills — the library a leader hands out to its team
/// (`brief_member`): one folder per skill holding a SKILL.md, or one
/// `<name>.md`, written by the person.
pub fn team_skills_dir() -> PathBuf {
    config_dir().join("skills")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    let mut settings = match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    settings.migrate();
    settings
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_settings_file_gets_its_claude_provider() {
        let old = r#"{"soundEnabled":true,"soundVolume":0.1,"autoCloseInterval":15,"absenceInterval":180,
            "activeIntegrations":[],"screen":"primary","autostart":false,"hooksInstalled":false,"model":"claude-sonnet-5"}"#;
        let mut s: Settings = serde_json::from_str(old).unwrap();
        s.migrate();
        assert_eq!(s.providers.len(), 1);
        assert_eq!(s.providers[0].id, "anthropic");
        assert_eq!(s.providers[0].model, "claude-sonnet-5");
        assert_eq!(s.active().unwrap().id, "anthropic");
    }

    #[test]
    fn a_missing_active_provider_falls_back_to_the_first() {
        let mut s = Settings::default();
        s.active_provider = "gone".into();
        s.migrate();
        assert_eq!(s.active_provider, "anthropic");
    }

    #[test]
    fn an_old_settings_file_docks_top_centre() {
        let old = r#"{"soundEnabled":true,"soundVolume":0.1,"autoCloseInterval":15,"absenceInterval":180,
            "activeIntegrations":[],"screen":"primary","autostart":false,"hooksInstalled":false}"#;
        let mut s: Settings = serde_json::from_str(old).unwrap();
        s.migrate();
        assert_eq!(s.dock, Dock::default());
        assert_eq!(s.dock.edge, "top");
        assert_eq!(s.dock.anchor, "center");
    }

    #[test]
    fn a_nonsense_dock_is_normalized() {
        let d = Dock { edge: "diagonal".into(), anchor: "middle".into(), offset: f64::NAN, monitor: "x".into() }
            .normalized();
        assert_eq!(d.edge, "top");
        assert_eq!(d.anchor, "center");
        assert_eq!(d.offset, 0.5);
        assert_eq!(d.monitor, "x");
        assert_eq!(Dock { offset: 3.0, ..Dock::default() }.normalized().offset, 1.0);
        assert_eq!(Dock { edge: "bottom".into(), ..Dock::default() }.normalized().edge, "bottom");
        assert_eq!(Dock { offset: -1.0, ..Dock::default() }.normalized().offset, 0.0);
        let s: Settings = serde_json::from_str(
            r#"{"soundEnabled":true,"soundVolume":0.1,"autoCloseInterval":15,"absenceInterval":180,
            "activeIntegrations":[],"screen":"primary","autostart":false,"hooksInstalled":false,
            "dock":{"edge":"left","anchor":"start","offset":0.3}}"#,
        )
        .unwrap();
        assert_eq!(s.dock.edge, "left");
        assert_eq!(s.dock.monitor, "");
    }

    #[test]
    fn saving_from_a_page_keeps_the_dragged_dock() {
        let mut current = Settings::default();
        current.dock = Dock { edge: "right".into(), anchor: "center".into(), offset: 0.3, monitor: "D2".into() };
        current.screen = "docked".into();
        // The settings window still holds the dock from before the drag.
        let mut page = Settings::default();
        page.screen = "docked".into();
        page.sound_volume = 0.5;
        let saved = current.from_page(page);
        assert_eq!(saved.dock, current.dock);
        assert_eq!(saved.sound_volume, 0.5);
        assert_eq!(saved.screen, "docked");
    }

    #[test]
    fn going_back_to_primary_forgets_the_docked_display() {
        let mut current = Settings::default();
        current.dock = Dock { edge: "left".into(), anchor: "center".into(), offset: 0.4, monitor: "D2".into() };
        current.screen = "docked".into();
        let mut page = Settings::default();
        page.screen = "cursor".into();
        let saved = current.from_page(page);
        assert_eq!(saved.dock.monitor, "");
        assert_eq!(saved.dock.edge, "left");
        assert_eq!(saved.screen, "cursor");
    }
}
