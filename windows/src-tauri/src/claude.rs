// Claude Code as an agent the island and a team can drive.
//
// Claude Code has no ACP either. It has the protocol the Claude Agent SDK
// speaks to it: `claude -p --input-format stream-json --output-format
// stream-json`, one JSON message per line each way, and with
// `--permission-prompt-tool stdio` it asks its host — us — before a tool
// that needs permission. This file translates that into what acp.rs already
// does for every agent:
//
//   handshake   a `control_request` "initialize"; its answer lists the
//               models this login can use
//   one turn    a `user` message in; the turn is over at the `result`
//   progress    `assistant` messages: their text, and each `tool_use`
//   permission  `control_request` "can_use_tool", answered allow (with the
//               input handed back unchanged) or deny — by the session's rules
//               when they allow it, otherwise by a person on the card
//   interrupt   a `control_request` "interrupt"
//
// The shapes were checked against Claude Code 2.1 on this machine.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::acp::{self, AcpOutcome, AcpPermission, AcpUpdate, Event, Launch, McpServer, Route, Running};
use crate::log;
use crate::policy::{self, Kind, Verdict};

/// A model an agent offers, for the drop-down next to a member.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub id: String,
    pub label: String,
    /// What the agent itself says the model takes, when it says (Codex's `inputModalities`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    /// The reasoning efforts it offers (Codex's `supportedReasoningEfforts`); empty when unsaid.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
    /// The agent's own default.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub default: bool,
}

#[derive(Default)]
pub struct ClaudeState {
    /// Settled by the `result` that ends a turn.
    done: Mutex<Option<oneshot::Sender<Result<String, String>>>>,
    /// Our own control requests, waiting for their `control_response`.
    control: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    /// Permission requests on a card: an allow must hand the input back.
    asked: Mutex<HashMap<String, Value>>,
    next: AtomicU64,
    pub models: Mutex<Vec<ModelChoice>>,
    /// The message being written was already shown piece by piece.
    streamed: AtomicBool,
    /// Claude Code has no login and no key: every turn would fail.
    pub signed_out: AtomicBool,
    /// `modelUsage` so far: each result carries the session's running totals.
    usage: crate::usage::Totals,
}

/// Said instead of starting a turn that cannot run. (Teamwork recognises the
/// English text in older logs; keep its first sentence as it is.)
pub fn signed_out() -> String {
    tr!(
        "Claude Code 還沒登入。請打開終端機執行 `claude`，再用 /login 登入。",
        "Claude Code is not signed in. Open a terminal, run `claude`, and sign in with /login."
    )
}

fn went_away() -> String {
    tr!("Claude Code 已經結束了。", "Claude Code went away.")
}

/// A step's title on the island and in the team's monitor.
pub(crate) fn run_title(command: &str) -> String {
    tr!(format!("執行 {command}"), format!("Run {command}"))
}

pub(crate) fn edit_title(paths: &str) -> String {
    tr!(format!("編輯 {paths}"), format!("Edit {paths}"))
}

/// What the driver adds to the profile's own arguments: the protocol, the
/// permission route, the model and the session's MCP servers.
pub fn args(model: Option<&str>, servers: &[McpServer]) -> Vec<String> {
    let mut out: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        "default",
        // Text as it is written, not a whole message at the end.
        "--include-partial-messages",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
        out.push("--model".into());
        out.push(m.trim().to_string());
    }
    if !servers.is_empty() {
        let mut map = serde_json::Map::new();
        for s in servers {
            let entry = if s.is_remote() {
                json!({ "type": "http", "url": s.url.trim() })
            } else {
                json!({ "type": "stdio", "command": s.command, "args": s.args, "env": s.env })
            };
            map.insert(s.name.clone(), entry);
        }
        out.push("--mcp-config".into());
        out.push(json!({ "mcpServers": map }).to_string());
    }
    out
}

async fn control(running: &Running, request: Value, timeout: Duration) -> Result<Value, String> {
    let id = format!("coucou-{}", running.claude.next.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = oneshot::channel();
    running.claude.control.lock().unwrap().insert(id.clone(), tx);
    let line = json!({ "type": "control_request", "request_id": id, "request": request }).to_string();
    acp::write_line(&running.writer, &line).await?;
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(v)) => {
            if v.get("subtype").and_then(Value::as_str) == Some("error") {
                Err(v.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| tr!("Claude Code 拒絕了這個請求。", "Claude Code refused the request.")))
            } else {
                Ok(v.get("response").cloned().unwrap_or(Value::Null))
            }
        }
        Ok(Err(_)) => Err(went_away()),
        Err(_) => {
            running.claude.control.lock().unwrap().remove(&id);
            Err(tr!(
                "Claude Code 沒有及時回應。如果這台電腦還沒用過它，請先在終端機執行一次 `claude` 登入。",
                "Claude Code did not answer in time. If it has never been used here, run `claude` once in a terminal to log in."
            ))
        }
    }
}

/// The handshake. Its answer lists the models this login can use.
pub async fn setup(running: &mut Running, key: &str, launch: &Launch, timeout: Duration) -> Result<(), String> {
    let init = control(running, json!({ "subtype": "initialize", "hooks": null }), timeout).await?;
    let models: Vec<ModelChoice> = init
        .get("models")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m.get("value").and_then(Value::as_str)?.to_string();
                    let name = m.get("displayName").and_then(Value::as_str).unwrap_or(&id).to_string();
                    let resolved = m.get("resolvedModel").and_then(Value::as_str).unwrap_or("");
                    let label = if resolved.is_empty() || resolved == id { name } else { format!("{name} ({resolved})") };
                    Some(ModelChoice { id, label, ..Default::default() })
                })
                .collect()
        })
        .unwrap_or_default();
    *running.claude.models.lock().unwrap() = models;
    // Its models are listed either way; its turns need an account or a key.
    let signed_out = init.pointer("/account/tokenSource").and_then(Value::as_str) == Some("none");
    running.claude.signed_out.store(signed_out, Ordering::SeqCst);
    running.session_id = "claude".into();
    log::line(format!(
        "claude {key}: ready ({} MCP server(s), {})",
        launch.mcp_servers.len(),
        if launch.auto.is_some() { "rules answer permissions" } else { "a person answers permissions" },
    ));
    Ok(())
}

pub async fn prompt(running: &Running, text: String, timeout: Duration) -> Result<AcpOutcome, String> {
    if running.claude.signed_out.load(Ordering::SeqCst) {
        return Err(signed_out());
    }
    let (tx, rx) = oneshot::channel();
    *running.claude.done.lock().unwrap() = Some(tx);
    let line = json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        "parent_tool_use_id": null,
        "session_id": "",
    })
    .to_string();
    if let Err(e) = acp::write_line(&running.writer, &line).await {
        running.claude.done.lock().unwrap().take();
        return Err(e);
    }
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result.map(|stop_reason| AcpOutcome { stop_reason, ..Default::default() }),
        Ok(Err(_)) => Err(went_away()),
        Err(_) => Err(tr!("Claude Code 沒有及時完成這一輪。", "Claude Code did not finish the turn in time.")),
    }
}

pub async fn cancel(running: &Running) -> Result<(), String> {
    let id = format!("coucou-{}", running.claude.next.fetch_add(1, Ordering::Relaxed));
    let line = json!({ "type": "control_request", "request_id": id, "request": { "subtype": "interrupt" } }).to_string();
    acp::write_line(&running.writer, &line).await
}

/// The person's answer to a card: allow hands the tool its input back.
// i18n: model-facing (the deny message is Claude Code's)
pub fn permission_reply(state: &crate::claude::ClaudeState, request_id: &Value, option_id: Option<&str>) -> String {
    let id = request_id.as_str().unwrap_or_default().to_string();
    let input = state.asked.lock().unwrap().remove(&id).unwrap_or_else(|| json!({}));
    let decision = match option_id {
        Some("allow") => json!({ "behavior": "allow", "updatedInput": input }),
        _ => json!({ "behavior": "deny", "message": "The user declined this." }),
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": id, "response": decision } }).to_string()
}

/// A request the constitution forbids: refused, with the rule, so Claude Code knows why.
// i18n: model-facing
fn refusal_reply(state: &crate::claude::ClaudeState, request_id: &str, rule: &str) -> String {
    state.asked.lock().unwrap().remove(request_id);
    let decision = json!({ "behavior": "deny", "message": format!("Refused by the user's constitution: {rule}. Do not try this again; find another way or tell the leader.") });
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": decision } }).to_string()
}

fn private_reply(state: &crate::claude::ClaudeState, request_id: &str) -> String {
    state.asked.lock().unwrap().remove(request_id);
    let decision = json!({ "behavior": "deny", "message": crate::policy::PRIVATE_REFUSAL });
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": decision } }).to_string()
}

fn options() -> Vec<Value> {
    vec![
        json!({ "optionId": "allow", "name": "Allow", "kind": "allow_once" }),
        json!({ "optionId": "deny", "name": "Deny", "kind": "reject_once" }),
    ]
}

/// A Claude Code tool call as a permission request the rules can judge.
pub fn request_of(tool: &str, input: &Value) -> (policy::Request, String, &'static str) {
    let text = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let request = |kind, command: Option<String>, paths: Vec<String>| policy::Request { kind, command, paths };
    match tool {
        "Bash" | "PowerShell" => {
            let command = text("command");
            (request(Kind::Execute, Some(command.clone()), vec![]), run_title(&command), "execute")
        }
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let path = [text("file_path"), text("notebook_path")].into_iter().find(|p| !p.is_empty()).unwrap_or_default();
            let paths = if path.is_empty() { vec![] } else { vec![path.clone()] };
            (request(Kind::Edit, None, paths), edit_title(&path), "edit")
        }
        // Where it reads, so a private folder is seen (policy::Private); reading is allowed anywhere else.
        "Read" | "Glob" | "Grep" | "LS" => {
            let paths: Vec<String> = [text("file_path"), text("path")].into_iter().filter(|p| !p.is_empty()).collect();
            (request(Kind::Read, None, paths), tool.to_string(), "read")
        }
        "WebFetch" | "WebSearch" => (request(Kind::Fetch, None, vec![]), tool.to_string(), "fetch"),
        // Bookkeeping that changes nothing outside the conversation, and the
        // team's own tools.
        "TodoWrite" | "Task" | "Agent" | "ExitPlanMode" | "EnterPlanMode" => (request(Kind::Think, None, vec![]), tool.to_string(), "think"),
        t if t.starts_with("mcp__coucou-team__") => (request(Kind::Think, None, vec![]), t.trim_start_matches("mcp__coucou-team__").to_string(), "other"),
        other => (request(Kind::Other, None, vec![]), other.to_string(), "other"),
    }
}

fn update(route: &Route, update: Value) {
    (route.sink)(Event::Update(AcpUpdate { agent_id: route.key.clone(), update }));
}

/// One line from Claude Code.
pub async fn dispatch(route: &Route, state: &ClaudeState, msg: Value) {
    let key = &route.key;
    match msg.get("type").and_then(Value::as_str).unwrap_or("") {
        "control_response" => {
            let response = msg.get("response").cloned().unwrap_or(Value::Null);
            let id = response.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
            if let Some(tx) = state.control.lock().unwrap().remove(&id) {
                let _ = tx.send(response);
            }
        }
        "control_request" => {
            let id = msg.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
            let request = msg.get("request").cloned().unwrap_or(Value::Null);
            if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
                // Hooks and SDK-side MCP servers are not ours to answer.
                let reply = json!({ "type": "control_response", "response": { "subtype": "error", "request_id": id, "error": "not offered by this host" } });
                let _ = acp::write_line(&route.writer, &reply.to_string()).await;
                return;
            }
            let tool = request.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
            let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
            let (asked, title, kind) = request_of(&tool, &input);
            state.asked.lock().unwrap().insert(id.clone(), input.clone());

            // A team's private documents: refused, and nobody is asked.
            if route.private.touches(&asked, &route.work_dir) {
                log::line(format!("claude {key}: {tool} refused — the team's private knowledge base"));
                let _ = acp::write_line(&route.writer, &private_reply(state, &id)).await;
                return;
            }
            // The constitution first: refused here, or asked for whatever the rules say.
            let ruled = crate::constitution::rule_for_in(&asked, &route.work_dir, route.auto.as_ref());
            if let Some((crate::constitution::Level::Never, rule)) = &ruled {
                log::line(format!("claude {key}: {tool} refused by the constitution — {}", rule.text));
                let _ = acp::write_line(&route.writer, &refusal_reply(state, &id, &rule.text)).await;
                (route.sink)(Event::Refused(acp::Refusal { agent_id: key.clone(), title, rule: rule.text.clone() }));
                return;
            }
            let mut rule_id = ruled.as_ref().map(|(_, r)| r.id.clone());
            let rule = ruled.map(|(_, r)| r.text);
            let mut danger = None;
            if let Some(scope) = route.auto.as_ref().filter(|_| rule.is_none()) {
                match policy::decide(scope, &asked) {
                    Verdict::Allow => {
                        log::line(format!("claude {key}: {tool} allowed by the rules"));
                        let reply = permission_reply(state, &json!(id), Some("allow"));
                        let _ = acp::write_line(&route.writer, &reply).await;
                        return;
                    }
                    Verdict::Ask(why) => {
                        log::line(format!("claude {key}: {tool} waits for a person — {why:?}"));
                        danger = Some(why);
                        rule_id = rule_id.or_else(|| policy::check_of(why).map(str::to_string));
                    }
                }
            } else {
                log::line(format!("claude {key}: permission asked for {tool}"));
            }
            (route.sink)(Event::Permission(AcpPermission {
                agent_id: key.clone(),
                request_id: json!(id),
                title,
                kind: kind.to_string(),
                raw_input: input,
                options: options(),
                danger,
                rule_id,
                rule,
            }));
        }
        // A sub-agent of Claude Code's own (the Task tool) speaks under its
        // parent's tool call; the member's screen shows that call, not its chatter.
        "stream_event" | "assistant" | "user" if msg.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) => {}
        "stream_event" => {
            let delta = msg.pointer("/event/delta").cloned().unwrap_or(Value::Null);
            let (kind, text) = match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => ("agent_message_chunk", delta.get("text")),
                Some("thinking_delta") => ("agent_thought_chunk", delta.get("thinking")),
                _ => return,
            };
            let text = text.and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                state.streamed.store(true, Ordering::SeqCst);
                update(route, json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } }));
            }
        }
        "assistant" => {
            // Its text was shown as it was written, unless this Claude Code
            // does not stream: then it is shown whole, now.
            let streamed = state.streamed.swap(false, Ordering::SeqCst);
            let content = msg.get("message").and_then(|m| m.get("content")).and_then(Value::as_array).cloned().unwrap_or_default();
            for block in content {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") if !streamed => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            update(route, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } }));
                        }
                    }
                    Some("tool_use") => {
                        let tool = block.get("name").and_then(Value::as_str).unwrap_or("");
                        let id = block.get("id").cloned().unwrap_or(Value::Null);
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        let (_, title, kind) = request_of(tool, &input);
                        update(
                            route,
                            json!({ "sessionUpdate": "tool_call", "toolCallId": id, "title": title, "kind": kind, "status": "in_progress", "rawInput": input }),
                        );
                    }
                    _ => {}
                }
            }
        }
        // What the tools gave back.
        "user" => {
            let content = msg.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default();
            for block in content.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
                let id = block.get("tool_use_id").cloned().unwrap_or(Value::Null);
                let failed = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                let text = match block.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(parts)) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
                    _ => String::new(),
                };
                let mut out = json!({ "sessionUpdate": "tool_call_update", "toolCallId": id, "status": if failed { "failed" } else { "completed" } });
                if !text.is_empty() {
                    out["content"] = json!([{ "type": "content", "content": { "type": "text", "text": text } }]);
                }
                update(route, out);
            }
        }
        "result" => {
            // What this turn used: the running totals by model, less what was reported before.
            if let Some(mu) = msg.get("modelUsage").filter(|m| m.is_object()) {
                for u in state.usage.advance(crate::usage::from_claude_model_usage(mu)) {
                    (route.sink)(Event::Usage(u));
                }
            }
            let failed = msg.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let subtype = msg.get("subtype").and_then(Value::as_str).unwrap_or("success");
            let outcome = if failed || subtype != "success" {
                let text = msg.get("result").and_then(Value::as_str).unwrap_or("");
                Err(if text.is_empty() { tr!(format!("Claude Code 停下來了：{subtype}"), format!("Claude Code stopped: {subtype}")) } else { text.to_string() })
            } else {
                Ok("end_turn".to_string())
            };
            if let Some(tx) = state.done.lock().unwrap().take() {
                let _ = tx.send(outcome);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::{AgentProfile, Agents, Opener, Protocol, Sink, Transport};
    use crate::policy::{Danger, Scope};
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn claude_profile() -> AgentProfile {
        AgentProfile {
            id: "claude".into(),
            name: "Claude Code".into(),
            command: "claude".into(),
            args: vec![],
            env: BTreeMap::new(),
            cwd: String::new(),
            protocol: Protocol::Claude,
            model: String::new(),
            ..Default::default()
        }
    }

    #[test]
    fn the_driver_asks_for_the_sdk_protocol_the_model_and_the_team_tools() {
        let args = args(
            Some("sonnet"),
            &[McpServer { name: "coucou-team".into(), command: r"C:\bin\coucou-team-mcp.exe".into(), args: vec![], env: BTreeMap::from([("COUCOU_TEAM".to_string(), "shop".to_string())]), url: String::new() }],
        );
        let joined = args.join(" ");
        assert!(joined.starts_with("-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio"));
        assert!(joined.contains("--model sonnet"));
        let config: Value = serde_json::from_str(args.last().unwrap()).unwrap();
        assert_eq!(config["mcpServers"]["coucou-team"]["command"], r"C:\bin\coucou-team-mcp.exe");
        assert_eq!(config["mcpServers"]["coucou-team"]["env"]["COUCOU_TEAM"], "shop");
        assert!(!super::args(None, &[]).contains(&"--model".to_string()));
    }

    #[test]
    fn claude_s_tools_are_read_the_way_the_rules_expect() {
        assert_eq!(request_of("Bash", &json!({ "command": "rm -rf dist" })).0.command.as_deref(), Some("rm -rf dist"));
        assert_eq!(request_of("Write", &json!({ "file_path": "src/a.ts" })).0.paths, vec!["src/a.ts".to_string()]);
        assert_eq!(request_of("Read", &json!({})).0.kind, Kind::Read);
        assert_eq!(request_of("mcp__coucou-team__deliver", &json!({})).0.kind, Kind::Think);
        assert_eq!(request_of("mcp__other__thing", &json!({})).0.kind, Kind::Other);
    }

    /// A real turn: Claude Code calls a team tool through the rules (no card),
    /// its words arrive as they are written, and the tool's result comes
    /// back. Spends one short turn. `cargo test -p coucou claude_calls -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_claude_code_calls_the_team_s_tools_and_streams() {
        let (dir, marker, server) = crate::acp::stand_in::team_server("claude");
        let heard = Arc::new(Mutex::new(Vec::<Value>::new()));
        let asked = Arc::new(Mutex::new(0));
        let sink: Sink = {
            let heard = heard.clone();
            let asked = asked.clone();
            Arc::new(move |event| match event {
                Event::Update(u) => heard.lock().unwrap().push(u.update),
                Event::Permission(_) => *asked.lock().unwrap() += 1,
                Event::Exit(_) | Event::Usage(_) | Event::Refused(_) => {}
            })
        };
        let launch = Launch {
            cwd: Some(dir.to_string_lossy().to_string()),
            mcp_servers: vec![server],
            auto: Some(Scope::new(&dir)),
            model: Some("haiku".into()),
            ..Launch::default()
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let agents = Agents::default();
        let outcome = runtime.block_on(agents.prompt(
            &sink,
            "test:claude-mcp",
            &claude_profile(),
            &launch,
            "Call the `team_status` tool of the coucou-team MCP server once, then tell me in one short sentence the word it gave you.".into(),
        ));
        runtime.block_on(agents.shutdown());
        let heard = heard.lock().unwrap();
        let said: String = heard.iter().filter(|u| u["sessionUpdate"] == "agent_message_chunk").filter_map(|u| u["content"]["text"].as_str()).collect();
        assert!(outcome.is_ok(), "{outcome:?}");
        assert!(marker.is_file(), "the tool was never called; Claude said: {said}");
        assert!(said.contains("PAPAYA"), "Claude said: {said}");
        let pieces = heard.iter().filter(|u| u["sessionUpdate"] == "agent_message_chunk").count();
        assert!(pieces > 1, "the words came whole, not as they were written");
        assert!(heard.iter().any(|u| u["sessionUpdate"] == "tool_call_update" && u["status"] == "completed"), "no tool result: {heard:?}");
        assert_eq!(*asked.lock().unwrap(), 0, "a person was asked");
    }

    /// Claude Code on the other end of a pipe: each user message makes it
    /// ask to run the message as a command, say what it was told, and end.
    fn scripted() -> Opener {
        Arc::new(|_profile, _launch| {
            let (ours, theirs) = tokio::io::duplex(64 * 1024);
            let (reader, writer) = tokio::io::split(ours);
            tokio::spawn(async move {
                let (read, mut write) = tokio::io::split(theirs);
                let mut lines = BufReader::new(read).lines();
                let mut asked = 0;
                while let Ok(Some(line)) = lines.next_line().await {
                    let msg: Value = serde_json::from_str(&line).unwrap();
                    let mut out = Vec::new();
                    match msg["type"].as_str().unwrap() {
                        "control_request" if msg["request"]["subtype"] == "initialize" => out.push(json!({
                            "type": "control_response",
                            "response": { "subtype": "success", "request_id": msg["request_id"], "response": {
                                "models": [{ "value": "sonnet", "resolvedModel": "claude-sonnet-5-5", "displayName": "Sonnet" }] } } })),
                        "user" => {
                            asked += 1;
                            let command = msg["message"]["content"][0]["text"].as_str().unwrap().to_string();
                            out.push(json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t", "name": "Bash", "input": { "command": command } }] } }));
                            out.push(json!({ "type": "control_request", "request_id": format!("cli-{asked}"), "request": {
                                "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": command } } }));
                        }
                        "control_response" => {
                            let decision = msg["response"]["response"]["behavior"].as_str().unwrap().to_string();
                            // An allow carries the input back unchanged.
                            if decision == "allow" {
                                assert!(msg["response"]["response"]["updatedInput"]["command"].is_string());
                            }
                            out.push(json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": decision }] } }));
                            // modelUsage holds the session's running totals.
                            out.push(json!({ "type": "result", "subtype": "success", "is_error": false, "result": "done", "total_cost_usd": 0.1 * asked as f64,
                                "modelUsage": { "claude-sonnet-5-5": { "inputTokens": 100 * asked, "outputTokens": 10 * asked, "cacheReadInputTokens": 500 * asked, "cacheCreationInputTokens": 0, "costUSD": 0.1 * asked as f64 } } }));
                        }
                        _ => {}
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
    fn a_claude_turn_runs_and_its_permissions_go_through_the_rules() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let agents = Arc::new(Agents::with_opener(scripted()));
            let heard = Arc::new(Mutex::new(Vec::<Event>::new()));
            let sink: Sink = {
                let heard = heard.clone();
                Arc::new(move |e| heard.lock().unwrap().push(e))
            };
            let said = |heard: &Arc<Mutex<Vec<Event>>>| -> Vec<String> {
                heard
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|e| match e {
                        Event::Update(u) if u.update["sessionUpdate"] == "agent_message_chunk" => u.update["content"]["text"].as_str().map(str::to_string),
                        _ => None,
                    })
                    .collect()
            };
            let member = Launch { auto: Some(Scope::new(r"D:\Work\shop")), ..Launch::default() };

            let done = agents.prompt(&sink, "m", &claude_profile(), &member, "npm test".into()).await.unwrap();
            assert_eq!(done.stop_reason, "end_turn");
            assert_eq!(said(&heard), vec!["allow"]);
            assert!(heard.lock().unwrap().iter().any(|e| matches!(e, Event::Update(u) if u.update["title"] == "Run npm test")));

            let turn = {
                let (agents, sink, member) = (agents.clone(), sink.clone(), member.clone());
                tokio::spawn(async move { agents.prompt(&sink, "m", &claude_profile(), &member, "rm -rf dist".into()).await })
            };
            let card = loop {
                let found = heard.lock().unwrap().iter().find_map(|e| match e {
                    Event::Permission(p) => Some(p.clone()),
                    _ => None,
                });
                if let Some(p) = found {
                    break p;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            assert_eq!(card.danger, Some(Danger::DeletesFolder));
            agents.answer_permission("m", card.request_id, Some("deny".into())).await.unwrap();
            turn.await.unwrap().unwrap();
            assert_eq!(said(&heard), vec!["allow", "deny"]);
            // Two turns: each reports what it added to the running totals.
            let used: Vec<crate::usage::Usage> = heard.lock().unwrap().iter().filter_map(|e| match e { Event::Usage(u) => Some(u.clone()), _ => None }).collect();
            assert_eq!(used.len(), 2);
            assert!(used.iter().all(|u| u.model == "claude-sonnet-5-5" && u.input == 100 && u.cache_read == 500 && u.output == 10));
            assert!((used[1].cost_usd.unwrap() - 0.1).abs() < 1e-9);

            // The handshake's model list is what the drop-down offers.
            let listed = agents.models(&claude_profile()).await.unwrap();
            assert_eq!(listed, vec![ModelChoice { id: "sonnet".into(), label: "Sonnet (claude-sonnet-5-5)".into(), ..Default::default() }]);
        });
    }

    /// The real Claude Code: the handshake only, so no tokens are spent.
    /// `cargo test -p coucou claude -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_claude_code_shakes_hands_and_lists_its_models() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let models = runtime.block_on(Agents::default().models(&claude_profile()));
        let models = models.expect("handshake");
        assert!(models.iter().any(|m| m.id == "sonnet" || m.id == "opus"), "{models:?}");
    }
}
