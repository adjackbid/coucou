// The words a member is given. A member is another vendor's CLI: all it knows
// about the team is what these texts say, so they are plain, complete, and
// say every time which tool reports what.
//
// All of it is for a model, in English whatever the person's language; the
// line saying which language to write to the person in is added where the
// first-turn brief is put together (orchestrator.rs `next_turns`).

use super::state::{Message, State, Task, TaskStatus};
use super::{LinkKind, TeamConfig, SYSTEM, YOU};

/// `AI 3 (ai3)` — the name a person reads and the id a tool call needs.
// i18n: model-facing
pub fn who(config: &TeamConfig, id: &str) -> String {
    match id {
        YOU => "the user".to_string(),
        SYSTEM => "Agent Center".to_string(),
        other => match config.member(other) {
            Some(m) => format!("{} ({})", m.name, m.id),
            None => other.to_string(),
        },
    }
}

// i18n: model-facing
fn roster(config: &TeamConfig, me: &str) -> String {
    config
        .members
        .iter()
        .filter(|m| m.id != me)
        .map(|m| {
            let lead = if m.id == config.leader { ", the leader" } else { "" };
            format!("- {} ({}): {}{lead}", m.name, m.id, m.role)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a member is told once, at the start of its first turn.
// i18n: model-facing
pub fn role(config: &TeamConfig, me: &str) -> String {
    let Some(member) = config.member(me) else { return String::new() };
    let is_leader = me == config.leader;
    let mut out = String::new();

    out.push_str(&format!(
        "You are {name} (id `{id}`), the {role} of the team \"{team}\". The team is a group of AI coding agents, each in its own session, coordinated by Agent Center. The others cannot see your screen or your replies: the only things that reach them are what you send and hand in through the `coucou-team` tools.\n\n",
        name = member.name,
        id = member.id,
        role = member.role,
        team = config.name,
    ));
    out.push_str(&format!("The user's goal:\n{}\n", config.goal.trim()));
    if !config.scope.is_empty() {
        out.push_str(&format!("Scope: {}\n", config.scope.join(", ")));
    }
    if !config.expected.is_empty() {
        let list: Vec<String> = config.expected.iter().map(|e| if e.detail.is_empty() { e.name.clone() } else { format!("{} ({})", e.name, e.detail) }).collect();
        out.push_str(&format!("The user expects to end up with: {}\n", list.join("; ")));
    }
    if !member.duty.trim().is_empty() {
        out.push_str(&format!("\nYour duty: {}\n", member.duty.trim()));
    }

    out.push_str(&format!("\nYour teammates:\n{}\n", roster(config, me)));
    let from: Vec<String> = config.links.iter().filter(|l| l.kind == LinkKind::Delivery && l.to == me).map(|l| format!("{} from {}", if l.what.is_empty() { "work" } else { &l.what }, who(config, &l.from))).collect();
    let to: Vec<String> = config.links.iter().filter(|l| l.kind == LinkKind::Delivery && l.from == me).map(|l| format!("{} to {}", if l.what.is_empty() { "work" } else { &l.what }, who(config, &l.to))).collect();
    if !from.is_empty() {
        out.push_str(&format!("You receive: {}.\n", from.join("; ")));
    }
    if !to.is_empty() {
        out.push_str(&format!("You hand over: {}.\n", to.join("; ")));
    }

    out.push_str(&format!("\nEveryone works in the same folder: {}\nStay inside it. Other members edit files there too, so keep to the files your task is about.\n", config.work_dir));
    out.push_str(&crate::constitution::brief_text());

    out.push_str("\nHow the team works:\n");
    if is_leader {
        out.push_str(
            "- You are the leader. Break the goal into tasks with `task_create`: one owner each, the criteria that make it done, the tasks it depends on (`depends_on`) and who receives the result (`deliver_to`). Give every teammate work that fits their role, then end your turn. Agent Center hands each task to its owner as soon as what it depends on has been delivered.\n\
             - When a teammate hands something in you are told. Check it against the criteria and call `review` to accept it or send it back with the reason.\n\
             - Answer teammates' questions with `message_send`. The user may send you new instructions at any time: adjust the tasks to them.\n",
        );
    } else {
        out.push_str("- The leader hands out tasks. You are told when one is yours and ready; until then there is nothing to do.\n");
    }
    out.push_str(
        "- When you start a task: `task_update` with status `doing`. As you meet its criteria: `task_update` with `done_criteria`.\n\
         - When it is finished: `deliver` with where the result is (a path in the work folder, or a URL) and one or two sentences on what it is. A task is not finished until you have called `deliver`.\n\
         - When you cannot go on: `task_block` with the reason and who you are waiting for, or `ask_human` if only the user can decide. Then end your turn.\n\
         - To ask or tell a teammate something: `message_send`. `team_status` shows your tasks, the board and any new messages.\n\
         - Then end your turn. You get a new turn when a task, a delivery or a message arrives for you. Do not wait or poll.\n\
         - Write notes, messages and summaries in the language named on the last line of this brief.\n",
    );
    out
}

/// The leader's first message.
// i18n: model-facing
pub fn kickoff(config: &TeamConfig) -> String {
    format!(
        "The team has started. Plan the work for this goal and create the tasks now:\n{}\nUse `team_status` to see your teammates and `task_create` for each task.",
        config.goal.trim()
    )
}

/// A task handed to its owner.
// i18n: model-facing
pub fn task(state: &State, task: &Task) -> String {
    let config = state.config.as_ref();
    let name = |id: &str| config.map(|c| who(c, id)).unwrap_or_else(|| id.to_string());
    let mut out = format!("{} is yours and ready to start: {}\n", task.id, task.title);
    if !task.detail.trim().is_empty() {
        out.push_str(&format!("{}\n", task.detail.trim()));
    }
    if !task.criteria.is_empty() {
        out.push_str("Done when:\n");
        for (i, c) in task.criteria.iter().enumerate() {
            out.push_str(&format!("{}. {}\n", i + 1, c.text));
        }
    }
    for dep in &task.depends_on {
        if let Some(d) = state.task(dep) {
            let handed = state.deliverables.iter().rev().find(|x| x.task.eq_ignore_ascii_case(&d.id));
            match handed {
                Some(x) => out.push_str(&format!("Input — {} ({}) from {}: {} — {}\n", d.id, d.title, name(&x.by), x.locator, x.summary)),
                None => out.push_str(&format!("Input — {} ({})\n", d.id, d.title)),
            }
        }
    }
    if let Some(to) = &task.deliver_to {
        out.push_str(&format!("Your result goes to {}.\n", name(to)));
    }
    if task.rejections > 0 && !task.note.is_empty() {
        out.push_str(&format!("Last note on it: {}\n", task.note));
    }
    out.push_str(&format!(
        "Call `task_update` (task \"{id}\", status \"doing\") now, `deliver` when it is finished, `task_block` if you cannot go on.",
        id = task.id
    ));
    out
}

// i18n: model-facing
pub fn to_review(config: &TeamConfig, task: &Task, by: &str, locator: &str, summary: &str) -> String {
    let criteria: Vec<String> = task.criteria.iter().enumerate().map(|(i, c)| format!("{}. {}", i + 1, c.text)).collect();
    format!(
        "{} handed in {} ({}): {}\nWhere: {}\n{}Check it and call `review` (task \"{}\", accept true or false, and the reason when you send it back).",
        who(config, by),
        task.id,
        task.title,
        summary,
        locator,
        if criteria.is_empty() { String::new() } else { format!("It is done when:\n{}\n", criteria.join("\n")) },
        task.id,
    )
}

// i18n: model-facing
pub fn as_input(config: &TeamConfig, task: &Task, by: &str, locator: &str, summary: &str) -> String {
    format!(
        "{} handed in {} ({}), which is meant for you: {}\nWhere: {}",
        who(config, by),
        task.id,
        task.title,
        summary,
        locator
    )
}

// i18n: model-facing
pub fn rejected(config: &TeamConfig, task: &Task, by: &str, reason: &str) -> String {
    format!(
        "{} sent {} ({}) back: {}\nFix it, then `deliver` again.",
        who(config, by),
        task.id,
        task.title,
        reason
    )
}

/// A member ended its turn with work still open and nothing said about it.
// i18n: model-facing
pub fn nudge(tasks: &[&Task]) -> String {
    let list: Vec<String> = tasks
        .iter()
        .map(|t| format!("{} ({}, {})", t.id, t.title, if t.status == TaskStatus::Doing { "doing" } else { "not started" }))
        .collect();
    format!(
        "You ended your turn, but this is still open and Agent Center has no report on it: {}.\nIf it is finished, call `deliver`. If you are stuck, call `task_block` with the reason. Otherwise carry on with it now.",
        list.join("; ")
    )
}

// i18n: model-facing
pub fn nudge_leader_no_tasks() -> String {
    "No task exists yet, so nobody on the team has anything to do. Create the tasks with `task_create` now.".to_string()
}

// i18n: model-facing
pub fn wrap_up(state: &State) -> String {
    let handed: Vec<String> = state.deliverables.iter().filter(|d| d.accepted == Some(true)).map(|d| format!("- {}: {} ({})", d.task, d.locator, d.summary)).collect();
    format!(
        "Every task has been accepted. Write the final report for the user with `message_send` (to \"you\"): what was built, where it is, how to run or open it, and anything left undone. Then call `team_finish` to close the team. If something is still missing, create the tasks for it instead.\nAccepted so far:\n{}",
        handed.join("\n")
    )
}

/// Everything is accepted and nobody works, but the leader has not closed the team.
// i18n: model-facing
pub fn finish_reminder() -> String {
    "Every task is accepted and nobody on the team is working. If the user's request is fully handled and you have reported to them, call `team_finish` to close the team. If something is still left, create the tasks for it or say what you are waiting for."
        .to_string()
}

/// A member's request the constitution refused.
// i18n: model-facing
pub fn refused(title: &str, rule: &str) -> String {
    format!("Agent Center refused \"{title}\": the user's constitution says {rule}. It will be refused every time — do not try it again. Find another way, or tell the leader (or ask the user with `ask_human`) if the task cannot be done without it.")
}

/// The leader of a finished team, when the person comes back with more.
// i18n: model-facing
pub fn reopened() -> String {
    "The team had finished and you had reported. The user has come back with more — their message follows. If it needs work, plan it: create the tasks with `task_create` and the team carries on; when everything is accepted again you will be asked for a new report. If it is a question, or something you can settle in a word, answer the user with `message_send` (to \"you\"). If you ask teammates for something, wait for their answers before you answer. Once the user's request is fully handled, call `team_finish`."
        .to_string()
}

/// The start of a turn: everything that arrived for the member since its last.
// i18n: model-facing
pub fn turn(config: &TeamConfig, messages: &[&Message]) -> String {
    let mut out = String::new();
    for m in messages {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        if m.from == SYSTEM {
            out.push_str(&m.text);
        } else {
            let about = m.task.as_deref().map(|t| format!(" about {t}")).unwrap_or_default();
            out.push_str(&format!("Message from {}{about}:\n{}", who(config, &m.from), m.text));
        }
    }
    out
}

/// Coucou was closed while the team worked, and is picking it up again: the
/// member's agent is a new session that remembers nothing.
// i18n: model-facing
pub fn revived(open: &[&Task], to_review: &[&Task]) -> String {
    let mut out = "Agent Center was closed while the team was working and has now picked the team up again. Your session is a new one: call `team_status` to see where the team stands.".to_string();
    if !open.is_empty() {
        let list: Vec<String> = open
            .iter()
            .map(|t| format!("{} ({}, {})", t.id, t.title, if t.status == TaskStatus::Doing { "doing" } else { "not started" }))
            .collect();
        out.push_str(&format!(" Then carry on with: {}.", list.join("; ")));
    }
    if !to_review.is_empty() {
        let list: Vec<String> = to_review.iter().map(|t| format!("{} ({})", t.id, t.title)).collect();
        out.push_str(&format!(" Handed in and waiting for your `review`: {}.", list.join("; ")));
    }
    out
}

/// The person added someone to the team while it runs: the leader puts them to work.
// i18n: model-facing
pub fn joined(config: &TeamConfig, member: &str) -> String {
    let m = config.members.iter().find(|m| m.id == member);
    let what = m
        .map(|m| [m.role.trim(), m.duty.trim()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(": "))
        .unwrap_or_default();
    format!(
        "A new teammate has joined to speed the work up: {}{}. They have nothing to do yet. Give them work now: create tasks for them with `task_create` (owner \"{member}\"), or move open work that has not started to them with `task_assign`. Split large tasks so they can work in parallel with the others.",
        who(config, member),
        if what.is_empty() { String::new() } else { format!(" — {what}") },
    )
}
