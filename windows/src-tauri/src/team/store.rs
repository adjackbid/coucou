// A team's events on disk: `%LOCALAPPDATA%\Coucou\teams\<id>\events.jsonl`,
// one JSON record per line, only ever appended. Opening a store replays the
// file, which is how the screens come back after a restart.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::state::{Event, Record, State, TeamStatus};

const FILE: &str = "events.jsonl";

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct Store {
    /// `None` keeps everything in memory (tests).
    file: Option<PathBuf>,
    state: State,
    seq: u64,
}

impl Store {
    pub fn memory() -> Self {
        Self { file: None, state: State::default(), seq: 0 }
    }

    /// A store for a new run in `dir`. A log left by an earlier run of the
    /// same team is kept beside it under its start time, never overwritten.
    pub fn fresh(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let file = dir.join(FILE);
        if file.exists() {
            let _ = std::fs::rename(&file, dir.join(format!("events-{}.jsonl", now_ms())));
        }
        Ok(Self { file: Some(file), state: State::default(), seq: 0 })
    }

    /// Replays the log in `dir`. A team that was running when Coucou closed
    /// comes back paused, with its open turns ended: no agent is behind them
    /// any more.
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        let file = dir.join(FILE);
        let text = std::fs::read_to_string(&file)?;
        let mut store = Self { file: Some(file), state: State::default(), seq: 0 };
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            // A line cut short by a crash is the last one; skip what cannot be read.
            let Ok(record) = serde_json::from_str::<Record>(line) else { continue };
            store.seq = store.seq.max(record.seq);
            store.state.apply(&record);
        }
        let open_turns: Vec<String> = store.state.turns.iter().filter(|(_, t)| t.active).map(|(m, _)| m.clone()).collect();
        for member in open_turns {
            store.append(Event::TurnEnded { member, ok: false, outcome: "interrupted".into() });
        }
        if store.state.status == TeamStatus::Running {
            store.append(Event::Paused { why: "Coucou was closed while the team was running.".into() });
        }
        Ok(store)
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    /// Records the event and applies it. A disk that will not take the line
    /// is logged; the team goes on with what it has in memory.
    pub fn append(&mut self, event: Event) {
        self.seq += 1;
        let record = Record { seq: self.seq, at: now_ms(), event };
        if let Some(file) = &self.file {
            let written = serde_json::to_string(&record).map_err(|e| e.to_string()).and_then(|line| {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(file)
                    .and_then(|mut f| writeln!(f, "{line}"))
                    .map_err(|e| e.to_string())
            });
            if let Err(err) = written {
                crate::log::line(format!("team log {}: {err}", file.display()));
            }
        }
        self.state.apply(&record);
    }

    pub fn append_all(&mut self, events: Vec<Event>) {
        for event in events {
            self.append(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::shop;
    use super::super::state::{Priority, TaskStatus};
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-team-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn a_short_run(store: &mut Store) {
        store.append(Event::Started { config: shop("D:\\x") });
        store.append(Event::TurnStarted { member: "ai1".into() });
        store.append(Event::TaskCreated {
            id: "TASK-01".into(),
            title: "商品圖片".into(),
            detail: String::new(),
            owner: "ai4".into(),
            priority: Priority::Medium,
            criteria: vec!["六張商品圖".into()],
            depends_on: vec![],
            deliver_to: Some("ai3".into()),
            by: "ai1".into(),
        });
        store.append(Event::TurnEnded { member: "ai1".into(), ok: true, outcome: "end_turn".into() });
        store.append(Event::TurnStarted { member: "ai4".into() });
        store.append(Event::Delivered {
            id: "D-1".into(),
            task: "TASK-01".into(),
            kind: "image".into(),
            locator: "public/img".into(),
            summary: "六張".into(),
            by: "ai4".into(),
        });
    }

    #[test]
    fn a_log_replays_into_the_same_state() {
        let dir = temp("replay");
        let mut store = Store::fresh(&dir).unwrap();
        a_short_run(&mut store);
        let before = store.state().clone();
        assert_eq!(before.tasks[0].status, TaskStatus::Delivered);
        assert_eq!(before.total_turns, 2);

        // Reopened: ai4's turn is over, the team is paused, nothing else moved.
        let reopened = Store::open(&dir).unwrap();
        let after = reopened.state();
        assert_eq!(after.tasks, before.tasks);
        assert_eq!(after.deliverables, before.deliverables);
        assert_eq!(after.status, TeamStatus::Paused);
        assert!(!after.turns["ai4"].active);

        // And once more gives exactly that again.
        assert_eq!(Store::open(&dir).unwrap().state(), after);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_run_keeps_the_old_log_beside_it() {
        let dir = temp("fresh");
        let mut first = Store::fresh(&dir).unwrap();
        a_short_run(&mut first);
        let second = Store::fresh(&dir).unwrap();
        assert!(second.state().tasks.is_empty());
        let kept = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("events-")).count();
        assert_eq!(kept, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_line_cut_short_does_not_lose_the_rest() {
        let dir = temp("cut");
        let mut store = Store::fresh(&dir).unwrap();
        a_short_run(&mut store);
        let file = dir.join(FILE);
        let mut text = std::fs::read_to_string(&file).unwrap();
        text.push_str("{\"seq\":99,\"at\":1,\"event\":{\"type\":\"taskCre");
        std::fs::write(&file, text).unwrap();
        assert_eq!(Store::open(&dir).unwrap().state().tasks.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
