// A conversation in which the model may call tools — for the secretary
// (secretary.rs). One request at a time, not streamed: the model answers
// with text, or with calls; the caller runs the calls and asks again with
// their results. Spoken in each of the three wires a chat provider can use:
// Anthropic Messages, OpenAI Chat Completions, OpenAI Responses.

use serde_json::{json, Value};

use super::{anthropic::ANTHROPIC_VERSION, Provider};

const MAX_TOKENS: u32 = 4096;

/// A tool the model may call: its name, what it does, and a JSON schema of its arguments.
#[derive(Debug, Clone)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// One step of the conversation.
#[derive(Debug, Clone)]
pub enum Turn {
    User(String),
    /// What the model said, and the calls it made with it.
    Assistant { text: String, calls: Vec<Call> },
    /// What each call gave back: (call id, tool name, output).
    Results(Vec<(String, String, String)>),
}

#[derive(Debug, Clone, Default)]
pub struct Reply {
    pub text: String,
    pub calls: Vec<Call>,
}

/// One request: the model's next step.
pub async fn complete(provider: &Provider, system: &str, turns: &[Turn], tools: &[Tool]) -> Result<Reply, String> {
    let key = provider.secret();
    if key.is_none() && provider.needs_key() {
        return Err(super::no_key(provider));
    }
    let (url, headers, body) = if provider.is_anthropic() {
        (provider.endpoint("messages"), vec![("anthropic-version", ANTHROPIC_VERSION)], anthropic_body(provider, system, turns, tools))
    } else if provider.wire_api == "responses" {
        (provider.endpoint("responses"), vec![], responses_body(provider, system, turns, tools))
    } else {
        (provider.endpoint("chat/completions"), vec![], chat_body(provider, system, turns, tools))
    };
    let response = super::post(provider, key.as_deref(), &url, &headers, &body, &mut |_| Ok(()))
        .await?
        .ok_or_else(|| -> String {
            let name = &provider.name;
            tr!(format!("{name} 用串流回覆了，但這裡要的是一次完整的回覆。"), format!("{name} streamed an answer that was asked for whole."))
        })?;
    if let Some(err) = super::error_message(&response) {
        return Err(err);
    }
    if provider.is_anthropic() {
        Ok(anthropic_reply(&response))
    } else if provider.wire_api == "responses" {
        Ok(responses_reply(&response))
    } else {
        chat_reply(&response)
    }
}

/// Arguments arrive as a JSON string in the OpenAI wires; a model that sends
/// something unreadable gets an empty object, and the tool says what is missing.
fn parse_arguments(raw: &Value) -> Value {
    match raw {
        Value::String(s) if s.trim().is_empty() => json!({}),
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
        Value::Object(_) => raw.clone(),
        _ => json!({}),
    }
}

// ── Anthropic Messages ───────────────────────────────────────────────────────

fn anthropic_body(provider: &Provider, system: &str, turns: &[Turn], tools: &[Tool]) -> Value {
    let messages: Vec<Value> = turns
        .iter()
        .map(|t| match t {
            Turn::User(text) => json!({ "role": "user", "content": text }),
            Turn::Assistant { text, calls } => {
                let mut content = Vec::new();
                if !text.is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                for c in calls {
                    content.push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments }));
                }
                json!({ "role": "assistant", "content": content })
            }
            Turn::Results(results) => json!({
                "role": "user",
                "content": results.iter().map(|(id, _, out)| json!({ "type": "tool_result", "tool_use_id": id, "content": out })).collect::<Vec<_>>(),
            }),
        })
        .collect();
    json!({
        "model": provider.model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": messages,
        "tools": tools.iter().map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.parameters })).collect::<Vec<_>>(),
    })
}

fn anthropic_reply(response: &Value) -> Reply {
    let mut reply = Reply::default();
    for block in response.get("content").and_then(Value::as_array).into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => reply.text.push_str(block.get("text").and_then(Value::as_str).unwrap_or("")),
            Some("tool_use") => reply.calls.push(Call {
                id: block.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                name: block.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                arguments: parse_arguments(block.get("input").unwrap_or(&Value::Null)),
            }),
            _ => {}
        }
    }
    reply
}

// ── OpenAI Chat Completions ──────────────────────────────────────────────────

fn chat_body(provider: &Provider, system: &str, turns: &[Turn], tools: &[Tool]) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": system })];
    for t in turns {
        match t {
            Turn::User(text) => messages.push(json!({ "role": "user", "content": text })),
            Turn::Assistant { text, calls } => {
                let mut m = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) } });
                if !calls.is_empty() {
                    m["tool_calls"] = calls
                        .iter()
                        .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments.to_string() } }))
                        .collect();
                }
                messages.push(m);
            }
            Turn::Results(results) => {
                for (id, _, out) in results {
                    messages.push(json!({ "role": "tool", "tool_call_id": id, "content": out }));
                }
            }
        }
    }
    json!({
        "model": provider.model,
        "messages": messages,
        "tools": tools.iter().map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } })).collect::<Vec<_>>(),
    })
}

fn chat_reply(response: &Value) -> Result<Reply, String> {
    let message = response
        .pointer("/choices/0/message")
        .ok_or_else(|| -> String { tr!("API 的回應不如預期：沒有 choices。", "Unexpected API response: no choices.") })?;
    let text = super::openai::content_text(message.get("content"));
    let calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, c)| Call {
            id: c.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("call_{i}")),
            name: c.pointer("/function/name").and_then(Value::as_str).unwrap_or("").to_string(),
            arguments: parse_arguments(c.pointer("/function/arguments").unwrap_or(&Value::Null)),
        })
        .collect();
    Ok(Reply { text, calls })
}

// ── OpenAI Responses ─────────────────────────────────────────────────────────

fn responses_body(provider: &Provider, system: &str, turns: &[Turn], tools: &[Tool]) -> Value {
    let mut input = Vec::new();
    for t in turns {
        match t {
            Turn::User(text) => input.push(json!({ "role": "user", "content": text })),
            Turn::Assistant { text, calls } => {
                if !text.is_empty() {
                    input.push(json!({ "role": "assistant", "content": text }));
                }
                for c in calls {
                    input.push(json!({ "type": "function_call", "call_id": c.id, "name": c.name, "arguments": c.arguments.to_string() }));
                }
            }
            Turn::Results(results) => {
                for (id, _, out) in results {
                    input.push(json!({ "type": "function_call_output", "call_id": id, "output": out }));
                }
            }
        }
    }
    json!({
        "model": provider.model,
        "instructions": system,
        "input": input,
        "tools": tools.iter().map(|t| json!({ "type": "function", "name": t.name, "description": t.description, "parameters": t.parameters })).collect::<Vec<_>>(),
    })
}

fn responses_reply(response: &Value) -> Reply {
    let mut reply = Reply::default();
    for item in response.get("output").and_then(Value::as_array).into_iter().flatten() {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                for part in item.get("content").and_then(Value::as_array).into_iter().flatten() {
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        reply.text.push_str(part.get("text").and_then(Value::as_str).unwrap_or(""));
                    }
                }
            }
            Some("function_call") => reply.calls.push(Call {
                id: item.get("call_id").and_then(Value::as_str).unwrap_or("").to_string(),
                name: item.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                arguments: parse_arguments(item.get("arguments").unwrap_or(&Value::Null)),
            }),
            _ => {}
        }
    }
    reply
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(kind: &str, wire: &str) -> Provider {
        let mut p = Provider::anthropic("m");
        p.kind = kind.into();
        p.wire_api = wire.into();
        p
    }

    fn conversation() -> Vec<Turn> {
        vec![
            Turn::User("各團隊現況?".into()),
            Turn::Assistant { text: String::new(), calls: vec![Call { id: "c1".into(), name: "list_teams".into(), arguments: json!({}) }] },
            Turn::Results(vec![("c1".into(), "list_teams".into(), "測試2: finished".into())]),
        ]
    }

    fn tools() -> Vec<Tool> {
        vec![Tool { name: "list_teams".into(), description: "Lists the teams.".into(), parameters: json!({ "type": "object", "properties": {} }) }]
    }

    #[test]
    fn each_wire_carries_the_calls_and_their_results() {
        let a = anthropic_body(&provider("anthropic", "chat"), "sys", &conversation(), &tools());
        assert_eq!(a["system"], "sys");
        assert_eq!(a["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(a["messages"][2]["content"][0]["tool_use_id"], "c1");
        assert_eq!(a["tools"][0]["input_schema"]["type"], "object");

        let c = chat_body(&provider("openai", "chat"), "sys", &conversation(), &tools());
        assert_eq!(c["messages"][0]["role"], "system");
        assert_eq!(c["messages"][2]["tool_calls"][0]["function"]["arguments"], "{}");
        assert_eq!(c["messages"][3]["role"], "tool");
        assert_eq!(c["tools"][0]["function"]["name"], "list_teams");

        let r = responses_body(&provider("openai", "responses"), "sys", &conversation(), &tools());
        assert_eq!(r["instructions"], "sys");
        assert_eq!(r["input"][1]["type"], "function_call");
        assert_eq!(r["input"][2]["type"], "function_call_output");
        assert_eq!(r["tools"][0]["type"], "function");
    }

    #[test]
    fn each_wire_s_answer_is_read_into_text_and_calls() {
        let a = anthropic_reply(&json!({ "content": [{ "type": "text", "text": "好" }, { "type": "tool_use", "id": "t1", "name": "team_detail", "input": { "team": "team-3" } }] }));
        assert_eq!((a.text.as_str(), a.calls[0].arguments["team"].as_str()), ("好", Some("team-3")));

        let c = chat_reply(&json!({ "choices": [{ "message": { "content": null, "tool_calls": [{ "id": "x", "type": "function", "function": { "name": "list_teams", "arguments": "{\"all\":true}" } }] } }] })).unwrap();
        assert_eq!((c.calls[0].name.as_str(), c.calls[0].arguments["all"].as_bool()), ("list_teams", Some(true)));
        assert!(c.text.is_empty());

        let r = responses_reply(&json!({ "output": [
            { "type": "reasoning", "summary": [] },
            { "type": "function_call", "call_id": "fc1", "name": "list_teams", "arguments": "not json" },
            { "type": "message", "content": [{ "type": "output_text", "text": "查好了" }] },
        ] }));
        assert_eq!((r.calls[0].id.as_str(), r.calls[0].arguments.clone(), r.text.as_str()), ("fc1", json!({}), "查好了"));
    }
}
