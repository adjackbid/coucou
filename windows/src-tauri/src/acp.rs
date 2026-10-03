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
}

/// A coding agent the island can start and talk to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
        }
    }

    pub fn secret_key(&self) -> String {
        format!("agent:{}", self.id)
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

/// An MCP server handed to the agent with its session (stdio transport).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct McpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl McpServer {
    fn to_json(&self) -> Value {
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
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AcpOutcome {
    pub stop_reason: String,
}

#[derive(Clone, Debug)]
pub enum Event {
    Update(AcpUpdate),
    Permission(AcpPermission),
    /// The agent's process is gone; the payload is the session's key.
    Exit(String),
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
    profile: AgentProfile,
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

fn working_dir(profile: &AgentProfile, launch: &Launch) -> std::path::PathBuf {
    match launch.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(cwd) => std::path::PathBuf::from(cwd),
        None => profile.working_dir(),
    }
}

/// Starts the agent's process with its stdin and stdout piped.
fn spawn_agent(profile: &AgentProfile, launch: &Launch) -> Result<Transport, String> {
    let exe = find_on_path(&profile.command)
        .ok_or_else(|| format!("'{}' was not found on PATH.", profile.command))?;
    let secret = secrets::get(&profile.secret_key()).unwrap_or_default();
    let cwd = working_dir(profile, launch);
    if !cwd.is_dir() {
        return Err(format!("The folder {} does not exist.", cwd.display()));
    }

    let mut cmd = Command::new(&exe);
    cmd.args(&profile.args);
    // Codex takes its MCP servers as configuration, not from the thread.
    if profile.protocol == Protocol::Codex {
        cmd.args(crate::codex::mcp_args(&launch.mcp_servers));
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
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", exe.display()))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    Ok(Transport { reader: Box::new(stdout), writer: Box::new(stdin), child: Some(child) })
}

/// Stops the agent and everything under it. An npm shim is a tree —
/// `copilot.cmd` → cmd.exe → node → copilot.exe — and killing the child we
/// spawned leaves the real agent running, so the whole tree goes.
async fn stop(running: &Running) {
    let Some(mut child) = running.child.lock().await.take() else { return };
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
    /// Set for a Codex session: its lines are read by codex.rs.
    codex: Option<Arc<CodexState>>,
}

/// Brings the agent up, runs `initialize` and `session/new`, and keeps it.
async fn start(opener: &Opener, sink: &Sink, key: &str, profile: &AgentProfile, launch: &Launch) -> Result<Running, String> {
    let Transport { reader, writer, child } = opener(profile, launch)?;
    let writer: Writer = Arc::new(AsyncMutex::new(writer));
    let pending: PendingMap = Default::default();
    let alive = Arc::new(AtomicBool::new(true));
    let codex = Arc::new(CodexState::default());

    // The reader: responses settle the pending requests, notifications go to
    // the sink, and the agent's own requests to us are answered here.
    {
        let route = Route {
            sink: sink.clone(),
            key: key.to_string(),
            pending: pending.clone(),
            writer: writer.clone(),
            auto: launch.auto.clone(),
            codex: (profile.protocol == Protocol::Codex).then(|| codex.clone()),
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
    };

    let setup = setup(&mut running, key, profile, launch).await;
    if let Err(err) = setup {
        stop(&running).await;
        return Err(err);
    }
    Ok(running)
}

async fn setup(running: &mut Running, key: &str, profile: &AgentProfile, launch: &Launch) -> Result<(), String> {
    if profile.protocol == Protocol::Codex {
        let cwd = working_dir(profile, launch);
        return crate::codex::setup(running, key, &cwd, launch, SETUP_TIMEOUT).await;
    }
    let init = request(
        running,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "coucou", "title": "Coucou", "version": env!("CARGO_PKG_VERSION") },
        }),
        SETUP_TIMEOUT,
    )
    .await?;
    if let Some(methods) = init.get("authMethods").and_then(Value::as_array) {
        if !methods.is_empty() && init.get("agentCapabilities").is_none() {
            return Err("The agent wants a login first. Run it once in a terminal.".into());
        }
    }
    let agent_name = init
        .get("agentInfo")
        .and_then(|i| i.get("title").or_else(|| i.get("name")))
        .and_then(Value::as_str)
        .unwrap_or("agent")
        .to_string();

    let cwd = working_dir(profile, launch);
    let servers: Vec<Value> = launch.mcp_servers.iter().map(McpServer::to_json).collect();
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
            format!(
                "{agent_name} wants to be logged in: run `{} login` in a terminal, or give the profile the provider environment (BYOK) it needs.",
                profile.command
            )
        } else {
            e
        }
    })?;
    running.session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("session/new returned no sessionId")?
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
        Ok(Err(_)) => Err("The agent went away.".into()),
        Err(_) => {
            running.pending.lock().unwrap().remove(&id);
            Err(format!("The agent did not answer {method} in time."))
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
                    Err(err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("agent error")
                        .to_string())
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
                    let title = tool.get("title").and_then(Value::as_str).unwrap_or("A tool call").to_string();
                    let kind = tool.get("kind").and_then(Value::as_str).unwrap_or("other").to_string();

                    // The session's rules first. Allowed once, never "always":
                    // the next request is judged on its own.
                    let mut danger = None;
                    if let Some(scope) = &route.auto {
                        // The shape of the input, not its content: enough to
                        // see a CLI the rules do not read yet.
                        let fields: Vec<&str> = tool
                            .get("rawInput")
                            .and_then(Value::as_object)
                            .map(|o| o.keys().map(String::as_str).collect())
                            .unwrap_or_default();
                        match policy::decide(scope, &policy::Request::from_acp(&tool)) {
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
                    }));
                }
                // We declared no fs or terminal capability; a well-behaved
                // agent never asks. Say no rather than hang it.
                _ => {
                    let reply = json!({
                        "jsonrpc": "2.0", "id": id,
                        "error": { "code": -32601, "message": format!("{method} is not offered by this client") },
                    });
                    let _ = write_line(&route.writer, &reply.to_string()).await;
                }
            }
        }
        (None, None) => {}
    }
}

// ── Entry points (the Tauri commands and the team orchestrator call these) ────

impl Agents {
    pub fn with_opener(opener: Opener) -> Self {
        Self { slots: Mutex::new(HashMap::new()), opener }
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

        if running.profile.protocol == Protocol::Codex {
            return crate::codex::prompt(&running, text, TURN_TIMEOUT).await;
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
        Ok(AcpOutcome {
            stop_reason: result
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn")
                .to_string(),
        })
    }

    /// Answers the agent's permission request with one of its options.
    pub async fn answer_permission(&self, key: &str, request_id: Value, option_id: Option<String>) -> Result<(), String> {
        let running = self.running(key).ok_or("that agent is not running")?;
        let reply = match running.profile.protocol {
            Protocol::Codex => crate::codex::permission_reply(&request_id, option_id.as_deref()),
            Protocol::Acp => permission_reply(&request_id, option_id.as_deref()),
        };
        write_line(&running.writer, &reply).await
    }

    /// Interrupts the current turn.
    pub async fn cancel(&self, key: &str) -> Result<(), String> {
        let running = self.running(key).ok_or("that agent is not running")?;
        if running.profile.protocol == Protocol::Codex {
            return crate::codex::cancel(&running).await;
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
        let slot = self.slots.lock().unwrap().get(key).cloned();
        let old = slot.and_then(|s| s.running.lock().unwrap().take());
        if let Some(old) = old {
            stop(&old).await;
            log::line(format!("acp {key}: reset"));
        }
    }

    /// The settings window's "Test": start, handshake, report, stop.
    pub async fn test(&self, profile: &AgentProfile) -> Result<String, String> {
        let nowhere: Sink = Arc::new(|_| {});
        let running = start(&self.opener, &nowhere, &format!("test:{}", profile.id), profile, &Launch::default()).await?;
        stop(&running).await;
        Ok(format!("{} answered the handshake and opened a session.", profile.name))
    }

    pub async fn shutdown(&self) {
        let slots: Vec<Arc<Slot>> = self.slots.lock().unwrap().drain().map(|(_, s)| s).collect();
        for slot in slots {
            let old = slot.running.lock().unwrap().take();
            if let Some(old) = old {
                stop(&old).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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
                }],
                ..Launch::default()
            };
            let t = turn(&agents, &heard, "m", launch, "ls");
            let p = heard.wait_for_permissions(1).await.pop().unwrap();
            agents.answer_permission("m", p.request_id, Some("yes".into())).await.unwrap();
            t.await.unwrap().unwrap();

            let new = seen.new_sessions.lock().unwrap()[0].clone();
            assert_eq!(new["cwd"], r"D:\Work\shop");
            assert_eq!(
                new["mcpServers"],
                json!([{ "name": "coucou-team", "command": r"C:\bin\coucou-team-mcp.exe", "args": ["--member", "ai3"],
                         "env": [{ "name": "COUCOU_TEAM", "value": "shop" }] }])
            );
        });
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
