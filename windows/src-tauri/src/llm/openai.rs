// The OpenAI shape, in both wires: Chat Completions (/v1/chat/completions),
// which nearly every compatible server speaks, and Responses (/v1/responses),
// which newer OpenAI-side proxies use. One provider picks one with `wire_api`.
// Both are streamed when the caller wants the reply as it is written; a
// server that answers in one piece anyway is read the old way.

use serde_json::{json, Value};

use super::{Message, OnDelta, Part, Provider, Role, SYSTEM_PROMPT};

const FILTERED: &str = "The provider's content filter declined this one.";

pub async fn send(
    provider: &Provider,
    key: Option<&str>,
    history: &[Message],
    on_delta: OnDelta<'_>,
) -> Result<String, String> {
    if provider.wire_api == "responses" {
        send_responses(provider, key, history, on_delta).await
    } else {
        send_chat(provider, key, history, on_delta).await
    }
}

// ── Chat Completions ──────────────────────────────────────────────────────────

async fn send_chat(
    provider: &Provider,
    key: Option<&str>,
    history: &[Message],
    on_delta: OnDelta<'_>,
) -> Result<String, String> {
    let mut messages = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
    messages.extend(history.iter().map(chat_message));
    let mut body = json!({ "model": provider.model, "messages": messages });
    if on_delta.is_some() {
        body["stream"] = json!(true);
    }

    let mut text = String::new();
    let whole = super::post(provider, key, &provider.endpoint("chat/completions"), &[], &body, &mut |event| {
        if let Some(piece) = chat_stream_event(event)? {
            if let Some(emit) = on_delta {
                emit(&piece);
            }
            text.push_str(&piece);
        }
        Ok(())
    })
    .await?;

    let Some(response) = whole else { return Ok(text) };
    // Some servers answer 200 with an error object inside.
    if let Some(err) = super::error_message(&response) {
        return Err(err);
    }
    let Some(choice) = response.get("choices").and_then(Value::as_array).and_then(|c| c.first()) else {
        return Err("Unexpected API response: no choices.".into());
    };
    if choice.get("finish_reason").and_then(Value::as_str) == Some("content_filter") {
        return Err(FILTERED.into());
    }
    Ok(content_text(choice.get("message").and_then(|m| m.get("content"))))
}

/// One chunk of a streamed chat completion: the text it adds, or its error.
fn chat_stream_event(event: &Value) -> Result<Option<String>, String> {
    if let Some(err) = super::error_message(event) {
        return Err(err);
    }
    let Some(choice) = event.get("choices").and_then(Value::as_array).and_then(|c| c.first()) else {
        // The closing usage chunk has no choices.
        return Ok(None);
    };
    if choice.get("finish_reason").and_then(Value::as_str) == Some("content_filter") {
        return Err(FILTERED.into());
    }
    let piece = content_text(choice.get("delta").and_then(|d| d.get("content")));
    Ok((!piece.is_empty()).then_some(piece))
}

/// One history entry as a chat message. Assistant turns are plain strings;
/// user turns are arrays so images and files can ride along.
fn chat_message(message: &Message) -> Value {
    match message.role {
        Role::Assistant => json!({ "role": "assistant", "content": message.text() }),
        Role::User => {
            let content: Vec<Value> = message
                .parts
                .iter()
                .map(|part| match part {
                    Part::Text(text) => json!({ "type": "text", "text": text }),
                    Part::Image { media, data } => json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{media};base64,{data}") },
                    }),
                    Part::Pdf { name, data } => json!({
                        "type": "file",
                        "file": { "filename": name, "file_data": format!("data:application/pdf;base64,{data}") },
                    }),
                })
                .collect();
            json!({ "role": "user", "content": content })
        }
    }
}

/// `content` is a string on most servers and an array of text parts on a few.
fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// ── Responses ─────────────────────────────────────────────────────────────────

async fn send_responses(
    provider: &Provider,
    key: Option<&str>,
    history: &[Message],
    on_delta: OnDelta<'_>,
) -> Result<String, String> {
    let input: Vec<Value> = history.iter().map(responses_item).collect();
    let mut body = json!({
        "model": provider.model,
        "instructions": SYSTEM_PROMPT,
        "input": input,
    });
    if on_delta.is_some() {
        body["stream"] = json!(true);
    }

    let mut text = String::new();
    let whole = super::post(provider, key, &provider.endpoint("responses"), &[], &body, &mut |event| {
        if let Some(piece) = responses_stream_event(event)? {
            if let Some(emit) = on_delta {
                emit(&piece);
            }
            text.push_str(&piece);
        }
        Ok(())
    })
    .await?;

    let Some(response) = whole else { return Ok(text) };
    if let Some(err) = super::error_message(&response) {
        return Err(err);
    }
    let Some(output) = response.get("output").and_then(Value::as_array) else {
        return Err("Unexpected API response: no output.".into());
    };
    // Reasoning items, tool calls and the like sit beside the message; only
    // the message's output_text parts are the answer.
    let text = output
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        if let Some(reason) = incomplete_reason(&response) {
            return Err(format!("The response was cut short: {reason}."));
        }
    }
    Ok(text)
}

fn incomplete_reason(response: &Value) -> Option<&str> {
    response
        .get("incomplete_details")
        .and_then(|d| d.get("reason"))
        .and_then(Value::as_str)
}

/// One event of a streamed response: the text it adds, or its error.
fn responses_stream_event(event: &Value) -> Result<Option<String>, String> {
    match event.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta") => {
            Ok(event.get("delta").and_then(Value::as_str).filter(|d| !d.is_empty()).map(str::to_string))
        }
        Some("response.failed") => Err(event
            .get("response")
            .and_then(super::error_message)
            .unwrap_or_else(|| "The response failed.".into())),
        Some("response.incomplete") => {
            let reason = event.get("response").and_then(incomplete_reason).unwrap_or("unknown reason");
            Err(format!("The response was cut short: {reason}."))
        }
        Some("error") => Err(event
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| super::error_message(event))
            .unwrap_or_else(|| "The stream reported an error.".into())),
        _ => Ok(None),
    }
}

fn responses_item(message: &Message) -> Value {
    match message.role {
        Role::Assistant => json!({
            "role": "assistant",
            "content": [{ "type": "output_text", "text": message.text() }],
        }),
        Role::User => {
            let content: Vec<Value> = message
                .parts
                .iter()
                .map(|part| match part {
                    Part::Text(text) => json!({ "type": "input_text", "text": text }),
                    Part::Image { media, data } => json!({
                        "type": "input_image",
                        "image_url": format!("data:{media};base64,{data}"),
                    }),
                    Part::Pdf { name, data } => json!({
                        "type": "input_file",
                        "filename": name,
                        "file_data": format!("data:application/pdf;base64,{data}"),
                    }),
                })
                .collect();
            json!({ "role": "user", "content": content })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history() -> Vec<Message> {
        vec![
            Message {
                role: Role::User,
                parts: vec![
                    Part::Image { media: "image/png".into(), data: "QUJD".into() },
                    Part::Text("what is this".into()),
                ],
            },
            Message { role: Role::Assistant, parts: vec![Part::Text("a square".into())] },
        ]
    }

    #[test]
    fn chat_wire_uses_image_url_parts_and_plain_assistant_strings() {
        let h = history();
        let user = chat_message(&h[0]);
        assert_eq!(user["content"][0]["type"], "image_url");
        assert_eq!(user["content"][0]["image_url"]["url"], "data:image/png;base64,QUJD");
        assert_eq!(user["content"][1]["text"], "what is this");
        let assistant = chat_message(&h[1]);
        assert_eq!(assistant["content"], "a square");
    }

    #[test]
    fn responses_wire_uses_input_and_output_items() {
        let h = history();
        let user = responses_item(&h[0]);
        assert_eq!(user["content"][0]["type"], "input_image");
        assert_eq!(user["content"][1]["type"], "input_text");
        let assistant = responses_item(&h[1]);
        assert_eq!(assistant["content"][0]["type"], "output_text");
        assert_eq!(assistant["content"][0]["text"], "a square");
    }

    #[test]
    fn content_text_reads_both_shapes() {
        assert_eq!(content_text(Some(&json!("hi"))), "hi");
        assert_eq!(content_text(Some(&json!([{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }]))), "a\nb");
        assert_eq!(content_text(None), "");
    }

    #[test]
    fn a_chat_stream_yields_its_text_and_its_errors() {
        let chunk = json!({ "choices": [{ "index": 0, "delta": { "content": "Hel" }, "finish_reason": null }] });
        assert_eq!(chat_stream_event(&chunk).unwrap().as_deref(), Some("Hel"));
        // The role-only first chunk, the finishing chunk and the usage chunk add nothing.
        assert_eq!(chat_stream_event(&json!({ "choices": [{ "delta": { "role": "assistant" } }] })).unwrap(), None);
        assert_eq!(chat_stream_event(&json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] })).unwrap(), None);
        assert_eq!(chat_stream_event(&json!({ "choices": [], "usage": { "total_tokens": 9 } })).unwrap(), None);
        let filtered = json!({ "choices": [{ "delta": {}, "finish_reason": "content_filter" }] });
        assert_eq!(chat_stream_event(&filtered).unwrap_err(), FILTERED);
        let error = json!({ "error": { "message": "model not found" } });
        assert_eq!(chat_stream_event(&error).unwrap_err(), "model not found");
    }

    #[test]
    fn a_responses_stream_yields_its_text_and_its_errors() {
        let delta = json!({ "type": "response.output_text.delta", "delta": "Hel" });
        assert_eq!(responses_stream_event(&delta).unwrap().as_deref(), Some("Hel"));
        assert_eq!(responses_stream_event(&json!({ "type": "response.created" })).unwrap(), None);
        assert_eq!(responses_stream_event(&json!({ "type": "response.reasoning_summary_text.delta", "delta": "thinking" })).unwrap(), None);
        let failed = json!({ "type": "response.failed", "response": { "error": { "message": "quota" } } });
        assert_eq!(responses_stream_event(&failed).unwrap_err(), "quota");
        let cut = json!({ "type": "response.incomplete", "response": { "incomplete_details": { "reason": "max_output_tokens" } } });
        assert_eq!(responses_stream_event(&cut).unwrap_err(), "The response was cut short: max_output_tokens.");
        assert_eq!(responses_stream_event(&json!({ "type": "error", "message": "bad" })).unwrap_err(), "bad");
    }
}
