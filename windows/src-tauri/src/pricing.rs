// What a model's tokens cost, to turn recorded usage into an estimate.
//
// Prices are US dollars per million tokens, by kind (input, output, cache
// read, cache write). They come from, in this order:
//
//   1. the person's own price for a model (Teamwork → 成本 → 價格)
//   2. prices read from an agent's own endpoint when it is a LiteLLM proxy
//      (`/model/info`), on the person's click
//   3. LiteLLM's public price list (model_prices_and_context_window.json):
//      a copy ships with Coucou, and the person can fetch a newer one
//
// No network call is made unless the person asks for one. Model names are
// matched loosely — provider prefixes, regions, dates, effort suffixes and
// `.` against `-` do not matter — and among the providers selling a model
// the maker's own price wins (Anthropic for Claude, OpenAI for GPT…).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Per million tokens, US dollars.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl Price {
    /// What `u` cost at this price.
    pub fn cost(&self, u: &crate::usage::Usage) -> f64 {
        (u.input as f64 * self.input + u.output as f64 * self.output + u.cache_read as f64 * self.cache_read + u.cache_write as f64 * self.cache_write) / 1_000_000.0
    }
}

/// One model in a price list: its price, the name it was listed under, and who sells it at that price.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub price: Price,
    pub listed_as: String,
    pub provider: String,
}

/// A price list: normalized model name → its price.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Table {
    pub source: String,
    /// When it was fetched (ms), 0 for the copy that ships with Coucou.
    pub fetched_at: u64,
    pub models: BTreeMap<String, Listed>,
}

/// Where the public list is fetched from, when the person asks.
pub const LITELLM_URL: &str = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/// The copy that ships with Coucou (see `regenerate_the_bundled_price_list`).
const BUNDLED: &str = include_str!("prices.json");

/// A model name with what does not change its price taken away.
pub fn normalize(model: &str) -> String {
    let mut m = model.trim().to_lowercase();
    if let Some(i) = m.find('[') {
        m.truncate(i);
    }
    if let Some(i) = m.rfind('/') {
        m = m[i + 1..].to_string();
    }
    for sep in [':', '@'] {
        if let Some(i) = m.find(sep) {
            m.truncate(i);
        }
    }
    for region in ["us-gov.", "us.", "eu.", "apac.", "global.", "jp.", "au.", "ca."] {
        if let Some(rest) = m.strip_prefix(region) {
            m = rest.to_string();
        }
    }
    for vendor in ["anthropic.", "openai.", "google.", "meta.", "deepseek.", "moonshotai.", "mistral.", "amazon.", "cohere.", "qwen.", "zai.", "minimax."] {
        if let Some(rest) = m.strip_prefix(vendor) {
            m = rest.to_string();
        }
    }
    // Trailing version, date, effort and alias markers.
    loop {
        let before = m.clone();
        for suffix in ["-latest", "-xhigh", "-high", "-medium", "-low", "-minimal", "-thinking-off"] {
            if let Some(rest) = m.strip_suffix(suffix) {
                m = rest.to_string();
            }
        }
        if let Some(i) = m.rfind("-v") {
            if m[i + 2..].chars().all(|c| c.is_ascii_digit()) && i + 2 < m.len() {
                m.truncate(i);
            }
        }
        if let Some(i) = m.rfind('-') {
            let tail = &m[i + 1..];
            if tail.len() == 8 && tail.chars().all(|c| c.is_ascii_digit()) {
                m.truncate(i);
            }
        }
        if m.len() > 11 {
            let tail = &m[m.len() - 11..];
            let b = tail.as_bytes();
            if b[0] == b'-' && b[5] == b'-' && b[8] == b'-' && tail[1..5].chars().all(|c| c.is_ascii_digit()) {
                m.truncate(m.len() - 11);
            }
        }
        if m == before {
            break;
        }
    }
    m.replace('.', "-")
}

/// How much a provider's listing is trusted for a model: the maker first.
fn rank(provider: &str, key: &str) -> u32 {
    const ORDER: [&str; 16] = [
        "anthropic", "openai", "gemini", "deepseek", "xai", "mistral", "moonshot", "zai", "minimax", "dashscope", "vertex_ai-anthropic_models", "vertex_ai",
        "bedrock_converse", "bedrock", "azure", "openrouter",
    ];
    let base = ORDER.iter().position(|p| *p == provider).map(|i| i as u32).unwrap_or(30);
    // A plain key ("gpt-5.6-sol") over a prefixed one ("openai/gpt-5.6-sol").
    base * 2 + u32::from(key.contains('/'))
}

/// LiteLLM's price list, one price per model.
pub fn reduce_litellm(all: &Value) -> BTreeMap<String, Listed> {
    let mut best: BTreeMap<String, (u32, Listed)> = BTreeMap::new();
    let Some(map) = all.as_object() else { return BTreeMap::new() };
    for (key, v) in map {
        if !matches!(v.get("mode").and_then(Value::as_str), Some("chat") | Some("responses")) {
            continue;
        }
        let lower = key.to_lowercase();
        if lower.contains(":free") || lower.contains("batch") || lower.starts_with("ft:") || lower.contains("/ft:") {
            continue;
        }
        let Some(input) = v.get("input_cost_per_token").and_then(Value::as_f64) else { continue };
        let output = v.get("output_cost_per_token").and_then(Value::as_f64).unwrap_or(0.0);
        let million = |x: f64| (x * 1_000_000.0 * 1e6).round() / 1e6;
        let price = Price {
            input: million(input),
            output: million(output),
            cache_read: million(v.get("cache_read_input_token_cost").and_then(Value::as_f64).unwrap_or(input)),
            cache_write: million(v.get("cache_creation_input_token_cost").and_then(Value::as_f64).unwrap_or(input)),
        };
        let provider = v.get("litellm_provider").and_then(Value::as_str).unwrap_or("").to_string();
        let r = rank(&provider, key);
        let name = normalize(key);
        if name.is_empty() {
            continue;
        }
        let listed = Listed { price, listed_as: key.clone(), provider };
        match best.get(&name) {
            Some((had, _)) if *had <= r => {}
            _ => {
                best.insert(name, (r, listed));
            }
        }
    }
    best.into_iter().map(|(k, (_, v))| (k, v)).collect()
}

/// A LiteLLM proxy's `/model/info`: the prices of the models it serves.
pub fn from_model_info(info: &Value, source: &str) -> BTreeMap<String, Listed> {
    let mut out = BTreeMap::new();
    let Some(list) = info.get("data").and_then(Value::as_array) else { return out };
    for m in list {
        let name = m.get("model_name").and_then(Value::as_str).unwrap_or("");
        let mi = m.get("model_info").cloned().unwrap_or(Value::Null);
        let Some(input) = mi.get("input_cost_per_token").and_then(Value::as_f64) else { continue };
        let output = mi.get("output_cost_per_token").and_then(Value::as_f64).unwrap_or(0.0);
        let price = Price {
            input: input * 1_000_000.0,
            output: output * 1_000_000.0,
            cache_read: mi.get("cache_read_input_token_cost").and_then(Value::as_f64).unwrap_or(input) * 1_000_000.0,
            cache_write: mi.get("cache_creation_input_token_cost").and_then(Value::as_f64).unwrap_or(input) * 1_000_000.0,
        };
        if !name.is_empty() {
            out.insert(normalize(name), Listed { price, listed_as: name.to_string(), provider: source.to_string() });
        }
    }
    out
}

/// What the person set: their own prices, how each agent is paid for, the currency shown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Choices {
    /// Model (as named in the usage) → the person's price.
    pub overrides: BTreeMap<String, Price>,
    /// Prices read from agents' endpoints: normalized model → price.
    pub proxy: BTreeMap<String, Listed>,
    /// Agent profile id → "metered" (pay per token) or "subscription" (a plan:
    /// the estimate is what the same tokens would cost at list price).
    pub billing: BTreeMap<String, String>,
    /// Shown beside US dollars: code and how many of it make one dollar.
    pub currency: String,
    pub rate: f64,
}

impl Default for Choices {
    fn default() -> Self {
        Self { overrides: BTreeMap::new(), proxy: BTreeMap::new(), billing: BTreeMap::new(), currency: "TWD".into(), rate: 32.0 }
    }
}

fn choices_path() -> PathBuf {
    crate::settings::config_dir().join("pricing.json")
}

fn table_path() -> PathBuf {
    crate::settings::local_dir().join("prices.json")
}

pub fn load_choices() -> Choices {
    std::fs::read(choices_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_choices(c: &Choices) -> Result<(), String> {
    let path = choices_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(c).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The public list, read once and kept (it is large): for checks that run on every usage report.
pub fn cached_table() -> std::sync::Arc<Table> {
    static CACHE: std::sync::RwLock<Option<(u64, std::sync::Arc<Table>)>> = std::sync::RwLock::new(None);
    let stamp = load_stamp();
    if let Some((at, t)) = CACHE.read().unwrap().as_ref() {
        if *at == stamp {
            return t.clone();
        }
    }
    let t = std::sync::Arc::new(load_table());
    *CACHE.write().unwrap() = Some((stamp, t.clone()));
    t
}

/// When the saved list was fetched (0 when none): a newer one is read again.
fn load_stamp() -> u64 {
    std::fs::metadata(table_path()).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The public list in use: the one fetched last, else the one that shipped.
pub fn load_table() -> Table {
    std::fs::read(table_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Table>(&b).ok())
        .filter(|t| !t.models.is_empty())
        .unwrap_or_else(|| serde_json::from_str(BUNDLED).unwrap_or_default())
}

pub fn save_table(t: &Table) -> Result<(), String> {
    let path = table_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_vec(t).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// A model's price, and where it came from: "override", "proxy", "list" — or none.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub price: Price,
    pub source: String,
    pub listed_as: String,
}

pub fn lookup(model: &str, choices: &Choices, table: &Table) -> Option<Found> {
    if let Some(p) = choices.overrides.get(model).or_else(|| choices.overrides.iter().find(|(k, _)| normalize(k) == normalize(model)).map(|(_, p)| p)) {
        return Some(Found { price: *p, source: "override".into(), listed_as: model.to_string() });
    }
    let key = normalize(model);
    if let Some(l) = choices.proxy.get(&key) {
        return Some(Found { price: l.price, source: "proxy".into(), listed_as: format!("{} ({})", l.listed_as, l.provider) });
    }
    table.models.get(&key).map(|l| Found { price: l.price, source: "list".into(), listed_as: format!("{} ({})", l.listed_as, l.provider) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_meet_whatever_the_provider_calls_them() {
        assert_eq!(normalize("claude-opus-5-5[1m]"), "claude-opus-5-5");
        assert_eq!(normalize("anthropic/claude-opus-5.5"), "claude-opus-5-5");
        assert_eq!(normalize("us.anthropic.claude-sonnet-5-5-20260301-v1:0"), "claude-sonnet-5-5");
        assert_eq!(normalize("gemini-3.8-flash-high"), "gemini-3-8-flash");
        assert_eq!(normalize("openrouter/deepseek/deepseek-v4.1-flash:batch"), "deepseek-v4-1-flash");
        assert_eq!(normalize("gpt-5.6-sol"), "gpt-5-6-sol");
        assert_eq!(normalize("gpt-4o-2024-08-06"), "gpt-4o");
    }

    #[test]
    fn the_maker_s_price_wins_and_batch_or_free_listings_are_left_out() {
        let all = json!({
            "openrouter/anthropic/claude-opus-5.5": { "mode": "chat", "litellm_provider": "openrouter", "input_cost_per_token": 0.00002, "output_cost_per_token": 0.0001 },
            "claude-opus-5-5": { "mode": "chat", "litellm_provider": "anthropic", "input_cost_per_token": 0.000015, "output_cost_per_token": 0.000075, "cache_read_input_token_cost": 0.0000015 },
            "openrouter/anthropic/claude-opus-5.5:batch": { "mode": "chat", "litellm_provider": "openrouter", "input_cost_per_token": 0.0000075 },
            "openrouter/minimax/minimax-m2.7:free": { "mode": "chat", "litellm_provider": "openrouter", "input_cost_per_token": 0.0 },
            "text-embedding-3": { "mode": "embedding", "input_cost_per_token": 0.0000001 },
        });
        let t = reduce_litellm(&all);
        let opus = &t["claude-opus-5-5"];
        assert_eq!(opus.provider, "anthropic");
        assert_eq!((opus.price.input, opus.price.output, opus.price.cache_read, opus.price.cache_write), (15.0, 75.0, 1.5, 15.0));
        assert!(!t.contains_key("minimax-m2-7"));
        assert!(!t.contains_key("text-embedding-3"));
    }

    #[test]
    fn the_person_s_price_comes_before_the_proxy_s_and_the_list_s() {
        let table = Table { models: [("m".to_string(), Listed { price: Price { input: 1.0, ..Default::default() }, listed_as: "m".into(), provider: "x".into() })].into(), ..Default::default() };
        let mut c = Choices::default();
        assert_eq!(lookup("m", &c, &table).unwrap().source, "list");
        c.proxy.insert("m".into(), Listed { price: Price { input: 2.0, ..Default::default() }, listed_as: "m".into(), provider: "llm-share".into() });
        assert_eq!(lookup("M", &c, &table).unwrap().price.input, 2.0);
        c.overrides.insert("m".into(), Price { input: 3.0, ..Default::default() });
        assert_eq!(lookup("m", &c, &table).unwrap().source, "override");
        assert!(lookup("nothing-like-it", &c, &table).is_none());
        let u = crate::usage::Usage { input: 1_000_000, output: 500_000, cache_read: 2_000_000, ..Default::default() };
        let p = Price { input: 2.0, output: 8.0, cache_read: 0.5, cache_write: 2.5 };
        assert!((p.cost(&u) - (2.0 + 4.0 + 1.0)).abs() < 1e-9);
    }

    #[test]
    fn a_litellm_proxy_s_model_info_gives_its_prices() {
        let info = json!({ "data": [{ "model_name": "deepseek-v4.1-flash", "model_info": { "input_cost_per_token": 0.0000003, "output_cost_per_token": 0.0000012, "cache_read_input_token_cost": 0.00000003 } }] });
        let p = from_model_info(&info, "llm-share");
        let got = &p["deepseek-v4-1-flash"].price;
        assert!((got.input - 0.3).abs() < 1e-9 && (got.output - 1.2).abs() < 1e-9 && (got.cache_read - 0.03).abs() < 1e-9);
    }

    #[test]
    fn the_bundled_list_reads_and_knows_the_common_models() {
        let t: Table = serde_json::from_str(BUNDLED).unwrap();
        assert!(t.models.len() > 500, "only {} models", t.models.len());
        for m in ["claude-opus-5-5", "gpt-5.6-sol", "deepseek-v4.1-flash", "gemini-3.8-flash-high"] {
            assert!(t.models.contains_key(&normalize(m)), "no price for {m}");
        }
    }

    /// Writes src/prices.json from a downloaded LiteLLM list:
    /// `LITELLM_PRICES=path cargo test -p coucou regenerate_the_bundled -- --ignored`.
    #[test]
    #[ignore]
    fn regenerate_the_bundled_price_list() {
        let path = std::env::var("LITELLM_PRICES").expect("LITELLM_PRICES=path to model_prices_and_context_window.json");
        let all: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let table = Table { source: "LiteLLM model_prices_and_context_window.json (MIT)".into(), fetched_at: 0, models: reduce_litellm(&all) };
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("prices.json");
        std::fs::write(&out, serde_json::to_vec(&table).unwrap()).unwrap();
        println!("{} models → {}", table.models.len(), out.display());
    }
}
