// What an agent can do, shown beside it (Agent Pool, Settings → Agent
// Provider) and told to Agent Center when it picks members: whether its model
// sees images, thinks before it answers, how much it reads, roughly what it
// costs, and whether it makes pictures.
//
// The model's own abilities come, first, from the agent itself where it says
// (Codex's model list: what each model takes, which efforts it offers, its
// default); then from the same lists as its price (pricing.rs): a LiteLLM
// proxy's /model/info, else LiteLLM's public list, which says so for most
// models once it has been fetched again from the cost page; last, from the
// model's family name (Claude, Gemini, GPT-5…), marked as a guess. Making
// pictures is a tool, not something any list says: the person ticks it on
// the provider.

use serde::Serialize;

use crate::acp::{AgentProfile, Launch, Protocol};
use crate::claude::ModelChoice;
use crate::pricing::{self, Choices, Table};

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    /// The model these are for; empty when the agent picks its own.
    pub model: String,
    pub vision: Option<bool>,
    pub thinking: Option<bool>,
    pub context: Option<u64>,
    /// 1 cheap … 4 dear, from its price per million tokens; None without a price.
    pub tier: Option<u8>,
    /// Makes pictures, as the person ticked it on the provider.
    pub image: bool,
    /// Reads web pages and searches the web: every coding CLI does through its
    /// own tools (Claude Code's WebFetch/WebSearch, Codex's web search, Gemini
    /// CLI's and Copilot's fetch, Antigravity's browser); an n8n workflow does
    /// not. The person can set it either way on the provider.
    pub web: bool,
    /// Runs commands and code on the machine: every coding CLI does; n8n does
    /// not. The person can set it either way on the provider.
    pub code: bool,
    /// Some of it is told from the model's name, not said by a list.
    pub guessed: bool,
}

/// Claude Code's aliases name the newest of a family: the list's newest entry for it.
fn claude_alias(model: &str, table: &Table) -> Option<String> {
    let alias = model.trim().to_ascii_lowercase();
    let alias = alias.split('[').next().unwrap_or("");
    if !["opus", "sonnet", "haiku"].contains(&alias) {
        return None;
    }
    let prefix = format!("claude-{alias}-");
    table.models.keys().filter(|k| k.starts_with(&prefix)).max().cloned()
}

/// What a model's family name says, when nothing else does: (vision, thinking).
fn family(model: &str) -> (Option<bool>, Option<bool>) {
    let m = model.to_ascii_lowercase();
    let m = m.rsplit('/').next().unwrap_or(&m);
    let efforted = ["-low", "-medium", "-high", "-xhigh", "-max"].iter().any(|s| m.ends_with(s));
    if m.starts_with("gpt-oss") {
        return (Some(false), Some(true));
    }
    if m.starts_with("claude") || ["opus", "sonnet", "haiku"].iter().any(|a| m.starts_with(a)) || m.starts_with("gemini") || m.starts_with("gpt-5") || m.starts_with("gpt-6") || m.starts_with("o3") || m.starts_with("o4") {
        return (Some(true), Some(true));
    }
    if m.starts_with("deepseek") || m.starts_with("qwen3") || m.starts_with("qwq") || m.contains("reasoning") || efforted {
        return (None, Some(true));
    }
    (None, None)
}

/// How dear a price is, in four steps: input weighed three to one against output.
pub fn tier(p: &pricing::Price) -> u8 {
    let blended = (p.input * 3.0 + p.output) / 4.0;
    if blended < 0.5 {
        1
    } else if blended < 3.0 {
        2
    } else if blended < 12.0 {
        3
    } else {
        4
    }
}

/// `offered`: the agent's own model list, when it says what its models can do (Codex).
pub fn of(profile: &AgentProfile, choices: &Choices, table: &Table, offered: Option<&[ModelChoice]>) -> Caps {
    let mut model = crate::acp::running_model(profile, &Launch::default());
    // The agent's own word on its model; with no model set, on its default one.
    let own = offered.and_then(|list| if model.is_empty() { list.iter().find(|m| m.default) } else { list.iter().find(|m| m.id == model) });
    if model.is_empty() {
        if let Some(m) = own {
            model = m.id.clone();
        }
    }
    let priced_as = claude_alias(&model, table).unwrap_or_else(|| model.clone());
    let found = (!priced_as.is_empty()).then(|| pricing::lookup(&priced_as, choices, table)).flatten();
    let can = found.as_ref().map(|f| f.can).unwrap_or_default();
    let claude = profile.protocol == Protocol::Claude;
    let said_vision = own.and_then(|m| m.vision).or(can.vision).or(claude.then_some(true));
    let said_thinking = own.filter(|m| !m.efforts.is_empty()).map(|_| true).or(can.reasoning).or(claude.then_some(true));
    let (guess_vision, guess_thinking) = family(&model);
    Caps {
        vision: said_vision.or(guess_vision),
        thinking: said_thinking.or(guess_thinking),
        context: can.context.or_else(|| (claude && model.contains("[1m]")).then_some(1_000_000)),
        tier: found.as_ref().map(|f| tier(&f.price)),
        image: profile.image_gen,
        web: profile.web.unwrap_or(profile.protocol != Protocol::N8n),
        code: profile.code.unwrap_or(profile.protocol != Protocol::N8n),
        guessed: (said_vision.is_none() && guess_vision.is_some()) || (said_thinking.is_none() && guess_thinking.is_some()),
        model,
    }
}

/// One line for Agent Center: what this agent can do.
// i18n: model-facing
pub fn describe(c: &Caps) -> String {
    let yes = |v: Option<bool>, what: &str| match v {
        Some(true) => Some(what.to_string()),
        Some(false) => Some(format!("cannot {what}")),
        None => None,
    };
    let mut bits: Vec<String> = [yes(c.vision, "see images"), yes(c.thinking, "think before answering")].into_iter().flatten().collect();
    if c.image {
        bits.push("make images (the user says so)".into());
    }
    if c.web {
        bits.push("browse and search the web (through its own CLI tools)".into());
    }
    if c.code {
        bits.push("run code and commands on its machine".into());
    }
    if let Some(n) = c.context {
        bits.push(format!("reads up to {n} tokens"));
    }
    if let Some(t) = c.tier {
        bits.push(format!("price tier {t} of 4"));
    }
    if bits.is_empty() {
        "abilities unknown".into()
    } else {
        bits.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pricing::{Abilities, Listed, Price};

    fn table() -> Table {
        let listed = |input: f64, output: f64, can: Abilities| Listed { price: Price { input, output, ..Default::default() }, listed_as: "x".into(), provider: "y".into(), can };
        Table {
            models: [
                (pricing::normalize("deepseek-v4-flash"), listed(0.3, 1.2, Abilities { vision: Some(true), reasoning: Some(true), context: Some(1_000_000) })),
                (pricing::normalize("claude-opus-5"), listed(15.0, 75.0, Abilities::default())),
            ]
            .into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_model_s_abilities_come_from_its_list_and_pictures_from_the_person() {
        let mut cg = AgentProfile::copilot();
        cg.model = "deepseek-v4-flash".into();
        cg.image_gen = true;
        let c = of(&cg, &Choices::default(), &table(), None);
        assert_eq!((c.vision, c.thinking, c.context, c.tier, c.image, c.guessed), (Some(true), Some(true), Some(1_000_000), Some(2), true, false));
        assert!(describe(&c).contains("see images") && describe(&c).contains("make images"));
        // A coding CLI browses and runs code on its own; an n8n workflow does neither.
        assert!((c.web, c.code) == (true, true) && describe(&c).contains("browse and search the web") && describe(&c).contains("run code"));
        let mut flow = AgentProfile::copilot();
        flow.protocol = Protocol::N8n;
        let f = of(&flow, &Choices::default(), &table(), None);
        assert!((f.web, f.code) == (false, false) && !describe(&f).contains("web"));
        // The person's own setting wins over what the kind says, either way.
        cg.web = Some(false);
        flow.code = Some(true);
        assert!(!of(&cg, &Choices::default(), &table(), None).web && of(&flow, &Choices::default(), &table(), None).code);

        let mut claude = AgentProfile::copilot();
        claude.protocol = Protocol::Claude;
        // "opus" is priced as the list's newest Opus.
        claude.model = "opus".into();
        let c = of(&claude, &Choices::default(), &table(), None);
        assert_eq!((c.vision, c.thinking, c.tier, c.image), (Some(true), Some(true), Some(4), false));

        flow.code = None;
        let unknown = of(&flow, &Choices::default(), &table(), None);
        assert_eq!(describe(&unknown), "abilities unknown");
    }

    #[test]
    fn the_agent_s_own_list_wins_then_the_family_name_is_a_guess() {
        let mut codex = AgentProfile::copilot();
        codex.protocol = Protocol::Codex;
        let offered = vec![
            ModelChoice { id: "gpt-6.1-sol".into(), label: "x".into(), vision: Some(true), efforts: vec!["low".into()], default: true },
            ModelChoice { id: "text-only".into(), label: "y".into(), vision: Some(false), ..Default::default() },
        ];
        let c = of(&codex, &Choices::default(), &table(), Some(&offered));
        assert_eq!((c.model.as_str(), c.vision, c.thinking, c.guessed), ("gpt-6.1-sol", Some(true), Some(true), false));
        codex.model = "text-only".into();
        assert_eq!(of(&codex, &Choices::default(), &table(), Some(&offered)).vision, Some(false));

        let mut agy = AgentProfile::copilot();
        agy.protocol = Protocol::Agy;
        agy.model = "gemini-3.8-flash-high".into();
        let c = of(&agy, &Choices::default(), &table(), None);
        assert_eq!((c.vision, c.thinking, c.guessed), (Some(true), Some(true), true));
        agy.model = "gpt-oss-120b-medium".into();
        assert_eq!(of(&agy, &Choices::default(), &table(), None).vision, Some(false));
    }
}
