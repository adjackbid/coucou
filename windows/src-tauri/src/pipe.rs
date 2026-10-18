// Named-pipe server for coucou-hook.
//
// `\\.\pipe\coucou-<sid>` — one instance per connection. Every hook event is
// forwarded to the island as a `hook` event. `PermissionRequest` is the only one
// that keeps its connection open: it waits for the island's decision and writes
// it back on the same pipe, which is how approving from the island works.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * coucou-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// What we write back is the bare word `allow` or `deny`. Turning that into the
// documented hookSpecificOutput JSON is coucou-hook's job, so the wire format
// Claude Code expects lives in exactly one place.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::island::WINDOW_LABEL;
use crate::log;

/// Slightly under coucou-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// `\\.\pipe\coucou-<sid>` — must match coucou-hook's `pipe_path()` exactly.
pub fn pipe_name() -> String {
    let key = crate::win_user::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-{key}")
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance also means we refuse to join a pipe somebody else
        // already owns under our name, rather than serving on top of it.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

async fn handle(app: AppHandle, mut pipe: NamedPipeServer) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let agent = payload
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or("claude")
        .to_string();

    // A team member's CLI is the team's to answer, on its own card. The relay
    // is meant to stay silent for it (COUCOU_TEAM in its environment), but a
    // CLI that does not hand that environment on — or an old relay — still
    // calls here. So the folder decides too: anything from the work folder of
    // a team with live agents gets no card and no pill; saying nothing hands
    // the request back to the CLI, which asks the team over its own line.
    if let Some(team) = team_working_in(&app, &payload) {
        let relay = payload.get("relay").and_then(Value::as_str).unwrap_or("old (no stamp)");
        let env = payload.get("team_env").and_then(Value::as_bool).map(|b| if b { "set" } else { "missing" }).unwrap_or("unknown");
        log::line(format!("hook {agent} {event}: from team \"{team}\"'s folder — left to the team (relay {relay}, COUCOU_TEAM {env})"));
        let _ = pipe.disconnect();
        return;
    }

    // The constitution, before the tool runs: what it forbids is refused
    // with its rule, what it asks about is put to the person even where the
    // CLI would not ask. coucou-hook turns the word into the CLI's answer.
    if event == "PreToolUse" {
        if let Some((level, rule)) = crate::constitution::rule_for_hook(&payload) {
            let word = if level == crate::constitution::Level::Never { "refuse" } else { "ask" };
            log::line(format!("hook {agent} PreToolUse: {word} by the constitution — {}", rule.text));
            // i18n: model-facing (the CLI hands the reason to its model)
            let reason = format!("{} (the user's constitution in Agent Center)", rule.text);
            let _ = pipe.write_all(format!("{word}\t{}\n", reason.replace(['\n', '\r', '\t'], " ")).as_bytes()).await;
            let _ = pipe.flush().await;
            payload["constitution"] = json!({ "level": word, "rule": rule.text });
        }
    }

    if event != "PermissionRequest" {
        // The tool and whether a session id came along: enough to see a CLI
        // change its payload shape without dumping the payload itself.
        let tool = payload.get("tool_name").and_then(Value::as_str).unwrap_or("");
        let sid = payload.get("session_id").and_then(Value::as_str).map(|s| s.len()).unwrap_or(0);
        let detail = if tool.is_empty() { String::new() } else { format!(" tool={tool}") };
        log::line(format!("hook {agent} {event}{detail} sid={sid}"));
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
        let _ = pipe.disconnect();
        return;
    }

    // What the constitution forbids is refused here, with no card to click by mistake.
    let ruled = crate::constitution::rule_for_hook(&payload);
    if let Some((crate::constitution::Level::Never, rule)) = &ruled {
        log::line(format!("hook {agent} PermissionRequest refused by the constitution — {}", rule.text));
        // i18n: model-facing (the CLI hands the reason to its model)
        let reason = format!("Refused by the user's constitution in Agent Center: {}", rule.text);
        let _ = pipe.write_all(format!("deny\t{}\n", reason.replace(['\n', '\r', '\t'], " ")).as_bytes()).await;
        let _ = pipe.flush().await;
        let _ = pipe.disconnect();
        return;
    }
    // What it asks about says so on the card.
    if let Some((_, rule)) = ruled {
        payload["constitution"] = json!({ "level": "ask", "rule": rule.text });
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    {
        let pending = app.state::<Pending>();
        pending.0.lock().unwrap().insert(id.clone(), tx);
    }
    payload["request_id"] = json!(id);
    log::line(format!("hook {agent} PermissionRequest id={id}"));
    // Kept for 「Ask」 while the card waits: the request in full, as it came.
    let mut kept = payload.clone();
    kept["agent"] = json!(agent);
    app.state::<crate::explain::Asked>().0.lock().unwrap().insert(id.clone(), kept);
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    let decision = wait_for_decision(&id, &mut rx).await;
    app.state::<Pending>().0.lock().unwrap().remove(&id);
    app.state::<crate::explain::Asked>().0.lock().unwrap().remove(&id);

    // No decision: say nothing at all. coucou-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Coucou were closed.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }
    let _ = pipe.disconnect();
}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!("hook id={id} island never acknowledged — terminal takes over"));
            return None;
        }
    }

    match tokio::time::timeout(DECISION_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            Some(d)
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        _ => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={request_id} — no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={request_id}"));
    send(app, request_id, Reply::Decline, false);
}

/// Called by the island's Allow / Deny buttons. Only ever a bare word: turning
/// it into Claude Code's JSON is coucou-hook's job.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let word = match decision {
        "allow" | "always" => "allow",
        _ => "deny",
    };
    log::line(format!("decision id={request_id} {word}"));
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

/// The team whose live agents work in the folder this hook event came from.
fn team_working_in(app: &AppHandle, payload: &Value) -> Option<String> {
    let cwd = payload.get("cwd").and_then(Value::as_str).filter(|c| !c.trim().is_empty())?;
    let norm = |p: &str| p.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let cwd = norm(cwd);
    let teams = app.try_state::<std::sync::Arc<crate::team::orchestrator::Teams>>()?;
    teams
        .snapshots()
        .into_iter()
        .filter(|s| !s.detached && matches!(s.status, crate::team::state::TeamStatus::Running | crate::team::state::TeamStatus::Paused))
        .find(|s| {
            let dir = norm(&s.work_dir);
            !dir.is_empty() && (cwd == dir || cwd.starts_with(&format!("{dir}\\")))
        })
        .map(|s| s.name)
}
