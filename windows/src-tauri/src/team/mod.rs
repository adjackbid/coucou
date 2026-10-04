// Teams: several coding agents working on one goal, with Coucou in the middle.
//
// The CLIs have no way to talk to each other, so nothing here asks them to.
// Every member talks to Coucou only — through the team's MCP tools — and
// Coucou keeps the one record of who is doing what, who waits on whom and
// what has been delivered:
//
//   state.rs         what happened (events) and what follows from it (state)
//   store.rs         the events on disk, one line each, replayed at start
//   tools.rs         what a member can say and do: the eight team tools
//   brief.rs         the words a member is given: its role, a task, a nudge
//   mcp.rs           the tools as an MCP server, behind coucou-team-mcp.exe
//   orchestrator.rs  who gets the next turn, and what it is told
//   screen.rs        what each member's agent is doing, for the live screens
//
// What a screen shows is always read from that record, never guessed from
// what an agent wrote in passing.

pub mod brief;
pub mod mcp;
pub mod orchestrator;
pub mod screen;
pub mod state;
pub mod store;
pub mod tools;

use serde::{Deserialize, Serialize};

/// The person at the keyboard, as a sender or a recipient.
pub const YOU: &str = "you";
/// Coucou itself: task hand-outs, delivery notices, nudges.
pub const SYSTEM: &str = "system";

/// A team as it is set up: the goal, who is in it, how they work together.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub id: String,
    pub name: String,
    /// What the person wants done, in their own words.
    pub goal: String,
    #[serde(default)]
    pub scope: Vec<String>,
    /// The one folder every member works in.
    pub work_dir: String,
    /// The member who breaks the goal down, hands out tasks and reviews.
    pub leader: String,
    /// Members act without a card for safe steps (see policy.rs); what is
    /// dangerous still asks. Off: every permission request is a card.
    #[serde(default)]
    pub auto_approve: bool,
    pub members: Vec<MemberConfig>,
    #[serde(default)]
    pub links: Vec<Link>,
    /// What the person expects to hold at the end.
    #[serde(default)]
    pub expected: Vec<Expected>,
    /// Members may message each other; off, only the leader and whoever a
    /// link joins them to.
    #[serde(default = "yes")]
    pub direct_talk: bool,
    /// Members see the whole board; off, only their own tasks.
    #[serde(default = "yes")]
    pub shared_board: bool,
    /// Turns the whole team may take before it pauses and waits for the person.
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    /// How the team's office looks in the Office view: warm, nordic, studio
    /// or premium; empty leaves it to Coucou (by the team's size).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub office_theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemberConfig {
    /// Short and plain (`ai1`): what members call each other in tool calls.
    pub id: String,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub duty: String,
    /// The agent profile (Settings → Agents) this member runs as.
    pub agent: String,
    /// The model, instead of the agent's own. Empty: the agent's.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    /// `from` hands something to `to`.
    Delivery,
    /// The two may message each other.
    Talk,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub from: String,
    pub to: String,
    pub kind: LinkKind,
    /// What is handed over, for a delivery ("product images").
    #[serde(default)]
    pub what: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub name: String,
    #[serde(default)]
    pub detail: String,
}

fn yes() -> bool {
    true
}

fn default_max_turns() -> u32 {
    60
}

/// Ids travel in pipe names, file names and tool calls: letters, digits, `-`, `_`.
pub fn is_plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The largest picture the Office will show of a deliverable.
pub const PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// A deliverable's picture, if it is one: an image file inside the team's
/// work folder, small enough to show. Nothing outside the folder is read,
/// whatever the locator says (`..`, another drive, a link out).
pub fn preview_path(work_dir: &str, locator: &str) -> Result<std::path::PathBuf, String> {
    let lower = locator.to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp"].iter().any(|ext| lower.ends_with(&format!(".{ext}"))) {
        return Err("Not a picture.".into());
    }
    let root = std::fs::canonicalize(work_dir).map_err(|_| "The work folder is not there.".to_string())?;
    let path = std::path::Path::new(locator);
    let full = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
    let full = std::fs::canonicalize(&full).map_err(|_| format!("{locator} is not there."))?;
    if !full.starts_with(&root) {
        return Err("Only pictures in the team's work folder are shown.".into());
    }
    let size = std::fs::metadata(&full).map_err(|e| e.to_string())?.len();
    if size > PREVIEW_MAX_BYTES {
        return Err("The picture is too large to preview.".into());
    }
    Ok(full)
}

impl TeamConfig {
    pub fn member(&self, id: &str) -> Option<&MemberConfig> {
        self.members.iter().find(|m| m.id == id)
    }

    pub fn has_member(&self, id: &str) -> bool {
        self.member(id).is_some()
    }

    /// May `from` message `to`? The leader reaches everyone and everyone
    /// reaches the leader and the person; otherwise it takes direct talk or a
    /// link between the two, in either direction.
    pub fn may_talk(&self, from: &str, to: &str) -> bool {
        if from == to {
            return false;
        }
        if to == YOU || from == YOU || from == SYSTEM {
            return true;
        }
        if from == self.leader || to == self.leader || self.direct_talk {
            return true;
        }
        self.links.iter().any(|l| (l.from == from && l.to == to) || (l.from == to && l.to == from))
    }

    /// Everything that would stop this team from starting, in plain words.
    /// `agents` are the profile ids that exist in settings.
    pub fn problems(&self, agents: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        if !is_plain_id(&self.id) {
            out.push("The team id may only use letters, digits, '-' and '_'.".to_string());
        }
        if self.goal.trim().is_empty() {
            out.push("The team has no goal.".to_string());
        }
        if self.members.is_empty() {
            out.push("The team has no members.".to_string());
        }
        let dir = std::path::Path::new(self.work_dir.trim());
        if self.work_dir.trim().is_empty() || !dir.is_absolute() {
            out.push("The work folder must be a full path.".to_string());
        } else if !dir.is_dir() {
            out.push(format!("The work folder {} does not exist.", dir.display()));
        }
        let mut seen = std::collections::BTreeSet::new();
        for m in &self.members {
            if !is_plain_id(&m.id) || m.id == YOU || m.id == SYSTEM || m.id == "all" || m.id == "leader" {
                out.push(format!("'{}' cannot be a member id.", m.id));
            }
            if !seen.insert(m.id.as_str()) {
                out.push(format!("Two members are called '{}'.", m.id));
            }
            if !agents.iter().any(|a| *a == m.agent) {
                out.push(format!("{} runs as agent '{}', which is not in Settings → Agents.", m.name, m.agent));
            }
        }
        if !self.has_member(&self.leader) {
            out.push(format!("The leader '{}' is not a member.", self.leader));
        }
        for l in &self.links {
            if !self.has_member(&l.from) || !self.has_member(&l.to) {
                out.push(format!("A link joins '{}' and '{}', and one of them is not a member.", l.from, l.to));
            }
        }
        out
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// The shopping-site team of the design drafts: AI 1 plans and reviews,
    /// AI 4 makes images for AI 3, AI 3 builds for AI 2, AI 2 tests.
    pub fn shop(work_dir: &str) -> TeamConfig {
        let member = |id: &str, name: &str, role: &str| MemberConfig {
            id: id.into(),
            name: name.into(),
            role: role.into(),
            duty: String::new(),
            agent: "copilot".into(),
            model: String::new(),
            color: String::new(),
        };
        let link = |from: &str, to: &str, kind, what: &str| Link { from: from.into(), to: to.into(), kind, what: what.into() };
        TeamConfig {
            id: "shop".into(),
            name: "購物網站團隊".into(),
            goal: "建立一個購物網站,包含商品列表、購物車與會員登入".into(),
            scope: vec!["商品目錄".into(), "購物車".into(), "會員登入".into()],
            work_dir: work_dir.into(),
            leader: "ai1".into(),
            auto_approve: true,
            members: vec![
                member("ai1", "AI 1", "規劃"),
                member("ai2", "AI 2", "執行整合"),
                member("ai3", "AI 3", "網站開發"),
                member("ai4", "AI 4", "圖片生成"),
            ],
            links: vec![
                link("ai4", "ai3", LinkKind::Delivery, "圖片素材"),
                link("ai3", "ai2", LinkKind::Delivery, "網站版本"),
            ],
            expected: vec![],
            direct_talk: false,
            shared_board: true,
            max_turns: 60,
            office_theme: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::shop;
    use super::*;

    #[test]
    fn only_pictures_inside_the_work_folder_are_previewed() {
        let base = std::env::temp_dir().join(format!("coucou-preview-{}", std::process::id()));
        let work = base.join("work");
        std::fs::create_dir_all(work.join("public")).unwrap();
        std::fs::write(work.join("public").join("shoe.png"), b"png").unwrap();
        std::fs::write(work.join("notes.md"), b"md").unwrap();
        std::fs::write(base.join("secret.png"), b"png").unwrap();
        let w = work.to_string_lossy().to_string();
        assert!(preview_path(&w, "public/shoe.png").is_ok());
        assert!(preview_path(&w, &work.join("public").join("shoe.png").to_string_lossy()).is_ok());
        assert!(preview_path(&w, "notes.md").is_err());
        assert!(preview_path(&w, "../secret.png").is_err());
        assert!(preview_path(&w, &base.join("secret.png").to_string_lossy()).is_err());
        assert!(preview_path(&w, "public/gone.png").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_team_that_cannot_start_says_why() {
        let dir = std::env::temp_dir();
        let agents = vec!["copilot".to_string()];
        assert!(shop(&dir.to_string_lossy()).problems(&agents).is_empty());

        let mut bad = shop("relative/path");
        bad.leader = "nobody".into();
        bad.members[1].id = "ai1".into();
        bad.members[2].agent = "gone".into();
        bad.members[3].id = "you".into();
        let problems = bad.problems(&agents).join("\n");
        for needle in ["full path", "'nobody' is not a member", "Two members are called 'ai1'", "agent 'gone'", "'you' cannot be a member id"] {
            assert!(problems.contains(needle), "missing: {needle}\n{problems}");
        }
    }

    #[test]
    fn who_may_message_whom_follows_the_links() {
        let team = shop("D:\\x");
        // The leader reaches everyone, and everyone reaches the leader and the person.
        assert!(team.may_talk("ai1", "ai4") && team.may_talk("ai4", "ai1") && team.may_talk("ai4", YOU));
        // A link joins both ends.
        assert!(team.may_talk("ai4", "ai3") && team.may_talk("ai3", "ai4"));
        // No link, no direct talk.
        assert!(!team.may_talk("ai4", "ai2"));
        let mut open = team.clone();
        open.direct_talk = true;
        assert!(open.may_talk("ai4", "ai2"));
        assert!(!open.may_talk("ai4", "ai4"));
    }

    #[test]
    fn a_team_file_needs_only_what_matters() {
        let json = r#"{"id":"t","name":"T","goal":"g","workDir":"D:\\x","leader":"a",
            "members":[{"id":"a","name":"A","role":"lead","agent":"copilot"}]}"#;
        let team: TeamConfig = serde_json::from_str(json).unwrap();
        assert!(team.direct_talk && team.shared_board && !team.auto_approve);
        assert_eq!(team.max_turns, 60);
    }
}
