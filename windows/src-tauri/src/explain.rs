// 「Ask」on a permission card: the secretary's model reads the request and
// tells the person what it is for and what it risks — before they choose.
//
// It is a single question with no tools: explaining must never be able to
// touch a team or a file. What keeps it from guessing is what it is given —
// the request in full, Coucou's own rule-based reading of it (inside or
// outside the work folder, deletes, installs, sends out…), the rule of the
// person's constitution it matched, the team working in that folder if any,
// and the tail of the session's own transcript (what the agent was doing and
// why). It is told to say what it cannot tell rather than fill the gap.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use crate::policy::{self, Danger, Scope};

/// The payloads of the cards still waiting, by request id: what Ask explains.
#[derive(Default)]
pub struct Asked(pub Mutex<HashMap<String, Value>>);

const MAX_INPUT: usize = 9_000;
const MAX_TRANSCRIPT: usize = 7_000;

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…(cut, {} more bytes)", &s[..end], s.len() - end)
}

// i18n: model-facing
fn danger_word(d: &Danger) -> &'static str {
    match d {
        Danger::DeletesFolder => "deletes a folder or deletes recursively",
        Danger::DeletesMany => "deletes several files at once or by wildcard",
        Danger::Installs => "installs a package, tool or program",
        Danger::Downloads => "downloads something from the network onto the disk",
        Danger::DestructiveGit => "a git command that throws work away",
        Danger::SendsOut => "sends something off this machine (push, publish, mail, upload)",
        Danger::OutsideWorkDir => "touches a path outside the session's folder",
        Danger::System => "changes the system (registry, services, processes, privileges)",
        Danger::Opaque => "could not be read well enough to call it safe",
    }
}

/// The last part of the session's transcript (JSONL), from the start of a line.
fn transcript_tail(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(MAX_TRANSCRIPT as u64 * 3))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let start = buf.iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0);
    let text = String::from_utf8_lossy(&buf[start..]).to_string();
    // Keep the newest lines that fit.
    let mut out: Vec<&str> = Vec::new();
    let mut size = 0;
    for line in text.lines().rev() {
        if size + line.len() > MAX_TRANSCRIPT {
            break;
        }
        size += line.len();
        out.push(line);
    }
    out.reverse();
    Some(out.join("\n"))
}

/// Everything the explanation may stand on, as one plain-text brief.
// i18n: model-facing
pub fn brief(payload: &Value, teams: &[crate::team::state::Snapshot]) -> String {
    let tool = payload.get("tool_name").and_then(Value::as_str).unwrap_or("(unknown tool)");
    let agent = payload.get("agent").and_then(Value::as_str).unwrap_or("a coding CLI");
    let cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("");
    let input = payload.get("tool_input").cloned().unwrap_or(Value::Null);
    let input_text = serde_json::to_string_pretty(&input).unwrap_or_default();

    let mut b = String::new();
    b.push_str(&format!("AGENT: {agent} (on Windows; shell commands run in PowerShell unless the tool says otherwise)\n"));
    b.push_str(&format!("TOOL: {tool}\n"));
    b.push_str(&format!("SESSION FOLDER (cwd): {}\n", if cwd.is_empty() { "(not given)" } else { cwd }));

    // Coucou's own reading, by its rules (not the model's).
    let request = crate::constitution::request_from_hook(payload);
    if !cwd.is_empty() {
        let dangers = policy::dangers_of(&Scope::new(PathBuf::from(cwd)), &request);
        if dangers.is_empty() {
            b.push_str("COUCOU'S RULE CHECK: nothing flagged (stays inside the session folder, no delete/install/download/send-out/system change detected).\n");
        } else {
            let words: Vec<&str> = dangers.iter().map(danger_word).collect();
            b.push_str(&format!("COUCOU'S RULE CHECK flags: {}.\n", words.join("; ")));
        }
    }
    if !request.paths.is_empty() {
        b.push_str(&format!("PATHS NAMED: {}\n", request.paths.join(", ")));
    }
    if let Some(rule) = payload.get("constitution").and_then(|c| c.get("rule")).and_then(Value::as_str) {
        b.push_str(&format!("THE USER'S CONSTITUTION asks about this, by the rule: {rule}\n"));
    }

    // A team working in that folder, if any.
    let norm = |p: &str| p.trim_end_matches(['\\', '/']).to_lowercase();
    if let Some(t) = teams.iter().find(|t| !cwd.is_empty() && !t.work_dir.is_empty() && norm(cwd).starts_with(&norm(&t.work_dir))) {
        b.push_str(&format!("A COUCOU TEAM WORKS IN THIS FOLDER: \"{}\" — goal: {}\n", t.name, clip(&t.goal, 600)));
        let members: Vec<String> = t.members.iter().map(|m| format!("{} ({})", m.name, m.role)).collect();
        if !members.is_empty() {
            b.push_str(&format!("  members: {}\n", members.join(", ")));
        }
    }

    b.push_str("\nTHE REQUEST, IN FULL (tool_input):\n");
    b.push_str(&clip(&input_text, MAX_INPUT));
    b.push('\n');

    if let Some(path) = payload.get("transcript_path").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        match transcript_tail(Path::new(path)) {
            Some(tail) if !tail.trim().is_empty() => {
                b.push_str("\nWHAT THE AGENT WAS DOING (the newest part of its own transcript, JSON lines):\n");
                b.push_str(&tail);
                b.push('\n');
            }
            _ => b.push_str("\n(The session transcript could not be read.)\n"),
        }
    } else {
        b.push_str("\n(No transcript was given with this request.)\n");
    }
    b
}

/// A team member's card, read the same way: the request as the agent sent it,
/// Coucou's verdict on it, the member's task, and its own live screen as the
/// account of what it was doing.
// i18n: model-facing
pub fn team_brief(snap: &crate::team::state::Snapshot, member: &str, request_json: &str) -> Option<String> {
    use crate::team::screen::LineKind;
    let m = snap.members.iter().find(|m| m.id == member)?;
    let wanted: Value = serde_json::from_str(request_json).unwrap_or(Value::Null);
    let perm = m.permission.iter().chain(m.more_permissions.iter()).find(|p| p.request_id == wanted).or(m.permission.as_ref())?;
    let payload = serde_json::json!({
        "agent": format!("team member \"{}\" ({}) of the Coucou team \"{}\", running {} {}", m.name, m.role, snap.name, m.agent, m.model),
        "tool_name": if perm.title.is_empty() { perm.kind.clone() } else { format!("{} — {}", perm.kind, perm.title) },
        "cwd": snap.work_dir,
        "tool_input": perm.raw_input,
        "constitution": perm.rule.as_ref().map(|r| serde_json::json!({ "rule": r })),
    });
    let mut b = brief(&payload, std::slice::from_ref(snap));
    if let Some(d) = &perm.danger {
        b.push_str(&format!("\nTHE TEAM'S OWN POLICY held this for the person because it {}.\n", danger_word(d)));
    } else {
        b.push_str("\nTHE TEAM'S OWN POLICY held this for the person (step-by-step mode, or the constitution asks).\n");
    }
    if let Some(task) = m.task.as_ref().and_then(|t| snap.tasks.iter().find(|x| &x.id == t)) {
        b.push_str(&format!("THE MEMBER'S TASK: {} {} — {}\n", task.id, task.title, clip(&task.detail, 900)));
    }
    let lines: Vec<String> = m
        .screen
        .iter()
        .rev()
        .take(30)
        .map(|l| {
            let tag = match l.kind {
                LineKind::Say => "said",
                LineKind::Think => "thought",
                LineKind::Tool => "tool",
                LineKind::Turn => "turn",
            };
            format!("[{tag}] {}", clip(&l.text, 600))
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if !lines.is_empty() {
        b.push_str("\nWHAT THE MEMBER WAS DOING (its own live screen, oldest first):\n");
        b.push_str(&clip(&lines.join("\n"), MAX_TRANSCRIPT));
        b.push('\n');
    }
    Some(b)
}

/// The team member's card, explained.
pub async fn explain_team(provider: &crate::llm::Provider, snap: &crate::team::state::Snapshot, member: &str, request_json: &str) -> Result<String, String> {
    let brief = team_brief(snap, member, request_json)
        .ok_or_else(|| -> String { tr!("這個請求已經不在等待了。", "This request is no longer waiting.") })?;
    let chat = crate::llm::Chat::default();
    let reply = crate::llm::send(&chat, provider, format!("{}\n\n=== BRIEF ===\n{brief}", system()), None, None).await?;
    Ok(reply.text)
}

/// The explanation is read by the person, so it comes in the app's language;
/// the sections are named in that language too.
// i18n: model-facing
fn system() -> &'static str {
    if crate::i18n::is_zh() {
        SYSTEM
    } else {
        SYSTEM_EN
    }
}

// i18n: model-facing
pub const SYSTEM: &str = "You help a person decide whether to allow a coding agent's request on their Windows computer. \
Answer in Traditional Chinese (繁體中文), plainly, for someone who may not read code. Use exactly these sections:\n\
【目的】what the agent is trying to achieve and why now (from its transcript and the request).\n\
【會做什麼】step by step, what this exact command or edit does when allowed.\n\
【影響範圍】which files/folders it reads, writes or deletes; whether it stays inside the session folder; whether it uses the network.\n\
【風險】低 / 中 / 高, then the reasons. Say whether the effect can be undone.\n\
【建議】同意 / 拒絕 / 先確認某件事 — and why in one or two sentences.\n\
【不確定的地方】what you cannot tell from what you were given (omit the section if nothing).\n\
Rules: rely only on the brief. Coucou's rule check is computed by code and is reliable — never contradict it. \
Do not invent files, intentions or effects. If the brief does not let you tell, say so instead of guessing. Keep it under 250 Chinese characters per section.";

// i18n: model-facing
pub const SYSTEM_EN: &str = "You help a person decide whether to allow a coding agent's request on their Windows computer. \
Answer in English, plainly, for someone who may not read code. Use exactly these sections:\n\
[Purpose] what the agent is trying to achieve and why now (from its transcript and the request).\n\
[What it does] step by step, what this exact command or edit does when allowed.\n\
[What it touches] which files/folders it reads, writes or deletes; whether it stays inside the session folder; whether it uses the network.\n\
[Risk] Low / Medium / High, then the reasons. Say whether the effect can be undone.\n\
[Advice] Allow / Deny / Check something first — and why in one or two sentences.\n\
[Not sure] what you cannot tell from what you were given (omit the section if nothing).\n\
Rules: rely only on the brief. Coucou's rule check is computed by code and is reliable — never contradict it. \
Do not invent files, intentions or effects. If the brief does not let you tell, say so instead of guessing. Keep it under 120 words per section.";

/// The question the secretary's model is asked, and the model to ask it.
pub async fn explain(provider: &crate::llm::Provider, payload: &Value, teams: &[crate::team::state::Snapshot]) -> Result<String, String> {
    let chat = crate::llm::Chat::default();
    let question = format!("{}\n\n=== BRIEF ===\n{}", system(), brief(payload, teams));
    let reply = crate::llm::send(&chat, provider, question, None, None).await?;
    Ok(reply.text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_brief_carries_the_request_the_rule_check_and_the_folder() {
        let payload = json!({
            "agent": "copilot",
            "tool_name": "powershell",
            "cwd": "D:\\Work\\Demo",
            "tool_input": { "command": "Remove-Item -Recurse -Force C:\\Users\\x\\Documents\\old", "description": "clean up" },
        });
        let b = brief(&payload, &[]);
        assert!(b.contains("TOOL: powershell"));
        assert!(b.contains("Remove-Item -Recurse"));
        assert!(b.contains("RULE CHECK flags"), "a recursive delete outside the folder must be flagged: {b}");
        assert!(b.contains("No transcript"));
    }

    #[test]
    fn a_harmless_read_inside_the_folder_is_not_flagged() {
        let payload = json!({ "tool_name": "view", "cwd": "D:\\Work\\Demo", "tool_input": { "path": "D:\\Work\\Demo\\index.html" } });
        assert!(brief(&payload, &[]).contains("nothing flagged"));
    }
}
