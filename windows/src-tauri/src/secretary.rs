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
//
// The person may attach files to what they ask (for a team's knowledge
// base). The model hears their names, kinds and sizes, never what is in
// them; a proposal names them, and only its confirmation copies them in.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use crate::acp::{AgentProfile, Agents};
use crate::llm::tools::{self, Call, Tool, Turn};
use crate::llm::Provider;
use crate::settings;
use crate::team::knowledge::{self, DocKind, Kb, KeyLike, Visibility};
use crate::team::orchestrator::{KnowledgeChange, Teams};
use crate::team::TeamConfig;

const MAX_ROUNDS: usize = 8;

/// Told to the model when it says a card is waiting but made none.
// i18n: model-facing
const NO_CARD: &str = "[Agent Center] You wrote that a card (or a button to click) is ready for the user, but you called no propose_* tool in this answer, so nothing is on their screen. If you meant to prepare something, call the propose_* tool now with what you described; if not, tell the user plainly that nothing was prepared yet.";

/// Whether an answer speaks of a card or a button for the person.
// i18n: model-facing (words looked for in the model's answer, never shown)
fn claims_card(text: &str) -> bool {
    let t = text.to_lowercase();
    ["提案卡", "卡片", "按鈕", "按下", "proposal card", "the card", "a card", "button", "click"].iter().any(|w| t.contains(w))
}
const MAX_RESULT: usize = 8000;
const KEEP_TURNS: usize = 60;
const COLORS: [&str; 8] = ["#5b8def", "#34c7a0", "#a06cf0", "#f5b63d", "#f472b6", "#22d3ee", "#84cc16", "#f97316"];

/// Something Agent Center prepared, waiting for the person's click.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
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
    /// The attached files it would put in a knowledge base.
    #[serde(default)]
    pub uses: Vec<String>,
    /// A new team's members as picked from Agent Pool, for the window's picking animation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub picks: Vec<Pick>,
    /// What confirming it does; kept out of what the window sees, saved with the conversation.
    #[serde(skip)]
    payload: Value,
}

/// One member of a proposed team: the team agent it runs as, and who it is.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub agent: String,
    pub name: String,
    pub role: String,
    pub leader: bool,
}

/// A file the person attached in the conversation, kept until a proposal
/// that names it is confirmed (or the conversation is cleared).
#[derive(Debug, Clone)]
pub struct Upload {
    /// `u` and four hex digits.
    pub id: String,
    pub name: String,
    /// Its copy in the uploads folder.
    pub file: PathBuf,
    /// Where it came from, when it was dropped or picked; empty for a paste.
    pub origin: String,
    pub kind: DocKind,
    pub bytes: u64,
    /// It looks like it holds a key…
    pub key_like: Option<KeyLike>,
    /// …and the person said to keep it anyway.
    pub force: bool,
}

/// An attached file, as the window shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadView {
    pub id: String,
    pub name: String,
    pub kind: DocKind,
    pub bytes: u64,
    pub key_like: Option<KeyLike>,
    pub force: bool,
}

impl Upload {
    pub fn view(&self) -> UploadView {
        UploadView { id: self.id.clone(), name: self.name.clone(), kind: self.kind, bytes: self.bytes, key_like: self.key_like.clone(), force: self.force }
    }

    /// May a proposal name it? Not while it waits for the person's word on a key.
    fn ready(&self) -> bool {
        self.key_like.is_none() || self.force
    }
}

/// One document a proposal puts in a team's knowledge base.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Item {
    /// An attached file's id…
    #[serde(default)]
    upload: String,
    /// …or a full path the person wrote.
    #[serde(default)]
    path: String,
    name: String,
    visibility: Visibility,
    bytes: u64,
    /// Looks like it holds a key (for an attached file: the person kept it anyway).
    key_like: bool,
}

/// A look-up or a preparation Agent Center made on the way to its answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub tool: String,
    pub label: String,
    /// The agent it looks at (agent_models), for the window's picking animation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub text: String,
    pub steps: Vec<Step>,
    pub proposals: Vec<Proposal>,
    /// A question it asks with options to click (offer_choices).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Choices>,
}

/// Options for the person to click; the one clicked is sent as their answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choices {
    pub question: String,
    pub options: Vec<String>,
    /// More than one may be picked.
    pub multiple: bool,
}

/// What offer_choices was given, or why not: 2 to 6 short options.
// i18n: model-facing
fn choices_of(a: &Value) -> Result<Choices, String> {
    let question = text(a, "question").unwrap_or_default();
    let options: Vec<String> = a
        .get("options")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(Value::as_str).map(|o| o.trim().to_string()).filter(|o| !o.is_empty()).collect())
        .unwrap_or_default();
    if options.len() < 2 || options.len() > 6 {
        return Err("Give 2 to 6 options.".into());
    }
    if options.iter().any(|o| o.chars().count() > 80) {
        return Err("Keep each option under 80 characters; put the detail in your answer.".into());
    }
    Ok(Choices { question, options, multiple: a.get("multiple").and_then(Value::as_bool).unwrap_or(false) })
}

/// What Agent Center can see and act on.
pub struct Office {
    pub teams: Arc<Teams>,
    /// Every agent a team may run as: the team agents, and the native ones
    /// a team set up before may still name.
    pub agents: Vec<AgentProfile>,
    /// What a new team is built from: the team agents only (team_agents.rs).
    pub choices: Vec<AgentProfile>,
    pub driver: Arc<Agents>,
    /// The person's clock: minutes to add to UTC for local time.
    pub tz_minutes: i64,
    /// What the person calls Agent Center; empty for no name.
    pub name: String,
    /// The person's own instructions for Agent Center (its ⚙ → 自訂指示); empty for none.
    pub instructions: String,
    /// Library skills Agent Center reads itself (its ⚙ → Skills), by name.
    pub skills: Vec<String>,
    /// Library skills the person took away from members (its ⚙ → Skills), by name.
    pub hidden_skills: Vec<String>,
    /// Fast mode forced from Agent Center's ⚙: every team it proposes is a fast one.
    pub fast: bool,
    /// The person's root folder for new teams (its ⚙ → 根目錄): a team the person
    /// gave no folder works in a new subfolder of it. Empty: the folder is asked for.
    pub root: String,
}

impl Office {
    /// The office as the person set it up: `natives` from Settings → Agent Provider,
    /// the team agents from Teamwork.
    pub fn new(teams: Arc<Teams>, natives: &[AgentProfile], driver: Arc<Agents>, tz_minutes: i64, name: String) -> Self {
        let doc = crate::team_agents::current();
        Self {
            teams,
            agents: doc.runnable(natives),
            choices: doc.choices(natives),
            driver,
            tz_minutes,
            name,
            instructions: String::new(),
            skills: Vec::new(),
            hidden_skills: Vec::new(),
            fast: false,
            root: String::new(),
        }
    }

    /// The skills Agent Center may hand a member: the member library less what the person hid.
    pub fn member_skills(&self) -> Vec<crate::team_agents::LibrarySkill> {
        crate::team_agents::member_library().into_iter().filter(|s| !self.hidden_skills.iter().any(|h| h.eq_ignore_ascii_case(&s.name))).collect()
    }
}

/// A saved conversation, in its file (`secretary-chats/<id>.json`).
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedChat {
    id: String,
    title: String,
    updated_ms: u64,
    turns: Vec<Turn>,
    /// Each proposal as the window sees it, with its `payload` put back in.
    proposals: Vec<Value>,
    notes: Vec<String>,
    /// The conversation as the window drew it (its entries), kept as it gave it.
    entries: String,
}

/// A saved conversation, in the window's list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInfo {
    pub id: String,
    pub title: String,
    pub updated_ms: u64,
    /// The one on screen now.
    pub current: bool,
}

/// How many conversations are kept; the oldest go first.
const CHATS_MAX: usize = 60;

pub struct Secretary {
    turns: Mutex<Vec<Turn>>,
    proposals: Mutex<Vec<Proposal>>,
    /// What the person did with proposals since the model last heard, told with their next words.
    notes: Mutex<Vec<String>>,
    busy: AtomicBool,
    /// Files attached in this conversation, by id.
    uploads: Mutex<BTreeMap<String, Upload>>,
    uploads_dir: PathBuf,
    /// The conversation on screen, by the id its file has.
    chat: Mutex<String>,
    /// Where conversations are saved.
    chats_dir: PathBuf,
}

fn chat_id() -> String {
    format!("c{}", crate::team::store::now_ms())
}

impl Default for Secretary {
    fn default() -> Self {
        Self::at(settings::secretary_uploads_dir())
    }
}

impl Secretary {
    /// A secretary keeping attached files in `dir`.
    pub fn at(dir: PathBuf) -> Self {
        let chats_dir = dir.parent().map(|p| p.join("secretary-chats")).unwrap_or_else(|| dir.join("chats"));
        Self { turns: Default::default(), proposals: Default::default(), notes: Default::default(), busy: AtomicBool::new(false), uploads: Default::default(), uploads_dir: dir, chat: Mutex::new(chat_id()), chats_dir }
    }

    /// The one the app runs: files attached in an earlier run belong to a
    /// conversation that is gone, so they go too.
    pub fn fresh() -> Self {
        let me = Self::default();
        let _ = std::fs::remove_dir_all(&me.uploads_dir);
        me
    }

    pub fn reset(&self) {
        self.turns.lock().unwrap().clear();
        self.proposals.lock().unwrap().clear();
        self.notes.lock().unwrap().clear();
        self.uploads.lock().unwrap().clear();
        let _ = std::fs::remove_dir_all(&self.uploads_dir);
        *self.chat.lock().unwrap() = chat_id();
    }

    /// Saves the conversation on screen: Agent Center's side (its turns, proposals and
    /// notes) with the window's own drawing of it (`entries`), so it can be brought back
    /// with 對話紀錄. Nothing is saved before anything was said.
    pub fn chat_save(&self, title: &str, entries: &str) -> Result<Option<ChatInfo>, String> {
        let turns = self.turns.lock().unwrap().clone();
        if turns.is_empty() {
            return Ok(None);
        }
        let proposals: Vec<Value> = self
            .proposals
            .lock()
            .unwrap()
            .iter()
            .map(|p| {
                let mut v = serde_json::to_value(p).unwrap_or(Value::Null);
                v["payload"] = p.payload.clone();
                v
            })
            .collect();
        let id = self.chat.lock().unwrap().clone();
        let title: String = title.trim().chars().take(60).collect();
        let title: String = if title.is_empty() { tr!("(沒有標題)", "(untitled)") } else { title };
        let saved = SavedChat { id: id.clone(), title, updated_ms: crate::team::store::now_ms(), turns, proposals, notes: self.notes.lock().unwrap().clone(), entries: entries.to_string() };
        std::fs::create_dir_all(&self.chats_dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec(&saved).map_err(|e| e.to_string())?;
        std::fs::write(self.chats_dir.join(format!("{id}.json")), json).map_err(|e| -> String { tr!(format!("無法儲存對話:{e}"), format!("Could not save the conversation: {e}")) })?;
        // The oldest go once there are too many.
        let mut all = self.chats();
        all.sort_by_key(|c| std::cmp::Reverse(c.updated_ms));
        for old in all.iter().skip(CHATS_MAX) {
            let _ = std::fs::remove_file(self.chats_dir.join(format!("{}.json", old.id)));
        }
        Ok(Some(ChatInfo { id: saved.id, title: saved.title, updated_ms: saved.updated_ms, current: true }))
    }

    /// The saved conversations, newest first.
    pub fn chats(&self) -> Vec<ChatInfo> {
        let current = self.chat.lock().unwrap().clone();
        let mut out: Vec<ChatInfo> = std::fs::read_dir(&self.chats_dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| {
                let saved: SavedChat = serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok()?;
                Some(ChatInfo { current: saved.id == current, id: saved.id, title: saved.title, updated_ms: saved.updated_ms })
            })
            .collect();
        out.sort_by_key(|c| std::cmp::Reverse(c.updated_ms));
        out
    }

    /// Brings a saved conversation back: Agent Center goes on from its turns, its open
    /// cards can still be confirmed, and the window gets its entries to draw. Files
    /// attached to the conversation on screen until now are let go.
    pub fn chat_open(&self, id: &str) -> Result<String, String> {
        if self.busy.load(Ordering::SeqCst) {
            return Err(tr!("Agent Center 還在處理上一個請求。", "Agent Center is still on the last request."));
        }
        let path = self.chats_dir.join(format!("{}.json", id.trim()));
        let bytes = std::fs::read(&path).map_err(|_| -> String { tr!("這段對話已經不在了。", "That conversation is no longer there.") })?;
        let saved: SavedChat = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let proposals: Vec<Proposal> = saved
            .proposals
            .into_iter()
            .filter_map(|mut v| {
                let payload = v.as_object_mut().and_then(|o| o.remove("payload")).unwrap_or(Value::Null);
                let mut p: Proposal = serde_json::from_value(v).ok()?;
                p.payload = payload;
                Some(p)
            })
            .collect();
        *self.turns.lock().unwrap() = saved.turns;
        *self.proposals.lock().unwrap() = proposals;
        *self.notes.lock().unwrap() = saved.notes;
        self.uploads.lock().unwrap().clear();
        let _ = std::fs::remove_dir_all(&self.uploads_dir);
        *self.chat.lock().unwrap() = saved.id;
        Ok(saved.entries)
    }

    /// Forgets a saved conversation. The one on screen stays on screen.
    pub fn chat_delete(&self, id: &str) -> Result<(), String> {
        let path = self.chats_dir.join(format!("{}.json", id.trim()));
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// A file the person attached: kept aside, checked as the knowledge base
    /// checks a document (its size, its kind, a key in a text).
    pub fn upload(&self, name: &str, bytes: Vec<u8>, origin: &str) -> Result<UploadView, String> {
        let name = knowledge::clean_name(name);
        if bytes.len() as u64 > knowledge::MAX_FILE {
            return Err(format!("{name} is larger than {} MB.", knowledge::MAX_FILE / 1024 / 1024)); // i18n-ok: kbSaid() in team/knowledge.ts translates it
        }
        let (kind, kept) = knowledge::classify(bytes);
        let key_like = if kind == DocKind::Text { knowledge::find_key_like(&String::from_utf8_lossy(&kept)) } else { None };
        let mut all = self.uploads.lock().unwrap();
        let id = loop {
            let id = format!("u{}", knowledge::random_hex(4));
            if !all.contains_key(&id) {
                break id;
            }
        };
        let not_kept = |e: std::io::Error| -> String { tr!(format!("無法保留 {name}:{e}"), format!("Could not keep {name}: {e}")) };
        std::fs::create_dir_all(&self.uploads_dir).map_err(not_kept)?;
        let file = self.uploads_dir.join(format!("{id}-{name}"));
        std::fs::write(&file, &kept).map_err(not_kept)?;
        let upload = Upload { id: id.clone(), name, file, origin: origin.to_string(), kind, bytes: kept.len() as u64, key_like, force: false };
        let view = upload.view();
        all.insert(id, upload);
        Ok(view)
    }

    /// The person keeps an attached file that looks like it holds a key.
    pub fn upload_force(&self, id: &str) -> Result<UploadView, String> {
        let mut all = self.uploads.lock().unwrap();
        let u = all.get_mut(id).ok_or_else(|| -> String { tr!("這個檔案已經不在附件裡了。", "That file is no longer attached.") })?;
        u.force = true;
        Ok(u.view())
    }

    /// The person takes an attached file away again.
    pub fn upload_remove(&self, id: &str) {
        if let Some(u) = self.uploads.lock().unwrap().remove(id) {
            let _ = std::fs::remove_file(&u.file);
        }
    }

    /// What the model hears of the files attached to a request: names, kinds
    /// and sizes, never what is in them.
    // i18n: model-facing
    fn attached_line(&self, ids: &[String]) -> Option<String> {
        let all = self.uploads.lock().unwrap();
        let parts: Vec<String> = ids
            .iter()
            .filter_map(|id| all.get(id))
            .filter(|u| u.ready())
            .map(|u| {
                let kind = match u.kind {
                    DocKind::Text => "text",
                    DocKind::Image => "image",
                    DocKind::File => "file",
                };
                let key = if u.key_like.is_some() { ", looks like it has a key — the user chose to keep it" } else { "" };
                format!("{} {} ({kind}, {}{key})", u.id, u.name, knowledge::size_text(u.bytes))
            })
            .collect();
        (!parts.is_empty()).then(|| format!("[Files the user attached: {}]", parts.join("; ")))
    }

    /// One request from the person: Agent Center looks things up and
    /// prepares what is asked, then answers. `uploads`: the files attached to it.
    pub async fn ask(&self, provider: &Provider, office: &Office, text: &str, uploads: &[String], on_step: &(dyn Fn(&Step) + Send + Sync)) -> Result<Reply, String> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(tr!("Agent Center 還在處理上一個請求。", "Agent Center is still on the last request."));
        }
        let text = match self.attached_line(uploads) {
            Some(line) => format!("{text}\n\n{line}"),
            None => text.to_string(),
        };
        let result = self.run(provider, office, &text, on_step).await;
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
        let mut nudged = false;
        let mut offered: Option<Choices> = None;

        for _ in 0..MAX_ROUNDS {
            let reply = tools::complete(provider, &system, &turns, &tools).await?;
            if reply.calls.is_empty() {
                let text = reply.text.trim().to_string();
                if text.is_empty() {
                    return Err(tr!(format!("{} 沒有回答。", provider.name), format!("{} gave no answer.", provider.name)));
                }
                // It speaks of a card for the person, but none was made in this answer and none is
                // still open from before: some models describe the proposal instead of making it.
                // Once, it is told so and asked to make it (or to say plainly that it did not).
                if made.is_empty() && !nudged && claims_card(&text) && !self.any_open() {
                    nudged = true;
                    turns.push(Turn::Assistant { text, calls: vec![] });
                    turns.push(Turn::User(NO_CARD.into()));
                    continue;
                }
                turns.push(Turn::Assistant { text: text.clone(), calls: vec![] });
                self.keep(turns);
                return Ok(Reply { text, steps, proposals: made, choices: offered });
            }
            let mut results = Vec::new();
            for call in &reply.calls {
                let agent = (call.name == "agent_models").then(|| self::text(&call.arguments, "agent")).flatten();
                let step = Step { tool: call.name.clone(), label: label(call, office), agent };
                on_step(&step);
                steps.push(step);
                let out = match self.call(call, office).await {
                    Ok(Called::Text(t)) => t,
                    Ok(Called::Proposed(p)) => {
                        // i18n: model-facing
                        let text = format!("Proposal {} is on the user's screen as a card. Nothing has happened yet: it happens only if they click it. Tell them in one or two lines what you prepared.", p.id);
                        made.push(p);
                        text
                    }
                    Ok(Called::Offered(c)) => {
                        offered = Some(c);
                        // i18n: model-facing
                        "The options are on the user's screen as buttons under your answer; the one they click comes back as their next message. Ask the question in your answer in one line, without listing the options again.".to_string()
                    }
                    // i18n: model-facing
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
        let text = tr!(
            "這件事需要查的東西比較多,我先停在這裡。可以再說得具體一點,或請我接著查。",
            "This needs more looking up than I can do in one go, so I'll stop here. Tell me more precisely what you need, or ask me to carry on."
        );
        Ok(Reply { text, steps, proposals: made, choices: offered })
    }

    /// A card from earlier still waits for the person's click.
    fn any_open(&self) -> bool {
        self.proposals.lock().unwrap().iter().any(|p| p.state == "open")
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
        // i18n: model-facing
        let note = match state {
            "done" => format!("[Agent Center] The user confirmed {} ({}): {outcome}", p.id, p.title),
            "declined" => format!("[Agent Center] The user declined {} ({}).", p.id, p.title),
            _ => format!("[Agent Center] {} ({}) was confirmed but failed: {outcome}", p.id, p.title),
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
        let p = self.proposal(id).ok_or_else(|| -> String { tr!("這個提案已經不在了。", "That proposal is no longer there.") })?;
        if p.state != "open" {
            return Err(tr!("這個提案已經處理過了。", "That proposal was already dealt with."));
        }
        let uploads = self.uploads.lock().unwrap().clone();
        let done = match p.kind.as_str() {
            "team" => create_team(&p.payload, office, create_folder, &uploads).await,
            "knowledge" => add_knowledge(&p.payload, office, &uploads),
            "instruction" => instruct(&p.payload, office),
            "action" => act(&p.payload, office, create_folder).await,
            _ => Err(tr!("不明的提案。", "Unknown proposal.")),
        };
        match done {
            Ok(outcome) => {
                // Copied in: the attached files have done their part.
                for used in &p.uses {
                    self.upload_remove(used);
                }
                Ok(self.settle(id, "done", &outcome).unwrap())
            }
            Err(err) => {
                self.settle(id, "failed", &err);
                Err(err)
            }
        }
    }

    // i18n: model-facing
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
                let profile = office.choices.iter().find(|p| p.id == id || p.name == id).ok_or_else(|| format!("No agent '{id}'. Use list_agents."))?;
                let models = office.driver.models(profile).await?;
                Ok(Called::Text(models.iter().map(|m| m.id.clone()).collect::<Vec<_>>().join("\n")))
            }
            "propose_team" => self.propose_team(a, office).map(Called::Proposed),
            "offer_choices" => choices_of(a).map(Called::Offered),
            "propose_instruction" => self.propose_instruction(a, office).map(Called::Proposed),
            "propose_team_action" => self.propose_action(a, office).map(Called::Proposed),
            "propose_knowledge" => self.propose_knowledge(a, office).map(Called::Proposed),
            other => Err(format!("There is no tool '{other}'.")),
        }
    }

    fn add(&self, kind: &str, title: String, lines: Vec<String>, confirm: &str, payload: Value) -> Proposal {
        let mut all = self.proposals.lock().unwrap();
        let uses = payload["knowledge"].as_array().into_iter().flatten().filter_map(|k| k["upload"].as_str()).filter(|u| !u.is_empty()).map(str::to_string).collect();
        let picks = picks_of(&payload["config"]);
        let p = Proposal {
            id: format!("P-{}", all.len() + 1),
            kind: kind.into(),
            title,
            lines,
            confirm: confirm.into(),
            state: "open".into(),
            outcome: String::new(),
            uses,
            picks,
            payload,
        };
        all.push(p.clone());
        p
    }

    fn propose_team(&self, a: &Value, office: &Office) -> Result<Proposal, String> {
        let name = need(a, "name")?;
        let goal = need(a, "goal")?;
        let work_dir = work_dir_of(a, &name, &office.root)?;
        // i18n: model-facing
        let members = a.get("members").and_then(Value::as_array).filter(|m| !m.is_empty()).ok_or("members is required: at least one member.")?;
        if members.len() > 12 {
            // i18n: model-facing
            return Err("A team has at most 12 members.".into());
        }
        let library = office.member_skills();
        let mut list = Vec::new();
        for (i, m) in members.iter().enumerate() {
            let agent_given = need(m, "agent")?;
            let agent = office
                .choices
                .iter()
                .find(|p| p.id.eq_ignore_ascii_case(&agent_given) || p.name.eq_ignore_ascii_case(&agent_given))
                // i18n: model-facing
                .ok_or_else(|| format!("Member {}: there is no agent '{agent_given}'. Agents: {}.", i + 1, office.choices.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(", ")))?;
            let skills: Vec<String> = m.get("skills").and_then(Value::as_array).map(|s| s.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()).unwrap_or_default();
            if let Some(unknown) = skills.iter().find(|s| !library.iter().any(|l| l.name.eq_ignore_ascii_case(s))) {
                // i18n: model-facing
                return Err(format!("Member {}: there is no skill '{unknown}' in Agent Center's library. Skills: {}.", i + 1, if library.is_empty() { "none".to_string() } else { library.iter().map(|l| l.name.as_str()).collect::<Vec<_>>().join(", ") }));
            }
            // The agent's model is the user's setting (Agent Pool): a member keeps it. Another
            // model is only for an agent the user left without one, or when the user asked.
            let model = text(m, "model").map(|s| s.trim().to_string()).unwrap_or_default();
            let set = crate::acp::running_model(agent, &crate::acp::Launch::default());
            if !model.is_empty() && !set.is_empty() && !model.eq_ignore_ascii_case(&set) && !a.get("model_change_asked").and_then(Value::as_bool).unwrap_or(false) {
                // i18n: model-facing
                return Err(format!(
                    "Member {}: '{}' runs {set}, as the user set it in Agent Pool; leave `model` empty to keep it. For an independent review pick a different agent, not this agent on another model. If the user themselves asked for {model} on this member, call again with model_change_asked: true.",
                    i + 1, agent.name
                ));
            }
            list.push(json!({
                "id": format!("ai{}", i + 1),
                "name": text(m, "name").unwrap_or_else(|| format!("AI {}", i + 1)),
                "role": text(m, "role").unwrap_or_default(),
                "duty": text(m, "duty").unwrap_or_default(),
                "agent": agent.id,
                "model": model,
                "color": COLORS[i % COLORS.len()],
                "brief": text(m, "brief").unwrap_or_default(),
                "skills": skills,
            }));
        }
        let kickoff = text(a, "kickoff").unwrap_or_default();
        let leader_given = text(a, "leader").unwrap_or_default();
        let leader = list
            .iter()
            .find(|m| !leader_given.is_empty() && (m["name"].as_str() == Some(leader_given.as_str()) || m["id"].as_str() == Some(leader_given.as_str())))
            .unwrap_or(&list[0])["id"]
            .as_str()
            .unwrap_or("ai1")
            .to_string();
        let leads_as = list.iter().find(|m| m["id"].as_str() == Some(leader.as_str())).and_then(|m| m["agent"].as_str()).unwrap_or("");
        if office.choices.iter().any(|p| p.id == leads_as && p.protocol == crate::acp::Protocol::N8n) {
            // i18n: model-facing
            return Err("The leader cannot be an n8n workflow: it only takes a task and hands back a result. Make another member the leader.".into());
        }
        let scope: Vec<String> = a.get("scope").and_then(Value::as_array).map(|s| s.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        let start = a.get("start").and_then(Value::as_bool).unwrap_or(true);
        let items = self.knowledge_items(a)?;
        let from = match text(a, "knowledge_from") {
            Some(given) => {
                let (from_id, from_config) = find_team(office, &given)?;
                let count = office.teams.kb(&from_id).load().docs.len();
                Some((from_id, from_config.name, count))
            }
            None => None,
        };
        let fast = office.fast || a.get("fast").and_then(Value::as_bool).unwrap_or(false);
        let config = json!({
            "id": "draft",
            "name": name,
            "goal": goal,
            "scope": scope,
            "workDir": work_dir,
            "leader": leader,
            "autoApprove": true,
            "members": list,
            "kickoff": kickoff,
            "fast": fast,
        });
        let draft: TeamConfig = serde_json::from_value(config.clone()).map_err(|e| e.to_string())?;
        let mut lines: Vec<String> = vec![tr!(format!("目標:{goal}"), format!("Goal: {goal}"))];
        if !scope.is_empty() {
            lines.push(tr!(format!("範圍:{}", scope.join("、")), format!("Scope: {}", scope.join(", "))));
        }
        let note: String = match folder_state(&work_dir) {
            Folder::Ready => String::new(),
            Folder::Missing => tr!("(還不存在,按下後會先問你要不要建立)", " (doesn't exist yet: you'll be asked whether to create it when you confirm)"),
            Folder::Blocked(why) => tr!(format!("({why})"), format!(" ({why})")),
        };
        lines.push(tr!(format!("工作資料夾:{work_dir}{note}"), format!("Work folder: {work_dir}{note}")));
        lines.extend(knowledge_lines(&items, from.as_ref().map(|(_, name, n)| (name.as_str(), *n))));
        let head = lines.clone();
        lines.extend(member_lines(&draft));
        let mut tail: Vec<String> = Vec::new();
        if !draft.kickoff.trim().is_empty() {
            tail.push(tr!(format!("開局指示:{}", cut(draft.kickoff.trim(), 240)), format!("Kickoff: {}", cut(draft.kickoff.trim(), 240))));
        }
        if draft.fast {
            tail.push(tr!("快速模式:最小團隊、一次審查、不來回", "Fast mode: the smallest team, one review, no second round"));
        }
        lines.extend(tail.iter().cloned());
        let confirm: &str = if start { tr!("建立並啟動", "Create and start") } else { tr!("建立團隊", "Create team") };
        let knowledge = serde_json::to_value(&items).map_err(|e| e.to_string())?;
        let from = from.map(|(id, _, _)| id).unwrap_or_default();
        let title: String = tr!(format!("新團隊「{}」", draft.name), format!("New team \"{}\"", draft.name));
        // The card's lines around the members are kept so the members can be changed by hand (revise_team).
        Ok(self.add("team", title, lines, confirm, json!({ "config": config, "start": start, "knowledge": knowledge, "knowledgeFrom": from, "linesHead": head, "linesTail": tail })))
    }

    /// The person changed a proposed team's members by hand (the picker on the card):
    /// `members` are `{agent, name, role, leader}` in their order. A member kept from
    /// Agent Center's pick (same agent and name) keeps its duty, model, brief and
    /// skills; a new one runs its agent as set in Agent Pool. The card is redrawn,
    /// and Agent Center is told, so its next proposal follows the person's taste.
    pub fn revise_team(&self, id: &str, members: &[Value], office: &Office) -> Result<Proposal, String> {
        let mut all = self.proposals.lock().unwrap();
        let p = all.iter_mut().find(|p| p.id == id).ok_or_else(|| -> String { tr!("沒有這張提案卡。", "There is no such proposal.") })?;
        if p.kind != "team" || p.state != "open" {
            return Err(tr!("這張卡已經不能改了。", "This card can no longer be changed."));
        }
        if members.is_empty() {
            return Err(tr!("至少要留一位成員。", "Keep at least one member."));
        }
        if members.len() > 12 {
            return Err(tr!("一個團隊最多 12 位成員。", "A team has at most 12 members."));
        }
        let old: Vec<Value> = p.payload["config"]["members"].as_array().cloned().unwrap_or_default();
        let mut list = Vec::new();
        let mut leader = String::new();
        for (i, m) in members.iter().enumerate() {
            let given = s(m, "agent");
            let agent = office
                .choices
                .iter()
                .find(|c| c.id.eq_ignore_ascii_case(given) || c.name.eq_ignore_ascii_case(given))
                .ok_or_else(|| -> String { tr!(format!("Agent Pool 裡沒有「{given}」。"), format!("There is no \"{given}\" in Agent Pool.")) })?;
            let name = text(m, "name").unwrap_or_else(|| agent.name.clone());
            let kept = old
                .iter()
                .find(|o| o["agent"].as_str() == Some(agent.id.as_str()) && o["name"].as_str() == Some(name.as_str()))
                .or_else(|| old.iter().find(|o| o["agent"].as_str() == Some(agent.id.as_str())))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let id = format!("ai{}", i + 1);
            if leader.is_empty() && m.get("leader").and_then(Value::as_bool).unwrap_or(false) {
                leader = id.clone();
            }
            list.push(json!({
                "id": id,
                "name": name,
                "role": text(m, "role").or_else(|| text(&kept, "role")).unwrap_or_default(),
                "duty": text(&kept, "duty").unwrap_or_default(),
                "agent": agent.id,
                "model": text(&kept, "model").unwrap_or_default(),
                "color": COLORS[i % COLORS.len()],
                "brief": text(&kept, "brief").unwrap_or_default(),
                "skills": kept.get("skills").cloned().unwrap_or_else(|| json!([])),
            }));
        }
        if leader.is_empty() {
            leader = "ai1".into();
        }
        let leads_as = list.iter().find(|m| m["id"].as_str() == Some(leader.as_str())).and_then(|m| m["agent"].as_str()).unwrap_or("");
        if office.choices.iter().any(|c| c.id == leads_as && c.protocol == crate::acp::Protocol::N8n) {
            return Err(tr!("n8n 工作流程不能當 Leader:它只接任務、交結果。請換一位當 Leader。", "An n8n workflow cannot be the leader: it only takes a task and hands back a result. Pick another leader."));
        }
        p.payload["config"]["members"] = Value::Array(list);
        p.payload["config"]["leader"] = Value::String(leader);
        let draft: TeamConfig = serde_json::from_value(p.payload["config"].clone()).map_err(|e| e.to_string())?;
        let strings = |v: &Value| v.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>();
        let mut lines = strings(&p.payload["linesHead"]);
        lines.extend(member_lines(&draft));
        lines.extend(strings(&p.payload["linesTail"]));
        p.lines = lines;
        p.picks = picks_of(&p.payload["config"]);
        let who: Vec<String> = draft.members.iter().map(|m| format!("{}{} ({}, {})", m.name, if m.id == draft.leader { " [leader]" } else { "" }, m.agent, if m.role.is_empty() { "-" } else { &m.role })).collect();
        // i18n: model-facing
        self.notes.lock().unwrap().push(format!("[Agent Center] The user changed the members of {} ({}) by hand; it is now: {}. Follow this taste in later proposals.", p.id, p.title, who.join("; ")));
        Ok(p.clone())
    }

    /// The documents a proposal names, checked now so the card is honest:
    /// attached files of this conversation, or full paths the person wrote.
    /// Its errors are the model's to read (a propose_* tool's result).
    // i18n: model-facing
    fn knowledge_items(&self, a: &Value) -> Result<Vec<Item>, String> {
        let Some(list) = a.get("knowledge").and_then(Value::as_array) else { return Ok(Vec::new()) };
        let uploads = self.uploads.lock().unwrap();
        let attached = || {
            let ids: Vec<&str> = uploads.values().filter(|u| u.ready()).map(|u| u.id.as_str()).collect();
            if ids.is_empty() { "none".to_string() } else { ids.join(", ") }
        };
        let mut out = Vec::new();
        for (i, k) in list.iter().enumerate() {
            let n = i + 1;
            let visibility = if text(k, "visibility").as_deref() == Some("shared") { Visibility::Shared } else { Visibility::Leader };
            let item = match (text(k, "upload"), text(k, "path")) {
                (Some(id), None) => {
                    let u = uploads.get(&id).filter(|u| u.ready()).ok_or_else(|| format!("Document {n}: there is no attached file '{id}'. Attached: {}.", attached()))?;
                    Item { upload: id, path: String::new(), name: u.name.clone(), visibility, bytes: u.bytes, key_like: u.key_like.is_some() }
                }
                (None, Some(path)) => {
                    if !Path::new(&path).is_absolute() {
                        return Err(format!("Document {n}: '{path}' is not a full path. Use only paths the user wrote in full, or files they attached."));
                    }
                    let (name, bytes) = knowledge::read_source(Path::new(&path))?;
                    let (kind, kept) = knowledge::classify(bytes);
                    let key_like = kind == DocKind::Text && knowledge::find_key_like(&String::from_utf8_lossy(&kept)).is_some();
                    Item { upload: String::new(), path, name, visibility, bytes: kept.len() as u64, key_like }
                }
                _ => return Err(format!("Document {n}: give either upload (an attached file's id) or path.")),
            };
            out.push(item);
        }
        if out.len() > knowledge::MAX_DOCS {
            return Err(format!("A team keeps at most {} documents.", knowledge::MAX_DOCS));
        }
        if out.iter().map(|d| d.bytes).sum::<u64>() > knowledge::MAX_TOTAL {
            return Err(format!("The documents come to more than {} MB.", knowledge::MAX_TOTAL / 1024 / 1024));
        }
        Ok(out)
    }

    /// Documents for a team that already exists.
    fn propose_knowledge(&self, a: &Value, office: &Office) -> Result<Proposal, String> {
        let (id, config) = find_team(office, &need(a, "team")?)?;
        let items = self.knowledge_items(a)?;
        if items.is_empty() {
            // i18n: model-facing
            return Err("knowledge is required: at least one document (an attached file or a full path).".into());
        }
        let mut lines = knowledge_lines(&items, None);
        if office.teams.is_live(&id) {
            lines.push(tr!(
                "團隊執行中:加入後會通知 Leader;共享的文件也會通知其他成員。",
                "The team is running: the leader is told once they are added, and the other members hear of the shared ones."
            ));
        }
        let knowledge = serde_json::to_value(&items).map_err(|e| e.to_string())?;
        let title: String = tr!(format!("加入「{}」的知識庫", config.name), format!("Add to the knowledge base of \"{}\"", config.name));
        Ok(self.add("knowledge", title, lines, tr!("加入知識庫", "Add to knowledge base"), json!({ "team": id, "knowledge": knowledge })))
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
                // i18n: model-facing
                .ok_or_else(|| format!("'{to_given}' is not a member of {}.", config.name))?
        };
        let who = if to.is_empty() {
            config.members.iter().find(|m| m.id == config.leader).map(|m| -> String { tr!(format!("{}(Leader)", m.name), format!("{} (Leader)", m.name)) }).unwrap_or("Leader".into())
        } else {
            config.members.iter().find(|m| m.id == to).map(|m| m.name.clone()).unwrap_or(to.clone())
        };
        let finished = office.teams.is_finished(&id);
        let mut lines: Vec<String> = vec![tr!(format!("給:{who}"), format!("To: {who}")), tr!(format!("內容:{words}"), format!("Message: {words}"))];
        if finished {
            lines.push(tr!("這個團隊已完成;送出後會重新開始工作。", "This team has finished; sending this starts it working again."));
        }
        let title: String = tr!(format!("給「{}」的指令", config.name), format!("Instruction for \"{}\"", config.name));
        Ok(self.add("instruction", title, lines, tr!("送出指令", "Send instruction"), json!({ "team": id, "to": to, "text": words })))
    }

    fn propose_action(&self, a: &Value, office: &Office) -> Result<Proposal, String> {
        let (id, config) = find_team(office, &need(a, "team")?)?;
        let action = need(a, "action")?.to_lowercase();
        let (title, line): (&str, &str) = match action.as_str() {
            "start" => (tr!("啟動", "Start"), tr!("從頭開始執行這個團隊(之前的紀錄會保留)。", "Runs this team from the start (its earlier record is kept).")),
            "pause" => (tr!("暫停", "Pause"), tr!("不再開始新的回合;正在做的會做完。", "No new turns start; the ones under way finish.")),
            "resume" => (tr!("繼續", "Resume"), tr!("從暫停或中斷的地方接著做。", "Carries on from where it was paused or interrupted.")),
            "stop" => (tr!("立刻停下", "Stop now"), tr!("暫停並中斷所有正在進行的回合。", "Pauses and interrupts every turn under way.")),
            "archive" => (tr!("封存", "Archive"), tr!("收起來,不再顯示在團隊清單和公司總覽(不會刪除)。", "Puts it away: it no longer shows in the team list or the company overview (nothing is deleted).")),
            "unarchive" => (tr!("取消封存", "Unarchive"), tr!("放回團隊清單和公司總覽。", "Puts it back in the team list and the company overview.")),
            // i18n: model-facing
            other => return Err(format!("Unknown action '{other}'. Use start, pause, resume, stop, archive or unarchive.")),
        };
        let heading: String = tr!(format!("{title}「{}」", config.name), format!("{title} \"{}\"", config.name));
        Ok(self.add("action", heading, vec![line.to_string()], title, json!({ "team": id, "action": action })))
    }
}

enum Called {
    Text(String),
    Proposed(Proposal),
    Offered(Choices),
}

/// The card's lines about a knowledge base: each document and who may read
/// it, and the team whose documents come along.
fn knowledge_lines(items: &[Item], from: Option<(&str, usize)>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some((name, count)) = from {
        out.push(tr!(format!("知識庫:沿用「{name}」的 {count} 份文件"), format!("Knowledge base: starts with the {count} document(s) of \"{name}\"")));
    }
    if !items.is_empty() {
        let docs: Vec<String> = items
            .iter()
            .map(|d| -> String {
                let who: &str = if d.visibility == Visibility::Shared { tr!("團隊共享", "shared with the team") } else { tr!("只有 Leader", "leader only") };
                let key: &str = if d.key_like { tr!(" ⚠ 疑似含金鑰", ", ⚠ may hold a key") } else { "" };
                tr!(format!("{}({who}{key})", d.name), format!("{} ({who}{key})", d.name))
            })
            .collect();
        out.push(tr!(format!("知識庫:{}", docs.join("、")), format!("Knowledge base: {}", docs.join(", "))));
    }
    out
}

/// Copies a proposal's documents into a knowledge base: attached files from
/// the uploads folder, paths from where they are. Each goes in or says why
/// not; a text found to hold a key by its path is left out (an attached one
/// the person already kept). Returns the documents added and what failed.
fn fill_knowledge(kb: &Kb, items: &[Item], uploads: &BTreeMap<String, Upload>) -> (Vec<String>, Vec<String>) {
    let mut added = Vec::new();
    let mut failed = Vec::new();
    for item in items {
        let got = if item.upload.is_empty() {
            knowledge::read_source(Path::new(&item.path)).map(|(_, bytes)| (bytes, item.path.clone(), false))
        } else {
            match uploads.get(&item.upload) {
                Some(u) => std::fs::read(&u.file).map(|bytes| (bytes, u.origin.clone(), u.force)).map_err(|e| -> String { tr!(format!("無法讀取 {}:{e}", u.name), format!("Could not read {}: {e}", u.name)) }),
                None => Err(tr!("附加的檔案已經不在了", "the attached file is no longer there")),
            }
        };
        let (bytes, source, force) = match got {
            Ok(x) => x,
            Err(err) => {
                failed.push(tr!(format!("{}:{err}", item.name), format!("{}: {err}", item.name)));
                continue;
            }
        };
        match kb.add(&item.name, bytes, &source, force) {
            Ok(knowledge::Added { doc: Some(doc), .. }) => {
                if item.visibility == Visibility::Shared {
                    if let Err(err) = kb.update(&doc.id, Some(Visibility::Shared), None) {
                        failed.push(tr!(format!("{}:沒能設成團隊共享({err})", item.name), format!("{}: could not be shared with the team ({err})", item.name)));
                    }
                }
                added.push(doc.id);
            }
            Ok(_) => failed.push(tr!(
                format!("{} 看起來含有金鑰,沒有加入;請在團隊設定裡確認後手動加入", item.name),
                format!("{} looks like it holds a key, so it was not added; check it in the team's setup and add it there yourself", item.name)
            )),
            Err(err) => failed.push(tr!(format!("{}:{err}", item.name), format!("{}: {err}", item.name))),
        }
    }
    (added, failed)
}

fn items_of(payload: &Value) -> Vec<Item> {
    serde_json::from_value(payload["knowledge"].clone()).unwrap_or_default()
}

/// What happened to the documents, for the card and the model.
fn knowledge_outcome(added: usize, failed: &[String]) -> String {
    let mut out: String = if added > 0 { tr!(format!("已有 {added} 份文件放進它的知識庫"), format!("{added} document(s) were put in its knowledge base")) } else { String::new() };
    if !failed.is_empty() {
        if !out.is_empty() {
            out.push_str(tr!(";", "; "));
        }
        let not_added: String = tr!(format!("沒有加入:{}", failed.join(";")), format!("not added: {}", failed.join("; ")));
        out.push_str(&not_added);
    }
    out
}

/// A confirmed propose_knowledge: the documents go in, and a running team
/// hears of them as if the person had added them in its setup.
fn add_knowledge(payload: &Value, office: &Office, uploads: &BTreeMap<String, Upload>) -> Result<String, String> {
    let team = s(payload, "team");
    if !crate::team::is_plain_id(team) {
        return Err(tr!("沒有這個團隊。", "There is no such team."));
    }
    let (added, failed) = fill_knowledge(&office.teams.kb(team), &items_of(payload), uploads);
    for doc in &added {
        office.teams.knowledge_changed(team, KnowledgeChange::Added { doc: doc.clone() });
    }
    crate::log::line(format!("secretary: {} document(s) added to team {team}'s knowledge base, {} not", added.len(), failed.len()));
    if added.is_empty() {
        return Err(knowledge_outcome(0, &failed));
    }
    Ok(knowledge_outcome(added.len(), &failed))
}

// i18n: model-facing
fn need(a: &Value, key: &str) -> Result<String, String> {
    text(a, key).ok_or_else(|| format!("'{key}' is required."))
}

fn text(a: &Value, key: &str) -> Option<String> {
    a.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

// i18n: model-facing
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
// i18n: model-facing
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

/// Where a proposed team works: `work_dir` as given when it is a full path; otherwise,
/// with a root folder set, a subfolder of the root (the given name, or the team's).
/// Without a root, a full path is required and the user is to be asked for it.
// i18n: model-facing
fn work_dir_of(a: &Value, team_name: &str, root: &str) -> Result<String, String> {
    let given = text(a, "work_dir").unwrap_or_default();
    if std::path::Path::new(&given).is_absolute() {
        return Ok(given);
    }
    let root = root.trim();
    if root.is_empty() || !std::path::Path::new(root).is_absolute() {
        return Err("work_dir must be a full path such as D:\\Code\\my-site (no root folder is set in your settings). Ask the user where the team should work if you do not know.".into());
    }
    let sub = folder_name(if given.is_empty() { team_name } else { &given });
    Ok(std::path::Path::new(root).join(sub).to_string_lossy().to_string())
}

/// A folder name Windows takes, from a team's name: no `<>:"/\|?*`, no control
/// characters, no trailing dots or spaces; `team` when nothing is left.
fn folder_name(name: &str) -> String {
    let cleaned: String = name.trim().chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && !c.is_control()).collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).trim().to_string();
    if cleaned.is_empty() { "team".into() } else { cleaned.chars().take(60).collect() }
}

/// A team card's member lines: one per member, the leader marked.
fn member_lines(draft: &TeamConfig) -> Vec<String> {
    draft
        .members
        .iter()
        .map(|m| {
            let model: String = if m.model.trim().is_empty() { tr!("代理預設", "agent default") } else { m.model.clone() };
            let lead: &str = if m.id == draft.leader { tr!("(Leader)", " (Leader)") } else { "" };
            let skills: String = if m.skills.is_empty() { String::new() } else { tr!(format!(" · skill:{}", m.skills.join("、")), format!(" · skills: {}", m.skills.join(", "))) };
            format!("{}{lead} · {} · {} / {}{}{skills}", m.name, if m.role.is_empty() { "—" } else { &m.role }, m.agent, model, if m.duty.is_empty() { String::new() } else { format!(" — {}", m.duty) })
        })
        .collect()
}

/// A proposed team's members as Agent Pool picks, from its config.
fn picks_of(config: &Value) -> Vec<Pick> {
    config["members"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| Pick {
            agent: s(m, "agent").to_string(),
            name: s(m, "name").to_string(),
            role: s(m, "role").to_string(),
            leader: m["id"] == config["leader"],
        })
        .collect()
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn n(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

// i18n: model-facing
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

// i18n: model-facing
fn team_detail(office: &Office, given: &str) -> Result<String, String> {
    let (id, c) = find_team(office, given)?;
    let mut out = vec![
        format!("Team {} (id {}). Goal: {}", c.name, id, c.goal),
        format!("Work folder: {}. Leader: {}.", c.work_dir, c.leader),
    ];
    // Its knowledge base by name and who may read each: never what is in them.
    let docs = office.teams.kb(&id).load().docs;
    if !docs.is_empty() {
        let list: Vec<String> = docs.iter().map(|d| format!("{} ({})", d.name, if d.visibility == Visibility::Shared { "shared" } else { "leader only" })).collect();
        out.push(format!("Knowledge base: {}.", list.join(", ")));
    }
    let Some(p) = picture(office, &id) else {
        out.push("Never started. Members:".into());
        for m in &c.members {
            out.push(format!("- {} ({}): {}, agent {} model {}", m.name, m.id, m.role, agent_label(office, &m.agent), if m.model.is_empty() { "default" } else { &m.model }));
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
        let mut line = format!("- {} ({}){}: {}, agent {} model {}, status {}, {} turn(s), {} tokens", s(m, "name"), s(m, "id"), if m["isLeader"].as_bool() == Some(true) { " leader" } else { "" }, s(m, "role"), agent_label(office, s(m, "agent")), if s(m, "model").is_empty() { "default" } else { s(m, "model") }, s(m, "status"), n(m, "turns"), tokens);
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

// i18n: model-facing
fn team_messages(office: &Office, given: &str, limit: usize) -> Result<String, String> {
    let (id, c) = find_team(office, given)?;
    let p = picture(office, &id).ok_or_else(|| format!("{} has never run.", c.name))?;
    let all: Vec<&Value> = p["messages"].as_array().map(|m| m.iter().collect()).unwrap_or_default();
    let from = all.len().saturating_sub(limit.clamp(1, 60));
    let lines: Vec<String> = all[from..].iter().map(|m| format!("[{}] {} → {}: {}", when(n(m, "at"), office.tz_minutes), s(m, "from"), s(m, "to"), cut(s(m, "text"), 600))).collect();
    Ok(if lines.is_empty() { "No messages yet.".into() } else { lines.join("\n") })
}

/// [from, to) in ms and its name, for a period word, on the person's clock.
// i18n: model-facing
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
// i18n: model-facing
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

// i18n: model-facing
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

/// A member's agent as the user knows it: a team agent by its name (its id is Coucou's own).
// i18n: model-facing
fn agent_label(office: &Office, id: &str) -> String {
    match office.agents.iter().find(|p| p.id == id && p.extras.is_some()) {
        Some(p) => format!("{} (team agent {id})", p.name),
        None => id.to_string(),
    }
}

// i18n: model-facing
fn list_agents(office: &Office) -> String {
    if office.choices.is_empty() {
        return "There are no team agents yet. Teams are built from team agents only: ask the user to add some in Teamwork → Agent Pool (each is built on a Cloud Agent or Local Agent from Settings → Agent Provider).".into();
    }
    // What each one really costs: its model's price (the same list as Teamwork → 成本與用量) and what it spent lately.
    let choices = crate::pricing::load_choices();
    let table = crate::pricing::cached_table();
    let now = crate::team::store::now_ms();
    let report = crate::cost::report(&settings::team_logs_dir(), now.saturating_sub(30 * 86_400_000), now + 86_400_000);
    let mut spent: BTreeMap<String, (u64, f64)> = BTreeMap::new();
    for r in &report.rows {
        let e = spent.entry(r.agent.clone()).or_default();
        e.0 += r.usage.input + r.usage.output + r.usage.cache_read + r.usage.cache_write;
        e.1 += r.estimated_usd.unwrap_or(0.0);
    }
    let lines: Vec<String> = office
        .choices
        .iter()
        .map(|p| {
            let endpoint = p.env.get("COPILOT_PROVIDER_BASE_URL").filter(|b| b.starts_with("http")).map(|b| format!(", own endpoint {b}")).unwrap_or_default();
            let model = crate::acp::running_model(p, &crate::acp::Launch::default());
            let own = crate::team_agents::describe(p).map(|d| format!(" — {d}")).unwrap_or_default();
            let base = p.extras.as_ref().map(|x| x.base.as_str()).unwrap_or(&p.id);
            let plan = [p.id.as_str(), base].iter().any(|id| choices.billing.get(*id).is_some_and(|b| b == "subscription"));
            let found = (!model.is_empty()).then(|| crate::pricing::lookup(&model, &choices, &table)).flatten();
            let cost = cost_note(p.location(), &model, found.as_ref(), plan, spent.get(&p.id).copied());
            let can = crate::caps::describe(&crate::caps::of(p, &choices, &table, None));
            format!("- {} (id {}): {:?}, default model {}{}{own}; can: {can}; {cost}", p.name, p.id, p.protocol, if model.is_empty() { "the agent's own" } else { &model }, endpoint)
        })
        .collect();
    format!(
        "The user's team agents (build new teams only from these; pick each member by what its description says it is good for; a Local Agent keeps the work on the user's own machine or network, a Cloud Agent sends it to a cloud service; an n8n workflow is never the leader). Prices are US dollars per million tokens, from the same price list as the cost page:\n{}",
        lines.join("\n")
    )
}

/// What an agent costs, for comparing them: its model's price and where it came from, a plan
/// that is not billed per token, and what it spent in the last 30 days.
// i18n: model-facing
fn cost_note(place: crate::acp::Location, model: &str, found: Option<&crate::pricing::Found>, plan: bool, spent: Option<(u64, f64)>) -> String {
    let mut out = match found {
        Some(f) => {
            let from = match f.source.as_str() {
                "override" => "the user's own price",
                "proxy" => "its endpoint's price",
                _ => "the public price list",
            };
            format!("price input ${} / output ${} / cache read ${} ({from})", f.price.input, f.price.output, f.price.cache_read)
        }
        None if model.is_empty() => "price unknown: it uses whatever model the agent picks".to_string(),
        None if place == crate::acp::Location::Local => "no price known: a local model is usually not charged per token".to_string(),
        None => "no price known for its model (the user can add one in 成本與用量 → 價格表)".to_string(),
    };
    if plan {
        out.push_str("; on a subscription plan: no extra charge per token, the price above is only its API equivalent");
    }
    match spent {
        Some((tokens, usd)) if tokens > 0 => out.push_str(&format!("; spent in the last 30 days: {tokens} tokens, about ${usd:.2}")),
        _ => out.push_str("; not used in the last 30 days"),
    }
    out
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
        Ok(_) => Folder::Blocked(tr!(format!("{dir} 是一個檔案,不是資料夾,請換一個資料夾路徑。"), format!("{dir} is a file, not a folder. Choose another folder path."))),
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
        Folder::Missing if !create => Err(tr!(
            format!("工作資料夾 {dir} 不存在。沒有建立資料夾,團隊也沒有開。"),
            format!("The work folder {dir} does not exist. No folder was created and the team was not started.")
        )),
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
            tr!(
                format!("Windows 拒絕存取:你的帳號沒有權限在 {parent} 底下建立資料夾,所以沒有建立 {dir}。請換一個你能寫入的位置(例如 D:\\Code 底下),或先在檔案總管自己建立好再試。"),
                format!("Windows denied access: your account may not create folders in {parent}, so {dir} was not created. Choose a place you can write to (under D:\\Code, say), or create the folder yourself in File Explorer and try again.")
            )
        }
        ErrorKind::PermissionDenied => tr!(
            format!("Windows 拒絕存取 {dir}:這個資料夾存在,但你的帳號沒有權限使用它。請換一個資料夾,或在資料夾的「內容 → 安全性」給自己讀寫權限。"),
            format!("Windows denied access to {dir}: the folder is there, but your account may not use it. Choose another folder, or give yourself read and write permission in the folder's Properties → Security.")
        ),
        ErrorKind::NotFound if creating => {
            let root = path.ancestors().last().map(|a| a.display().to_string()).unwrap_or_default();
            tr!(
                format!("無法建立 {dir}:{root} 不存在或目前無法使用(例如磁碟沒有接上)。"),
                format!("Could not create {dir}: {root} does not exist or cannot be used right now (a drive that is not plugged in, say).")
            )
        }
        _ if creating => tr!(format!("無法建立資料夾 {dir}:{e}"), format!("Could not create the folder {dir}: {e}")),
        _ => tr!(format!("無法使用資料夾 {dir}:{e}"), format!("Could not use the folder {dir}: {e}")),
    }
}

async fn create_team(payload: &Value, office: &Office, create_folder: bool, uploads: &BTreeMap<String, Upload>) -> Result<String, String> {
    let dir = settings::team_configs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = (1..1000)
        .map(|n| if n == 1 { "team".to_string() } else { format!("team-{n}") })
        .find(|id| !dir.join(format!("{id}.json")).exists())
        .ok_or_else(|| -> String { tr!("團隊檔案太多了。", "There are too many team files.") })?;
    let mut config: TeamConfig = serde_json::from_value(payload["config"].clone()).map_err(|e| e.to_string())?;
    config.id = id.clone();
    ensure_folder(&config.work_dir, create_folder)?;
    let known: Vec<String> = office.agents.iter().map(|a| a.id.clone()).collect();
    let problems = config.problems(&known);
    if !problems.is_empty() {
        return Err(problems.join(" "));
    }
    let file = format!("{id}.json");
    std::fs::write(dir.join(&file), serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| -> String { tr!(format!("無法儲存 {file}:{e}"), format!("Could not save {file}: {e}")) })?;
    crate::log::line(format!("secretary: created team {id}"));
    // Its documents, before it starts: the members hear of them in their opening words.
    let kb = office.teams.kb(&id);
    let mut docs = String::new();
    let from = s(payload, "knowledgeFrom");
    if crate::team::is_plain_id(from) {
        match office.teams.kb(from).copy_to(&kb) {
            Ok(n) => {
                let line: String = tr!(format!(";從團隊 {from} 複製了 {n} 份文件"), format!("; {n} document(s) were copied from team {from}"));
                docs.push_str(&line);
            }
            Err(err) => {
                let line: String = tr!(format!(";團隊 {from} 的文件沒有複製:{err}"), format!("; the documents of team {from} were not copied: {err}"));
                docs.push_str(&line);
            }
        }
    }
    let (added, failed) = fill_knowledge(&kb, &items_of(payload), uploads);
    let more = knowledge_outcome(added.len(), &failed);
    if !more.is_empty() {
        docs.push_str(tr!(";", "; "));
        docs.push_str(&more);
    }
    if payload["start"].as_bool() == Some(true) {
        start(&config, office)?;
        Ok(tr!(format!("已建立並啟動團隊 {}(id {id}){docs}", config.name), format!("team {} (id {id}) was created and started{docs}", config.name)))
    } else {
        Ok(tr!(format!("已建立團隊 {}(id {id}),尚未啟動{docs}", config.name), format!("team {} (id {id}) was created, not started{docs}", config.name)))
    }
}

fn start(config: &TeamConfig, office: &Office) -> Result<(), String> {
    if !settings::team_mcp_exe_path().is_file() {
        return Err(tr!(
            "Agent Center 的 bin 資料夾裡少了 coucou-team-mcp.exe,成員沒辦法回報。請重新安裝或重新建置 Agent Center。",
            "coucou-team-mcp.exe is missing from Agent Center's bin folder, so members could not report. Reinstall or rebuild Agent Center."
        ));
    }
    office.teams.start(config.clone(), &office.agents).map(|_| ())
}

fn instruct(payload: &Value, office: &Office) -> Result<String, String> {
    let team = s(payload, "team");
    let to = s(payload, "to");
    let words = s(payload, "text");
    if office.teams.is_finished(team) {
        let wanted = crate::read_team_file(&format!("{team}.json")).ok();
        office.teams.reopen(team, to, words, None, &office.agents, wanted.as_ref())?;
        return Ok(tr!("指令已送出,已完成的團隊重新開始工作", "the instruction was sent and the finished team started again"));
    }
    office.teams.instruct(team, to, words, None).map(|_| tr!("指令已送出", "the instruction was sent"))
}

async fn act(payload: &Value, office: &Office, create_folder: bool) -> Result<String, String> {
    let team = s(payload, "team");
    match s(payload, "action") {
        "start" => {
            let config = crate::read_team_file(&format!("{team}.json"))?;
            ensure_folder(&config.work_dir, create_folder)?;
            start(&config, office)?;
            Ok(tr!("團隊已啟動", "the team was started"))
        }
        "pause" => office.teams.pause(team).map(|_| tr!("團隊已暫停", "the team was paused")),
        "resume" => office.teams.resume(team, &office.agents).map(|_| tr!("團隊繼續工作", "the team carries on")),
        "stop" => office.teams.interrupt(team).await.map(|_| tr!("團隊已停下", "the team was stopped")),
        "archive" | "unarchive" => {
            let archived = s(payload, "action") == "archive";
            let file = format!("{team}.json");
            let path = crate::team_file_path(&file)?;
            let mut config = crate::read_team_file(&file)?;
            if archived && office.teams.is_live(&config.id) {
                return Err(tr!("這個團隊正在執行,請先停下再封存。", "This team is running. Stop it before putting it away."));
            }
            config.archived = archived;
            std::fs::write(path, serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            Ok(if archived { tr!("團隊已封存", "the team was archived") } else { tr!("團隊已取消封存", "the team was taken out of the archive") })
        }
        other => Err(tr!(format!("不明的操作「{other}」。"), format!("Unknown action '{other}'."))),
    }
}

// ── What the model is told ───────────────────────────────────────────────────

// i18n: model-facing
fn system_prompt(office: &Office) -> String {
    format!(
        "{}You are Agent Center, the assistant that runs the user's company of AI agents in a Windows app. The company is made of teams: each has a goal, a work folder and AI members (each runs an agent such as Codex, Claude Code, Copilot or Antigravity, with a model); a leader member plans tasks, hands them out and reviews them. The user calls on you when they need you: to find out how the teams are doing, what is stuck or waiting for them, what it cost, or to get something done.\n\
\n\
How you work:\n\
- Look things up with your tools before you answer; never guess a team's state. Quote names, numbers and times as the tools give them.\n\
- You cannot change anything yourself. To get something done (a new team, an instruction to a team, starting, pausing, resuming, stopping or archiving a team) you prepare it with a propose_* tool: it appears on the user's screen as a card, and it happens only if they click it. Never say something was done unless a [Agent Center] note says the user confirmed it. Never say a card or a button is ready unless a propose_* tool told you in this answer that it is on the user's screen: when the user wants a team, call propose_team; describing the team in words is not enough.\n\
- Prefer one proposal that does what was asked. Ask a short question first only when something essential is missing, such as the work folder for a new team when no root folder is set.{}\n\
- When you ask the user to choose between options, call offer_choices with them so they can click one, instead of listing them as text.\n\
- For a new team: pick agents from list_agents; each runs the model the user set on it (shown in list_agents), so leave `model` empty unless the agent has none (then agent_models lists what it offers) or the user asked for another. Independent review means a different agent, never the same agent on another model. Give the leader the agent with the strongest model; give each member a short role (2-6 characters) and a one-line duty; keep the team small (2-5 members) unless asked.{}\n\
- Size the request before you shape the team (quick: the leader alone; medium: one does, one on another model reviews once; large: split by scope), and say which size in `kickoff`; your skills below, when you have them, say how in detail. Every coding CLI agent (Claude Code, Codex, Gemini CLI, Copilot, Antigravity) browses the web and runs code through its own tools, and its `can:` line says so; only an n8n workflow cannot. Never tell the user the agents cannot go online unless no agent's `can:` line says it browses. Pick an agent for images only when its `can:` line says it makes them.\n\
- In `kickoff` tell the leader: the size, the split, who reviews what (so reviews are not all on the leader), the first batch each member delivers, and the rules of the work (sources, formats, what counts as done). Give a member its own rules in `brief`. Members read messages only when a turn starts, so rules belong in the tasks and briefs, not in later messages.{}\n\
{}- A team has a knowledge base: documents (design notes, specs, pictures, any file) its members work from. When the user attaches files or mentions design documents, specs or reference material for a team, put them in `knowledge` (propose_team for a new team, propose_knowledge for one that exists): attached files by their id (u…), or full paths the user wrote — never a path you guessed. Each is for the leader only unless the user says the whole team should see it (then visibility \"shared\"). You only see the files' names, never what is in them.\n\
- Answer in the language named on the last line of this prompt, short and concrete: a few lines or a short list. Point out anything waiting for the user (permission cards, questions) first.\n\
\n\
Now: {} (the user's local time).\n\
{}{}",
        // The window's name for an assistant the person has not named, in either language (秘書 / Secretary from earlier versions).
        match office.name.trim() {
            "" | "秘書" | "Secretary" | "Agent Center" => String::new(),
            name => format!("Your name is {name}; the user calls you that, and you may call yourself that. "),
        },
        root_line(&office.root),
        " The user builds teams from their own team agents only: list_agents lists them with what each is good for, whether it is a Cloud Agent or a Local Agent, and what it costs; choose members by those descriptions, and never name an agent that is not listed. When the user wants it cheap, on a budget, or asks which costs less (or wants the best whatever it costs), compare the agents by the prices and recent spend list_agents gives, not only by what their descriptions say, and tell the user the prices you compared; a description is the user's own note, the price is the fact, so when they disagree say so. An agent on a subscription plan costs nothing extra per token. When you talk to the user, call a team agent by its name, never by its id (ta-…).",
        library_line(office),
        fast_line(office.fast),
        when(crate::team::store::now_ms(), office.tz_minutes),
        format!("{}{}", center_skills(&office.skills), own_instructions(&office.instructions)),
        crate::i18n::reply_language(),
    )
}

/// The root folder from Agent Center's ⚙, for the prompt: where a team goes when the user names no folder.
// i18n: model-facing
fn root_line(root: &str) -> String {
    if root.trim().is_empty() {
        return String::new();
    }
    format!(" The user's root folder for teams is {}: when they name no folder for a new team, do not ask; leave `work_dir` empty (the team gets a new subfolder named after it) or pass a short folder name to use under the root. A full path they name is used as it is.", root.trim())
}

/// Agent Center's skill library, for the prompt: what a member may be given with `skills`.
// i18n: model-facing
fn library_line(office: &Office) -> String {
    let lib = office.member_skills();
    if lib.is_empty() {
        return String::new();
    }
    let items: Vec<String> = lib.iter().map(|s| if s.description.is_empty() { s.name.clone() } else { format!("{} ({})", s.name, s.description) }).collect();
    format!(" Skills in Agent Center's library, which you may give a member with `skills` (they get the skill's text with their role): {}.", items.join("; "))
}

/// Fast mode forced from Agent Center's ⚙: one more rule for the prompt, or nothing.
// i18n: model-facing
fn fast_line(fast: bool) -> String {
    if !fast {
        return String::new();
    }
    "- FAST MODE is on (the user set it in your settings): every team you propose is a fast team, and `fast` is set for you. Take the smallest team that does the job: a quick request gets one member, who is the leader; a medium one gets one worker and one reviewer on a different model; only a goal with several independent parts gets more, split by scope, at most 4 members. No pipelines (gather → verify → write). In `kickoff` say that the team runs in fast mode: one review per task, no second round, accepted is final.\n".to_string()
}

/// The skills Agent Center reads itself (its ⚙ → Skills): their text, after the rules and
/// before the person's instructions, so the person can give it know-how for kinds of request.
// i18n: model-facing
fn center_skills(names: &[String]) -> String {
    if names.is_empty() {
        return String::new();
    }
    let text = crate::team_agents::skill_text(names);
    if text.trim().is_empty() {
        return String::new();
    }
    format!("Your skills (the user put them in Agent Center's library and turned them on for you). Use whichever fits the request when you judge its size, pick members, split the work and write `kickoff`; they never let you act without the user's click.\n{text}\n")
}

/// How long the person's own instructions may be: a few paragraphs, not a second prompt.
pub const MAX_INSTRUCTIONS: usize = 2000;

/// The person's own instructions, put before the language line: they shape how Agent Center
/// works, never what it may do on its own.
// i18n: model-facing
fn own_instructions(given: &str) -> String {
    let given = given.trim();
    if given.is_empty() {
        return String::new();
    }
    format!(
        "The user's own instructions for you (they set them in Agent Center's settings). Follow them as long as they do not go against the rules above: whatever they say, nothing happens without the user's click on a card, you never guess a team's state, and you only name agents list_agents gave you.\n<user_instructions>\n{}\n</user_instructions>\n",
        cut(given, MAX_INSTRUCTIONS)
    )
}

// i18n: model-facing
fn describe() -> Vec<Tool> {
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| Tool {
        name: name.into(),
        description: description.into(),
        parameters: json!({ "type": "object", "properties": properties, "required": required }),
    };
    let team = json!({ "type": "string", "description": "The team's id or name." });
    let knowledge = json!({
        "type": "array",
        "description": "Documents for the team's knowledge base: files the user attached (their id, e.g. u1a2b) or full paths the user wrote. visibility: \"leader\" (the default) or \"shared\" — shared only when the user said the whole team may see it.",
        "items": { "type": "object", "properties": {
            "upload": { "type": "string", "description": "An attached file's id." },
            "path": { "type": "string", "description": "A full path the user wrote." },
            "visibility": { "type": "string", "enum": ["leader", "shared"] },
        } },
    });
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
        tool("list_agents", "The agents members can run as: their default models, what each is good for, its price per million tokens and what it spent in the last 30 days.", json!({}), &[]),
        tool("agent_models", "The models one agent offers (asks the agent's endpoint).", json!({ "agent": { "type": "string", "description": "The agent's id." } }), &["agent"]),
        tool(
            "offer_choices",
            "When you ask the user to choose between a few options, put them on screen as buttons: the one they click comes back as their next message. Use it for every multiple-choice question (which team, which agent, cheaper or stronger, yes or no…).",
            json!({
                "question": { "type": "string", "description": "The question, in one line." },
                "options": { "type": "array", "items": { "type": "string" }, "description": "2 to 6 short options, each a complete answer the user could have typed." },
                "multiple": { "type": "boolean", "description": "True when more than one may be picked." }
            }),
            &["question", "options"],
        ),
        tool(
            "propose_team",
            "Prepares a new team for the user to confirm with a click (it is created, and started if start is true, only then).",
            json!({
                "name": { "type": "string" },
                "goal": { "type": "string", "description": "What the team must achieve and deliver, in the user's words and enough detail." },
                "scope": { "type": "array", "items": { "type": "string" } },
                "work_dir": { "type": "string", "description": "Full path of the folder the team works in. If it does not exist, the user is asked whether to create it when they confirm. When a root folder is set (see your instructions) it may be left out (a subfolder named after the team) or be a folder name under the root." },
                "members": { "type": "array", "items": { "type": "object", "properties": {
                    "name": { "type": "string" }, "role": { "type": "string" }, "duty": { "type": "string" },
                    "agent": { "type": "string", "description": "An agent id from list_agents." },
                    "model": { "type": "string", "description": "Empty keeps the model the user set on the agent (the usual case). Another model only for an agent with no model set, or when the user asked for it (then also pass model_change_asked)." },
                    "brief": { "type": "string", "description": "Rules this member keeps throughout its work (sources, formats, what not to do). Read with its role." },
                    "skills": { "type": "array", "items": { "type": "string" }, "description": "Names of skills from Agent Center's library (listed in your instructions) this member gets the text of." },
                }, "required": ["name", "role", "agent"] } },
                "leader": { "type": "string", "description": "The leader's name; the first member if empty." },
                "kickoff": { "type": "string", "description": "Your plan for the leader, read with its first message: how big the goal is (quick / medium / large), how to split it (by scope, by batch, or one member plus one reviewer), who reviews what, what to deliver first, and the rules of the work. A few lines." },
                "model_change_asked": { "type": "boolean", "description": "True only when the user themselves asked for a member to run a model other than the one set on its agent." },
                "fast": { "type": "boolean", "description": "Fast mode: the leader takes the smallest team that does the job, one review per task, no second round. Set it when the user asks for speed or a quick answer." },
                "start": { "type": "boolean", "description": "Start it as soon as it is created (default true)." },
                "knowledge": knowledge.clone(),
                "knowledge_from": { "type": "string", "description": "Another team (id or name) whose knowledge base the new team starts with, each document as it was shared." },
            }),
            &["name", "goal", "members"],
        ),
        tool(
            "propose_knowledge",
            "Prepares adding documents to an existing team's knowledge base, for the user to confirm. A running team's leader is told of them.",
            json!({ "team": team, "knowledge": knowledge }),
            &["team", "knowledge"],
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

/// What the window shows while Agent Center works.
fn label(call: &Call, office: &Office) -> String {
    let a = &call.arguments;
    let team = || {
        let given = text(a, "team").unwrap_or_default();
        find_team(office, &given).map(|(_, c)| c.name).unwrap_or(given)
    };
    match call.name.as_str() {
        "list_teams" => tr!("查看所有團隊", "Looking at all the teams"),
        "team_detail" => tr!(format!("查看「{}」的現況", team()), format!("Checking how \"{}\" is doing", team())),
        "team_messages" => tr!(format!("讀「{}」的溝通紀錄", team()), format!("Reading the messages of \"{}\"", team())),
        "cost_analysis" => tr!(format!("分析「{}」的成本", team()), format!("Analyzing the cost of \"{}\"", team())),
        "usage_summary" => {
            let period: &str = match a.get("period").and_then(Value::as_str).unwrap_or("7d") {
                "today" => tr!("今天", "today"),
                "yesterday" => tr!("昨天", "yesterday"),
                "30d" => tr!("近 30 天", "the last 30 days"),
                "month" => tr!("本月", "this month"),
                _ => tr!("近 7 天", "the last 7 days"),
            };
            tr!(format!("查詢{period}的用量與成本"), format!("Checking usage and cost for {period}"))
        }
        "list_agents" => tr!("查看可用的代理", "Looking at the available agents"),
        "agent_models" => tr!(format!("查詢「{}」提供的模型", text(a, "agent").unwrap_or_default()), format!("Checking the models \"{}\" offers", text(a, "agent").unwrap_or_default())),
        "propose_team" => tr!(format!("擬好新團隊「{}」", text(a, "name").unwrap_or_default()), format!("Drafted the new team \"{}\"", text(a, "name").unwrap_or_default())),
        "offer_choices" => tr!("列出選項", "Offering choices"),
        "propose_instruction" => tr!(format!("擬好給「{}」的指令", team()), format!("Drafted an instruction for \"{}\"", team())),
        "propose_team_action" => tr!(format!("擬好「{}」的操作", team()), format!("Drafted an action for \"{}\"", team())),
        "propose_knowledge" => tr!(format!("擬好「{}」的知識庫文件", team()), format!("Drafted documents for the knowledge base of \"{}\"", team())),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choices_are_two_to_six_short_options() {
        let ok = choices_of(&json!({ "question": "哪一種?", "options": ["便宜的組合", " 最強的組合 ", ""] })).unwrap();
        assert_eq!((ok.options.len(), ok.options[1].as_str(), ok.multiple), (2, "最強的組合", false));
        assert!(choices_of(&json!({ "question": "?", "options": ["only one"] })).is_err());
        assert!(choices_of(&json!({ "question": "?", "options": ["a", "b", "c", "d", "e", "f", "g"] })).is_err());
    }

    #[test]
    fn an_answer_that_speaks_of_a_card_is_caught() {
        assert!(claims_card("已準備好一張團隊提案卡,確認後按卡片上的按鈕即會建立並啟動。"));
        assert!(claims_card("The card is on your screen: click Create."));
        assert!(!claims_card("目前有 2 個團隊,購物網站團隊執行中。"));
    }

    #[test]
    fn the_person_s_instructions_end_the_prompt_within_the_rules() {
        assert_eq!(own_instructions("  "), "");
        let said = own_instructions("開團隊預設 3 人,預算優先。");
        assert!(said.contains("<user_instructions>\n開團隊預設 3 人,預算優先。\n</user_instructions>") && said.contains("nothing happens without the user's click"), "{said}");
        assert!(own_instructions(&"字".repeat(MAX_INSTRUCTIONS + 500)).chars().count() < MAX_INSTRUCTIONS + 400);
    }

    #[test]
    fn a_member_keeps_the_model_the_user_set_on_its_agent() {
        let mut planner = crate::acp::AgentProfile::copilot();
        planner.id = "ta-plan".into();
        planner.name = "規劃大師".into();
        planner.protocol = crate::acp::Protocol::Claude;
        planner.model = "claude-opus-5".into();
        let driver = Arc::new(crate::acp::Agents::default());
        let teams = Arc::new(crate::team::orchestrator::Teams::new(Arc::new(crate::team::orchestrator::AcpDrive(driver.clone())), Arc::new(|_| {}), Some(std::env::temp_dir().join(format!("coucou-secretary-model-{}", std::process::id()))), settings::team_mcp_exe_path()));
        let mut office = Office::new(teams, &[], driver, 480, String::new());
        office.choices = vec![planner];
        let sec = Secretary::default();
        let member = |model: &str| json!({ "name": "查證員", "role": "查證", "agent": "ta-plan", "model": model });
        let ask = |m: Value, extra: Value| {
            let mut a = json!({ "name": "t", "goal": "g", "work_dir": "D:\\x", "members": [m] });
            if let Some(o) = extra.as_object() { for (k, v) in o { a[k] = v.clone(); } }
            a
        };
        let err = sec.propose_team(&ask(member("claude-sonnet-5"), json!({})), &office).unwrap_err();
        assert!(err.contains("claude-opus-5") && err.contains("different agent"), "{err}");
        assert!(sec.propose_team(&ask(member(""), json!({})), &office).is_ok());
        assert!(sec.propose_team(&ask(member("claude-opus-5"), json!({})), &office).is_ok());
        assert!(sec.propose_team(&ask(member("claude-sonnet-5"), json!({ "model_change_asked": true })), &office).is_ok());
    }

    #[test]
    fn the_person_can_change_a_proposed_team_s_members_by_hand() {
        let mut planner = crate::acp::AgentProfile::copilot();
        planner.id = "ta-plan".into();
        planner.name = "規劃大師".into();
        planner.protocol = crate::acp::Protocol::Claude;
        let mut coder = planner.clone();
        coder.id = "ta-code".into();
        coder.name = "工程師".into();
        let driver = Arc::new(crate::acp::Agents::default());
        let teams = Arc::new(crate::team::orchestrator::Teams::new(Arc::new(crate::team::orchestrator::AcpDrive(driver.clone())), Arc::new(|_| {}), Some(std::env::temp_dir().join(format!("coucou-secretary-revise-{}", std::process::id()))), settings::team_mcp_exe_path()));
        let mut office = Office::new(teams, &[], driver, 480, String::new());
        office.choices = vec![planner, coder];
        let sec = Secretary::default();
        let ask = json!({ "name": "t", "goal": "g", "work_dir": "D:\\x", "kickoff": "go", "members": [{ "name": "規劃", "role": "規劃", "duty": "plan it", "agent": "ta-plan", "skills": [] }] });
        let p = sec.propose_team(&ask, &office).unwrap();
        assert_eq!(p.picks.len(), 1);
        let revised = sec
            .revise_team(&p.id, &[json!({ "agent": "ta-code", "name": "工程師", "role": "寫程式", "leader": true }), json!({ "agent": "ta-plan", "name": "規劃", "leader": false })], &office)
            .unwrap();
        assert_eq!(revised.picks.len(), 2);
        assert!(revised.picks[0].leader && revised.picks[0].agent == "ta-code" && !revised.picks[1].leader);
        let config = &revised.payload["config"];
        assert_eq!(config["leader"], "ai1");
        // The kept member keeps what Agent Center gave it; the new one starts plain.
        assert_eq!(config["members"][1]["duty"], "plan it");
        assert_eq!(config["members"][1]["role"], "規劃");
        assert_eq!(config["members"][0]["duty"], "");
        assert!(revised.lines[0].contains("g") && revised.lines.iter().any(|l| l.starts_with("工程師")) && revised.lines.last().unwrap().contains("go"), "{:?}", revised.lines);
        assert!(sec.notes.lock().unwrap().last().unwrap().contains("by hand"));
        assert!(sec.revise_team(&p.id, &[], &office).is_err());
    }

    #[test]
    fn a_team_without_a_folder_goes_under_the_root_folder() {
        let none = json!({});
        assert!(work_dir_of(&none, "TXC 調查", "").unwrap_err().contains("full path"));
        assert_eq!(work_dir_of(&json!({ "work_dir": "D:\\x" }), "t", "").unwrap(), "D:\\x");
        assert_eq!(work_dir_of(&none, "TXC 調查: 下跌?", "D:\\ai").unwrap(), "D:\\ai\\TXC 調查 下跌");
        assert_eq!(work_dir_of(&json!({ "work_dir": "site" }), "t", "D:\\ai").unwrap(), "D:\\ai\\site");
        assert_eq!(work_dir_of(&json!({ "work_dir": "D:\\x" }), "t", "D:\\ai").unwrap(), "D:\\x");
        assert_eq!(folder_name(" ... "), "team");
        assert!(root_line("").is_empty() && root_line("D:\\ai").contains("D:\\ai"));
    }

    #[test]
    fn a_conversation_is_saved_and_comes_back_with_its_cards() {
        let dir = std::env::temp_dir().join(format!("coucou-secretary-chats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sec = Secretary::at(dir.join("uploads"));
        assert!(sec.chat_save("x", "[]").unwrap().is_none(), "nothing said, nothing saved");
        let mut planner = crate::acp::AgentProfile::copilot();
        planner.id = "ta-plan".into();
        planner.protocol = crate::acp::Protocol::Claude;
        let driver = Arc::new(crate::acp::Agents::default());
        let teams = Arc::new(crate::team::orchestrator::Teams::new(Arc::new(crate::team::orchestrator::AcpDrive(driver.clone())), Arc::new(|_| {}), Some(dir.join("teams")), settings::team_mcp_exe_path()));
        let mut office = Office::new(teams, &[], driver, 480, String::new());
        office.choices = vec![planner];
        sec.turns.lock().unwrap().push(Turn::User("開個團隊".into()));
        let p = sec.propose_team(&json!({ "name": "t", "goal": "g", "work_dir": "D:\\x", "members": [{ "name": "規劃", "role": "規劃", "agent": "ta-plan" }] }), &office).unwrap();
        let first = sec.chat_save("開個團隊", "[{\"who\":\"you\"}]").unwrap().unwrap();
        assert!(first.current && first.title == "開個團隊");
        sec.reset();
        sec.turns.lock().unwrap().push(Turn::User("第二段".into()));
        sec.chat_save("第二段", "[]").unwrap();
        let list = sec.chats();
        assert_eq!(list.len(), 2);
        assert!(list[0].current && list[0].title == "第二段" && !list[1].current);
        let entries = sec.chat_open(&first.id).unwrap();
        assert_eq!(entries, "[{\"who\":\"you\"}]");
        assert!(matches!(sec.turns.lock().unwrap().first(), Some(Turn::User(t)) if t == "開個團隊"));
        let back = sec.proposal(&p.id).unwrap();
        assert_eq!(back.state, "open");
        assert_eq!(back.payload["config"]["name"], "t", "the card can still be confirmed: its payload came back");
        assert!(sec.chats().iter().find(|c| c.id == first.id).unwrap().current);
        sec.chat_delete(&first.id).unwrap();
        assert_eq!(sec.chats().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fast_mode_from_the_settings_marks_every_proposed_team() {
        assert_eq!(fast_line(false), "");
        assert!(fast_line(true).contains("FAST MODE") && fast_line(true).contains("smallest team"));
    }

    #[test]
    fn agent_center_s_own_skills_go_in_its_prompt_as_their_text() {
        assert_eq!(center_skills(&[]), "");
        let dir = std::env::temp_dir().join(format!("coucou-center-skill-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: x\nfor: agent-center\n---\nFor a stock question, one member who browses.").unwrap();
        let said = center_skills(&[dir.to_string_lossy().to_string()]);
        assert!(said.starts_with("Your skills") && said.contains("For a stock question") && !said.contains("for: agent-center"), "{said}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_agent_s_cost_is_its_model_s_price_and_what_it_spent() {
        let found = crate::pricing::Found { price: crate::pricing::Price { input: 0.3, output: 1.2, cache_read: 0.03, cache_write: 0.0 }, source: "list".into(), listed_as: "deepseek-v4-flash".into(), can: Default::default() };
        let line = cost_note(crate::acp::Location::Cloud, "deepseek-v4-flash", Some(&found), false, Some((120_000, 0.42)));
        assert!(line.contains("input $0.3 / output $1.2") && line.contains("public price list") && line.contains("about $0.42"), "{line}");
        let plan = cost_note(crate::acp::Location::Cloud, "claude-opus-5", Some(&found), true, None);
        assert!(plan.contains("subscription") && plan.contains("not used"), "{plan}");
        assert!(cost_note(crate::acp::Location::Local, "qwen3-coder", None, false, None).contains("local model"));
        assert!(cost_note(crate::acp::Location::Cloud, "", None, false, None).contains("price unknown"));
    }

    #[test]
    fn a_missing_work_folder_is_created_only_when_the_person_says_so() {
        let dir = std::env::temp_dir().join(format!("coucou-folder-test-{}", std::process::id())).join("site");
        let path = dir.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        assert!(matches!(folder_state(&path), Folder::Missing));
        let refused = ensure_folder(&path, false).unwrap_err();
        assert!(refused.contains("does not exist"), "{refused}");
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
        assert_eq!(tools.len(), 12);
        for t in &tools {
            assert_eq!(t.parameters["type"], "object");
            assert!(t.description.len() > 20);
        }
        assert!(tools.iter().filter(|t| t.name.starts_with("propose_")).count() == 4);
    }

    fn uploads_in(name: &str) -> (Secretary, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("coucou-sec-uploads-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        (Secretary::at(base.join("uploads")), base)
    }

    #[test]
    fn attached_files_are_kept_aside_and_the_model_hears_only_their_names() {
        let (sec, base) = uploads_in("names");
        let brand = sec.upload("品牌指南.md", "主色:藍".as_bytes().to_vec(), r"D:\Docs\品牌指南.md").unwrap();
        let pic = sec.upload("首頁.png", b"\x89PNG\r\n\x1a\nxx".to_vec(), "").unwrap();
        let env = sec.upload("env.md", b"OPENAI=sk-proj-abcdefghijklmnopqrstuvwx".to_vec(), "").unwrap();
        assert_eq!((brand.kind, pic.kind), (DocKind::Text, DocKind::Image));
        assert!(env.key_like.is_some() && !env.force);

        let ids = vec![brand.id.clone(), pic.id.clone(), env.id.clone(), "u0000".into()];
        let line = sec.attached_line(&ids).unwrap();
        assert!(line.contains(&format!("{} 品牌指南.md (text, 1 KB)", brand.id)) && line.contains(&format!("{} 首頁.png (image", pic.id)));
        // Nothing of what is in them, and not the one still waiting for the person's word on a key.
        assert!(!line.contains("主色") && !line.contains("env.md"));
        sec.upload_force(&env.id).unwrap();
        assert!(sec.attached_line(&ids).unwrap().contains("env.md (text, 1 KB, looks like it has a key — the user chose to keep it)"));

        sec.upload_remove(&pic.id);
        assert!(!sec.attached_line(&ids).unwrap().contains("首頁.png"));
        assert_eq!(std::fs::read_dir(base.join("uploads")).unwrap().count(), 2);
        sec.reset();
        assert!(!base.join("uploads").exists());
        assert!(sec.attached_line(&ids).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_proposal_names_only_attached_files_and_full_paths_and_says_who_may_read_them() {
        let (sec, base) = uploads_in("items");
        let brand = sec.upload("品牌指南.md", b"blue".to_vec(), "").unwrap();
        let env = sec.upload("env.md", b"OPENAI=sk-proj-abcdefghijklmnopqrstuvwx".to_vec(), "").unwrap();
        std::fs::create_dir_all(&base).unwrap();
        let spec = base.join("spec.md");
        std::fs::write(&spec, b"# spec").unwrap();

        let items = sec
            .knowledge_items(&json!({ "knowledge": [
                { "upload": brand.id, "visibility": "shared" },
                { "path": spec.to_string_lossy() },
            ] }))
            .unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!((items[0].visibility, items[1].visibility), (Visibility::Shared, Visibility::Leader));
        assert_eq!(
            knowledge_lines(&items, Some(("購物網站", 3))),
            vec!["Knowledge base: starts with the 3 document(s) of \"購物網站\"".to_string(), "Knowledge base: 品牌指南.md (shared with the team), spec.md (leader only)".to_string()]
        );

        for bad in [
            json!({ "knowledge": [{ "upload": "u9999" }] }),
            json!({ "knowledge": [{ "upload": env.id }] }),
            json!({ "knowledge": [{ "path": "spec.md" }] }),
            json!({ "knowledge": [{ "path": base.join("gone.md").to_string_lossy() }] }),
            json!({ "knowledge": [{}] }),
        ] {
            assert!(sec.knowledge_items(&bad).is_err(), "{bad}");
        }
        sec.upload_force(&env.id).unwrap();
        let kept = sec.knowledge_items(&json!({ "knowledge": [{ "upload": env.id }] })).unwrap();
        assert!(kept[0].key_like);
        assert!(knowledge_lines(&kept, None)[0].contains("⚠ may hold a key"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_confirmed_proposal_copies_its_documents_in() {
        let (sec, base) = uploads_in("fill");
        let brand = sec.upload("品牌指南.md", b"blue".to_vec(), r"D:\Docs\品牌指南.md").unwrap();
        let env = sec.upload("env.md", b"OPENAI=sk-proj-abcdefghijklmnopqrstuvwx".to_vec(), "").unwrap();
        sec.upload_force(&env.id).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        let leaked = base.join("leaked.md");
        std::fs::write(&leaked, b"password = hunter2hunter2").unwrap();
        let items = sec
            .knowledge_items(&json!({ "knowledge": [
                { "upload": brand.id, "visibility": "shared" },
                { "upload": env.id },
                { "path": leaked.to_string_lossy() },
            ] }))
            .unwrap();

        let kb = Kb::at(base.join("kb"));
        let uploads = sec.uploads.lock().unwrap().clone();
        let (added, failed) = fill_knowledge(&kb, &items, &uploads);
        assert_eq!(added.len(), 2);
        assert_eq!(failed, vec!["leaked.md looks like it holds a key, so it was not added; check it in the team's setup and add it there yourself".to_string()]);
        let index = kb.load();
        let brand_doc = index.docs.iter().find(|d| d.name == "品牌指南.md").unwrap();
        assert_eq!((brand_doc.visibility, brand_doc.source.as_str()), (Visibility::Shared, r"D:\Docs\品牌指南.md"));
        assert_eq!(index.docs.iter().find(|d| d.name == "env.md").unwrap().visibility, Visibility::Leader);
        assert_eq!(
            knowledge_outcome(added.len(), &failed),
            "2 document(s) were put in its knowledge base; not added: leaked.md looks like it holds a key, so it was not added; check it in the team's setup and add it there yourself"
        );
        let _ = std::fs::remove_dir_all(&base);
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
            let office = Office::new(teams, &settings.agents, driver, 480, String::new());
            let secretary = Secretary::default();
            let step = |s: &Step| eprintln!("  step: {} ({})", s.label, s.tool);
            let reply = secretary.ask(&provider, &office, "幫我分析「購物網站 DEMO」這 30 天的成本:為什麼這麼高?怎麼優化?", &[], &step).await.expect("an answer");
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
            let office = Office::new(teams, &settings.agents, driver, 480, String::new());
            let secretary = Secretary::default();
            let step = |s: &Step| eprintln!("  step: {} ({})", s.label, s.tool);

            let first = secretary.ask(&provider, &office, "各團隊現在的狀況如何?有沒有在等我處理的?", &[], &step).await.expect("an answer");
            eprintln!("Q1 → {}\n", first.text);
            assert!(first.steps.iter().any(|s| s.tool == "list_teams" || s.tool == "team_detail"));

            let second = secretary
                .ask(&provider, &office, r"幫我開一個新團隊:在 D:\Temp\coucou-secretary-check 做一個顯示 Hello 的單頁網頁。兩個成員都用 cg2,隊長用 glm-5.3-flash,另一位用 deepseek-v4-flash。先不要啟動。", &[], &step)
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
