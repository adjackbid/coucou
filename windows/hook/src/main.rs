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
//! Usage: `coucou-hook <EventName>` (the name is also read from the JSON).

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

fn main() {
    let Some((payload, event)) = read_event() else { std::process::exit(0) };

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
        if let Some(json) = decision_json(&decision) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
fn decision_json(decision: &str) -> Option<String> {
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not Claude Code's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Coucou"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// Reads stdin and returns the payload to forward plus the event name.
fn read_event() -> Option<(String, String)> {
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

    // The event name is passed as argv[1] by the hook command; the JSON usually
    // carries it too. Trust argv when the JSON is missing it.
    let arg_event = std::env::args().nth(1).unwrap_or_default();
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

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
            decision_json("allow").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("").is_none());
        assert!(decision_json("maybe").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#).is_none());
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
    fn the_cut_is_reported_through_nested_values() {
        let mut v = serde_json::json!({
            "tool_input": { "edits": [ { "old_string": "a", "new_string": "b".repeat(70_000) } ] }
        });
        assert!(truncate_strings(&mut v, MAX_FIELD_LEN));
        assert_eq!(v["tool_input"]["edits"][0]["old_string"], "a");
        assert!(v["tool_input"]["edits"][0]["new_string"].as_str().unwrap().ends_with('…'));
    }
}
