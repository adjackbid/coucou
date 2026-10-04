// Usage and cost over time, for the Teamwork window's 成本 page: every
// usage record in every team log (current runs and the earlier runs kept
// beside them) between two moments, each priced (pricing.rs), with who
// spent it — team, run, member, agent, model.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use crate::pricing::{self, Choices, Found, Table};
use crate::team::state::{Event, Record};
use crate::usage::Usage;

/// One usage record, priced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub at: u64,
    pub team: String,
    pub team_name: String,
    /// When the run started (ms): runs of one team are told apart by it.
    pub run: u64,
    pub member: String,
    pub member_name: String,
    /// The agent profile the member ran as.
    pub agent: String,
    pub usage: Usage,
    /// Coucou's estimate at the price found, in US dollars; none when no price is known.
    pub estimated_usd: Option<f64>,
    /// "override", "proxy", "list", or "reported" (the agent's own figure), or "" when nothing priced it.
    pub priced_by: String,
}

/// A model seen in the period, with the price used for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub model: String,
    pub found: Option<Found>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub rows: Vec<Row>,
    pub models: Vec<ModelPrice>,
    pub choices: Choices,
    pub table_source: String,
    pub table_fetched_at: u64,
    pub table_size: usize,
}

/// The usage records of one log in [from, to), with who spent them.
fn read_log(file: &Path, team: &str, from: u64, to: u64, out: &mut Vec<Row>) {
    let Ok(text) = std::fs::read_to_string(file) else { return };
    let mut team_name = team.to_string();
    let mut run = 0u64;
    // member id → (name, agent)
    let mut who: HashMap<String, (String, String)> = HashMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(record) = serde_json::from_str::<Record>(line) else { continue };
        match &record.event {
            Event::Started { config } => {
                team_name = config.name.clone();
                run = record.at;
                for m in &config.members {
                    who.insert(m.id.clone(), (m.name.clone(), m.agent.clone()));
                }
            }
            Event::Joined { member } => {
                who.insert(member.id.clone(), (member.name.clone(), member.agent.clone()));
            }
            Event::Usage { member, usage } if record.at >= from && record.at < to => {
                let (name, agent) = who.get(member).cloned().unwrap_or_else(|| (member.clone(), String::new()));
                out.push(Row {
                    at: record.at,
                    team: team.to_string(),
                    team_name: team_name.clone(),
                    run,
                    member: member.clone(),
                    member_name: name,
                    agent,
                    usage: usage.clone(),
                    estimated_usd: None,
                    priced_by: String::new(),
                });
            }
            _ => {}
        }
    }
    // A team renamed later keeps its latest name across its rows.
    for r in out.iter_mut().filter(|r| r.team == team) {
        r.team_name = team_name.clone();
    }
}

/// Every team's usage in [from, to), from the logs under `root`.
pub fn collect(root: &Path, from: u64, to: u64) -> Vec<Row> {
    let mut rows = Vec::new();
    let Ok(teams) = std::fs::read_dir(root) else { return rows };
    for team in teams.flatten() {
        let id = team.file_name().to_string_lossy().to_string();
        if !crate::team::is_plain_id(&id) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(team.path()) else { continue };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if name == "events.jsonl" || (name.starts_with("events-") && name.ends_with(".jsonl")) {
                read_log(&f.path(), &id, from, to, &mut rows);
            }
        }
    }
    rows.sort_by_key(|r| r.at);
    rows
}

/// Prices every row: the price found for its model, else the agent's own figure.
pub fn price(rows: &mut [Row], choices: &Choices, table: &Table) -> Vec<ModelPrice> {
    let mut seen: BTreeMap<String, Option<Found>> = BTreeMap::new();
    for r in rows.iter_mut() {
        let found = seen.entry(r.usage.model.clone()).or_insert_with(|| pricing::lookup(&r.usage.model, choices, table)).clone();
        match (found, r.usage.cost_usd) {
            (Some(f), _) => {
                r.estimated_usd = Some(f.price.cost(&r.usage));
                r.priced_by = f.source;
            }
            (None, Some(c)) => {
                r.estimated_usd = Some(c);
                r.priced_by = "reported".into();
            }
            (None, None) => {}
        }
    }
    seen.into_iter().map(|(model, found)| ModelPrice { model, found }).collect()
}

pub fn report(root: &Path, from: u64, to: u64) -> Report {
    let choices = pricing::load_choices();
    let table = pricing::load_table();
    let mut rows = collect(root, from, to);
    let models = price(&mut rows, &choices, &table);
    Report { rows, models, table_source: table.source.clone(), table_fetched_at: table.fetched_at, table_size: table.models.len(), choices }
}

/// A LiteLLM proxy's prices, read with the agent's own endpoint and key.
pub async fn proxy_prices(base: &str, key: Option<String>, label: &str) -> Result<BTreeMap<String, pricing::Listed>, String> {
    let root = base.trim_end_matches('/').trim_end_matches("/v1");
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let mut last = String::new();
    for path in ["/model/info", "/v1/model/info"] {
        let mut req = client.get(format!("{root}{path}"));
        if let Some(k) = &key {
            req = req.bearer_auth(k);
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                let info: Value = resp.json().await.map_err(|e| e.to_string())?;
                let found = pricing::from_model_info(&info, label);
                if found.is_empty() {
                    return Err("The endpoint answered, but listed no prices for its models.".into());
                }
                return Ok(found);
            }
            Ok(resp) => last = format!("{} answered {}", path, resp.status()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("This endpoint does not give its prices (it is not a LiteLLM proxy, or the key may not read them): {last}"))
}

/// LiteLLM's public price list, fetched now.
pub async fn fetch_list() -> Result<Table, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let resp = client.get(pricing::LITELLM_URL).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("The price list answered {}", resp.status()));
    }
    let all: Value = resp.json().await.map_err(|e| e.to_string())?;
    let models = pricing::reduce_litellm(&all);
    if models.len() < 100 {
        return Err("The price list came back nearly empty; the copy in use was kept.".into());
    }
    Ok(Table { source: "LiteLLM model_prices_and_context_window.json".into(), fetched_at: crate::team::store::now_ms(), models })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team::fixtures::shop;
    use crate::team::store::Store;

    #[test]
    fn usage_is_read_from_every_run_in_the_period_with_who_spent_it() {
        let root = std::env::temp_dir().join(format!("coucou-cost-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("shop");
        let used = |model: &str, input: u64| Usage { model: model.into(), input, output: 1_000, ..Default::default() };
        let mut first = Store::fresh(&dir).unwrap();
        first.append(Event::Started { config: shop("D:\\shop") });
        first.append(Event::Usage { member: "ai3".into(), usage: used("gpt-5.6-sol", 1_000_000) });
        drop(first);
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut second = Store::fresh(&dir).unwrap();
        second.append(Event::Started { config: shop("D:\\shop") });
        second.append(Event::Usage { member: "ai1".into(), usage: used("model-nobody-sells", 10) });
        drop(second);

        let mut rows = collect(&root, 0, u64::MAX);
        assert_eq!(rows.len(), 2);
        let ai3 = rows.iter().find(|r| r.member == "ai3").unwrap();
        assert_eq!((ai3.member_name.as_str(), ai3.agent.as_str(), ai3.team_name.as_str()), ("AI 3", "copilot", "購物網站團隊"));

        let table = Table {
            models: [(pricing::normalize("gpt-5.6-sol"), pricing::Listed { price: pricing::Price { input: 4.0, output: 20.0, ..Default::default() }, listed_as: "gpt-5.6-sol".into(), provider: "openai".into() })].into(),
            ..Default::default()
        };
        let models = price(&mut rows, &Choices::default(), &table);
        let ai3 = rows.iter().find(|r| r.member == "ai3").unwrap();
        assert!((ai3.estimated_usd.unwrap() - (4.0 + 0.02)).abs() < 1e-9);
        assert_eq!(ai3.priced_by, "list");
        let unknown = rows.iter().find(|r| r.member == "ai1").unwrap();
        assert!(unknown.estimated_usd.is_none());
        assert_eq!(models.len(), 2);

        // Outside the period: nothing.
        assert!(collect(&root, u64::MAX - 1, u64::MAX).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
