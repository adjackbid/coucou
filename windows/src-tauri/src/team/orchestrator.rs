// Who gets the next turn, and what it is told.
//
// A member only ever hears something at the start of a turn, so the whole of
// coordination is this: when a member is not in a turn and something is
// waiting for it — a task that became ready, a delivery, a message — give it
// a turn that begins with exactly that. When the turn ends, look at what it
// left behind: work still open and no word about it earns one reminder, and a
// second silent turn marks the member as lost so a person can step in.
//
// Members run through a `Drive` (ACP today). Their tool calls come back in
// through `act`, from the MCP server in mcp.rs.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::Notify;

use super::screen::{Line, Screen};
use super::state::{Event, Live, PermissionView, Snapshot, State, TaskStatus, TeamStatus};
use super::store::Store;
use super::{brief, tools, TeamConfig, SYSTEM, YOU};
use crate::acp::{self, AgentProfile, Agents, Launch, McpServer, Sink};
use crate::log;
use crate::policy::Scope;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// A task sent back this many times stops the team for a person to look.
const MAX_REJECTIONS: u32 = 3;
/// Turns in a row a member may end without a word about its open work.
const MAX_SILENT_TURNS: u32 = 2;

/// Where a team's scheduler runs. Asked before anything is changed: called
/// from outside the async runtime (a synchronous Tauri command runs on the
/// window's thread), spawning would panic and take the app down.
fn runtime() -> Result<tokio::runtime::Handle, String> {
    tokio::runtime::Handle::try_current().map_err(|_| "Coucou cannot run a team from here: it was asked outside its async runtime.".to_string())
}
/// Lines of each member's screen in a snapshot.
const SCREEN_LINES: usize = 150;
/// A screen's changes go out at most this often: an agent writes a few
/// characters at a time, and the window needs no more than a smooth line.
const SCREEN_EVERY: std::time::Duration = std::time::Duration::from_millis(120);

/// One member's session: its key, the agent it runs as and how it is started.
#[derive(Clone, Debug)]
pub struct Seat {
    pub key: String,
    pub profile: AgentProfile,
    pub launch: Launch,
}

/// How members are driven. ACP today; a stream-json driver joins it later.
pub trait Drive: Send + Sync {
    /// One turn: resolves with the stop reason when the agent ends it.
    fn prompt(&self, seat: Seat, text: String, events: Sink) -> BoxFuture<Result<String, String>>;
    fn answer(&self, key: String, request_id: Value, option_id: Option<String>) -> BoxFuture<Result<(), String>>;
    fn cancel(&self, key: String) -> BoxFuture<Result<(), String>>;
    fn stop(&self, key: String) -> BoxFuture<()>;
}

/// Members that speak ACP: Copilot CLI, and Copilot CLI with its own provider.
pub struct AcpDrive(pub Arc<Agents>);

impl Drive for AcpDrive {
    fn prompt(&self, seat: Seat, text: String, events: Sink) -> BoxFuture<Result<String, String>> {
        let agents = self.0.clone();
        Box::pin(async move { agents.prompt(&events, &seat.key, &seat.profile, &seat.launch, text).await.map(|o| o.stop_reason) })
    }

    fn answer(&self, key: String, request_id: Value, option_id: Option<String>) -> BoxFuture<Result<(), String>> {
        let agents = self.0.clone();
        Box::pin(async move { agents.answer_permission(&key, request_id, option_id).await })
    }

    fn cancel(&self, key: String) -> BoxFuture<Result<(), String>> {
        let agents = self.0.clone();
        Box::pin(async move { agents.cancel(&key).await })
    }

    fn stop(&self, key: String) -> BoxFuture<()> {
        let agents = self.0.clone();
        Box::pin(async move { agents.reset(&key).await })
    }
}

/// Called with the team's new picture every time it changes.
pub type Emit = Arc<dyn Fn(&Snapshot) + Send + Sync>;

/// Lines of one member's live screen that changed.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPatch {
    pub team: String,
    pub member: String,
    pub lines: Vec<Line>,
}

/// Called with each member's screen as it changes.
pub type Show = Arc<dyn Fn(&ScreenPatch) + Send + Sync>;

/// A member's screen, and when the window was last told about it.
#[derive(Default)]
struct Shown {
    screen: Screen,
    sent: Option<std::time::Instant>,
    pending: bool,
}

pub struct Team {
    pub id: String,
    store: Mutex<Store>,
    live: Mutex<BTreeMap<String, Live>>,
    screens: Mutex<BTreeMap<String, Shown>>,
    /// Members whose current agent session has been told its role. A new
    /// session — the first, after a restart, after a crash — is told again.
    briefed: Mutex<HashSet<String>>,
    seats: BTreeMap<String, Seat>,
    tokens: BTreeMap<String, String>,
    wake: Notify,
    drive: Arc<dyn Drive>,
    emit: Emit,
    show: Show,
}

/// Every team this run of Coucou knows about.
pub struct Teams {
    teams: Mutex<HashMap<String, Arc<Team>>>,
    drive: Arc<dyn Drive>,
    emit: Emit,
    show: Show,
    /// Where logs are kept; `None` keeps them in memory (tests).
    root: Option<PathBuf>,
    /// coucou-team-mcp.exe, handed to every member as its MCP server.
    bridge: PathBuf,
}

/// 128 bits nobody can guess, without a dependency: std seeds each
/// `RandomState` from the system's random source.
fn token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

pub fn seat_key(team: &str, member: &str) -> String {
    format!("team:{team}:{member}")
}

fn settle(store: &mut Store) {
    loop {
        let more = tools::react(store.state());
        if more.is_empty() {
            break;
        }
        store.append_all(more);
    }
}

impl Team {
    /// The team's picture, as every change sends it: the screens are not in
    /// it, they stream on their own (`with_screens`).
    pub fn snapshot(&self) -> Option<Snapshot> {
        let live = self.live.lock().unwrap().clone();
        let mut snapshot = self.store.lock().unwrap().state().snapshot(&live)?;
        snapshot.detached = self.seats.is_empty();
        Some(snapshot)
    }

    /// The picture with each member's last screen lines: for a window that
    /// opens, or opens again.
    pub fn full_snapshot(&self) -> Option<Snapshot> {
        let mut snapshot = self.snapshot()?;
        let screens = self.screens.lock().unwrap();
        for m in &mut snapshot.members {
            if let Some(shown) = screens.get(&m.id) {
                m.screen = shown.screen.lines(SCREEN_LINES);
            }
        }
        Some(snapshot)
    }

    /// Changes something on a member's screen, and has the window told soon.
    fn on_screen(self: &Arc<Self>, member: &str, change: impl FnOnce(&mut Screen) -> bool) {
        let wait = {
            let mut screens = self.screens.lock().unwrap();
            let shown = screens.entry(member.to_string()).or_default();
            if !change(&mut shown.screen) || shown.pending {
                return;
            }
            let wait = shown.sent.map(|t| SCREEN_EVERY.saturating_sub(t.elapsed())).unwrap_or_default();
            shown.pending = !wait.is_zero();
            wait
        };
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) if !wait.is_zero() => {
                let team = Arc::downgrade(self);
                let member = member.to_string();
                runtime.spawn(async move {
                    tokio::time::sleep(wait).await;
                    if let Some(team) = team.upgrade() {
                        team.send_screen(&member);
                    }
                });
            }
            _ => self.send_screen(member),
        }
    }

    fn send_screen(&self, member: &str) {
        let lines = {
            let mut screens = self.screens.lock().unwrap();
            let Some(shown) = screens.get_mut(member) else { return };
            shown.pending = false;
            shown.sent = Some(std::time::Instant::now());
            shown.screen.take_changed()
        };
        if !lines.is_empty() {
            (self.show)(&ScreenPatch { team: self.id.clone(), member: member.to_string(), lines });
        }
    }

    pub fn config(&self) -> Option<TeamConfig> {
        self.store.lock().unwrap().state().config.clone()
    }

    pub fn token_ok(&self, member: &str, given: &str) -> bool {
        self.tokens.get(member).map(|t| !t.is_empty() && t == given).unwrap_or(false)
    }

    #[cfg(test)]
    pub fn token_for_tests(&self, member: &str) -> Option<String> {
        self.tokens.get(member).cloned()
    }

    /// Tells the screens, and lets the scheduler look again.
    fn changed(&self) {
        if let Some(snapshot) = self.snapshot() {
            (self.emit)(&snapshot);
        }
        self.wake.notify_one();
    }

    fn with_state<T>(&self, read: impl FnOnce(&State) -> T) -> T {
        read(self.store.lock().unwrap().state())
    }

    /// Records events that did not come from a member's tool call.
    fn record(&self, events: Vec<Event>) {
        {
            let mut store = self.store.lock().unwrap();
            store.append_all(events);
            settle(&mut store);
        }
        self.changed();
    }

    /// A member's tool call, from the MCP server.
    pub fn act(&self, member: &str, tool: &str, args: &Value) -> Result<String, String> {
        let text = {
            let mut store = self.store.lock().unwrap();
            let outcome = tools::call(store.state(), member, tool, args)?;
            let sent_back: Vec<String> = outcome
                .events
                .iter()
                .filter_map(|e| match e {
                    Event::Reviewed { task, accepted: false, .. } => Some(task.clone()),
                    _ => None,
                })
                .collect();
            store.append_all(outcome.events);
            for task in sent_back {
                let over = store.state().task(&task).map(|t| t.rejections >= MAX_REJECTIONS).unwrap_or(false);
                if over && store.state().status == TeamStatus::Running {
                    store.append(Event::Paused { why: format!("{task} was sent back {MAX_REJECTIONS} times.") });
                }
            }
            settle(&mut store);
            outcome.text
        };
        log::line(format!("team {}: {member} {tool}", self.id));
        self.changed();
        Ok(text)
    }

    /// Opens a turn for every member that is free and has something to hear:
    /// who, what it is told, and what it hears in it (from, text).
    fn next_turns(&self) -> Vec<(String, String, Vec<(String, String)>)> {
        let mut store = self.store.lock().unwrap();
        let mut out = Vec::new();
        let Some(config) = store.state().config.clone() else { return out };
        for member in &config.members {
            let state = store.state();
            if state.status != TeamStatus::Running {
                break;
            }
            let busy = state.turns.get(&member.id).map(|t| t.active).unwrap_or(false);
            if busy || state.lost.contains_key(&member.id) {
                continue;
            }
            let unheard = state.unheard(&member.id);
            if unheard.is_empty() {
                continue;
            }
            if state.total_turns >= config.max_turns {
                store.append(Event::Paused { why: format!("The team has used its {} turns.", config.max_turns) });
                break;
            }
            // A session that has not heard its role yet hears it first.
            let first = self.briefed.lock().unwrap().insert(member.id.clone());
            let mut text = if first { format!("{}\n\n", brief::role(&config, &member.id)) } else { String::new() };
            text.push_str(&brief::turn(&config, &unheard));
            let ids: Vec<String> = unheard.iter().map(|m| m.id.clone()).collect();
            let heard: Vec<(String, String)> = unheard.iter().map(|m| (m.from.clone(), m.text.clone())).collect();
            store.append(Event::TurnStarted { member: member.id.clone() });
            store.append(Event::Heard { member: member.id.clone(), ids });
            out.push((member.id.clone(), text, heard));
        }
        out
    }

    /// What reaches Coucou while a member's agent works: the tool it is in,
    /// the card it holds.
    fn sink(self: &Arc<Self>, member: &str) -> Sink {
        let team = Arc::downgrade(self);
        let member = member.to_string();
        Arc::new(move |event| {
            let Some(team) = team.upgrade() else { return };
            if let acp::Event::Update(u) = &event {
                team.on_screen(&member, |screen| screen.update(&u.update));
            }
            let changed = {
                let mut live = team.live.lock().unwrap();
                let entry = live.entry(member.clone()).or_default();
                match event {
                    // The screen shows it as it happens; the picture keeps
                    // the tool's name for when the window opens.
                    acp::Event::Update(u) => {
                        let kind = u.update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
                        let title = u.update.get("title").and_then(Value::as_str).unwrap_or("");
                        if kind == "tool_call" && !title.is_empty() {
                            entry.activity = title.to_string();
                        }
                        false
                    }
                    acp::Event::Permission(p) => {
                        entry.permission = Some(PermissionView {
                            request_id: p.request_id,
                            title: p.title,
                            kind: p.kind,
                            raw_input: p.raw_input,
                            options: p.options,
                            danger: p.danger,
                        });
                        true
                    }
                    // The agent is gone; the next one is a new session.
                    acp::Event::Exit(_) => {
                        team.briefed.lock().unwrap().remove(&member);
                        false
                    }
                }
            };
            if changed {
                if let Some(snapshot) = team.snapshot() {
                    (team.emit)(&snapshot);
                }
            }
        })
    }

    async fn run_turn(self: Arc<Self>, member: String, text: String, heard: Vec<(String, String)>) {
        let Some(seat) = self.seats.get(&member).cloned() else { return };
        log::line(format!("team {}: turn for {member} ({} characters)", self.id, text.chars().count()));
        let number = self.with_state(|s| s.turns.get(&member).map(|t| t.count).unwrap_or(0));
        self.on_screen(&member, |screen| {
            screen.turn_started(number, heard);
            true
        });
        let result = self.drive.prompt(seat, text, self.sink(&member)).await;
        self.live.lock().unwrap().remove(&member);
        self.on_screen(&member, |screen| {
            screen.turn_ended(number, result.as_ref().err().map(String::as_str));
            true
        });

        {
            let mut store = self.store.lock().unwrap();
            match &result {
                Ok(outcome) => store.append(Event::TurnEnded { member: member.clone(), ok: true, outcome: outcome.clone() }),
                Err(err) => {
                    log::line(format!("team {}: {member} failed: {err}", self.id));
                    store.append(Event::TurnEnded { member: member.clone(), ok: false, outcome: err.clone() });
                    store.append(Event::Lost { member: member.clone(), why: err.clone() });
                }
            }
            // What the turn left behind decides what happens next.
            let follow = if result.is_ok() {
                let state = store.state();
                let is_leader = state.leader() == member;
                // Finished once the leader has heard the request for the
                // report and ended the turn it was given for it — not at the
                // end of the turn in which it accepted the last task.
                if is_leader && state.wrapping && state.all_done() && state.unheard(&member).is_empty() {
                    Some(Event::Finished)
                } else if state.status != TeamStatus::Finished && state.unheard(&member).is_empty() && state.open_question(&member).is_none() {
                    // Work it was given, has not handed in, and is not waiting on anyone for.
                    let open: Vec<_> = state.open_tasks(&member).into_iter().filter(|t| t.blocked.is_none()).collect();
                    let no_plan = is_leader && state.tasks.is_empty();
                    if open.is_empty() && !no_plan {
                        None
                    } else if state.turns.get(&member).map(|t| t.silent).unwrap_or(0) >= MAX_SILENT_TURNS {
                        Some(Event::Lost {
                            member: member.clone(),
                            why: "It ended two turns in a row without a word about its open work.".into(),
                        })
                    } else {
                        let text = if no_plan { brief::nudge_leader_no_tasks() } else { brief::nudge(&open) };
                        Some(Event::Message { id: state.next_message_id(), from: SYSTEM.into(), to: member.clone(), text, task: None })
                    }
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(event) = follow {
                store.append(event);
            }
            settle(&mut store);
        }
        self.changed();
    }

    /// The scheduler: one loop per team, asleep until something changes.
    async fn run(self: Arc<Self>) {
        loop {
            let turns = self.next_turns();
            if !turns.is_empty() {
                if let Some(snapshot) = self.snapshot() {
                    (self.emit)(&snapshot);
                }
            }
            for (member, text, heard) in turns {
                tokio::spawn(self.clone().run_turn(member, text, heard));
            }
            if self.with_state(|s| s.status == TeamStatus::Finished) {
                // The work is done: the agents have nothing left to wait for.
                for seat in self.seats.values() {
                    self.drive.stop(seat.key.clone()).await;
                }
                log::line(format!("team {}: finished", self.id));
                break;
            }
            self.wake.notified().await;
        }
    }
}

impl Teams {
    pub fn new(drive: Arc<dyn Drive>, emit: Emit, root: Option<PathBuf>, bridge: PathBuf) -> Self {
        Self { teams: Mutex::new(HashMap::new()), drive, emit, show: Arc::new(|_| {}), root, bridge }
    }

    /// Where the members' live screens go.
    pub fn with_screens(mut self, show: Show) -> Self {
        self.show = show;
        self
    }

    pub fn get(&self, id: &str) -> Option<Arc<Team>> {
        self.teams.lock().unwrap().get(id).cloned()
    }

    fn team(&self, id: &str) -> Result<Arc<Team>, String> {
        self.get(id).ok_or_else(|| format!("There is no team '{id}'."))
    }

    pub fn snapshots(&self) -> Vec<Snapshot> {
        let teams: Vec<Arc<Team>> = self.teams.lock().unwrap().values().cloned().collect();
        let mut out: Vec<Snapshot> = teams.iter().filter_map(|t| t.full_snapshot()).collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    /// An agent session per member, each with its own way into the team's tools.
    fn seats_for(&self, config: &TeamConfig, profiles: &[AgentProfile]) -> Result<(BTreeMap<String, Seat>, BTreeMap<String, String>), String> {
        let mut seats = BTreeMap::new();
        let mut tokens = BTreeMap::new();
        for member in &config.members {
            let profile = profiles.iter().find(|p| p.id == member.agent).cloned().ok_or("an agent went missing")?;
            let secret = token();
            let launch = Launch {
                cwd: Some(config.work_dir.clone()),
                // Seen by the hooks the CLI runs, which then stay silent: a
                // member's steps and permissions come through the team.
                env: BTreeMap::from([
                    ("COUCOU_TEAM".to_string(), config.id.clone()),
                    ("COUCOU_MEMBER".to_string(), member.id.clone()),
                ]),
                mcp_servers: vec![McpServer {
                    name: crate::acp::TEAM_SERVER.into(),
                    command: self.bridge.to_string_lossy().to_string(),
                    args: vec![],
                    env: BTreeMap::from([
                        ("COUCOU_TEAM".to_string(), config.id.clone()),
                        ("COUCOU_MEMBER".to_string(), member.id.clone()),
                        ("COUCOU_TEAM_TOKEN".to_string(), secret.clone()),
                    ]),
                }],
                auto: config.auto_approve.then(|| Scope::new(&config.work_dir)),
                model: Some(member.model.trim().to_string()).filter(|m| !m.is_empty()),
            };
            seats.insert(member.id.clone(), Seat { key: seat_key(&config.id, &member.id), profile, launch });
            tokens.insert(member.id.clone(), secret);
        }

        Ok((seats, tokens))
    }

    /// Starts a team: a fresh log, an agent session per member, and the goal
    /// handed to the leader. Must be called from inside the async runtime.
    pub fn start(&self, config: TeamConfig, profiles: &[AgentProfile]) -> Result<Snapshot, String> {
        let runtime = runtime()?;
        let known: Vec<String> = profiles.iter().map(|p| p.id.clone()).collect();
        let problems = config.problems(&known);
        if !problems.is_empty() {
            return Err(problems.join("\n"));
        }
        if let Some(existing) = self.get(&config.id) {
            if existing.with_state(|s| s.status == TeamStatus::Running || s.turns.values().any(|t| t.active)) {
                return Err(format!("The team '{}' is already running.", config.name));
            }
        }

        let store = match &self.root {
            Some(root) => Store::fresh(&root.join(&config.id)).map_err(|e| format!("Could not open the team's log: {e}"))?,
            None => Store::memory(),
        };

        let (seats, tokens) = self.seats_for(&config, profiles)?;

        let team = Arc::new(Team {
            id: config.id.clone(),
            store: Mutex::new(store),
            live: Mutex::new(BTreeMap::new()),
            screens: Mutex::new(BTreeMap::new()),
            briefed: Mutex::new(HashSet::new()),
            seats,
            tokens,
            wake: Notify::new(),
            drive: self.drive.clone(),
            emit: self.emit.clone(),
            show: self.show.clone(),
        });
        {
            let mut store = team.store.lock().unwrap();
            let leader = config.leader.clone();
            let kickoff = brief::kickoff(&config);
            store.append(Event::Started { config });
            let id = store.state().next_message_id();
            store.append(Event::Message { id, from: SYSTEM.into(), to: leader, text: kickoff, task: None });
        }
        self.teams.lock().unwrap().insert(team.id.clone(), team.clone());
        log::line(format!("team {}: started with {} member(s)", team.id, team.seats.len()));
        runtime.spawn(team.clone().run());
        team.snapshot().ok_or_else(|| "The team did not start.".to_string())
    }

    /// Picks a team loaded from an earlier run up where it stopped: its
    /// record as it is, an agent per member again. The agents are new
    /// sessions — what they knew went with Coucou — so each is told its role
    /// again and where its work stands; lost members come back with them.
    pub fn revive(&self, id: &str, profiles: &[AgentProfile]) -> Result<Snapshot, String> {
        let runtime = runtime()?;
        let old = self.team(id)?;
        if !old.seats.is_empty() {
            return Err(format!("The team '{id}' is already running."));
        }
        let config = old.config().ok_or("The team's record has no setup to pick up.")?;
        let known: Vec<String> = profiles.iter().map(|p| p.id.clone()).collect();
        let problems = config.problems(&known);
        if !problems.is_empty() {
            return Err(problems.join("\n"));
        }
        let (seats, tokens) = self.seats_for(&config, profiles)?;
        let store = std::mem::replace(&mut *old.store.lock().unwrap(), Store::memory());
        let team = Arc::new(Team {
            id: id.to_string(),
            store: Mutex::new(store),
            live: Mutex::new(BTreeMap::new()),
            screens: Mutex::new(BTreeMap::new()),
            briefed: Mutex::new(HashSet::new()),
            seats,
            tokens,
            wake: Notify::new(),
            drive: self.drive.clone(),
            emit: self.emit.clone(),
            show: self.show.clone(),
        });
        {
            let mut store = team.store.lock().unwrap();
            let lost: Vec<String> = store.state().lost.keys().cloned().collect();
            store.append_all(lost.into_iter().map(|member| Event::Recovered { member }).collect());
            for member in &config.members {
                let state = store.state();
                let is_leader = member.id == config.leader;
                let open = state.open_tasks(&member.id);
                let to_review: Vec<&super::state::Task> =
                    if is_leader { state.tasks.iter().filter(|t| t.status == TaskStatus::Delivered).collect() } else { Vec::new() };
                let text = if is_leader && state.tasks.is_empty() {
                    brief::kickoff(&config)
                } else if is_leader || !open.is_empty() {
                    brief::revived(&open, &to_review)
                } else {
                    continue;
                };
                // Picked up before, and not heard yet: once is enough.
                if state.unheard(&member.id).iter().any(|m| m.text == text) {
                    continue;
                }
                let id = state.next_message_id();
                store.append(Event::Message { id, from: SYSTEM.into(), to: member.id.clone(), text, task: None });
            }
            if store.state().status == TeamStatus::Paused {
                store.append(Event::Resumed);
            }
            settle(&mut store);
        }
        self.teams.lock().unwrap().insert(id.to_string(), team.clone());
        log::line(format!("team {id}: picked up again with {} member(s)", team.seats.len()));
        runtime.spawn(team.clone().run());
        team.changed();
        team.snapshot().ok_or_else(|| "The team did not start.".to_string())
    }

    /// Brings back a team's record from disk, to look at. It comes back
    /// paused; picking the work up again is a later step.
    pub fn load(&self, id: &str) -> Option<Snapshot> {
        if let Some(team) = self.get(id) {
            return team.snapshot();
        }
        let store = Store::open(&self.root.as_ref()?.join(id)).ok()?;
        let team = Arc::new(Team {
            id: id.to_string(),
            store: Mutex::new(store),
            live: Mutex::new(BTreeMap::new()),
            screens: Mutex::new(BTreeMap::new()),
            briefed: Mutex::new(HashSet::new()),
            seats: BTreeMap::new(),
            tokens: BTreeMap::new(),
            wake: Notify::new(),
            drive: self.drive.clone(),
            emit: self.emit.clone(),
            show: self.show.clone(),
        });
        let snapshot = team.snapshot()?;
        self.teams.lock().unwrap().insert(id.to_string(), team);
        Some(snapshot)
    }

    /// A member's tool call. The token is the one its bridge was started with.
    pub fn act(&self, team: &str, member: &str, token: &str, tool: &str, args: &Value) -> Result<String, String> {
        let team = self.team(team)?;
        if !team.token_ok(member, token) {
            return Err("This session is not a member of that team.".into());
        }
        team.act(member, tool, args)
    }

    /// The person writes to a member — by default the leader.
    pub fn instruct(&self, team: &str, to: &str, text: &str) -> Result<(), String> {
        let team = self.team(team)?;
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        let (to, id) = team.with_state(|s| {
            let config = s.config.as_ref();
            let to = if to.is_empty() || to == "leader" { s.leader().to_string() } else { to.to_string() };
            let known = config.map(|c| c.has_member(&to)).unwrap_or(false);
            (known.then_some(to), s.next_message_id())
        });
        let to = to.ok_or("That is not a member of the team.")?;
        team.record(vec![Event::Message { id, from: YOU.into(), to, text: text.to_string(), task: None }]);
        Ok(())
    }

    /// The person answers a member's question.
    pub fn answer(&self, team: &str, question: &str, text: &str) -> Result<(), String> {
        let team = self.team(team)?;
        let found = team.with_state(|s| {
            s.questions.iter().find(|q| q.id == question && q.answer.is_none()).map(|q| (q.by.clone(), q.question.clone(), q.task.clone(), s.next_message_id()))
        });
        let (by, asked, task, id) = found.ok_or("That question is not open.")?;
        team.record(vec![
            Event::Answered { id: question.to_string(), text: text.trim().to_string() },
            Event::Message { id, from: YOU.into(), to: by, text: format!("You asked: {asked}\nThe user answers: {}", text.trim()), task },
        ]);
        Ok(())
    }

    /// The person answers the permission card a member's agent is holding.
    pub async fn permit(&self, team: &str, member: &str, option_id: Option<String>) -> Result<(), String> {
        let team = self.team(team)?;
        let request = team.live.lock().unwrap().get_mut(member).and_then(|l| l.permission.take());
        let request = request.ok_or("That member is not waiting for a permission.")?;
        let key = team.seats.get(member).map(|s| s.key.clone()).ok_or("That is not a member of the team.")?;
        let sent = team.drive.answer(key, request.request_id, option_id).await;
        team.changed();
        sent
    }

    /// No new turns. The ones under way run to their end.
    pub fn pause(&self, team: &str) -> Result<(), String> {
        let team = self.team(team)?;
        if team.with_state(|s| s.status == TeamStatus::Running) {
            team.record(vec![Event::Paused { why: "Paused by the user.".into() }]);
        }
        Ok(())
    }

    /// Turns again — and for a team loaded from an earlier run, agents again.
    pub fn resume(&self, team: &str, profiles: &[AgentProfile]) -> Result<(), String> {
        if self.team(team)?.seats.is_empty() {
            return self.revive(team, profiles).map(|_| ());
        }
        let team = self.team(team)?;
        if team.with_state(|s| s.status == TeamStatus::Paused) {
            team.record(vec![Event::Resumed]);
        }
        Ok(())
    }

    /// The emergency stop: pause, and interrupt every turn under way.
    pub async fn interrupt(&self, team: &str) -> Result<(), String> {
        self.pause(team)?;
        let team = self.team(team)?;
        let active: Vec<String> = team.with_state(|s| s.turns.iter().filter(|(_, t)| t.active).map(|(m, _)| m.clone()).collect());
        for member in active {
            if let Some(seat) = team.seats.get(&member) {
                let _ = team.drive.cancel(seat.key.clone()).await;
            }
        }
        Ok(())
    }

    /// Interrupts one member's turn — one that has gone quiet, say. The team
    /// carries on: the member is reminded of its open work in its next turn.
    pub async fn interrupt_member(&self, team: &str, member: &str) -> Result<(), String> {
        let team = self.team(team)?;
        let seat = team.seats.get(member).cloned().ok_or("That is not a member of the team.")?;
        if team.with_state(|s| s.turns.get(member).map(|t| t.active).unwrap_or(false)) {
            team.drive.cancel(seat.key).await?;
        }
        Ok(())
    }

    /// A lost member gets another go: a fresh agent, and a reminder of where it stood.
    pub async fn recover(&self, team: &str, member: &str) -> Result<(), String> {
        let team = self.team(team)?;
        if team.seats.is_empty() {
            return Err("This team was loaded from an earlier run. Press Continue to pick it up.".into());
        }
        let seat = team.seats.get(member).cloned().ok_or("That is not a member of the team.")?;
        if !team.with_state(|s| s.lost.contains_key(member)) {
            return Ok(());
        }
        team.drive.stop(seat.key).await;
        team.briefed.lock().unwrap().remove(member);
        let (id, text) = team.with_state(|s| {
            let open = s.open_tasks(member);
            let text = if open.is_empty() {
                "You were restarted. Call `team_status` to see where the team stands.".to_string()
            } else {
                let list: Vec<String> = open.iter().map(|t| format!("{} ({}, {})", t.id, t.title, if t.status == TaskStatus::Doing { "doing" } else { "not started" })).collect();
                format!("You were restarted and have lost what you knew. Call `team_status`, then carry on with: {}.", list.join("; "))
            };
            (s.next_message_id(), text)
        });
        team.record(vec![
            Event::Recovered { member: member.to_string() },
            Event::Message { id, from: SYSTEM.into(), to: member.to_string(), text, task: None },
        ]);
        Ok(())
    }

    /// Coucou is closing: no agent outlives it.
    pub async fn shutdown(&self) {
        let teams: Vec<Arc<Team>> = self.teams.lock().unwrap().values().cloned().collect();
        for team in teams {
            for seat in team.seats.values() {
                team.drive.stop(seat.key.clone()).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::shop;
    use super::super::state::MemberStatus;
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Weak;
    use std::time::Duration;

    /// What a scripted member does with a turn: it may call the team's tools,
    /// and says how the turn ended.
    type Script = Arc<dyn Fn(&Mate, &str) -> Result<String, String> + Send + Sync>;

    /// The scripted member's view of the team: its tools, nothing else.
    struct Mate {
        teams: Arc<Teams>,
        team: String,
        member: String,
        token: String,
    }

    impl Mate {
        fn tool(&self, tool: &str, args: Value) -> String {
            match self.teams.act(&self.team, &self.member, &self.token, tool, &args) {
                Ok(text) => text,
                Err(err) => format!("ERROR: {err}"),
            }
        }
    }

    /// A drive whose members are closures. `held` keeps a member's turn open
    /// until the test lets it go.
    struct Scripted {
        teams: Mutex<Weak<Teams>>,
        script: Script,
        prompts: Mutex<Vec<(String, String)>>,
        answered: Mutex<Vec<(String, Option<String>)>>,
        stopped: Mutex<Vec<String>>,
        hold: Arc<Notify>,
        held: Mutex<Vec<String>>,
        asks: Mutex<Vec<String>>,
    }

    impl Drive for Scripted {
        fn prompt(&self, seat: Seat, text: String, events: Sink) -> BoxFuture<Result<String, String>> {
            let member = seat.key.rsplit(':').next().unwrap().to_string();
            self.prompts.lock().unwrap().push((member.clone(), text.clone()));
            let teams = self.teams.lock().unwrap().upgrade().expect("teams");
            let server = &seat.launch.mcp_servers[0];
            let mate = Mate { teams, team: server.env["COUCOU_TEAM"].clone(), member: member.clone(), token: server.env["COUCOU_TEAM_TOKEN"].clone() };
            let script = self.script.clone();
            let hold = self.held.lock().unwrap().contains(&member).then(|| self.hold.clone());
            let asks = self.asks.lock().unwrap().contains(&member);
            Box::pin(async move {
                if asks {
                    events(acp::Event::Permission(acp::AcpPermission {
                        agent_id: seat.key.clone(),
                        request_id: json!(7),
                        title: "Run rm -rf dist".into(),
                        kind: "execute".into(),
                        raw_input: json!({ "command": "rm -rf dist" }),
                        options: vec![],
                        danger: Some(crate::policy::Danger::DeletesFolder),
                    }));
                }
                if let Some(hold) = hold {
                    hold.notified().await;
                }
                script(&mate, &text)
            })
        }

        fn answer(&self, key: String, _request_id: Value, option_id: Option<String>) -> BoxFuture<Result<(), String>> {
            self.answered.lock().unwrap().push((key, option_id));
            Box::pin(async { Ok(()) })
        }

        fn cancel(&self, _key: String) -> BoxFuture<Result<(), String>> {
            Box::pin(async { Ok(()) })
        }

        fn stop(&self, key: String) -> BoxFuture<()> {
            self.stopped.lock().unwrap().push(key);
            Box::pin(async {})
        }
    }

    struct Bench {
        teams: Arc<Teams>,
        drive: Arc<Scripted>,
        emitted: Arc<AtomicUsize>,
    }

    fn bench(script: Script) -> Bench {
        bench_in(script, None)
    }

    /// A bench whose team logs are kept in `root`, as the app keeps them.
    fn bench_in(script: Script, root: Option<PathBuf>) -> Bench {
        let drive = Arc::new(Scripted {
            teams: Mutex::new(Weak::new()),
            script,
            prompts: Default::default(),
            answered: Default::default(),
            stopped: Default::default(),
            hold: Arc::new(Notify::new()),
            held: Default::default(),
            asks: Default::default(),
        });
        let emitted = Arc::new(AtomicUsize::new(0));
        let count = emitted.clone();
        let emit: Emit = Arc::new(move |_| {
            count.fetch_add(1, Ordering::Relaxed);
        });
        let teams = Arc::new(Teams::new(drive.clone(), emit, root, PathBuf::from(r"C:\bin\coucou-team-mcp.exe")));
        *drive.teams.lock().unwrap() = Arc::downgrade(&teams);
        Bench { teams, drive, emitted }
    }

    impl Bench {
        fn start(&self, config: TeamConfig) -> Snapshot {
            self.teams.start(config, &[AgentProfile::copilot()]).expect("start")
        }

        fn snap(&self) -> Snapshot {
            self.teams.get("shop").unwrap().snapshot().unwrap()
        }

        fn member(&self, id: &str) -> super::super::state::MemberView {
            self.snap().members.into_iter().find(|m| m.id == id).unwrap()
        }

        async fn until(&self, what: &str, done: impl Fn(&Snapshot) -> bool) -> Snapshot {
            for _ in 0..600 {
                let snap = self.snap();
                if done(&snap) {
                    return snap;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            panic!("never happened: {what}\n{:#?}", self.snap().feed);
        }

        fn turns_of(&self, member: &str) -> Vec<String> {
            self.drive.prompts.lock().unwrap().iter().filter(|(m, _)| m == member).map(|(_, t)| t.clone()).collect()
        }
    }

    fn run<F: Future>(future: F) -> F::Output {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async { tokio::time::timeout(Duration::from_secs(20), future).await.expect("the test hung") })
    }

    fn work_dir() -> String {
        std::env::temp_dir().to_string_lossy().to_string()
    }

    /// `TASK-02` out of "TASK-02 is yours…" or "…handed in TASK-02 (…".
    fn task_in(text: &str, after: &str) -> Option<String> {
        let at = text.find(after)?;
        let rest = &text[at + after.len()..];
        let start = rest.find("TASK-")?;
        Some(rest[start..start + 7].to_string())
    }

    /// Members that do what the brief says: the leader plans, reviews and
    /// reports; everyone else starts, hands in, and stops.
    fn diligent() -> Script {
        Arc::new(|mate, text| {
            if text.contains("Plan the work for this goal") {
                mate.tool("task_create", json!({ "title": "商品圖片", "owner": "ai4", "criteria": ["六張商品圖"], "deliver_to": "ai3" }));
                mate.tool("task_create", json!({ "title": "購物車功能", "owner": "ai3", "depends_on": ["TASK-01"], "deliver_to": "ai2" }));
                mate.tool("task_create", json!({ "title": "整合測試", "owner": "ai2", "depends_on": ["TASK-02"] }));
            }
            let mut rest = text;
            while let Some(task) = task_in(rest, "handed in ") {
                if rest.contains("call `review`") {
                    mate.tool("review", json!({ "task": task, "accept": true }));
                }
                rest = &rest[rest.find("handed in ").unwrap() + 10..];
            }
            // The words of a hand-out, not the brief's mention of them.
            if let Some(at) = text.find(" is yours and ready to start") {
                let task = text[at - 7..at].to_string();
                mate.tool("task_update", json!({ "task": task, "status": "doing" }));
                mate.tool("deliver", json!({ "task": task, "locator": "http://localhost:5173/", "summary": format!("{} 完成", mate.member) }));
            }
            if text.contains("Write the final report") {
                mate.tool("message_send", json!({ "to": "you", "text": "網站完成,預覽在 http://localhost:5173/" }));
            }
            Ok("end_turn".into())
        })
    }

    #[test]
    fn the_shop_team_runs_itself_from_goal_to_report() {
        run(async {
            let bench = bench(diligent());
            let started = bench.start(shop(&work_dir()));
            assert_eq!(started.status, TeamStatus::Running);

            let done = bench.until("the team finishes", |s| s.status == TeamStatus::Finished).await;
            assert_eq!((done.done, done.total), (3, 3));
            // Everyone who had work has handed it in; the leader owned none.
            assert!(done.members.iter().all(|m| m.status == if m.is_leader { MemberStatus::Idle } else { MemberStatus::Done }));
            assert_eq!(done.messages.last().unwrap().to, YOU);
            assert_eq!(done.deliverables.len(), 3);
            assert!(done.deliverables.iter().all(|d| d.accepted == Some(true)));

            // The leader's first turn carries its role and the goal; later ones only the news.
            let leader = bench.turns_of("ai1");
            assert!(leader[0].contains("You are AI 1 (id `ai1`)") && leader[0].contains("You are the leader") && leader[0].contains("購物車與會員登入"));
            assert!(!leader[1].contains("You are AI 1 (id `ai1`)"));
            // A member hears nothing until its input is there, then hears where it is.
            let ai3 = bench.turns_of("ai3");
            assert!(ai3[0].contains("You are AI 3") && ai3[0].contains("You receive: 圖片素材 from AI 4 (ai4)"));
            assert!(ai3[0].contains("TASK-02 is yours and ready") && ai3[0].contains("Input — TASK-01"));

            // When it is over the agents are stopped, and the screens were told all along.
            bench.until("the agents stop", |_| bench.drive.stopped.lock().unwrap().len() == 4).await;
            assert!(bench.emitted.load(Ordering::Relaxed) > 10);
            // Nothing more can be changed afterwards.
            let team = bench.teams.get("shop").unwrap();
            assert!(team.act("ai1", "task_create", &json!({ "title": "x", "owner": "ai2" })).unwrap_err().contains("has finished"));
        });
    }

    #[test]
    fn a_member_that_says_nothing_is_reminded_once_then_marked_lost() {
        run(async {
            // The leader plans; AI 4 takes its turns and never touches a tool.
            let script: Script = Arc::new(|mate, text| {
                if text.contains("Plan the work for this goal") {
                    mate.tool("task_create", json!({ "title": "商品圖片", "owner": "ai4" }));
                }
                Ok("end_turn".into())
            });
            let bench = bench(script);
            bench.start(shop(&work_dir()));
            bench.until("ai4 is lost", |s| s.members.iter().any(|m| m.id == "ai4" && m.status == MemberStatus::Lost)).await;

            let turns = bench.turns_of("ai4");
            assert_eq!(turns.len(), 2, "one turn for the task, one for the reminder, and no more");
            assert!(turns[1].contains("still open and Coucou has no report on it: TASK-01"));
            assert!(bench.member("ai4").lost_why.contains("two turns in a row"));
            assert_eq!(bench.snap().status, TeamStatus::Running);

            // Restarted by the person, it is told where it stood and gets a turn.
            bench.teams.recover("shop", "ai4").await.unwrap();
            bench.until("ai4 gets a third turn", |_| bench.turns_of("ai4").len() >= 3).await;
            assert!(bench.turns_of("ai4")[2].contains("You were restarted") && bench.turns_of("ai4")[2].contains("TASK-01"));
            assert!(bench.drive.stopped.lock().unwrap().contains(&"team:shop:ai4".to_string()));
        });
    }

    #[test]
    fn a_leader_that_plans_nothing_is_reminded_too() {
        run(async {
            let bench = bench(Arc::new(|_, _| Ok("end_turn".into())));
            bench.start(shop(&work_dir()));
            bench.until("the leader is lost", |s| s.members[0].status == MemberStatus::Lost).await;
            let turns = bench.turns_of("ai1");
            assert_eq!(turns.len(), 2);
            assert!(turns[1].contains("No task exists yet"));
        });
    }

    #[test]
    fn an_agent_that_fails_to_start_is_lost_with_the_reason() {
        run(async {
            let bench = bench(Arc::new(|_, _| Err("Copilot CLI wants to be logged in".into())));
            bench.start(shop(&work_dir()));
            bench.until("the leader is lost", |s| s.members[0].status == MemberStatus::Lost).await;
            assert!(bench.member("ai1").lost_why.contains("wants to be logged in"));
            assert_eq!(bench.turns_of("ai1").len(), 1);
        });
    }

    #[test]
    fn a_question_holds_a_member_until_the_person_answers() {
        run(async {
            let script: Script = Arc::new(|mate, text| {
                if text.contains("Plan the work for this goal") {
                    mate.tool("ask_human", json!({ "question": "要支援手機版嗎?" }));
                } else if text.contains("The user answers: 要") {
                    mate.tool("task_create", json!({ "title": "手機版", "owner": "ai3" }));
                }
                Ok("end_turn".into())
            });
            let bench = bench(script);
            bench.start(shop(&work_dir()));
            let asked = bench.until("the question shows", |s| s.questions.len() == 1 && s.members[0].status == MemberStatus::WaitingYou).await;
            assert_eq!(asked.members[0].waiting.as_ref().unwrap().what, "要支援手機版嗎?");
            // No reminder while it waits for the person.
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(bench.turns_of("ai1").len(), 1);

            bench.teams.answer("shop", "Q-1", "要").unwrap();
            bench.until("the leader plans", |s| s.tasks.len() == 1).await;
            assert!(bench.teams.answer("shop", "Q-1", "again").is_err());
        });
    }

    #[test]
    fn an_instruction_reaches_the_leader_at_its_next_turn() {
        run(async {
            let bench = bench(diligent());
            bench.drive.held.lock().unwrap().push("ai1".into());
            bench.start(shop(&work_dir()));
            bench.until("the leader is working", |s| s.members[0].status == MemberStatus::Working).await;

            // Sent while the leader is busy: it waits, it does not interrupt.
            bench.teams.instruct("shop", "", "首版不要做優惠券").unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(bench.turns_of("ai1").len(), 1);
            assert!(!bench.snap().messages.last().unwrap().heard);

            bench.drive.held.lock().unwrap().clear();
            bench.drive.hold.notify_one();
            bench.until("the leader hears it", |_| bench.turns_of("ai1").iter().any(|t| t.contains("Message from the user:\n首版不要做優惠券"))).await;
            assert!(bench.teams.instruct("shop", "nobody", "x").is_err());
        });
    }

    #[test]
    fn pausing_stops_new_turns_and_resuming_picks_up() {
        run(async {
            let bench = bench(diligent());
            bench.drive.held.lock().unwrap().push("ai1".into());
            bench.start(shop(&work_dir()));
            bench.until("the leader is working", |s| s.members[0].status == MemberStatus::Working).await;
            bench.teams.pause("shop").unwrap();

            // The leader's turn runs to its end and plans; nobody is handed a turn after it.
            bench.drive.held.lock().unwrap().clear();
            bench.drive.hold.notify_one();
            bench.until("the plan exists", |s| s.tasks.len() == 3 && s.members[0].status != MemberStatus::Working).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(bench.turns_of("ai4").is_empty());
            assert_eq!(bench.snap().status, TeamStatus::Paused);

            bench.teams.resume("shop", &[AgentProfile::copilot()]).unwrap();
            bench.until("the team finishes", |s| s.status == TeamStatus::Finished).await;
        });
    }

    /// A synchronous command runs on the window's thread, outside the
    /// runtime: starting a team from there is refused, never a panic.
    #[test]
    fn a_team_asked_to_start_outside_the_runtime_says_so() {
        let bench = bench(diligent());
        let refused = bench.teams.start(shop(&work_dir()), &[AgentProfile::copilot()]).unwrap_err();
        assert!(refused.contains("async runtime"), "{refused}");
        assert!(bench.teams.get("shop").is_none());
    }

    #[test]
    fn a_team_left_by_an_earlier_run_is_picked_up_where_it_stopped() {
        run(async {
            let root = std::env::temp_dir().join(format!("coucou-revive-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let diligent = diligent();
            // A new session told to carry on does so; otherwise it is the diligent member.
            let carries_on: Script = Arc::new(move |mate, text| {
                if let Some(task) = task_in(text, "carry on with: ") {
                    mate.tool("task_update", json!({ "task": task, "status": "doing" }));
                    mate.tool("deliver", json!({ "task": task, "locator": "http://localhost:5173/", "summary": "接著做完" }));
                }
                diligent(mate, text)
            });

            // The first run: the plan is made, and Coucou closes while AI 4 is at its task.
            let first = bench_in(carries_on.clone(), Some(root.clone()));
            first.drive.held.lock().unwrap().push("ai4".into());
            first.start(shop(&work_dir()));
            first.until("AI 4 is at work", |s| s.members[3].status == MemberStatus::Working).await;

            // Coucou again: the team comes back as a record, paused, with nobody behind it.
            let second = bench_in(carries_on, Some(root.clone()));
            let loaded = second.teams.load("shop").unwrap();
            assert!(loaded.detached);
            assert_eq!(loaded.status, TeamStatus::Paused);
            assert!(second.teams.recover("shop", "ai4").await.unwrap_err().contains("Press Continue"));

            second.teams.resume("shop", &[AgentProfile::copilot()]).unwrap();
            assert!(!second.snap().detached);
            let done = second.until("the team finishes", |s| s.status == TeamStatus::Finished).await;
            assert_eq!((done.done, done.total), (3, 3));

            // Each new session hears its role again, then where its work stands.
            let ai4 = second.turns_of("ai4");
            assert!(ai4[0].starts_with("You are"), "{}", ai4[0]);
            assert!(ai4[0].contains("picked the team up again") && ai4[0].contains("TASK-01"), "{}", ai4[0]);
            assert!(second.turns_of("ai1")[0].starts_with("You are"));
            // The earlier run's record is the same log, carried on.
            let log = std::fs::read_to_string(root.join("shop").join("events.jsonl")).unwrap();
            assert!(log.contains("\"interrupted\"") && log.contains("\"resumed\""));
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn the_turn_limit_pauses_the_team() {
        run(async {
            let bench = bench(diligent());
            let mut config = shop(&work_dir());
            config.max_turns = 2;
            bench.start(config);
            let paused = bench.until("the team pauses", |s| s.status == TeamStatus::Paused).await;
            assert!(paused.paused_why.contains("used its 2 turns"));
            assert_eq!(paused.total_turns, 2);
        });
    }

    #[test]
    fn a_permission_card_waits_for_the_person_and_is_answered_through_the_drive() {
        run(async {
            let bench = bench(diligent());
            bench.drive.held.lock().unwrap().push("ai1".into());
            bench.drive.asks.lock().unwrap().push("ai1".into());
            bench.start(shop(&work_dir()));
            let waiting = bench.until("the card shows", |s| s.members[0].status == MemberStatus::WaitingYou).await;
            let card = waiting.members[0].permission.clone().unwrap();
            assert_eq!(card.danger, Some(crate::policy::Danger::DeletesFolder));
            assert_eq!(waiting.members[0].waiting.as_ref().unwrap().on, YOU);

            bench.teams.permit("shop", "ai1", Some("no".into())).await.unwrap();
            assert_eq!(bench.drive.answered.lock().unwrap()[0], ("team:shop:ai1".to_string(), Some("no".to_string())));
            assert_eq!(bench.member("ai1").status, MemberStatus::Working);
            assert!(bench.teams.permit("shop", "ai1", None).await.is_err());
            bench.drive.hold.notify_one();
        });
    }

    #[test]
    fn a_member_s_seat_carries_the_folder_the_bridge_and_the_rules() {
        run(async {
            let bench = bench(Arc::new(|_, _| Ok("end_turn".into())));
            let dir = work_dir();
            bench.start(shop(&dir));
            let team = bench.teams.get("shop").unwrap();
            let seat = &team.seats["ai3"];
            assert_eq!(seat.key, "team:shop:ai3");
            assert_eq!(seat.launch.cwd.as_deref(), Some(dir.as_str()));
            assert_eq!(seat.launch.auto, Some(Scope::new(&dir)));
            // The CLI itself is told it is a team member (its hooks stay silent); the token is not in its environment.
            assert_eq!(seat.launch.env["COUCOU_TEAM"], "shop");
            assert!(!seat.launch.env.contains_key("COUCOU_TEAM_TOKEN"));
            let server = &seat.launch.mcp_servers[0];
            assert_eq!(server.command, r"C:\bin\coucou-team-mcp.exe");
            assert_eq!(server.env["COUCOU_MEMBER"], "ai3");
            // Each member has its own token, and only its own opens the door.
            let token = server.env["COUCOU_TEAM_TOKEN"].clone();
            assert_eq!(token.len(), 32);
            assert_ne!(token, team.seats["ai4"].launch.mcp_servers[0].env["COUCOU_TEAM_TOKEN"]);
            assert!(bench.teams.act("shop", "ai3", &token, "team_status", &json!({})).is_ok());
            assert!(bench.teams.act("shop", "ai4", &token, "team_status", &json!({})).is_err());
            assert!(bench.teams.act("shop", "ai3", "", "team_status", &json!({})).is_err());

            // A team that turns the rules off gets a card for everything.
            let mut careful = shop(&dir);
            careful.id = "careful".into();
            careful.auto_approve = false;
            bench.teams.start(careful, &[AgentProfile::copilot()]).unwrap();
            assert_eq!(bench.teams.get("careful").unwrap().seats["ai3"].launch.auto, None);
            // And a team that cannot start says why.
            let mut broken = shop(&dir);
            broken.id = "broken".into();
            broken.leader = "nobody".into();
            assert!(bench.teams.start(broken, &[AgentProfile::copilot()]).unwrap_err().contains("is not a member"));
            assert!(bench.teams.start(shop(&dir), &[AgentProfile::copilot()]).unwrap_err().contains("already running"));
        });
    }
}
