// What a member can say and do: the eight team tools.
//
// Each call is checked against the state, and answers with a line of text for
// the member and the events to record. Nothing here touches a process or the
// disk (except to check that a delivery is really there), so the whole of a
// team's rules can be read and tested in one place. `react` is the other half:
// what Coucou does on its own once the state has changed.
//
// Everything written here is for a member's model (tool results, errors,
// messages to members, tool descriptions): English, not translated.

use std::path::Path;

use serde_json::{json, Value};

use super::brief;
use super::state::{Event, Priority, State, TaskStatus, TeamStatus};
use super::{TeamConfig, SYSTEM, YOU};

pub struct Outcome {
    pub text: String,
    pub events: Vec<Event>,
}

/// Ids for what one call creates, counted on from the state.
struct Ids {
    messages: usize,
}

impl Ids {
    fn of(state: &State) -> Self {
        Self { messages: state.messages.len() }
    }

    fn message(&mut self) -> String {
        self.messages += 1;
        format!("M-{}", self.messages)
    }
}

fn text(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

// i18n: model-facing
fn need(args: &Value, key: &str) -> Result<String, String> {
    text(args, key).ok_or_else(|| format!("`{key}` is missing."))
}

/// A list given as an array, or as one string.
fn list(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::Array(items)) => items.iter().filter_map(|v| v.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect(),
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
        _ => Vec::new(),
    }
}

/// A member named by id, by `leader`, or by its display name.
fn member_id(config: &TeamConfig, given: &str) -> Option<String> {
    let given = given.trim();
    if given.eq_ignore_ascii_case("leader") {
        return Some(config.leader.clone());
    }
    config
        .members
        .iter()
        .find(|m| m.id.eq_ignore_ascii_case(given) || m.name.eq_ignore_ascii_case(given))
        .map(|m| m.id.clone())
}

fn members_line(config: &TeamConfig) -> String {
    config.members.iter().map(|m| m.id.as_str()).collect::<Vec<_>>().join(", ")
}

fn message(ids: &mut Ids, from: &str, to: &str, text: String, task: Option<&str>) -> Event {
    Event::Message { id: ids.message(), from: from.to_string(), to: to.to_string(), text, task: task.map(str::to_string) }
}

/// Runs one tool call for `member`. `Err` is a message for the member: what
/// was wrong with the call, in words it can act on.
// i18n: model-facing
pub fn call(state: &State, member: &str, tool: &str, args: &Value) -> Result<Outcome, String> {
    let config = state.config.as_ref().ok_or("The team has not started.")?;
    if !config.has_member(member) {
        return Err("You are not a member of this team.".into());
    }
    if state.status == TeamStatus::Finished && tool != "team_status" {
        return Err("The team has finished; nothing more can be changed.".into());
    }
    let is_leader = member == config.leader;
    let mut ids = Ids::of(state);

    match tool {
        "team_status" => {
            let unheard: Vec<String> = state.unheard(member).iter().map(|m| m.id.clone()).collect();
            let events = if unheard.is_empty() { vec![] } else { vec![Event::Heard { member: member.to_string(), ids: unheard }] };
            Ok(Outcome { text: status_text(state, config, member), events })
        }

        "task_create" => {
            if !is_leader {
                return Err("Only the leader creates tasks. Ask the leader with `message_send`.".into());
            }
            let title = need(args, "title")?;
            let owner_given = need(args, "owner")?;
            let owner = member_id(config, &owner_given).ok_or_else(|| format!("'{owner_given}' is not a member. Members: {}.", members_line(config)))?;
            let depends_on = list(args, "depends_on");
            let mut deps = Vec::new();
            for d in &depends_on {
                let t = state.task(d).ok_or_else(|| format!("'{d}' in depends_on is not a task. Create that task first."))?;
                deps.push(t.id.clone());
            }
            let deliver_to = match text(args, "deliver_to") {
                Some(to) => Some(member_id(config, &to).ok_or_else(|| format!("'{to}' in deliver_to is not a member. Members: {}.", members_line(config)))?),
                None => None,
            };
            let priority = match text(args, "priority").as_deref().map(str::to_lowercase).as_deref() {
                Some("high") => Priority::High,
                Some("low") => Priority::Low,
                _ => Priority::Medium,
            };
            let id = state.next_task_id();
            let events = vec![Event::TaskCreated {
                id: id.clone(),
                title: title.clone(),
                detail: text(args, "detail").unwrap_or_default(),
                owner: owner.clone(),
                priority,
                criteria: list(args, "criteria"),
                depends_on: deps,
                deliver_to,
                by: member.to_string(),
            }];
            Ok(Outcome { text: format!("Created {id} \"{title}\" for {}.", brief::who(config, &owner)), events })
        }

        "team_finish" => {
            if !is_leader {
                return Err("Only the leader closes the team. Tell the leader with `message_send` that your part is done.".into());
            }
            let open: Vec<String> = state.tasks.iter().filter(|t| t.status != TaskStatus::Done).map(|t| format!("{} ({})", t.id, t.title)).collect();
            if state.tasks.is_empty() {
                return Err("There are no tasks yet. Plan the work with `task_create` first.".into());
            }
            if !open.is_empty() {
                return Err(format!("Not every task is accepted yet: {}. Close the team once they are.", open.join(", ")));
            }
            Ok(Outcome {
                text: "The team closes as soon as nobody is still working and every message has been read. If you asked a teammate something, their answer reaches you first.".into(),
                events: vec![Event::FinishAsked { by: member.to_string() }],
            })
        }

        "task_assign" => {
            if !is_leader {
                return Err("Only the leader assigns tasks.".into());
            }
            let task = find_task(state, args)?;
            let owner_given = need(args, "owner")?;
            let owner = member_id(config, &owner_given).ok_or_else(|| format!("'{owner_given}' is not a member. Members: {}.", members_line(config)))?;
            if task.status == TaskStatus::Done {
                return Err(format!("{} is already accepted.", task.id));
            }
            let events = vec![Event::TaskAssigned { id: task.id.clone(), owner: owner.clone(), by: member.to_string() }];
            Ok(Outcome { text: format!("{} now belongs to {}.", task.id, brief::who(config, &owner)), events })
        }

        "task_update" => {
            let task = find_task(state, args)?;
            if task.owner != member && !is_leader {
                return Err(format!("{} belongs to {}, not to you.", task.id, brief::who(config, &task.owner)));
            }
            if matches!(task.status, TaskStatus::Delivered | TaskStatus::Done) {
                return Err(format!("{} has been handed in already. If it needs more work, tell the leader.", task.id));
            }
            let status = match text(args, "status").as_deref().map(str::to_lowercase).as_deref() {
                None => None,
                Some("doing") | Some("in_progress") | Some("in progress") | Some("started") => Some(TaskStatus::Doing),
                Some("todo") => Some(TaskStatus::Todo),
                Some("done") | Some("delivered") | Some("finished") | Some("completed") => {
                    return Err("A task is finished by calling `deliver` with where the result is, not by setting its status.".into())
                }
                Some(other) => return Err(format!("'{other}' is not a status. Use \"doing\".")),
            };
            if status == Some(TaskStatus::Doing) && !state.deps_met(task) {
                return Err(format!("{} cannot start yet: it depends on work that has not been handed in.", task.id));
            }
            // Criteria are numbered from 1 for the member.
            let mut checked = Vec::new();
            if let Some(items) = args.get("done_criteria").and_then(Value::as_array) {
                for item in items {
                    let n = item.as_u64().or_else(|| item.as_str().and_then(|s| s.trim().parse().ok())).unwrap_or(0) as usize;
                    if n == 0 || n > task.criteria.len() {
                        return Err(format!("{} has criteria 1 to {}; {item} is not one of them.", task.id, task.criteria.len()));
                    }
                    checked.push(n - 1);
                }
            }
            let note = text(args, "note");
            if status.is_none() && note.is_none() && checked.is_empty() {
                return Err("Nothing to update: give a status, a note or done_criteria.".into());
            }
            let events = vec![Event::TaskUpdated { id: task.id.clone(), status, note, checked, by: member.to_string() }];
            Ok(Outcome { text: format!("{} updated.", task.id), events })
        }

        "task_block" => {
            let task = find_task(state, args)?;
            if task.owner != member {
                return Err(format!("{} belongs to {}, not to you.", task.id, brief::who(config, &task.owner)));
            }
            let reason = need(args, "reason")?;
            let on_given = need(args, "waiting_on")?;
            let on = if on_given.eq_ignore_ascii_case(YOU) || on_given.eq_ignore_ascii_case("user") || on_given.eq_ignore_ascii_case("human") {
                YOU.to_string()
            } else {
                member_id(config, &on_given).ok_or_else(|| format!("'{on_given}' is not a member. Use a member id ({}) or \"you\" for the user.", members_line(config)))?
            };
            if on == member {
                return Err("You cannot wait on yourself.".into());
            }
            let mut events = vec![Event::TaskBlocked { id: task.id.clone(), reason: reason.clone(), on: on.clone(), by: member.to_string() }];
            // Whoever is waited on has to hear about it.
            if on == YOU {
                events.push(Event::Asked { id: state.next_question_id(), by: member.to_string(), question: reason, task: Some(task.id.clone()) });
            } else {
                let body = format!("{} is stopped on {} ({}) and waiting for you: {}", brief::who(config, member), task.id, task.title, reason);
                events.push(message(&mut ids, SYSTEM, &on, body, Some(&task.id)));
            }
            Ok(Outcome { text: format!("{} is marked as waiting for {}. End your turn; you get a new one when the answer arrives.", task.id, brief::who(config, &on)), events })
        }

        "deliver" => {
            let task = find_task(state, args)?;
            if task.owner != member {
                return Err(format!("{} belongs to {}, not to you.", task.id, brief::who(config, &task.owner)));
            }
            if task.status == TaskStatus::Done {
                return Err(format!("{} is already accepted.", task.id));
            }
            if !state.deps_met(task) {
                return Err(format!("{} depends on work that has not been handed in yet.", task.id));
            }
            let locator = need(args, "locator")?;
            let summary = need(args, "summary")?;
            let is_url = locator.starts_with("http://") || locator.starts_with("https://");
            if !is_url {
                let path = Path::new(&locator);
                let full = if path.is_absolute() { path.to_path_buf() } else { Path::new(&config.work_dir).join(path) };
                if !full.exists() {
                    return Err(format!("Nothing exists at {}. Give the path of what you made, relative to {}, or a URL.", full.display(), config.work_dir));
                }
            }
            let kind = text(args, "kind").unwrap_or_else(|| "file".into());
            let mut events = vec![Event::Delivered {
                id: state.next_deliverable_id(),
                task: task.id.clone(),
                kind,
                locator: locator.clone(),
                summary: summary.clone(),
                by: member.to_string(),
            }];
            let reviewer = state.reviewer(task);
            match &reviewer {
                Some(r) => events.push(message(&mut ids, SYSTEM, r, brief::to_review(config, task, member, &locator, &summary), Some(&task.id))),
                // The leader's own work with nobody to receive it: accepted as it is.
                None => events.push(Event::Reviewed { task: task.id.clone(), accepted: true, reason: String::new(), by: SYSTEM.to_string() }),
            }
            if let Some(to) = task.deliver_to.as_ref().filter(|to| Some(*to) != reviewer.as_ref() && *to != member) {
                events.push(message(&mut ids, SYSTEM, to, brief::as_input(config, task, member, &locator, &summary), Some(&task.id)));
            }
            let next = match &reviewer {
                Some(r) => format!("{} will review it.", brief::who(config, r)),
                None => "It is accepted.".to_string(),
            };
            Ok(Outcome { text: format!("{} handed in. {next} End your turn unless you have another task.", task.id), events })
        }

        "review" => {
            let task = find_task(state, args)?;
            let may = is_leader || task.deliver_to.as_deref() == Some(member);
            if !may || task.owner == member {
                return Err(format!("{} is reviewed by {}.", task.id, state.reviewer(task).map(|r| brief::who(config, &r)).unwrap_or_else(|| "nobody".into())));
            }
            if task.status != TaskStatus::Delivered {
                return Err(format!("{} has not been handed in, so there is nothing to review.", task.id));
            }
            let accept = match args.get("accept") {
                Some(Value::Bool(b)) => *b,
                Some(Value::String(s)) if matches!(s.to_lowercase().as_str(), "true" | "yes" | "accept") => true,
                Some(Value::String(s)) if matches!(s.to_lowercase().as_str(), "false" | "no" | "reject") => false,
                _ => return Err("`accept` must be true or false.".into()),
            };
            let reason = text(args, "reason").unwrap_or_default();
            if !accept && reason.is_empty() {
                return Err("Say why it is sent back: `reason` is missing.".into());
            }
            let mut events = vec![Event::Reviewed { task: task.id.clone(), accepted: accept, reason: reason.clone(), by: member.to_string() }];
            // Sent back, the owner must hear why. Accepted, there is nothing
            // for it to do: the board says so, and a turn is not spent on it.
            if !accept {
                events.push(message(&mut ids, SYSTEM, &task.owner, brief::rejected(config, task, member, &reason), Some(&task.id)));
            }
            Ok(Outcome { text: format!("{} {}.", task.id, if accept { "accepted" } else { "sent back" }), events })
        }

        "message_send" => {
            let body = need(args, "text")?;
            let to_given = need(args, "to")?;
            let task = match text(args, "task") {
                Some(t) => Some(state.task(&t).ok_or_else(|| format!("'{t}' is not a task."))?.id.clone()),
                None => None,
            };
            let to: Vec<String> = if to_given.eq_ignore_ascii_case("all") {
                config.members.iter().filter(|m| m.id != member).map(|m| m.id.clone()).collect()
            } else if to_given.eq_ignore_ascii_case(YOU) || to_given.eq_ignore_ascii_case("user") || to_given.eq_ignore_ascii_case("human") {
                vec![YOU.to_string()]
            } else {
                vec![member_id(config, &to_given).ok_or_else(|| format!("'{to_given}' is not a member. Members: {}; or \"you\" for the user, \"all\" for everyone.", members_line(config)))?]
            };
            if to_given.eq_ignore_ascii_case("all") && !is_leader && !config.direct_talk {
                return Err("Only the leader writes to everyone. Write to the leader instead.".into());
            }
            for t in &to {
                if !config.may_talk(member, t) {
                    return Err(format!("You have no line to {}. Write to the leader ({}), who can pass it on.", brief::who(config, t), config.leader));
                }
            }
            let events = to.iter().map(|t| message(&mut ids, member, t, body.clone(), task.as_deref())).collect();
            let names: Vec<String> = to.iter().map(|t| brief::who(config, t)).collect();
            Ok(Outcome { text: format!("Sent to {}. They read it at the start of their next turn.", names.join(", ")), events })
        }

        "ask_human" => {
            let question = need(args, "question")?;
            let task = match text(args, "task") {
                Some(t) => Some(state.task(&t).ok_or_else(|| format!("'{t}' is not a task."))?.id.clone()),
                None => None,
            };
            let events = vec![Event::Asked { id: state.next_question_id(), by: member.to_string(), question, task }];
            Ok(Outcome { text: "The user has been asked. End your turn; the answer starts your next one.".into(), events })
        }

        other => Err(format!("There is no tool called '{other}'.")),
    }
}

// i18n: model-facing
fn find_task<'a>(state: &'a State, args: &Value) -> Result<&'a super::state::Task, String> {
    let id = need(args, "task")?;
    state.task(&id).ok_or_else(|| {
        let known: Vec<&str> = state.tasks.iter().map(|t| t.id.as_str()).collect();
        format!("'{id}' is not a task. Tasks: {}.", if known.is_empty() { "none yet".to_string() } else { known.join(", ") })
    })
}

// i18n: model-facing
fn status_word(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Todo => "not started",
        TaskStatus::Doing => "doing",
        TaskStatus::Delivered => "handed in, waiting for review",
        TaskStatus::Done => "accepted",
    }
}

// i18n: model-facing
fn status_text(state: &State, config: &TeamConfig, member: &str) -> String {
    let me = config.member(member).expect("checked by call");
    let mut out = format!(
        "You are {} ({}), {}{}.\nTeam \"{}\": {} of {} tasks accepted.\n",
        me.name,
        me.id,
        me.role,
        if member == config.leader { ", the leader" } else { "" },
        config.name,
        state.tasks.iter().filter(|t| t.status == TaskStatus::Done).count(),
        state.tasks.len(),
    );

    let inbox = state.unheard(member);
    if !inbox.is_empty() {
        out.push_str(&format!("\nNew for you:\n{}\n", brief::turn(config, &inbox)));
    }

    let line = |t: &super::state::Task| {
        let mut l = format!("- {} [{}] {}", t.id, status_word(t.status), t.title);
        if t.owner != member {
            l.push_str(&format!(" — {}", brief::who(config, &t.owner)));
        }
        if let Some(b) = &t.blocked {
            l.push_str(&format!(" — waiting for {}: {}", brief::who(config, &b.on), b.reason));
        } else if matches!(t.status, TaskStatus::Todo) && !state.deps_met(t) {
            l.push_str(&format!(" — waits for {}", t.depends_on.join(", ")));
        }
        l
    };

    let mine: Vec<&super::state::Task> = state.tasks.iter().filter(|t| t.owner == member).collect();
    out.push_str("\nYour tasks:\n");
    if mine.is_empty() {
        out.push_str("- none\n");
    }
    for t in &mine {
        out.push_str(&line(t));
        out.push('\n');
        for (i, c) in t.criteria.iter().enumerate() {
            out.push_str(&format!("    {} {}. {}\n", if c.claimed { "[x]" } else { "[ ]" }, i + 1, c.text));
        }
        if let Some(to) = &t.deliver_to {
            out.push_str(&format!("    goes to {}\n", brief::who(config, to)));
        }
    }

    if config.shared_board || member == config.leader {
        let others: Vec<&super::state::Task> = state.tasks.iter().filter(|t| t.owner != member).collect();
        if !others.is_empty() {
            out.push_str("\nThe rest of the board:\n");
            for t in others {
                out.push_str(&line(t));
                out.push('\n');
            }
        }
        let handed: Vec<String> = state.deliverables.iter().map(|d| format!("- {} by {}: {} — {}", d.task, brief::who(config, &d.by), d.locator, d.summary)).collect();
        if !handed.is_empty() {
            out.push_str(&format!("\nHanded in:\n{}\n", handed.join("\n")));
        }
    }

    let mates: Vec<String> = config
        .members
        .iter()
        .filter(|m| m.id != member)
        .map(|m| format!("{} ({}): {}{}", m.name, m.id, m.role, if m.id == config.leader { ", leader" } else { "" }))
        .collect();
    out.push_str(&format!("\nTeammates: {}\nWork folder: {}", mates.join("; "), config.work_dir));
    out
}

/// What Coucou does by itself once the state has changed: hand out the tasks
/// whose inputs have arrived, and ask the leader for the report when every
/// task is accepted. Run again after applying, until it returns nothing.
pub fn react(state: &State) -> Vec<Event> {
    let Some(config) = state.config.as_ref() else { return vec![] };
    if state.status == TeamStatus::Finished {
        return vec![];
    }
    let mut ids = Ids::of(state);
    let mut events = Vec::new();

    for task in &state.tasks {
        if task.status == TaskStatus::Todo && !task.dispatched && config.has_member(&task.owner) && state.deps_met(task) {
            events.push(Event::Dispatched { task: task.id.clone() });
            events.push(message(&mut ids, SYSTEM, &task.owner, brief::task(state, task), Some(&task.id)));
        }
    }

    if state.all_done() && !state.wrapping {
        events.push(Event::Wrapping { on: true });
        events.push(message(&mut ids, SYSTEM, &config.leader, brief::wrap_up(state), None));
    } else if state.wrapping && !state.all_done() {
        events.push(Event::Wrapping { on: false });
    }
    events
}

/// The tools as MCP describes them, for `tools/list`. The leader gets two more.
// i18n: model-facing
pub fn describe(config: &TeamConfig, member: &str) -> Vec<Value> {
    let members = members_line(config);
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": { "type": "object", "properties": properties, "required": required },
        })
    };
    let task = json!({ "type": "string", "description": "The task id, e.g. TASK-03." });

    let mut tools = vec![tool(
        "team_status",
        "Shows your tasks, the team's board, what has been handed in, and any new messages for you.",
        json!({}),
        &[],
    )];
    if member == config.leader {
        tools.push(tool(
            "task_create",
            "Leader only. Creates a task for one member. Coucou hands it to its owner as soon as everything in depends_on has been handed in.",
            json!({
                "title": { "type": "string" },
                "detail": { "type": "string", "description": "What to do, in enough words for someone who has not seen the goal." },
                "owner": { "type": "string", "description": format!("The member who does it: {members}.") },
                "criteria": { "type": "array", "items": { "type": "string" }, "description": "What must be true for the task to be done, one item each." },
                "depends_on": { "type": "array", "items": { "type": "string" }, "description": "Ids of tasks whose result this one needs." },
                "deliver_to": { "type": "string", "description": "The member who receives the result, if any." },
                "priority": { "type": "string", "enum": ["high", "medium", "low"] },
            }),
            &["title", "owner"],
        ));
        tools.push(tool(
            "task_assign",
            "Leader only. Gives a task to another member.",
            json!({ "task": task, "owner": { "type": "string", "description": format!("One of: {members}.") } }),
            &["task", "owner"],
        ));
        tools.push(tool(
            "knowledge_share",
            "Leader only. Shares a leader-only document of the knowledge base with the whole team. Only when the user has asked you to share that document; Coucou checks that they did.",
            json!({ "doc": { "type": "string", "description": "The document's id (from knowledge_read) or its file name." } }),
            &["doc"],
        ));
        tools.push(tool(
            "team_finish",
            "Leader only. Closes the team once every task is accepted and you have reported to the user. It closes when nobody is still working and every message has been read.",
            json!({}),
            &[],
        ));
    }
    tools.push(tool(
        "task_update",
        "Reports progress on your task: that you started it, which criteria are met, a short note.",
        json!({
            "task": task,
            "status": { "type": "string", "enum": ["doing"], "description": "Set to \"doing\" when you start." },
            "done_criteria": { "type": "array", "items": { "type": "integer" }, "description": "Numbers of the criteria that are now met (from 1)." },
            "note": { "type": "string", "description": "One line on where the task stands." },
        }),
        &["task"],
    ));
    tools.push(tool(
        "task_block",
        "Says you cannot go on with your task until someone answers or hands something in. They are told. End your turn after this.",
        json!({
            "task": task,
            "reason": { "type": "string", "description": "What you need, as a question or a request." },
            "waiting_on": { "type": "string", "description": format!("Who you are waiting for: {members}, or \"you\" for the user.") },
        }),
        &["task", "reason", "waiting_on"],
    ));
    tools.push(tool(
        "deliver",
        "Hands in your task. The result must already exist at the locator.",
        json!({
            "task": task,
            "locator": { "type": "string", "description": "Where the result is: a path in the work folder (file or folder), or a URL." },
            "summary": { "type": "string", "description": "One or two sentences on what it is and how to use it." },
            "kind": { "type": "string", "description": "What kind of thing it is: source, image, report, preview, spec…" },
        }),
        &["task", "locator", "summary"],
    ));
    tools.push(tool(
        "review",
        "Accepts a task that was handed in to you, or sends it back with the reason.",
        json!({
            "task": task,
            "accept": { "type": "boolean" },
            "reason": { "type": "string", "description": "Required when sending it back: what is wrong and what would make it right." },
        }),
        &["task", "accept"],
    ));
    tools.push(tool(
        "message_send",
        "Sends a message to a teammate, to the leader, or to the user. They read it at the start of their next turn.",
        json!({
            "to": { "type": "string", "description": format!("A member id ({members}), \"leader\", \"all\", or \"you\" for the user.") },
            "text": { "type": "string" },
            "task": { "type": "string", "description": "The task it is about, if any." },
        }),
        &["to", "text"],
    ));
    tools.push(tool(
        "knowledge_read",
        "Reads the team's knowledge base: documents the user gave this team. With no doc, lists the ones you may read. With doc, returns that document: its text, the picture itself, or for other files where to open it.",
        json!({
            "doc": { "type": "string", "description": "The document's id (k7f3a) or file name, from the list." },
            "part": { "type": "integer", "description": "For a long text: which part, from 1. The answer says how many parts there are." },
        }),
        &[],
    ));
    tools.push(tool(
        "ask_human",
        "Asks the user something only they can decide. End your turn after this.",
        json!({ "question": { "type": "string" }, "task": { "type": "string", "description": "The task it is about, if any." } }),
        &["question"],
    ));
    tools
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::shop;
    use super::super::state::MemberStatus;
    use super::super::store::Store;
    use super::*;
    use std::collections::BTreeMap;

    /// A started team in a real folder, so deliveries can be checked.
    struct Run {
        store: Store,
        dir: std::path::PathBuf,
    }

    impl Run {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("coucou-tools-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let mut store = Store::memory();
            store.append(Event::Started { config: shop(&dir.to_string_lossy()) });
            Self { store, dir }
        }

        /// A tool call, recorded, followed by whatever Coucou does about it.
        fn call(&mut self, member: &str, tool: &str, args: Value) -> Result<String, String> {
            let outcome = call(self.store.state(), member, tool, &args)?;
            self.store.append_all(outcome.events);
            loop {
                let more = react(self.store.state());
                if more.is_empty() {
                    break;
                }
                self.store.append_all(more);
            }
            Ok(outcome.text)
        }

        fn ok(&mut self, member: &str, tool: &str, args: Value) -> String {
            self.call(member, tool, args).unwrap_or_else(|e| panic!("{member} {tool}: {e}"))
        }

        fn status(&self, member: &str) -> (MemberStatus, Option<String>) {
            let snap = self.store.state().snapshot(&BTreeMap::new()).unwrap();
            let m = snap.members.into_iter().find(|m| m.id == member).unwrap();
            (m.status, m.waiting.map(|w| w.on))
        }

        fn inbox(&self, member: &str) -> String {
            self.store.state().unheard(member).iter().map(|m| m.text.clone()).collect::<Vec<_>>().join("\n---\n")
        }

        fn make(&self, path: &str) {
            let full = self.dir.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, b"x").unwrap();
        }
    }

    impl Drop for Run {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The leader's plan from the drafts: images → site → integration test.
    fn plan(run: &mut Run) {
        run.ok("ai1", "task_create", json!({ "title": "商品圖片", "owner": "ai4", "criteria": ["六張商品圖"], "deliver_to": "ai3" }));
        run.ok("ai1", "task_create", json!({ "title": "購物車功能", "owner": "ai3", "criteria": ["加入商品", "調整數量", "計算小計"], "depends_on": ["TASK-01"], "deliver_to": "ai2", "priority": "high" }));
        run.ok("ai1", "task_create", json!({ "title": "整合測試", "owner": "AI 2", "depends_on": "task-02" }));
    }

    #[test]
    fn the_shop_runs_from_plan_to_report() {
        let mut run = Run::new("flow");
        plan(&mut run);

        // Only the task with nothing to wait for is handed out.
        assert!(run.inbox("ai4").contains("TASK-01 is yours and ready"));
        assert!(run.inbox("ai3").is_empty());
        assert_eq!(run.status("ai3"), (MemberStatus::WaitingDelivery, Some("ai4".into())));
        assert_eq!(run.status("ai2"), (MemberStatus::WaitingDelivery, Some("ai3".into())));

        // AI 4 makes the images and hands them in.
        run.ok("ai4", "task_update", json!({ "task": "TASK-01", "status": "doing" }));
        run.make("public/img/bag.png");
        run.ok("ai4", "deliver", json!({ "task": "TASK-01", "locator": "public/img", "summary": "六張商品圖", "kind": "image" }));
        assert_eq!(run.status("ai4").0, MemberStatus::Done);

        // That releases AI 3, who is told where the input is; the leader is asked to review.
        let ai3 = run.inbox("ai3");
        assert!(ai3.contains("TASK-02 is yours and ready") && ai3.contains("public/img"), "{ai3}");
        assert!(ai3.contains("which is meant for you"));
        assert!(run.inbox("ai1").contains("Check it and call `review`"));
        run.ok("ai1", "review", json!({ "task": "TASK-01", "accept": true }));

        // AI 3 has a question for the leader and stops on it.
        run.ok("ai3", "task_update", json!({ "task": "TASK-02", "status": "doing", "done_criteria": [1] }));
        run.ok("ai3", "task_block", json!({ "task": "TASK-02", "reason": "首版需要優惠券嗎?", "waiting_on": "leader" }));
        assert_eq!(run.status("ai3"), (MemberStatus::WaitingReply, Some("ai1".into())));
        run.ok("ai1", "message_send", json!({ "to": "ai3", "text": "首版先完成基本結帳,優惠券列為後續。", "task": "TASK-02" }));
        assert_eq!(run.status("ai3").0, MemberStatus::Idle);

        // AI 3 hands in; AI 2 is released; the leader sends it back once.
        run.make("src/cart.ts");
        run.ok("ai3", "deliver", json!({ "task": "TASK-02", "locator": "src/cart.ts", "summary": "購物車" }));
        assert!(run.inbox("ai2").contains("TASK-03 is yours and ready"));
        run.ok("ai1", "review", json!({ "task": "TASK-02", "accept": false, "reason": "小計沒有含稅" }));
        assert!(run.inbox("ai3").contains("sent TASK-02 (購物車功能) back: 小計沒有含稅"));
        assert_eq!(run.store.state().task("TASK-02").unwrap().rejections, 1);
        run.ok("ai3", "deliver", json!({ "task": "TASK-02", "locator": "src/cart.ts", "summary": "小計含稅" }));
        run.ok("ai1", "review", json!({ "task": "TASK-02", "accept": true }));

        // AI 2 tests and hands in the report; once accepted the leader is asked to wrap up.
        run.make("test-report.md");
        run.ok("ai2", "deliver", json!({ "task": "TASK-03", "locator": "test-report.md", "summary": "全部通過" }));
        assert!(!run.store.state().wrapping);
        run.ok("ai1", "review", json!({ "task": "TASK-03", "accept": true }));
        assert!(run.store.state().wrapping);
        assert!(run.inbox("ai1").contains("Write the final report"));
        let snap = run.store.state().snapshot(&BTreeMap::new()).unwrap();
        assert_eq!((snap.done, snap.total), (3, 3));
        run.ok("ai1", "message_send", json!({ "to": "you", "text": "網站在 src/,測試報告在 test-report.md。" }));
        assert_eq!(run.store.state().messages.last().unwrap().to, YOU);
    }

    #[test]
    fn a_delivery_must_exist() {
        let mut run = Run::new("exists");
        plan(&mut run);
        let err = run.call("ai4", "deliver", json!({ "task": "TASK-01", "locator": "public/img", "summary": "x" })).unwrap_err();
        assert!(err.contains("Nothing exists at"), "{err}");
        assert_eq!(run.store.state().deliverables.len(), 0);
        // A URL is taken at its word.
        run.ok("ai4", "deliver", json!({ "task": "TASK-01", "locator": "http://localhost:5173/", "summary": "預覽" }));
    }

    #[test]
    fn what_a_member_may_not_do_is_said_in_words_it_can_act_on() {
        let mut run = Run::new("rules");
        plan(&mut run);
        let mut refuse = |member: &str, tool: &str, args: Value, needle: &str| {
            let err = run.call(member, tool, args).unwrap_err();
            assert!(err.contains(needle), "{tool}: expected '{needle}' in '{err}'");
        };
        refuse("ai3", "task_create", json!({ "title": "x", "owner": "ai3" }), "Only the leader creates tasks");
        refuse("ai1", "task_create", json!({ "title": "x", "owner": "ai9" }), "'ai9' is not a member");
        refuse("ai1", "task_create", json!({ "title": "x", "owner": "ai2", "depends_on": ["TASK-77"] }), "is not a task");
        refuse("ai1", "task_create", json!({ "owner": "ai2" }), "`title` is missing");
        refuse("ai2", "task_update", json!({ "task": "TASK-01", "status": "doing" }), "belongs to AI 4 (ai4)");
        refuse("ai3", "task_update", json!({ "task": "TASK-02", "status": "doing" }), "cannot start yet");
        refuse("ai4", "task_update", json!({ "task": "TASK-01", "status": "done" }), "calling `deliver`");
        refuse("ai4", "task_update", json!({ "task": "TASK-01", "done_criteria": [2] }), "criteria 1 to 1");
        refuse("ai4", "task_update", json!({ "task": "TASK-01" }), "Nothing to update");
        refuse("ai3", "deliver", json!({ "task": "TASK-02", "locator": "http://x/", "summary": "s" }), "has not been handed in yet");
        refuse("ai1", "review", json!({ "task": "TASK-01", "accept": true }), "nothing to review");
        refuse("ai4", "message_send", json!({ "to": "ai2", "text": "hi" }), "You have no line to AI 2 (ai2)");
        refuse("ai4", "message_send", json!({ "to": "all", "text": "hi" }), "Only the leader writes to everyone");
        refuse("ai4", "task_block", json!({ "task": "TASK-01", "reason": "r", "waiting_on": "ai4" }), "cannot wait on yourself");
        refuse("ai4", "nope", json!({}), "no tool called 'nope'");
        // Nothing was recorded by any of them.
        assert_eq!(run.store.state().tasks.len(), 3);
        assert!(run.store.state().feed.iter().all(|f| f.kind == "task"));
    }

    #[test]
    fn reviewing_is_for_the_reviewer_and_needs_a_reason_to_refuse() {
        let mut run = Run::new("review");
        plan(&mut run);
        run.ok("ai4", "deliver", json!({ "task": "TASK-01", "locator": "http://localhost/", "summary": "s" }));
        // The owner cannot accept its own work; a member with no part in it cannot either.
        assert!(run.call("ai4", "review", json!({ "task": "TASK-01", "accept": true })).is_err());
        assert!(run.call("ai2", "review", json!({ "task": "TASK-01", "accept": true })).is_err());
        let err = run.call("ai1", "review", json!({ "task": "TASK-01", "accept": false })).unwrap_err();
        assert!(err.contains("`reason` is missing"));
        // Whoever receives it may send it back.
        run.ok("ai3", "review", json!({ "task": "TASK-01", "accept": false, "reason": "尺寸不對" }));
        assert_eq!(run.store.state().task("TASK-01").unwrap().status, TaskStatus::Doing);
        assert_eq!(run.store.state().deliverables[0].accepted, Some(false));
    }

    #[test]
    fn the_leader_s_own_work_needs_no_reviewer() {
        let mut run = Run::new("own");
        run.ok("ai1", "task_create", json!({ "title": "需求拆解", "owner": "ai1" }));
        run.ok("ai1", "deliver", json!({ "task": "TASK-01", "locator": "http://localhost/spec", "summary": "規格" }));
        assert_eq!(run.store.state().task("TASK-01").unwrap().status, TaskStatus::Done);
    }

    #[test]
    fn waiting_for_the_person_is_a_question_they_can_see() {
        let mut run = Run::new("human");
        plan(&mut run);
        run.ok("ai4", "task_block", json!({ "task": "TASK-01", "reason": "要寫實風還是插畫風?", "waiting_on": "you" }));
        assert_eq!(run.status("ai4"), (MemberStatus::WaitingYou, Some(YOU.into())));
        assert_eq!(run.store.state().questions.len(), 1);
        run.ok("ai2", "ask_human", json!({ "question": "要支援手機版嗎?" }));
        assert_eq!(run.status("ai2").0, MemberStatus::WaitingYou);
    }

    #[test]
    fn reading_the_inbox_marks_it_read_and_the_board_follows_the_setting() {
        let mut run = Run::new("status");
        plan(&mut run);
        let text = run.ok("ai4", "team_status", json!({}));
        assert!(text.contains("New for you:") && text.contains("TASK-01 is yours and ready"), "{text}");
        assert!(text.contains("The rest of the board:") && text.contains("TASK-02"));
        assert!(run.inbox("ai4").is_empty());
        assert!(!run.ok("ai4", "team_status", json!({})).contains("New for you:"));

        let mut closed = Run::new("status-closed");
        let mut config = shop(&closed.dir.to_string_lossy());
        config.shared_board = false;
        closed.store = Store::memory();
        closed.store.append(Event::Started { config });
        plan(&mut closed);
        assert!(!closed.ok("ai4", "team_status", json!({})).contains("The rest of the board:"));
        assert!(closed.ok("ai1", "team_status", json!({})).contains("The rest of the board:"));
    }

    #[test]
    fn more_work_after_the_wrap_up_reopens_the_team() {
        let mut run = Run::new("reopen");
        run.ok("ai1", "task_create", json!({ "title": "a", "owner": "ai2" }));
        run.ok("ai2", "deliver", json!({ "task": "TASK-01", "locator": "http://localhost/", "summary": "s" }));
        run.ok("ai1", "review", json!({ "task": "TASK-01", "accept": true }));
        assert!(run.store.state().wrapping);
        run.ok("ai1", "task_create", json!({ "title": "b", "owner": "ai2" }));
        assert!(!run.store.state().wrapping);
        assert!(run.inbox("ai2").contains("TASK-02 is yours and ready"));
    }

    #[test]
    fn only_the_leader_is_offered_the_planning_tools() {
        let config = shop("D:\\x");
        let names = |member: &str| describe(&config, member).iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(
            names("ai1"),
            ["team_status", "task_create", "task_assign", "knowledge_share", "team_finish", "task_update", "task_block", "deliver", "review", "message_send", "knowledge_read", "ask_human"]
        );
        assert_eq!(names("ai3"), ["team_status", "task_update", "task_block", "deliver", "review", "message_send", "knowledge_read", "ask_human"]);
        for tool in describe(&config, "ai1") {
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert!(tool["description"].as_str().unwrap().len() > 20);
        }
    }
}
