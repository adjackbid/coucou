// Team agents (Teamwork → Agent 設定): agents of the person's own making,
// each built on a native agent of Settings → Agents. A team agent keeps its
// base's command, environment and key, and adds its own name, model, system
// prompt, MCP servers and skills, and a description the secretary reads to
// know what it is good for. Nothing here holds a key: the base's stays in
// the Credential Manager, under the base's name.
//
// Stored in %APPDATA%\Coucou\team-agents.json, beside constitution.json,
// together with the secretary's switch: build teams from the native agents
// (the default, so existing teams stay as they are) or from these.
//
// Where they are run, a team agent is simply one more AgentProfile (`profiles`):
// its base's, under its own id, with `key_of` naming the base and `extras`
// carrying what it adds. A team that names a native agent runs as before.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::acp::{AgentProfile, Extras, McpServer, Protocol};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Teams are built from Settings → Agents.
    #[default]
    Native,
    /// Teams are built from the team agents only.
    Team,
}

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
    /// The native agent (Settings → Agents) it runs on.
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
    /// What it is for, in the person's words: the secretary picks by it.
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamAgents {
    #[serde(default)]
    pub source: Source,
    #[serde(default)]
    pub agents: Vec<TeamAgent>,
}

/// What a protocol can take of a team agent: natively, through the member's
/// brief, or not at all. Shown on the Agent 設定 page.
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
}

pub fn supports(protocol: Protocol) -> Supports {
    match protocol {
        // --append-system-prompt-file, --mcp-config.
        Protocol::Claude => Supports { system_prompt: Support::Native, mcp: Support::Native, skills: Support::Brief },
        // developerInstructions on thread/start, mcp_servers.* overrides.
        Protocol::Codex => Supports { system_prompt: Support::Native, mcp: Support::Native, skills: Support::Brief },
        // ACP has no system prompt; MCP servers go with session/new (or Copilot's own file).
        Protocol::Acp => Supports { system_prompt: Support::Brief, mcp: Support::Native, skills: Support::Brief },
        // Antigravity reads MCP servers only from the work folder's .agents,
        // which every member shares: one member's servers would be everyone's.
        Protocol::Agy => Supports { system_prompt: Support::Brief, mcp: Support::No, skills: Support::Brief },
    }
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
    std::fs::write(&file, json).map_err(|e| format!("Could not save the team agents: {e}"))
}

impl TeamAgents {
    /// What stops these from being saved, in plain words.
    pub fn problems(&self, natives: &[AgentProfile]) -> Vec<String> {
        let mut out = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for a in &self.agents {
            let name = if a.name.trim().is_empty() { a.id.as_str() } else { a.name.trim() };
            if !crate::team::is_plain_id(&a.id) {
                out.push(format!("Team agent '{name}': its id may only use letters, digits, '-' and '_'."));
            }
            if !seen.insert(a.id.as_str()) {
                out.push(format!("Two team agents have the id '{}'.", a.id));
            }
            if natives.iter().any(|n| n.id == a.id) {
                out.push(format!("Team agent '{name}' has the id of an agent in Settings → Agents."));
            }
            if a.name.trim().is_empty() {
                out.push(format!("Team agent '{}' has no name.", a.id));
            }
            let mut servers = std::collections::BTreeSet::new();
            for m in &a.mcp {
                if !crate::team::is_plain_id(m.name.trim()) || m.name.trim() == crate::acp::TEAM_SERVER {
                    out.push(format!("Team agent '{name}': '{}' cannot be an MCP server's name (letters, digits, '-' and '_').", m.name));
                } else if !servers.insert(m.name.trim()) {
                    out.push(format!("Team agent '{name}' has two MCP servers called '{}'.", m.name.trim()));
                }
                let url = m.url.trim();
                if url.is_empty() && m.command.trim().is_empty() {
                    out.push(format!("Team agent '{name}': the MCP server '{}' needs a command or a URL.", m.name));
                }
                if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) {
                    out.push(format!("Team agent '{name}': the MCP server '{}' URL must start with http:// or https://.", m.name));
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

    /// Every profile a team may run as: the native ones and the team agents.
    pub fn runnable(&self, natives: &[AgentProfile]) -> Vec<AgentProfile> {
        let mut all = natives.to_vec();
        all.extend(self.profiles(natives).into_iter().filter(|p| !natives.iter().any(|n| n.id == p.id)));
        all
    }

    /// The profiles a new team is built from, as the switch says.
    pub fn choices(&self, natives: &[AgentProfile]) -> Vec<AgentProfile> {
        match self.source {
            Source::Native => natives.to_vec(),
            Source::Team => self.profiles(natives),
        }
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

/// One line per agent for the secretary: who it is, what it runs on, what it is for.
pub fn describe(profile: &AgentProfile) -> Option<String> {
    let x = profile.extras.as_ref()?;
    let mut bits = vec![format!("team agent built on {}", x.base)];
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
        }
    }

    #[test]
    fn a_team_agent_runs_on_its_base_with_its_own_additions() {
        let doc = TeamAgents { source: Source::Native, agents: vec![reviewer()] };
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
    fn the_switch_decides_what_new_teams_are_built_from_and_old_teams_still_run() {
        let mut doc = TeamAgents { source: Source::Native, agents: vec![reviewer()] };
        let ids = |v: Vec<AgentProfile>| v.into_iter().map(|p| p.id).collect::<Vec<_>>();
        assert_eq!(ids(doc.choices(&natives())), ["copilot", "claude", "agy"]);
        doc.source = Source::Team;
        assert_eq!(ids(doc.choices(&natives())), ["ta-reviewer"]);
        // Whatever the switch, a team naming either kind can run.
        assert_eq!(ids(doc.runnable(&natives())), ["copilot", "claude", "agy", "ta-reviewer"]);
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
        for needle in ["Two team agents", "Settings → Agents", "'x y' cannot be", "needs a command or a URL", "http:// or https://"] {
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
