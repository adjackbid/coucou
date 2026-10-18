// Team agents (Teamwork → Agent Pool): agents of the person's own making,
// each built on a native agent of Settings → Agent Provider. A team agent keeps its
// base's command (or an n8n node's webhook), environment and key, and adds
// its own name, model, system prompt, MCP servers and skills, and a
// description Agent Center reads to know what it is good for. It is a
// Cloud Agent or a Local Agent as its base is. Nothing here holds a key: the
// base's stays in the Credential Manager, under the base's name.
//
// Stored in %APPDATA%\Coucou\team-agents.json, beside constitution.json.
// New teams — Agent Center's and the ones made by hand — are built from
// these only. A team set up before that, naming a native agent, still runs.
//
// Where they are run, a team agent is simply one more AgentProfile (`profiles`):
// its base's, under its own id, with `key_of` naming the base and `extras`
// carrying what it adds.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::acp::{AgentProfile, Extras, Location, McpServer, Protocol};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Mcp {
    pub name: String,
    /// A command to start (stdio)…
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// …or a URL to connect to (streamable HTTP).
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamAgent {
    pub id: String,
    pub name: String,
    /// The native agent (Settings → Agent Provider) it runs on.
    pub base: String,
    /// Empty: the base's model.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub mcp: Vec<Mcp>,
    /// Skill folders (each with a SKILL.md) or skill names.
    #[serde(default)]
    pub skills: Vec<String>,
    /// What it is for, in the person's words: Agent Center picks by it.
    #[serde(default)]
    pub description: String,
    /// The person's grouping in Agent Pool (程式開發, 文案…); empty for none.
    #[serde(default)]
    pub category: String,
    /// How hard it thinks: low, medium, high, xhigh or max; empty for the provider's own default.
    #[serde(default)]
    pub effort: String,
}

/// The efforts every provider that takes one understands.
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// An effort a provider will take, or none.
pub fn effort_of(given: &str) -> Option<&'static str> {
    let given = given.trim().to_ascii_lowercase();
    EFFORTS.iter().copied().find(|e| *e == given)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamAgents {
    /// An older file's `source` (native or team agents for new teams) is
    /// read past: new teams always take these.
    #[serde(default)]
    pub agents: Vec<TeamAgent>,
}

/// What a protocol can take of a team agent: natively, through the member's
/// brief, or not at all. Shown on the Agent Pool page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Support {
    Native,
    Brief,
    No,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Supports {
    pub system_prompt: Support,
    pub mcp: Support,
    pub skills: Support,
    /// Its reasoning effort: a flag on its command line (or, for n8n, a field of each call).
    pub effort: Support,
}

pub fn supports(protocol: Protocol) -> Supports {
    match protocol {
        // --append-system-prompt-file, --mcp-config.
        Protocol::Claude => Supports { system_prompt: Support::Native, mcp: Support::Native, skills: Support::Brief, effort: Support::Native },
        // developerInstructions on thread/start, mcp_servers.* overrides.
        Protocol::Codex => Supports { system_prompt: Support::Native, mcp: Support::Native, skills: Support::Brief, effort: Support::Native },
        // ACP has no system prompt; MCP servers go with session/new (or Copilot's own file).
        // --reasoning-effort is Copilot CLI's (another ACP agent: see `supports_profile`).
        Protocol::Acp => Supports { system_prompt: Support::Brief, mcp: Support::Native, skills: Support::Brief, effort: Support::Native },
        // Antigravity reads MCP servers only from the work folder's .agents,
        // which every member shares: one member's servers would be everyone's.
        Protocol::Agy => Supports { system_prompt: Support::Brief, mcp: Support::No, skills: Support::Brief, effort: Support::Native },
        // An n8n workflow is sent the system prompt with every call (n8n.rs);
        // its tools and skills are the workflow's own business.
        Protocol::N8n => Supports { system_prompt: Support::Native, mcp: Support::No, skills: Support::No, effort: Support::Native },
    }
}

/// What a native agent can take: as its protocol can, but only Copilot CLI among ACP agents knows an effort.
pub fn supports_profile(profile: &AgentProfile) -> Supports {
    let mut s = supports(profile.protocol);
    if profile.protocol == Protocol::Acp && !crate::acp::runs_copilot(profile) {
        s.effort = Support::No;
    }
    s
}

fn path() -> PathBuf {
    crate::settings::config_dir().join("team-agents.json")
}

pub fn current() -> TeamAgents {
    std::fs::read(path())
        .ok()
        .and_then(|b| serde_json::from_slice::<TeamAgents>(b.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&b)).ok())
        .unwrap_or_default()
}

pub fn save(doc: TeamAgents, natives: &[AgentProfile]) -> Result<(), String> {
    let problems = doc.problems(natives);
    if !problems.is_empty() {
        return Err(problems.join("\n"));
    }
    let file = path();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&file, json).map_err(|e| tr!(format!("無法儲存團隊 Agent:{e}"), format!("Couldn't save the team agents: {e}")))
}

impl TeamAgents {
    /// What stops these from being saved, in plain words.
    pub fn problems(&self, natives: &[AgentProfile]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for a in &self.agents {
            let name = if a.name.trim().is_empty() { a.id.as_str() } else { a.name.trim() };
            if !crate::team::is_plain_id(&a.id) {
                out.push(tr!(format!("團隊 Agent「{name}」:id 只能用英文字母、數字、'-' 和 '_'。"), format!("Team agent '{name}': its id may only use letters, digits, '-' and '_'.")));
            }
            if !seen.insert(a.id.as_str()) {
                out.push(tr!(format!("有兩個團隊 Agent 的 id 都是「{}」。", a.id), format!("Two team agents have the id '{}'.", a.id)));
            }
            if natives.iter().any(|n| n.id == a.id) {
                out.push(tr!(format!("團隊 Agent「{name}」的 id 和「設定 → Agent Provider」裡的某個 agent 相同。"), format!("Team agent '{name}' has the id of an agent in Settings → Agent Provider.")));
            }
            if a.name.trim().is_empty() {
                out.push(tr!(format!("團隊 Agent「{}」沒有名字。", a.id), format!("Team agent '{}' has no name.", a.id)));
            }
            let mut servers = std::collections::BTreeSet::new();
            for m in &a.mcp {
                if !crate::team::is_plain_id(m.name.trim()) || m.name.trim() == crate::acp::TEAM_SERVER {
                    out.push(tr!(
                        format!("團隊 Agent「{name}」:「{}」不能當 MCP 伺服器的名字(只能用英文字母、數字、'-' 和 '_')。", m.name),
                        format!("Team agent '{name}': '{}' cannot be an MCP server's name (letters, digits, '-' and '_').", m.name)
                    ));
                } else if !servers.insert(m.name.trim()) {
                    out.push(tr!(format!("團隊 Agent「{name}」有兩個都叫「{}」的 MCP 伺服器。", m.name.trim()), format!("Team agent '{name}' has two MCP servers called '{}'.", m.name.trim())));
                }
                let url = m.url.trim();
                if url.is_empty() && m.command.trim().is_empty() {
                    out.push(tr!(format!("團隊 Agent「{name}」:MCP 伺服器「{}」需要一個指令或一個網址。", m.name), format!("Team agent '{name}': the MCP server '{}' needs a command or a URL.", m.name)));
                }
                if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) {
                    out.push(tr!(
                        format!("團隊 Agent「{name}」:MCP 伺服器「{}」的網址必須以 http:// 或 https:// 開頭。", m.name),
                        format!("Team agent '{name}': the MCP server '{}' URL must start with http:// or https://.", m.name)
                    ));
                }
            }
        }
        out
    }

    /// The team agents as profiles a member can run as. One whose base is
    /// gone from Settings is left out (a team naming it says so).
    pub fn profiles(&self, natives: &[AgentProfile]) -> Vec<AgentProfile> {
        self.agents.iter().filter_map(|a| profile_of(a, natives)).collect()
    }

    /// Every profile a team may run as: the team agents, and the native ones
    /// a team set up before teams took team agents only may still name.
    pub fn runnable(&self, natives: &[AgentProfile]) -> Vec<AgentProfile> {
        let mut all = natives.to_vec();
        all.extend(self.profiles(natives).into_iter().filter(|p| !natives.iter().any(|n| n.id == p.id)));
        all
    }

    /// The profiles a new team is built from: the team agents only.
    pub fn choices(&self, natives: &[AgentProfile]) -> Vec<AgentProfile> {
        self.profiles(natives)
    }
}

/// The profile a team agent runs as: its base's, with what it adds. None
/// when its base is gone from Settings.
pub fn profile_of(a: &TeamAgent, natives: &[AgentProfile]) -> Option<AgentProfile> {
    let base = natives.iter().find(|n| n.id == a.base)?;
    let mut p = base.clone();
    p.id = a.id.clone();
    p.name = if a.name.trim().is_empty() { a.id.clone() } else { a.name.trim().to_string() };
    if !a.model.trim().is_empty() {
        p.model = a.model.trim().to_string();
    }
    p.key_of = Some(base.key_of.clone().unwrap_or_else(|| base.id.clone()));
    let mcp_servers = if supports(base.protocol).mcp == Support::No {
        Vec::new()
    } else {
        a.mcp
            .iter()
            .map(|m| McpServer {
                name: m.name.trim().to_string(),
                command: m.command.trim().to_string(),
                args: m.args.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
                env: Default::default(),
                url: m.url.trim().to_string(),
            })
            .collect()
    };
    p.extras = Some(Extras {
        system_prompt: a.system_prompt.trim().to_string(),
        mcp_servers,
        skills: a.skills.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        description: a.description.trim().to_string(),
        category: a.category.trim().to_string(),
        effort: effort_of(&a.effort).filter(|_| supports_profile(base).effort != Support::No).unwrap_or("").to_string(),
        base: base.id.clone(),
    });
    Some(p)
}

/// Where a skill named only by its name lives, if it is in Agent Center's
/// library or one of the usual places.
fn find_skill(name: &str) -> Option<PathBuf> {
    let mut dirs = vec![crate::settings::team_skills_dir()];
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        dirs.extend([home.join(".claude").join("skills"), home.join(".codex").join("skills"), home.join(".agents").join("skills"), home.join(".copilot").join("skills")]);
    }
    dirs.into_iter().map(|d| d.join(name)).find(|d| d.join("SKILL.md").is_file())
}

/// A skill in Agent Center's library (settings::team_skills_dir).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySkill {
    pub name: String,
    /// The `description:` of its front matter, or nothing.
    pub description: String,
    pub path: PathBuf,
    /// `for: agent-center` in its front matter: Agent Center's own know-how
    /// (how to size a request, pick members, split work), never handed to a
    /// member. Any other skill is for members, and Agent Center may read it too.
    pub for_center: bool,
    /// `source:` of its front matter: where it comes from (a GitHub URL), or nothing.
    pub source: String,
    /// `stars:` of its front matter: GitHub stars as written ("103.3k"), or nothing.
    pub stars: String,
    /// `stars-at:` of its front matter: the day the stars were counted, or nothing.
    pub stars_at: String,
    /// `role:` of its front matter: what the market calls it (開發總監), or nothing.
    pub role: String,
    /// `category:` of its front matter (程式開發, UI/UX 設計…), the same words
    /// Agent Pool groups agents by; a preset copied before it had one takes
    /// the preset's. Empty for none.
    pub category: String,
}

/// A skill as the market lists it, from its SKILL.md front matter.
fn library_skill(name: String, md: PathBuf) -> LibrarySkill {
    let front = |k: &str| skill_front(&md, k).unwrap_or_default();
    let (description, source, stars, stars_at, role) = (front("description"), front("source"), front("stars"), front("stars-at"), front("role"));
    let mut category = front("category");
    if category.is_empty() {
        if let Some((_, preset)) = PRESET_SKILLS.iter().find(|(n, _)| n.eq_ignore_ascii_case(&name)) {
            category = front_of(preset, "category").unwrap_or_default();
        }
    }
    let for_center = skill_front(&md, "for").is_some_and(|f| f.eq_ignore_ascii_case("agent-center"));
    LibrarySkill { name, description, path: md, for_center, source, stars, stars_at, role, category }
}

/// Skills the market starts with (src/skills/*.md): well-known skills from
/// GitHub, each with its source, purpose and star count in the front matter
/// and a summary of its rules for a member that cannot install the original.
const PRESET_SKILLS: &[(&str, &str)] = &[
    ("superpowers", include_str!("skills/superpowers.md")),
    ("skill-creator", include_str!("skills/skill-creator.md")),
    ("pptx", include_str!("skills/pptx.md")),
    ("marketing-skills", include_str!("skills/marketing-skills.md")),
    ("ui-ux-pro-max", include_str!("skills/ui-ux-pro-max.md")),
    ("ponytail", include_str!("skills/ponytail.md")),
    ("addy-osmani-skills", include_str!("skills/addy-osmani-skills.md")),
    ("understand-anything", include_str!("skills/understand-anything.md")),
    ("graphify", include_str!("skills/graphify.md")),
    ("archify", include_str!("skills/archify.md")),
    ("impeccable", include_str!("skills/impeccable.md")),
    ("agent-browser", include_str!("skills/agent-browser.md")),
    ("remotion-skills", include_str!("skills/remotion-skills.md")),
    ("caveman", include_str!("skills/caveman.md")),
    ("awesome-claude-skills", include_str!("skills/awesome-claude-skills.md")),
];

/// The skills Agent Center itself starts with (src/skills/*.md, `for: agent-center`):
/// they shape how it plans and are never handed to a member.
const CENTER_SKILLS: &[(&str, &str)] = &[(DEFAULT_CENTER_SKILL, DEFAULT_CENTER_SKILL_MD)];

/// Written to `.presets` in the library once the presets went in. Raise it
/// when presets are added, so a library seeded earlier gets the new ones.
const PRESETS_VERSION: &str = "2";

/// Puts in the presets the library does not have yet — Agent Center's own
/// first, then the market's — once per PRESETS_VERSION. A preset the person
/// deleted stays deleted (until the version is raised); one they edited is
/// left as they made it.
pub fn seed_presets(dir: &std::path::Path) {
    let marker = dir.join(".presets");
    if std::fs::read_to_string(&marker).is_ok_and(|v| v.trim() == PRESETS_VERSION) {
        return;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    for (name, md) in CENTER_SKILLS.iter().chain(PRESET_SKILLS) {
        let folder = dir.join(name);
        if folder.exists() || dir.join(format!("{name}.md")).exists() {
            continue;
        }
        if std::fs::create_dir_all(&folder).is_ok() {
            let _ = std::fs::write(folder.join("SKILL.md"), md);
        }
    }
    let _ = std::fs::write(marker, PRESETS_VERSION);
}

/// The skill Agent Center starts with, written into an empty library so the
/// person can read, change or switch off how it sizes a request and shapes a team.
pub const DEFAULT_CENTER_SKILL: &str = "agent-center-planning";

// i18n: model-facing
const DEFAULT_CENTER_SKILL_MD: &str = include_str!("skills/agent-center-planning.md");

/// Makes the library folder when it is not there yet and puts in the skills
/// it starts with: Agent Center's own and the market's presets. Called as the
/// app starts, so a fresh install has them before anyone opens the market.
/// A person who deletes any of them later keeps it deleted.
pub fn ensure_library() -> PathBuf {
    let dir = crate::settings::team_skills_dir();
    seed_presets(&dir);
    dir
}

/// The skills Agent Center may hand a member: the library without Agent Center's own.
pub fn member_library() -> Vec<LibrarySkill> {
    library().into_iter().filter(|s| !s.for_center).collect()
}

/// The library, by name: `<name>/SKILL.md` folders and `<name>.md` files.
pub fn library() -> Vec<LibrarySkill> {
    let Ok(entries) = std::fs::read_dir(crate::settings::team_skills_dir()) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let (name, md) = if p.is_dir() && p.join("SKILL.md").is_file() {
            (entry.file_name().to_string_lossy().to_string(), p.join("SKILL.md"))
        } else if p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("md")) {
            (p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), p.clone())
        } else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        out.push(library_skill(name, md));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// A skill's name as a folder name: letters, digits, '-', '_', '.', spaces; nothing that walks out of the library.
pub fn skill_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.trim() == name
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

/// Where a library skill's text is: `<name>/SKILL.md`, or `<name>.md`.
fn library_md(name: &str) -> Option<PathBuf> {
    library().into_iter().find(|s| s.name.eq_ignore_ascii_case(name)).map(|s| s.path)
}

/// A library skill's whole text, front matter included (the Skill market's editor).
pub fn skill_read(name: &str) -> Result<String, String> {
    let md = library_md(name).ok_or_else(|| -> String { tr!(format!("市集裡沒有叫「{name}」的 skill。"), format!("No skill named '{name}' in the market.")) })?;
    std::fs::read_to_string(&md).map_err(|e| tr!(format!("讀不到 {}:{e}", md.display()), format!("Couldn't read {}: {e}", md.display())))
}

/// Writes a skill into the library: a new `<name>/SKILL.md`, or over the one of that name.
pub fn skill_write(name: &str, text: &str) -> Result<LibrarySkill, String> {
    if !skill_name_ok(name) {
        return Err(tr!("skill 名稱只能用中英文、數字、'-'、'_'、'.' 和空格,最多 64 字。", "A skill's name may only use letters, digits, '-', '_', '.' and spaces, up to 64 characters."));
    }
    let dir = ensure_library();
    let md = library_md(name).unwrap_or_else(|| dir.join(name).join("SKILL.md"));
    if let Some(parent) = md.parent() {
        std::fs::create_dir_all(parent).map_err(|e| -> String { tr!(format!("無法建立 {}:{e}", parent.display()), format!("Couldn't create {}: {e}", parent.display())) })?;
    }
    std::fs::write(&md, text).map_err(|e| -> String { tr!(format!("無法儲存 {}:{e}", md.display()), format!("Couldn't save {}: {e}", md.display())) })?;
    library().into_iter().find(|s| s.path == md).ok_or_else(|| -> String { tr!("存好了,但市集列不出它。", "Saved, but the market cannot list it.") })
}

/// Removes a skill from the library: its folder, or its single `.md` file. Nothing outside the library is touched.
pub fn skill_delete(name: &str) -> Result<(), String> {
    let dir = crate::settings::team_skills_dir();
    let md = library_md(name).ok_or_else(|| -> String { tr!(format!("市集裡沒有叫「{name}」的 skill。"), format!("No skill named '{name}' in the market.")) })?;
    if !md.starts_with(&dir) {
        return Err(tr!("這份 skill 不在市集資料夾裡,不能從這裡刪。", "This skill is not in the market folder, so it cannot be removed from here."));
    }
    let folder = md.parent().filter(|p| *p != dir.as_path() && md.file_name().is_some_and(|f| f == "SKILL.md"));
    let done = match folder {
        Some(f) => std::fs::remove_dir_all(f),
        None => std::fs::remove_file(&md),
    };
    done.map_err(|e| tr!(format!("無法刪除:{e}"), format!("Couldn't delete: {e}")))
}

/// Skills found in the usual places outside the library (~/.claude/skills and
/// the like), not already in it by name: the market offers to copy them in.
pub fn skills_elsewhere() -> Vec<LibrarySkill> {
    let have: Vec<String> = library().into_iter().map(|s| s.name.to_ascii_lowercase()).collect();
    let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) else { return Vec::new() };
    let mut out: Vec<LibrarySkill> = Vec::new();
    for dir in [home.join(".claude").join("skills"), home.join(".codex").join("skills"), home.join(".agents").join("skills"), home.join(".copilot").join("skills")] {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let md = entry.path().join("SKILL.md");
            if !md.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.is_empty() || have.contains(&name.to_ascii_lowercase()) || out.iter().any(|s| s.name.eq_ignore_ascii_case(&name)) {
                continue;
            }
            out.push(library_skill(name, md));
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Copies a SKILL.md found elsewhere (its folder, or the file) into the library under its folder's name.
pub fn skill_import(path: &str) -> Result<LibrarySkill, String> {
    let p = PathBuf::from(path);
    let md = if p.is_dir() { p.join("SKILL.md") } else { p };
    if !md.is_file() {
        return Err(tr!(format!("找不到 {}", md.display()), format!("{} is not there", md.display())));
    }
    let name = if md.file_name().is_some_and(|f| f == "SKILL.md") {
        md.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    } else {
        md.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    };
    let text = std::fs::read_to_string(&md).map_err(|e| -> String { tr!(format!("讀不到 {}:{e}", md.display()), format!("Couldn't read {}: {e}", md.display())) })?;
    skill_write(&name, &text)
}

/// Characters of a skill a member is given in its brief.
const SKILL_TEXT_MAX: usize = 16_000;

/// What a member is given for the skills its leader named (`brief_member`):
/// a library skill's own text, so every vendor's CLI gets it without
/// reading a file outside the work folder; a skill elsewhere by its path.
// i18n: model-facing
pub fn skill_text(names: &[String]) -> String {
    let lib = library();
    let mut out = String::new();
    for s in names {
        let p = PathBuf::from(s);
        let md = if p.is_absolute() {
            Some(if p.is_dir() { p.join("SKILL.md") } else { p })
        } else if let Some(l) = lib.iter().find(|l| l.name.eq_ignore_ascii_case(s)) {
            Some(l.path.clone())
        } else {
            find_skill(s).map(|d| d.join("SKILL.md"))
        };
        let Some(md) = md.filter(|m| m.is_file()) else {
            out.push_str(&format!("- {s}: a skill you may already have under this name; use it when it fits.\n"));
            continue;
        };
        match std::fs::read_to_string(&md) {
            Ok(text) => {
                let body = text.trim_start_matches('\u{feff}');
                // The front matter is for Agent Center; the member gets the instructions.
                let body = body.strip_prefix("---").and_then(|b| b.find("\n---").map(|i| &b[i + 4..])).unwrap_or(body).trim();
                let body: String = body.chars().take(SKILL_TEXT_MAX).collect();
                out.push_str(&format!("\n### Skill: {s}\n{body}\n"));
            }
            Err(_) => out.push_str(&format!("- {s}: read {} and follow it.\n", md.display())),
        }
    }
    out
}

/// The `description:` of a SKILL.md's front matter.
fn skill_description(skill_md: &std::path::Path) -> Option<String> {
    skill_front(skill_md, "description")
}

/// One key of a SKILL.md's front matter (`description:`, `for:`), or nothing.
fn skill_front(skill_md: &std::path::Path, key: &str) -> Option<String> {
    front_of(&std::fs::read_to_string(skill_md).ok()?, key)
}

/// The same, from the text of a SKILL.md.
fn front_of(text: &str, key: &str) -> Option<String> {
    let body = text.trim_start_matches('\u{feff}').strip_prefix("---")?;
    let head = &body[..body.find("\n---")?];
    let prefix = format!("{key}:");
    head.lines().find_map(|l| l.trim().strip_prefix(prefix.as_str()).map(|d| d.trim().trim_matches(['"', '\'']).to_string())).filter(|d| !d.is_empty())
}

/// What a member running as a team agent is told with its role, besides
/// the team's own words: the system prompt, where its protocol has no place
/// for one, and the skills it may use.
// i18n: model-facing
pub fn brief_text(profile: &AgentProfile) -> String {
    let Some(x) = profile.extras.as_ref() else { return String::new() };
    let mut out = String::new();
    if let Some(words) = x.system_prompt() {
        if supports(profile.protocol).system_prompt == Support::Brief {
            out.push_str(&format!("\nInstructions from the user for you as {}, to keep throughout your work:\n{}\n", profile.name, words));
        }
    }
    if !x.skills.is_empty() {
        out.push_str("\nSkills the user gave you. Before work a skill is about, read its SKILL.md and follow it:\n");
        for s in &x.skills {
            let p = PathBuf::from(s);
            let folder = if p.is_absolute() { Some(p) } else { find_skill(s) };
            match folder {
                Some(dir) => {
                    let md = dir.join("SKILL.md");
                    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| s.clone());
                    let what = skill_description(&md).map(|d| format!(" — {d}")).unwrap_or_default();
                    out.push_str(&format!("- {name}: {}{what}\n", md.display()));
                }
                None => out.push_str(&format!("- {s}: a skill you may already have under this name; use it when it fits.\n")),
            }
        }
    }
    out
}

/// One line per agent for Agent Center: who it is, what it runs on, where,
/// what it is for.
// i18n: model-facing
pub fn describe(profile: &AgentProfile) -> Option<String> {
    let x = profile.extras.as_ref()?;
    let place = match profile.location() {
        Location::Cloud => "Cloud Agent (works on a cloud service)",
        Location::Local => "Local Agent (works on the user's own machine or network)",
    };
    let mut bits = vec![format!("team agent built on {}", x.base), place.to_string()];
    if !x.category.is_empty() {
        bits.push(format!("category: {}", x.category));
    }
    if !x.effort.is_empty() {
        bits.push(format!("reasoning effort: {}", x.effort));
    }
    if profile.protocol == Protocol::N8n {
        bits.push("an n8n workflow: it takes one task at a time and hands back one result, has no tools, and cannot be the leader".into());
    }
    if !x.mcp_servers.is_empty() {
        bits.push(format!("MCP: {}", x.mcp_servers.iter().map(|m| m.name.as_str()).collect::<Vec<_>>().join(", ")));
    }
    if !x.skills.is_empty() {
        bits.push(format!("skills: {}", x.skills.join(", ")));
    }
    let what = if x.description.is_empty() { String::new() } else { format!(" — good for: {}", x.description) };
    Some(format!("{}{what}", bits.join("; ")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_skill_s_name_stays_inside_the_library() {
        assert!(skill_name_ok("web-research"));
        assert!(skill_name_ok("寫報告 v2"));
        assert!(!skill_name_ok(""));
        assert!(!skill_name_ok("../etc"));
        assert!(!skill_name_ok("a/b"));
        assert!(!skill_name_ok(".hidden"));
        assert!(!skill_name_ok(" padded"));
    }

    #[test]
    fn the_market_starts_with_the_preset_skills_once() {
        let dir = std::env::temp_dir().join(format!("coucou-presets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        super::seed_presets(&dir);
        assert_eq!(super::PRESET_SKILLS.len(), 15);
        // Agent Center's own skill goes in with them, marked as its own.
        for (name, md) in super::CENTER_SKILLS {
            let p = dir.join(name).join("SKILL.md");
            assert!(p.is_file(), "{name}");
            assert!(md.contains("for: agent-center") && md.contains("description:"), "{name}");
            assert!(super::library_skill(name.to_string(), p).for_center, "{name}");
        }
        assert!(dir.join(super::DEFAULT_CENTER_SKILL).join("SKILL.md").is_file());
        for (name, md) in super::PRESET_SKILLS {
            let p = dir.join(name).join("SKILL.md");
            assert!(p.is_file(), "{name}");
            assert_eq!(super::skill_front(&p, "name").as_deref(), Some(*name), "{name}");
            assert!(super::skill_front(&p, "source").is_some_and(|u| u.starts_with("https://github.com/")), "{name}");
            for key in ["description", "stars", "stars-at", "role", "category"] {
                assert!(super::skill_front(&p, key).is_some(), "{name} lacks {key}");
            }
            // Presets are for members: never Agent Center's own.
            assert!(!md.contains("for: agent-center"), "{name}");
            let got = super::library_skill(name.to_string(), p.clone());
            assert!(!got.for_center && got.source.contains("github.com") && !got.stars.is_empty() && !got.role.is_empty() && !got.category.is_empty(), "{name}");
        }
        // A preset copied before it had a category takes the preset's.
        let bare = dir.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::write(bare.join("SKILL.md"), "---\nname: caveman\ndescription: x\n---\nBody").unwrap();
        assert_eq!(super::library_skill("caveman".into(), bare.join("SKILL.md")).category, "工具自動化");
        assert_eq!(super::library_skill("bare".into(), bare.join("SKILL.md")).category, "");
        // Deleted by the person: not put back on the next start.
        std::fs::remove_dir_all(dir.join("caveman")).unwrap();
        std::fs::remove_dir_all(dir.join(super::DEFAULT_CENTER_SKILL)).unwrap();
        super::seed_presets(&dir);
        assert!(!dir.join("caveman").exists());
        assert!(!dir.join(super::DEFAULT_CENTER_SKILL).exists());
        // A library that is not there yet is made with everything in it.
        let _ = std::fs::remove_dir_all(&dir);
        super::seed_presets(&dir);
        assert!(dir.join(super::DEFAULT_CENTER_SKILL).join("SKILL.md").is_file() && dir.join("caveman").join("SKILL.md").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_skill_s_front_matter_says_who_it_is_for() {
        let dir = std::env::temp_dir().join(format!("coucou-skill-front-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let md = dir.join("SKILL.md");
        std::fs::write(&md, "---\nname: plan\ndescription: \"How to size a request\"\nfor: agent-center\n---\n# Body\n").unwrap();
        assert_eq!(super::skill_front(&md, "description").as_deref(), Some("How to size a request"));
        assert_eq!(super::skill_front(&md, "for").as_deref(), Some("agent-center"));
        assert_eq!(super::skill_front(&md, "name").as_deref(), Some("plan"));
        std::fs::write(&md, "no front matter").unwrap();
        assert_eq!(super::skill_front(&md, "for"), None);
        // The default skill Agent Center starts with is its own, with a description.
        assert!(super::DEFAULT_CENTER_SKILL_MD.contains("for: agent-center") && super::DEFAULT_CENTER_SKILL_MD.contains("description:"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    fn natives() -> Vec<AgentProfile> {
        let mut claude = AgentProfile::copilot();
        claude.id = "claude".into();
        claude.name = "Claude Code".into();
        claude.command = "claude".into();
        claude.protocol = Protocol::Claude;
        claude.model = "sonnet".into();
        let mut agy = AgentProfile::copilot();
        agy.id = "agy".into();
        agy.protocol = Protocol::Agy;
        vec![AgentProfile::copilot(), claude, agy]
    }

    fn reviewer() -> TeamAgent {
        TeamAgent {
            id: "ta-reviewer".into(),
            name: "審查員".into(),
            base: "claude".into(),
            model: "opus".into(),
            system_prompt: "You review code strictly.".into(),
            mcp: vec![Mcp { name: "docs".into(), url: "https://example.test/mcp".into(), ..Default::default() }],
            skills: vec!["code-review".into()],
            description: "審查程式碼".into(),
            category: "程式開發".into(),
            effort: "high".into(),
        }
    }

    #[test]
    fn a_team_agent_runs_on_its_base_with_its_own_additions() {
        let doc = TeamAgents { agents: vec![reviewer()] };
        let p = &doc.profiles(&natives())[0];
        assert_eq!(p.id, "ta-reviewer");
        assert_eq!(p.command, "claude");
        assert_eq!(p.protocol, Protocol::Claude);
        assert_eq!(p.model, "opus");
        // The base's key, never one of its own.
        assert_eq!(p.secret_key(), "agent:claude");
        let x = p.extras.as_ref().unwrap();
        assert_eq!(x.mcp_servers[0].url, "https://example.test/mcp");
        assert_eq!(x.system_prompt(), Some("You review code strictly."));
        // An empty model is the base's.
        let mut plain = reviewer();
        plain.model.clear();
        assert_eq!(TeamAgents { agents: vec![plain], ..Default::default() }.profiles(&natives())[0].model, "sonnet");
    }

    #[test]
    fn new_teams_take_team_agents_only_and_old_teams_still_run() {
        // An older file still says which kind new teams used: it is read past.
        let doc: TeamAgents = serde_json::from_value(serde_json::json!({ "source": "native", "agents": [reviewer()] })).unwrap();
        let ids = |v: Vec<AgentProfile>| v.into_iter().map(|p| p.id).collect::<Vec<_>>();
        assert_eq!(ids(doc.choices(&natives())), ["ta-reviewer"]);
        // A team naming a native agent from before can still run.
        assert_eq!(ids(doc.runnable(&natives())), ["copilot", "claude", "agy", "ta-reviewer"]);
        assert!(!serde_json::to_string(&doc).unwrap().contains("source"));
    }

    #[test]
    fn a_team_agent_is_cloud_or_local_as_its_base_and_an_n8n_one_says_what_it_can_do() {
        let mut list = natives();
        // An n8n node is local whatever it was set to.
        list.push(AgentProfile { id: "flow".into(), name: "Report flow".into(), protocol: Protocol::N8n, location: Some(Location::Cloud), ..Default::default() });
        let mut on_flow = reviewer();
        on_flow.id = "ta-flow".into();
        on_flow.base = "flow".into();
        let profiles = TeamAgents { agents: vec![reviewer(), on_flow] }.profiles(&list);
        assert_eq!(profiles[0].location(), Location::Cloud);
        assert_eq!(profiles[1].location(), Location::Local);
        // A workflow is not given MCP servers; Agent Center hears what it is.
        assert!(profiles[1].extras.as_ref().unwrap().mcp_servers.is_empty());
        let line = describe(&profiles[1]).unwrap();
        assert!(line.contains("Local Agent") && line.contains("cannot be the leader"), "{line}");
        let line = describe(&profiles[0]).unwrap();
        assert!(line.contains("Cloud Agent") && line.contains("category: 程式開發"), "{line}");
    }

    #[test]
    fn its_effort_goes_with_it_when_the_base_takes_one() {
        let p = &TeamAgents { agents: vec![reviewer()] }.profiles(&natives())[0];
        assert_eq!(p.extras.as_ref().unwrap().effort, "high");
        let mut odd = reviewer();
        odd.effort = "turbo".into();
        assert_eq!(TeamAgents { agents: vec![odd] }.profiles(&natives())[0].extras.as_ref().unwrap().effort, "");
        assert_eq!(effort_of(" XHigh "), Some("xhigh"));
    }

    #[test]
    fn a_team_agent_on_a_base_that_is_gone_is_left_out() {
        let mut lost = reviewer();
        lost.base = "gone".into();
        assert!(TeamAgents { agents: vec![lost], ..Default::default() }.profiles(&natives()).is_empty());
    }

    #[test]
    fn what_cannot_be_saved_says_why() {
        let mut bad = reviewer();
        bad.id = "copilot".into();
        bad.mcp.push(Mcp { name: "x y".into(), ..Default::default() });
        bad.mcp.push(Mcp { name: "web".into(), url: "ftp://x".into(), ..Default::default() });
        let doc = TeamAgents { agents: vec![bad.clone(), bad], ..Default::default() };
        let problems = doc.problems(&natives()).join("\n");
        for needle in ["Two team agents", "Settings → Agent Provider", "'x y' cannot be", "needs a command or a URL", "http:// or https://"] {
            assert!(problems.contains(needle), "missing: {needle}\n{problems}");
        }
        assert!(TeamAgents { agents: vec![reviewer()], ..Default::default() }.problems(&natives()).is_empty());
    }

    #[test]
    fn a_member_is_told_what_its_protocol_cannot_take_and_its_skills() {
        let dir = std::env::temp_dir().join(format!("coucou-skill-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: tidy\ndescription: Keeps imports tidy.\n---\nBody").unwrap();
        let mut a = reviewer();
        a.skills = vec![dir.to_string_lossy().to_string(), "no-such-skill-here".into()];
        // Claude Code takes the system prompt itself: the brief has only the skills.
        let claude = &TeamAgents { agents: vec![a.clone()], ..Default::default() }.profiles(&natives())[0];
        let text = brief_text(claude);
        assert!(!text.contains("review code strictly"));
        assert!(text.contains("Keeps imports tidy.") && text.contains("SKILL.md") && text.contains("no-such-skill-here"));
        // Copilot over ACP has no place for one: the brief carries it.
        a.base = "copilot".into();
        let copilot = &TeamAgents { agents: vec![a.clone()], ..Default::default() }.profiles(&natives())[0];
        assert!(brief_text(copilot).contains("review code strictly"));
        // Antigravity is not given MCP servers it would share with the whole folder.
        a.base = "agy".into();
        let agy = &TeamAgents { agents: vec![a], ..Default::default() }.profiles(&natives())[0];
        assert!(agy.extras.as_ref().unwrap().mcp_servers.is_empty());
        assert!(brief_text(&AgentProfile::copilot()).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
