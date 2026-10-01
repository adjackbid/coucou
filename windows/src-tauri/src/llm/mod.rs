// LLM providers — the chat talks to a model through one of these, never to a
// hard-coded endpoint. Two kinds cover nearly everything: Anthropic's Messages
// API, and the OpenAI shape (Chat Completions or Responses) that OpenAI, Azure,
// OpenRouter, Ollama, LM Studio, vLLM and most proxies speak.
//
// The history is kept in a neutral format and converted on the way out, so a
// conversation started on one provider can continue on another.
//
// Everything happens here rather than in the island: the API key never leaves
// the Credential Manager, and file bytes never cross the IPC boundary.

pub mod anthropic;
pub mod openai;

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::secrets;

/// Text and code files are inlined; anything larger is skipped, as on macOS.
const MAX_INLINE_TEXT: u64 = 200_000;
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

pub const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
You can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

// ── Configuration ─────────────────────────────────────────────────────────────

/// One endpoint the chat can talk to. Lives in settings.json; its key lives in
/// the Credential Manager under `provider:<id>`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    /// "anthropic" (Messages API) or "openai" (Chat Completions / Responses).
    pub kind: String,
    pub base_url: String,
    pub model: String,
    /// OpenAI kind only: "chat" → /v1/chat/completions, "responses" → /v1/responses.
    #[serde(default = "default_wire")]
    pub wire_api: String,
    /// How the key travels: "bearer", "x-api-key", "none" or "header:<name>".
    /// Empty means the kind's own default.
    #[serde(default)]
    pub auth: String,
    /// Extra headers sent verbatim. "{secret}" in a value becomes the key —
    /// here, never in the front end.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub capabilities: Capabilities,
}

fn default_wire() -> String {
    "chat".into()
}

/// What the endpoint can take. `None` means "whatever the kind usually can".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub images: Option<bool>,
    pub pdf: Option<bool>,
    pub web_search: Option<bool>,
}

/// The resolved version of `Capabilities`.
#[derive(Debug, Clone, Copy)]
pub struct Caps {
    pub images: bool,
    pub pdf: bool,
    pub web_search: bool,
}

impl Provider {
    /// The one provider every install starts with.
    pub fn anthropic(model: &str) -> Self {
        Self {
            id: "anthropic".into(),
            name: "Claude".into(),
            kind: "anthropic".into(),
            base_url: "https://api.anthropic.com".into(),
            model: model.into(),
            wire_api: default_wire(),
            auth: String::new(),
            headers: BTreeMap::new(),
            capabilities: Capabilities::default(),
        }
    }

    pub fn is_anthropic(&self) -> bool {
        self.kind == "anthropic"
    }

    pub fn caps(&self) -> Caps {
        let (images, pdf, web_search) = if self.is_anthropic() {
            (true, true, true)
        } else {
            // Images are near-universal in the OpenAI shape; PDFs only OpenAI's
            // own API takes, and the web search tool is Anthropic's.
            (true, false, false)
        };
        Caps {
            images: self.capabilities.images.unwrap_or(images),
            pdf: self.capabilities.pdf.unwrap_or(pdf),
            web_search: self.capabilities.web_search.unwrap_or(web_search),
        }
    }

    /// Credential Manager key for this provider.
    pub fn secret_key(&self) -> String {
        format!("provider:{}", self.id)
    }

    fn auth_mode(&self) -> &str {
        if !self.auth.trim().is_empty() {
            self.auth.trim()
        } else if self.is_anthropic() {
            "x-api-key"
        } else {
            "bearer"
        }
    }

    fn needs_key(&self) -> bool {
        self.auth_mode() != "none"
    }

    /// The key, or the pre-provider "anthropic-api-key" entry for the default
    /// Claude provider, so an existing install keeps working untouched.
    fn secret(&self) -> Option<String> {
        secrets::get(&self.secret_key()).or_else(|| {
            (self.id == "anthropic").then(|| secrets::get("anthropic-api-key")).flatten()
        })
    }

    /// `base_url` + `/v1/<path>`, tolerating a base that already ends in `/v1`
    /// (OpenRouter, Ollama and Azure are all written that way).
    pub fn endpoint(&self, path: &str) -> String {
        let mut base = self.base_url.trim().trim_end_matches('/').to_string();
        if base.ends_with("/v1") {
            base.truncate(base.len() - 3);
        }
        format!("{base}/v1/{path}")
    }

    /// Adds the key and the extra headers. The key is only ever read here.
    fn authorize(&self, mut req: reqwest::RequestBuilder, key: Option<&str>) -> reqwest::RequestBuilder {
        if let Some(key) = key {
            req = match self.auth_mode() {
                "none" => req,
                "x-api-key" => req.header("x-api-key", key),
                mode if mode.starts_with("header:") => req.header(mode["header:".len()..].trim(), key),
                _ => req.bearer_auth(key),
            };
        }
        for (name, value) in &self.headers {
            if name.trim().is_empty() {
                continue;
            }
            req = req.header(name.trim(), value.replace("{secret}", key.unwrap_or("")));
        }
        req
    }
}

// ── Neutral conversation ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone)]
pub enum Part {
    Text(String),
    /// Base64 bytes with their media type.
    Image { media: String, data: String },
    Pdf { name: String, data: String },
}

#[derive(Debug, Clone)]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
}

impl Message {
    pub fn text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|p| match p {
                Part::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Default)]
pub struct Chat {
    messages: Mutex<Vec<Message>>,
}

impl Chat {
    pub fn reset(&self) {
        self.messages.lock().unwrap().clear();
    }

    fn is_empty(&self) -> bool {
        self.messages.lock().unwrap().is_empty()
    }

    fn push(&self, message: Message) {
        self.messages.lock().unwrap().push(message);
    }

    fn pop(&self) {
        self.messages.lock().unwrap().pop();
    }

    fn snapshot(&self) -> Vec<Message> {
        self.messages.lock().unwrap().clone()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

// ── Entry points ──────────────────────────────────────────────────────────────

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    chat: &Chat,
    provider: &Provider,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let key = provider.secret();
    if key.is_none() && provider.needs_key() {
        return Err(format!("No API key for {}. Open settings.", provider.name));
    }
    let caps = provider.caps();

    let mut parts: Vec<Part> = Vec::new();
    // File / window context rides along with the first message only, exactly
    // like ClaudeService.chat() on macOS.
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                parts.extend(file_parts(path, &caps));
                parts.push(Part::Text(format!("File: {name}")));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                parts.push(Part::Text(text));
            }
            None => {}
        }
    }
    parts.push(Part::Text(query));
    chat.push(Message { role: Role::User, parts });

    let history = chat.snapshot();
    let result = if provider.is_anthropic() {
        anthropic::send(provider, key.as_deref(), &history, &caps).await
    } else {
        openai::send(provider, key.as_deref(), &history).await
    };

    match result {
        Ok(text) if !text.trim().is_empty() => {
            let text = text.trim().to_string();
            chat.push(Message { role: Role::Assistant, parts: vec![Part::Text(text.clone())] });
            Ok(ChatReply { text })
        }
        Ok(_) => {
            chat.pop();
            Err("No response text.".into())
        }
        Err(err) => {
            chat.pop(); // keep the history consistent with what the model saw
            Err(err)
        }
    }
}

/// The settings window's "Test" button: one tiny round trip, with the reply.
pub async fn test(provider: &Provider) -> Result<String, String> {
    let key = provider.secret();
    if key.is_none() && provider.needs_key() {
        return Err("No API key saved for this provider yet.".into());
    }
    let history = vec![Message {
        role: Role::User,
        parts: vec![Part::Text("Reply with the single word OK.".into())],
    }];
    let caps = Caps { images: false, pdf: false, web_search: false };
    let text = if provider.is_anthropic() {
        anthropic::send(provider, key.as_deref(), &history, &caps).await?
    } else {
        openai::send(provider, key.as_deref(), &history).await?
    };
    let snippet: String = text.trim().chars().take(80).collect();
    Ok(format!("{} answered: {snippet}", provider.model))
}

// ── Shared plumbing ───────────────────────────────────────────────────────────

pub(super) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// POSTs JSON, authorised, and returns the parsed body or a readable error.
pub(super) async fn post_json(
    provider: &Provider,
    key: Option<&str>,
    url: &str,
    extra_headers: &[(&str, &str)],
    body: &Value,
) -> Result<Value, String> {
    let mut req = client()?.post(url).header("content-type", "application/json");
    for (name, value) in extra_headers {
        req = req.header(*name, *value);
    }
    req = provider.authorize(req, key);

    let response = req
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key obvious.
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| error_message(&v))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("{} {status}: {detail}", provider.name));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad response from {}: {e}", provider.name))
}

/// `{"error":{"message":…}}`, `{"error":"…"}` and `{"message":"…"}` all occur.
pub(super) fn error_message(v: &Value) -> Option<String> {
    let error = v.get("error")?;
    if let Some(s) = error.as_str() {
        return Some(s.to_string());
    }
    error
        .get("message")
        .or_else(|| v.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// PDF → a PDF part, image → an image part, text/code → inline text. What the
/// provider cannot take is left out, with a line saying so rather than silence.
fn file_parts(path: &str, caps: &Caps) -> Vec<Part> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let image = match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    if let Some(media) = image {
        if !caps.images {
            return vec![Part::Text(format!("(The image {name} was attached, but this provider does not take images.)"))];
        }
        return std::fs::read(path)
            .map(|bytes| vec![Part::Image { media: media.into(), data: base64(&bytes) }])
            .unwrap_or_default();
    }
    if ext == "pdf" {
        if !caps.pdf {
            return vec![Part::Text(format!("(The PDF {name} was attached, but this provider does not take PDFs.)"))];
        }
        return std::fs::read(path)
            .map(|bytes| vec![Part::Pdf { name, data: base64(&bytes) }])
            .unwrap_or_default();
    }

    let Ok(meta) = std::fs::metadata(path) else { return Vec::new() };
    if meta.len() > MAX_INLINE_TEXT {
        return Vec::new();
    }
    std::fs::read_to_string(path)
        .map(|text| vec![Part::Text(format!("File contents:\n{text}"))])
        .unwrap_or_default()
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth.
pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    fn provider(base_url: &str) -> Provider {
        let mut p = Provider::anthropic("m");
        p.base_url = base_url.into();
        p
    }

    #[test]
    fn endpoints_tolerate_every_way_people_write_a_base_url() {
        assert_eq!(provider("https://api.anthropic.com").endpoint("messages"), "https://api.anthropic.com/v1/messages");
        assert_eq!(provider("https://api.anthropic.com/").endpoint("messages"), "https://api.anthropic.com/v1/messages");
        assert_eq!(provider("http://localhost:11434/v1").endpoint("chat/completions"), "http://localhost:11434/v1/chat/completions");
        assert_eq!(provider("https://openrouter.ai/api/v1/").endpoint("chat/completions"), "https://openrouter.ai/api/v1/chat/completions");
        assert_eq!(
            provider("https://x.openai.azure.com/openai/v1").endpoint("responses"),
            "https://x.openai.azure.com/openai/v1/responses"
        );
    }

    #[test]
    fn capabilities_follow_the_kind_unless_overridden() {
        let claude = Provider::anthropic("m");
        assert!(claude.caps().pdf && claude.caps().web_search);
        let mut local = Provider::anthropic("m");
        local.kind = "openai".into();
        assert!(local.caps().images && !local.caps().pdf && !local.caps().web_search);
        local.capabilities.pdf = Some(true);
        local.capabilities.images = Some(false);
        assert!(local.caps().pdf && !local.caps().images);
    }

    #[test]
    fn auth_defaults_follow_the_kind() {
        let mut p = Provider::anthropic("m");
        assert_eq!(p.auth_mode(), "x-api-key");
        p.kind = "openai".into();
        assert_eq!(p.auth_mode(), "bearer");
        p.auth = "none".into();
        assert!(!p.needs_key());
        p.auth = "header:api-key".into();
        assert!(p.needs_key());
    }

    #[test]
    fn error_messages_are_found_in_every_common_shape() {
        let a: Value = serde_json::from_str(r#"{"error":{"type":"x","message":"bad key"}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"error":"model not found"}"#).unwrap();
        let c: Value = serde_json::from_str(r#"{"ok":true}"#).unwrap();
        assert_eq!(error_message(&a).as_deref(), Some("bad key"));
        assert_eq!(error_message(&b).as_deref(), Some("model not found"));
        assert_eq!(error_message(&c), None);
    }
}
