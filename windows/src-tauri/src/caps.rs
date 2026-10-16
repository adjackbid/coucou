// What an agent can do, shown beside it (Agent Pool, Settings → Agent
// Provider) and told to Agent Center when it picks members: whether its model
// sees images, thinks before it answers, how much it reads, roughly what it
// costs, and whether it makes pictures.
//
// The model's own abilities come from the same lists as its price
// (pricing.rs): a LiteLLM proxy's /model/info, else LiteLLM's public list,
// which says so for most models once it has been fetched again from the cost
// page. Claude Code's models all see images and think. Making pictures is a
// tool, not something any list says: the person ticks it on the provider.

use serde::Serialize;

use crate::acp::{AgentProfile, Launch, Protocol};
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

pub fn of(profile: &AgentProfile, choices: &Choices, table: &Table) -> Caps {
    let model = crate::acp::running_model(profile, &Launch::default());
    let found = (!model.is_empty()).then(|| pricing::lookup(&model, choices, table)).flatten();
    let can = found.as_ref().map(|f| f.can).unwrap_or_default();
    let claude = profile.protocol == Protocol::Claude;
    Caps {
        vision: can.vision.or(claude.then_some(true)),
        thinking: can.reasoning.or(claude.then_some(true)),
        context: can.context.or_else(|| (claude && model.contains("[1m]")).then_some(1_000_000)),
        tier: found.as_ref().map(|f| tier(&f.price)),
        image: profile.image_gen,
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
        let c = of(&cg, &Choices::default(), &table());
        assert_eq!((c.vision, c.thinking, c.context, c.tier, c.image), (Some(true), Some(true), Some(1_000_000), Some(2), true));
        assert!(describe(&c).contains("see images") && describe(&c).contains("make images"));

        let mut claude = AgentProfile::copilot();
        claude.protocol = Protocol::Claude;
        claude.model = "claude-opus-5".into();
        let c = of(&claude, &Choices::default(), &table());
        assert_eq!((c.vision, c.thinking, c.tier, c.image), (Some(true), Some(true), Some(4), false));

        let unknown = of(&AgentProfile::copilot(), &Choices::default(), &table());
        assert_eq!(describe(&unknown), "abilities unknown");
    }
}
