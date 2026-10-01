// Anthropic Messages API — the same integration as ClaudeService.swift: web
// search as a server-side tool, files as document/image blocks. Streamed when
// the caller wants the reply as it is written.

use serde_json::{json, Value};

use super::{Caps, Message, OnDelta, Part, Provider, Role, SYSTEM_PROMPT};

pub const DEFAULT_MODEL: &str = "claude-opus-5";

pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 4096;
const DECLINED: &str = "Claude declined this one.";

pub async fn send(
    provider: &Provider,
    key: Option<&str>,
    history: &[Message],
    caps: &Caps,
    on_delta: OnDelta<'_>,
) -> Result<String, String> {
    let messages: Vec<Value> = history.iter().map(to_message).collect();
    let mut body = json!({
        "model": provider.model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": messages,
    });
    if on_delta.is_some() {
        body["stream"] = json!(true);
    }
    // The search tool and the fallback beta are Anthropic's own; a proxy that
    // speaks this shape may not know them, so they go only where they belong.
    let mut headers = vec![("anthropic-version", ANTHROPIC_VERSION)];
    if caps.web_search {
        body["tools"] = json!([{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }]);
        body["fallbacks"] = json!("default");
        headers.push(("anthropic-beta", FALLBACK_BETA));
    }

    let mut text = String::new();
    let whole = super::post(provider, key, &provider.endpoint("messages"), &headers, &body, &mut |event| {
        match stream_event(event)? {
            Some(piece) => {
                if let Some(emit) = on_delta {
                    emit(&piece);
                }
                text.push_str(&piece);
            }
            None => {}
        }
        Ok(())
    })
    .await?;

    let Some(response) = whole else { return Ok(text) };

    // Not streamed. A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        return Err(refusal_text(response.get("stop_details")));
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

fn refusal_text(details: Option<&Value>) -> String {
    details
        .and_then(|d| d.get("explanation"))
        .and_then(Value::as_str)
        .unwrap_or(DECLINED)
        .to_string()
}

/// One event of a streamed reply: the text it adds, if any, or the error it
/// reports. Tool-use blocks, thinking and bookkeeping events add nothing.
fn stream_event(event: &Value) -> Result<Option<String>, String> {
    match event.get("type").and_then(Value::as_str) {
        Some("content_block_delta") => {
            let delta = event.get("delta");
            let is_text = delta.and_then(|d| d.get("type")).and_then(Value::as_str) == Some("text_delta");
            Ok(is_text
                .then(|| delta.and_then(|d| d.get("text")).and_then(Value::as_str).map(str::to_string))
                .flatten())
        }
        Some("message_delta") => {
            let delta = event.get("delta");
            if delta.and_then(|d| d.get("stop_reason")).and_then(Value::as_str) == Some("refusal") {
                return Err(refusal_text(delta.and_then(|d| d.get("stop_details"))));
            }
            Ok(None)
        }
        Some("error") => Err(super::error_message(event).unwrap_or_else(|| "The stream reported an error.".into())),
        _ => Ok(None),
    }
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

    #[test]
    fn a_stream_yields_its_text_and_its_errors() {
        let text = json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hel" } });
        assert_eq!(stream_event(&text).unwrap().as_deref(), Some("Hel"));
        // A tool's JSON arguments and the bookkeeping events are not reply text.
        let tool = json!({ "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": "{" } });
        assert_eq!(stream_event(&tool).unwrap(), None);
        assert_eq!(stream_event(&json!({ "type": "message_start" })).unwrap(), None);
        assert_eq!(stream_event(&json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" } })).unwrap(), None);

        let refused = json!({ "type": "message_delta", "delta": { "stop_reason": "refusal" } });
        assert_eq!(stream_event(&refused).unwrap_err(), DECLINED);
        let error = json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } });
        assert_eq!(stream_event(&error).unwrap_err(), "Overloaded");
    }
}
