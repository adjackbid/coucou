// Clearing the record of past work, on the person's click in Settings →
// 團隊與 Agent Center: the teams' runs — their messages, tasks and the usage
// the cost page adds up — and, if asked, the teams themselves (their files,
// the ones deleted before, their knowledge documents) and Agent Center's
// conversation.
//
// What sets things up stays: Agent Pool (team-agents.json), Settings →
// Agents and the chat models (settings.json), keys in Credential Manager,
// the price list and billing (pricing.json, prices.json), the constitution.
// Nothing in a team's own work folder is touched. What goes is moved to the
// Recycle Bin, so a click made by mistake can still be undone there.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::settings;

/// What there is to clear, for the page to say before the click.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Team files in the list (archived ones included).
    pub teams: usize,
    /// Team files deleted before, kept aside in the teams folder's `.deleted`.
    pub deleted: usize,
    /// Run logs (one per run of a team), and their size.
    pub runs: usize,
    pub run_bytes: u64,
    /// Knowledge documents, and their size.
    pub documents: usize,
    pub document_bytes: u64,
}

fn files_under(dir: &Path, keep: &mut dyn FnMut(&Path, u64)) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.filter_map(|e| e.ok()) {
        let path = e.path();
        match e.metadata() {
            Ok(m) if m.is_dir() => files_under(&path, keep),
            Ok(m) => keep(&path, m.len()),
            Err(_) => {}
        }
    }
}

fn entries(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir).map(|e| e.filter_map(|e| e.ok()).map(|e| e.path()).collect()).unwrap_or_default()
}

fn is_team_file(p: &Path) -> bool {
    p.is_file() && p.extension().is_some_and(|x| x == "json")
}

pub fn stats() -> Stats {
    stats_in(&settings::team_configs_dir(), &settings::team_logs_dir(), &settings::team_knowledge_dir())
}

fn stats_in(configs: &Path, logs: &Path, knowledge: &Path) -> Stats {
    let mut s = Stats { teams: entries(configs).iter().filter(|p| is_team_file(p)).count(), ..Default::default() };
    files_under(&configs.join(".deleted"), &mut |_, _| s.deleted += 1);
    files_under(logs, &mut |p, n| {
        if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("events") && n.ends_with(".jsonl")) {
            s.runs += 1;
            s.run_bytes += n;
        }
    });
    files_under(knowledge, &mut |_, n| {
        s.documents += 1;
        s.document_bytes += n;
    });
    s
}

/// What a clear moves away: every team's runs, and with `all` the teams themselves.
fn targets(all: bool, configs: &Path, logs: &Path, knowledge: &Path) -> Vec<PathBuf> {
    let mut out = entries(logs);
    if all {
        out.extend(entries(configs).into_iter().filter(|p| is_team_file(p)));
        let bin = configs.join(".deleted");
        if bin.exists() {
            out.push(bin);
        }
        out.extend(entries(knowledge));
    }
    out
}

/// Clears the runs, and with `all` the teams too. The caller has made sure no team is at work.
pub fn clear(all: bool) -> Result<(), String> {
    clear_in(all, &settings::team_configs_dir(), &settings::team_logs_dir(), &settings::team_knowledge_dir(), recycle)
}

fn clear_in(all: bool, configs: &Path, logs: &Path, knowledge: &Path, away: fn(&[PathBuf]) -> Result<(), String>) -> Result<(), String> {
    let paths = targets(all, configs, logs, knowledge);
    if !paths.is_empty() {
        away(&paths)?;
    }
    if all {
        // An empty teams folder gets the example team back unless it says teams were deleted here.
        std::fs::create_dir_all(configs.join(".deleted")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Moves files and folders to the Recycle Bin, all in one go, asking nothing.
#[cfg(windows)]
fn recycle(paths: &[PathBuf]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    // A list of full paths, each ended by a nul, the whole by one more.
    let mut from: Vec<u16> = Vec::new();
    for p in paths {
        from.extend(p.as_os_str().encode_wide());
        from.push(0);
    }
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT).0 as u16,
        ..Default::default()
    };
    // SAFETY: `op` points at `from`, which lives until the call returns.
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 || op.fAnyOperationsAborted.as_bool() {
        return Err(tr!(
            format!("沒辦法把紀錄移到資源回收筒(代碼 {code}),有檔案可能正被其他程式開著。什麼都沒有刪。"),
            format!("Could not move the records to the Recycle Bin (code {code}); a file may be open in another program. Nothing was deleted.")
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn recycle(paths: &[PathBuf]) -> Result<(), String> {
    for p in paths {
        let gone = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
        gone.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gone(paths: &[PathBuf]) -> Result<(), String> {
        for p in paths {
            let r = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
            r.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn bench(name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("coucou-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (configs, logs, knowledge) = (root.join("teams"), root.join("logs"), root.join("team-knowledge"));
        for d in [configs.join(".deleted"), logs.join("shop"), knowledge.join("shop")] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(configs.join("shop.json"), "{}").unwrap();
        std::fs::write(configs.join(".deleted").join("old-1.json"), "{}").unwrap();
        std::fs::write(logs.join("shop").join("events.jsonl"), "0123456789").unwrap();
        std::fs::write(logs.join("shop").join("events-1700.jsonl"), "01234").unwrap();
        std::fs::write(knowledge.join("shop").join("spec.md"), "# spec").unwrap();
        // Set up beside them: never touched.
        std::fs::write(root.join("team-agents.json"), "{}").unwrap();
        std::fs::write(root.join("pricing.json"), "{}").unwrap();
        (root, configs, logs, knowledge)
    }

    /// Puts a small file in the real Recycle Bin: run by hand (`cargo test -- --ignored recycle`).
    #[test]
    #[ignore]
    fn recycle_moves_a_file_to_the_recycle_bin() {
        let probe = std::env::temp_dir().join("coucou-history-probe.txt");
        std::fs::write(&probe, "probe").unwrap();
        recycle(&[probe.clone()]).unwrap();
        assert!(!probe.exists());
    }

    #[test]
    fn it_counts_what_there_is_to_clear() {
        let (root, configs, logs, knowledge) = bench("stats");
        let s = stats_in(&configs, &logs, &knowledge);
        assert_eq!(s, Stats { teams: 1, deleted: 1, runs: 2, run_bytes: 15, documents: 1, document_bytes: 6 });
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn runs_only_keeps_the_teams_and_all_keeps_the_agents_and_prices() {
        let (root, configs, logs, knowledge) = bench("clear");
        clear_in(false, &configs, &logs, &knowledge, gone).unwrap();
        let s = stats_in(&configs, &logs, &knowledge);
        assert_eq!((s.teams, s.deleted, s.runs, s.documents), (1, 1, 0, 1));

        clear_in(true, &configs, &logs, &knowledge, gone).unwrap();
        assert_eq!(stats_in(&configs, &logs, &knowledge), Stats::default());
        // The example team does not come back into an emptied folder.
        assert!(configs.join(".deleted").is_dir());
        assert!(root.join("team-agents.json").is_file() && root.join("pricing.json").is_file());
        let _ = std::fs::remove_dir_all(root);
    }
}
