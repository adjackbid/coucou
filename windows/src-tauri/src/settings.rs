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
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
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
    /// Seconds the compact bar stays after the mouse leaves before hiding.
    #[serde(default = "default_hide_after")]
    pub hide_after: f64,
    /// Coding agents the island can start and talk to over ACP.
    #[serde(default)]
    pub agents: Vec<AgentProfile>,
    /// Names the person gave to project folders, by lower-cased path.
    #[serde(default)]
    pub session_names: std::collections::BTreeMap<String, String>,
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
            hide_after: default_hide_after(),
            agents: vec![AgentProfile::copilot()],
            session_names: Default::default(),
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
}
