// The OpenAI shape, in both wires: Chat Completions (/v1/chat/completions),
// which nearly every compatible server speaks, and Responses (/v1/responses),
// which newer OpenAI-side proxies use. One provider picks one with `wire_api`.

use serde_json::{json, Value};

use super::{Message, Part, Provider, Role, SYSTEM_PROMPT};

pub async fn send(provider: &Provider, key: Option<&str>, history: &[Message]) -> Result<String, String> {
    if provider.wire_api == "responses" {
        send_responses(provider, key, history).await
    } else {
        send_chat(provider, key, history).await
    }
}

// ── Chat Completions ──────────────────────────────────────────────────────────

async fn send_chat(provider: &Provider, key: Option<&str>, history: &[Message]) -> Result<String, String> {
    let mut messages = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
    messages.extend(history.iter().map(chat_message));
    let body = json!({ "model": provider.model, "messages": messages });

    let response = super::post_json(provider, key, &provider.endpoint("chat/completions"), &[], &body).await?;
    // Some servers answer 200 with an error object inside.
    if let Some(err) = super::error_message(&response) {
        return Err(err);
    }
    let Some(choice) = response.get("choices").and_then(Value::as_array).and_then(|c| c.first()) else {
        return Err("Unexpected API response: no choices.".into());
    };
    if choice.get("finish_reason").and_then(Value::as_str) == Some("content_filter") {
        return Err("The provider's content filter declined this one.".into());
    }
    Ok(content_text(choice.get("message").and_then(|m| m.get("content"))))
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

async fn send_responses(provider: &Provider, key: Option<&str>, history: &[Message]) -> Result<String, String> {
    let input: Vec<Value> = history.iter().map(responses_item).collect();
    let body = json!({
        "model": provider.model,
        "instructions": SYSTEM_PROMPT,
        "input": input,
    });

    let response = super::post_json(provider, key, &provider.endpoint("responses"), &[], &body).await?;
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
        if let Some(reason) = response
            .get("incomplete_details")
            .and_then(|d| d.get("reason"))
            .and_then(Value::as_str)
        {
            return Err(format!("The response was cut short: {reason}."));
        }
    }
    Ok(text)
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
}
