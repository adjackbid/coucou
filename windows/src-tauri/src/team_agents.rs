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

fn profile_of(a: &TeamAgent, natives: &[AgentProfile]) -> Option<AgentProfile> {
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

/// Where a skill named only by its name lives, if it is in one of the usual places.
fn find_skill(name: &str) -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("USERPROFILE")?);
    [home.join(".claude").join("skills"), home.join(".codex").join("skills"), home.join(".agents").join("skills"), home.join(".copilot").join("skills")]
        .into_iter()
        .map(|d| d.join(name))
        .find(|d| d.join("SKILL.md").is_file())
}

/// The `description:` of a SKILL.md's front matter.
fn skill_description(skill_md: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(skill_md).ok()?;
    let body = text.trim_start_matches('\u{feff}').strip_prefix("---")?;
    let head = &body[..body.find("\n---")?];
    head.lines().find_map(|l| l.trim().strip_prefix("description:").map(|d| d.trim().trim_matches(['"', '\'']).to_string())).filter(|d| !d.is_empty())
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
