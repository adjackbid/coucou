// The person's constitution: rules every agent Coucou drives must keep —
// every member of every team, and the chat's agent — whatever a team's way
// of working. A rule says when it applies (one of Coucou's own checks, or
// words to look for in a command or a path) and what happens then:
//
// - 要問我 (`Ask`): the person is asked with a card, even in 自主協作, and
//   the card says which rule it is;
// - 絕對不能做 (`Never`): the request is refused on the spot. No card is
//   shown — nothing to click by mistake — and the member is told why.
//
// The rules are also written into each member's brief (brief.rs), so it
// knows them before it tries. Rules are judged by Coucou from the request
// itself, never by a model: a Never rule always holds.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::policy::{self, Danger, Kind, Request, Scope};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    /// The general rules alone decide.
    #[default]
    Off,
    Ask,
    Never,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    /// What the rule is about, in the person's words: shown on cards, told to members.
    pub text: String,
    pub level: Level,
    /// One of Coucou's own checks (`BUILTIN`); empty for a rule of the person's own.
    #[serde(default)]
    pub check: String,
    /// The person's own rule: words to look for in the command or a path, `*` for anything.
    #[serde(default)]
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Constitution {
    pub rules: Vec<Rule>,
}

/// Coucou's own checks, with the level they start with.
const BUILTIN: [(&str, Level); 7] = [
    ("git-folder", Level::Never),
    ("drive-root", Level::Never),
    ("install", Level::Ask),
    ("git-destructive", Level::Ask),
    ("send-out", Level::Ask),
    ("system", Level::Ask),
    ("download", Level::Ask),
];

/// What one of Coucou's checks says, in the language of the moment.
fn builtin_text(check: &str) -> String {
    match check {
        "git-folder" => tr!("不能刪除或搬走 .git 資料夾(整個版本紀錄會不見)", "Don't delete or move a .git folder (the whole version history would be lost)"),
        "drive-root" => tr!(
            "不能刪除或格式化整顆磁碟,或 Windows、Program Files、使用者資料夾這類系統資料夾",
            "Don't delete or format a whole drive, or a system folder such as Windows, Program Files or the user folders"
        ),
        "install" => tr!("安裝軟體或套件之前要先問我", "Ask me before installing software or packages"),
        "git-destructive" => tr!("會丟掉變更的 git 指令(reset --hard、clean、強制推送)之前要先問我", "Ask me before git commands that throw changes away (reset --hard, clean, force push)"),
        "send-out" => tr!("對外發送或發布(git push、npm publish、寄信、上傳)之前要先問我", "Ask me before sending or publishing anything (git push, npm publish, email, uploads)"),
        "system" => tr!("變更系統(登錄檔、服務、關閉程式、權限)之前要先問我", "Ask me before changing the system (registry, services, closing programs, permissions)"),
        "download" => tr!("從網路下載檔案之前要先問我", "Ask me before downloading files from the internet"),
        other => other.to_string(),
    }
}

impl Constitution {
    /// Coucou's checks at their starting levels.
    pub fn starting() -> Self {
        Self {
            rules: BUILTIN.iter().map(|(id, level)| Rule { id: (*id).into(), text: builtin_text(id), level: *level, check: (*id).into(), patterns: vec![] }).collect(),
        }
    }

    /// Checks added to Coucou after the person last saved join at their starting levels.
    fn completed(mut self) -> Self {
        for (i, (id, level)) in BUILTIN.iter().enumerate() {
            if !self.rules.iter().any(|r| r.check == *id) {
                self.rules.insert(i.min(self.rules.len()), Rule { id: (*id).into(), text: builtin_text(id), level: *level, check: (*id).into(), patterns: vec![] });
            }
        }
        self
    }

    /// Coucou's own checks in the language of the moment, whichever one they
    /// were saved in (the person cannot reword them; their own rules stay as written).
    fn localized(mut self) -> Self {
        for rule in &mut self.rules {
            if BUILTIN.iter().any(|(id, _)| !rule.check.is_empty() && rule.check == *id) {
                rule.text = builtin_text(&rule.check);
            }
        }
        self
    }

    /// The strictest rule `request` falls under, if any. `work_dir` is where
    /// the agent works: relative paths are read against it.
    pub fn judge(&self, request: &Request, work_dir: &Path) -> Option<(Level, Rule)> {
        let scope = Scope::new(work_dir);
        let command = request.command.as_deref().unwrap_or("");
        let mut removed: Vec<String> = if request.kind == Kind::Execute { policy::removal_targets(command) } else { vec![] };
        if matches!(request.kind, Kind::Delete | Kind::Move) {
            removed.extend(request.paths.iter().cloned());
        }
        let dangers = || policy::dangers_of(&scope, request);
        let mut best: Option<(Level, Rule)> = None;
        for rule in self.rules.iter().filter(|r| r.level != Level::Off) {
            let hit = match rule.check.as_str() {
                "git-folder" => removed.iter().any(|p| has_git_folder(p)),
                "drive-root" => removed.iter().any(|p| p.starts_with("<format>") || is_vital(&scope, p)),
                "install" => dangers().contains(&Danger::Installs),
                "git-destructive" => dangers().contains(&Danger::DestructiveGit),
                "send-out" => dangers().contains(&Danger::SendsOut),
                "system" => dangers().contains(&Danger::System),
                "download" => dangers().contains(&Danger::Downloads),
                "" => rule.patterns.iter().any(|p| matches_text(p, command) || request.paths.iter().any(|path| matches_text(p, path))),
                _ => false,
            };
            if hit && best.as_ref().is_none_or(|(l, _)| rule.level > *l) {
                best = Some((rule.level, rule.clone()));
            }
        }
        best
    }

    /// The rules in force, for a member's brief; empty when there are none.
    // i18n: model-facing
    pub fn for_brief(&self) -> String {
        let never: Vec<&str> = self.rules.iter().filter(|r| r.level == Level::Never).map(|r| r.text.as_str()).collect();
        let ask: Vec<&str> = self.rules.iter().filter(|r| r.level == Level::Ask).map(|r| r.text.as_str()).collect();
        if never.is_empty() && ask.is_empty() {
            return String::new();
        }
        let mut out = String::from("\nThe user's constitution — rules you must keep, whatever the task:\n");
        for t in never {
            out.push_str(&format!("- Never: {t}. Agent Center refuses such a request; do not try it, find another way or tell the leader.\n"));
        }
        for t in ask {
            out.push_str(&format!("- Ask the user first: {t}. Agent Center shows the user a card; it may be refused.\n"));
        }
        out
    }
}

/// A path with a `.git` folder in it (`.git`, `repo/.git`, `.git\objects`).
fn has_git_folder(path: &str) -> bool {
    let p = path.trim().trim_matches(['"', '\'']);
    p.split(['\\', '/']).any(|part| part.eq_ignore_ascii_case(".git") || part.eq_ignore_ascii_case(".git*"))
}

/// A whole drive, or one of the folders Windows and every program live in —
/// or everything inside one (`C:\*`).
fn is_vital(scope: &Scope, raw: &str) -> bool {
    let p = raw.trim().trim_matches(['"', '\'']).replace('/', "\\");
    if p.is_empty() {
        return false;
    }
    // Everything inside a folder is the folder.
    let folder = p.trim_end_matches('*').trim_end_matches('\\');
    let lower = folder.to_lowercase();
    if matches!(lower.as_str(), "~" | "$home" | "$env:userprofile" | "%userprofile%") {
        return true;
    }
    let bytes = lower.as_bytes();
    // `C:`, `C:\`, `C:\*`; `\`, `/c`, `/c/*` (Git Bash).
    let drive = |s: &str| s.len() == 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic();
    if drive(&lower) || (p.starts_with('\\') && (lower.is_empty() || (bytes.len() == 2 && bytes[0] == b'\\' && bytes[1].is_ascii_alphabetic()))) {
        return true;
    }
    let Some(full) = resolve(scope, folder) else { return false };
    let full = full.to_string_lossy().to_lowercase();
    let full = full.trim_end_matches('\\');
    let home = std::env::var("USERPROFILE").unwrap_or_default().to_lowercase();
    let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()).to_lowercase();
    let mut vital = vec![windir, r"c:\program files".into(), r"c:\program files (x86)".into(), r"c:\programdata".into(), r"c:\users".into()];
    if !home.is_empty() {
        vital.push(home.clone());
        for sub in ["desktop", "documents", "downloads", "pictures", "appdata"] {
            vital.push(format!("{home}\\{sub}"));
        }
    }
    drive(full) || vital.iter().any(|v| full == v.trim_end_matches('\\'))
}

fn resolve(scope: &Scope, path: &str) -> Option<PathBuf> {
    let joined = if Path::new(path).is_absolute() { PathBuf::from(path) } else { scope.work_dir.join(path) };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

/// `pattern` (any case, `*` for anything) found in `text`; slashes either way.
fn matches_text(pattern: &str, text: &str) -> bool {
    let pattern = pattern.trim().to_lowercase().replace('/', "\\");
    if pattern.is_empty() || text.is_empty() {
        return false;
    }
    let text = text.to_lowercase().replace('/', "\\");
    // Found anywhere: the pattern's own `*` join its pieces in order.
    let mut at = 0;
    for piece in pattern.split('*').filter(|p| !p.is_empty()) {
        match text[at..].find(piece) {
            Some(i) => at += i + piece.len(),
            None => return false,
        }
    }
    true
}

// ── Kept on disk, read once ──────────────────────────────────────────────────

static CURRENT: RwLock<Option<Constitution>> = RwLock::new(None);

fn path() -> PathBuf {
    crate::settings::config_dir().join("constitution.json")
}

/// The constitution in force: the person's, or Coucou's starting one.
pub fn current() -> Constitution {
    if let Some(c) = CURRENT.read().unwrap().as_ref() {
        return c.clone().localized();
    }
    let c = std::fs::read(path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Constitution>(&b).ok())
        .map(Constitution::completed)
        .unwrap_or_else(Constitution::starting);
    *CURRENT.write().unwrap() = Some(c.clone());
    c.localized()
}

pub fn save(c: Constitution) -> Result<(), String> {
    let c = c.completed();
    let file = path();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, serde_json::to_vec_pretty(&c).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    *CURRENT.write().unwrap() = Some(c);
    Ok(())
}

/// A hook's tool call (Claude Code's or Copilot CLI's own sessions), as a request.
pub fn request_from_hook(payload: &serde_json::Value) -> Request {
    let tool = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
    let input = payload.get("tool_input").cloned().unwrap_or(serde_json::Value::Null);
    let (mut request, _, _) = crate::claude::request_of(tool, &input);
    if request.kind == Kind::Other {
        // Copilot's tools by their own names: a command, or a file.
        let text = |k: &str| input.get(k).and_then(|v| v.as_str()).map(str::to_string);
        if let Some(command) = text("command").or_else(|| text("cmd")) {
            request = Request { kind: Kind::Execute, command: Some(command), paths: vec![] };
        } else if let Some(path) = text("path").or_else(|| text("file_path")) {
            let delete = tool.to_lowercase().contains("delete") || tool.to_lowercase().contains("remove");
            request = Request { kind: if delete { Kind::Delete } else { Kind::Edit }, command: None, paths: vec![path] };
        }
    }
    request
}

/// What the constitution says about a hook's tool call, read against the session's folder.
pub fn rule_for_hook(payload: &serde_json::Value) -> Option<(Level, Rule)> {
    let cwd = payload.get("cwd").and_then(|v| v.as_str()).map(PathBuf::from).or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from)).unwrap_or_default();
    rule_for(&request_from_hook(payload), &cwd)
}

/// The rules in force, for a member's brief (none in tests: the person's file is not theirs).
// i18n: model-facing
pub fn brief_text() -> String {
    if cfg!(test) {
        return String::new();
    }
    current().for_brief()
}

/// What the constitution says about a request, for an agent working in `work_dir`.
/// `rule_for`, less the asks the person waived for this team (`scope.waived`,
/// "allow this for the whole team" on a card). A Never rule is never waived.
pub fn rule_for_in(request: &Request, work_dir: &Path, auto: Option<&Scope>) -> Option<(Level, Rule)> {
    match rule_for(request, work_dir) {
        Some((Level::Ask, rule)) if auto.is_some_and(|s| s.waived.contains(&rule.id)) => None,
        ruled => ruled,
    }
}

pub fn rule_for(request: &Request, work_dir: &Path) -> Option<(Level, Rule)> {
    if cfg!(test) {
        // A test's agents keep the general rules only — the person's file is
        // not theirs — unless the test works in a folder set aside for this.
        return testing(request, work_dir);
    }
    current().judge(request, work_dir)
}

#[cfg(test)]
static TESTING: RwLock<Option<Constitution>> = RwLock::new(None);

/// The constitution the drivers' tests run under, in folders named `constitution-test`.
#[cfg(test)]
pub fn for_tests(c: Constitution) {
    *TESTING.write().unwrap() = Some(c);
}

#[cfg(test)]
fn testing(request: &Request, work_dir: &Path) -> Option<(Level, Rule)> {
    if !work_dir.to_string_lossy().contains("constitution-test") {
        return None;
    }
    TESTING.read().unwrap().as_ref()?.judge(request, work_dir)
}

#[cfg(not(test))]
fn testing(_: &Request, _: &Path) -> Option<(Level, Rule)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(c: &Constitution, command: &str) -> Option<Level> {
        c.judge(&Request { kind: Kind::Execute, command: Some(command.into()), paths: vec![] }, Path::new(r"D:\Work\shop")).map(|(l, _)| l)
    }

    #[test]
    fn the_starting_rules_refuse_what_cannot_be_undone_and_ask_the_rest() {
        let c = Constitution::starting();
        assert_eq!(run(&c, "Remove-Item -Recurse -Force .git"), Some(Level::Never));
        assert_eq!(run(&c, r#"cmd /c "rd /s /q C:\""#), Some(Level::Never));
        assert_eq!(run(&c, "rm -rf /c/"), Some(Level::Never));
        assert_eq!(run(&c, "format D: /q"), Some(Level::Never));
        assert_eq!(run(&c, r"Remove-Item 'C:\Program Files' -Recurse"), Some(Level::Never));
        assert_eq!(run(&c, "npm install left-pad"), Some(Level::Ask));
        assert_eq!(run(&c, "winget install Git.Git"), Some(Level::Ask));
        assert_eq!(run(&c, "git reset --hard HEAD~3"), Some(Level::Ask));
        // Everyday work falls under none of them.
        assert_eq!(run(&c, "npm test"), None);
        assert_eq!(run(&c, "git commit -m 'drop the .git mention'"), None);
        assert_eq!(run(&c, r"Remove-Item dist\old.js"), None);
        // Everything in the work folder, or a folder in it: the general rules decide, not this one.
        assert_eq!(run(&c, "Remove-Item * -Recurse"), None);
        assert_eq!(run(&c, "rm -rf ./build ."), None);
        // Climbing out to the drive, or all of a system folder, is.
        assert_eq!(run(&c, r"Remove-Item ..\..\* -Recurse"), Some(Level::Never));
        assert_eq!(run(&c, r"rm -rf C:\Windows\*"), Some(Level::Never));
        assert_eq!(run(&c, "rm -rf ~"), Some(Level::Never));
        // A deletion request names its paths itself.
        let delete = Request { kind: Kind::Delete, command: None, paths: vec![r"D:\Work\shop\.git".into()] };
        assert_eq!(c.judge(&delete, Path::new(r"D:\Work\shop")).map(|(l, _)| l), Some(Level::Never));
    }

    #[test]
    fn the_person_s_own_rules_match_words_and_the_strictest_wins() {
        let mut c = Constitution::starting();
        c.rules.push(Rule { id: "mine-1".into(), text: "不能碰重要資料".into(), level: Level::Never, check: String::new(), patterns: vec![r"D:\重要資料\*".into()] });
        c.rules.push(Rule { id: "mine-2".into(), text: "跑 docker 要問我".into(), level: Level::Ask, check: String::new(), patterns: vec!["docker *".into()] });
        assert_eq!(run(&c, r"Copy-Item a.txt D:\重要資料\b.txt"), Some(Level::Never));
        assert_eq!(run(&c, "copy a.txt d:/重要資料/b.txt"), Some(Level::Never));
        assert_eq!(run(&c, "docker compose up"), Some(Level::Ask));
        // Asked about installing and refused for the folder: refused.
        assert_eq!(run(&c, r"npm install --prefix D:\重要資料\x left-pad"), Some(Level::Never));
        // Turned off: the general rules alone decide.
        c.rules.iter_mut().for_each(|r| r.level = Level::Off);
        assert_eq!(run(&c, "Remove-Item -Recurse .git"), None);
    }

    #[test]
    fn a_hook_s_tool_call_is_read_whichever_cli_sent_it() {
        let claude = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": "rm -rf .git" }, "cwd": r"D:\Work\shop" });
        let c = Constitution::starting();
        let judge = |p: &serde_json::Value| c.judge(&request_from_hook(p), Path::new(r"D:\Work\shop")).map(|(l, _)| l);
        assert_eq!(judge(&claude), Some(Level::Never));
        let copilot = serde_json::json!({ "tool_name": "powershell", "tool_input": { "command": "winget install Git.Git" } });
        assert_eq!(judge(&copilot), Some(Level::Ask));
        let edit = serde_json::json!({ "tool_name": "Write", "tool_input": { "file_path": r"D:\Work\shop\a.txt", "content": "x" } });
        assert_eq!(judge(&edit), None);
    }

    #[test]
    fn a_saved_constitution_gains_checks_added_later_and_tells_members_its_rules() {
        let old = Constitution { rules: vec![Rule { id: "git-folder".into(), text: "x".into(), level: Level::Ask, check: "git-folder".into(), patterns: vec![] }] };
        let now = old.completed();
        assert_eq!(now.rules.len(), BUILTIN.len());
        assert_eq!(now.rules[0].level, Level::Ask, "the person's choice is kept");
        let brief = Constitution::starting().for_brief();
        assert!(brief.contains("- Never: Don't delete or move a .git folder") && brief.contains("- Ask the user first: Ask me before installing"));
        // Saved in one language, Coucou's own checks read in the language of the moment.
        let saved = Constitution { rules: vec![Rule { id: "install".into(), text: "安裝軟體或套件之前要先問我".into(), level: Level::Ask, check: "install".into(), patterns: vec![] }] };
        assert_eq!(saved.localized().rules[0].text, "Ask me before installing software or packages");
        let mine = Rule { id: "mine-1".into(), text: "不能碰重要資料".into(), level: Level::Never, check: String::new(), patterns: vec!["x".into()] };
        assert_eq!(Constitution { rules: vec![mine] }.localized().rules[0].text, "不能碰重要資料", "the person's own words stay");
        assert!(Constitution { rules: vec![] }.for_brief().is_empty());
    }
}
