// What each member's agent is doing, line by line, for the live screens of
// the Teamwork window: what it says as it says it, each tool it runs and what
// that printed, and where each of its turns began and ended.
//
// The drivers all speak the same updates (ACP's `session/update` shapes, which
// codex.rs and claude.rs translate into). Nothing here is written down: it is
// a view of the sessions, the last few hundred lines, for as long as Coucou
// runs.

use std::collections::{BTreeSet, VecDeque};

use serde::Serialize;
use serde_json::{json, Value};

/// Lines kept per member.
const KEEP: usize = 300;
/// Characters kept of what one tool printed: the end, where results are.
const OUTPUT_TAIL: usize = 1500;
/// Characters kept of one thing a teammate said, in a turn's opening line.
const HEARD_TEXT: usize = 240;

/// Coucou's own team tools, as the agents call them.
pub const TEAM_TOOLS: &[&str] =
    &["team_status", "task_create", "task_assign", "set_reviewer", "team_finish", "task_update", "task_block", "deliver", "review", "message_send", "ask_human"];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Say,
    Think,
    Tool,
    Turn,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// Its number on the member's screen; a changed line is sent again under it.
    pub n: u64,
    /// When it appeared.
    pub since: u64,
    /// When it last changed: what an agent's last sign of life is read from.
    pub at: u64,
    pub kind: LineKind,
    /// Say and think: the text so far. Tool: its title. Turn: the turn's number.
    pub text: String,
    /// Tool: read, edit, execute… as the agent called it.
    pub tool: String,
    /// Tool: which of Coucou's team tools, else empty.
    pub team_tool: String,
    /// Tool: what it was called with. Turn: what the member heard, `[{from, text}]`.
    pub input: Value,
    /// Tool: "running", "done" or "failed". Turn: "start", "end" or "failed".
    pub status: String,
    /// Tool: the end of what it printed. Turn: why it failed.
    pub output: String,
    #[serde(skip)]
    id: String,
}

/// One member's screen.
#[derive(Debug, Default)]
pub struct Screen {
    lines: VecDeque<Line>,
    next: u64,
    /// Lines changed since the window last heard, by number.
    dirty: BTreeSet<u64>,
    /// The last said or thought line is still being written.
    open: bool,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn tail(text: &str, keep: usize) -> String {
    let count = text.chars().count();
    if count <= keep {
        return text.to_string();
    }
    let cut: String = text.chars().skip(count - keep).collect();
    format!("…{cut}")
}

fn head(text: &str, keep: usize) -> String {
    if text.chars().count() <= keep {
        return text.to_string();
    }
    let cut: String = text.chars().take(keep).collect();
    format!("{cut}…")
}

/// ACP's statuses, in the screen's three words.
fn status_of(update: &Value) -> Option<&'static str> {
    Some(match update.get("status").and_then(Value::as_str)? {
        "completed" => "done",
        "failed" | "declined" | "cancelled" => "failed",
        _ => "running",
    })
}

/// "coucou-team.task_create", "mcp__coucou-team__deliver", "deliver"… → the
/// team tool's name.
pub fn team_tool(title: &str) -> String {
    let lower = title.to_ascii_lowercase();
    let ours = lower.contains(crate::acp::TEAM_SERVER);
    TEAM_TOOLS
        .iter()
        .find(|t| lower == **t || (ours && lower.ends_with(**t)))
        .map(|t| t.to_string())
        .unwrap_or_default()
}

/// The text of an ACP tool update's `content`: what was printed, or what was edited.
fn content_text(update: &Value) -> Option<String> {
    let items = update.get("content")?.as_array()?;
    let mut out = Vec::new();
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("content") => {
                if let Some(t) = item.pointer("/content/text").and_then(Value::as_str) {
                    out.push(t.to_string());
                }
            }
            Some("diff") => {
                if let Some(p) = item.get("path").and_then(Value::as_str) {
                    out.push(format!("± {p}"));
                }
            }
            _ => {}
        }
    }
    (!out.is_empty()).then(|| out.join("\n"))
}

impl Screen {
    fn push(&mut self, kind: LineKind, text: String) -> &mut Line {
        self.next += 1;
        let n = self.next;
        let at = now();
        self.lines.push_back(Line {
            n,
            since: at,
            at,
            kind,
            text,
            tool: String::new(),
            team_tool: String::new(),
            input: Value::Null,
            status: String::new(),
            output: String::new(),
            id: String::new(),
        });
        while self.lines.len() > KEEP {
            if let Some(gone) = self.lines.pop_front() {
                self.dirty.remove(&gone.n);
            }
        }
        self.dirty.insert(n);
        self.open = false;
        self.lines.back_mut().unwrap()
    }

    fn find(&mut self, id: &str) -> Option<&mut Line> {
        if id.is_empty() {
            return None;
        }
        self.lines.iter_mut().rev().find(|l| l.kind == LineKind::Tool && l.id == id)
    }

    /// The last `count` lines.
    pub fn lines(&self, count: usize) -> Vec<Line> {
        self.lines.iter().skip(self.lines.len().saturating_sub(count)).cloned().collect()
    }

    /// The lines changed since the last call.
    pub fn take_changed(&mut self) -> Vec<Line> {
        let changed = std::mem::take(&mut self.dirty);
        self.lines.iter().filter(|l| changed.contains(&l.n)).cloned().collect()
    }

    /// A turn begins, with what the member is hearing in it.
    pub fn turn_started(&mut self, number: u32, heard: Vec<(String, String)>) {
        let heard: Vec<Value> = heard.into_iter().map(|(from, text)| json!({ "from": from, "text": head(&text, HEARD_TEXT) })).collect();
        let line = self.push(LineKind::Turn, number.to_string());
        line.status = "start".into();
        line.input = Value::Array(heard);
    }

    pub fn turn_ended(&mut self, number: u32, failed: Option<&str>) {
        // A tool still running when the turn ends never finished.
        for line in self.lines.iter_mut().filter(|l| l.kind == LineKind::Tool && l.status == "running") {
            line.status = "failed".into();
            line.at = now();
            self.dirty.insert(line.n);
        }
        let line = self.push(LineKind::Turn, number.to_string());
        line.status = if failed.is_some() { "failed".into() } else { "end".into() };
        line.output = failed.map(|f| head(f, 400)).unwrap_or_default();
    }

    /// One update from the member's agent. True when the screen changed.
    pub fn update(&mut self, update: &Value) -> bool {
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
        match kind {
            "agent_message_chunk" | "agent_thought_chunk" => {
                let text = update.pointer("/content/text").and_then(Value::as_str).unwrap_or("");
                if text.is_empty() {
                    return false;
                }
                let kind = if kind == "agent_message_chunk" { LineKind::Say } else { LineKind::Think };
                let open = self.open;
                match self.lines.back_mut() {
                    Some(last) if open && last.kind == kind => {
                        last.text.push_str(text);
                        last.at = now();
                        let n = last.n;
                        self.dirty.insert(n);
                    }
                    _ => {
                        self.push(kind, text.to_string());
                        self.open = true;
                    }
                }
                true
            }
            "tool_call" => {
                let id = update.get("toolCallId").and_then(Value::as_str).unwrap_or("").to_string();
                let title = update.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                let status = status_of(update).unwrap_or("running");
                if let Some(line) = self.find(&id) {
                    line.at = now();
                    if !title.is_empty() {
                        line.team_tool = team_tool(&title);
                        line.text = title;
                    }
                    line.status = status.into();
                    if let Some(input) = update.get("rawInput").filter(|v| !v.is_null()) {
                        line.input = input.clone();
                    }
                    let n = line.n;
                    self.dirty.insert(n);
                    self.open = false;
                    return true;
                }
                let line = self.push(LineKind::Tool, title.clone());
                line.id = id;
                line.team_tool = team_tool(&title);
                line.tool = update.get("kind").and_then(Value::as_str).unwrap_or("other").to_string();
                line.status = status.into();
                line.input = update.get("rawInput").cloned().unwrap_or(Value::Null);
                true
            }
            "tool_call_update" => {
                let id = update.get("toolCallId").and_then(Value::as_str).unwrap_or("").to_string();
                let Some(line) = self.find(&id) else { return false };
                line.at = now();
                if let Some(status) = status_of(update) {
                    line.status = status.into();
                }
                if let Some(title) = update.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    line.team_tool = team_tool(title);
                    line.text = title.to_string();
                }
                if let Some(text) = content_text(update) {
                    line.output = tail(&text, OUTPUT_TAIL);
                }
                if let Some(delta) = update.get("outputDelta").and_then(Value::as_str) {
                    line.output = tail(&format!("{}{delta}", line.output), OUTPUT_TAIL);
                }
                let n = line.n;
                self.dirty.insert(n);
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(text: &str) -> Value {
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } })
    }

    #[test]
    fn what_an_agent_says_grows_one_line_until_it_does_something_else() {
        let mut s = Screen::default();
        s.turn_started(1, vec![("ai1".into(), "TASK-01 is yours".into())]);
        assert!(s.update(&chunk("我先看")));
        assert!(s.update(&chunk("一下看板")));
        assert!(s.update(&json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "coucou-team.team_status", "kind": "other", "status": "in_progress" })));
        assert!(s.update(&chunk("好了")));
        let lines = s.lines(10);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0].kind, LineKind::Turn);
        assert_eq!(lines[0].input[0]["from"], "ai1");
        assert_eq!(lines[1].text, "我先看一下看板");
        assert_eq!(lines[2].team_tool, "team_status");
        assert_eq!(lines[3].text, "好了");
    }

    #[test]
    fn a_tool_is_one_line_from_start_to_result() {
        let mut s = Screen::default();
        s.update(&json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "npm test", "kind": "execute", "status": "in_progress" }));
        s.take_changed();
        s.update(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "outputDelta": "PASS a\n" }));
        s.update(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "outputDelta": "PASS b\n" }));
        let changed = s.take_changed();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].output, "PASS a\nPASS b\n");
        assert_eq!(changed[0].status, "running");
        s.update(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "failed", "content": [{ "type": "content", "content": { "type": "text", "text": "exit 1" } }] }));
        let line = &s.lines(1)[0];
        assert_eq!((line.status.as_str(), line.output.as_str()), ("failed", "exit 1"));
        assert!(s.take_changed().len() == 1 && s.take_changed().is_empty());
    }

    #[test]
    fn a_turn_that_ends_leaves_no_tool_running() {
        let mut s = Screen::default();
        s.update(&json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "sleep", "kind": "execute" }));
        s.turn_ended(1, Some("interrupted"));
        let lines = s.lines(5);
        assert_eq!(lines[0].status, "failed");
        assert_eq!((lines[1].status.as_str(), lines[1].output.as_str()), ("failed", "interrupted"));
    }

    #[test]
    fn team_tools_are_known_by_every_agent_s_spelling() {
        assert_eq!(team_tool("coucou-team.task_create"), "task_create");
        assert_eq!(team_tool("mcp__coucou-team__deliver"), "deliver");
        assert_eq!(team_tool("message_send"), "message_send");
        assert_eq!(team_tool("npm run deliver"), "");
    }

    #[test]
    fn only_the_last_lines_are_kept_and_long_output_keeps_its_end() {
        let mut s = Screen::default();
        for i in 0..(KEEP + 20) {
            s.update(&json!({ "sessionUpdate": "tool_call", "toolCallId": format!("t{i}"), "title": format!("step {i}") }));
        }
        assert_eq!(s.lines(usize::MAX).len(), KEEP);
        assert_eq!(s.take_changed().len(), KEEP);
        let long = "x".repeat(OUTPUT_TAIL * 2) + "END";
        s.update(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": format!("t{}", KEEP + 19), "outputDelta": long }));
        assert!(s.lines(1)[0].output.ends_with("END"));
        assert!(s.lines(1)[0].output.chars().count() <= OUTPUT_TAIL + 1);
    }
}
