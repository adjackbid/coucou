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

/// What an agent's endpoint (a LiteLLM proxy) has billed its key: the
/// spend since the key's budget last reset, by model, and the budget.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySpend {
    pub spend: f64,
    pub max_budget: Option<f64>,
    /// How often the budget starts again ("7d", "30d"), when it does.
    pub budget_duration: Option<String>,
    pub budget_reset_at: Option<String>,
    pub model_spend: BTreeMap<String, f64>,
    /// When it was asked (ms).
    pub asked_at: u64,
}

/// Asks the endpoint what it billed the agent's key (LiteLLM's `/key/info`).
pub async fn key_spend(base: &str, key: Option<String>) -> Result<KeySpend, String> {
    let root = base.trim_end_matches('/').trim_end_matches("/v1");
    let key = key.ok_or("This agent has no key to ask with.")?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let resp = client.get(format!("{root}/key/info")).bearer_auth(&key).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("The endpoint does not tell what its key has spent (it answered {}; it may not be a LiteLLM proxy).", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(spend_of(&body["info"]))
}

fn spend_of(info: &Value) -> KeySpend {
    let text = |k: &str| info.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    KeySpend {
        spend: info.get("spend").and_then(Value::as_f64).unwrap_or(0.0),
        max_budget: info.get("max_budget").and_then(Value::as_f64),
        budget_duration: text("budget_duration"),
        budget_reset_at: text("budget_reset_at"),
        model_spend: info
            .get("model_spend")
            .and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_f64()?))).collect())
            .unwrap_or_default(),
        asked_at: crate::team::store::now_ms(),
    }
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

    #[test]
    fn a_key_s_spend_is_read_from_litellm_s_key_info() {
        let info = serde_json::json!({ "key_alias": "x", "spend": 15.5, "max_budget": 150.0, "budget_duration": "7d", "budget_reset_at": "2026-10-06T00:00:00Z", "model_spend": { "deepseek-v4-flash": 12.25, "glm-5.3-flash": 3.25 } });
        let s = spend_of(&info);
        assert_eq!((s.spend, s.max_budget, s.budget_duration.as_deref()), (15.5, Some(150.0), Some("7d")));
        assert_eq!(s.model_spend["deepseek-v4-flash"], 12.25);
        let none = spend_of(&serde_json::json!({ "spend": 0.0, "max_budget": null, "budget_duration": null, "model_spend": {} }));
        assert_eq!((none.max_budget, none.budget_duration), (None, None));
    }

    /// The public list and an agent's own endpoint answer (network; nothing is saved).
    #[test]
    #[ignore]
    fn prices_can_be_fetched_from_the_list_and_from_an_agent_s_endpoint() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let table = runtime.block_on(fetch_list()).expect("the public list");
        eprintln!("public list: {} models", table.models.len());
        assert!(table.models.len() > 500);
        let Some(profile) = crate::settings::load().agents.into_iter().find(|a| a.env.get("COPILOT_PROVIDER_BASE_URL").is_some_and(|b| b.starts_with("http"))) else { return };
        let secret = crate::secrets::get(&profile.secret_key()).unwrap_or_default();
        let key = profile.env.get("COPILOT_PROVIDER_API_KEY").map(|v| v.replace("{secret}", &secret)).filter(|k| !k.trim().is_empty());
        match runtime.block_on(proxy_prices(&profile.env["COPILOT_PROVIDER_BASE_URL"], key, "endpoint")) {
            Ok(found) => {
                eprintln!("endpoint: {} models priced", found.len());
                for (k, l) in found.iter().take(8) {
                    eprintln!("  {k}: in {} out {} cache {} ({})", l.price.input, l.price.output, l.price.cache_read, l.listed_as);
                }
            }
            Err(e) => eprintln!("endpoint: {e}"),
        }
    }
}
