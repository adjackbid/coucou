// Anthropic Messages API — the same integration as ClaudeService.swift: web
// search as a server-side tool, files as document/image blocks.

use serde_json::{json, Value};

use super::{Caps, Message, Part, Provider, Role, SYSTEM_PROMPT};

pub const DEFAULT_MODEL: &str = "claude-opus-5";

const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 4096;

pub async fn send(
    provider: &Provider,
    key: Option<&str>,
    history: &[Message],
    caps: &Caps,
) -> Result<String, String> {
    let messages: Vec<Value> = history.iter().map(to_message).collect();
    let mut body = json!({
        "model": provider.model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": messages,
    });
    // The search tool and the fallback beta are Anthropic's own; a proxy that
    // speaks this shape may not know them, so they go only where they belong.
    let mut headers = vec![("anthropic-version", ANTHROPIC_VERSION)];
    if caps.web_search {
        body["tools"] = json!([{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }]);
        body["fallbacks"] = json!("default");
        headers.push(("anthropic-beta", FALLBACK_BETA));
    }

    let response = super::post_json(provider, key, &provider.endpoint("messages"), &headers, &body).await?;

    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        let why = response
            .get("stop_details")
            .and_then(|d| d.get("explanation"))
            .and_then(Value::as_str)
            .unwrap_or("Claude declined this one.");
        return Err(why.to_string());
    }

    let Some(blocks) = response.get("content").and_then(Value::as_array) else {
        return Err("Unexpected API response.".into());
    };
    Ok(blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n"))
}

fn to_message(message: &Message) -> Value {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
    };
    let content: Vec<Value> = message
        .parts
        .iter()
        .map(|part| match part {
            Part::Text(text) => json!({ "type": "text", "text": text }),
            Part::Image { media, data } => json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media, "data": data },
            }),
            Part::Pdf { data, .. } => json!({
                "type": "document",
                "source": { "type": "base64", "media_type": "application/pdf", "data": data },
            }),
        })
        .collect();
    json!({ "role": role, "content": content })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_become_the_documented_blocks() {
        let m = Message {
            role: Role::User,
            parts: vec![
                Part::Pdf { name: "a.pdf".into(), data: "QUJD".into() },
                Part::Image { media: "image/png".into(), data: "QUJD".into() },
                Part::Text("hi".into()),
            ],
        };
        let v = to_message(&m);
        assert_eq!(v["role"], "user");
        assert_eq!(v["content"][0]["type"], "document");
        assert_eq!(v["content"][0]["source"]["media_type"], "application/pdf");
        assert_eq!(v["content"][1]["type"], "image");
        assert_eq!(v["content"][1]["source"]["media_type"], "image/png");
        assert_eq!(v["content"][2]["text"], "hi");
    }
}
