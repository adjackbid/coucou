// The words a member is given. A member is another vendor's CLI: all it knows
// about the team is what these texts say, so they are plain, complete, and
// say every time which tool reports what.
//
// All of it is for a model, in English whatever the person's language; the
// line saying which language to write to the person in is added where the
// first-turn brief is put together (orchestrator.rs `next_turns`).

use super::state::{Message, SpecPhase, State, Task, TaskStatus};
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
    // What Agent Center gave this member when the team was proposed.
    if !member.brief.trim().is_empty() || !member.skills.is_empty() {
        out.push_str("\nFrom Agent Center, to keep throughout your work:\n");
        if !member.brief.trim().is_empty() {
            out.push_str(member.brief.trim());
            out.push('\n');
        }
        if !member.skills.is_empty() {
            out.push_str(&crate::team_agents::skill_text(&member.skills));
        }
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
            "- You are the leader. Break the goal into tasks with `task_create`: one owner each, the criteria that make it done, the tasks it depends on (`depends_on`), who receives the result (`deliver_to`) and, if not you, who accepts it (`reviewer`). Give every teammate work that fits their role, then end your turn. Agent Center hands each task to its owner as soon as what it depends on has been delivered.\n\
             - When a teammate hands something in you are told. Check it against the criteria and call `review` to accept it or send it back with the reason.\n\
             - Answer teammates' questions with `message_send`. The user may send you new instructions at any time: adjust the tasks to them.\n",
        );
        out.push_str(
            "\nHow Agent Center runs the team, and what follows for your plan:\n\
             - Each member runs one turn at a time. Two tasks owned by the same member run one after the other, so spread independent tasks over different members (yourself included) and give everyone work in your first turn. A member holding most of the tasks sets the finish time.\n\
             - A member reads messages only at the start of a turn. A ruling sent while someone is deep in a long turn reaches them after they hand in, and the work is redone. Put the rules in the task itself; send corrections in one message, not several.\n\
             - A dependent task starts as soon as its inputs are handed in, before they are accepted. Only a rejection sends the chain backwards.\n\
             - Size the goal first. A fact or a short answer: one task for yourself, do it, deliver, report to the user with `message_send` (to \"you\"), `team_finish`. One document with no natural split: one member does it, another accepts it (`reviewer`). Several parts: split by scope (themes, chapters, product lines), each member from start to finish, chains of at most two links; if the user fixed the roles, split by batch instead and have each member deliver batch by batch. Do not put the cheapest model at the head of a chain.\n\
             - Review against the criteria you wrote. Send back once with every fix listed; accepted is final, no follow-up checks by message. If a task comes back a second time, move it with `task_assign` or do it yourself. Spot-check two or three items rather than redoing a member's work.\n\
             - A member out of quota, missing a tool, or blocked for more than a turn: move its remaining work with `task_assign` at once.\n",
        );
        if config.openspec.is_some() {
            out.push_str(&format!("\n{}\n", spec_rules(config)));
        }
        if config.fast {
            out.push_str(&format!("\n{}\n", fast_rules()));
        }
        if config.time_limit_min > 0 {
            out.push_str(&format!("\n{}\n", time_rules(config)));
        }
        let library = crate::team_agents::member_library();
        if !library.is_empty() {
            out.push_str("\nSkills in Agent Center's library. Hand one to a teammate with `brief_member` (skills: [name]) when it fits their task; they get its text with their role:\n");
            for s in &library {
                out.push_str(&format!("- {}{}\n", s.name, if s.description.is_empty() { String::new() } else { format!(": {}", s.description) }));
            }
        }
    } else {
        out.push_str("- The leader hands out tasks. You are told when one is yours and ready; until then there is nothing to do.\n");
        if config.openspec.is_some() {
            out.push_str("- The team follows the OpenSpec flow: what to build is written up as a change under openspec/changes/ (proposal, specs with scenarios, tasks), approved by the user. Read it for your task's context and check your work against its scenarios. Only the leader edits the change's files; you change the code.\n");
        }
    }
    out.push_str(
        "- When you start a task: `task_update` with status `doing`. As you meet its criteria: `task_update` with `done_criteria`.\n\
         - When it is finished: `deliver` with where the result is (a path in the work folder, or a URL) and one or two sentences on what it is. A task is not finished until you have called `deliver`.\n\
         - When you cannot go on: `task_block` with the reason and who you are waiting for, or `ask_human` if only the user can decide. Then end your turn.\n\
         - To ask or tell a teammate something: `message_send`. `team_status` shows your tasks, the board and any new messages.\n\
         - Then end your turn. You get a new turn when a task, a delivery or a message arrives for you. Do not wait or poll.\n\
         - Tool results tell you when messages arrived during your turn: call `team_status` to read them before you deliver, so a ruling does not reach you after the work is done.\n\
         - Write notes, messages and summaries in the language named on the last line of this brief.\n",
    );
    out
}

/// What the leader gave a member to keep (`brief_member`), as a message to
/// one already at work.
// i18n: model-facing
pub fn briefed(text: &str) -> String {
    format!("From the leader, to keep throughout your work:\n{text}")
}

/// Everything the leader gave a member to keep, for its first-turn brief;
/// nothing when there is none.
// i18n: model-facing
pub fn briefs(state: &State, member: &str) -> String {
    match state.briefs.get(member).filter(|b| !b.is_empty()) {
        Some(items) => format!("\nFrom the leader, to keep throughout your work:\n{}\n", items.join("\n\n")),
        None => String::new(),
    }
}

/// Appended to a tool result when messages arrived during the turn.
// i18n: model-facing
pub fn unread(n: usize) -> String {
    format!("You have {n} unread message{}. Call `team_status` to read {} before you go on.", if n == 1 { "" } else { "s" }, if n == 1 { "it" } else { "them" })
}

/// The leader's first message.
// i18n: model-facing
pub fn kickoff(config: &TeamConfig) -> String {
    if config.openspec.is_some() {
        return spec_kickoff(config);
    }
    let plan = if config.kickoff.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nAgent Center's plan for this team, from the user's request. Follow it unless the board shows it is wrong; then say what you changed and why:\n{}", config.kickoff.trim())
    };
    let fast = if config.fast { format!("\n\n{}", fast_rules()) } else { String::new() };
    let timed = if config.time_limit_min > 0 { format!("\n\n{}", time_rules(config)) } else { String::new() };
    format!(
        "The team has started. Plan the work for this goal and create the tasks now:\n{}\nUse `team_status` to see your teammates and `task_create` for each task.{plan}{fast}{timed}",
        config.goal.trim()
    )
}

/// The leader's first message in the OpenSpec flow: the change first, the tasks
/// after the person approved it; Agent Center's plan is for then.
// i18n: model-facing
fn spec_kickoff(config: &TeamConfig) -> String {
    let plan = if config.kickoff.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nAgent Center's plan for this team, from the user's request: who does what and who reviews. Use it when you create the implementation tasks, after the user has approved the change:\n{}", config.kickoff.trim())
    };
    let fast = if config.fast { format!("\n\n{}", fast_rules()) } else { String::new() };
    let timed = if config.time_limit_min > 0 { format!("\n\n{}", time_rules(config)) } else { String::new() };
    format!(
        "The team has started with the OpenSpec flow on. Do not plan implementation tasks yet: first look at the project, talk the change over with the user, write it up as an OpenSpec change and hand it in with `spec_submit`. The goal:\n{}\n\n{}{plan}{fast}{timed}",
        config.goal.trim(),
        spec_rules(config),
    )
}

/// What the OpenSpec flow asks of the leader (TeamConfig::openspec), after
/// OpenSpec's own advice for an existing project: explore, talk it over,
/// propose, have it reviewed, then apply; archive once merged. Said with the
/// kickoff and again in the leader's role.
// i18n: model-facing
pub fn spec_rules(config: &TeamConfig) -> String {
    let Some(spec) = config.openspec.as_ref() else { return String::new() };
    let carry_on = if spec.change.trim().is_empty() {
        String::new()
    } else {
        format!(" The user asked to carry on with the change `{0}`: start from `openspec status --change {0} --json` and keep what is already written.", spec.change.trim())
    };
    let design = if spec.full && !config.fast {
        "design.md (the technical approach, the options and why this one)"
    } else {
        "design.md only if the change cuts across modules or holds a real technical choice (keep it lite: short requirements, a few scenarios each)"
    };
    format!(
        "OPENSPEC FLOW is on: the user wants what will be built written up as an OpenSpec change (github.com/Fission-AI/openspec) and approved by them before anything is built. Agent Center enforces it: until the user approves the change, `task_create` only takes spec tasks (`kind` \"spec\") and the team cannot close. Use the `openspec` command line, not slash commands; add `--json` where you read its output.\n\
         0. Set up. No openspec/ folder in the work folder: `openspec init --tools <your CLI: claude, codex, gemini, github-copilot…>` (or `--tools none`). No `openspec` command: it needs Node.js 20.19+ and `npm install -g @fission-ai/openspec@latest`; installing asks the user's permission, so say why.{carry_on}\n\
         1. Explore. Read the parts of the code the goal touches and the current specs (`openspec list --specs`, `openspec show <spec>`). Write no code. A teammate may explore a part for you: a task with `kind` \"spec\", handed in as notes.\n\
         2. Talk it over. Ask what only the user can decide in one `ask_human` with `questions`: the scope and what is left out, the options you see and their trade-offs, how they will know it works. Give `options` where there are clear choices. One to three rounds are usually enough; when the goal is already precise, go straight to 3.\n\
         3. Propose. `openspec new change <kebab-name>`, then for each artifact `openspec status --change <name> --json` (the first \"ready\" one is next) and `openspec instructions <artifact> --change <name> --json` (its template and rules): proposal.md (why, what changes, which capabilities), the delta specs in specs/<capability>/spec.md (ADDED / MODIFIED / REMOVED Requirements with SHALL or MUST, each with `#### Scenario:` WHEN / THEN), {design}, tasks.md (checkbox groups, each small enough for one member). Then `openspec validate <name>` and fix what it reports.\n\
         4. Review. `spec_submit` with the change's name, a summary for the user and what validate said, then end your turn. The user approves it or sends it back with what to change; then update the files, validate and `spec_submit` again. Only their approval on the review card unlocks implementation: if they answer in a message instead, ask them to approve or send it back on the card.\n\
         5. Implement. Once approved: `openspec instructions apply --change <name> --json`, then create the tasks from tasks.md, one per group, `criteria` from the scenarios it must meet, owners and reviewers as usual. You alone edit openspec/changes/<name>/ (one change, one owner); members change the code. Tick a box in tasks.md when you accept the work that does it.\n\
         6. Verify. Review against the change's scenarios, not only the task text. If the requirements must change, update the change and `spec_submit` again: new implementation tasks wait for the user's approval.\n\
         7. Finish. Report as usual and say the change can be archived (`openspec archive <name>`) once the work is merged. Do not archive it unless the user asks.",
    )
}

/// Why `task_create` refused an implementation task before the change was approved.
// i18n: model-facing
pub fn spec_locked(state: &State) -> String {
    if state.spec_phase() == Some(SpecPhase::Review) {
        return format!("The change `{}` is with the user for review. Until they approve it, only spec tasks can be created (`kind` \"spec\"). End your turn; their answer starts your next one.", state.spec.change);
    }
    "The OpenSpec flow is on and the user has not approved a change yet, so only spec tasks can be created (`kind` \"spec\": exploring the code, drafting a part of the change). Carry on with the flow: ask the user with `ask_human`, write the change under openspec/changes/, then hand it in with `spec_submit`."
        .to_string()
}

/// Where the OpenSpec flow stands, for `team_status`; nothing for a team not in it.
// i18n: model-facing
pub fn spec_status(state: &State) -> Option<String> {
    let spec = &state.spec;
    Some(match state.spec_phase()? {
        SpecPhase::Exploring if spec.rounds == 0 => "OpenSpec flow: no change handed in yet. Only spec tasks until the user approves one.".to_string(),
        SpecPhase::Exploring => format!("OpenSpec flow: the user sent the change `{}` back: {}. Update it and `spec_submit` again.", spec.change, spec.note),
        SpecPhase::Review => format!("OpenSpec flow: the change `{}` is with the user for review.", spec.change),
        SpecPhase::Approved => format!("OpenSpec flow: the user approved the change `{}`; the team implements it.", spec.change),
        SpecPhase::Archiving => format!("OpenSpec flow: the user asked to archive the change `{}`.", spec.change),
    })
}

/// The leader ended a turn in the OpenSpec flow with nothing under way: no
/// question for the user, no change handed in, no task. Nothing when it is
/// fine to wait.
// i18n: model-facing
pub fn spec_nudge(state: &State) -> Option<String> {
    match state.spec_phase()? {
        SpecPhase::Exploring if state.tasks.iter().all(|t| t.status == TaskStatus::Done) => Some(
            "You ended your turn without a step of the OpenSpec flow, and nobody is working. Carry on: ask the user with `ask_human`, or write the change and hand it in with `spec_submit`.".to_string(),
        ),
        SpecPhase::Approved if !state.tasks.iter().any(|t| !t.spec) => Some(format!(
            "The user approved the change `{0}`, but no implementation task exists yet. Read `openspec instructions apply --change {0} --json` and create the tasks from tasks.md with `task_create` now.",
            state.spec.change
        )),
        _ => None,
    }
}

/// The person approved the change: the leader plans the implementation.
// i18n: model-facing
pub fn spec_approved(change: &str, note: &str) -> String {
    let note = if note.trim().is_empty() { String::new() } else { format!(" They added: {}", note.trim()) };
    format!(
        "The user approved the change `{change}`.{note}\nImplement it now: read `openspec instructions apply --change {change} --json`, then create the tasks from tasks.md with `task_create`, one per group, with `criteria` from the scenarios each must meet. Only you edit openspec/changes/{change}/; tick tasks.md as you accept the work."
    )
}

/// The person sent the change back.
// i18n: model-facing
pub fn spec_returned(change: &str, note: &str) -> String {
    format!(
        "The user sent the change `{change}` back: {}\nUpdate it (proposal, specs, design, tasks as needed), run `openspec validate {change}`, and `spec_submit` again. If something is unclear, ask with `ask_human` first.",
        note.trim()
    )
}

/// What fast mode asks of the leader (TeamConfig::fast): the smallest team that
/// does the job, one review, no second round. Said with the kickoff and again
/// in the leader's role, so it holds for the whole run.
// i18n: model-facing
pub fn fast_rules() -> String {
    "FAST MODE is on: the user wants the result in the shortest time, with one independent check for accuracy. Rules that override your planning habits:\n\
     1. Size first, and choose the smaller size when in doubt. A fact, a short answer or one small file: one task owned by you, do it yourself now, `deliver`, report to the user with `message_send` (to \"you\"), `team_finish`. Do not give teammates work for a quick goal.\n\
     2. One deliverable with no natural split: one member does the whole thing and one other member, on a different model, is its `reviewer`. Nobody else works on it.\n\
     3. Several parts: split by scope so every member works at the same time, from start to finish on its slice; hand-off chains of at most two links. When the user fixed the roles, split by batch and have each member deliver batch by batch.\n\
     4. Every task is reviewed once. Send it back at most once, with every fix listed; if it comes back again, accept it and fix the rest yourself or move it with `task_assign`. Accepted is final: no follow-up checks or additions by message.\n\
     5. Spot-check two or three items; never redo a member's work. Keep your own messages short.\n\
     6. A member blocked, out of quota or silent for a turn: move its work at once."
        .to_string()
}

/// What a time limit asks of the leader (TeamConfig::time_limit_min): the last part
/// is for assembling, and the deliverable goes out at the limit, done or not.
// i18n: model-facing
pub fn time_rules(config: &TeamConfig) -> String {
    let total = config.time_limit_min;
    let reserve = config.time_reserve_min();
    format!(
        "TIME LIMIT: the user wants the deliverable within {total} minutes of the start, done or not. The last {reserve} minutes are reserved for assembling, so the work itself has {} minutes. Rules:\n\
         1. Plan for the time: small first batches that can be assembled on their own, delivered early; nothing that only pays off at the end.\n\
         2. You will get a message when the reserve begins. From then on hand out no new work, collect what has been handed in (accept it as it is), write the deliverable from it yourself, mark plainly what is missing or unverified, `deliver`, report to the user with `message_send` (to \"you\"), and `team_finish`.\n\
         3. When the limit is reached you will be told again: deliver within your next turn with whatever you have, even a partial one, and close the team.\n\
         4. A partial deliverable on time beats a complete one late.",
        total.saturating_sub(reserve)
    )
}

/// The reserve of the time limit has begun.
// i18n: model-facing
pub fn time_reserve(config: &TeamConfig, left_min: u64) -> String {
    format!(
        "TIME CHECK: {left_min} of the {} minutes are left: the assembling reserve has begun. Hand out no new work. Collect what has been handed in (accept it as it is), write the deliverable from it yourself now, mark what is missing or unverified, `deliver`, report to the user with `message_send` (to \"you\"), then `team_finish`. Teammates still working: tell them with `message_send` to hand in what they have within this turn.",
        config.time_limit_min
    )
}

/// The time limit is reached.
// i18n: model-facing
pub fn time_up(config: &TeamConfig) -> String {
    format!(
        "TIME IS UP: the {} minutes are over. Deliver now, in this turn, with whatever you have: write the deliverable from what is in, mark the gaps, `deliver`, report to the user with `message_send` (to \"you\"), and `team_finish`. Do not wait for anyone.",
        config.time_limit_min
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
        "{} handed in {} ({}): {}\nWhere: {}\n{}Check it against these and call `review` (task \"{}\", accept true or false). If you send it back, list every fix in the reason at once; once accepted, it is final.{}",
        who(config, by),
        task.id,
        task.title,
        summary,
        locator,
        if criteria.is_empty() { String::new() } else { format!("It is done when:\n{}\n", criteria.join("\n")) },
        task.id,
        if config.fast && task.rejections >= 1 { " Fast mode: it was sent back once already, so accept it now and fix what is left yourself, or move it with `task_assign`." } else if config.fast { " Fast mode: spot-check two or three criteria; this is the one review it gets." } else { "" },
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

/// A task was sent back for the second time: the leader changes the plan
/// rather than the reviewer trying a third time.
// i18n: model-facing
pub fn rejected_again(task: &Task) -> String {
    format!(
        "{} ({}) has now been sent back twice. Rather than another round, move it to someone else with `task_assign` or do it yourself; a third rejection pauses the team for the user.",
        task.id, task.title,
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
    let spec = match state.spec_phase() {
        Some(_) => format!(
            "\nOpenSpec: tick every box of openspec/changes/{0}/tasks.md that the accepted work does, run `openspec validate {0}`, and tell the user in the report that the change can be archived (`openspec archive {0}`) once the work is merged.",
            state.spec.change
        ),
        None => String::new(),
    };
    format!(
        "Every task has been accepted. Write the final report for the user with `message_send` (to \"you\"): what was built, where it is, how to run or open it, and anything left undone. Then call `team_finish` to close the team. If something is still missing, create the tasks for it instead.{spec}\nAccepted so far:\n{}",
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
