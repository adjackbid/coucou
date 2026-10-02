//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>`.
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! Usage: `coucou-hook [--agent claude|copilot] <EventName>` (the name is also
//! read from the JSON). The agent tags the payload so the island knows which
//! CLI is talking, and picks the shape of the answer written back: Claude Code
//! wants `hookSpecificOutput`, Copilot CLI a bare `behavior`.

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// `ERROR_PIPE_BUSY` — every instance is serving someone else right now. This is
/// the one error worth retrying: the server exists and a slot will free up.
const ERROR_PIPE_BUSY: i32 = 231;

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path"];
/// How much of the end of a transcript is read to find the last reply. A
/// transcript can be megabytes; the last turn is in the final few kilobytes.
const TRANSCRIPT_TAIL: u64 = 256 * 1024;
/// Longest reply forwarded as `last_reply`. The island shows the whole thing
/// in its session view, so this is a real page, not a headline.
const MAX_REPLY_LEN: usize = 6_000;
/// The Stop hook can fire before the CLI has appended the reply it is
/// stopping on. When the transcript still ends on the user's prompt, wait a
/// little and look again — a few times, well inside the fire-and-forget budget.
const REPLY_RETRIES: u32 = 8;
const REPLY_RETRY_WAIT: Duration = Duration::from_millis(150);
/// Longest prompt lifted out of a transcript.
const MAX_FIELD_FALLBACK: usize = 2_000;
/// Longest string forwarded for any single field. The island shows the whole
/// thing — a Write's content, an Edit's old and new strings — so this has to
/// hold a real file, not a headline. Past it the field is cut and the payload
/// flagged, and the island offers "Ask in terminal" instead of an Allow for
/// something nobody could read.
const MAX_FIELD_LEN: usize = 64 * 1024;
/// Ceiling for the whole line on the pipe (Coucou stops reading at 1 MiB). A
/// MultiEdit with dozens of 64 KB edits would blow past it, so the fields are
/// re-cut to this much shorter length and the payload flagged, rather than the
/// event being lost on the way.
const MAX_LINE_LEN: usize = 512 * 1024;
const FALLBACK_FIELD_LEN: usize = 2_000;
/// Set to `true` on the payload when any string was cut.
const TRUNCATED_FLAG: &str = "coucou_truncated";

mod win;

/// `\\.\pipe\coucou-<sid>`. The SID keeps two accounts on the same machine from
/// ever meeting on the same pipe; the name falls back to the user name only if
/// the SID cannot be read at all, which should not happen.
fn pipe_path() -> String {
    let key = win::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-{key}")
}

/// Opens the pipe. Retries only while the server is busy: any other error means
/// there is nothing to talk to, and waiting would only delay Claude Code.
fn connect() -> Option<std::fs::File> {
    use std::os::windows::io::AsRawHandle;
    let path = pipe_path();
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => {
                let handle = windows::Win32::Foundation::HANDLE(file.as_raw_handle());
                // Somebody else's server on our pipe name gets nothing from us.
                return win::pipe_server_is_same_user(handle).then_some(file);
            }
            Err(err) => {
                if err.raw_os_error() != Some(ERROR_PIPE_BUSY) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

/// `[--agent <name>] [<EventName>]`, in either order.
fn parse_args() -> (String, String) {
    let mut agent = "claude".to_string();
    let mut event = String::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--agent" {
            if let Some(name) = args.next() {
                agent = name;
            }
        } else if let Some(name) = arg.strip_prefix("--agent=") {
            agent = name.to_string();
        } else if event.is_empty() {
            event = arg;
        }
    }
    (agent, event)
}

/// Antigravity reads a JSON object from every hook's stdout. An empty one
/// changes nothing: no decision, no injected steps, the agent stops when it
/// meant to. The other CLIs want silence, which they get.
fn finish(agent: &str) -> ! {
    if agent == "antigravity" {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{{}}");
        let _ = out.flush();
    }
    std::process::exit(0)
}

fn main() {
    let (agent, arg_event) = parse_args();
    let Some((payload, event)) = read_event(&agent, &arg_event) else { finish(&agent) };

    let waits_for_answer = event == "PermissionRequest";
    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(json) = decision_json(&decision, &agent) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    finish(&agent);
}

/// Copilot's payload, put into the words every other agent uses. Up to
/// 1.0.90 its PascalCase hooks received Claude-shaped payloads; 1.0.91 sends
/// its native shape to every hook — `sessionId`, and the tool as
/// `toolCalls: [{name, args}]`. Both shapes are accepted; a field already in
/// the Claude spelling is left alone.
fn normalize_copilot(map: &mut serde_json::Map<String, serde_json::Value>) {
    for (camel, snake) in [("sessionId", "session_id"), ("transcriptPath", "transcript_path")] {
        if !map.contains_key(snake) {
            if let Some(v) = map.remove(camel) {
                map.insert(snake.into(), v);
            }
        }
    }
    if !map.contains_key("tool_name") {
        let first = map
            .get("toolCalls")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .cloned();
        if let Some(call) = first {
            if let Some(name) = call.get("name").and_then(|v| v.as_str()) {
                map.insert("tool_name".into(), serde_json::Value::String(name.to_string()));
            }
            if let Some(args) = call.get("args").or_else(|| call.get("arguments")) {
                map.insert("tool_input".into(), args.clone());
            }
        }
    }
}

/// Antigravity's payload, put into the words every other agent uses: its
/// camelCase ids become `session_id` / `cwd` / `transcript_path`, and its
/// events get the names the island knows. Returns the event name.
///
/// Only events that cannot change what the agent does are hooked at all —
/// PreInvocation, PostToolUse, Stop — so there is no PreToolUse here: its
/// answer decides permissions, and Coucou must never do that unasked.
fn normalize_antigravity(map: &mut serde_json::Map<String, serde_json::Value>, arg_event: &str) -> String {
    if let Some(id) = map.remove("conversationId") {
        map.insert("session_id".into(), id);
    }
    let cwd = map
        .get("workspacePaths")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(str::to_string);
    if let Some(cwd) = cwd {
        map.insert("cwd".into(), serde_json::Value::String(cwd));
    }
    if let Some(path) = map.remove("transcriptPath") {
        map.insert("transcript_path".into(), path);
    }
    let failed = map
        .get("error")
        .and_then(|v| v.as_str())
        .map(|e| !e.is_empty())
        .unwrap_or(false);
    match arg_event {
        // The tool has run; its name is not in the payload (see read_event).
        "PostToolUse" => "ToolUsed",
        "Stop" if failed => "ErrorOccurred",
        other => other,
    }
    .to_string()
}

/// The person's request out of Antigravity's wrapper:
/// `<USER_REQUEST>…</USER_REQUEST><ADDITIONAL_METADATA>…`.
fn strip_user_request(content: &str) -> String {
    let inner = match (content.find("<USER_REQUEST>"), content.find("</USER_REQUEST>")) {
        (Some(a), Some(b)) if a + 14 <= b => &content[a + 14..b],
        _ => content,
    };
    inner.trim().chars().take(MAX_FIELD_FALLBACK).collect()
}

/// The newest line of the transcript tail for which `pick` finds something.
fn newest<T>(path: &std::path::Path, pick: impl Fn(&serde_json::Value) -> Option<T>) -> Option<T> {
    let tail = read_tail(path)?;
    tail.lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find_map(|v| pick(&v))
}

/// Antigravity: what the person last asked.
fn last_prompt(path: &std::path::Path) -> Option<String> {
    newest(path, |v| {
        (v.get("type")?.as_str()? == "USER_INPUT")
            .then(|| v.get("content").and_then(|c| c.as_str()).map(strip_user_request))
            .flatten()
            .filter(|s| !s.is_empty())
    })
}

/// Antigravity: the tool the agent last called, with its arguments.
fn last_tool_call(path: &std::path::Path) -> Option<(String, serde_json::Value)> {
    newest(path, |v| {
        let call = v.get("tool_calls")?.as_array()?.last()?;
        let name = call.get("name")?.as_str()?.to_string();
        Some((name, call.get("args").cloned().unwrap_or(serde_json::Value::Null)))
    })
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// Claude Code: https://code.claude.com/docs/en/hooks — the decision sits
/// inside `hookSpecificOutput`. Copilot CLI: the hooks reference wants the
/// bare `{"behavior": …}` object.
fn decision_json(decision: &str, agent: &str) -> Option<String> {
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not the CLI's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Coucou"}"#.to_string(),
        _ => return None,
    };
    if agent == "copilot" {
        return Some(behavior);
    }
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// Reads stdin and returns the payload to forward plus the event name.
fn read_event(agent: &str, arg_event: &str) -> Option<(String, String)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    // The event name is passed on the command line by the hook entry; the JSON
    // usually carries it too. Trust the argument when the JSON is missing it.
    if agent == "copilot" {
        normalize_copilot(map);
    }
    let event = if agent == "antigravity" {
        normalize_antigravity(map, arg_event)
    } else {
        map.get("hook_event_name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| arg_event.to_string())
    };
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    // Antigravity's payloads say when, not what: the prompt and the tool that
    // ran are in its transcript, so they are read from there.
    if agent == "antigravity" {
        let transcript = map
            .get("transcript_path")
            .and_then(|v| v.as_str())
            .map(std::path::PathBuf::from);
        match (event.as_str(), transcript) {
            ("PreInvocation", Some(path)) => {
                if let Some(prompt) = last_prompt(&path) {
                    map.insert("prompt".into(), serde_json::Value::String(prompt));
                }
            }
            ("ToolUsed", Some(path)) => {
                if let Some((name, args)) = last_tool_call(&path) {
                    map.insert("tool_name".into(), serde_json::Value::String(name));
                    map.insert("tool_input".into(), args);
                }
            }
            _ => {}
        }
    }
    // Which CLI is talking. Copilot's PascalCase hooks send Claude-shaped
    // payloads, so this is the one field that tells them apart.
    map.insert("agent".into(), serde_json::Value::String(agent.to_string()));

    // The Stop payload carries no reply, only where the transcript is. The
    // island wants to show what the agent just said, so the last assistant
    // message is read out of the transcript here, before the path is dropped.
    if event == "Stop" {
        let path = map
            .get("transcript_path")
            .and_then(|v| v.as_str())
            .map(std::path::PathBuf::from)
            .or_else(|| copilot_transcript(agent, map.get("session_id").and_then(|v| v.as_str())));
        if let Some(reply) = path.and_then(|p| last_reply(&p)) {
            map.insert("last_reply".into(), serde_json::Value::String(reply));
        }
    }

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou on Windows accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
        // Set by coucou-pty when the CLI runs inside it: the pipe the island
        // can type into this very terminal through.
        ("pty", "COUCOU_PTY"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    cap_payload(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event))
}

/// Copilot CLI keeps every session's events in a folder named after it. Its
/// Stop payload may or may not say so; the folder is where it always is.
fn copilot_transcript(agent: &str, session_id: Option<&str>) -> Option<std::path::PathBuf> {
    if agent != "copilot" {
        return None;
    }
    let id = session_id?;
    // A session id is a UUID; anything else must not become a path component.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let home = std::env::var_os("USERPROFILE")?;
    Some(std::path::PathBuf::from(home).join(".copilot").join("session-state").join(id).join("events.jsonl"))
}

/// The last thing the assistant said, from the tail of a JSONL transcript —
/// Claude Code's (`type: "assistant"`, text blocks in `message.content`) or
/// Copilot CLI's (`type: "assistant.message"`, a string in `data.content`).
///
/// Retries while the transcript still ends on the user's prompt: the reply
/// being stopped on is usually appended a moment after the hook fires, and
/// the previous turn's answer is worse than a short wait.
fn last_reply(path: &std::path::Path) -> Option<String> {
    let mut stale: Option<String> = None;
    for attempt in 0..=REPLY_RETRIES {
        match reply_in_tail(&read_tail(path)?) {
            Found::Fresh(reply) => return Some(reply),
            Found::Stale(reply) => stale = reply,
        }
        if attempt < REPLY_RETRIES {
            std::thread::sleep(REPLY_RETRY_WAIT);
        }
    }
    stale
}

fn read_tail(path: &std::path::Path) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TRANSCRIPT_TAIL))).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    Some(String::from_utf8_lossy(&tail).to_string())
}

enum Found {
    /// The newest reply, and it comes after the newest prompt.
    Fresh(String),
    /// The transcript ends on a prompt: the reply is not written yet. Carries
    /// the previous reply, if any, as the fallback.
    Stale(Option<String>),
}

/// Reading from the end: the first complete line that is a reply or a prompt
/// decides. A cut first line (we started mid-line) fails to parse and is
/// skipped.
fn reply_in_tail(text: &str) -> Found {
    let mut saw_prompt = false;
    for line in text.lines().rev() {
        match line_kind(line) {
            Line::Reply(reply) => {
                return if saw_prompt { Found::Stale(Some(reply)) } else { Found::Fresh(reply) };
            }
            Line::Prompt => saw_prompt = true,
            Line::Other => {}
        }
    }
    Found::Stale(None)
}

enum Line {
    Reply(String),
    Prompt,
    Other,
}

fn line_kind(line: &str) -> Line {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return Line::Other };
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match kind {
        // Copilot CLI, Antigravity.
        "user.message" | "USER_INPUT" => return Line::Prompt,
        // Claude Code also files tool results under "user"; only a prompt —
        // plain string content, or text blocks — counts as one.
        "user" => {
            let content = v.get("message").and_then(|m| m.get("content"));
            let is_prompt = match content {
                Some(serde_json::Value::String(_)) => true,
                Some(serde_json::Value::Array(blocks)) => {
                    blocks.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                }
                _ => false,
            };
            return if is_prompt { Line::Prompt } else { Line::Other };
        }
        _ => {}
    }
    match reply_in_value(&v, kind) {
        Some(reply) => Line::Reply(reply),
        None => Line::Other,
    }
}

fn reply_in_value(v: &serde_json::Value, kind: &str) -> Option<String> {
    let text = match kind {
        "assistant" => v
            .get("message")?
            .get("content")?
            .as_array()?
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        "assistant.message" => v.get("data")?.get("content")?.as_str()?.to_string(),
        // Antigravity: a planner step that says something (the ones that only
        // call tools have no content and are skipped below).
        "PLANNER_RESPONSE" => v.get("content")?.as_str()?.to_string(),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() {
        // A tool-call-only turn says nothing; keep looking further back.
        return None;
    }
    let mut out: String = text.chars().take(MAX_REPLY_LEN).collect();
    if out.len() < text.len() {
        out.push('…');
    }
    Some(out)
}

#[cfg(test)]
fn reply_in_line(line: &str) -> Option<String> {
    match line_kind(line) {
        Line::Reply(r) => Some(r),
        _ => None,
    }
}

/// Two cuts: a generous one, then the short one if the line would still be too
/// long for the pipe. Either way the payload says when it is no longer whole.
fn cap_payload(payload: &mut serde_json::Value) {
    let mut cut = truncate_strings(payload, MAX_FIELD_LEN);
    if payload.to_string().len() > MAX_LINE_LEN {
        cut |= truncate_strings(payload, FALLBACK_FIELD_LEN);
    }
    if cut {
        payload[TRUNCATED_FLAG] = serde_json::Value::Bool(true);
    }
}

/// Caps every string in the payload at `limit` bytes. A single Write can carry
/// a whole file. Returns whether anything was cut.
fn truncate_strings(value: &mut serde_json::Value, limit: usize) -> bool {
    match value {
        serde_json::Value::String(s) => {
            if s.len() <= limit {
                return false;
            }
            // Cut on a char boundary; a lone byte index can split UTF-8.
            let mut end = limit;
            while end > 0 && !s.is_char_boundary(end) {
                end -= 1;
            }
            s.truncate(end);
            s.push('…');
            true
        }
        serde_json::Value::Array(items) => items
            .iter_mut()
            .fold(false, |cut, item| truncate_strings(item, limit) || cut),
        serde_json::Value::Object(map) => map
            .values_mut()
            .fold(false, |cut, item| truncate_strings(item, limit) || cut),
        _ => false,
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow", "claude").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny", "claude").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always", "claude").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn copilot_gets_the_bare_behavior_object() {
        assert_eq!(decision_json("allow", "copilot").unwrap(), r#"{"behavior":"allow"}"#);
        assert_eq!(
            decision_json("deny", "copilot").unwrap(),
            r#"{"behavior":"deny","message":"Denied from Coucou"}"#
        );
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("", "claude").is_none());
        assert!(decision_json("maybe", "claude").is_none());
        assert!(decision_json("maybe", "copilot").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, "claude").is_none());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(40_000) } });
        assert!(truncate_strings(&mut v, MAX_FIELD_LEN));
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn a_whole_file_goes_through_untouched() {
        // 2 000 bytes used to be the cap, which turned every real Write into a
        // headline. A 50 KB file is what the island is there to show.
        let content = "x".repeat(50_000);
        let mut v = serde_json::json!({ "tool_input": { "content": content.clone() } });
        assert!(!truncate_strings(&mut v, MAX_FIELD_LEN));
        assert_eq!(v["tool_input"]["content"].as_str().unwrap(), content);
    }

    #[test]
    fn a_payload_that_is_whole_is_not_flagged() {
        let mut v = serde_json::json!({ "tool_input": { "content": "x".repeat(50_000) } });
        cap_payload(&mut v);
        assert!(v.get(TRUNCATED_FLAG).is_none());
    }

    #[test]
    fn a_cut_payload_is_flagged() {
        let mut v = serde_json::json!({ "tool_input": { "content": "x".repeat(70_000) } });
        cap_payload(&mut v);
        assert_eq!(v[TRUNCATED_FLAG], true);
        assert!(v["tool_input"]["content"].as_str().unwrap().len() <= MAX_FIELD_LEN + 4);
    }

    #[test]
    fn too_many_big_fields_fall_back_to_the_short_cut() {
        // Twenty 60 KB edits pass the per-field cap and still make a 1.2 MB line,
        // which Coucou would drop unread — and Claude Code would then wait the
        // full decision budget for an answer that can never come.
        let edits: Vec<_> = (0..20)
            .map(|_| serde_json::json!({ "old_string": "a", "new_string": "b".repeat(60_000) }))
            .collect();
        let mut v = serde_json::json!({ "tool_input": { "edits": edits } });
        cap_payload(&mut v);
        assert_eq!(v[TRUNCATED_FLAG], true);
        assert!(v.to_string().len() <= MAX_LINE_LEN);
        for edit in v["tool_input"]["edits"].as_array().unwrap() {
            assert!(edit["new_string"].as_str().unwrap().len() <= FALLBACK_FIELD_LEN + 4);
        }
    }

    #[test]
    fn the_last_reply_is_found_in_either_transcript_shape() {
        // Claude Code: the newest assistant line wins, tool-only turns are skipped.
        let claude = [
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"older"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done — "},{"type":"text","text":"three files changed."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,
        ];
        let found = claude.iter().rev().find_map(|l| reply_in_line(l)).unwrap();
        assert_eq!(found, "Done — \nthree files changed.");

        // Copilot CLI: data.content is a plain string.
        let copilot = r#"{"type":"assistant.message","data":{"content":"Still here and ready.","model":"glm"}}"#;
        assert_eq!(reply_in_line(copilot).unwrap(), "Still here and ready.");
        assert!(reply_in_line(r#"{"type":"assistant.turn_end","data":{}}"#).is_none());
        assert!(reply_in_line("{ cut off").is_none());
    }

    #[test]
    fn a_reply_written_before_the_newest_prompt_is_stale() {
        // Copilot: the Stop hook fired before the answer to "say hi" landed.
        let early = concat!(
            "{\"type\":\"user.message\",\"data\":{\"content\":\"test\"}}\n",
            "{\"type\":\"assistant.message\",\"data\":{\"content\":\"Works.\"}}\n",
            "{\"type\":\"user.message\",\"data\":{\"content\":\"say hi\"}}\n",
        );
        match reply_in_tail(early) {
            Found::Stale(Some(r)) => assert_eq!(r, "Works."),
            _ => panic!("the previous answer must be reported as stale"),
        }
        let late = format!("{early}{{\"type\":\"assistant.message\",\"data\":{{\"content\":\"Hi there!\"}}}}\n");
        match reply_in_tail(&late) {
            Found::Fresh(r) => assert_eq!(r, "Hi there!"),
            _ => panic!("the answer after the prompt is fresh"),
        }

        // Claude Code: a tool_result "user" line is not a prompt.
        let claude = concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"do it\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\"}]}}\n",
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"ok\"}]}}\n",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Done.\"}]}}\n",
        );
        match reply_in_tail(claude) {
            Found::Fresh(r) => assert_eq!(r, "Done."),
            _ => panic!("the final text after a tool round trip is fresh"),
        }
    }

    #[test]
    fn copilot_1_0_91_payloads_are_put_into_the_islands_words() {
        let mut v = serde_json::json!({
            "sessionId": "097a", "cwd": "D:/Code/DemoLight",
            "toolCalls": [{ "id": "call_1", "name": "ask_user", "args": { "message": "Now what?" } }]
        });
        normalize_copilot(v.as_object_mut().unwrap());
        assert_eq!(v["session_id"], "097a");
        assert_eq!(v["tool_name"], "ask_user");
        assert_eq!(v["tool_input"]["message"], "Now what?");
        assert!(v.get("sessionId").is_none());

        // The older, Claude-shaped payload is left as it is.
        let mut old = serde_json::json!({ "session_id": "a", "tool_name": "Bash", "tool_input": { "command": "ls" } });
        normalize_copilot(old.as_object_mut().unwrap());
        assert_eq!(old["tool_name"], "Bash");
        assert_eq!(old["tool_input"]["command"], "ls");
    }

    #[test]
    fn antigravity_is_put_into_the_islands_words() {
        let mut v = serde_json::json!({
            "conversationId": "ec33", "workspacePaths": ["D:\\Code\\FPS", "D:\\other"],
            "transcriptPath": "C:\\t\\transcript.jsonl", "stepIdx": 5
        });
        let event = normalize_antigravity(v.as_object_mut().unwrap(), "PostToolUse");
        assert_eq!(event, "ToolUsed");
        assert_eq!(v["session_id"], "ec33");
        assert_eq!(v["cwd"], "D:\\Code\\FPS");
        assert_eq!(v["transcript_path"], "C:\\t\\transcript.jsonl");
        assert!(v.get("conversationId").is_none());

        let mut stop = serde_json::json!({ "conversationId": "x", "terminationReason": "error", "error": "boom" });
        assert_eq!(normalize_antigravity(stop.as_object_mut().unwrap(), "Stop"), "ErrorOccurred");
        let mut ok = serde_json::json!({ "conversationId": "x", "terminationReason": "model_stop", "error": "" });
        assert_eq!(normalize_antigravity(ok.as_object_mut().unwrap(), "Stop"), "Stop");
        let mut pre = serde_json::json!({ "conversationId": "x", "invocationNum": 1 });
        assert_eq!(normalize_antigravity(pre.as_object_mut().unwrap(), "PreInvocation"), "PreInvocation");
    }

    #[test]
    fn antigravity_transcripts_give_the_prompt_the_tool_and_the_reply() {
        let dir = std::env::temp_dir().join(format!("coucou-agy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("transcript.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"<USER_REQUEST>\\nlist the files\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>\"}\n",
                "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"list_dir\",\"args\":{\"DirectoryPath\":\"D:\\\\Code\"}}]}\n",
                "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"GENERIC\",\"status\":\"DONE\",\"content\":\"a.txt\"}\n",
            ),
        )
        .unwrap();
        assert_eq!(last_prompt(&path).unwrap(), "list the files");
        let (name, args) = last_tool_call(&path).unwrap();
        assert_eq!(name, "list_dir");
        assert_eq!(args["DirectoryPath"], "D:\\Code");
        // No planner step has spoken yet: the tail ends on the prompt, so stale with nothing.
        assert!(matches!(reply_in_tail(&std::fs::read_to_string(&path).unwrap()), Found::Stale(None)));

        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{\"step_index\":3,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"content\":\"There is one file: a.txt\"}\n");
        match reply_in_tail(&text) {
            Found::Fresh(r) => assert_eq!(r, "There is one file: a.txt"),
            _ => panic!("the planner's answer after the prompt is fresh"),
        }
        assert_eq!(strip_user_request("plain"), "plain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_reply_is_cut_with_an_ellipsis() {
        let line = format!(r#"{{"type":"assistant.message","data":{{"content":"{}"}}}}"#, "x".repeat(MAX_REPLY_LEN + 1000));
        let out = reply_in_line(&line).unwrap();
        assert!(out.ends_with('…'));
        assert!(out.chars().count() == MAX_REPLY_LEN + 1);
    }

    #[test]
    fn the_copilot_transcript_path_is_derived_only_from_a_tame_session_id() {
        std::env::set_var("USERPROFILE", r"C:\Users\test");
        let p = copilot_transcript("copilot", Some("2da23453-5236-436d-86e5-a54af110657d")).unwrap();
        assert!(p.ends_with(r"session-state\2da23453-5236-436d-86e5-a54af110657d\events.jsonl"));
        assert!(copilot_transcript("claude", Some("abc")).is_none());
        assert!(copilot_transcript("copilot", Some(r"..\..\etc")).is_none());
        assert!(copilot_transcript("copilot", None).is_none());
    }

    #[test]
    fn the_cut_is_reported_through_nested_values() {
        let mut v = serde_json::json!({
            "tool_input": { "edits": [ { "old_string": "a", "new_string": "b".repeat(70_000) } ] }
        });
        assert!(truncate_strings(&mut v, MAX_FIELD_LEN));
        assert_eq!(v["tool_input"]["edits"][0]["old_string"], "a");
        assert!(v["tool_input"]["edits"][0]["new_string"].as_str().unwrap().ends_with('…'));
    }
}
