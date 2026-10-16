// Antigravity's CLI (`agy`) as an agent: its headless mode, one process per
// session, NDJSON in and out.
//
//   start      agy --input-format stream-json --output-format stream-json
//              [--dangerously-skip-permissions] [--model m] -p=
//   a turn     {"event":"user","message":{"content":"…"}} in;
//              {"event":"step_update",…} lines out — the reply's text as it
//              is written, each tool step as it starts and ends — and one
//              {"event":"result",…} when the turn is over
//   interrupt  {"event":"interrupt"}
//
// Headless, agy cannot ask anyone: a step that needs a permission is simply
// refused. So a team member runs with agy's own checks off and Coucou's in
// their place: a PreToolUse hook in the work folder (.agents/hooks.json)
// runs `coucou-team-mcp --gate` before every step, which asks the team over
// its pipe — the rules allow what is safe, and what is not waits for the
// person on a card, exactly as for the other agents. The team's tools come
// from .agents/mcp_config.json in the same folder. Both files name only the
// programs: who the member is and its key come from agy's environment,
// which agy passes on to them, so members share the files.
//
// Outside a team (the island's chat) agy keeps its own checks: what it would
// ask about, it is refused.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use crate::acp::{self, AcpOutcome, AcpUpdate, Event, Launch, McpServer, Route, Running};
use crate::claude::ModelChoice;
use crate::log;
use crate::policy::{self, Kind};

#[derive(Default)]
pub struct AgyState {
    /// Settled by the `result` that ends a turn.
    done: Mutex<Option<oneshot::Sender<Result<String, String>>>>,
    /// The model it was started with, to name the usage it reports.
    pub model: Mutex<String>,
}

/// The name of Coucou's gate in the work folder's hooks.json.
const GATE_KEY: &str = "coucou-team-gate";

/// What the driver adds to the profile's own arguments. `-p=` comes last:
/// agy would read the next argument as the prompt.
pub fn args(model: Option<&str>, gated: bool) -> Vec<String> {
    let mut out: Vec<String> = ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "12h"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if gated {
        out.push("--dangerously-skip-permissions".into());
    }
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
        out.push("--model".into());
        out.push(m.trim().to_string());
    }
    out.push("-p=".into());
    out
}

/// Merges Coucou's entry into a JSON file of the work folder's `.agents`,
/// keeping everything else in it.
fn merge(path: &std::path::Path, set: impl FnOnce(&mut Map<String, Value>)) -> Result<(), String> {
    let mut root = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    set(&mut root);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| {
        let p = path.display();
        tr!(format!("無法寫入 {p}：{e}"), format!("Could not write {p}: {e}"))
    })
}

/// The team's tools and Coucou's gate, in the folder the member works in.
pub fn prepare_folder(cwd: &std::path::Path, relay: &McpServer) -> Result<(), String> {
    let dir = cwd.join(".agents");
    merge(&dir.join("mcp_config.json"), |root| {
        let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
        if let Some(servers) = servers.as_object_mut() {
            servers.insert(relay.name.clone(), json!({ "command": relay.command, "args": relay.args }));
        }
    })?;
    let gate = format!("{} --gate", crate::hooks::cmd_safe_path(std::path::Path::new(&relay.command)));
    merge(&dir.join("hooks.json"), |root| {
        root.insert(
            GATE_KEY.into(),
            // The person may take a while to answer a card.
            json!({ "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": gate, "timeout": 3600 }] }] }),
        );
    })
}

pub async fn setup(running: &mut Running, key: &str, cwd: &std::path::Path, launch: &Launch) -> Result<(), String> {
    if let Some(m) = launch.model.as_deref().filter(|m| !m.trim().is_empty()) {
        *running.agy.model.lock().unwrap() = m.trim().to_string();
    }
    if let Some(relay) = launch.mcp_servers.first() {
        prepare_folder(cwd, relay)?;
    }
    running.session_id = "agy".into();
    log::line(format!(
        "agy {key}: ready in {} ({})",
        cwd.display(),
        if launch.mcp_servers.is_empty() { "its own checks" } else { "the team's gate answers permissions" },
    ));
    Ok(())
}

pub async fn prompt(running: &Running, text: String, timeout: Duration) -> Result<AcpOutcome, String> {
    let (tx, rx) = oneshot::channel();
    *running.agy.done.lock().unwrap() = Some(tx);
    let line = json!({ "event": "user", "message": { "content": text } }).to_string();
    if let Err(e) = acp::write_line(&running.writer, &line).await {
        running.agy.done.lock().unwrap().take();
        return Err(e);
    }
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result.map(|stop_reason| AcpOutcome { stop_reason, ..Default::default() }),
        Ok(Err(_)) => Err(tr!("Antigravity 已經結束了。", "Antigravity went away.")),
        Err(_) => Err(tr!("Antigravity 沒有及時完成這一輪。", "Antigravity did not finish the turn in time.")),
    }
}

pub async fn cancel(running: &Running) -> Result<(), String> {
    acp::write_line(&running.writer, &json!({ "event": "interrupt" }).to_string()).await
}

/// `agy models`: one model a line, its id and its name separated by a tab.
pub async fn models(command: &str) -> Result<Vec<ModelChoice>, String> {
    let mut cmd = tokio::process::Command::new(command);
    cmd.arg("models").stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| -> String { tr!("agy models 沒有及時回應。", "agy models did not answer in time.") })?
        .map_err(|e| -> String { tr!(format!("無法執行 agy models：{e}"), format!("Could not run agy models: {e}")) })?;
    let text = String::from_utf8_lossy(&out.stdout);
    let list: Vec<ModelChoice> = text
        .lines()
        .filter_map(|l| {
            let (id, name) = l.split_once('\t')?;
            let id = id.trim();
            (!id.is_empty() && !id.contains(' ')).then(|| ModelChoice { id: id.to_string(), label: name.trim().to_string() })
        })
        .collect();
    if list.is_empty() {
        return Err(if out.status.success() {
            tr!("agy models 什麼都沒有列出來。", "agy models listed nothing.")
        } else {
            tr!("agy models 什麼都沒有列出來：agy 登入了嗎？", "agy models listed nothing: is agy signed in?")
        });
    }
    Ok(list)
}

fn text(args: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|k| args.get(*k).and_then(Value::as_str)).unwrap_or("").to_string()
}

/// A step's title and ACP kind, for the screens.
pub fn title_of(tool: &str, args: &Value) -> (String, &'static str) {
    match tool {
        "run_command" | "send_command_input" => (crate::claude::run_title(&text(args, &["CommandLine", "Input"])), "execute"),
        "write_to_file" | "replace_file_content" | "multi_replace_file_content" | "sed_file" | "notebook_edit" => {
            (crate::claude::edit_title(&text(args, &["TargetFile", "AbsolutePath", "File"])), "edit")
        }
        "view_file" => (read_title(&text(args, &["AbsolutePath", "File"])), "read"),
        "list_dir" => (read_title(&text(args, &["DirectoryPath"])), "read"),
        "grep_search" | "find_by_name" => {
            let what = text(args, &["Query", "Pattern", "SearchPath", "SearchDirectory"]);
            (tr!(format!("搜尋 {what}"), format!("Search {what}")), "search")
        }
        "read_url_content" | "search_web" | "open_browser_url" | "read_browser_page" => {
            let what = text(args, &["Url", "Query"]);
            (tr!(format!("讀取網頁 {what}"), format!("Fetch {what}")), "fetch")
        }
        "call_mcp_tool" => (format!("{}.{}", text(args, &["ServerName"]), text(args, &["ToolName"])), "other"),
        "generate_image" => (tr!("產生圖片", "Generate an image"), "other"),
        other => (other.to_string(), "other"),
    }
}

fn read_title(what: &str) -> String {
    tr!(format!("讀取 {what}"), format!("Read {what}"))
}

/// A step as the rules read it, for the gate.
pub fn request_of(tool: &str, args: &Value) -> policy::Request {
    let paths = |keys: &[&str]| keys.iter().filter_map(|k| args.get(*k).and_then(Value::as_str)).map(str::to_string).collect::<Vec<_>>();
    let (kind, command, paths) = match tool {
        "run_command" => (Kind::Execute, Some(text(args, &["CommandLine"])), vec![]),
        // Typing into a command already running: what it types is a command line too.
        "send_command_input" => (Kind::Execute, Some(text(args, &["Input"])), vec![]),
        "write_to_file" | "replace_file_content" | "multi_replace_file_content" | "sed_file" | "notebook_edit" => {
            (Kind::Edit, None, paths(&["TargetFile", "AbsolutePath", "File"]))
        }
        // Where it reads, so a private folder is seen (policy::Private); reading is allowed anywhere else.
        "view_file" | "list_dir" | "grep_search" | "find_by_name" => {
            (Kind::Read, None, paths(&["AbsolutePath", "File", "TargetFile", "DirectoryPath", "SearchPath", "SearchDirectory", "Path"]))
        }
        "read_url_content" | "search_web" | "open_browser_url" | "read_browser_page" | "list_browser_pages" | "capture_browser_screenshot"
        | "capture_browser_console_logs" | "browser_get_dom" | "browser_list_network_requests" | "browser_get_network_request" => (Kind::Fetch, None, vec![]),
        "call_mcp_tool" if text(args, &["ServerName"]) == acp::TEAM_SERVER => (Kind::Think, None, vec![]),
        // Its own bookkeeping: tasks, waiting, sub-agents, questions, images.
        "command_status" | "wait" | "wait_5_seconds" | "manage_task" | "finish" | "ask_question" | "define_subagent" | "invoke_subagent"
        | "manage_subagents" | "browser_subagent" | "list_permissions" | "send_message" | "manage_inbox" | "list_resources" | "read_resource"
        | "generate_image" | "ask_permission" | "ask_custom_permission" => (Kind::Think, None, vec![]),
        _ => (Kind::Other, None, vec![]),
    };
    policy::Request { kind, command, paths }
}

fn update(route: &Route, update: Value) {
    (route.sink)(Event::Update(AcpUpdate { agent_id: route.key.clone(), update }));
}

/// One line from agy.
pub async fn dispatch(route: &Route, state: &AgyState, msg: Value) {
    match msg.get("event").and_then(Value::as_str).unwrap_or("") {
        "step_update" => {
            let step = msg.get("step_update").cloned().unwrap_or(Value::Null);
            let at = step.get("step_index").map(|v| v.to_string()).unwrap_or_default();
            let st = step.get("state").and_then(Value::as_str).unwrap_or("");
            match step.get("step_type").and_then(Value::as_str).unwrap_or("") {
                "agent_response" | "planner_response" => {
                    for (field, kind) in [("thinking_delta", "agent_thought_chunk"), ("text_delta", "agent_message_chunk")] {
                        let t = step.get(field).and_then(Value::as_str).unwrap_or("");
                        if !t.is_empty() {
                            update(route, json!({ "sessionUpdate": kind, "content": { "type": "text", "text": t } }));
                        }
                    }
                }
                "tool" => {
                    let info = step.get("tool_info").cloned().unwrap_or(Value::Null);
                    let tool = step.get("tool_name").and_then(Value::as_str).unwrap_or("");
                    let params = info.get("parameters").cloned().unwrap_or(Value::Null);
                    let (title, kind) = title_of(tool, &params);
                    // The team's tools are read by their arguments.
                    let input = if tool == "call_mcp_tool" { params.get("Arguments").cloned().unwrap_or(Value::Null) } else { params.clone() };
                    match st {
                        "DONE" | "ERROR" => {
                            let failed = st == "ERROR" && info.get("error").is_some();
                            let said = if failed {
                                info.pointer("/error/message").and_then(Value::as_str)
                            } else {
                                info.get("output").and_then(Value::as_str)
                            };
                            // A step that ended before it was seen starting is still one line.
                            update(route, json!({ "sessionUpdate": "tool_call", "toolCallId": at, "title": title, "kind": kind, "status": "in_progress", "rawInput": input }));
                            let mut done = json!({ "sessionUpdate": "tool_call_update", "toolCallId": at, "status": if failed { "failed" } else { "completed" } });
                            if let Some(t) = said.filter(|t| !t.is_empty()) {
                                done["content"] = json!([{ "type": "content", "content": { "type": "text", "text": t } }]);
                            }
                            update(route, done);
                        }
                        _ => update(route, json!({ "sessionUpdate": "tool_call", "toolCallId": at, "title": title, "kind": kind, "status": "in_progress", "rawInput": input })),
                    }
                }
                _ => {}
            }
        }
        "result" => {
            let result = msg.get("result").cloned().unwrap_or(Value::Null);
            // Usage, if this agy version reports any: Gemini's usageMetadata,
            // or an OpenAI-style usage.
            let model = state.model.lock().unwrap().clone();
            let found = [result.get("usageMetadata"), msg.get("usageMetadata"), result.get("usage_metadata")]
                .into_iter()
                .flatten()
                .next()
                .map(|u| crate::usage::from_gemini(&model, u))
                .or_else(|| [result.get("usage"), msg.get("usage")].into_iter().flatten().next().map(|u| crate::usage::from_openai(&model, u)));
            if let Some(u) = found.filter(|u| !u.is_empty()) {
                (route.sink)(Event::Usage(u));
            }
            let status = result.get("status").and_then(Value::as_str).unwrap_or("SUCCESS");
            let outcome = match status {
                "SUCCESS" => Ok("end_turn".to_string()),
                "CANCELLED" | "CANCELED" | "INTERRUPTED" => Ok("cancelled".to_string()),
                _ => Err(result
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|e| !e.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| tr!("Antigravity 因為錯誤結束了這一輪。", "Antigravity ended the turn on an error."))),
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

    fn agy_profile() -> crate::acp::AgentProfile {
        crate::acp::AgentProfile {
            id: "agy".into(),
            name: "Antigravity".into(),
            command: "agy".into(),
            args: vec![],
            env: Default::default(),
            cwd: String::new(),
            protocol: crate::acp::Protocol::Agy,
            model: String::new(),
            ..Default::default()
        }
    }

    /// A real agy turn through the driver: words as they are written, a
    /// step shown, the turn ended by its result. Spends one short turn.
    /// `cargo test -p coucou the_real_agy -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_agy_runs_a_turn_and_streams() {
        let dir = std::env::temp_dir().join(format!("coucou-agy-real-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.txt"), "The word is PAPAYA.").unwrap();
        let heard = std::sync::Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink: acp::Sink = {
            let heard = heard.clone();
            std::sync::Arc::new(move |event| {
                if let Event::Update(u) = event {
                    heard.lock().unwrap().push(u.update);
                }
            })
        };
        let launch = Launch { cwd: Some(dir.to_string_lossy().to_string()), model: Some("gemini-3.8-flash-low".into()), ..Launch::default() };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let agents = acp::Agents::default();
        let outcome = runtime.block_on(agents.prompt(&sink, "test:agy", &agy_profile(), &launch, "Read note.txt in this folder and reply with the word it gives, in one short sentence.".into()));
        runtime.block_on(agents.shutdown());
        let heard = heard.lock().unwrap();
        let said: String = heard.iter().filter(|u| u["sessionUpdate"] == "agent_message_chunk").filter_map(|u| u["content"]["text"].as_str()).collect();
        assert!(outcome.is_ok(), "{outcome:?}");
        assert!(said.contains("PAPAYA"), "agy said: {said}");
        assert!(heard.iter().any(|u| u["sessionUpdate"] == "tool_call" && u["kind"] == "read"), "no step shown: {heard:?}");
        assert!(heard.iter().any(|u| u["sessionUpdate"] == "tool_call_update" && u["status"] == "completed"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `agy models`, for the drop-down. Spends nothing.
    #[test]
    #[ignore]
    fn the_real_agy_lists_its_models() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let models = runtime.block_on(acp::Agents::default().models(&agy_profile())).expect("agy models");
        assert!(models.iter().any(|m| m.id.starts_with("gemini")), "{models:?}");
    }

    #[test]
    fn the_prompt_flag_comes_last_and_checks_are_off_only_behind_the_gate() {
        let team = args(Some("gemini-3.8-flash-high"), true);
        assert_eq!(team.last().unwrap(), "-p=");
        assert!(team.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(team.windows(2).any(|w| w == ["--model", "gemini-3.8-flash-high"]));
        assert!(!args(None, false).contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn agy_s_steps_are_read_the_way_the_rules_expect() {
        let run = request_of("run_command", &json!({ "CommandLine": "rm -rf dist" }));
        assert_eq!((run.kind, run.command.as_deref()), (Kind::Execute, Some("rm -rf dist")));
        assert_eq!(request_of("write_to_file", &json!({ "TargetFile": r"C:\x\a.ts" })).paths, vec![r"C:\x\a.ts".to_string()]);
        assert_eq!(request_of("view_file", &json!({})).kind, Kind::Read);
        assert_eq!(request_of("call_mcp_tool", &json!({ "ServerName": "coucou-team", "ToolName": "deliver" })).kind, Kind::Think);
        assert_eq!(request_of("call_mcp_tool", &json!({ "ServerName": "github", "ToolName": "push" })).kind, Kind::Other);
        assert_eq!(title_of("call_mcp_tool", &json!({ "ServerName": "coucou-team", "ToolName": "task_create" })).0, "coucou-team.task_create");
    }

    #[test]
    fn the_folder_gets_the_tools_and_the_gate_and_keeps_its_own() {
        let dir = std::env::temp_dir().join(format!("coucou-agy-folder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".agents")).unwrap();
        std::fs::write(dir.join(".agents").join("hooks.json"), r#"{"mine":{"Stop":[{"command":"echo"}]}}"#).unwrap();
        let relay = McpServer { name: "coucou-team".into(), command: r"C:\bin\coucou-team-mcp.exe".into(), args: vec![], env: Default::default(), url: String::new() };
        prepare_folder(&dir, &relay).unwrap();
        let hooks: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".agents").join("hooks.json")).unwrap()).unwrap();
        assert!(hooks.get("mine").is_some());
        assert_eq!(hooks[GATE_KEY]["PreToolUse"][0]["hooks"][0]["command"], r"C:\bin\coucou-team-mcp.exe --gate");
        let mcp: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".agents").join("mcp_config.json")).unwrap()).unwrap();
        assert_eq!(mcp["mcpServers"]["coucou-team"]["command"], r"C:\bin\coucou-team-mcp.exe");
        // No key in the file: it comes from agy's environment.
        assert!(mcp["mcpServers"]["coucou-team"].get("env").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
