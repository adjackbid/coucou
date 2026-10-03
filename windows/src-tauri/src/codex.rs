// Codex as an agent the island and a team can drive.
//
// Codex does not speak the Agent Client Protocol; it has its own, the "app
// server": JSON-RPC 2.0, one message per line on stdio, run with
// `codex app-server`. The shape is close enough that it shares everything
// else in acp.rs — the process, the lock per session, the sink, the
// permission rules. This file is only the translation:
//
//   handshake   `initialize`, then `initialized`, then `thread/start`
//   one turn    `turn/start`, which answers at once; the turn is over when
//               the `turn/completed` notification for it arrives
//   progress    `item/started` (a command, a file change, an MCP call) and
//               `item/agentMessage/delta`, passed on as ACP-shaped updates
//   permission  `item/commandExecution/requestApproval` and
//               `item/fileChange/requestApproval`, answered `accept` or
//               `decline` — by the session's rules when they allow it,
//               otherwise by a person on the card
//   interrupt   `turn/interrupt`
//
// The message shapes were read off `codex app-server generate-ts` (Codex CLI
// 0.153). Everything this client does not take part in is declined, so Codex
// never waits on us for an answer.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::acp::{self, AcpOutcome, AcpPermission, AcpUpdate, Event, Launch, McpServer, Route, Running};
use crate::log;
use crate::policy::{self, Kind, Verdict};

/// What a Codex session keeps between messages.
#[derive(Default)]
pub struct CodexState {
    pub thread: Mutex<String>,
    /// The turn under way, for `turn/interrupt`.
    turn: Mutex<Option<String>>,
    /// Settled by `turn/completed`: the stop reason, or why the turn failed.
    done: Mutex<Option<oneshot::Sender<Result<String, String>>>>,
    /// The files each file-change item touches, from `item/started`: an
    /// approval request names only the item.
    edits: Mutex<HashMap<String, Vec<String>>>,
}

/// A TOML basic string, for `-c key=value` overrides.
fn toml_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A session's MCP servers as Codex configuration overrides. Codex reads
/// them from its config, not from the thread, so they go on the command line.
pub fn mcp_args(servers: &[McpServer]) -> Vec<String> {
    let mut out = Vec::new();
    for s in servers {
        let key = format!("mcp_servers.{}", s.name);
        out.push("-c".into());
        out.push(format!("{key}.command={}", toml_str(&s.command)));
        out.push("-c".into());
        out.push(format!("{key}.args=[{}]", s.args.iter().map(|a| toml_str(a)).collect::<Vec<_>>().join(", ")));
        if !s.env.is_empty() {
            let env: Vec<String> = s.env.iter().map(|(k, v)| format!("{}={}", toml_str(k), toml_str(v))).collect();
            out.push("-c".into());
            out.push(format!("{key}.env={{{}}}", env.join(", ")));
        }
    }
    out
}

/// `initialize`, `initialized`, `thread/start`. The thread asks before
/// anything that is not plainly safe ("untrusted"), so every step that
/// matters reaches the rules or the card, and writes stay in the folder.
pub async fn setup(running: &mut Running, key: &str, cwd: &std::path::Path, launch: &Launch, timeout: Duration) -> Result<(), String> {
    acp::request(
        running,
        "initialize",
        json!({
            "clientInfo": { "name": "coucou", "title": "Coucou", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": null,
        }),
        timeout,
    )
    .await?;
    acp::notify(&running.writer, "initialized", json!({})).await?;
    let started = acp::request(
        running,
        "thread/start",
        json!({ "cwd": cwd.to_string_lossy(), "approvalPolicy": "untrusted", "sandbox": "workspace-write" }),
        timeout,
    )
    .await
    .map_err(|e| {
        if e.to_lowercase().contains("auth") || e.to_lowercase().contains("login") {
            "Codex wants to be logged in: run `codex login` in a terminal.".to_string()
        } else {
            e
        }
    })?;
    let thread = started
        .get("thread")
        .and_then(|t| t.get("id"))
        .and_then(Value::as_str)
        .ok_or("thread/start returned no thread id")?
        .to_string();
    *running.codex.thread.lock().unwrap() = thread.clone();
    running.session_id = thread.clone();
    log::line(format!(
        "codex {key}: thread {thread} in {} ({} MCP server(s), {})",
        cwd.display(),
        launch.mcp_servers.len(),
        if launch.auto.is_some() { "rules answer permissions" } else { "a person answers permissions" },
    ));
    Ok(())
}

/// One turn: start it, then wait for Codex to say it is over.
pub async fn prompt(running: &Running, text: String, timeout: Duration) -> Result<AcpOutcome, String> {
    let (tx, rx) = oneshot::channel();
    // Waiting before asking: a short turn can complete before its answer.
    *running.codex.done.lock().unwrap() = Some(tx);
    let thread = running.codex.thread.lock().unwrap().clone();
    let started = acp::request(
        running,
        "turn/start",
        json!({ "threadId": thread, "input": [{ "type": "text", "text": text, "text_elements": [] }] }),
        timeout,
    )
    .await;
    let started = match started {
        Ok(v) => v,
        Err(e) => {
            running.codex.done.lock().unwrap().take();
            return Err(e);
        }
    };
    if let Some(id) = started.get("turn").and_then(|t| t.get("id")).and_then(Value::as_str) {
        *running.codex.turn.lock().unwrap() = Some(id.to_string());
    }
    let outcome = match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Codex went away.".into()),
        Err(_) => Err("Codex did not finish the turn in time.".into()),
    };
    running.codex.turn.lock().unwrap().take();
    outcome.map(|stop_reason| AcpOutcome { stop_reason })
}

/// Interrupts the turn under way, if there is one.
pub async fn cancel(running: &Running) -> Result<(), String> {
    let thread = running.codex.thread.lock().unwrap().clone();
    let Some(turn) = running.codex.turn.lock().unwrap().clone() else { return Ok(()) };
    // Its answer is of no interest; `turn/completed` says the rest.
    let id = running.next_id.fetch_add(1, Ordering::Relaxed);
    let line = json!({ "jsonrpc": "2.0", "id": id, "method": "turn/interrupt", "params": { "threadId": thread, "turnId": turn } }).to_string();
    acp::write_line(&running.writer, &line).await
}

/// The answer to an approval request: the option id is Codex's own word.
pub fn permission_reply(request_id: &Value, option_id: Option<&str>) -> String {
    let decision = match option_id {
        Some("accept") => "accept",
        Some("decline") => "decline",
        _ => "cancel",
    };
    json!({ "jsonrpc": "2.0", "id": request_id, "result": { "decision": decision } }).to_string()
}

/// The two answers a card offers for a Codex request.
fn options() -> Vec<Value> {
    vec![
        json!({ "optionId": "accept", "name": "Allow", "kind": "allow_once" }),
        json!({ "optionId": "decline", "name": "Decline", "kind": "reject_once" }),
    ]
}

fn update(route: &Route, update: Value) {
    (route.sink)(Event::Update(AcpUpdate { agent_id: route.key.clone(), update }));
}

/// The title a step gets on the island and in the team's monitor.
fn title_of(item: &Value) -> Option<(String, &'static str)> {
    let text = |k: &str| item.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match item.get("type").and_then(Value::as_str)? {
        "commandExecution" => Some((format!("Run {}", text("command")), "execute")),
        "fileChange" => {
            let paths: Vec<String> = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|c| c.iter().filter_map(|x| x.get("path").and_then(Value::as_str)).map(str::to_string).collect())
                .unwrap_or_default();
            Some((format!("Edit {}", paths.join(", ")), "edit"))
        }
        "mcpToolCall" => Some((format!("{}.{}", text("server"), text("tool")), "other")),
        "webSearch" => Some(("Search the web".into(), "fetch")),
        "imageGeneration" => Some(("Generate an image".into(), "other")),
        _ => None,
    }
}

/// One line from Codex that is not an answer to one of our requests.
pub async fn dispatch(route: &Route, state: &CodexState, msg: Value) {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let key = &route.key;

    let Some(id) = msg.get("id").cloned() else {
        // A notification.
        match method {
            "item/started" => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("fileChange") {
                    let id = item.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let paths = item
                        .get("changes")
                        .and_then(Value::as_array)
                        .map(|c| c.iter().filter_map(|x| x.get("path").and_then(Value::as_str)).map(str::to_string).collect())
                        .unwrap_or_default();
                    state.edits.lock().unwrap().insert(id, paths);
                }
                if let Some((title, kind)) = title_of(&item) {
                    update(route, json!({ "sessionUpdate": "tool_call", "title": title, "kind": kind, "status": "in_progress" }));
                }
            }
            "item/agentMessage/delta" => {
                let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
                if !delta.is_empty() {
                    update(route, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": delta } }));
                }
            }
            "turn/completed" => {
                let turn = params.get("turn").cloned().unwrap_or(Value::Null);
                let status = turn.get("status").and_then(Value::as_str).unwrap_or("completed");
                let result = match status {
                    "failed" => Err(turn
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Codex reported a failed turn.")
                        .to_string()),
                    "interrupted" => Ok("cancelled".to_string()),
                    _ => Ok("end_turn".to_string()),
                };
                if let Some(tx) = state.done.lock().unwrap().take() {
                    let _ = tx.send(result);
                }
            }
            "error" => log::line(format!("codex {key}: {}", params.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("error"))),
            _ => {}
        }
        return;
    };

    // A request from Codex to us.
    let request = match method {
        "item/commandExecution/requestApproval" => {
            let command = params.get("command").and_then(Value::as_str).unwrap_or("").to_string();
            Some((policy::Request { kind: Kind::Execute, command: Some(command.clone()), paths: vec![] }, format!("Run {command}"), "execute"))
        }
        "item/fileChange/requestApproval" => {
            let item = params.get("itemId").and_then(Value::as_str).unwrap_or("");
            let mut paths = state.edits.lock().unwrap().get(item).cloned().unwrap_or_default();
            // Asking for a whole folder is asking for more than a file.
            if let Some(root) = params.get("grantRoot").and_then(Value::as_str) {
                paths.push(root.to_string());
            }
            let title = format!("Edit {}", if paths.is_empty() { "files".to_string() } else { paths.join(", ") });
            Some((policy::Request { kind: Kind::Edit, command: None, paths }, title, "edit"))
        }
        _ => None,
    };

    let Some((asked, title, kind)) = request else {
        // Nothing else is ours to answer: an MCP server's form is declined,
        // everything else is refused, and Codex carries on without it.
        let reply = if method == "mcpServer/elicitation/request" {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "action": "decline", "content": null, "_meta": null } })
        } else {
            log::line(format!("codex {key}: declined {method}"));
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("{method} is not offered by this client") } })
        };
        let _ = acp::write_line(&route.writer, &reply.to_string()).await;
        return;
    };

    let mut danger = None;
    if let Some(scope) = &route.auto {
        match policy::decide(scope, &asked) {
            Verdict::Allow => {
                log::line(format!("codex {key}: {kind} allowed by the rules"));
                let _ = acp::write_line(&route.writer, &permission_reply(&id, Some("accept"))).await;
                return;
            }
            Verdict::Ask(why) => {
                log::line(format!("codex {key}: {kind} waits for a person — {why:?}"));
                danger = Some(why);
            }
        }
    } else {
        log::line(format!("codex {key}: permission asked for {kind}"));
    }

    let mut raw = json!({});
    if let Some(c) = &asked.command {
        raw["command"] = json!(c);
    }
    if !asked.paths.is_empty() {
        raw["paths"] = json!(asked.paths);
    }
    if let Some(reason) = params.get("reason").and_then(Value::as_str) {
        raw["reason"] = json!(reason);
    }
    (route.sink)(Event::Permission(AcpPermission {
        agent_id: key.clone(),
        request_id: id,
        title,
        kind: kind.to_string(),
        raw_input: raw,
        options: options(),
        danger,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn mcp_servers_become_codex_config_overrides() {
        let args = mcp_args(&[McpServer {
            name: "coucou-team".into(),
            command: r"C:\Users\x\AppData\Local\Coucou\bin\coucou-team-mcp.exe".into(),
            args: vec![],
            env: BTreeMap::from([("COUCOU_TEAM".to_string(), "shop".to_string()), ("COUCOU_MEMBER".to_string(), "ai3".to_string())]),
        }]);
        assert_eq!(
            args,
            vec![
                "-c",
                r#"mcp_servers.coucou-team.command="C:\\Users\\x\\AppData\\Local\\Coucou\\bin\\coucou-team-mcp.exe""#,
                "-c",
                "mcp_servers.coucou-team.args=[]",
                "-c",
                r#"mcp_servers.coucou-team.env={"COUCOU_MEMBER"="ai3", "COUCOU_TEAM"="shop"}"#,
            ]
        );
        assert_eq!(toml_str("a\"b\nc"), r#""a\"b\nc""#);
    }

    #[test]
    fn an_answer_is_codex_s_own_word() {
        let id = json!(7);
        assert!(permission_reply(&id, Some("accept")).contains(r#""decision":"accept""#));
        assert!(permission_reply(&id, Some("decline")).contains(r#""decision":"decline""#));
        assert!(permission_reply(&id, None).contains(r#""decision":"cancel""#));
        assert!(permission_reply(&id, Some("allow_always")).contains(r#""decision":"cancel""#));
    }

    use crate::acp::{AgentProfile, Agents, Opener, Protocol, Sink, Transport};
    use crate::policy::{Danger, Scope};
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn codex_profile() -> AgentProfile {
        AgentProfile {
            id: "codex".into(),
            name: "Codex".into(),
            command: "codex".into(),
            args: vec!["app-server".into()],
            env: BTreeMap::new(),
            cwd: String::new(),
            protocol: Protocol::Codex,
        }
    }

    /// A Codex app server on the other end of a pipe: every turn asks to run
    /// the prompt's text as a command, says which decision it got, and ends.
    fn scripted() -> Opener {
        Arc::new(|_profile, _launch| {
            let (ours, theirs) = tokio::io::duplex(64 * 1024);
            let (reader, writer) = tokio::io::split(ours);
            tokio::spawn(async move {
                let (read, mut write) = tokio::io::split(theirs);
                let mut lines = BufReader::new(read).lines();
                let mut turn = 0;
                while let Ok(Some(line)) = lines.next_line().await {
                    let msg: Value = serde_json::from_str(&line).unwrap();
                    let mut out = Vec::new();
                    match msg.get("method").and_then(Value::as_str) {
                        Some("initialize") => out.push(json!({ "id": msg["id"], "result": { "userAgent": "codex", "codexHome": "x", "platformFamily": "windows", "platformOs": "windows" } })),
                        Some("initialized") => {}
                        Some("thread/start") => {
                            assert_eq!(msg["params"]["approvalPolicy"], "untrusted");
                            out.push(json!({ "id": msg["id"], "result": { "thread": { "id": "th1" } } }));
                        }
                        Some("turn/start") => {
                            turn += 1;
                            let command = msg["params"]["input"][0]["text"].as_str().unwrap().to_string();
                            out.push(json!({ "id": msg["id"], "result": { "turn": { "id": format!("tu{turn}"), "status": "inProgress" } } }));
                            out.push(json!({ "method": "item/started", "params": { "item": { "type": "commandExecution", "id": "i1", "command": command } } }));
                            out.push(json!({ "id": 900 + turn, "method": "item/commandExecution/requestApproval", "params": { "threadId": "th1", "turnId": format!("tu{turn}"), "itemId": "i1", "command": command } }));
                        }
                        Some(_) => {}
                        None => {
                            // Our decision; report it and end the turn.
                            let decision = msg["result"]["decision"].as_str().unwrap().to_string();
                            out.push(json!({ "method": "item/agentMessage/delta", "params": { "delta": decision } }));
                            out.push(json!({ "method": "turn/completed", "params": { "threadId": "th1", "turn": { "id": format!("tu{turn}"), "status": "completed" } } }));
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

    #[test]
    fn a_codex_turn_runs_and_its_approvals_go_through_the_rules() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let agents = Arc::new(Agents::with_opener(scripted()));
            let heard = Arc::new(Mutex::new(Vec::<Event>::new()));
            let sink: Sink = {
                let heard = heard.clone();
                Arc::new(move |e| heard.lock().unwrap().push(e))
            };
            let said = |heard: &Arc<Mutex<Vec<Event>>>| -> Vec<String> {
                heard.lock().unwrap().iter().filter_map(|e| match e {
                    Event::Update(u) if u.update["sessionUpdate"] == "agent_message_chunk" => u.update["content"]["text"].as_str().map(str::to_string),
                    _ => None,
                }).collect()
            };
            let member = Launch { auto: Some(Scope::new(r"D:\Work\shop")), ..Launch::default() };

            // Safe: the rules accept it, and the turn ends on turn/completed.
            let done = agents.prompt(&sink, "m", &codex_profile(), &member, "npm test".into()).await.unwrap();
            assert_eq!(done.stop_reason, "end_turn");
            assert_eq!(said(&heard), vec!["accept"]);
            assert!(heard.lock().unwrap().iter().any(|e| matches!(e, Event::Update(u) if u.update["title"] == "Run npm test")));

            // Dangerous: a card, and the person's answer goes back in Codex's words.
            let turn = {
                let (agents, sink, member) = (agents.clone(), sink.clone(), member.clone());
                tokio::spawn(async move { agents.prompt(&sink, "m", &codex_profile(), &member, "rm -rf dist".into()).await })
            };
            let card = loop {
                let found = heard.lock().unwrap().iter().find_map(|e| match e { Event::Permission(p) => Some(p.clone()), _ => None });
                if let Some(p) = found { break p; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            assert_eq!(card.danger, Some(Danger::DeletesFolder));
            assert_eq!(card.raw_input["command"], "rm -rf dist");
            agents.answer_permission("m", card.request_id, Some("decline".into())).await.unwrap();
            turn.await.unwrap().unwrap();
            assert_eq!(said(&heard), vec!["accept", "decline"]);
        });
    }

    /// The real `codex app-server`: handshake and a thread, no turn (so no
    /// model is called). `cargo test -p coucou codex -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_codex_shakes_hands_and_opens_a_thread() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let said = runtime.block_on(Agents::default().test(&codex_profile()));
        assert!(said.is_ok(), "{said:?}");
    }
}
