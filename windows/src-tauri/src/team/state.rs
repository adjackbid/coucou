// What happened in a team, and what it adds up to.
//
// Every change is an event. The state is nothing but the events applied in
// order, so the screens can be rebuilt after a restart and every number on
// them can be traced: progress is accepted tasks over all tasks, "waiting for
// AI 3" is a dependency that has not been delivered. Nothing is inferred from
// what a member happened to write.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{TeamConfig, SYSTEM, YOU};
use crate::policy::Danger;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TeamStatus {
    #[default]
    Idle,
    Running,
    Paused,
    Finished,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Todo,
    Doing,
    /// Handed in, not yet accepted.
    Delivered,
    /// Accepted by its reviewer.
    Done,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    High,
    #[default]
    Medium,
    Low,
}

/// One thing that happened. `by` is the member whose tool call it was.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    Started { config: TeamConfig },
    Paused { why: String },
    Resumed,
    Finished,
    TaskCreated {
        id: String,
        title: String,
        detail: String,
        owner: String,
        priority: Priority,
        criteria: Vec<String>,
        depends_on: Vec<String>,
        deliver_to: Option<String>,
        by: String,
    },
    TaskAssigned { id: String, owner: String, by: String },
    /// `checked` are the criteria the owner says are met (indexes from 0).
    TaskUpdated { id: String, status: Option<TaskStatus>, note: Option<String>, checked: Vec<usize>, by: String },
    TaskBlocked { id: String, reason: String, on: String, by: String },
    /// Coucou told the owner the task is theirs and ready.
    Dispatched { task: String },
    Delivered { id: String, task: String, kind: String, locator: String, summary: String, by: String },
    Reviewed { task: String, accepted: bool, reason: String, by: String },
    Message { id: String, from: String, to: String, text: String, task: Option<String> },
    /// These messages reached the member (at the start of a turn, or when it
    /// read its inbox).
    Heard { member: String, ids: Vec<String> },
    Asked { id: String, by: String, question: String, task: Option<String> },
    Answered { id: String, text: String },
    TurnStarted { member: String },
    TurnEnded { member: String, ok: bool, outcome: String },
    Lost { member: String, why: String },
    Recovered { member: String },
    /// Someone joined the team while it ran.
    Joined { member: super::MemberConfig },
    /// Everything is accepted and the leader has been asked for the report
    /// (`on`), or work was added after that (`!on`).
    Wrapping { on: bool },
    /// The person came back to a finished team with more: it runs again.
    Reopened,
    /// Tokens a member's model used since the last report.
    Usage { member: String, usage: crate::usage::Usage },
}

/// An event with its place in the log and its time (ms since 1970).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub seq: u64,
    pub at: u64,
    pub event: Event,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    pub text: String,
    /// The owner says it is met. It is confirmed when the task is accepted.
    pub claimed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub reason: String,
    /// A member id, or `you`.
    pub on: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub owner: String,
    pub status: TaskStatus,
    pub priority: Priority,
    pub criteria: Vec<Criterion>,
    pub depends_on: Vec<String>,
    pub deliver_to: Option<String>,
    pub blocked: Option<Block>,
    pub note: String,
    pub rejections: u32,
    pub dispatched: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deliverable {
    pub id: String,
    pub task: String,
    pub kind: String,
    /// A path in the work folder, or a URL.
    pub locator: String,
    pub summary: String,
    pub by: String,
    pub at: u64,
    /// `None` until reviewed.
    pub accepted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub from: String,
    pub to: String,
    pub text: String,
    pub task: Option<String>,
    pub at: u64,
    pub heard: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub by: String,
    pub question: String,
    pub task: Option<String>,
    pub at: u64,
    pub answer: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Turns {
    pub count: u32,
    pub active: bool,
    /// Tool calls that changed something during the current (or last) turn.
    pub moves: u32,
    /// Turns in a row that ended without one.
    pub silent: u32,
    pub last_outcome: String,
}

/// One line of the "latest collaboration" timeline.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub at: u64,
    /// message · task · delivered · accepted · rejected · blocked · asked ·
    /// answered · lost · paused · finished · joined
    pub kind: &'static str,
    pub from: String,
    pub to: String,
    pub text: String,
    pub task: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub config: Option<TeamConfig>,
    pub status: TeamStatus,
    pub paused_why: String,
    pub wrapping: bool,
    pub started_at: u64,
    pub finished_at: u64,
    pub tasks: Vec<Task>,
    pub deliverables: Vec<Deliverable>,
    pub messages: Vec<Message>,
    pub questions: Vec<Question>,
    pub turns: BTreeMap<String, Turns>,
    pub lost: BTreeMap<String, String>,
    /// What each member's models used in this run: member → model → totals.
    pub usage: BTreeMap<String, BTreeMap<String, crate::usage::Usage>>,
    pub feed: Vec<FeedItem>,
    pub total_turns: u32,
}

impl State {
    pub fn task(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id.eq_ignore_ascii_case(id))
    }

    fn task_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.id.eq_ignore_ascii_case(id))
    }

    pub fn leader(&self) -> &str {
        self.config.as_ref().map(|c| c.leader.as_str()).unwrap_or("")
    }

    /// Whether everything `task` depends on has been handed in.
    pub fn deps_met(&self, task: &Task) -> bool {
        task.depends_on.iter().all(|d| {
            self.task(d).map(|t| matches!(t.status, TaskStatus::Delivered | TaskStatus::Done)).unwrap_or(true)
        })
    }

    /// Messages waiting for `member`.
    pub fn unheard(&self, member: &str) -> Vec<&Message> {
        self.messages.iter().filter(|m| m.to == member && !m.heard).collect()
    }

    /// Tasks `member` has been given and has not handed in.
    pub fn open_tasks(&self, member: &str) -> Vec<&Task> {
        self.tasks
            .iter()
            .filter(|t| t.owner == member && t.dispatched && matches!(t.status, TaskStatus::Todo | TaskStatus::Doing))
            .collect()
    }

    pub fn open_question(&self, member: &str) -> Option<&Question> {
        self.questions.iter().find(|q| q.by == member && q.answer.is_none())
    }

    pub fn all_done(&self) -> bool {
        !self.tasks.is_empty() && self.tasks.iter().all(|t| t.status == TaskStatus::Done)
    }

    /// Who accepts a task: the leader, unless the leader did it — then
    /// whoever receives it, and failing that nobody (it is accepted as is).
    pub fn reviewer(&self, task: &Task) -> Option<String> {
        let leader = self.leader();
        if task.owner != leader {
            return Some(leader.to_string());
        }
        task.deliver_to.clone().filter(|d| d != leader)
    }

    pub fn next_task_id(&self) -> String {
        format!("TASK-{:02}", self.tasks.len() + 1)
    }

    pub fn next_message_id(&self) -> String {
        format!("M-{}", self.messages.len() + 1)
    }

    pub fn next_deliverable_id(&self) -> String {
        format!("D-{}", self.deliverables.len() + 1)
    }

    pub fn next_question_id(&self) -> String {
        format!("Q-{}", self.questions.len() + 1)
    }

    fn moved(&mut self, by: &str) {
        if let Some(t) = self.turns.get_mut(by) {
            if t.active {
                t.moves += 1;
            }
        }
    }

    fn say(&mut self, at: u64, kind: &'static str, from: &str, to: &str, text: &str, task: Option<&str>) {
        self.feed.push(FeedItem {
            at,
            kind,
            from: from.to_string(),
            to: to.to_string(),
            text: text.to_string(),
            task: task.map(str::to_string),
        });
    }

    pub fn apply(&mut self, record: &Record) {
        let at = record.at;
        match &record.event {
            Event::Started { config } => {
                self.config = Some(config.clone());
                self.status = TeamStatus::Running;
                self.started_at = at;
            }
            Event::Paused { why } => {
                self.status = TeamStatus::Paused;
                self.paused_why = why.clone();
                self.say(at, "paused", SYSTEM, YOU, why, None);
            }
            Event::Resumed => {
                self.status = TeamStatus::Running;
                self.paused_why.clear();
            }
            Event::Finished => {
                self.status = TeamStatus::Finished;
                self.finished_at = at;
                self.say(at, "finished", SYSTEM, YOU, "", None);
            }
            Event::TaskCreated { id, title, detail, owner, priority, criteria, depends_on, deliver_to, by } => {
                self.tasks.push(Task {
                    id: id.clone(),
                    title: title.clone(),
                    detail: detail.clone(),
                    owner: owner.clone(),
                    status: TaskStatus::Todo,
                    priority: *priority,
                    criteria: criteria.iter().map(|c| Criterion { text: c.clone(), claimed: false }).collect(),
                    depends_on: depends_on.clone(),
                    deliver_to: deliver_to.clone(),
                    blocked: None,
                    note: String::new(),
                    rejections: 0,
                    dispatched: false,
                    created_at: at,
                    updated_at: at,
                });
                self.moved(by);
                self.say(at, "task", by, owner, title, Some(id));
            }
            Event::TaskAssigned { id, owner, by } => {
                if let Some(t) = self.task_mut(id) {
                    t.owner = owner.clone();
                    t.dispatched = false;
                    t.blocked = None;
                    t.updated_at = at;
                }
                self.moved(by);
            }
            Event::TaskUpdated { id, status, note, checked, by } => {
                if let Some(t) = self.task_mut(id) {
                    if let Some(s) = status {
                        t.status = *s;
                    }
                    if let Some(n) = note {
                        t.note = n.clone();
                    }
                    for i in checked {
                        if let Some(c) = t.criteria.get_mut(*i) {
                            c.claimed = true;
                        }
                    }
                    // Reporting on a task is working on it again.
                    t.blocked = None;
                    t.updated_at = at;
                }
                self.moved(by);
            }
            Event::TaskBlocked { id, reason, on, by } => {
                if let Some(t) = self.task_mut(id) {
                    t.blocked = Some(Block { reason: reason.clone(), on: on.clone() });
                    t.updated_at = at;
                }
                self.moved(by);
                self.say(at, "blocked", by, on, reason, Some(id));
            }
            Event::Dispatched { task } => {
                if let Some(t) = self.task_mut(task) {
                    t.dispatched = true;
                }
            }
            Event::Delivered { id, task, kind, locator, summary, by } => {
                self.deliverables.push(Deliverable {
                    id: id.clone(),
                    task: task.clone(),
                    kind: kind.clone(),
                    locator: locator.clone(),
                    summary: summary.clone(),
                    by: by.clone(),
                    at,
                    accepted: None,
                });
                let mut to = String::new();
                if let Some(t) = self.task_mut(task) {
                    t.status = TaskStatus::Delivered;
                    t.blocked = None;
                    t.updated_at = at;
                    to = t.deliver_to.clone().unwrap_or_default();
                }
                self.moved(by);
                self.say(at, "delivered", by, &to, summary, Some(task));
            }
            Event::Reviewed { task, accepted, reason, by } => {
                let mut owner = String::new();
                if let Some(t) = self.task_mut(task) {
                    owner = t.owner.clone();
                    if *accepted {
                        t.status = TaskStatus::Done;
                        for c in &mut t.criteria {
                            c.claimed = true;
                        }
                    } else {
                        t.status = TaskStatus::Doing;
                        t.rejections += 1;
                        for c in &mut t.criteria {
                            c.claimed = false;
                        }
                    }
                    t.updated_at = at;
                }
                if let Some(d) = self.deliverables.iter_mut().rev().find(|d| d.task.eq_ignore_ascii_case(task) && d.accepted.is_none()) {
                    d.accepted = Some(*accepted);
                }
                self.moved(by);
                self.say(at, if *accepted { "accepted" } else { "rejected" }, by, &owner, reason, Some(task));
            }
            Event::Message { id, from, to, text, task } => {
                self.messages.push(Message {
                    id: id.clone(),
                    from: from.clone(),
                    to: to.clone(),
                    text: text.clone(),
                    task: task.clone(),
                    at,
                    // Nothing delivers a message to the person: the screen shows it.
                    heard: to == YOU,
                });
                // An answer from whoever a task waits on sets it going again.
                for t in &mut self.tasks {
                    if t.owner == *to && t.blocked.as_ref().map(|b| b.on == *from).unwrap_or(false) {
                        t.blocked = None;
                    }
                }
                self.moved(from);
                if from != SYSTEM {
                    self.say(at, "message", from, to, text, task.as_deref());
                }
            }
            Event::Heard { member, ids } => {
                for m in &mut self.messages {
                    if m.to == *member && ids.contains(&m.id) {
                        m.heard = true;
                    }
                }
            }
            Event::Asked { id, by, question, task } => {
                self.questions.push(Question {
                    id: id.clone(),
                    by: by.clone(),
                    question: question.clone(),
                    task: task.clone(),
                    at,
                    answer: None,
                });
                self.moved(by);
                self.say(at, "asked", by, YOU, question, task.as_deref());
            }
            Event::Answered { id, text } => {
                let mut by = String::new();
                if let Some(q) = self.questions.iter_mut().find(|q| q.id == *id) {
                    q.answer = Some(text.clone());
                    by = q.by.clone();
                }
                self.say(at, "answered", YOU, &by, text, None);
            }
            Event::TurnStarted { member } => {
                let t = self.turns.entry(member.clone()).or_default();
                t.count += 1;
                t.active = true;
                t.moves = 0;
                self.total_turns += 1;
            }
            Event::TurnEnded { member, ok: _, outcome } => {
                let t = self.turns.entry(member.clone()).or_default();
                t.active = false;
                t.silent = if t.moves == 0 { t.silent + 1 } else { 0 };
                t.last_outcome = outcome.clone();
            }
            Event::Lost { member, why } => {
                self.lost.insert(member.clone(), why.clone());
                if let Some(t) = self.turns.get_mut(member) {
                    t.active = false;
                }
                self.say(at, "lost", member, YOU, why, None);
            }
            Event::Joined { member } => {
                if let Some(config) = self.config.as_mut() {
                    if !config.members.iter().any(|m| m.id == member.id) {
                        config.members.push(member.clone());
                    }
                }
                let text = if member.role.is_empty() { member.name.clone() } else { format!("{} · {}", member.name, member.role) };
                self.say(at, "joined", &member.id, "", &text, None);
            }
            Event::Recovered { member } => {
                self.lost.remove(member);
                if let Some(t) = self.turns.get_mut(member) {
                    t.silent = 0;
                }
            }
            Event::Wrapping { on } => self.wrapping = *on,
            Event::Usage { member, usage } => {
                let models = self.usage.entry(member.clone()).or_default();
                let total = models.entry(usage.model.clone()).or_insert_with(|| crate::usage::Usage { model: usage.model.clone(), ..Default::default() });
                total.add(usage);
            }
            Event::Reopened => {
                self.status = TeamStatus::Running;
                self.finished_at = 0;
                self.paused_why.clear();
                self.say(at, "reopened", YOU, "", "", None);
            }
        }
    }
}

// ── What the screens show ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MemberStatus {
    Working,
    /// Its work depends on something not handed in yet.
    WaitingDelivery,
    /// It asked another member and stopped until the answer.
    WaitingReply,
    /// A permission card or a question is waiting for the person.
    WaitingYou,
    Idle,
    Done,
    Lost,
}

/// What a member at work is doing, read from the board: a leader with no
/// tasks yet is planning; one whose hand-ins are waiting for its review,
/// with no task of its own under way, is reviewing.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Planning,
    Reviewing,
}

/// Who a member waits on, and for what.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    /// A member id, or `you`.
    pub on: String,
    pub what: String,
    pub task: Option<String>,
}

/// A permission request a member's agent is holding for the person.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionView {
    pub request_id: Value,
    pub title: String,
    pub kind: String,
    pub raw_input: Value,
    pub options: Vec<Value>,
    pub danger: Option<Danger>,
}

/// What is known about a member right now and is not worth writing down:
/// the tool it is in the middle of, the card it is holding.
#[derive(Debug, Clone, Default)]
pub struct Live {
    pub activity: String,
    /// Requests waiting for the person, oldest first. An agent may ask for
    /// several at once (Codex runs steps in parallel): none may be dropped,
    /// or the agent waits for an answer that never comes.
    pub permissions: Vec<PermissionView>,
}

/// Coucou's accents, for members given no colour — the same list and order
/// as the Teamwork window's setup form (src/team/main.ts PALETTE).
const PALETTE: [&str; 6] = ["#3B9EFF", "#34D399", "#A78BFA", "#F5A524", "#F472B6", "#22D3EE"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub id: String,
    pub name: String,
    pub role: String,
    pub duty: String,
    pub agent: String,
    /// The model it was told to run; empty for the agent's own.
    pub model: String,
    pub color: String,
    pub is_leader: bool,
    pub status: MemberStatus,
    /// Planning or reviewing, while it works; nothing otherwise.
    pub phase: Option<Phase>,
    /// What its models used in this run, model by model.
    pub usage: Vec<crate::usage::Usage>,
    /// The task it is on, if any.
    pub task: Option<String>,
    pub waiting: Option<Waiting>,
    /// The tool it is using right now.
    pub activity: String,
    pub turns: u32,
    /// The oldest request waiting for the person…
    pub permission: Option<PermissionView>,
    /// …and the ones behind it.
    pub more_permissions: Vec<PermissionView>,
    pub lost_why: String,
    /// The last lines of its live screen.
    pub screen: Vec<super::screen::Line>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    /// The last event of the log this picture includes: a later picture of
    /// the same run never has a smaller one.
    pub seq: u64,
    /// Loaded from an earlier run: no agent stands behind it until it is
    /// picked up again (or started afresh).
    pub detached: bool,
    pub name: String,
    pub goal: String,
    pub work_dir: String,
    pub status: TeamStatus,
    pub paused_why: String,
    pub done: usize,
    pub total: usize,
    pub total_turns: u32,
    pub max_turns: u32,
    pub started_at: u64,
    pub finished_at: u64,
    pub members: Vec<MemberView>,
    pub tasks: Vec<Task>,
    pub deliverables: Vec<Deliverable>,
    pub messages: Vec<Message>,
    pub questions: Vec<Question>,
    pub feed: Vec<FeedItem>,
}

impl State {
    fn member_status(&self, member: &str, live: Option<&Live>) -> (MemberStatus, Option<String>, Option<Waiting>) {
        let mine: Vec<&Task> = self.tasks.iter().filter(|t| t.owner == member).collect();
        let open: Vec<&Task> = mine.iter().copied().filter(|t| matches!(t.status, TaskStatus::Todo | TaskStatus::Doing)).collect();
        let current = open
            .iter()
            .find(|t| t.status == TaskStatus::Doing)
            .or_else(|| open.iter().find(|t| self.deps_met(t)))
            .map(|t| t.id.clone());

        if self.lost.contains_key(member) {
            return (MemberStatus::Lost, current, None);
        }
        if let Some(p) = live.and_then(|l| l.permissions.first()) {
            let waiting = Waiting { on: YOU.into(), what: p.title.clone(), task: current.clone() };
            return (MemberStatus::WaitingYou, current, Some(waiting));
        }
        if let Some(q) = self.open_question(member) {
            let waiting = Waiting { on: YOU.into(), what: q.question.clone(), task: q.task.clone() };
            return (MemberStatus::WaitingYou, current, Some(waiting));
        }
        if self.turns.get(member).map(|t| t.active).unwrap_or(false) {
            return (MemberStatus::Working, current, None);
        }
        if let Some((task, block)) = open.iter().find_map(|t| t.blocked.as_ref().map(|b| (t, b))) {
            let waiting = Waiting { on: block.on.clone(), what: block.reason.clone(), task: Some(task.id.clone()) };
            let status = if block.on == YOU { MemberStatus::WaitingYou } else { MemberStatus::WaitingReply };
            return (status, Some(task.id.clone()), Some(waiting));
        }
        // Every open task waits on something not handed in yet.
        if !open.is_empty() && open.iter().all(|t| !self.deps_met(t)) {
            let task = open[0];
            let dep = task.depends_on.iter().filter_map(|d| self.task(d)).find(|d| !matches!(d.status, TaskStatus::Delivered | TaskStatus::Done));
            let waiting = dep.map(|d| Waiting { on: d.owner.clone(), what: d.title.clone(), task: Some(task.id.clone()) });
            return (MemberStatus::WaitingDelivery, Some(task.id.clone()), waiting);
        }
        if !mine.is_empty() && open.is_empty() {
            return (MemberStatus::Done, None, None);
        }
        (MemberStatus::Idle, current, None)
    }

    fn phase(&self, member: &str, status: MemberStatus) -> Option<Phase> {
        if status != MemberStatus::Working {
            return None;
        }
        if member == self.leader() && self.tasks.is_empty() {
            return Some(Phase::Planning);
        }
        let doing = self.tasks.iter().any(|t| t.owner == member && t.status == TaskStatus::Doing);
        let to_review = self.tasks.iter().any(|t| t.status == TaskStatus::Delivered && self.reviewer(t).as_deref() == Some(member));
        (to_review && !doing).then_some(Phase::Reviewing)
    }

    pub fn snapshot(&self, live: &BTreeMap<String, Live>) -> Option<Snapshot> {
        let config = self.config.as_ref()?;
        let members = config
            .members
            .iter()
            .enumerate()
            .map(|(at, m)| {
                let l = live.get(&m.id);
                let (status, task, waiting) = self.member_status(&m.id, l);
                MemberView {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    role: m.role.clone(),
                    duty: m.duty.clone(),
                    agent: m.agent.clone(),
                    model: m.model.clone(),
                    // No colour of its own: Coucou's accents in turn, as the setup form shows them.
                    color: if m.color.trim().is_empty() { PALETTE[at % PALETTE.len()].to_string() } else { m.color.clone() },
                    is_leader: m.id == config.leader,
                    status,
                    phase: self.phase(&m.id, status),
                    usage: self.usage.get(&m.id).map(|u| u.values().cloned().collect()).unwrap_or_default(),
                    task,
                    waiting,
                    activity: l.map(|l| l.activity.clone()).unwrap_or_default(),
                    turns: self.turns.get(&m.id).map(|t| t.count).unwrap_or(0),
                    permission: l.and_then(|l| l.permissions.first().cloned()),
                    more_permissions: l.map(|l| l.permissions.iter().skip(1).cloned().collect()).unwrap_or_default(),
                    lost_why: self.lost.get(&m.id).cloned().unwrap_or_default(),
                    screen: Vec::new(),
                }
            })
            .collect();
        Some(Snapshot {
            id: config.id.clone(),
            seq: 0,
            detached: false,
            name: config.name.clone(),
            goal: config.goal.clone(),
            work_dir: config.work_dir.clone(),
            status: self.status,
            paused_why: self.paused_why.clone(),
            done: self.tasks.iter().filter(|t| t.status == TaskStatus::Done).count(),
            total: self.tasks.len(),
            total_turns: self.total_turns,
            max_turns: config.max_turns,
            started_at: self.started_at,
            finished_at: self.finished_at,
            members,
            tasks: self.tasks.clone(),
            deliverables: self.deliverables.clone(),
            messages: self.messages.clone(),
            questions: self.questions.clone(),
            feed: self.feed.clone(),
        })
    }
}
