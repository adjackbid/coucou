//! coucou-team-mcp — a team member's tools, as an MCP server its CLI can start.
//!
//! There is nothing in here but a relay. A CLI starts MCP servers itself, as
//! child processes speaking JSON-RPC on stdio; the team's state lives in
//! Coucou. So this process connects to Coucou's pipe, says which member it
//! speaks for (`COUCOU_TEAM`, `COUCOU_MEMBER`, `COUCOU_TEAM_TOKEN`, set by
//! Coucou when it started the CLI), and passes each line through: a request
//! goes in, its one answer comes back out.
//!
//! The CLI is never left waiting. If Coucou is closed, or does not know this
//! member, every request is answered here with an error saying so.

#[path = "../../hook/src/win.rs"]
mod win;

use std::io::{BufRead, BufReader, Write};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const ERROR_PIPE_BUSY: i32 = 231;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// `\\.\pipe\coucou-team-<sid>` — must match `team::mcp::pipe_name()`.
fn pipe_path() -> String {
    let key = win::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-team-{key}")
}

fn open_pipe() -> Option<std::fs::File> {
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
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

/// Coucou's end of the pipe: lines out, lines back.
struct Link {
    write: std::fs::File,
    read: BufReader<std::fs::File>,
}

impl Link {
    fn send(&mut self, line: &str) -> std::io::Result<()> {
        self.write.write_all(line.as_bytes())?;
        self.write.write_all(b"\n")?;
        self.write.flush()
    }

    fn receive(&mut self) -> std::io::Result<String> {
        let mut line = String::new();
        if self.read.read_line(&mut line)? == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        Ok(line.trim_end().to_string())
    }
}

/// Connects and introduces this member. `Err` is why the tools cannot work.
fn connect() -> Result<Link, String> {
    let env = |name: &str| std::env::var(name).unwrap_or_default();
    let (team, member, token) = (env("COUCOU_TEAM"), env("COUCOU_MEMBER"), env("COUCOU_TEAM_TOKEN"));
    if team.is_empty() || member.is_empty() {
        return Err("This session was not started by a Coucou team.".into());
    }
    let file = open_pipe().ok_or("Coucou is not running, so the team's tools are not available.")?;
    let read = file.try_clone().map_err(|e| e.to_string())?;
    let mut link = Link { write: file, read: BufReader::new(read) };
    link.send(&json!({ "team": team, "member": member, "token": token }).to_string()).map_err(|e| e.to_string())?;
    let welcome: Value = serde_json::from_str(&link.receive().map_err(|e| e.to_string())?).unwrap_or(Value::Null);
    if welcome.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(link)
    } else {
        Err(welcome.get("error").and_then(Value::as_str).unwrap_or("Coucou did not recognise this session.").to_string())
    }
}

fn refusal(id: &Value, why: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": why } }).to_string()
}

/// `--gate`: Antigravity's PreToolUse hook. The step it is about to take
/// comes on stdin; the team decides (the rules, or the person on a card);
/// the decision goes to stdout. Outside a team it changes nothing: "ask" is
/// what Antigravity would have done anyway. Coucou out of reach: refused —
/// a member that cannot be watched does not run unchecked.
fn gate() {
    use std::io::Read;
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let payload: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let call = payload.get("toolCall").cloned().unwrap_or(Value::Null);
    let decision = if std::env::var("COUCOU_TEAM").map(|v| v.is_empty()).unwrap_or(true) {
        json!({ "decision": "ask" })
    } else {
        match connect() {
            Ok(mut link) => {
                let request = json!({ "jsonrpc": "2.0", "id": 1, "method": "coucou/gate", "params": { "tool": call.get("name"), "args": call.get("args") } });
                match link.send(&request.to_string()).and_then(|_| link.receive()) {
                    Ok(line) => serde_json::from_str::<Value>(&line).ok().and_then(|v| v.get("result").cloned()).unwrap_or_else(|| json!({ "decision": "deny", "reason": "Coucou gave no answer." })),
                    Err(_) => json!({ "decision": "deny", "reason": "Coucou was closed while this step waited." }),
                }
            }
            Err(why) => json!({ "decision": "deny", "reason": why }),
        }
    };
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{decision}");
    let _ = out.flush();
}

fn main() {
    if std::env::args().any(|a| a == "--gate") {
        return gate();
    }
    let mut link = connect();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        // Only a request (it has an id) is answered; a notification is not.
        let id = serde_json::from_str::<Value>(&line).ok().and_then(|m| m.get("id").filter(|id| !id.is_null()).cloned());
        let reply = match &mut link {
            Ok(pipe) => {
                let passed = pipe.send(&line).and_then(|_| if id.is_some() { pipe.receive().map(Some) } else { Ok(None) });
                match passed {
                    Ok(reply) => reply,
                    Err(_) => {
                        link = Err("Coucou was closed, so the team's tools are no longer available.".into());
                        id.as_ref().map(|id| refusal(id, "Coucou was closed, so the team's tools are no longer available."))
                    }
                }
            }
            Err(why) => id.as_ref().map(|id| refusal(id, why)),
        };
        if let Some(reply) = reply {
            if writeln!(stdout, "{reply}").and_then(|_| stdout.flush()).is_err() {
                break;
            }
        }
    }
}
