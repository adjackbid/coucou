// n8n nodes as agents (Settings → Agent Provider, always a Local Agent): an n8n
// workflow that starts with a Webhook node. There is no process and no
// protocol: a turn is one POST of JSON to the Webhook's URL, and what the
// workflow answers is the agent's reply — streamed to the sink like a CLI's
// words, and handed back whole so a team can hand it in for the member
// (`hand_in`, called by orchestrator.rs).
//
// What is sent: `{source, kind, sessionId, message, model}` from the chat
// and the Test button; a team turn sends `team_turn` instead.
// What may come back: plain text, or JSON whose `reply`, `output` or `text`
// is the answer (`output` is what n8n's AI Agent node gives), with an
// optional `locator` (a URL of what it made), `blocked` (why it cannot go
// on) and `usage` ({model, inputTokens, outputTokens, costUsd}).
//
// The Webhook's URL is one the person typed, and the key for its Header Auth
// stays in the Credential Manager under the profile's name.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::acp::{AcpOutcome, AcpUpdate, AgentProfile, Event, Launch, Sink};
use crate::secrets;
use crate::team::state::{Message, State, Task};
use crate::team::TeamConfig;

/// Seconds one call may take when the profile does not say.
pub const DEFAULT_TIMEOUT: u64 = 300;
/// What every body says it comes from, so a workflow can tell.
pub const SOURCE: &str = "agent-center";
/// A summary handed in with a delivery is cut to this many characters.
const SUMMARY: usize = 200;

pub(crate) fn no_process() -> String {
    tr!("n8n 節點不是程式,沒有東西可以啟動:它透過 Webhook 呼叫。", "An n8n node is not a program to start: it is called through its webhook.")
}

/// What the workflow answered, read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Answer {
    pub text: String,
    /// A URL of what it made.
    pub locator: String,
    /// Why it cannot go on, when it says so.
    pub blocked: String,
    pub usage: Option<crate::usage::Usage>,
}

fn field<'a>(map: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|n| map.get(*n)).filter(|v| !v.is_null())
}

fn words(map: &Map<String, Value>, names: &[&str]) -> String {
    match field(map, names) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn number(map: &Map<String, Value>, names: &[&str]) -> u64 {
    field(map, names).and_then(Value::as_u64).unwrap_or(0)
}

/// Reads a workflow's answer: plain text, or JSON as the top of this file says.
/// "Respond with all incoming items" gives an array: the first item answers.
pub fn read_answer(body: &str, model: &str) -> Answer {
    let body = body.trim();
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Answer { text: body.to_string(), ..Default::default() };
    };
    let item = match value {
        Value::Array(items) => items.into_iter().next().unwrap_or(Value::Null),
        other => other,
    };
    let map = match item {
        Value::Object(map) => map,
        Value::String(s) => return Answer { text: s.trim().to_string(), ..Default::default() },
        Value::Null => return Answer::default(),
        other => return Answer { text: other.to_string(), ..Default::default() },
    };
    let text = match field(&map, &["reply", "output", "text", "message", "answer"]) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(other) => serde_json::to_string_pretty(other).unwrap_or_default(),
        None => serde_json::to_string_pretty(&map).unwrap_or_default(),
    };
    let usage = map.get("usage").and_then(Value::as_object).map(|u| {
        let named = words(u, &["model"]);
        crate::usage::Usage {
            model: if named.is_empty() { model.to_string() } else { named },
            input: number(u, &["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
            output: number(u, &["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
            requests: 1,
            cost_usd: field(u, &["costUsd", "cost_usd", "cost"]).and_then(Value::as_f64),
            ..Default::default()
        }
    });
    Answer {
        text,
        locator: words(&map, &["locator", "url"]),
        blocked: words(&map, &["blocked"]),
        usage: usage.filter(|u| !u.is_empty()),
    }
}

/// The body the chat and the Test button send.
fn chat_body(key: &str, kind: &str, model: &str, text: &str) -> Value {
    json!({ "source": SOURCE, "kind": kind, "sessionId": key, "message": text, "model": model })
}

fn task_json(t: &Task) -> Value {
    json!({
        "id": t.id,
        "title": t.title,
        "detail": t.detail,
        "doneCriteria": t.criteria.iter().map(|c| c.text.clone()).collect::<Vec<_>>(),
        "status": format!("{:?}", t.status).to_lowercase(),
    })
}

/// The task an n8n member's next answer is for: the first it was given that
/// is not blocked and whose inputs are in.
fn current_task<'a>(state: &'a State, member: &str) -> Option<&'a Task> {
    state.open_tasks(member).into_iter().find(|t| t.blocked.is_none() && state.deps_met(t))
}

/// What a team member that is an n8n node is sent for a turn, as the text of
/// its prompt (`prompt` sends it as it is): the team, who it is in it, the
/// task its answer is for, its other open tasks and what it heard.
pub fn team_turn(config: &TeamConfig, state: &State, member: &str, heard: &[&Message], key: &str, system_prompt: &str, model: &str) -> String {
    let me = config.member(member);
    let who = |id: &str| crate::team::brief::who(config, id);
    json!({
        "source": SOURCE,
        "kind": "team-turn",
        "sessionId": key,
        "team": { "id": config.id, "name": config.name, "goal": config.goal, "workFolder": config.work_dir },
        "member": {
            "id": member,
            "name": me.map(|m| m.name.as_str()).unwrap_or(member),
            "role": me.map(|m| m.role.as_str()).unwrap_or(""),
            "duty": me.map(|m| m.duty.as_str()).unwrap_or(""),
        },
        "systemPrompt": system_prompt,
        "model": model,
        "task": current_task(state, member).map(task_json),
        "tasks": state.open_tasks(member).into_iter().map(task_json).collect::<Vec<_>>(),
        "messages": heard.iter().map(|m| json!({ "from": who(&m.from), "text": m.text, "task": m.task })).collect::<Vec<_>>(),
        "reply": "Answer with the result as text, or JSON {reply, locator?, blocked?, usage?}.",
    })
    .to_string()
}

/// What an n8n member's answer does in its team, as team tool calls made for
/// it: a reason to stop blocks its task; an answer to a task is delivered
/// (written to the work folder when it gave no URL); anything else goes to
/// the leader. Nothing at all, with no task, does nothing.
pub fn hand_in(config: &TeamConfig, state: &State, member: &str, answer: &Answer) -> Result<Vec<(&'static str, Value)>, String> {
    let Some(task) = current_task(state, member) else {
        if answer.text.is_empty() || member == config.leader {
            return Ok(Vec::new());
        }
        return Ok(vec![("message_send", json!({ "to": config.leader, "text": answer.text }))]);
    };
    let block = |reason: &str| ("task_block", json!({ "task": task.id, "reason": reason, "waiting_on": config.leader }));
    if !answer.blocked.is_empty() {
        return Ok(vec![block(&answer.blocked)]);
    }
    if answer.text.is_empty() && answer.locator.is_empty() {
        return Ok(vec![block("The n8n workflow answered with nothing.")]);
    }
    let locator = if answer.locator.starts_with("http://") || answer.locator.starts_with("https://") {
        answer.locator.clone()
    } else {
        let relative = format!("n8n-output/{member}/{}.md", task.id);
        let full = Path::new(&config.work_dir).join(&relative);
        if let Some(dir) = full.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&full, format!("# {}\n\n{}\n", task.title, answer.text)).map_err(|e| e.to_string())?;
        relative
    };
    let summary: String = if answer.text.is_empty() { locator.clone() } else { answer.text.chars().take(SUMMARY).collect() };
    let kind = if locator.starts_with("http") { "link" } else { "document" };
    Ok(vec![("deliver", json!({ "task": task.id, "locator": locator, "summary": summary, "kind": kind }))])
}

/// One POST to the profile's Webhook; the answer's body.
async fn call(profile: &AgentProfile, body: &Value) -> Result<String, String> {
    let url = profile.url.trim();
    if url.is_empty() {
        return Err(tr!("這個 n8n 節點還沒填 Webhook 網址。", "This n8n node has no webhook URL yet."));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(tr!("Webhook 網址要以 http:// 或 https:// 開頭。", "The webhook URL must start with http:// or https://."));
    }
    let seconds = if profile.timeout_secs == 0 { DEFAULT_TIMEOUT } else { profile.timeout_secs };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(seconds)).build().map_err(|e| e.to_string())?;
    let mut request = client.post(url).header("Accept", "application/json, text/plain;q=0.9, */*;q=0.5").json(body);
    let header = profile.header_name.trim();
    if !header.is_empty() {
        let key = secrets::get(&profile.secret_key()).unwrap_or_default();
        if key.is_empty() {
            return Err(tr!(format!("驗證 Header「{header}」還沒存金鑰。"), format!("No key is saved for the '{header}' header yet.")));
        }
        request = request.header(header, key);
    }
    let response = request.send().await.map_err(|e| -> String {
        if e.is_timeout() {
            tr!(format!("n8n 在 {seconds} 秒內沒有回應。"), format!("n8n did not answer within {seconds} s."))
        } else {
            tr!(format!("連不到 n8n 的 Webhook:{e}"), format!("Could not reach the n8n webhook: {e}"))
        }
    })?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let code = status.as_u16();
        let head: String = text.trim().chars().take(200).collect();
        let hint: String = if code == 404 {
            tr!(
                "(Webhook 沒有在聽:工作流程要設成 Active 並用 Production URL,或用 Test URL 時先在 n8n 按 Listen)",
                " (the webhook is not listening: make the workflow Active and use its Production URL, or press Listen in n8n for the Test URL)"
            )
        } else {
            String::new()
        };
        return Err(tr!(format!("n8n 回了 HTTP {code}{hint}:{head}"), format!("n8n answered HTTP {code}{hint}: {head}")));
    }
    Ok(text)
}

/// One turn: the call, shown as a step, and the answer as the agent's words.
pub async fn prompt(sink: Sink, key: String, profile: AgentProfile, launch: Launch, text: String) -> Result<AcpOutcome, String> {
    let model = crate::acp::running_model(&profile, &launch);
    // A team's turn comes ready (`team_turn`); anything else is the chat's.
    let body = serde_json::from_str::<Value>(&text)
        .ok()
        .filter(|v| v.get("source").and_then(Value::as_str) == Some(SOURCE))
        .unwrap_or_else(|| chat_body(&key, "chat", &model, &text));
    let update = |u: Value| sink(Event::Update(AcpUpdate { agent_id: key.clone(), update: u }));
    let step = format!("n8n-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let shown = profile.url.trim().split(['?', '#']).next().unwrap_or("").to_string();
    let title: String = tr!("呼叫 n8n Webhook", "Calling the n8n webhook");
    update(json!({
        "sessionUpdate": "tool_call",
        "toolCallId": step,
        "title": title,
        "kind": "fetch",
        "status": "in_progress",
        "rawInput": { "url": shown },
    }));
    match call(&profile, &body).await {
        Err(err) => {
            update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": step, "status": "failed", "content": [{ "type": "content", "content": { "type": "text", "text": err } }] }));
            Err(err)
        }
        Ok(raw) => {
            let answer = read_answer(&raw, &model);
            update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": step, "status": "completed" }));
            if !answer.text.is_empty() {
                update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": answer.text } }));
            }
            if let Some(usage) = answer.usage {
                sink(Event::Usage(usage));
            }
            Ok(AcpOutcome { stop_reason: "end_turn".into(), reply: raw })
        }
    }
}

/// The settings window's "Test": one call with `kind: "test"`.
pub async fn test(profile: &AgentProfile) -> Result<String, String> {
    let raw = call(profile, &chat_body(&format!("test:{}", profile.id), "test", &profile.model, "ping")).await?;
    let head: String = read_answer(&raw, "").text.chars().take(120).collect();
    let name = &profile.name;
    Ok(if head.is_empty() {
        tr!(format!("{name} 的 Webhook 回應了(沒有內容)。"), format!("{name}'s webhook answered (with nothing in it)."))
    } else {
        tr!(format!("{name} 的 Webhook 回應了:{head}"), format!("{name}'s webhook answered: {head}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team::state::{Event as TeamEvent, Record};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn an_answer_is_read_from_text_or_the_usual_json_fields() {
        assert_eq!(read_answer("  done  ", "m").text, "done");
        let ai_agent = read_answer(r#"[{"output":"Here it is","usage":{"inputTokens":12,"outputTokens":5,"costUsd":0.01}}]"#, "glm");
        assert_eq!(ai_agent.text, "Here it is");
        let usage = ai_agent.usage.unwrap();
        assert_eq!((usage.model.as_str(), usage.input, usage.output, usage.cost_usd), ("glm", 12, 5, Some(0.01)));
        let blocked = read_answer(r#"{"reply":"","blocked":"Need the API key"}"#, "");
        assert_eq!(blocked.blocked, "Need the API key");
        let link = read_answer(r#"{"reply":"Report","locator":"https://example.test/r.pdf"}"#, "");
        assert_eq!(link.locator, "https://example.test/r.pdf");
        // Something else entirely is shown as it is.
        assert!(read_answer(r#"{"rows":3}"#, "").text.contains("\"rows\": 3"));
        assert_eq!(read_answer("\"quoted\"", "").text, "quoted");
    }

    fn team(dir: &Path) -> (TeamConfig, State) {
        let mut config: TeamConfig = serde_json::from_value(json!({
            "id": "t", "name": "T", "goal": "Reports", "workDir": dir.to_string_lossy(), "leader": "lead",
            "members": [
                { "id": "lead", "name": "Lead", "role": "Leader", "agent": "claude" },
                { "id": "flow", "name": "Flow", "role": "Reporter", "agent": "n8n-report" }
            ]
        }))
        .unwrap();
        config.direct_talk = true;
        let mut state = State::default();
        apply(&mut state, TeamEvent::Started { config: config.clone() });
        (config, state)
    }

    fn apply(state: &mut State, event: TeamEvent) {
        state.apply(&Record { seq: 0, at: 0, event });
    }

    fn give_task(state: &mut State) {
        apply(state, TeamEvent::TaskCreated {
            id: "T1".into(),
            title: "Weekly report".into(),
            detail: "Sum up the week".into(),
            owner: "flow".into(),
            priority: Default::default(),
            criteria: vec![],
            depends_on: vec![],
            deliver_to: None,
            by: "lead".into(),
        });
        apply(state, TeamEvent::Dispatched { task: "T1".into() });
    }

    #[test]
    fn an_answer_to_a_task_is_written_and_delivered_and_anything_else_goes_to_the_leader() {
        let dir = std::env::temp_dir().join(format!("agent-center-n8n-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (config, mut state) = team(&dir);
        let said = |text: &str| Answer { text: text.into(), ..Default::default() };

        let free = hand_in(&config, &state, "flow", &said("Hello lead")).unwrap();
        assert_eq!(free[0].0, "message_send");
        assert_eq!(free[0].1["to"], "lead");
        assert!(hand_in(&config, &state, "flow", &Answer::default()).unwrap().is_empty());

        give_task(&mut state);
        let body: Value = serde_json::from_str(&team_turn(&config, &state, "flow", &[], "team:t:flow", "Be brief.", "glm")).unwrap();
        assert_eq!(body["kind"], "team-turn");
        assert_eq!(body["task"]["id"], "T1");
        assert_eq!(body["member"]["role"], "Reporter");

        let done = hand_in(&config, &state, "flow", &said("All good this week.")).unwrap();
        assert_eq!(done[0].0, "deliver");
        let locator = done[0].1["locator"].as_str().unwrap().to_string();
        assert_eq!(locator, "n8n-output/flow/T1.md");
        assert!(std::fs::read_to_string(dir.join(&locator)).unwrap().contains("All good this week."));

        let link = hand_in(&config, &state, "flow", &Answer { text: "See it".into(), locator: "https://x.test/r".into(), ..Default::default() }).unwrap();
        assert_eq!(link[0].1["locator"], "https://x.test/r");

        let stuck = hand_in(&config, &state, "flow", &Answer { blocked: "No data source".into(), ..Default::default() }).unwrap();
        assert_eq!((stuck[0].0, stuck[0].1["waiting_on"].as_str()), ("task_block", Some("lead")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A webhook on this machine that answers once with `reply`, and hands
    /// back what it was sent.
    async fn webhook(status: &'static str, reply: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/webhook/agent", listener.local_addr().unwrap());
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if got.len() >= end + 4 + length || n == 0 {
                        break;
                    }
                }
            }
            let answer = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
            socket.write_all(answer.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&got).to_string()
        });
        (url, served)
    }

    fn node(url: &str) -> AgentProfile {
        AgentProfile { id: "n8n-report".into(), name: "Report flow".into(), protocol: crate::acp::Protocol::N8n, url: url.into(), ..Default::default() }
    }

    #[test]
    fn a_turn_posts_to_the_webhook_and_shows_the_answer_as_words() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let (url, served) = webhook("200 OK", r#"{"output":"Report ready","usage":{"outputTokens":7}}"#).await;
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Event>::new()));
            let into = seen.clone();
            let sink: Sink = std::sync::Arc::new(move |e| into.lock().unwrap().push(e));
            let outcome = prompt(sink, "agent:n8n-report".into(), node(&url), Launch::default(), "Hi there".into()).await.unwrap();
            assert!(outcome.reply.contains("Report ready"));
            let request = served.await.unwrap();
            assert!(request.starts_with("POST /webhook/agent"));
            assert!(request.contains("\"kind\":\"chat\"") && request.contains("\"message\":\"Hi there\"") && request.contains("agent-center"));
            let events = seen.lock().unwrap();
            let words = events.iter().any(|e| matches!(e, Event::Update(u) if u.update["content"]["text"] == "Report ready"));
            assert!(words, "the answer shows as the agent's words");
            assert!(events.iter().any(|e| matches!(e, Event::Usage(u) if u.output == 7)));
        });
    }

    #[test]
    fn a_webhook_that_is_not_listening_says_what_to_do() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let (url, _served) = webhook("404 Not Found", r#"{"message":"not registered"}"#).await;
            let err = test(&node(&url)).await.unwrap_err();
            assert!(err.contains("404") && (err.contains("Active") || err.contains("Listen")), "{err}");
            assert!(test(&node("")).await.is_err());
        });
    }
}
