// Agent Client Protocol client — the island driving a coding agent it started
// itself (`copilot --acp --stdio`, or anything else that speaks ACP).
//
// JSON-RPC 2.0, one message per line, over the child's stdin/stdout. We are
// the client: we send `initialize`, `session/new` and `session/prompt`; the
// agent streams `session/update` notifications (text chunks, tool calls) and
// may ask us `session/request_permission`. Everything the agent says goes to
// the session's sink as events; a permission request is answered by the
// session's rules when it has any (see policy.rs), and otherwise — or when the
// rules say "ask" — by a person, through `answer_permission`.
//
// Sessions are independent. Each has its own process, its own lock and its
// own key: the chat uses the profile's id, a team uses one key per member, so
// one profile can run as several members at once and none of them waits on
// another's turn.

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::claude::{ClaudeState, ModelChoice};
use crate::codex::CodexState;
use crate::island::WINDOW_LABEL;
use crate::log;
use crate::policy::{self, Danger, Scope, Verdict};
use crate::secrets;

const PROTOCOL_VERSION: u64 = 1;
/// How long `initialize` and `session/new` may take; a CLI that needs a login
/// prompt will hang here, and the island must say so rather than wait forever.
const SETUP_TIMEOUT: Duration = Duration::from_secs(30);
/// A whole prompt turn. Agents work for minutes; the island shows progress
/// meanwhile, so this is only a safety net.
const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Configuration ─────────────────────────────────────────────────────────────

/// The protocol an agent is driven by.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    /// The Agent Client Protocol: Copilot CLI (with or without its own
    /// provider), Gemini CLI, any ACP agent.
    #[default]
    Acp,
    /// Codex's app server (`codex app-server`), see codex.rs.
    Codex,
    /// Claude Code's stream-json protocol, the one the Agent SDK speaks; see claude.rs.
    Claude,
    /// Antigravity's CLI in headless mode; see agy.rs.
    Agy,
    /// An n8n workflow behind a Webhook node: no process, one POST a turn; see n8n.rs.
    N8n,
}

/// Where an agent does its work, as the person sorts it in Settings → Agent Provider:
/// on a cloud service, or on their own machine or network. A team agent is
/// whatever its base is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Location {
    Cloud,
    Local,
}

/// A coding agent the island can start and talk to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    /// The executable, looked up on PATH like `where` would (so `copilot`
    /// finds `copilot.cmd`).
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment. "{secret}" in a value becomes the profile's key
    /// from the Credential Manager — here, never in the front end.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Where sessions start; empty means the home folder.
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub protocol: Protocol,
    /// The model it runs, unless a team member names another. Empty: the
    /// agent's own default.
    #[serde(default)]
    pub model: String,
    /// Cloud Agent or Local Agent, as the person set it. None: never set, and
    /// `location()` tells it from the profile.
    #[serde(default)]
    pub location: Option<Location>,
    /// An n8n node: its Webhook's URL (the Production URL).
    #[serde(default)]
    pub url: String,
    /// An n8n node: the header its Webhook checks (Header Auth). Its value is
    /// the profile's key, in the Credential Manager. Empty: no header.
    #[serde(default)]
    pub header_name: String,
    /// An n8n node: how long one call may take, in seconds. 0: n8n::DEFAULT_TIMEOUT.
    #[serde(default)]
    pub timeout_secs: u64,
    /// A team agent (team_agents.rs) runs on another profile's key: that
    /// profile's id. Never saved; set when a team agent is made a profile.
    #[serde(skip)]
    pub key_of: Option<String>,
    /// What a team agent adds to the profile it is built on. Never saved here.
    #[serde(skip)]
    pub extras: Option<Extras>,
    /// The person says it can make pictures (it has a tool for it): nothing reports that on its own.
    #[serde(default)]
    pub image_gen: bool,
}

/// What a team agent (Teamwork → Agent Pool) adds to the native agent it is
/// built on: words for its system prompt, MCP servers, skills, and the
/// description Agent Center picks it by.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Extras {
    pub system_prompt: String,
    pub mcp_servers: Vec<McpServer>,
    /// Skill folders (each with a SKILL.md), or names the agent may already know.
    pub skills: Vec<String>,
    pub description: String,
    /// The person's grouping in Agent Pool; empty for none.
    pub category: String,
    /// Reasoning effort (team_agents::EFFORTS), already checked against the base; empty for its default.
    pub effort: String,
    /// The native agent it is built on.
    pub base: String,
}

impl Extras {
    pub fn system_prompt(&self) -> Option<&str> {
        Some(self.system_prompt.trim()).filter(|s| !s.is_empty())
    }
}

impl AgentProfile {
    /// Copilot CLI as installed from npm; the one profile every install starts with.
    pub fn copilot() -> Self {
        Self {
            id: "copilot".into(),
            name: "Copilot CLI".into(),
            command: "copilot".into(),
            args: vec!["--acp".into(), "--stdio".into()],
            env: BTreeMap::new(),
            cwd: String::new(),
            protocol: Protocol::Acp,
            model: String::new(),
            location: None,
            url: String::new(),
            header_name: String::new(),
            timeout_secs: 0,
            key_of: None,
            extras: None,
            image_gen: false,
        }
    }

    pub fn secret_key(&self) -> String {
        format!("agent:{}", self.key_of.as_deref().unwrap_or(&self.id))
    }

    /// Cloud or local. An n8n node is always local; otherwise what the person
    /// chose, and when they never did, a Copilot on an endpoint of their own
    /// machine or network is local and everything else cloud. The settings
    /// window guesses the same way (core/state.ts `locationOf`).
    pub fn location(&self) -> Location {
        if self.protocol == Protocol::N8n {
            return Location::Local;
        }
        if let Some(chosen) = self.location {
            return chosen;
        }
        let own_endpoint = self.protocol == Protocol::Acp && self.env.get("COPILOT_PROVIDER_BASE_URL").is_some_and(|u| is_local_address(u));
        if own_endpoint { Location::Local } else { Location::Cloud }
    }

    fn working_dir(&self) -> std::path::PathBuf {
        let cwd = self.cwd.trim();
        if !cwd.is_empty() {
            return std::path::PathBuf::from(cwd);
        }
        std::env::var_os("USERPROFILE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    }
}

/// Whether a URL's host is this machine or a private network: localhost,
/// 127.*, ::1, 10.*, 192.168.*, 172.16–31.*, or a name ending in .local / .lan.
pub fn is_local_address(url: &str) -> bool {
    let rest = url.trim().split_once("://").map(|(_, r)| r).unwrap_or(url.trim());
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    }
    .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".lan") || host == "::1" {
        return true;
    }
    let Ok(ip) = host.parse::<std::net::Ipv4Addr>() else { return false };
    ip.is_loopback() || ip.is_private()
}

/// An MCP server handed to the agent with its session: a command it starts
/// (stdio), or a URL it connects to (streamable HTTP) when `url` is set.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct McpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: String,
}

impl McpServer {
    pub fn is_remote(&self) -> bool {
        !self.url.trim().is_empty()
    }

    fn to_json(&self) -> Value {
        if self.is_remote() {
            return json!({ "type": "http", "name": self.name, "url": self.url.trim(), "headers": [] });
        }
        let env: Vec<Value> = self.env.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect();
        json!({ "name": self.name, "command": self.command, "args": self.args, "env": env })
    }
}

/// What one session adds to its profile. The chat's agent launches with the
/// default: the profile's own folder, no MCP server, a card for every request.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Launch {
    /// Where the session works, instead of the profile's folder.
    pub cwd: Option<String>,
    /// Environment on top of the profile's.
    pub env: BTreeMap<String, String>,
    pub mcp_servers: Vec<McpServer>,
    /// Rules that answer permission requests on their own inside this folder;
    /// what they do not allow still reaches a person. `None`: always a person.
    pub auto: Option<Scope>,
    /// The model, instead of the profile's.
    pub model: Option<String>,
    /// Folders this session may not touch at all, refused without a card
    /// (the teams' knowledge bases, but for its own part of one).
    pub private: crate::policy::Private,
}

/// The model a session actually runs, to name usage the agent reported
/// without one: a member's, else the profile's model field (a team agent's
/// own model is that field), and only when neither is set, for Copilot, a
/// COPILOT_MODEL in the profile's environment — what `spawn_agent` gives it.
pub fn running_model(profile: &AgentProfile, launch: &Launch) -> String {
    model_of(profile, launch).or_else(|| env_model(profile)).unwrap_or_default()
}

/// A Copilot profile's COPILOT_MODEL, the stand-in for an empty model field.
fn env_model(profile: &AgentProfile) -> Option<String> {
    (profile.protocol == Protocol::Acp)
        .then(|| profile.env.get("COPILOT_MODEL").map(|m| m.trim()).filter(|m| !m.is_empty() && !m.contains('{')))
        .flatten()
        .map(str::to_string)
}

/// The model a session runs: the launch's, else the profile's, else the agent's own default.
fn model_of(profile: &AgentProfile, launch: &Launch) -> Option<String> {
    launch
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .or_else(|| Some(profile.model.trim()).filter(|m| !m.is_empty()))
        .map(str::to_string)
}

// ── What a session says ───────────────────────────────────────────────────────

/// A `session/update` from the agent.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AcpUpdate {
    /// The session's key (for the chat's agent, the profile id).
    pub agent_id: String,
    pub update: Value,
}

/// A `session/request_permission` a person must answer.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermission {
    pub agent_id: String,
    /// The JSON-RPC id of the agent's request; hand it back with the answer.
    pub request_id: Value,
    pub title: String,
    pub kind: String,
    pub raw_input: Value,
    /// `{ optionId, name, kind }` as the agent offered them.
    pub options: Vec<Value>,
    /// Why the session's rules would not answer this themselves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub danger: Option<Danger>,
    /// The constitution's rule that asks the person about it, when one does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AcpOutcome {
    pub stop_reason: String,
    /// What an n8n node answered, whole: a team hands it in for the member
    /// (orchestrator.rs). The CLIs' words only stream as updates: empty.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reply: String,
}

#[derive(Clone, Debug)]
pub enum Event {
    Update(AcpUpdate),
    Permission(AcpPermission),
    /// The agent's process is gone; the payload is the session's key.
    Exit(String),
    /// Tokens the session's model used since its last report.
    Usage(crate::usage::Usage),
    /// A request the person's constitution forbids, refused without asking.
    Refused(Refusal),
}

/// What was refused, and the rule that refused it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub agent_id: String,
    pub title: String,
    pub rule: String,
}

/// Where a session's events go: the island for the chat's agent, the team's
/// orchestrator for a member.
pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

/// The sink of the chat's agent: straight to the island window.
pub fn to_island(app: &AppHandle) -> Sink {
    let app = app.clone();
    Arc::new(move |event| {
        let _ = match event {
            Event::Update(u) => app.emit_to(WINDOW_LABEL, "acp-update", u),
            Event::Permission(p) => app.emit_to(WINDOW_LABEL, "acp-permission", p),
            Event::Exit(key) => app.emit_to(WINDOW_LABEL, "acp-exit", key),
            // The chat does not count; teams do.
            Event::Usage(_) => Ok(()),
            Event::Refused(r) => app.emit_to(WINDOW_LABEL, "acp-refused", r),
        };
    })
}

// ── The running agent ─────────────────────────────────────────────────────────

type Reader = Box<dyn AsyncRead + Send + Unpin>;
pub(crate) type Writer = Arc<AsyncMutex<Box<dyn AsyncWrite + Send + Unpin>>>;
type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// The two ends of an agent, and the process behind them when there is one.
pub struct Transport {
    pub reader: Reader,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    pub child: Option<Child>,
}

/// How an agent is brought up. The app starts a process; a test hands over a
/// pipe with a scripted agent on the other end.
pub type Opener = Arc<dyn Fn(&AgentProfile, &Launch) -> Result<Transport, String> + Send + Sync>;

pub(crate) struct Running {
    pub(crate) profile: AgentProfile,
    launch: Launch,
    child: AsyncMutex<Option<Child>>,
    pub(crate) writer: Writer,
    /// The ACP session, or the Codex thread.
    pub(crate) session_id: String,
    pending: PendingMap,
    pub(crate) next_id: AtomicU64,
    /// Cleared by the reader when the agent closes its output.
    alive: Arc<AtomicBool>,
    pub(crate) codex: Arc<CodexState>,
    pub(crate) claude: Arc<ClaudeState>,
    pub(crate) agy: Arc<crate::agy::AgyState>,
    /// What the agent has reported in this session so far (ACP).
    usage: crate::usage::Totals,
}

/// One session's place: the lock that keeps its turns in order, and the agent
/// once it is up. The lock is per session, never shared.
#[derive(Default)]
struct Slot {
    turn: AsyncMutex<()>,
    running: Mutex<Option<Arc<Running>>>,
}

/// Every session the app has started, by key.
pub struct Agents {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    opener: Opener,
    /// The n8n calls under way, by session key: cancel and reset abort them.
    calls: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl Default for Agents {
    fn default() -> Self {
        Self::with_opener(Arc::new(spawn_agent))
    }
}

fn find_on_path(stem: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(stem);
    if p.is_absolute() && p.is_file() {
        return Some(p.to_path_buf());
    }
    crate::find_on_path(stem)
}

/// Where npm and the usual installers drop CLIs — tried when PATH comes up
/// empty, because the app inherits PATH at launch and a probe can also fail
/// transiently (a scanner holding the shim, a sync client hydrating it).
fn fallback_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(std::path::PathBuf::from(&appdata).join("npm"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local = std::path::PathBuf::from(&local);
        dirs.push(local.join("Programs"));
        dirs.push(local.join("Microsoft").join("WindowsApps"));
    }
    dirs
}

/// The PATH lookup with the known directories behind it and one short retry.
/// A team resume must not fall over on a probe that fails for half a second.
pub fn resolve_agent_exe(stem: &str) -> Option<std::path::PathBuf> {
    for attempt in 0..2u8 {
        if let Some(p) = find_on_path(stem) {
            return Some(p);
        }
        for dir in fallback_dirs() {
            for ext in [".cmd", ".exe", ".bat", ".com"] {
                let candidate = dir.join(format!("{stem}{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        if attempt == 0 {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
    None
}

/// One agent's health, the way `agents_doctor` tells it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheck {
    pub id: String,
    pub name: String,
    pub command: String,
    /// The executable the lookup settles on, if any.
    pub found: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
    pub took_ms: u64,
}

/// Looks every profile's CLI up and asks it for its version: the self-check
/// behind 檢查代理. Finding it again also warms whatever made the last probe
/// fail, so this doubles as the repair.
pub async fn doctor(profiles: Vec<AgentProfile>) -> Vec<AgentCheck> {
    let mut out = Vec::new();
    for p in profiles {
        let started = std::time::Instant::now();
        let mut check = AgentCheck { id: p.id.clone(), name: p.name.clone(), command: p.command.clone(), found: None, version: None, error: None, took_ms: 0 };
        // An n8n node has nothing to look for on this machine: its Test calls it.
        if p.protocol == Protocol::N8n {
            check.command = p.url.clone();
            if p.url.trim().is_empty() {
                check.error = Some(tr!("這個 n8n 節點還沒填 Webhook 網址。", "This n8n node has no webhook URL yet."));
            } else {
                check.found = Some(p.url.trim().to_string());
            }
            out.push(check);
            continue;
        }
        match resolve_agent_exe(&p.command) {
            None => {
                let dirs: Vec<String> = fallback_dirs().iter().map(|d| d.display().to_string()).collect();
                let (command, dirs) = (&p.command, dirs.join(", "));
                check.error = Some(tr!(
                    format!("在 PATH 和 {dirs} 裡都找不到「{command}」。請重新安裝，或在設定裡填上它的完整路徑。"),
                    format!("'{command}' was not found on PATH nor in {dirs}. Reinstall it, or put its full path in the profile.")
                ));
            }
            Some(exe) => {
                check.found = Some(exe.display().to_string());
                // npm shims are batch files: they only run through cmd.
                let shim = exe.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
                let mut cmd = if shim {
                    let mut c = tokio::process::Command::new("cmd");
                    c.arg("/c").arg(&exe);
                    c
                } else {
                    tokio::process::Command::new(&exe)
                };
                cmd.arg("--version");
                #[cfg(windows)]
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                match tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output()).await {
                    Err(_) => check.error = Some(tr!("它在 15 秒內沒有回應 `--version`。", "It did not answer `--version` within 15 s.")),
                    Ok(Err(e)) => check.error = Some(tr!(format!("沒辦法啟動它：{e}"), format!("It could not be started: {e}"))),
                    Ok(Ok(out_)) if !out_.status.success() && out_.stdout.is_empty() => {
                        let said = String::from_utf8_lossy(&out_.stderr).trim().to_string();
                        check.error = Some(tr!(format!("`--version` 失敗：{said}"), format!("`--version` failed: {said}")))
                    }
                    Ok(Ok(out_)) => {
                        let text = String::from_utf8_lossy(&out_.stdout);
                        check.version = Some(text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string());
                    }
                }
            }
        }
        check.took_ms = started.elapsed().as_millis() as u64;
        out.push(check);
    }
    out
}

fn working_dir(profile: &AgentProfile, launch: &Launch) -> std::path::PathBuf {
    match launch.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(cwd) => std::path::PathBuf::from(cwd),
        None => profile.working_dir(),
    }
}

/// Starts the agent's process with its stdin and stdout piped.
/// The name every team member knows Coucou's team server by.
pub const TEAM_SERVER: &str = "coucou-team";

fn is_copilot(exe: &std::path::Path) -> bool {
    exe.file_stem().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("copilot"))
}

/// Copilot CLI over ACP accepts the `mcpServers` of `session/new` and starts
/// none of them; it takes its servers from its own configuration. So a
/// session's servers go into a file in that format, handed over with
/// `--additional-mcp-config @file` — a file, because the command line goes
/// through cmd.exe (copilot is an npm shim) and JSON does not survive it.
/// Files older than two days are swept away.
fn copilot_mcp_file(servers: &[McpServer]) -> Result<std::path::PathBuf, String> {
    let mut map = serde_json::Map::new();
    for s in servers {
        let entry = if s.is_remote() {
            json!({ "type": "http", "url": s.url.trim(), "tools": ["*"] })
        } else {
            json!({ "type": "local", "command": s.command, "args": s.args, "env": s.env, "tools": ["*"] })
        };
        map.insert(s.name.clone(), entry);
    }
    let text = json!({ "mcpServers": map }).to_string();
    let dir = std::env::temp_dir().join("coucou-mcp");
    std::fs::create_dir_all(&dir).map_err(|e| mcp_unprepared(&e))?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let old = std::time::SystemTime::now() - Duration::from_secs(2 * 24 * 3600);
        for entry in entries.flatten() {
            if entry.metadata().and_then(|m| m.modified()).map(|t| t < old).unwrap_or(false) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    // Named after what is in it: the same servers, the same file.
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    let file = dir.join(format!("{:016x}.json", h.finish()));
    std::fs::write(&file, text).map_err(|e| mcp_unprepared(&e))?;
    Ok(file)
}

fn mcp_unprepared(e: &std::io::Error) -> String {
    tr!(format!("沒辦法準備 agent 的 MCP 伺服器：{e}"), format!("Could not prepare the agent's MCP servers: {e}"))
}

fn prompt_unprepared(e: &std::io::Error) -> String {
    tr!(format!("沒辦法準備 agent 的系統提示：{e}"), format!("Could not prepare the agent's system prompt: {e}"))
}

/// What the person is told when an agent's CLI cannot be found.
pub(crate) fn not_on_path(command: &str) -> String {
    tr!(
        format!("在 PATH 上找不到「{command}」。在團隊設定按「檢查代理」可以重新檢測與定位。"),
        format!("'{command}' was not found on PATH. Press 'Check agents' in the team's setup to look for it again.")
    )
}

/// A team agent's system prompt as a file, for Claude Code's
/// `--append-system-prompt-file`: many lines and quotes do not survive a
/// command line that goes through cmd.exe. Named after what is in it.
fn prompt_file(words: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join("coucou-prompts");
    std::fs::create_dir_all(&dir).map_err(|e| prompt_unprepared(&e))?;
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    words.hash(&mut h);
    let file = dir.join(format!("{:016x}.md", h.finish()));
    std::fs::write(&file, words).map_err(|e| prompt_unprepared(&e))?;
    Ok(file)
}

/// Whether a profile runs Copilot CLI, whose MCP servers go on its command line.
/// The folder an agent keeps its own working files in, outside any project:
/// Copilot's sessions, the images Codex generates, Antigravity's artifacts.
/// A team may trust it like its work folder (TeamConfig::agent_folders).
pub fn agent_folder(profile: &AgentProfile) -> Option<std::path::PathBuf> {
    let home = std::path::PathBuf::from(std::env::var_os("USERPROFILE")?);
    Some(match profile.protocol {
        Protocol::Acp if runs_copilot(profile) => home.join(".copilot").join("session-state"),
        Protocol::Codex => home.join(".codex").join("generated_images"),
        Protocol::Agy => home.join(".gemini").join("antigravity").join("brain"),
        _ => return None,
    })
}

pub fn runs_copilot(profile: &AgentProfile) -> bool {
    profile.protocol == Protocol::Acp && is_copilot(std::path::Path::new(&profile.command))
}

fn spawn_agent(profile: &AgentProfile, launch: &Launch) -> Result<Transport, String> {
    if profile.protocol == Protocol::N8n {
        return Err(crate::n8n::no_process());
    }
    let exe = resolve_agent_exe(&profile.command).ok_or_else(|| not_on_path(&profile.command))?;
    let secret = secrets::get(&profile.secret_key()).unwrap_or_default();
    let cwd = working_dir(profile, launch);
    if !cwd.is_dir() {
        let d = cwd.display();
        return Err(tr!(format!("資料夾 {d} 不存在。"), format!("The folder {d} does not exist.")));
    }

    let mut cmd = Command::new(&exe);
    cmd.args(&profile.args);
    let model = model_of(profile, launch);
    // A team agent's effort, each provider by its own flag.
    let effort = profile.extras.as_ref().map(|x| x.effort.as_str()).filter(|e| !e.is_empty());
    match profile.protocol {
        // Codex takes its MCP servers as configuration, not from the thread.
        Protocol::Codex => {
            cmd.args(crate::codex::mcp_args(&launch.mcp_servers));
            if let Some(e) = effort {
                cmd.arg("-c").arg(format!("model_reasoning_effort=\"{e}\""));
            }
        }
        Protocol::Claude => {
            cmd.args(crate::claude::args(model.as_deref(), &launch.mcp_servers));
            if let Some(e) = effort {
                cmd.arg("--effort").arg(e);
            }
            if let Some(words) = profile.extras.as_ref().and_then(|x| x.system_prompt()) {
                cmd.arg("--append-system-prompt-file").arg(prompt_file(words)?);
            }
        }
        // A team member: agy's checks off, the team's gate in their place
        // (agy.rs), and who it is in the environment its hook and its MCP
        // server inherit.
        Protocol::Agy => {
            let team = launch.mcp_servers.first();
            cmd.args(crate::agy::args(model.as_deref(), effort, team.is_some()));
            for (k, v) in team.map(|s| &s.env).into_iter().flatten() {
                cmd.env(k, v);
            }
        }
        // Copilot CLI reads its model from the environment, whichever
        // provider it talks to (set below, after the profile's own). The MCP
        // servers are Agent Center's own, so their tools run without a card
        // each time.
        Protocol::Acp => {
            if let (true, Some(e)) = (runs_copilot(profile), effort) {
                cmd.arg("--reasoning-effort").arg(e);
            }
            if runs_copilot(profile) && !launch.mcp_servers.is_empty() {
                // Only the team's own tools go without a card; a server the
                // person added asks like any other tool.
                cmd.args(launch.mcp_servers.iter().filter(|s| s.name == TEAM_SERVER).map(|s| format!("--allow-tool={}", s.name)));
                cmd.arg("--additional-mcp-config").arg(format!("@{}", copilot_mcp_file(&launch.mcp_servers)?.display()));
            }
        }
        Protocol::N8n => unreachable!("an n8n node is turned away above"),
    }
    cmd
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    for (k, v) in &profile.env {
        if k.trim().is_empty() {
            continue;
        }
        cmd.env(k.trim(), v.replace("{secret}", &secret));
    }
    for (k, v) in &launch.env {
        if !k.trim().is_empty() {
            cmd.env(k.trim(), v);
        }
    }
    // The model the person can see wins — a member's, else the agent's model
    // field (a team agent's own model) — over a COPILOT_MODEL left in the
    // profile's environment, which only stands in when neither is set. The
    // other way round, an endpoint that lets a key use only some models
    // answers 401 for the leftover one, and Copilot calls that a bad key.
    if let (Protocol::Acp, Some(m)) = (&profile.protocol, &model) {
        cmd.env("COPILOT_MODEL", m);
    }
    let mut child = cmd.spawn().map_err(|e| -> String {
        let x = exe.display();
        tr!(format!("沒辦法啟動 {x}：{e}"), format!("Could not start {x}: {e}"))
    })?;
    let stdin = child.stdin.take().ok_or_else(|| -> String { tr!("沒有拿到 agent 的輸入管道。", "no stdin") })?;
    let stdout = child.stdout.take().ok_or_else(|| -> String { tr!("沒有拿到 agent 的輸出管道。", "no stdout") })?;
    Ok(Transport { reader: Box::new(stdout), writer: Box::new(stdin), child: Some(child) })
}

/// Copilot CLI on its own endpoint (the `cg` way): the endpoint's list. On a
/// GitHub login it lists nothing here, and the model is typed.
async fn copilot_models(profile: &AgentProfile) -> Result<Vec<ModelChoice>, String> {
    let base = profile.env.get("COPILOT_PROVIDER_BASE_URL").map(|s| s.trim()).filter(|s| !s.is_empty() && !s.contains('…'));
    let Some(base) = base else {
        return Err(tr!("這個 agent 不會在這裡列出它的模型，請直接輸入模型名稱。", "This agent does not list its models here; type the model's name."));
    };
    let secret = secrets::get(&profile.secret_key()).unwrap_or_default();
    let key = profile.env.get("COPILOT_PROVIDER_API_KEY").map(|v| v.replace("{secret}", &secret)).filter(|k| !k.trim().is_empty());
    let mut provider = crate::llm::Provider::anthropic("");
    provider.id = format!("agent-{}", profile.id);
    provider.name = profile.name.clone();
    provider.kind = "openai".into();
    provider.base_url = base.to_string();
    provider.auth = if key.is_some() { "bearer".into() } else { "none".into() };
    let ids = crate::llm::models_with_key(&provider, key).await?;
    Ok(ids.into_iter().map(|id| ModelChoice { label: id.clone(), id }).collect())
}

/// Why `model` will not do on an endpoint that lists `offered`: a gateway
/// such as LiteLLM lists only what the key may use, and answers 401 for
/// anything else — which Copilot reports as a bad key. None when it is
/// listed, or when nothing is listed or no model is named to judge by.
fn unoffered(model: &str, offered: &[ModelChoice]) -> Option<String> {
    let model = model.trim();
    if model.is_empty() || offered.is_empty() || offered.iter().any(|m| m.id.eq_ignore_ascii_case(model)) {
        return None;
    }
    let mut list: Vec<&str> = offered.iter().map(|m| m.id.as_str()).take(12).collect();
    if offered.len() > list.len() {
        list.push("…");
    }
    let list = list.join(", ");
    Some(tr!(
        format!("連得上，但它會用的模型「{model}」不在端點的模型清單裡（這把金鑰能用：{list}）。實際工作時端點會回 401，看起來像金鑰錯。請在「模型」欄選清單裡的一個（它優先於環境變數的 COPILOT_MODEL）。"),
        format!("It connects, but the model it would use, '{model}', is not in the endpoint's list (this key may use: {list}). At work the endpoint would answer 401, which looks like a bad key. Pick one of those in the Model field (it wins over COPILOT_MODEL in the environment).")
    ))
}

/// Stops the agent and everything under it. An npm shim is a tree —
/// `copilot.cmd` → cmd.exe → node → copilot.exe — and killing the child we
/// spawned leaves the real agent running, so the whole tree goes.
async fn stop(running: &Running) {
    let Some(mut child) = running.child.lock().await.take() else { return };
    // Asked to go, an agent gets to close its session properly (its own
    // records finished, its last report sent): its input closed, it has a
    // moment to do so before it is killed. A write stuck on a pipe the agent
    // no longer reads holds the writer: closing it is not waited on forever.
    let _ = tokio::time::timeout(Duration::from_millis(500), async { running.writer.lock().await.shutdown().await }).await;
    if tokio::time::timeout(Duration::from_secs(4), child.wait()).await.is_ok() {
        return;
    }
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = child.kill().await;
}

/// What the reader needs to route one line from the agent.
#[derive(Clone)]
pub(crate) struct Route {
    pub(crate) sink: Sink,
    pub(crate) key: String,
    pending: PendingMap,
    pub(crate) writer: Writer,
    pub(crate) auto: Option<Scope>,
    pub(crate) private: crate::policy::Private,
    /// Where the session works: the constitution reads relative paths against it.
    pub(crate) work_dir: std::path::PathBuf,
    /// Set for a Codex session: its lines are read by codex.rs.
    codex: Option<Arc<CodexState>>,
    /// Set for a Claude Code session: its lines are read by claude.rs.
    claude: Option<Arc<ClaudeState>>,
    /// Set for an Antigravity session: its lines are read by agy.rs.
    agy: Option<Arc<crate::agy::AgyState>>,
}

/// Brings the agent up, runs `initialize` and `session/new`, and keeps it.
async fn start(opener: &Opener, sink: &Sink, key: &str, profile: &AgentProfile, launch: &Launch) -> Result<Running, String> {
    let Transport { reader, writer, child } = opener(profile, launch)?;
    let writer: Writer = Arc::new(AsyncMutex::new(writer));
    let pending: PendingMap = Default::default();
    let alive = Arc::new(AtomicBool::new(true));
    let codex = Arc::new(CodexState::default());
    let claude = Arc::new(ClaudeState::default());
    let agy = Arc::new(crate::agy::AgyState::default());

    // The reader: responses settle the pending requests, notifications go to
    // the sink, and the agent's own requests to us are answered here.
    {
        let route = Route {
            sink: sink.clone(),
            key: key.to_string(),
            pending: pending.clone(),
            writer: writer.clone(),
            auto: launch.auto.clone(),
            private: launch.private.clone(),
            work_dir: working_dir(profile, launch),
            codex: (profile.protocol == Protocol::Codex).then(|| codex.clone()),
            claude: (profile.protocol == Protocol::Claude).then(|| claude.clone()),
            agy: (profile.protocol == Protocol::Agy).then(|| agy.clone()),
        };
        let alive = alive.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                dispatch(&route, msg).await;
            }
            log::line(format!("acp {}: agent closed its output", route.key));
            alive.store(false, Ordering::Relaxed);
            // Nobody will answer what is still pending.
            route.pending.lock().unwrap().clear();
            (route.sink)(Event::Exit(route.key.clone()));
        });
    }

    let mut running = Running {
        profile: profile.clone(),
        launch: launch.clone(),
        child: AsyncMutex::new(child),
        writer,
        session_id: String::new(),
        pending,
        next_id: AtomicU64::new(1),
        alive,
        codex,
        claude,
        agy,
        usage: crate::usage::Totals::default(),
    };

    let setup = setup(&mut running, key, profile, launch).await;
    if let Err(err) = setup {
        stop(&running).await;
        return Err(err);
    }
    Ok(running)
}

async fn setup(running: &mut Running, key: &str, profile: &AgentProfile, launch: &Launch) -> Result<(), String> {
    match profile.protocol {
        Protocol::Codex => {
            let cwd = working_dir(profile, launch);
            return crate::codex::setup(running, key, &cwd, launch, model_of(profile, launch), SETUP_TIMEOUT).await;
        }
        Protocol::Claude => return crate::claude::setup(running, key, launch, SETUP_TIMEOUT).await,
        Protocol::Agy => {
            if let Some(m) = model_of(profile, launch) {
                *running.agy.model.lock().unwrap() = m;
            }
            return crate::agy::setup(running, key, &working_dir(profile, launch), launch).await;
        }
        Protocol::N8n => return Err(crate::n8n::no_process()),
        Protocol::Acp => {}
    }
    let init = request(
        running,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "coucou", "title": "Agent Center", "version": env!("CARGO_PKG_VERSION") },
        }),
        SETUP_TIMEOUT,
    )
    .await?;
    if let Some(methods) = init.get("authMethods").and_then(Value::as_array) {
        if !methods.is_empty() && init.get("agentCapabilities").is_none() {
            return Err(tr!("這個 agent 要先登入。請先在終端機執行它一次。", "The agent wants a login first. Run it once in a terminal."));
        }
    }
    let agent_name = init
        .get("agentInfo")
        .and_then(|i| i.get("title").or_else(|| i.get("name")))
        .and_then(Value::as_str)
        .unwrap_or("agent")
        .to_string();

    let cwd = working_dir(profile, launch);
    // Copilot's came on its command line (see copilot_mcp_file); naming them
    // here as well would only risk a second copy.
    let servers: Vec<Value> = if runs_copilot(profile) { Vec::new() } else { launch.mcp_servers.iter().map(McpServer::to_json).collect() };
    let session = request(
        running,
        "session/new",
        json!({ "cwd": cwd.to_string_lossy(), "mcpServers": servers }),
        SETUP_TIMEOUT,
    )
    .await
    .map_err(|e| {
        // Copilot without a GitHub login and without BYOK variables answers
        // exactly this; say what to do about it.
        if e.contains("Authentication required") {
            let command = &profile.command;
            tr!(
                format!("{agent_name} 要先登入：請在終端機執行 `{command} login`，或在設定裡替它加上供應商需要的環境變數（BYOK）。"),
                format!("{agent_name} wants to be logged in: run `{command} login` in a terminal, or give the profile the provider environment (BYOK) it needs.")
            )
        } else {
            e
        }
    })?;
    running.session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| -> String { tr!("agent 的 session/new 沒有回傳 sessionId。", "session/new returned no sessionId") })?
        .to_string();
    log::line(format!(
        "acp {key}: {agent_name} session {} in {} ({} MCP server(s), {})",
        running.session_id,
        cwd.display(),
        launch.mcp_servers.len(),
        if launch.auto.is_some() { "rules answer permissions" } else { "a person answers permissions" },
    ));
    Ok(())
}

/// Sends a request and waits for its response.
pub(crate) async fn request(running: &Running, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let id = running.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    running.pending.lock().unwrap().insert(id, tx);
    let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
    if let Err(err) = write_line(&running.writer, &line).await {
        running.pending.lock().unwrap().remove(&id);
        return Err(err);
    }
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(tr!("agent 已經結束了。", "The agent went away.")),
        Err(_) => {
            running.pending.lock().unwrap().remove(&id);
            Err(tr!(format!("agent 沒有及時回應 {method}。"), format!("The agent did not answer {method} in time.")))
        }
    }
}

pub(crate) async fn notify(writer: &Writer, method: &str, params: Value) -> Result<(), String> {
    let line = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
    write_line(writer, &line).await
}

pub(crate) async fn write_line(writer: &Writer, line: &str) -> Result<(), String> {
    let mut w = writer.lock().await;
    w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    w.write_all(b"\n").await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())
}

/// The option of one of `kinds` the agent offered, first kind first.
fn option_of(options: &[Value], kinds: &[&str]) -> Option<String> {
    kinds.iter().find_map(|kind| {
        options
            .iter()
            .find(|o| o.get("kind").and_then(Value::as_str) == Some(kind))
            .and_then(|o| o.get("optionId").and_then(Value::as_str))
            .map(str::to_string)
    })
}

fn permission_reply(request_id: &Value, option_id: Option<&str>) -> String {
    let outcome = match option_id {
        Some(id) => json!({ "outcome": "selected", "optionId": id }),
        None => json!({ "outcome": "cancelled" }),
    };
    json!({ "jsonrpc": "2.0", "id": request_id, "result": { "outcome": outcome } }).to_string()
}

/// One line from the agent.
async fn dispatch(route: &Route, msg: Value) {
    // Claude Code's lines are not JSON-RPC at all.
    if let Some(state) = route.claude.clone() {
        crate::claude::dispatch(route, &state, msg).await;
        return;
    }
    if let Some(state) = route.agy.clone() {
        crate::agy::dispatch(route, &state, msg).await;
        return;
    }
    let method = msg.get("method").and_then(Value::as_str);
    let id = msg.get("id").cloned();
    let key = &route.key;

    // Codex's notifications and requests are its own; answers to our
    // requests are settled below the same way for both.
    if method.is_some() {
        if let Some(state) = route.codex.clone() {
            crate::codex::dispatch(route, &state, msg).await;
            return;
        }
    }

    match (method, id) {
        // A response to one of ours.
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            if let Some(tx) = route.pending.lock().unwrap().remove(&id) {
                let result = if let Some(err) = msg.get("error") {
                    Err(err.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| tr!("agent 發生錯誤", "agent error")))
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(result);
            }
        }
        // A notification: progress.
        (Some("session/update"), None) => {
            let update = msg.get("params").and_then(|p| p.get("update")).cloned().unwrap_or(Value::Null);
            (route.sink)(Event::Update(AcpUpdate { agent_id: key.clone(), update }));
        }
        (Some(_), None) => {}
        // A request from the agent to us.
        (Some(method), Some(id)) => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            match method {
                "session/request_permission" => {
                    let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
                    let options = params
                        .get("options")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let title = tool.get("title").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| tr!("一個工具呼叫", "A tool call"));
                    let kind = tool.get("kind").and_then(Value::as_str).unwrap_or("other").to_string();

                    // The constitution first: what it forbids is refused here,
                    // with no card; what it asks about goes to the person.
                    let asked = policy::Request::from_acp(&tool);
                    // A team's private documents: refused, and nobody is asked.
                    if route.private.touches(&asked, &route.work_dir) {
                        log::line(format!("acp {key}: {kind} refused — the team's private knowledge base"));
                        let refuse = option_of(&options, &["reject_once", "reject_always"]);
                        let _ = write_line(&route.writer, &permission_reply(&id, refuse.as_deref())).await;
                        return;
                    }
                    let ruled = crate::constitution::rule_for(&asked, &route.work_dir);
                    if let Some((crate::constitution::Level::Never, rule)) = &ruled {
                        log::line(format!("acp {key}: {kind} refused by the constitution — {}", rule.text));
                        let refuse = option_of(&options, &["reject_once", "reject_always"]);
                        let _ = write_line(&route.writer, &permission_reply(&id, refuse.as_deref())).await;
                        (route.sink)(Event::Refused(Refusal { agent_id: key.clone(), title, rule: rule.text.clone() }));
                        return;
                    }
                    let rule = ruled.map(|(_, r)| r.text);
                    // Then the session's rules. Allowed once, never "always":
                    // the next request is judged on its own.
                    let mut danger = None;
                    if let Some(scope) = route.auto.as_ref().filter(|_| rule.is_none()) {
                        // The shape of the input, not its content: enough to
                        // see a CLI the rules do not read yet.
                        let fields: Vec<&str> = tool
                            .get("rawInput")
                            .and_then(Value::as_object)
                            .map(|o| o.keys().map(String::as_str).collect())
                            .unwrap_or_default();
                        match policy::decide(scope, &asked) {
                            Verdict::Allow => {
                                if let Some(option) = option_of(&options, &["allow_once"]) {
                                    log::line(format!("acp {key}: {kind} allowed by the rules (input: {fields:?})"));
                                    let _ = write_line(&route.writer, &permission_reply(&id, Some(&option))).await;
                                    return;
                                }
                                // Nothing to allow it once with: a person decides.
                            }
                            Verdict::Ask(why) => {
                                log::line(format!("acp {key}: {kind} waits for a person — {why:?} (input: {fields:?})"));
                                danger = Some(why);
                            }
                        }
                    } else {
                        log::line(format!("acp {key}: permission asked for {kind}: {title}"));
                    }

                    (route.sink)(Event::Permission(AcpPermission {
                        agent_id: key.clone(),
                        request_id: id,
                        title,
                        kind,
                        raw_input: tool.get("rawInput").cloned().unwrap_or(Value::Null),
                        options,
                        danger,
                        rule,
                    }));
                }
                // We declared no fs or terminal capability; a well-behaved
                // agent never asks. Say no rather than hang it.
                _ => {
                    let reply = json!({
                        "jsonrpc": "2.0", "id": id,
                        // The agent's own protocol: not for the person.
                        "error": { "code": -32601, "message": format!("{method} is not offered by this client") },
                    });
                    let _ = write_line(&route.writer, &reply.to_string()).await;
                }
            }
        }
        (None, None) => {}
    }
}

fn not_running() -> String {
    tr!("這個 agent 沒有在執行。", "that agent is not running")
}

// ── Entry points (the Tauri commands and the team orchestrator call these) ────

impl Agents {
    pub fn with_opener(opener: Opener) -> Self {
        Self { slots: Mutex::new(HashMap::new()), opener, calls: Mutex::new(HashMap::new()) }
    }

    fn slot(&self, key: &str) -> Arc<Slot> {
        self.slots.lock().unwrap().entry(key.to_string()).or_default().clone()
    }

    /// The session's agent if it is up — a short look, never held over a turn.
    fn running(&self, key: &str) -> Option<Arc<Running>> {
        let slot = self.slots.lock().unwrap().get(key).cloned()?;
        let running = slot.running.lock().unwrap().clone();
        running
    }

    /// Sends one prompt to the session `key`, starting its agent if need be,
    /// and waits for the turn to end. Progress arrives at `sink` as events.
    ///
    /// Only this session's own turns wait for each other. Another session's
    /// prompt, and this session's permission answers and cancel, go through
    /// while the turn runs.
    pub async fn prompt(
        &self,
        sink: &Sink,
        key: &str,
        profile: &AgentProfile,
        launch: &Launch,
        text: String,
    ) -> Result<AcpOutcome, String> {
        let slot = self.slot(key);
        let _turn = slot.turn.lock().await;

        // An n8n node has no process to keep: each turn is one call, and
        // cancel aborts it.
        if profile.protocol == Protocol::N8n {
            let call = tokio::spawn(crate::n8n::prompt(sink.clone(), key.to_string(), profile.clone(), launch.clone(), text));
            self.calls.lock().unwrap().insert(key.to_string(), call.abort_handle());
            let ended = call.await;
            self.calls.lock().unwrap().remove(key);
            return match ended {
                Ok(result) => result,
                Err(e) if e.is_cancelled() => Ok(AcpOutcome { stop_reason: "cancelled".into(), ..Default::default() }),
                Err(e) => Err(e.to_string()),
            };
        }

        let current = slot.running.lock().unwrap().clone();
        let fresh = current
            .as_ref()
            .map(|r| r.profile == *profile && r.launch == *launch && r.alive.load(Ordering::Relaxed))
            .unwrap_or(false);
        let running = match (fresh, current) {
            (true, Some(running)) => running,
            (_, stale) => {
                if let Some(old) = stale {
                    slot.running.lock().unwrap().take();
                    stop(&old).await;
                }
                let started = Arc::new(start(&self.opener, sink, key, profile, launch).await?);
                *slot.running.lock().unwrap() = Some(started.clone());
                started
            }
        };

        match running.profile.protocol {
            Protocol::Codex => return crate::codex::prompt(&running, text, TURN_TIMEOUT).await,
            Protocol::Claude => return crate::claude::prompt(&running, text, TURN_TIMEOUT).await,
            Protocol::Agy => return crate::agy::prompt(&running, text, TURN_TIMEOUT).await,
            Protocol::N8n | Protocol::Acp => {}
        }
        let result = request(
            &running,
            "session/prompt",
            json!({
                "sessionId": running.session_id,
                "prompt": [{ "type": "text", "text": text }],
            }),
            TURN_TIMEOUT,
        )
        .await?;
        // Copilot reports the session's running total at the end of each
        // turn, not the turn's own: what is new since the last report goes on.
        if let Some(u) = result.get("usage").filter(|u| u.is_object()) {
            let usage = crate::usage::from_acp(&running_model(profile, launch), u);
            for new in running.usage.advance(vec![usage]) {
                sink(Event::Usage(new));
            }
        }
        Ok(AcpOutcome {
            stop_reason: result
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn")
                .to_string(),
            ..Default::default()
        })
    }

    /// Answers the agent's permission request with one of its options.
    pub async fn answer_permission(&self, key: &str, request_id: Value, option_id: Option<String>) -> Result<(), String> {
        let running = self.running(key).ok_or_else(not_running)?;
        let reply = match running.profile.protocol {
            Protocol::Codex => crate::codex::permission_reply(&request_id, option_id.as_deref()),
            Protocol::Claude => crate::claude::permission_reply(&running.claude, &request_id, option_id.as_deref()),
            // agy's requests wait at the team's gate, not on its connection.
            Protocol::Agy => return Err(tr!("Antigravity 的請求在團隊的關卡回答。", "Antigravity's requests are answered at the team's gate.")),
            Protocol::N8n => return Err(not_running()),
            Protocol::Acp => permission_reply(&request_id, option_id.as_deref()),
        };
        write_line(&running.writer, &reply).await
    }

    /// Interrupts the current turn.
    pub async fn cancel(&self, key: &str) -> Result<(), String> {
        if let Some(call) = self.calls.lock().unwrap().remove(key) {
            call.abort();
            return Ok(());
        }
        let running = self.running(key).ok_or_else(not_running)?;
        match running.profile.protocol {
            Protocol::Codex => return crate::codex::cancel(&running).await,
            Protocol::Claude => return crate::claude::cancel(&running).await,
            Protocol::Agy => return crate::agy::cancel(&running).await,
            Protocol::N8n | Protocol::Acp => {}
        }
        notify(&running.writer, "session/cancel", json!({ "sessionId": running.session_id })).await
    }

    /// Whether the session's agent is up.
    #[cfg(test)]
    pub fn is_running(&self, key: &str) -> bool {
        self.running(key).map(|r| r.alive.load(Ordering::Relaxed)).unwrap_or(false)
    }

    /// A fresh start: the process goes, the next prompt starts a new session.
    pub async fn reset(&self, key: &str) {
        if let Some(call) = self.calls.lock().unwrap().remove(key) {
            call.abort();
        }
        let slot = self.slots.lock().unwrap().get(key).cloned();
        let old = slot.and_then(|s| s.running.lock().unwrap().take());
        if let Some(old) = old {
            stop(&old).await;
            log::line(format!("acp {key}: reset"));
        }
    }

    /// The models an agent offers, for the drop-down beside a team member.
    /// Codex and Claude Code are asked (a handshake, no prompt: nothing is
    /// spent); Copilot CLI on its own endpoint lists what the endpoint has.
    pub async fn models(&self, profile: &AgentProfile) -> Result<Vec<ModelChoice>, String> {
        // A workflow has no list: what is typed goes to it as `model`.
        if profile.protocol == Protocol::N8n {
            return Ok(Vec::new());
        }
        if profile.protocol == Protocol::Acp {
            return copilot_models(profile).await;
        }
        if profile.protocol == Protocol::Agy {
            let exe = resolve_agent_exe(&profile.command).ok_or_else(|| -> String {
                let command = &profile.command;
                tr!(format!("在 PATH 上找不到「{command}」。"), format!("'{command}' was not found on PATH."))
            })?;
            return crate::agy::models(&exe.to_string_lossy()).await;
        }
        let nowhere: Sink = Arc::new(|_| {});
        let running = start(&self.opener, &nowhere, &format!("models:{}", profile.id), profile, &Launch::default()).await?;
        let listed = match profile.protocol {
            Protocol::Claude => Ok(running.claude.models.lock().unwrap().clone()),
            _ => request(&running, "model/list", json!({}), SETUP_TIMEOUT).await.map(|v| {
                v.get("data")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter(|m| !m.get("hidden").and_then(Value::as_bool).unwrap_or(false))
                            .filter_map(|m| {
                                let id = m.get("id").and_then(Value::as_str)?.to_string();
                                let label = m.get("displayName").and_then(Value::as_str).unwrap_or(&id).to_string();
                                Some(ModelChoice { id, label })
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            }),
        };
        stop(&running).await;
        listed
    }

    /// The settings window's "Test": start, handshake, report, stop.
    pub async fn test(&self, profile: &AgentProfile) -> Result<String, String> {
        if profile.protocol == Protocol::N8n {
            return crate::n8n::test(profile).await;
        }
        let nowhere: Sink = Arc::new(|_| {});
        let running = start(&self.opener, &nowhere, &format!("test:{}", profile.id), profile, &Launch::default()).await?;
        stop(&running).await;
        if running.claude.signed_out.load(Ordering::SeqCst) {
            return Err(crate::claude::signed_out());
        }
        // A handshake spends nothing and says nothing about the model. On an
        // endpoint of its own, the model Copilot will ask for has to be one
        // the endpoint lets this key use: its list says so, still for free.
        if profile.protocol == Protocol::Acp && profile.env.contains_key("COPILOT_PROVIDER_BASE_URL") {
            let model = running_model(profile, &Launch::default());
            if let Ok(offered) = copilot_models(profile).await {
                if let Some(problem) = unoffered(&model, &offered) {
                    return Err(problem);
                }
            }
        }
        let name = &profile.name;
        Ok(tr!(format!("{name} 回應了連線，也開好了工作階段。"), format!("{name} answered the handshake and opened a session.")))
    }

    /// Every session goes, all at once: each gets its moment to close
    /// properly side by side, not one after another — an agent in the middle
    /// of a turn rarely lets go by itself, and the app is quitting.
    pub async fn shutdown(&self) {
        for (_, call) in self.calls.lock().unwrap().drain() {
            call.abort();
        }
        let slots: Vec<Arc<Slot>> = self.slots.lock().unwrap().drain().map(|(_, s)| s).collect();
        let mut going = tokio::task::JoinSet::new();
        for slot in slots {
            let old = slot.running.lock().unwrap().take();
            if let Some(old) = old {
                going.spawn(async move { stop(&old).await });
            }
        }
        while going.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// A real Copilot agent from Settings (Steven's cg): does a session get
    /// the team's MCP server started? Opens a session, sends no prompt.
    /// `cargo test -p coucou the_real_copilot_starts -- --ignored`.
    #[test]
    fn usage_without_a_model_is_named_after_the_model_really_running() {
        // TXCDeep: a model field, and a COPILOT_MODEL left over from the cg preset.
        let mut cg = AgentProfile::copilot();
        cg.model = "deepseek-ai/DeepSeek-V4.1-Flash".into();
        cg.env.insert("COPILOT_MODEL".into(), "glm-5.3-flash".into());
        // The model field the person can see is what runs, not the leftover.
        assert_eq!(running_model(&cg, &Launch::default()), "deepseek-ai/DeepSeek-V4.1-Flash");
        // A member's own model is set last of all.
        let member = Launch { model: Some("minimax-m2.7".into()), ..Launch::default() };
        assert_eq!(running_model(&cg, &member), "minimax-m2.7");
        // A team agent's own model is its profile's model field.
        let team_agent = AgentProfile { model: "TXC-LLM-Reasoning".into(), ..cg.clone() };
        assert_eq!(running_model(&team_agent, &Launch::default()), "TXC-LLM-Reasoning");
        // With no model field, COPILOT_MODEL stands in (the cg presets).
        cg.model.clear();
        assert_eq!(running_model(&cg, &Launch::default()), "glm-5.3-flash");
        cg.env.clear();
        assert_eq!(running_model(&cg, &Launch::default()), "");
    }

    #[test]
    fn a_model_the_endpoint_does_not_list_for_the_key_is_caught_by_the_test() {
        let offered: Vec<ModelChoice> = ["TXC-LLM-Reasoning", "deepseek-ai/DeepSeek-V4.1-Flash"].iter().map(|id| ModelChoice { id: id.to_string(), label: id.to_string() }).collect();
        let problem = unoffered("glm-5.3-flash", &offered).expect("a model the key may not use");
        assert!(problem.contains("glm-5.3-flash") && problem.contains("TXC-LLM-Reasoning") && problem.contains("401"), "{problem}");
        assert!(unoffered("deepseek-ai/deepseek-v4.1-flash", &offered).is_none());
        // Nothing to judge by: no complaint.
        assert!(unoffered("", &offered).is_none());
        assert!(unoffered("glm-5.3-flash", &[]).is_none());
    }

    #[test]
    fn an_agent_is_cloud_unless_it_is_set_local_runs_on_a_local_endpoint_or_is_an_n8n_node() {
        let mut cg = AgentProfile::copilot();
        assert_eq!(cg.location(), Location::Cloud);
        for local in ["http://localhost:11434/v1", "http://127.0.0.1:8080", "https://192.168.1.20/v1", "http://10.0.0.5:4000", "http://172.20.1.1", "http://[::1]:1234/v1", "http://gpu-box.lan/v1"] {
            cg.env.insert("COPILOT_PROVIDER_BASE_URL".into(), local.into());
            assert_eq!(cg.location(), Location::Local, "{local}");
        }
        for cloud in ["https://llm-share.duotify.com/v1", "https://172.32.0.1", "https://api.openai.com/v1", "https://user@10.example.com"] {
            cg.env.insert("COPILOT_PROVIDER_BASE_URL".into(), cloud.into());
            assert_eq!(cg.location(), Location::Cloud, "{cloud}");
        }
        // What the person chose wins over the guess…
        cg.location = Some(Location::Local);
        assert_eq!(cg.location(), Location::Local);
        // …but an n8n node is always local.
        let node = AgentProfile { protocol: Protocol::N8n, location: Some(Location::Cloud), ..Default::default() };
        assert_eq!(node.location(), Location::Local);
        // Older settings without the field still load.
        let old: AgentProfile = serde_json::from_str(r#"{"id":"c","name":"C","command":"claude","protocol":"claude"}"#).unwrap();
        assert_eq!((old.location, old.location()), (None, Location::Cloud));
        let saved = serde_json::to_value(&node).unwrap();
        assert_eq!((saved["protocol"].as_str(), saved["location"].as_str()), (Some("n8n"), Some("cloud")));
    }

    #[test]
    #[ignore]
    fn the_real_copilot_starts_the_team_s_server() {
        let profile = crate::settings::load()
            .agents
            .into_iter()
            .find(|a| a.protocol == Protocol::Acp && a.command == "copilot")
            .expect("a Copilot agent in Settings");
        let (dir, marker, server) = stand_in::team_server("copilot");
        let up = std::path::PathBuf::from(format!("{}.up", marker.display()));
        let _ = std::fs::remove_file(&up);
        let launch = Launch {
            cwd: Some(dir.to_string_lossy().to_string()),
            mcp_servers: vec![server],
            auto: Some(Scope::new(&dir)),
            ..Launch::default()
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let nowhere: Sink = Arc::new(|_| {});
            let opener: Opener = Arc::new(spawn_agent);
            let running = start(&opener, &nowhere, "test:copilot-mcp", &profile, &launch).await.expect("a session");
            for _ in 0..200 {
                if up.is_file() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            stop(&running).await;
        });
        assert!(up.is_file(), "Copilot never started the team's MCP server");
    }

    /// A real turn on that Copilot: it calls a team tool, nobody is asked.
    /// Spends one short turn of its provider.
    /// `cargo test -p coucou the_real_copilot_calls -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_copilot_calls_the_team_s_tools_without_asking() {
        let profile = crate::settings::load()
            .agents
            .into_iter()
            .find(|a| a.protocol == Protocol::Acp && a.command == "copilot")
            .expect("a Copilot agent in Settings");
        let (dir, marker, server) = stand_in::team_server("copilot-call");
        let said = Arc::new(Mutex::new(String::new()));
        let asked = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink: Sink = {
            let said = said.clone();
            let asked = asked.clone();
            Arc::new(move |event| match event {
                Event::Update(u) => {
                    if u.update["sessionUpdate"] == "agent_message_chunk" {
                        if let Some(t) = u.update.pointer("/content/text").and_then(Value::as_str) {
                            said.lock().unwrap().push_str(t);
                        }
                    }
                }
                Event::Permission(p) => asked.lock().unwrap().push(p.title),
                Event::Exit(_) | Event::Usage(_) | Event::Refused(_) => {}
            })
        };
        let launch = Launch {
            cwd: Some(dir.to_string_lossy().to_string()),
            mcp_servers: vec![server],
            auto: Some(Scope::new(&dir)),
            ..Launch::default()
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let agents = Agents::default();
        let outcome = runtime.block_on(agents.prompt(
            &sink,
            "test:copilot-call",
            &profile,
            &launch,
            "Call the `team_status` tool of the coucou-team MCP server once, then reply with the word it gives you and nothing else.".into(),
        ));
        runtime.block_on(agents.shutdown());
        assert!(outcome.is_ok(), "{outcome:?}");
        assert!(asked.lock().unwrap().is_empty(), "a person was asked: {:?}", asked.lock().unwrap());
        assert!(marker.is_file(), "the tool was never called; Copilot said: {}", said.lock().unwrap());
        assert!(said.lock().unwrap().contains("PAPAYA"), "Copilot said: {}", said.lock().unwrap());
    }

    /// What the scripted agents saw and how many were started.
    #[derive(Default)]
    struct Seen {
        started: AtomicU64,
        new_sessions: Mutex<Vec<Value>>,
    }

    /// An agent on the other end of a pipe. It answers the handshake, and for
    /// every prompt asks permission to run the prompt's text as a command,
    /// then reports which option it was given and ends the turn.
    fn scripted(seen: Arc<Seen>) -> Opener {
        Arc::new(move |_profile, _launch| {
            let (ours, theirs) = tokio::io::duplex(64 * 1024);
            let (reader, writer) = tokio::io::split(ours);
            let seen = seen.clone();
            let number = seen.started.fetch_add(1, Ordering::Relaxed) + 1;
            tokio::spawn(async move {
                let (read, mut write) = tokio::io::split(theirs);
                let mut lines = BufReader::new(read).lines();
                let mut asked: HashMap<u64, Value> = HashMap::new();
                let mut next_ask = 900u64;
                while let Ok(Some(line)) = lines.next_line().await {
                    let msg: Value = serde_json::from_str(&line).unwrap();
                    let mut out = Vec::new();
                    match msg.get("method").and_then(Value::as_str) {
                        Some("initialize") => out.push(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {
                            "protocolVersion": 1, "agentCapabilities": {}, "agentInfo": { "name": "scripted" } } })),
                        Some("session/new") => {
                            seen.new_sessions.lock().unwrap().push(msg["params"].clone());
                            out.push(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "sessionId": format!("s{number}") } }));
                        }
                        Some("session/prompt") => {
                            let command = msg["params"]["prompt"][0]["text"].as_str().unwrap().to_string();
                            asked.insert(next_ask, msg["id"].clone());
                            out.push(json!({ "jsonrpc": "2.0", "id": next_ask, "method": "session/request_permission", "params": {
                                "sessionId": format!("s{number}"),
                                "toolCall": { "toolCallId": "t", "title": format!("Run {command}"), "kind": "execute", "rawInput": { "command": command } },
                                "options": [
                                    { "optionId": "yes", "name": "Allow", "kind": "allow_once" },
                                    { "optionId": "forever", "name": "Always", "kind": "allow_always" },
                                    { "optionId": "no", "name": "Reject", "kind": "reject_once" },
                                ] } }));
                            next_ask += 1;
                        }
                        Some(_) => {}
                        // Our answer to its permission request.
                        None => {
                            let ask = msg["id"].as_u64().unwrap();
                            let prompt_id = asked.remove(&ask).unwrap();
                            let given = msg["result"]["outcome"]["optionId"].as_str().unwrap_or("cancelled").to_string();
                            out.push(json!({ "jsonrpc": "2.0", "method": "session/update", "params": {
                                "sessionId": format!("s{number}"),
                                "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": given } } } }));
                            out.push(json!({ "jsonrpc": "2.0", "id": prompt_id, "result": { "stopReason": "end_turn" } }));
                        }
                    }
                    for reply in out {
                        write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                    }
                }
            });
            Ok(Transport { reader: Box::new(reader), writer: Box::new(writer), child: None })
        })
    }

    #[derive(Default)]
    struct Heard(Mutex<Vec<Event>>);

    impl Heard {
        fn sink(self: &Arc<Self>) -> Sink {
            let heard = self.clone();
            Arc::new(move |e| heard.0.lock().unwrap().push(e))
        }

        fn permissions(&self) -> Vec<AcpPermission> {
            self.0.lock().unwrap().iter().filter_map(|e| match e { Event::Permission(p) => Some(p.clone()), _ => None }).collect()
        }

        /// What each session's agent said it was given, by key.
        fn given(&self, key: &str) -> Vec<String> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    Event::Update(u) if u.agent_id == key => u.update["content"]["text"].as_str().map(str::to_string),
                    _ => None,
                })
                .collect()
        }

        fn refused(&self) -> Vec<Refusal> {
            self.0.lock().unwrap().iter().filter_map(|e| match e { Event::Refused(r) => Some(r.clone()), _ => None }).collect()
        }

        async fn wait_for_permissions(&self, count: usize) -> Vec<AcpPermission> {
            for _ in 0..400 {
                let got = self.permissions();
                if got.len() >= count {
                    return got;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            panic!("only {} of {count} permission requests arrived", self.permissions().len());
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async { tokio::time::timeout(Duration::from_secs(10), future).await.expect("the test hung") })
    }

    fn fixture() -> (Arc<Agents>, Arc<Seen>, Arc<Heard>) {
        let seen = Arc::new(Seen::default());
        (Arc::new(Agents::with_opener(scripted(seen.clone()))), seen, Arc::new(Heard::default()))
    }

    fn turn(agents: &Arc<Agents>, heard: &Arc<Heard>, key: &str, launch: Launch, text: &str) -> tokio::task::JoinHandle<Result<AcpOutcome, String>> {
        let (agents, sink, key, text) = (agents.clone(), heard.sink(), key.to_string(), text.to_string());
        tokio::spawn(async move { agents.prompt(&sink, &key, &AgentProfile::copilot(), &launch, text).await })
    }

    #[test]
    fn two_sessions_work_at_once_and_a_permission_is_answered_mid_turn() {
        run(async {
            let (agents, _, heard) = fixture();
            let a = turn(&agents, &heard, "a", Launch::default(), "npm test");
            let b = turn(&agents, &heard, "b", Launch::default(), "npm run build");

            // Both turns are open at once, each waiting on its own request.
            let asked = heard.wait_for_permissions(2).await;
            for p in asked.iter().rev() {
                agents.answer_permission(&p.agent_id, p.request_id.clone(), Some("yes".into())).await.unwrap();
            }
            assert_eq!(a.await.unwrap().unwrap().stop_reason, "end_turn");
            assert_eq!(b.await.unwrap().unwrap().stop_reason, "end_turn");
            assert_eq!(heard.given("a"), vec!["yes"]);
            assert_eq!(heard.given("b"), vec!["yes"]);
        });
    }

    #[test]
    fn one_profile_runs_as_many_sessions_as_it_is_asked_for() {
        run(async {
            let (agents, seen, heard) = fixture();
            let first = turn(&agents, &heard, "team:shop:ai3", Launch::default(), "ls");
            let second = turn(&agents, &heard, "team:shop:ai4", Launch::default(), "ls");
            for p in heard.wait_for_permissions(2).await {
                agents.answer_permission(&p.agent_id, p.request_id, Some("yes".into())).await.unwrap();
            }
            first.await.unwrap().unwrap();
            second.await.unwrap().unwrap();
            assert_eq!(seen.started.load(Ordering::Relaxed), 2);
            assert!(agents.is_running("team:shop:ai3") && agents.is_running("team:shop:ai4"));
            assert!(!agents.is_running("copilot"));

            // A second turn on the same session reuses its agent.
            let again = turn(&agents, &heard, "team:shop:ai3", Launch::default(), "ls");
            let p = heard.wait_for_permissions(3).await.pop().unwrap();
            agents.answer_permission(&p.agent_id, p.request_id, None).await.unwrap();
            again.await.unwrap().unwrap();
            assert_eq!(seen.started.load(Ordering::Relaxed), 2);
            assert_eq!(heard.given("team:shop:ai3"), vec!["yes", "cancelled"]);
        });
    }

    #[test]
    fn a_session_is_given_its_folder_and_its_mcp_servers() {
        run(async {
            let (agents, seen, heard) = fixture();
            let launch = Launch {
                cwd: Some(r"D:\Work\shop".into()),
                mcp_servers: vec![McpServer {
                    name: "coucou-team".into(),
                    command: r"C:\bin\coucou-team-mcp.exe".into(),
                    args: vec!["--member".into(), "ai3".into()],
                    env: BTreeMap::from([("COUCOU_TEAM".to_string(), "shop".to_string())]),
                    url: String::new(),
                }],
                ..Launch::default()
            };
            let t = turn(&agents, &heard, "m", launch, "ls");
            let p = heard.wait_for_permissions(1).await.pop().unwrap();
            agents.answer_permission("m", p.request_id, Some("yes".into())).await.unwrap();
            t.await.unwrap().unwrap();

            let new = seen.new_sessions.lock().unwrap()[0].clone();
            assert_eq!(new["cwd"], r"D:\Work\shop");
            // Copilot starts none of the session's servers; they went on its
            // command line instead (see copilot_mcp_file).
            assert_eq!(new["mcpServers"], json!([]));
        });
    }

    #[test]
    fn copilot_is_given_its_servers_in_its_own_configuration_format() {
        let server = McpServer {
            name: "coucou-team".into(),
            command: r"C:\bin\coucou-team-mcp.exe".into(),
            args: vec!["--member".into(), "ai3".into()],
            env: BTreeMap::from([("COUCOU_TEAM".to_string(), "shop".to_string())]),
            url: String::new(),
        };
        let file = copilot_mcp_file(std::slice::from_ref(&server)).unwrap();
        let config: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            config,
            json!({ "mcpServers": { "coucou-team": { "type": "local", "command": r"C:\bin\coucou-team-mcp.exe",
                "args": ["--member", "ai3"], "env": { "COUCOU_TEAM": "shop" }, "tools": ["*"] } } })
        );
        // The same servers, the same file.
        assert_eq!(copilot_mcp_file(&[server]).unwrap(), file);
        assert!(runs_copilot(&AgentProfile::copilot()));
        assert!(!runs_copilot(&AgentProfile { command: "gemini".into(), ..AgentProfile::copilot() }));
    }

    #[test]
    fn the_rules_answer_what_they_can_and_the_rest_reaches_a_person() {
        run(async {
            let (agents, _, heard) = fixture();
            let member = Launch { cwd: Some(r"D:\Work\shop".into()), auto: Some(Scope::new(r"D:\Work\shop")), ..Launch::default() };

            // Everyday work: allowed once, no card.
            turn(&agents, &heard, "m", member.clone(), "npm test").await.unwrap().unwrap();
            assert!(heard.permissions().is_empty());
            assert_eq!(heard.given("m"), vec!["yes"]);

            // Removing a folder: the card, with the reason, and the person's answer.
            let risky = turn(&agents, &heard, "m", member.clone(), "rm -rf dist");
            let p = heard.wait_for_permissions(1).await.pop().unwrap();
            assert_eq!(p.danger, Some(Danger::DeletesFolder));
            assert_eq!(p.raw_input["command"], "rm -rf dist");
            agents.answer_permission("m", p.request_id, Some("no".into())).await.unwrap();
            risky.await.unwrap().unwrap();
            assert_eq!(heard.given("m"), vec!["yes", "no"]);
        });
    }

    /// The constitution before the session's rules: what it forbids is
    /// refused with no card; what it asks about is a card even where the
    /// rules would let it through.
    #[test]
    fn the_constitution_refuses_what_it_forbids_and_asks_about_what_it_names() {
        let mut rules = crate::constitution::Constitution::starting();
        rules.rules.push(crate::constitution::Rule {
            id: "mine".into(),
            text: "跑測試前要問我".into(),
            level: crate::constitution::Level::Ask,
            check: String::new(),
            patterns: vec!["npm test".into()],
        });
        crate::constitution::for_tests(rules);
        run(async {
            let (agents, _, heard) = fixture();
            let dir = r"D:\Work\constitution-test";
            let member = Launch { cwd: Some(dir.into()), auto: Some(Scope::new(dir)), ..Launch::default() };

            turn(&agents, &heard, "m", member.clone(), "Remove-Item -Recurse -Force .git").await.unwrap().unwrap();
            assert!(heard.permissions().is_empty(), "no card for what is forbidden");
            assert_eq!(heard.given("m"), vec!["no"]);
            let refused = heard.refused();
            assert_eq!(refused.len(), 1);
            assert!(refused[0].rule.contains(".git"));

            // Even without the session's rules (逐步確認), it is never put to the person.
            turn(&agents, &heard, "plain", Launch { cwd: Some(dir.into()), ..Launch::default() }, "format D: /q").await.unwrap().unwrap();
            assert!(heard.permissions().is_empty());
            assert_eq!(heard.given("plain"), vec!["no"]);

            // Asked about: a card naming the rule, though the session's rules would allow it.
            let asked = turn(&agents, &heard, "m", member.clone(), "npm test");
            let p = heard.wait_for_permissions(1).await.pop().unwrap();
            assert_eq!(p.rule.as_deref(), Some("跑測試前要問我"));
            agents.answer_permission("m", p.request_id, Some("yes".into())).await.unwrap();
            asked.await.unwrap().unwrap();
        });
    }

    #[test]
    fn a_session_without_rules_asks_a_person_every_time() {
        run(async {
            let (agents, _, heard) = fixture();
            let t = turn(&agents, &heard, "copilot", Launch::default(), "npm test");
            let p = heard.wait_for_permissions(1).await.pop().unwrap();
            assert_eq!(p.danger, None);
            agents.answer_permission("copilot", p.request_id, Some("yes".into())).await.unwrap();
            t.await.unwrap().unwrap();
        });
    }

    #[test]
    fn a_changed_launch_starts_the_session_afresh() {
        run(async {
            let (agents, seen, heard) = fixture();
            let member = Launch { auto: Some(Scope::new(r"D:\Work\shop")), ..Launch::default() };
            turn(&agents, &heard, "m", member.clone(), "npm test").await.unwrap().unwrap();
            turn(&agents, &heard, "m", member, "npm test").await.unwrap().unwrap();
            assert_eq!(seen.started.load(Ordering::Relaxed), 1);

            let moved = Launch { auto: Some(Scope::new(r"D:\Work\other")), ..Launch::default() };
            turn(&agents, &heard, "m", moved, "npm test").await.unwrap().unwrap();
            assert_eq!(seen.started.load(Ordering::Relaxed), 2);

            agents.reset("m").await;
            assert!(!agents.is_running("m"));
        });
    }
}

/// For the tests that run a real agent: a folder to work in, and the smallest
/// MCP server under the team server's name — one tool, `team_status`, that
/// leaves a file behind when called and answers with the word PAPAYA.
#[cfg(test)]
pub(crate) mod stand_in {
    use super::{McpServer, TEAM_SERVER};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    const SERVER: &str = r#"import sys, json
marker = sys.argv[1]
for line in sys.stdin:
    msg = json.loads(line)
    mid = msg.get("id")
    if mid is None:
        continue
    method = msg.get("method")
    if method == "initialize":
        open(marker + ".up", "w").write("up")
        r = {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "coucou-team", "version": "0"}}
    elif method == "tools/list":
        r = {"tools": [{"name": "team_status", "description": "Where the team stands.", "inputSchema": {"type": "object", "properties": {}}}]}
    elif method == "tools/call":
        open(marker, "w").write("called")
        r = {"content": [{"type": "text", "text": "The team is ready. The word is PAPAYA."}], "isError": False}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "not offered"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": r}), flush=True)
"#;

    /// (work folder, the file a call leaves, the server).
    pub fn team_server(agent: &str) -> (PathBuf, PathBuf, McpServer) {
        let dir = std::env::temp_dir().join(format!("coucou-{agent}-mcp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("called.txt");
        let _ = std::fs::remove_file(&marker);
        let script = dir.join("team.py");
        std::fs::write(&script, SERVER).unwrap();
        let server = McpServer {
            name: TEAM_SERVER.into(),
            command: "python".into(),
            args: vec![script.to_string_lossy().to_string(), marker.to_string_lossy().to_string()],
            env: BTreeMap::new(),
            url: String::new(),
        };
        (dir, marker, server)
    }
}
