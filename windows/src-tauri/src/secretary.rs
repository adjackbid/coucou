// Coucou's secretary: the person asks, in their own words, and a chat model
// answers with Coucou's records in hand — how the teams are doing, who is
// stuck, what it all cost — and, when asked to, prepares what the person
// wants done: a new team, an instruction, a pause. Nothing it prepares
// happens until the person clicks 確認 on it (the Teamwork window calls
// `confirm` from that click alone); what it reads, it reads freely.
//
// It is called on, never running by itself: one conversation, kept in
// memory, sent to the chat provider the person picked, with Coucou's office
// tools (below) as the only tools it has — no files, no shell.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use crate::acp::{AgentProfile, Agents};
use crate::llm::tools::{self, Call, Tool, Turn};
use crate::llm::Provider;
use crate::settings;
use crate::team::orchestrator::Teams;
use crate::team::TeamConfig;

const MAX_ROUNDS: usize = 8;
const MAX_RESULT: usize = 8000;
const KEEP_TURNS: usize = 60;
const COLORS: [&str; 8] = ["#5b8def", "#34c7a0", "#a06cf0", "#f5b63d", "#f472b6", "#22d3ee", "#84cc16", "#f97316"];

/// Something the secretary prepared, waiting for the person's click.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    /// "team", "instruction" or "action".
    pub kind: String,
    pub title: String,
    /// What it will do, line by line, for the card.
    pub lines: Vec<String>,
    /// The confirm button's words.
    pub confirm: String,
    /// "open", "done", "declined" or "failed".
    pub state: String,
    pub outcome: String,
    #[serde(skip)]
    payload: Value,
}

/// A look-up or a preparation the secretary made on the way to its answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub tool: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub text: String,
    pub steps: Vec<Step>,
    pub proposals: Vec<Proposal>,
}

/// What the secretary can see and act on.
pub struct Office {
    pub teams: Arc<Teams>,
    pub agents: Vec<AgentProfile>,
    pub driver: Arc<Agents>,
    /// The person's clock: minutes to add to UTC for local time.
    pub tz_minutes: i64,
    /// What the person calls the secretary; empty for no name.
    pub name: String,
}

#[derive(Default)]
pub struct Secretary {
    turns: Mutex<Vec<Turn>>,
    proposals: Mutex<Vec<Proposal>>,
    /// What the person did with proposals since the model last heard, told with their next words.
    notes: Mutex<Vec<String>>,
    busy: AtomicBool,
}

impl Secretary {
    pub fn reset(&self) {
        self.turns.lock().unwrap().clear();
        self.proposals.lock().unwrap().clear();
        self.notes.lock().unwrap().clear();
    }

    /// One request from the person: the secretary looks things up and
    /// prepares what is asked, then answers.
    pub async fn ask(&self, provider: &Provider, office: &Office, text: &str, on_step: &(dyn Fn(&Step) + Send + Sync)) -> Result<Reply, String> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("The secretary is still on the last request.".into());
        }
        let result = self.run(provider, office, text, on_step).await;
        self.busy.store(false, Ordering::SeqCst);
        result
    }

    async fn run(&self, provider: &Provider, office: &Office, text: &str, on_step: &(dyn Fn(&Step) + Send + Sync)) -> Result<Reply, String> {
        let notes: Vec<String> = std::mem::take(&mut *self.notes.lock().unwrap());
        let said = if notes.is_empty() { text.to_string() } else { format!("{}\n\n{text}", notes.join("\n")) };
        let mut turns = self.turns.lock().unwrap().clone();
        let start = turns.len();
        turns.push(Turn::User(said));
        let system = system_prompt(office);
        let tools = describe();
        let mut steps = Vec::new();
        let mut made = Vec::new();

        for _ in 0..MAX_ROUNDS {
            let reply = tools::complete(provider, &system, &turns, &tools).await?;
            if reply.calls.is_empty() {
                let text = reply.text.trim().to_string();
                if text.is_empty() {
                    return Err(format!("{} gave no answer.", provider.name));
                }
                turns.push(Turn::Assistant { text: text.clone(), calls: vec![] });
                self.keep(turns);
                return Ok(Reply { text, steps, proposals: made });
            }
            let mut results = Vec::new();
            for call in &reply.calls {
                let step = Step { tool: call.name.clone(), label: label(call, office) };
                on_step(&step);
                steps.push(step);
                let out = match self.call(call, office).await {
                    Ok(Called::Text(t)) => t,
                    Ok(Called::Proposed(p)) => {
                        let text = format!("Proposal {} is on the user's screen as a card. Nothing has happened yet: it happens only if they click it. Tell them in one or two lines what you prepared.", p.id);
                        made.push(p);
                        text
                    }
                    Err(err) => format!("ERROR: {err}"),
                };
                results.push((call.id.clone(), call.name.clone(), cut(&out, MAX_RESULT)));
            }
            turns.push(Turn::Assistant { text: reply.text.clone(), calls: reply.calls.clone() });
            turns.push(Turn::Results(results));
        }
        // Out of rounds: what was found so far is kept, the person told.
        let _ = start;
        self.keep(turns);
        Ok(Reply { text: "這件事需要查的東西比較多,我先停在這裡。可以再說得具體一點,或請我接著查。".into(), steps, proposals: made })
    }

    /// Keeps the conversation, from a user turn on, within bounds.
    fn keep(&self, mut turns: Vec<Turn>) {
        if turns.len() > KEEP_TURNS {
            let mut cut = turns.len() - KEEP_TURNS;
            while cut < turns.len() && !matches!(turns[cut], Turn::User(_)) {
                cut += 1;
            }
            turns.drain(..cut);
        }
        *self.turns.lock().unwrap() = turns;
    }

    pub fn proposal(&self, id: &str) -> Option<Proposal> {
        self.proposals.lock().unwrap().iter().find(|p| p.id == id).cloned()
    }

    fn settle(&self, id: &str, state: &str, outcome: &str) -> Option<Proposal> {
        let mut all = self.proposals.lock().unwrap();
        let p = all.iter_mut().find(|p| p.id == id)?;
        p.state = state.into();
        p.outcome = outcome.into();
        let note = match state {
            "done" => format!("[Coucou] The user confirmed {} ({}): {outcome}", p.id, p.title),
            "declined" => format!("[Coucou] The user declined {} ({}).", p.id, p.title),
            _ => format!("[Coucou] {} ({}) was confirmed but failed: {outcome}", p.id, p.title),
        };
        self.notes.lock().unwrap().push(note);
        Some(p.clone())
    }

    pub fn decline(&self, id: &str) -> Option<Proposal> {
        let open = self.proposal(id).is_some_and(|p| p.state == "open");
        open.then(|| self.settle(id, "declined", "")).flatten()
    }

    /// The work folder proposal `id` needs and that is not there yet, if any:
    /// the card asks the person whether to create it before confirming.
    pub fn missing_folder(&self, id: &str) -> Option<String> {
        let p = self.proposal(id).filter(|p| p.state == "open")?;
        let dir = match (p.kind.as_str(), s(&p.payload, "action")) {
            ("team", _) => p.payload["config"]["workDir"].as_str().unwrap_or_default().to_string(),
            ("action", "start") => crate::read_team_file(&format!("{}.json", s(&p.payload, "team"))).ok()?.work_dir,
            _ => return None,
        };
        matches!(folder_state(&dir), Folder::Missing).then_some(dir)
    }

    /// Does what proposal `id` says. Called only from the person's click on its card.
    /// `create_folder` is the person's answer to "the work folder does not exist,
    /// create it?": without it a missing folder is never created.
    pub async fn confirm(&self, id: &str, office: &Office, create_folder: bool) -> Result<Proposal, String> {
        let p = self.proposal(id).ok_or("That proposal is no longer there.")?;
        if p.state != "open" {
            return Err("That proposal was already dealt with.".into());
        }
        let done = match p.kind.as_str() {
            "team" => create_team(&p.payload, office, create_folder).await,
            "instruction" => instruct(&p.payload, office),
            "action" => act(&p.payload, office, create_folder).await,
            _ => Err("Unknown proposal.".into()),
        };
        match done {
            Ok(outcome) => Ok(self.settle(id, "done", &outcome).unwrap()),
            Err(err) => {
                self.settle(id, "failed", &err);
                Err(err)
            }
        }
    }

    async fn call(&self, call: &Call, office: &Office) -> Result<Called, String> {
        let a = &call.arguments;
        match call.name.as_str() {
            "list_teams" => Ok(Called::Text(list_teams(office, a.get("include_archived").and_then(Value::as_bool).unwrap_or(false)))),
            "team_detail" => Ok(Called::Text(team_detail(office, &need(a, "team")?)?)),
            "team_messages" => Ok(Called::Text(team_messages(office, &need(a, "team")?, a.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize)?)),
            "usage_summary" => Ok(Called::Text(usage_summary(office, a.get("period").and_then(Value::as_str).unwrap_or("7d")))),
            "cost_analysis" => Ok(Called::Text(cost_analysis(office, &need(a, "team")?, a.get("period").and_then(Value::as_str).unwrap_or("30d"))?)),
            "list_agents" => Ok(Called::Text(list_agents(office))),
            "agent_models" => {
                let id = need(a, "agent")?;
                let profile = office.agents.iter().find(|p| p.id == id || p.name == id).ok_or_else(|| format!("No agent '{id}'. Use list_agents."))?;
                let models = office.driver.models(profile).await?;
                Ok(Called::Text(models.iter().map(|m| m.id.clone()).collect::<Vec<_>>().join("\n")))
            }
            "propose_team" => self.propose_team(a, office).map(Called::Proposed),
            "propose_instruction" => self.propose_instruction(a, office).map(Called::Proposed),
            "propose_team_action" => self.propose_action(a, office).map(Called::Proposed),
            other => Err(format!("There is no tool '{other}'.")),
        }
    }

    fn add(&self, kind: &str, title: String, lines: Vec<String>, confirm: &str, payload: Value) -> Proposal {
        let mut all = self.proposals.lock().unwrap();
        let p = Proposal {
            id: format!("P-{}", all.len() + 1),
            kind: kind.into(),
            title,
            lines,
            confirm: confirm.into(),
            state: "open".into(),
            outcome: String::new(),
            payload,
        };
        all.push(p.clone());
        p
    }

    fn propose_team(&self, a: &Value, office: &Office) -> Result<Proposal, String> {
        let name = need(a, "name")?;
        let goal = need(a, "goal")?;
        let work_dir = need(a, "work_dir")?;
        if !std::path::Path::new(&work_dir).is_absolute() {
            return Err("work_dir must be a full path such as D:\\Code\\my-site. Ask the user where the team should work if you do not know.".into());
        }
        let members = a.get("members").and_then(Value::as_array).filter(|m| !m.is_empty()).ok_or("members is required: at least one member.")?;
        if members.len() > 12 {
            return Err("A team has at most 12 members.".into());
        }
        let mut list = Vec::new();
        for (i, m) in members.iter().enumerate() {
            let agent_given = need(m, "agent")?;
            let agent = office
                .agents
                .iter()
                .find(|p| p.id.eq_ignore_ascii_case(&agent_given) || p.name.eq_ignore_ascii_case(&agent_given))
                .ok_or_else(|| format!("Member {}: there is no agent '{agent_given}'. Agents: {}.", i + 1, office.agents.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(", ")))?;
            list.push(json!({
                "id": format!("ai{}", i + 1),
                "name": text(m, "name").unwrap_or_else(|| format!("AI {}", i + 1)),
                "role": text(m, "role").unwrap_or_default(),
                "duty": text(m, "duty").unwrap_or_default(),
                "agent": agent.id,
                "model": text(m, "model").unwrap_or_default(),
                "color": COLORS[i % COLORS.len()],
            }));
        }
        let leader_given = text(a, "leader").unwrap_or_default();
        let leader = list
            .iter()
            .find(|m| !leader_given.is_empty() && (m["name"].as_str() == Some(leader_given.as_str()) || m["id"].as_str() == Some(leader_given.as_str())))
            .unwrap_or(&list[0])["id"]
            .as_str()
            .unwrap_or("ai1")
            .to_string();
        let scope: Vec<String> = a.get("scope").and_then(Value::as_array).map(|s| s.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        let start = a.get("start").and_then(Value::as_bool).unwrap_or(true);
        let config = json!({
            "id": "draft",
            "name": name,
            "goal": goal,
            "scope": scope,
            "workDir": work_dir,
            "leader": leader,
            "autoApprove": true,
            "members": list,
        });
        let draft: TeamConfig = serde_json::from_value(config.clone()).map_err(|e| e.to_string())?;
        let mut lines = vec![format!("目標:{goal}")];
        if !scope.is_empty() {
            lines.push(format!("範圍:{}", scope.join("、")));
        }
        let note = match folder_state(&work_dir) {
            Folder::Ready => String::new(),
            Folder::Missing => "(還不存在,按下後會先問你要不要建立)".into(),
            Folder::Blocked(why) => format!("({why})"),
        };
        lines.push(format!("工作資料夾:{work_dir}{note}"));
        for m in &draft.members {
            let model = if m.model.trim().is_empty() { "代理預設".to_string() } else { m.model.clone() };
            lines.push(format!("{}{} · {} · {} / {}{}", m.name, if m.id == draft.leader { "(Leader)" } else { "" }, if m.role.is_empty() { "—" } else { &m.role }, m.agent, model, if m.duty.is_empty() { String::new() } else { format!(" — {}", m.duty) }));
        }
        let confirm = if start { "建立並啟動" } else { "建立團隊" };
        Ok(self.add("team", format!("新團隊「{}」", draft.name), lines, confirm, json!({ "config": config, "start": start })))
    }

    fn propose_instruction(&self, a: &Value, office: &Office) -> Result<Proposal, String> {
        let (id, config) = find_team(office, &need(a, "team")?)?;
        let words = need(a, "text")?;
        let to_given = text(a, "to").unwrap_or_default();
        let to = if to_given.is_empty() || to_given.eq_ignore_ascii_case("leader") {
            String::new()
        } else {
            config
                .members
                .iter()
                .find(|m| m.id.eq_ignore_ascii_case(&to_given) || m.name.eq_ignore_ascii_case(&to_given))
                .map(|m| m.id.clone())
                .ok_or_else(|| format!("'{to_given}' is not a member of {}.", config.name))?
        };
        let who = if to.is_empty() {
            config.members.iter().find(|m| m.id == config.leader).map(|m| format!("{}(Leader)", m.name)).unwrap_or("Leader".into())
        } else {
            config.members.iter().find(|m| m.id == to).map(|m| m.name.clone()).unwrap_or(to.clone())
        };
        let finished = office.teams.is_finished(&id);
        let mut lines = vec![format!("給:{who}"), format!("內容:{words}")];
        if finished {
            lines.push("這個團隊已完成;送出後會重新開始工作。".into());
        }
        Ok(self.add("instruction", format!("給「{}」的指令", config.name), lines, "送出指令", json!({ "team": id, "to": to, "text": words })))
    }

    fn propose_action(&self, a: &Value, office: &Office) -> Result<Proposal, String> {
        let (id, config) = find_team(office, &need(a, "team")?)?;
        let action = need(a, "action")?.to_lowercase();
        let (title, line, confirm) = match action.as_str() {
            "start" => ("啟動", "從頭開始執行這個團隊(之前的紀錄會保留)。", "啟動"),
            "pause" => ("暫停", "不再開始新的回合;正在做的會做完。", "暫停"),
            "resume" => ("繼續", "從暫停或中斷的地方接著做。", "繼續"),
            "stop" => ("立刻停下", "暫停並中斷所有正在進行的回合。", "立刻停下"),
            "archive" => ("封存", "收起來,不再顯示在團隊清單和公司總覽(不會刪除)。", "封存"),
            "unarchive" => ("取消封存", "放回團隊清單和公司總覽。", "取消封存"),
            other => return Err(format!("Unknown action '{other}'. Use start, pause, resume, stop, archive or unarchive.")),
        };
        Ok(self.add("action", format!("{title}「{}」", config.name), vec![line.to_string()], confirm, json!({ "team": id, "action": action })))
    }
}

enum Called {
    Text(String),
    Proposed(Proposal),
}

fn need(a: &Value, key: &str) -> Result<String, String> {
    text(a, key).ok_or_else(|| format!("'{key}' is required."))
}

fn text(a: &Value, key: &str) -> Option<String> {
    a.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("\n…(cut)");
    out
}

// ── What it can read ─────────────────────────────────────────────────────────

/// Every team file: (file, its config or why it cannot be read).
fn team_files() -> Vec<(String, Result<TeamConfig, String>)> {
    let mut names: Vec<String> = std::fs::read_dir(settings::team_configs_dir())
        .map(|entries| entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(".json")).collect())
        .unwrap_or_default();
    names.sort();
    names.into_iter().map(|f| {
        let c = crate::read_team_file(&f);
        (f, c)
    }).collect()
}

/// A team by its id or name (any case): its id and setup.
fn find_team(office: &Office, given: &str) -> Result<(String, TeamConfig), String> {
    let _ = office;
    let given = given.trim();
    for (_, c) in team_files() {
        if let Ok(c) = c {
            if c.id.eq_ignore_ascii_case(given) || c.name.eq_ignore_ascii_case(given) {
                return Ok((c.id.clone(), c));
            }
        }
    }
    Err(format!("There is no team '{given}'. Use list_teams for their ids and names."))
}

/// The team's latest picture, as JSON (camelCase, as the window gets it).
fn picture(office: &Office, id: &str) -> Option<Value> {
    let snap = office.teams.get(id).and_then(|t| t.full_snapshot()).or_else(|| office.teams.load(id))?;
    serde_json::to_value(snap).ok()
}

fn when(ms: u64, tz: i64) -> String {
    if ms == 0 {
        return "—".into();
    }
    let local = ms as i64 + tz * 60_000;
    let days = local.div_euclid(86_400_000);
    let rest = local.rem_euclid(86_400_000);
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", rest / 3_600_000, rest % 3_600_000 / 60_000)
}

/// Days since 1970-01-01 → (year, month, day).
fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn n(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn list_teams(office: &Office, include_archived: bool) -> String {
    let mut out = Vec::new();
    for (file, config) in team_files() {
        let Ok(c) = config else {
            out.push(format!("- {file}: cannot be read"));
            continue;
        };
        if c.archived && !include_archived {
            continue;
        }
        let mut line = format!("- {} (id {}){}: {} member(s)", c.name, c.id, if c.archived { " [archived]" } else { "" }, c.members.len());
        match picture(office, &c.id) {
            Some(p) => {
                let waiting = p["members"].as_array().map(|m| m.iter().filter(|m| s(m, "status") == "waitingYou").count()).unwrap_or(0);
                let open_q = p["questions"].as_array().map(|q| q.iter().filter(|q| q["answer"].is_null()).count()).unwrap_or(0);
                line.push_str(&format!(
                    ", status {}, tasks {}/{} accepted, turns {}/{}, started {}{}",
                    s(&p, "status"),
                    n(&p, "done"),
                    n(&p, "total"),
                    n(&p, "totalTurns"),
                    n(&p, "maxTurns"),
                    when(n(&p, "startedAt"), office.tz_minutes),
                    if n(&p, "finishedAt") > 0 { format!(", finished {}", when(n(&p, "finishedAt"), office.tz_minutes)) } else { String::new() },
                ));
                if waiting + open_q > 0 {
                    line.push_str(&format!(", WAITING FOR THE USER: {waiting} permission card(s), {open_q} question(s)"));
                }
                if !s(&p, "pausedWhy").is_empty() {
                    line.push_str(&format!(", paused because: {}", s(&p, "pausedWhy")));
                }
            }
            None => line.push_str(", never started"),
        }
        line.push_str(&format!(". Goal: {}", cut(&c.goal, 120)));
        out.push(line);
    }
    if out.is_empty() {
        "No teams.".into()
    } else {
        out.join("\n")
    }
}

fn team_detail(office: &Office, given: &str) -> Result<String, String> {
    let (id, c) = find_team(office, given)?;
    let mut out = vec![
        format!("Team {} (id {}). Goal: {}", c.name, id, c.goal),
        format!("Work folder: {}. Leader: {}.", c.work_dir, c.leader),
    ];
    let Some(p) = picture(office, &id) else {
        out.push("Never started. Members:".into());
        for m in &c.members {
            out.push(format!("- {} ({}): {}, agent {} model {}", m.name, m.id, m.role, m.agent, if m.model.is_empty() { "default" } else { &m.model }));
        }
        return Ok(out.join("\n"));
    };
    out.push(format!(
        "Status {}{}; tasks {}/{} accepted; turns {}/{}; started {}{}.",
        s(&p, "status"),
        if s(&p, "pausedWhy").is_empty() { String::new() } else { format!(" ({})", s(&p, "pausedWhy")) },
        n(&p, "done"),
        n(&p, "total"),
        n(&p, "totalTurns"),
        n(&p, "maxTurns"),
        when(n(&p, "startedAt"), office.tz_minutes),
        if n(&p, "finishedAt") > 0 { format!(", finished {}", when(n(&p, "finishedAt"), office.tz_minutes)) } else { String::new() },
    ));
    out.push("Members:".into());
    for m in p["members"].as_array().into_iter().flatten() {
        let tokens: u64 = m["usage"].as_array().into_iter().flatten().map(|u| n(u, "input") + n(u, "output") + n(u, "cacheRead") + n(u, "cacheWrite")).sum();
        let mut line = format!("- {} ({}){}: {}, agent {} model {}, status {}, {} turn(s), {} tokens", s(m, "name"), s(m, "id"), if m["isLeader"].as_bool() == Some(true) { " leader" } else { "" }, s(m, "role"), s(m, "agent"), if s(m, "model").is_empty() { "default" } else { s(m, "model") }, s(m, "status"), n(m, "turns"), tokens);
        if !s(m, "task").is_empty() {
            line.push_str(&format!(", on {}", s(m, "task")));
        }
        if m["waiting"].is_object() {
            line.push_str(&format!(", waiting on {} for {}", s(&m["waiting"], "on"), s(&m["waiting"], "what")));
        }
        if m["permission"].is_object() {
            line.push_str(&format!(", HOLDING A PERMISSION CARD: {}", s(&m["permission"], "title")));
        }
        if !s(m, "lostWhy").is_empty() {
            line.push_str(&format!(", lost: {}", s(m, "lostWhy")));
        }
        out.push(line);
    }
    out.push("Tasks:".into());
    for t in p["tasks"].as_array().into_iter().flatten() {
        let mut line = format!("- {} {} → {}: {}", s(t, "id"), s(t, "title"), s(t, "owner"), s(t, "status"));
        if t["blocked"].is_object() {
            line.push_str(&format!(" (blocked on {}: {})", s(&t["blocked"], "on"), s(&t["blocked"], "reason")));
        }
        if !s(t, "note").is_empty() {
            line.push_str(&format!(" — {}", cut(s(t, "note"), 100)));
        }
        out.push(line);
    }
    let open: Vec<String> = p["questions"].as_array().into_iter().flatten().filter(|q| q["answer"].is_null()).map(|q| format!("- {} from {}: {}", s(q, "id"), s(q, "by"), s(q, "question"))).collect();
    if !open.is_empty() {
        out.push("Questions waiting for the user:".into());
        out.extend(open);
    }
    let handed: Vec<String> = p["deliverables"].as_array().into_iter().flatten().map(|d| format!("- {} {}: {} ({})", s(d, "task"), s(d, "locator"), cut(s(d, "summary"), 100), match d["accepted"].as_bool() { Some(true) => "accepted", Some(false) => "sent back", None => "not reviewed" })).collect();
    if !handed.is_empty() {
        out.push("Handed in:".into());
        out.extend(handed);
    }
    Ok(out.join("\n"))
}

fn team_messages(office: &Office, given: &str, limit: usize) -> Result<String, String> {
    let (id, c) = find_team(office, given)?;
    let p = picture(office, &id).ok_or_else(|| format!("{} has never run.", c.name))?;
    let all: Vec<&Value> = p["messages"].as_array().map(|m| m.iter().collect()).unwrap_or_default();
    let from = all.len().saturating_sub(limit.clamp(1, 60));
    let lines: Vec<String> = all[from..].iter().map(|m| format!("[{}] {} → {}: {}", when(n(m, "at"), office.tz_minutes), s(m, "from"), s(m, "to"), cut(s(m, "text"), 600))).collect();
    Ok(if lines.is_empty() { "No messages yet.".into() } else { lines.join("\n") })
}

/// [from, to) in ms and its name, for a period word, on the person's clock.
fn period_range(office: &Office, period: &str) -> (u64, u64, &'static str) {
    let now = crate::team::store::now_ms() as i64;
    let tz = office.tz_minutes * 60_000;
    let day = 86_400_000i64;
    let today = (now + tz).div_euclid(day) * day - tz;
    let (from, to, name) = match period {
        "today" => (today, today + day, "today"),
        "yesterday" => (today - day, today, "yesterday"),
        "7d" => (today - 6 * day, today + day, "the last 7 days"),
        "month" => {
            let (_, _, d) = civil((now + tz).div_euclid(day));
            (today - (d - 1) * day, today + day, "this month")
        }
        "all" => (0, today + day, "all time"),
        _ => (today - 29 * day, today + day, "the last 30 days"),
    };
    (from.max(0) as u64, to as u64, name)
}

/// One team's cost taken apart: who spent it on which model, on what kind
/// of token, how hard they worked for it, and whether their context grew.
fn cost_analysis(office: &Office, given: &str, period: &str) -> Result<String, String> {
    let (id, c) = find_team(office, given)?;
    let (from, to, name) = period_range(office, period);
    let report = crate::cost::report(&settings::team_logs_dir(), from, to);
    let rows: Vec<&crate::cost::Row> = report.rows.iter().filter(|r| r.team == id).collect();
    if rows.is_empty() {
        return Ok(format!("{} used no tokens in {name}.", c.name));
    }
    let money = |usd: f64| if report.choices.rate > 0.0 { format!("${usd:.4} (≈ {} {:.2})", report.choices.currency, usd * report.choices.rate) } else { format!("${usd:.4}") };
    let total_usd: f64 = rows.iter().filter_map(|r| r.estimated_usd).sum();
    let mut out = vec![format!("Team {} (id {id}), {name}: {} usage records, estimated {}.", c.name, rows.len(), money(total_usd))];
    // The kinds of token, and what each cost.
    let (mut i, mut o, mut cr, mut cw) = (0u64, 0u64, 0u64, 0u64);
    let (mut ui, mut uo, mut ucr, mut ucw) = (0f64, 0f64, 0f64, 0f64);
    for r in &rows {
        let u = &r.usage;
        i += u.input;
        o += u.output;
        cr += u.cache_read;
        cw += u.cache_write;
        if let Some(Some(f)) = report.models.iter().find(|m| m.model == u.model).map(|m| m.found.as_ref()) {
            ui += u.input as f64 * f.price.input / 1e6;
            uo += u.output as f64 * f.price.output / 1e6;
            ucr += u.cache_read as f64 * f.price.cache_read / 1e6;
            ucw += u.cache_write as f64 * f.price.cache_write / 1e6;
        }
    }
    let hit = if i + cr + cw > 0 { cr as f64 * 100.0 / (i + cr + cw) as f64 } else { 0.0 };
    out.push(format!(
        "Tokens: input (not cached) {i} costing {}, output {o} costing {}, cache read {cr} costing {}, cache write {cw} costing {}. Cache hit rate {hit:.0}% of the input side.",
        money(ui), money(uo), money(ucr), money(ucw)
    ));
    // Members: model, spend, share, work done, context growth.
    out.push("Members:".into());
    let mut members: Vec<String> = rows.iter().map(|r| r.member.clone()).collect();
    members.sort();
    members.dedup();
    let mut lines: Vec<(f64, String)> = Vec::new();
    for m in members {
        let mine: Vec<&&crate::cost::Row> = rows.iter().filter(|r| r.member == m).collect();
        let usd: f64 = mine.iter().filter_map(|r| r.estimated_usd).sum();
        let tokens: u64 = mine.iter().map(|r| r.usage.input + r.usage.output + r.usage.cache_read + r.usage.cache_write).sum();
        let mut models: Vec<String> = mine.iter().map(|r| r.usage.model.clone()).collect();
        models.sort();
        models.dedup();
        let did = report.activity.iter().find(|a| a.team == id && a.member == m).cloned().unwrap_or_default();
        // Input per call, early against late: a context that keeps growing costs more each turn.
        let per_call: Vec<u64> = mine.iter().map(|r| r.usage.input + r.usage.cache_read + r.usage.cache_write).collect();
        let third = (per_call.len() / 3).max(1);
        let avg = |s: &[u64]| if s.is_empty() { 0 } else { s.iter().sum::<u64>() / s.len() as u64 };
        let (early, late) = (avg(&per_call[..third.min(per_call.len())]), avg(&per_call[per_call.len().saturating_sub(third)..]));
        let name = mine.first().map(|r| r.member_name.clone()).unwrap_or(m.clone());
        lines.push((
            usd,
            format!(
                "- {name} ({m}){}{}: model {}, {} ({:.0}% of the team), {tokens} tokens in {} records; {} turns ({} failed), {} hand-ins, {} sent back, {} accepted, {} reviews made; cost per turn {}; context per call {early} early vs {late} late.",
                if did.leader { " leader" } else { "" },
                if did.role.is_empty() { String::new() } else { format!(", role {}", did.role) },
                models.join(" + "),
                money(usd),
                if total_usd > 0.0 { usd * 100.0 / total_usd } else { 0.0 },
                mine.len(),
                did.turns,
                did.failed_turns,
                did.delivered,
                did.rejected,
                did.accepted,
                did.reviews,
                if did.turns > 0 { money(usd / did.turns as f64) } else { "—".into() },
            ),
        ));
    }
    lines.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.extend(lines.into_iter().map(|(_, l)| l));
    // The prices behind it.
    let mut used: Vec<&String> = rows.iter().map(|r| &r.usage.model).collect();
    used.sort();
    used.dedup();
    out.push("Prices used (USD per 1M tokens, input/output/cache read):".into());
    for m in used {
        match report.models.iter().find(|x| &x.model == m).and_then(|x| x.found.as_ref()) {
            Some(f) => out.push(format!("- {m}: {}/{}/{}", f.price.input, f.price.output, f.price.cache_read)),
            None => out.push(format!("- {m}: no price known")),
        }
    }
    let accepted: u32 = report.activity.iter().filter(|a| a.team == id).map(|a| a.accepted).sum();
    let rejected: u32 = report.activity.iter().filter(|a| a.team == id).map(|a| a.rejected).sum();
    if accepted > 0 {
        out.push(format!("Cost per accepted task: {} ({accepted} accepted, {rejected} sent back first).", money(total_usd / accepted as f64)));
    }
    Ok(out.join("\n"))
}

fn usage_summary(office: &Office, period: &str) -> String {
    let now = crate::team::store::now_ms() as i64;
    let tz = office.tz_minutes * 60_000;
    let today = (now + tz).div_euclid(86_400_000) * 86_400_000 - tz;
    let day = 86_400_000i64;
    let (from, to, name) = match period {
        "today" => (today, today + day, "today"),
        "yesterday" => (today - day, today, "yesterday"),
        "30d" => (today - 29 * day, today + day, "the last 30 days"),
        "month" => {
            let (_, _, d) = civil((now + tz).div_euclid(day));
            (today - (d - 1) * day, today + day, "this month")
        }
        _ => (today - 6 * day, today + day, "the last 7 days"),
    };
    let report = crate::cost::report(&settings::team_logs_dir(), from.max(0) as u64, to as u64);
    if report.rows.is_empty() {
        return format!("No usage recorded in {name}.");
    }
    let mut total = (0u64, 0.0f64, 0u64);
    let mut by_team: BTreeMap<String, (u64, f64)> = BTreeMap::new();
    let mut by_model: BTreeMap<String, (u64, f64)> = BTreeMap::new();
    let mut by_agent: BTreeMap<String, (u64, f64)> = BTreeMap::new();
    for r in &report.rows {
        let tokens = r.usage.input + r.usage.output + r.usage.cache_read + r.usage.cache_write;
        let usd = r.estimated_usd.unwrap_or(0.0);
        total.0 += tokens;
        total.1 += usd;
        if r.estimated_usd.is_none() {
            total.2 += tokens;
        }
        for (map, key) in [(&mut by_team, r.team_name.clone()), (&mut by_model, r.usage.model.clone()), (&mut by_agent, r.agent.clone())] {
            let e = map.entry(key).or_default();
            e.0 += tokens;
            e.1 += usd;
        }
    }
    let rate = report.choices.rate;
    let money = |usd: f64| if rate > 0.0 { format!("${usd:.3} (≈ {} {:.1})", report.choices.currency, usd * rate) } else { format!("${usd:.3}") };
    let list = |map: BTreeMap<String, (u64, f64)>| {
        let mut v: Vec<_> = map.into_iter().collect();
        v.sort_by(|a, b| b.1 .1.partial_cmp(&a.1 .1).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().map(|(k, (t, u))| format!("  - {k}: {t} tokens, {}", money(u))).collect::<Vec<_>>().join("\n")
    };
    let billing: Vec<String> = report.choices.billing.iter().filter(|(_, b)| *b == "subscription").map(|(a, _)| a.clone()).collect();
    format!(
        "Usage in {name}: {} tokens, estimated {}{}.\nBy team:\n{}\nBy agent:\n{}\nBy model:\n{}{}",
        total.0,
        money(total.1),
        if total.2 > 0 { format!(" ({} tokens have no price yet)", total.2) } else { String::new() },
        list(by_team),
        list(by_agent),
        list(by_model),
        if billing.is_empty() { String::new() } else { format!("\nOn a subscription (the amount is the API-price equivalent, not billed): {}", billing.join(", ")) },
    )
}

fn list_agents(office: &Office) -> String {
    office
        .agents
        .iter()
        .map(|p| {
            let endpoint = p.env.get("COPILOT_PROVIDER_BASE_URL").filter(|b| b.starts_with("http")).map(|b| format!(", own endpoint {b}")).unwrap_or_default();
            let model = crate::acp::running_model(p, &crate::acp::Launch::default());
            format!("- {} (id {}): {:?}, default model {}{}", p.name, p.id, p.protocol, if model.is_empty() { "the agent's own" } else { &model }, endpoint)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ── What the person confirmed ────────────────────────────────────────────────

/// How a work folder stands, checked on disk.
enum Folder {
    Ready,
    Missing,
    /// It is there (or cannot be told) but cannot be used: why, in plain words.
    Blocked(String),
}

fn folder_state(dir: &str) -> Folder {
    match std::fs::metadata(dir) {
        Ok(m) if m.is_dir() => Folder::Ready,
        Ok(_) => Folder::Blocked(format!("{dir} 是一個檔案,不是資料夾,請換一個資料夾路徑。")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Folder::Missing,
        Err(e) => Folder::Blocked(folder_error(dir, &e, false)),
    }
}

/// Makes sure the work folder is there. A missing folder is created only
/// when the person said so (`create`); a folder Windows will not let us
/// use is told apart from one that is simply not there.
fn ensure_folder(dir: &str, create: bool) -> Result<(), String> {
    match folder_state(dir) {
        Folder::Ready => Ok(()),
        Folder::Blocked(why) => Err(why),
        Folder::Missing if !create => Err(format!("工作資料夾 {dir} 不存在。沒有建立資料夾,團隊也沒有開。")),
        Folder::Missing => std::fs::create_dir_all(dir).map_err(|e| folder_error(dir, &e, true)),
    }
}

/// An error on a work folder, in words a person can act on.
fn folder_error(dir: &str, e: &std::io::Error, creating: bool) -> String {
    use std::io::ErrorKind;
    let path = std::path::Path::new(dir);
    match e.kind() {
        ErrorKind::PermissionDenied if creating => {
            // The deepest folder that is there is the one that refused.
            let parent = path.ancestors().skip(1).find(|a| a.is_dir()).map(|a| a.display().to_string()).unwrap_or_else(|| dir.to_string());
            format!("Windows 拒絕存取:你的帳號沒有權限在 {parent} 底下建立資料夾,所以沒有建立 {dir}。請換一個你能寫入的位置(例如 D:\\Code 底下),或先在檔案總管自己建立好再試。")
        }
        ErrorKind::PermissionDenied => format!("Windows 拒絕存取 {dir}:這個資料夾存在,但你的帳號沒有權限使用它。請換一個資料夾,或在資料夾的「內容 → 安全性」給自己讀寫權限。"),
        ErrorKind::NotFound if creating => {
            let root = path.ancestors().last().map(|a| a.display().to_string()).unwrap_or_default();
            format!("無法建立 {dir}:{root} 不存在或目前無法使用(例如磁碟沒有接上)。")
        }
        _ if creating => format!("無法建立資料夾 {dir}:{e}"),
        _ => format!("無法使用資料夾 {dir}:{e}"),
    }
}

async fn create_team(payload: &Value, office: &Office, create_folder: bool) -> Result<String, String> {
    let dir = settings::team_configs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = (1..1000)
        .map(|n| if n == 1 { "team".to_string() } else { format!("team-{n}") })
        .find(|id| !dir.join(format!("{id}.json")).exists())
        .ok_or("There are too many team files.")?;
    let mut config: TeamConfig = serde_json::from_value(payload["config"].clone()).map_err(|e| e.to_string())?;
    config.id = id.clone();
    ensure_folder(&config.work_dir, create_folder)?;
    let known: Vec<String> = office.agents.iter().map(|a| a.id.clone()).collect();
    let problems = config.problems(&known);
    if !problems.is_empty() {
        return Err(problems.join(" "));
    }
    let file = format!("{id}.json");
    std::fs::write(dir.join(&file), serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| format!("Could not save {file}: {e}"))?;
    crate::log::line(format!("secretary: created team {id}"));
    if payload["start"].as_bool() == Some(true) {
        start(&config, office)?;
        Ok(format!("team {} (id {id}) was created and started", config.name))
    } else {
        Ok(format!("team {} (id {id}) was created, not started", config.name))
    }
}

fn start(config: &TeamConfig, office: &Office) -> Result<(), String> {
    if !settings::team_mcp_exe_path().is_file() {
        return Err("coucou-team-mcp.exe is missing from Coucou's bin folder, so members could not report. Reinstall or rebuild Coucou.".into());
    }
    office.teams.start(config.clone(), &office.agents).map(|_| ())
}

fn instruct(payload: &Value, office: &Office) -> Result<String, String> {
    let team = s(payload, "team");
    let to = s(payload, "to");
    let words = s(payload, "text");
    if office.teams.is_finished(team) {
        office.teams.reopen(team, to, words, None, &office.agents)?;
        return Ok("the instruction was sent and the finished team started again".into());
    }
    office.teams.instruct(team, to, words, None).map(|_| "the instruction was sent".into())
}

async fn act(payload: &Value, office: &Office, create_folder: bool) -> Result<String, String> {
    let team = s(payload, "team");
    match s(payload, "action") {
        "start" => {
            let config = crate::read_team_file(&format!("{team}.json"))?;
            ensure_folder(&config.work_dir, create_folder)?;
            start(&config, office)?;
            Ok("the team was started".into())
        }
        "pause" => office.teams.pause(team).map(|_| "the team was paused".into()),
        "resume" => office.teams.resume(team, &office.agents).map(|_| "the team carries on".into()),
        "stop" => office.teams.interrupt(team).await.map(|_| "the team was stopped".into()),
        "archive" | "unarchive" => {
            let archived = s(payload, "action") == "archive";
            let file = format!("{team}.json");
            let path = crate::team_file_path(&file)?;
            let mut config = crate::read_team_file(&file)?;
            if archived && office.teams.is_live(&config.id) {
                return Err("This team is running. Stop it before putting it away.".into());
            }
            config.archived = archived;
            std::fs::write(path, serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            Ok(if archived { "the team was archived".into() } else { "the team was taken out of the archive".into() })
        }
        other => Err(format!("Unknown action '{other}'.")),
    }
}

// ── What the model is told ───────────────────────────────────────────────────

fn system_prompt(office: &Office) -> String {
    format!(
        "{}You are the secretary of the user's company of AI agents, inside Coucou, a Windows app. The company is made of teams: each has a goal, a work folder and AI members (each runs an agent such as Codex, Claude Code, Copilot or Antigravity, with a model); a leader member plans tasks, hands them out and reviews them. The user calls on you when they need you: to find out how the teams are doing, what is stuck or waiting for them, what it cost, or to get something done.\n\
\n\
How you work:\n\
- Look things up with your tools before you answer; never guess a team's state. Quote names, numbers and times as the tools give them.\n\
- You cannot change anything yourself. To get something done (a new team, an instruction to a team, starting, pausing, resuming, stopping or archiving a team) you prepare it with a propose_* tool: it appears on the user's screen as a card, and it happens only if they click it. Never say something was done unless a [Coucou] note says the user confirmed it.\n\
- Prefer one proposal that does what was asked. Ask a short question first only when something essential is missing, such as the work folder for a new team.\n\
- For a new team: pick agents and models from list_agents (agent_models lists what an agent offers); give the leader the strongest model; give each member a short role (2-6 characters) and a one-line duty; keep the team small (2-5 members) unless asked.\n\
- Answer in the user's language (Traditional Chinese when they write Chinese), short and concrete: a few lines or a short list. Point out anything waiting for the user (permission cards, questions) first.\n\
\n\
Now: {} (the user's local time).",
        match office.name.trim() {
            "" | "秘書" => String::new(),
            name => format!("Your name is {name}; the user calls you that, and you may call yourself that. "),
        },
        when(crate::team::store::now_ms(), office.tz_minutes)
    )
}

fn describe() -> Vec<Tool> {
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| Tool {
        name: name.into(),
        description: description.into(),
        parameters: json!({ "type": "object", "properties": properties, "required": required }),
    };
    let team = json!({ "type": "string", "description": "The team's id or name." });
    vec![
        tool("list_teams", "Lists the teams: status, progress, turns, when they ran, and anything waiting for the user.", json!({ "include_archived": { "type": "boolean" } }), &[]),
        tool("team_detail", "One team in detail: members (agent, model, status, what they are on or waiting for, tokens), tasks, open questions, what was handed in.", json!({ "team": team }), &["team"]),
        tool("team_messages", "The latest messages within a team, oldest first.", json!({ "team": team, "limit": { "type": "integer", "description": "How many, 1-60 (default 20)." } }), &["team"]),
        tool("usage_summary", "Tokens used and estimated cost, by team, agent and model.", json!({ "period": { "type": "string", "enum": ["today", "yesterday", "7d", "30d", "month"] } }), &["period"]),
        tool(
            "cost_analysis",
            "One team's cost taken apart, to explain why it is high or low and how to bring it down: the kinds of token and what each cost, the cache hit rate, each member's model, spend, share, turns, hand-ins, rejections and how its context per call grew, the prices used, and the cost per accepted task.",
            json!({ "team": team, "period": { "type": "string", "enum": ["today", "yesterday", "7d", "30d", "month", "all"] } }),
            &["team"],
        ),
        tool("list_agents", "The agents members can run as, with their default models.", json!({}), &[]),
        tool("agent_models", "The models one agent offers (asks the agent's endpoint).", json!({ "agent": { "type": "string", "description": "The agent's id." } }), &["agent"]),
        tool(
            "propose_team",
            "Prepares a new team for the user to confirm with a click (it is created, and started if start is true, only then).",
            json!({
                "name": { "type": "string" },
                "goal": { "type": "string", "description": "What the team must achieve and deliver, in the user's words and enough detail." },
                "scope": { "type": "array", "items": { "type": "string" } },
                "work_dir": { "type": "string", "description": "Full path of the folder the team works in. If it does not exist, the user is asked whether to create it when they confirm." },
                "members": { "type": "array", "items": { "type": "object", "properties": {
                    "name": { "type": "string" }, "role": { "type": "string" }, "duty": { "type": "string" },
                    "agent": { "type": "string", "description": "An agent id from list_agents." },
                    "model": { "type": "string", "description": "Empty for the agent's default." },
                }, "required": ["name", "role", "agent"] } },
                "leader": { "type": "string", "description": "The leader's name; the first member if empty." },
                "start": { "type": "boolean", "description": "Start it as soon as it is created (default true)." },
            }),
            &["name", "goal", "work_dir", "members"],
        ),
        tool(
            "propose_instruction",
            "Prepares an instruction to a team's leader (or one member) for the user to confirm. A finished team starts again with it.",
            json!({ "team": team, "to": { "type": "string", "description": "A member's name or id; empty for the leader." }, "text": { "type": "string" } }),
            &["team", "text"],
        ),
        tool(
            "propose_team_action",
            "Prepares starting, pausing, resuming, stopping, archiving or unarchiving a team, for the user to confirm.",
            json!({ "team": team, "action": { "type": "string", "enum": ["start", "pause", "resume", "stop", "archive", "unarchive"] } }),
            &["team", "action"],
        ),
    ]
}

/// What the window shows while the secretary works.
fn label(call: &Call, office: &Office) -> String {
    let a = &call.arguments;
    let team = || {
        let given = text(a, "team").unwrap_or_default();
        find_team(office, &given).map(|(_, c)| c.name).unwrap_or(given)
    };
    match call.name.as_str() {
        "list_teams" => "查看所有團隊".into(),
        "team_detail" => format!("查看「{}」的現況", team()),
        "team_messages" => format!("讀「{}」的溝通紀錄", team()),
        "cost_analysis" => format!("分析「{}」的成本", team()),
        "usage_summary" => format!(
            "查詢{}的用量與成本",
            match a.get("period").and_then(Value::as_str).unwrap_or("7d") {
                "today" => "今天",
                "yesterday" => "昨天",
                "30d" => "近 30 天",
                "month" => "本月",
                _ => "近 7 天",
            }
        ),
        "list_agents" => "查看可用的代理".into(),
        "agent_models" => format!("查詢「{}」提供的模型", text(a, "agent").unwrap_or_default()),
        "propose_team" => format!("擬好新團隊「{}」", text(a, "name").unwrap_or_default()),
        "propose_instruction" => format!("擬好給「{}」的指令", team()),
        "propose_team_action" => format!("擬好「{}」的操作", team()),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_work_folder_is_created_only_when_the_person_says_so() {
        let dir = std::env::temp_dir().join(format!("coucou-folder-test-{}", std::process::id())).join("site");
        let path = dir.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        assert!(matches!(folder_state(&path), Folder::Missing));
        let refused = ensure_folder(&path, false).unwrap_err();
        assert!(refused.contains("不存在"), "{refused}");
        assert!(!dir.exists());
        ensure_folder(&path, true).unwrap();
        assert!(dir.is_dir());
        assert!(matches!(folder_state(&path), Folder::Ready));
        // A file where the folder should be is told as such, not as missing.
        let file = dir.join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(matches!(folder_state(&file.to_string_lossy()), Folder::Blocked(_)));
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn local_times_read_as_the_person_s_clock() {
        // 2026-10-05 00:30 UTC is 08:30 in Taipei (+8 h).
        let ms = 1_790_000_000_000u64; // a moment to turn both ways
        let utc = when(ms, 0);
        let taipei = when(ms, 480);
        assert_ne!(utc, taipei);
        assert_eq!(when(86_400_000 * 365, 0), "1971-01-01 00:00");
        assert_eq!(when(0, 480), "—");
        assert_eq!(civil(20_366), (2025, 10, 5));
    }

    #[test]
    fn the_tools_are_described_for_every_wire() {
        let tools = describe();
        assert_eq!(tools.len(), 10);
        for t in &tools {
            assert_eq!(t.parameters["type"], "object");
            assert!(t.description.len() > 20);
        }
        assert!(tools.iter().filter(|t| t.name.starts_with("propose_")).count() == 3);
    }

    fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                copy_dir(&p, &to.join(e.file_name()));
            } else {
                std::fs::copy(&p, to.join(e.file_name())).unwrap();
            }
        }
    }

    /// The person's own chat provider, teams (a copy of their logs) and
    /// agents: a question, then a request for a team. Nothing is confirmed,

    /// The person's own team logs and chat provider: why a team cost what it did. Needs the network.
    #[test]
    #[ignore]
    fn the_real_secretary_explains_a_team_s_cost() {
        use crate::team::orchestrator::AcpDrive;
        let settings = crate::settings::load();
        let provider = settings.providers.first().cloned().expect("a chat provider in Settings");
        let logs = std::env::temp_dir().join(format!("coucou-secretary-cost-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&logs);
        copy_dir(&settings::team_logs_dir(), &logs);
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        runtime.block_on(async {
            let driver = Arc::new(Agents::default());
            let teams = Arc::new(Teams::new(Arc::new(AcpDrive(driver.clone())), Arc::new(|_| {}), Some(logs.clone()), settings::team_mcp_exe_path()));
            let office = Office { teams, agents: settings.agents.clone(), driver, tz_minutes: 480, name: String::new() };
            let secretary = Secretary::default();
            let step = |s: &Step| eprintln!("  step: {} ({})", s.label, s.tool);
            let reply = secretary.ask(&provider, &office, "幫我分析「購物網站 DEMO」這 30 天的成本:為什麼這麼高?怎麼優化?", &step).await.expect("an answer");
            eprintln!("\n{}", reply.text);
            assert!(reply.steps.iter().any(|s| s.tool == "cost_analysis"));
        });
        let _ = std::fs::remove_dir_all(&logs);
    }
    /// so nothing is created. Needs the network.
    #[test]
    #[ignore]
    fn the_real_secretary_answers_with_the_office_tools() {
        use crate::team::orchestrator::AcpDrive;
        let settings = crate::settings::load();
        let provider = settings.providers.first().cloned().expect("a chat provider in Settings");
        let logs = std::env::temp_dir().join(format!("coucou-secretary-logs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&logs);
        copy_dir(&settings::team_logs_dir(), &logs);
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        runtime.block_on(async {
            let driver = Arc::new(Agents::default());
            let teams = Arc::new(Teams::new(Arc::new(AcpDrive(driver.clone())), Arc::new(|_| {}), Some(logs.clone()), settings::team_mcp_exe_path()));
            let office = Office { teams, agents: settings.agents.clone(), driver, tz_minutes: 480, name: String::new() };
            let secretary = Secretary::default();
            let step = |s: &Step| eprintln!("  step: {} ({})", s.label, s.tool);

            let first = secretary.ask(&provider, &office, "各團隊現在的狀況如何?有沒有在等我處理的?", &step).await.expect("an answer");
            eprintln!("Q1 → {}\n", first.text);
            assert!(first.steps.iter().any(|s| s.tool == "list_teams" || s.tool == "team_detail"));

            let second = secretary
                .ask(&provider, &office, r"幫我開一個新團隊:在 D:\Temp\coucou-secretary-check 做一個顯示 Hello 的單頁網頁。兩個成員都用 cg2,隊長用 glm-5.3-flash,另一位用 deepseek-v4-flash。先不要啟動。", &step)
                .await
                .expect("an answer");
            eprintln!("Q2 → {}", second.text);
            for p in &second.proposals {
                eprintln!("  proposal {} [{}] {} — {}\n    {}", p.id, p.kind, p.title, p.confirm, p.lines.join("\n    "));
            }
            assert!(second.proposals.iter().any(|p| p.kind == "team" && p.state == "open"));
            assert!(!std::path::Path::new(r"D:\Temp\coucou-secretary-check").exists(), "nothing happens before a click");
        });
        let _ = std::fs::remove_dir_all(&logs);
    }
}
