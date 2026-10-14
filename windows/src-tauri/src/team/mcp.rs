// The team's tools as an MCP server.
//
// A CLI starts MCP servers itself, as child processes on stdio, so the thing
// it starts is `coucou-team-mcp.exe` — a relay with nothing in it. The relay
// opens `\\.\pipe\coucou-team-<sid>`, says which member it speaks for (the
// team, the member and the token it was started with), and from then on
// passes every line through. The server is here, next to the state it works
// on: one JSON-RPC request in, exactly one line out.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

use super::orchestrator::Teams;
use super::tools;
use crate::log;

const PROTOCOL: &str = "2025-06-18";
const MAX_LINE: usize = 1 << 20;

/// Who a relay speaks for: the first line it sends.
#[derive(Debug, Deserialize)]
pub struct Hello {
    pub team: String,
    pub member: String,
    pub token: String,
}

/// `\\.\pipe\coucou-team-<sid>` — must match coucou-team-mcp's own.
pub fn pipe_name() -> String {
    let key = crate::win_user::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-team-{key}")
}

fn result(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

fn tool_result(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// One line from a member's MCP client. `None` for a notification, which
/// gets no answer; anything with an id gets exactly one.
pub fn answer(teams: &Teams, who: &Hello, line: &str) -> Option<String> {
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        return Some(error(&Value::Null, -32700, "That line is not JSON."));
    };
    let id = msg.get("id").filter(|id| !id.is_null())?.clone();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    Some(match msg.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => {
            // Speak the version the client asked for; the three calls used
            // here have not changed between revisions.
            let version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL);
            result(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "coucou-team", "title": "Coucou team", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "The tools of your Coucou team: report on your task, hand in results, message teammates. Your teammates only see what goes through these tools.",
                }),
            )
        }
        "ping" => result(&id, json!({})),
        "tools/list" => match teams.get(&who.team).filter(|t| t.token_ok(&who.member, &who.token)).and_then(|t| t.config()) {
            Some(config) => result(&id, json!({ "tools": tools::describe(&config, &who.member) })),
            None => error(&id, -32000, "This session is not a member of a running team."),
        },
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            // The knowledge base is read, not acted on: it is no event in the record.
            if name == "knowledge_read" {
                return Some(match teams.knowledge_read(&who.team, &who.member, &who.token, &args) {
                    Ok(content) => result(&id, json!({ "content": content, "isError": false })),
                    Err(why) => result(&id, tool_result(&why, true)),
                });
            }
            if name == "knowledge_share" {
                return Some(match teams.knowledge_share(&who.team, &who.member, &who.token, &args) {
                    Ok(text) => result(&id, tool_result(&text, false)),
                    Err(why) => result(&id, tool_result(&why, true)),
                });
            }
            match teams.act(&who.team, &who.member, &who.token, name, &args) {
                Ok(text) => result(&id, tool_result(&text, false)),
                // A refused call is a result the model reads and acts on, not
                // a protocol failure.
                Err(why) => result(&id, tool_result(&why, true)),
            }
        }
        other => error(&id, -32601, &format!("{other} is not offered by this server")),
    })
}

/// Serves the pipe for as long as the app runs.
pub fn start(teams: Arc<Teams>) {
    tauri::async_runtime::spawn(async move {
        // first_pipe_instance: never serve on top of a pipe somebody else
        // already owns under our name.
        match ServerOptions::new().first_pipe_instance(true).create(pipe_name()) {
            Ok(server) => listen(teams, server).await,
            Err(err) => log::line(format!("cannot open the team pipe: {err}")),
        }
    });
}

/// Accepts relays on the pipe, each on its own task.
async fn listen(teams: Arc<Teams>, mut server: NamedPipeServer) {
    let name = pipe_name();
    loop {
        if server.connect().await.is_err() {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        // Hand the connected instance to a task and listen on a fresh one.
        let next = match ServerOptions::new().create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot reopen the team pipe: {err}"));
                return;
            }
        };
        let connected = std::mem::replace(&mut server, next);
        tokio::spawn(serve(teams.clone(), connected));
    }
}

async fn serve(teams: Arc<Teams>, pipe: NamedPipeServer) {
    let (read, mut write) = tokio::io::split(pipe);
    let mut lines = BufReader::new(read).lines();

    // The relay introduces itself, and is told whether it was recognised.
    let Ok(Some(first)) = lines.next_line().await else { return };
    let who = match serde_json::from_str::<Hello>(&first) {
        Ok(hello) if teams.get(&hello.team).map(|t| t.token_ok(&hello.member, &hello.token)).unwrap_or(false) => hello,
        _ => {
            let _ = write.write_all(b"{\"ok\":false,\"error\":\"This session is not a member of a running team.\"}\n").await;
            return;
        }
    };
    if write.write_all(b"{\"ok\":true}\n").await.is_err() {
        return;
    }
    log::line(format!("team {}: {} connected its tools", who.team, who.member));

    while let Ok(Some(line)) = lines.next_line().await {
        if line.len() > MAX_LINE {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        // A step held at the gate waits for the person: answered here, async.
        let message = serde_json::from_str::<Value>(&line).ok();
        if let Some(gate) = message.as_ref().filter(|m| m.get("method").and_then(Value::as_str) == Some("coucou/gate")) {
            let params = gate.get("params").cloned().unwrap_or(Value::Null);
            let tool = params.get("tool").and_then(Value::as_str).unwrap_or("");
            let args = params.get("args").cloned().unwrap_or(Value::Null);
            let decision = teams.gate(&who.team, &who.member, &who.token, tool, &args).await;
            let reply = json!({ "jsonrpc": "2.0", "id": gate.get("id").cloned().unwrap_or(Value::Null), "result": decision });
            if write.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
                break;
            }
            continue;
        }
        if let Some(reply) = answer(&teams, &who, &line) {
            if write.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::shop;
    use super::super::orchestrator::{BoxFuture, Drive, Emit, Seat};
    use super::*;
    use crate::acp::{AgentProfile, Sink};
    use std::path::PathBuf;

    /// Members that never do anything: only the server is under test.
    struct Asleep;

    impl Drive for Asleep {
        fn prompt(&self, _seat: Seat, _text: String, _events: Sink) -> BoxFuture<Result<String, String>> {
            Box::pin(std::future::pending())
        }
        fn answer(&self, _key: String, _request_id: Value, _option_id: Option<String>) -> BoxFuture<Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn cancel(&self, _key: String) -> BoxFuture<Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn stop(&self, _key: String) -> BoxFuture<()> {
            Box::pin(async {})
        }
    }

    #[test]
    fn a_member_s_client_can_list_and_call_its_tools() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let emit: Emit = Arc::new(|_| {});
            let teams = Teams::new(Arc::new(Asleep), emit, None, PathBuf::from("bridge.exe"));
            let dir = std::env::temp_dir().to_string_lossy().to_string();
            teams.start(shop(&dir), &[AgentProfile::copilot()]).unwrap();
            let token = |member: &str| teams.get("shop").unwrap().token_for_tests(member).unwrap();
            let leader = Hello { team: "shop".into(), member: "ai1".into(), token: token("ai1") };
            let ask = |who: &Hello, msg: Value| -> Value { serde_json::from_str(&answer(&teams, who, &msg.to_string()).unwrap()).unwrap() };

            let init = ask(&leader, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2024-11-05", "capabilities": {} } }));
            assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
            assert_eq!(init["result"]["serverInfo"]["name"], "coucou-team");
            assert!(init["result"]["capabilities"]["tools"].is_object());

            // A notification is not answered.
            assert!(answer(&teams, &leader, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none());

            let list = ask(&leader, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
            assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 12);
            // The knowledge base is read through the same server.
            let docs = ask(&leader, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "knowledge_read", "arguments": {} } }));
            assert_eq!(docs["result"]["isError"], false);
            assert!(docs["result"]["content"][0]["text"].is_string());

            let made = ask(&leader, json!({ "jsonrpc": "2.0", "id": "c1", "method": "tools/call",
                "params": { "name": "task_create", "arguments": { "title": "商品圖片", "owner": "ai4" } } }));
            assert_eq!(made["id"], "c1");
            assert_eq!(made["result"]["isError"], false);
            assert!(made["result"]["content"][0]["text"].as_str().unwrap().contains("Created TASK-01"));

            // A call the rules refuse comes back as a result the model can read.
            let member = Hello { team: "shop".into(), member: "ai3".into(), token: token("ai3") };
            let refused = ask(&member, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "task_create", "arguments": { "title": "x", "owner": "ai3" } } }));
            assert_eq!(refused["result"]["isError"], true);
            assert!(refused["result"]["content"][0]["text"].as_str().unwrap().contains("Only the leader"));
            assert_eq!(ask(&member, json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" }))["result"]["tools"].as_array().unwrap().len(), 8);

            // The wrong token gets nothing, whoever it claims to be.
            let stranger = Hello { team: "shop".into(), member: "ai1".into(), token: token("ai3") };
            assert!(ask(&stranger, json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list" }))["error"].is_object());
            let called = ask(&stranger, json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "team_status" } }));
            assert_eq!(called["result"]["isError"], true);

            assert_eq!(ask(&leader, json!({ "jsonrpc": "2.0", "id": 7, "method": "resources/list" }))["error"]["code"], -32601);
            assert_eq!(ask(&leader, json!({ "jsonrpc": "2.0", "id": 8, "method": "ping" }))["result"], json!({}));
            let garbled: Value = serde_json::from_str(&answer(&teams, &leader, "{ not json").unwrap()).unwrap();
            assert_eq!(garbled["error"]["code"], -32700);
        });
    }

    /// The real relay against the real pipe: what a CLI would start. Skipped
    /// when the relay has not been built, or when a running Coucou already
    /// owns the pipe.
    #[test]
    fn the_relay_carries_a_member_s_calls_to_the_team() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let target = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target");
        let Some(relay) = ["release", "debug"].iter().map(|p| target.join(p).join("coucou-team-mcp.exe")).find(|p| p.is_file()) else {
            eprintln!("skipped: coucou-team-mcp.exe is not built");
            return;
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let Ok(server) = ServerOptions::new().first_pipe_instance(true).create(pipe_name()) else {
                eprintln!("skipped: the team pipe is already served");
                return;
            };
            let emit: Emit = Arc::new(|_| {});
            let teams = Arc::new(Teams::new(Arc::new(Asleep), emit, None, relay.clone()));
            teams.start(shop(&std::env::temp_dir().to_string_lossy()), &[AgentProfile::copilot()]).unwrap();
            tokio::spawn(listen(teams.clone(), server));

            // Started the way Coucou starts it for a member: three variables, stdio.
            let spawn = |member: &str, token: String| {
                let mut child = tokio::process::Command::new(&relay)
                    .env("COUCOU_TEAM", "shop")
                    .env("COUCOU_MEMBER", member)
                    .env("COUCOU_TEAM_TOKEN", token)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap();
                let stdin = child.stdin.take().unwrap();
                let stdout = BufReader::new(child.stdout.take().unwrap()).lines();
                (child, stdin, stdout)
            };
            let real = teams.get("shop").unwrap().token_for_tests("ai1").unwrap();
            let (_leader, mut to, mut from) = spawn("ai1", real);

            to.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}
").await.unwrap();
            let init: Value = serde_json::from_str(&from.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(init["result"]["serverInfo"]["name"], "coucou-team");

            // The notification gets no line back; the next answer is the call's.
            to.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}
").await.unwrap();
            let call = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "task_create", "arguments": { "title": "商品圖片", "owner": "ai4" } } });
            to.write_all(format!("{call}
").as_bytes()).await.unwrap();
            let made: Value = serde_json::from_str(&from.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(made["id"], 2);
            assert!(made["result"]["content"][0]["text"].as_str().unwrap().contains("Created TASK-01"));
            assert_eq!(teams.get("shop").unwrap().snapshot().unwrap().tasks[0].title, "商品圖片");

            // A relay with the wrong token is told so on every request, and never hangs.
            let (_stranger, mut to, mut from) = spawn("ai1", "not-the-token".into());
            to.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/list\"}
").await.unwrap();
            let refused: Value = serde_json::from_str(&from.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(refused["id"], 9);
            assert!(refused["error"]["message"].as_str().unwrap().contains("not a member"));
        });
    }
}
