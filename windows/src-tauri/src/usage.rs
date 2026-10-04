// What an agent's model used: tokens by kind, for one model, and what the
// agent itself says it cost when it says so. Each driver reports usage as it
// learns of it (acp::Event::Usage) — Codex as the thread's totals grow,
// Claude Code at the end of each turn, Copilot through Coucou's meter (see
// meter.rs) — always as the part that is new since the last report, so
// usage can simply be added up.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Usage {
    /// The model's id as the agent named it ("claude-opus-5-5", "gpt-5.6-sol").
    pub model: String,
    /// Input tokens that were not read from the cache.
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Reasoning tokens, already counted in `output`.
    pub reasoning: u64,
    /// Calls to the model this covers, when known.
    pub requests: u64,
    /// The agent's own estimate, in US dollars (Claude Code gives one).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

impl Usage {
    pub fn is_empty(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_read == 0 && self.cache_write == 0 && self.cost_usd.unwrap_or(0.0) == 0.0
    }

    /// Adds `other` (of the same model) to these totals.
    pub fn add(&mut self, other: &Usage) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.reasoning += other.reasoning;
        self.requests += other.requests;
        self.cost_usd = match (self.cost_usd, other.cost_usd) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
        };
    }

    /// What grew from `before` to `self` (both running totals of one model).
    pub fn since(&self, before: &Usage) -> Usage {
        Usage {
            model: self.model.clone(),
            input: self.input.saturating_sub(before.input),
            output: self.output.saturating_sub(before.output),
            cache_read: self.cache_read.saturating_sub(before.cache_read),
            cache_write: self.cache_write.saturating_sub(before.cache_write),
            reasoning: self.reasoning.saturating_sub(before.reasoning),
            requests: self.requests.saturating_sub(before.requests),
            cost_usd: match (self.cost_usd, before.cost_usd) {
                (Some(now), Some(then)) => Some((now - then).max(0.0)),
                (now, _) => now,
            },
        }
    }
}

fn num(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64().or_else(|| x.as_f64().map(|f| f.max(0.0) as u64))).unwrap_or(0)
}

/// Claude Code's `modelUsage` (running totals of the session, by model).
pub fn from_claude_model_usage(model_usage: &Value) -> Vec<Usage> {
    let Some(map) = model_usage.as_object() else { return Vec::new() };
    map.iter()
        .map(|(model, u)| Usage {
            model: model.clone(),
            input: num(u, "inputTokens"),
            output: num(u, "outputTokens"),
            cache_read: num(u, "cacheReadInputTokens"),
            cache_write: num(u, "cacheCreationInputTokens"),
            reasoning: 0,
            requests: 0,
            cost_usd: u.get("costUSD").and_then(Value::as_f64),
        })
        .collect()
}

/// Codex's `TokenUsageBreakdown` (a thread's running total). Codex counts
/// cached input inside `inputTokens`.
pub fn from_codex_breakdown(model: &str, b: &Value) -> Usage {
    let input = num(b, "inputTokens");
    let cached = num(b, "cachedInputTokens");
    Usage {
        model: model.to_string(),
        input: input.saturating_sub(cached),
        output: num(b, "outputTokens"),
        cache_read: cached,
        cache_write: num(b, "cacheWriteInputTokens"),
        reasoning: num(b, "reasoningOutputTokens"),
        requests: 0,
        cost_usd: None,
    }
}

/// ACP's `PromptResponse.usage` (one turn), when an agent fills it in.
pub fn from_acp(model: &str, u: &Value) -> Usage {
    let cache_read = num(u, "cachedReadTokens");
    let input = num(u, "inputTokens");
    Usage {
        model: model.to_string(),
        // ACP's inputTokens may or may not include the cached ones; the
        // total says which.
        input: if input + num(u, "outputTokens") + cache_read + num(u, "cachedWriteTokens") > num(u, "totalTokens") && num(u, "totalTokens") > 0 {
            input.saturating_sub(cache_read)
        } else {
            input
        },
        output: num(u, "outputTokens"),
        cache_read,
        cache_write: num(u, "cachedWriteTokens"),
        reasoning: num(u, "thoughtTokens"),
        requests: 1,
        cost_usd: None,
    }
}

/// An OpenAI-style `usage` — Responses (`input_tokens`, `output_tokens`,
/// `input_tokens_details.cached_tokens`) or Chat Completions
/// (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details`) — as a
/// metered request carried it. `input` there includes the cached part.
pub fn from_openai(model: &str, u: &Value) -> Usage {
    let input = num(u, "input_tokens").max(num(u, "prompt_tokens"));
    let output = num(u, "output_tokens").max(num(u, "completion_tokens"));
    let details = u.get("input_tokens_details").or_else(|| u.get("prompt_tokens_details")).cloned().unwrap_or(Value::Null);
    let cached = num(&details, "cached_tokens");
    let out_details = u.get("output_tokens_details").or_else(|| u.get("completion_tokens_details")).cloned().unwrap_or(Value::Null);
    Usage {
        model: model.to_string(),
        input: input.saturating_sub(cached),
        output,
        cache_read: cached,
        cache_write: num(&details, "cache_creation_tokens"),
        reasoning: num(&out_details, "reasoning_tokens"),
        requests: 1,
        cost_usd: u.get("cost").and_then(Value::as_f64),
    }
}

/// Gemini's `usageMetadata` (Antigravity, when its result carries one).
pub fn from_gemini(model: &str, u: &Value) -> Usage {
    let prompt = num(u, "promptTokenCount");
    let cached = num(u, "cachedContentTokenCount");
    let thoughts = num(u, "thoughtsTokenCount");
    Usage {
        model: model.to_string(),
        input: prompt.saturating_sub(cached),
        output: num(u, "candidatesTokenCount") + thoughts,
        cache_read: cached,
        cache_write: 0,
        reasoning: thoughts,
        requests: 1,
        cost_usd: None,
    }
}

/// Each member's usage turn by turn, to tell apart a running total repeated
/// after the calls it adds up. Copilot over ACP reports its session's running
/// total at the end of every turn; a member behind Coucou's meter also had
/// every call reported, and records written before 2026-10-05 kept both. A
/// session starts with a turn, so a record equal to everything the member
/// used from the start of some turn up to now is such a total, and is not
/// counted again.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnSums(HashMap<String, Vec<(u32, Usage)>>);

impl TurnSums {
    pub fn turn_started(&mut self, member: &str) {
        self.0.entry(member.to_string()).or_default().push(Default::default());
    }

    /// Whether `u` is usage of its own (true), or a running total again (false).
    pub fn counts(&mut self, member: &str, u: &Usage) -> bool {
        let turns = self.0.entry(member.to_string()).or_default();
        if turns.is_empty() {
            turns.push(Default::default());
        }
        let same = |s: &Usage| u.input == s.input && u.output == s.output && u.cache_read == s.cache_read && u.cache_write == s.cache_write;
        let mut since = Usage::default();
        let mut calls = 0;
        for (n, sum) in turns.iter().rev() {
            since.add(sum);
            calls += n;
            if calls > 0 && same(&since) {
                return false;
            }
        }
        let (n, sum) = turns.last_mut().unwrap();
        *n += 1;
        sum.add(u);
        true
    }
}

/// Running totals by model, turned into what is new since last time.
#[derive(Default)]
pub struct Totals(std::sync::Mutex<HashMap<String, Usage>>);

impl Totals {
    /// The part of `now` (running totals) not reported yet, model by model.
    pub fn advance(&self, now: Vec<Usage>) -> Vec<Usage> {
        let mut seen = self.0.lock().unwrap();
        let mut out = Vec::new();
        for u in now {
            let before = seen.get(&u.model).cloned().unwrap_or_default();
            let new = u.since(&before);
            seen.insert(u.model.clone(), u);
            if !new.is_empty() {
                out.push(new);
            }
        }
        out
    }

    /// Like `advance`, keyed by something else than the model (a Codex thread).
    pub fn advance_keyed(&self, key: &str, now: Usage) -> Option<Usage> {
        let mut seen = self.0.lock().unwrap();
        let before = seen.get(key).cloned().unwrap_or_default();
        let new = now.since(&before);
        seen.insert(key.to_string(), now);
        (!new.is_empty()).then_some(new)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_s_running_totals_are_reported_as_what_each_turn_added() {
        let totals = Totals::default();
        let first = from_claude_model_usage(&json!({ "claude-opus-5-5": { "inputTokens": 100, "outputTokens": 20, "cacheReadInputTokens": 1000, "cacheCreationInputTokens": 50, "costUSD": 0.5 } }));
        let got = totals.advance(first);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].input, got[0].output, got[0].cache_read, got[0].cache_write), (100, 20, 1000, 50));
        let second = from_claude_model_usage(&json!({
            "claude-opus-5-5": { "inputTokens": 150, "outputTokens": 30, "cacheReadInputTokens": 3000, "cacheCreationInputTokens": 50, "costUSD": 0.8 },
            "claude-haiku-4-5": { "inputTokens": 10, "outputTokens": 5, "costUSD": 0.01 },
        }));
        let mut got = totals.advance(second);
        got.sort_by(|a, b| a.model.cmp(&b.model));
        assert_eq!(got[0].model, "claude-haiku-4-5");
        assert_eq!((got[1].input, got[1].output, got[1].cache_read, got[1].cache_write), (50, 10, 2000, 0));
        assert!((got[1].cost_usd.unwrap() - 0.3).abs() < 1e-9);
    }

    #[test]
    fn codex_counts_cached_input_inside_input_and_coucou_does_not() {
        let u = from_codex_breakdown("gpt-5.6-sol", &json!({ "totalTokens": 1300, "inputTokens": 1000, "cachedInputTokens": 800, "cacheWriteInputTokens": 0, "outputTokens": 300, "reasoningOutputTokens": 100 }));
        assert_eq!((u.input, u.cache_read, u.output, u.reasoning), (200, 800, 300, 100));
        let totals = Totals::default();
        assert!(totals.advance_keyed("th1", u.clone()).is_some());
        assert!(totals.advance_keyed("th1", u).is_none());
    }

    #[test]
    fn a_turn_s_total_after_its_calls_is_not_counted_again() {
        let call = |input: u64, output: u64, cache_read: u64| Usage { model: "deepseek-v4.1-flash".into(), input, output, cache_read, requests: 1, ..Default::default() };
        let mut sums = TurnSums::default();
        assert!(sums.counts("ai1", &call(15588, 414, 0)));
        assert!(sums.counts("ai1", &call(1391, 1730, 15458)));
        assert!(sums.counts("ai2", &call(15323, 165, 0)));
        // ai1's turn ends with its total, under another model's name.
        let total = Usage { model: "deepseek-v4-flash".into(), ..call(16979, 2144, 15458) };
        assert!(!sums.counts("ai1", &total));
        // The next turn: one call, then the session's running total so far.
        sums.turn_started("ai1");
        assert!(sums.counts("ai1", &call(500, 50, 20000)));
        assert!(!sums.counts("ai1", &call(17479, 2194, 35458)));
        // …or, from a session that started with this turn, just the turn's.
        assert!(!sums.counts("ai1", &call(500, 50, 20000)));
        // Calls of their own still count.
        assert!(sums.counts("ai1", &call(501, 50, 20000)));
    }

    #[test]
    fn openai_usage_of_both_wires_is_read() {
        let responses = from_openai("m", &json!({ "input_tokens": 500, "output_tokens": 40, "input_tokens_details": { "cached_tokens": 300 }, "output_tokens_details": { "reasoning_tokens": 10 } }));
        assert_eq!((responses.input, responses.cache_read, responses.output, responses.reasoning), (200, 300, 40, 10));
        let chat = from_openai("m", &json!({ "prompt_tokens": 500, "completion_tokens": 40, "prompt_tokens_details": { "cached_tokens": 100 } }));
        assert_eq!((chat.input, chat.cache_read, chat.output), (400, 100, 40));
    }
}
