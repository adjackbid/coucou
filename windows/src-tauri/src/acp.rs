// Agent Client Protocol client — the island driving a coding agent it started
// itself (`copilot --acp --stdio`, or anything else that speaks ACP).
//
// JSON-RPC 2.0, one message per line, over the child's stdin/stdout. We are
// the client: we send `initialize`, `session/new` and `session/prompt`; the
// agent streams `session/update` notifications (text chunks, tool calls) and
// may ask us `session/request_permission`, which the island answers from its
// approval card. Everything the agent says is forwarded to the island as
// events; the one response the agent waits on from a human is routed back
// through `answer_permission`.
//
// One agent process per profile, started on the first prompt and kept until
// the profile is reset, the app quits, or the process dies.

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::island::WINDOW_LABEL;
use crate::log;
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

/// A coding agent the island can start and talk to over ACP.
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

// ── What the island hears ─────────────────────────────────────────────────────

/// A `session/update` from the agent, as the island receives it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AcpUpdate {
    pub agent_id: String,
    pub update: Value,
}

/// A `session/request_permission` the island must answer.
#[derive(Serialize, Clone)]
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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AcpOutcome {
    pub stop_reason: String,
}

// ── The running agent ─────────────────────────────────────────────────────────

struct Running {
    profile: AgentProfile,
    child: Child,
    stdin: Arc<AsyncMutex<ChildStdin>>,
    session_id: String,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    next_id: Arc<AtomicU64>,
}

/// Every agent the island has started, by profile id.
#[derive(Default)]
pub struct Agents {
    running: AsyncMutex<HashMap<String, Running>>,
}

fn find_on_path(stem: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(stem);
    if p.is_absolute() && p.is_file() {
        return Some(p.to_path_buf());
    }
    crate::find_on_path(stem)
}

/// Stops the agent and everything under it. An npm shim is a tree —
/// `copilot.cmd` → cmd.exe → node → copilot.exe — and killing the child we
/// spawned leaves the real agent running, so the whole tree goes.
async fn stop(child: &mut Child) {
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

/// Starts the agent, runs `initialize` and `session/new`, and keeps it.
async fn start(app: &AppHandle, profile: &AgentProfile) -> Result<Running, String> {
    let exe = find_on_path(&profile.command)
        .ok_or_else(|| format!("'{}' was not found on PATH.", profile.command))?;
    let secret = secrets::get(&profile.secret_key()).unwrap_or_default();
    let cwd = profile.working_dir();
    if !cwd.is_dir() {
        return Err(format!("The folder {} does not exist.", cwd.display()));
    }

    let mut cmd = Command::new(&exe);
    cmd.args(&profile.args)
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
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", exe.display()))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stdin = Arc::new(AsyncMutex::new(stdin));
    let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> = Default::default();
    let next_id = Arc::new(AtomicU64::new(1));

    // The reader: responses settle the pending requests, notifications go to
    // the island, and the agent's own requests to us are answered here.
    {
        let app = app.clone();
        let pending = pending.clone();
        let stdin = stdin.clone();
        let agent_id = profile.id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                dispatch(&app, &agent_id, &pending, &stdin, msg).await;
            }
            log::line(format!("acp {agent_id}: agent closed its output"));
            let _ = app.emit_to(WINDOW_LABEL, "acp-exit", agent_id.clone());
            // Nobody will answer what is still pending.
            pending.lock().unwrap().clear();
        });
    }

    let mut running = Running {
        profile: profile.clone(),
        child,
        stdin,
        session_id: String::new(),
        pending,
        next_id,
    };

    let init = request(
        &running,
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

    let session = request(
        &running,
        "session/new",
        json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
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
        "acp {}: {agent_name} session {} in {}",
        profile.id,
        running.session_id,
        cwd.display()
    ));
    Ok(running)
}

/// Sends a request and waits for its response.
async fn request(running: &Running, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let id = running.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    running.pending.lock().unwrap().insert(id, tx);
    let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
    write_line(&running.stdin, &line).await?;
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The agent went away.".into()),
        Err(_) => {
            running.pending.lock().unwrap().remove(&id);
            Err(format!("The agent did not answer {method} in time."))
        }
    }
}

async fn notify(stdin: &Arc<AsyncMutex<ChildStdin>>, method: &str, params: Value) -> Result<(), String> {
    let line = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
    write_line(stdin, &line).await
}

async fn write_line(stdin: &Arc<AsyncMutex<ChildStdin>>, line: &str) -> Result<(), String> {
    let mut w = stdin.lock().await;
    w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    w.write_all(b"\n").await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())
}

/// One line from the agent.
async fn dispatch(
    app: &AppHandle,
    agent_id: &str,
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    stdin: &Arc<AsyncMutex<ChildStdin>>,
    msg: Value,
) {
    let method = msg.get("method").and_then(Value::as_str);
    let id = msg.get("id").cloned();

    match (method, id) {
        // A response to one of ours.
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
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
        // A notification: progress for the island.
        (Some("session/update"), None) => {
            let update = msg.get("params").and_then(|p| p.get("update")).cloned().unwrap_or(Value::Null);
            let _ = app.emit_to(WINDOW_LABEL, "acp-update", AcpUpdate { agent_id: agent_id.into(), update });
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
                    log::line(format!("acp {agent_id}: permission asked for {kind}: {title}"));
                    let _ = app.emit_to(
                        WINDOW_LABEL,
                        "acp-permission",
                        AcpPermission {
                            agent_id: agent_id.into(),
                            request_id: id,
                            title,
                            kind,
                            raw_input: tool.get("rawInput").cloned().unwrap_or(Value::Null),
                            options,
                        },
                    );
                }
                // We declared no fs or terminal capability; a well-behaved
                // agent never asks. Say no rather than hang it.
                _ => {
                    let reply = json!({
                        "jsonrpc": "2.0", "id": id,
                        "error": { "code": -32601, "message": format!("{method} is not offered by this client") },
                    });
                    let _ = write_line(stdin, &reply.to_string()).await;
                }
            }
        }
        (None, None) => {}
    }
}

// ── Entry points (the Tauri commands call these) ──────────────────────────────

impl Agents {
    /// Sends one prompt to the profile's agent, starting it if need be, and
    /// waits for the turn to end. Progress arrives as `acp-update` events.
    pub async fn prompt(&self, app: &AppHandle, profile: &AgentProfile, text: String) -> Result<AcpOutcome, String> {
        let mut map = self.running.lock().await;
        let stale = match map.get_mut(&profile.id) {
            Some(r) => r.profile != *profile || r.child.try_wait().map(|s| s.is_some()).unwrap_or(true),
            None => true,
        };
        if stale {
            if let Some(mut old) = map.remove(&profile.id) {
                stop(&mut old.child).await;
            }
            map.insert(profile.id.clone(), start(app, profile).await?);
        }
        let running = map.get(&profile.id).unwrap();
        let result = request(
            running,
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
    pub async fn answer_permission(&self, agent_id: &str, request_id: Value, option_id: Option<String>) -> Result<(), String> {
        let map = self.running.lock().await;
        let running = map.get(agent_id).ok_or("that agent is not running")?;
        let outcome = match option_id {
            Some(id) => json!({ "outcome": "selected", "optionId": id }),
            None => json!({ "outcome": "cancelled" }),
        };
        let reply = json!({ "jsonrpc": "2.0", "id": request_id, "result": { "outcome": outcome } });
        write_line(&running.stdin, &reply.to_string()).await
    }

    /// Interrupts the current turn.
    pub async fn cancel(&self, agent_id: &str) -> Result<(), String> {
        let map = self.running.lock().await;
        let running = map.get(agent_id).ok_or("that agent is not running")?;
        notify(&running.stdin, "session/cancel", json!({ "sessionId": running.session_id })).await
    }

    /// A fresh start: the process goes, the next prompt starts a new session.
    pub async fn reset(&self, agent_id: &str) {
        let mut map = self.running.lock().await;
        if let Some(mut old) = map.remove(agent_id) {
            stop(&mut old.child).await;
            log::line(format!("acp {agent_id}: reset"));
        }
    }

    /// The settings window's "Test": start, handshake, report, stop.
    pub async fn test(&self, app: &AppHandle, profile: &AgentProfile) -> Result<String, String> {
        let mut running = start(app, profile).await?;
        stop(&mut running.child).await;
        Ok(format!("{} answered the handshake and opened a session.", profile.name))
    }

    pub async fn shutdown(&self) {
        let mut map = self.running.lock().await;
        for (_, mut r) in map.drain() {
            stop(&mut r.child).await;
        }
    }
}
