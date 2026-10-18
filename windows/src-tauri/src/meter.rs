// Coucou's meter for Copilot members on an endpoint of their own (the cg
// way). Copilot CLI over ACP reports no token usage anywhere, so a team
// member that runs on its own OpenAI-style endpoint is given a local address
// instead: http://127.0.0.1:<port>/m/<token>. The meter passes every request
// on to the real endpoint unchanged — headers, key, body — streams the answer
// back as it comes, and reads the `usage` the endpoint puts in it (the final
// `response.completed` of the Responses API, the last chunk of a chat
// stream, or a plain JSON answer). Nothing is kept: the usage goes to the
// member's team record, the rest only passes through. Two small things stay
// per seat, for the person's eyes: the endpoint's last refusal (its status,
// the path asked and its own words), and for an agent test (a `test:` key)
// what its sentence used — so Settings can say what really went wrong.
//
// It listens on 127.0.0.1 only, each member's address carries a token
// nobody can guess, and it forwards only to the endpoint the member was set
// up with.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::log;
use crate::usage::{self, Usage};

/// Where metered usage goes: the seat's key and what it used.
pub type Report = Arc<dyn Fn(&str, Usage) + Send + Sync>;

struct Route {
    upstream: String,
    key: String,
}

/// The seat keys of an agent test (Settings' and Agent Pool's 測試).
pub const TEST: &str = "test:";

/// The endpoint said no: what it was asked and what it answered.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub status: u16,
    /// The path asked of the endpoint, after its base ("/v1/responses").
    pub path: String,
    /// The endpoint's own words, on one line, cut at 600 bytes.
    pub words: String,
}

static GLOBAL: OnceLock<Arc<Meter>> = OnceLock::new();

/// The app's meter, once it listens.
pub fn global() -> Option<Arc<Meter>> {
    GLOBAL.get().cloned()
}

pub fn install(meter: Arc<Meter>) {
    let _ = GLOBAL.set(meter);
}

pub struct Meter {
    port: u16,
    routes: Mutex<HashMap<String, Route>>,
    tokens: Mutex<HashMap<String, String>>,
    report: OnceLock<Report>,
    refusals: Mutex<HashMap<String, Refused>>,
    tested: Mutex<HashMap<String, Usage>>,
}

impl Meter {
    /// Starts listening on a free local port.
    pub async fn start() -> std::io::Result<Arc<Meter>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let meter = Arc::new(Meter { port, routes: Mutex::new(HashMap::new()), tokens: Mutex::new(HashMap::new()), report: OnceLock::new(), refusals: Mutex::new(HashMap::new()), tested: Mutex::new(HashMap::new()) });
        let m = meter.clone();
        tokio::spawn(async move {
            loop {
                let Ok((conn, _)) = listener.accept().await else { continue };
                let m = m.clone();
                tokio::spawn(async move {
                    if let Err(e) = m.serve(conn).await {
                        log::line(format!("meter: {e}"));
                    }
                });
            }
        });
        log::line(format!("meter: listening on 127.0.0.1:{port}"));
        Ok(meter)
    }

    pub fn set_report(&self, report: Report) {
        let _ = self.report.set(report);
    }

    /// The local address that stands for `upstream` for the seat `key`. The
    /// same seat gets the same address every time (so its launch stays the same).
    pub fn route(&self, upstream: &str, key: &str) -> String {
        let token = self.tokens.lock().unwrap().entry(key.to_string()).or_insert_with(crate::team::orchestrator::fresh_token).clone();
        self.routes.lock().unwrap().insert(token.clone(), Route { upstream: upstream.trim_end_matches('/').to_string(), key: key.to_string() });
        format!("http://127.0.0.1:{}/m/{token}", self.port)
    }

    /// The endpoint's last refusal for the seat `key`, if it refused one.
    pub fn last_refusal(&self, key: &str) -> Option<Refused> {
        self.refusals.lock().unwrap().get(key).cloned()
    }

    /// A fresh start for the seat `key`: no refusal, nothing used.
    pub fn forget(&self, key: &str) {
        self.refusals.lock().unwrap().remove(key);
        self.tested.lock().unwrap().remove(key);
    }

    /// What an agent test's calls used, added up (a `test:` key only).
    pub fn used(&self, key: &str) -> Option<Usage> {
        self.tested.lock().unwrap().get(key).cloned()
    }

    fn refused(&self, key: &str, status: u16, path: &str, words: &str) {
        self.refusals.lock().unwrap().insert(key.to_string(), Refused { status, path: path.to_string(), words: words.trim().to_string() });
    }

    fn metered(&self, key: &str, u: Usage) {
        if key.starts_with(TEST) {
            self.tested.lock().unwrap().entry(key.to_string()).or_insert_with(|| Usage { model: u.model.clone(), ..Usage::default() }).add(&u);
        }
        if let Some(report) = self.report.get() {
            report(key, u);
        }
    }

    async fn serve(&self, mut conn: TcpStream) -> Result<(), String> {
        // The request: its head, then its body.
        let mut buf = Vec::with_capacity(8192);
        let head_end = loop {
            let mut chunk = [0u8; 8192];
            let n = conn.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(i) = find(&buf, b"\r\n\r\n") {
                break i + 4;
            }
            if buf.len() > 256 * 1024 {
                return respond(&mut conn, 431, "headers too large").await;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let mut lines = head.split("\r\n");
        let first = lines.next().unwrap_or("");
        let mut parts = first.split_whitespace();
        let method = parts.next().unwrap_or("GET").to_string();
        let target = parts.next().unwrap_or("/").to_string();
        let headers: Vec<(String, String)> = lines
            .filter(|l| !l.is_empty())
            .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
            .collect();
        let header = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());

        let Some(rest) = target.strip_prefix("/m/") else { return respond(&mut conn, 404, "not here").await };
        let (token, path) = rest.split_once('/').map(|(t, p)| (t.to_string(), format!("/{p}"))).unwrap_or((rest.to_string(), String::new()));
        let found = self.routes.lock().unwrap().get(&token).map(|r| (r.upstream.clone(), r.key.clone()));
        let Some((upstream, key)) = found else { return respond(&mut conn, 404, "unknown route").await };
        if header("upgrade").is_some() {
            return respond(&mut conn, 501, "Agent Center's meter does not carry upgraded connections").await;
        }

        // The body, as sent (by length, or chunked).
        let mut body = buf[head_end..].to_vec();
        if let Some(len) = header("content-length").and_then(|v| v.parse::<usize>().ok()) {
            while body.len() < len {
                let mut chunk = vec![0u8; (len - body.len()).min(65536)];
                let n = conn.read(&mut chunk).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..n]);
            }
        } else if header("transfer-encoding").map(|v| v.to_lowercase().contains("chunked")).unwrap_or(false) {
            body = read_chunked(&mut conn, body).await?;
        }
        let model = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v.get("model").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        // A chat stream carries its usage only when asked to.
        if path.ends_with("/chat/completions") {
            body = ask_for_usage(body);
        }

        // On to the real endpoint.
        let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut req = client.request(method, format!("{upstream}{path}"));
        for (k, v) in &headers {
            let lower = k.to_lowercase();
            if ["host", "content-length", "connection", "transfer-encoding", "accept-encoding", "keep-alive", "proxy-connection"].contains(&lower.as_str()) {
                continue;
            }
            req = req.header(k, v);
        }
        req = req.header("accept-encoding", "identity");
        let resp = match req.body(body).send().await {
            Ok(r) => r,
            Err(e) => return respond(&mut conn, 502, &format!("Agent Center's meter could not reach the endpoint: {e}")).await,
        };

        // Its answer, passed back as it streams, read for usage on the way.
        let status = resp.status();
        let mut out = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
        for (k, v) in resp.headers() {
            let lower = k.as_str().to_lowercase();
            if ["content-length", "transfer-encoding", "connection", "content-encoding", "keep-alive"].contains(&lower.as_str()) {
                continue;
            }
            if let Ok(v) = v.to_str() {
                out.push_str(&format!("{k}: {v}\r\n"));
            }
        }
        out.push_str("transfer-encoding: chunked\r\nconnection: close\r\n\r\n");
        conn.write_all(out.as_bytes()).await.map_err(|e| e.to_string())?;

        let mut reader = Reader::default();
        // A refusal's own words go to the log: the agent may sum one up
        // wrongly (Copilot calls a gateway's "key not allowed to access
        // model" 401 a failed authentication).
        let mut refusal: Option<Vec<u8>> = (!status.is_success()).then(Vec::new);
        let mut resp = resp;
        loop {
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    if let Some(said) = refusal.as_mut().filter(|s| s.len() < 600) {
                        said.extend_from_slice(&bytes[..bytes.len().min(600 - said.len())]);
                    }
                    reader.feed(&bytes);
                    conn.write_all(format!("{:x}\r\n", bytes.len()).as_bytes()).await.map_err(|e| e.to_string())?;
                    conn.write_all(&bytes).await.map_err(|e| e.to_string())?;
                    conn.write_all(b"\r\n").await.map_err(|e| e.to_string())?;
                }
                Ok(None) => break,
                Err(e) => {
                    log::line(format!("meter: the endpoint's answer broke off: {e}"));
                    break;
                }
            }
        }
        let _ = conn.write_all(b"0\r\n\r\n").await;
        let _ = conn.flush().await;
        if let Some(said) = refusal {
            let said = String::from_utf8_lossy(&said).replace(['\r', '\n'], " ");
            log::line(format!("meter: {key} {upstream}{path} (model {model}) answered HTTP {}: {}", status.as_u16(), said.trim()));
            // The path as the endpoint saw it, its base included ("/v1/responses").
            let asked = reqwest::Url::parse(&format!("{upstream}{path}")).map(|u| u.path().to_string()).unwrap_or_else(|_| path.clone());
            self.refused(&key, status.as_u16(), &asked, &said);
        }

        if let Some(u) = reader.usage(&model) {
            self.metered(&key, u);
        }
        Ok(())
    }
}

/// Reads usage out of an answer as it streams: SSE `data:` lines, or a whole JSON body.
#[derive(Default)]
pub struct Reader {
    text: Vec<u8>,
    found: Option<Value>,
}

impl Reader {
    pub fn feed(&mut self, bytes: &[u8]) {
        self.text.extend_from_slice(bytes);
        // An event stream: look at each complete line, then let it go.
        while let Some(i) = self.text.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.text.drain(..=i).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else {
                // Not a stream (or a JSON body with newlines): keep it whole.
                if !line.trim().is_empty() && !line.trim_start().starts_with("event:") && !line.trim_start().starts_with(':') {
                    let mut back = line.as_bytes().to_vec();
                    back.extend_from_slice(&self.text);
                    self.text = back;
                    return;
                }
                continue;
            };
            if let Ok(v) = serde_json::from_str::<Value>(data.trim()) {
                self.take(&v);
            }
        }
    }

    fn take(&mut self, v: &Value) {
        if let Some(u) = v.pointer("/response/usage").or_else(|| v.get("usage")).filter(|u| u.is_object()) {
            self.found = Some(u.clone());
        }
    }

    /// The usage the answer carried, if it carried one.
    pub fn usage(mut self, model: &str) -> Option<Usage> {
        if self.found.is_none() && !self.text.is_empty() {
            if let Ok(v) = serde_json::from_slice::<Value>(&self.text) {
                self.take(&v);
            }
        }
        let u = usage::from_openai(model, self.found.as_ref()?);
        (!u.is_empty()).then_some(u)
    }
}

/// A streamed chat request, asked to end with its usage (`stream_options.include_usage`).
fn ask_for_usage(body: Vec<u8>) -> Vec<u8> {
    let Ok(mut v) = serde_json::from_slice::<Value>(&body) else { return body };
    if v.get("stream").and_then(Value::as_bool) != Some(true) || v.pointer("/stream_options/include_usage").is_some() {
        return body;
    }
    let Some(obj) = v.as_object_mut() else { return body };
    let options = obj.entry("stream_options").or_insert_with(|| Value::Object(Default::default()));
    if let Some(o) = options.as_object_mut() {
        o.insert("include_usage".into(), Value::Bool(true));
    }
    serde_json::to_vec(&v).unwrap_or(body)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

async fn read_chunked(conn: &mut TcpStream, mut raw: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        // Make sure a size line is there.
        while find(&raw, b"\r\n").is_none() {
            let mut chunk = [0u8; 8192];
            let n = conn.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Ok(out);
            }
            raw.extend_from_slice(&chunk[..n]);
        }
        let i = find(&raw, b"\r\n").unwrap();
        let size = usize::from_str_radix(String::from_utf8_lossy(&raw[..i]).split(';').next().unwrap_or("0").trim(), 16).map_err(|e| e.to_string())?;
        raw.drain(..i + 2);
        if size == 0 {
            return Ok(out);
        }
        while raw.len() < size + 2 {
            let mut chunk = [0u8; 8192];
            let n = conn.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..n]);
        }
        out.extend_from_slice(&raw[..size.min(raw.len())]);
        raw.drain(..(size + 2).min(raw.len()));
    }
}

async fn respond(conn: &mut TcpStream, code: u16, text: &str) -> Result<(), String> {
    let reply = format!("HTTP/1.1 {code} Error\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
    conn.write_all(reply.as_bytes()).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_is_read_from_a_responses_stream_a_chat_stream_and_a_plain_answer() {
        let mut r = Reader::default();
        r.feed(b"event: response.created\ndata: {\"type\":\"response.created\"}\n\nevent: response.output_text.delta\ndata: {\"delta\":\"hi\"}\n\n");
        r.feed(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1200,\"input_tokens_details\":{\"cached_tokens\":1000},\"output_tokens\":30}}}\n\n");
        let u = r.usage("deepseek-v4.1-flash").unwrap();
        assert_eq!((u.input, u.cache_read, u.output, u.model.as_str()), (200, 1000, 30, "deepseek-v4.1-flash"));

        let mut r = Reader::default();
        r.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n");
        let u = r.usage("m").unwrap();
        assert_eq!((u.input, u.output), (50, 5));

        let mut r = Reader::default();
        r.feed(b"{\n  \"id\": \"x\",\n  \"usage\": {\"prompt_tokens\": 7, \"completion_tokens\": 3}\n}");
        assert_eq!(r.usage("m").unwrap().input, 7);

        let mut r = Reader::default();
        r.feed(b"data: {\"delta\":\"no usage here\"}\n\n");
        assert!(r.usage("m").is_none());
    }

    #[test]
    fn a_streamed_chat_request_is_asked_for_its_usage_and_nothing_else_changes() {
        let asked: Value = serde_json::from_slice(&ask_for_usage(br#"{"model":"m","stream":true,"messages":[]}"#.to_vec())).unwrap();
        assert_eq!(asked["stream_options"]["include_usage"], true);
        let plain = br#"{"model":"m","messages":[]}"#.to_vec();
        assert_eq!(ask_for_usage(plain.clone()), plain);
        let already = br#"{"model":"m","stream":true,"stream_options":{"include_usage":false}}"#.to_vec();
        assert_eq!(ask_for_usage(already.clone()), already);
    }


    /// Copilot on its own endpoint (cg), run through the meter for one short
    /// turn: its usage is read. Needs that agent in Settings and the network.
    #[test]
    #[ignore]
    fn the_real_copilot_on_its_own_endpoint_is_metered() {
        use crate::acp::{Agents, Event, Launch, Protocol, Sink};
        let profile = crate::settings::load()
            .agents
            .into_iter()
            .find(|a| a.protocol == Protocol::Acp && a.env.get("COPILOT_PROVIDER_BASE_URL").is_some_and(|b| b.starts_with("http")))
            .expect("a Copilot agent on its own endpoint in Settings");
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let reported = Arc::new(Mutex::new(Vec::<Usage>::new()));
        let meter = runtime.block_on(Meter::start()).unwrap();
        let r2 = reported.clone();
        meter.set_report(Arc::new(move |_, u| r2.lock().unwrap().push(u)));
        // A team member's own model, which must win over the profile's COPILOT_MODEL.
        let mut launch = Launch { model: Some("glm-5.3-flash".into()), ..Launch::default() };
        launch.env.insert("COPILOT_PROVIDER_BASE_URL".into(), meter.route(&profile.env["COPILOT_PROVIDER_BASE_URL"], "test:metered"));
        let own = Arc::new(Mutex::new(Vec::<Usage>::new()));
        let o2 = own.clone();
        let sink: Sink = Arc::new(move |e: Event| {
            if let Event::Usage(u) = e {
                o2.lock().unwrap().push(u);
            }
        });
        let agents = Agents::default();
        let outcome = runtime.block_on(agents.prompt(&sink, "test:metered", &profile, &launch, "Reply with the single word OK.".into()));
        runtime.block_on(agents.shutdown());
        assert!(outcome.is_ok(), "{outcome:?}");
        let got = reported.lock().unwrap().clone();
        eprintln!("metered: {got:?}");
        assert!(!got.is_empty(), "nothing was metered");
        assert!(got.iter().all(|u| u.model == "glm-5.3-flash" && u.input + u.cache_read > 0 && u.output > 0), "{got:?}");
        eprintln!("the agent's own report: {:?}", own.lock().unwrap());
    }
    #[test]
    fn a_refusal_is_kept_for_its_seat_and_a_test_s_usage_is_added_up() {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        runtime.block_on(async {
            // The endpoint: no Responses API (404), then two chat answers.
            let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let up_port = upstream.local_addr().unwrap().port();
            tokio::spawn(async move {
                for n in 0..3 {
                    let (mut c, _) = upstream.accept().await.unwrap();
                    let mut buf = vec![0u8; 65536];
                    let mut got = Vec::new();
                    loop {
                        let k = c.read(&mut buf).await.unwrap();
                        got.extend_from_slice(&buf[..k]);
                        if let Some(i) = find(&got, b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&got[..i]).to_lowercase();
                            let len = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                            if got.len() >= i + 4 + len {
                                break;
                            }
                        }
                    }
                    let (status, body) = if n == 0 { ("404 Not Found", "{\"detail\":\"Not Found\"}") } else { ("200 OK", "{\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":1}}") };
                    let reply = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}", body.len());
                    c.write_all(reply.as_bytes()).await.unwrap();
                }
            });

            let meter = Meter::start().await.unwrap();
            let key = format!("{TEST}cg");
            let base = meter.route(&format!("http://127.0.0.1:{up_port}/v1"), &key);
            let ask = |path: &str| reqwest::Client::new().post(format!("{base}{path}")).json(&serde_json::json!({ "model": "m", "input": "hi" })).send();
            assert_eq!(ask("/responses").await.unwrap().status().as_u16(), 404);
            for _ in 0..100 {
                if meter.last_refusal(&key).is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let refused = meter.last_refusal(&key).expect("the refusal is kept");
            assert_eq!((refused.status, refused.path.as_str()), (404, "/v1/responses"));
            assert!(refused.words.contains("Not Found"), "{refused:?}");
            assert!(meter.last_refusal("team:shop:ai3").is_none());

            for _ in 0..2 {
                ask("/chat/completions").await.unwrap().text().await.unwrap();
            }
            for _ in 0..100 {
                if meter.used(&key).is_some_and(|u| u.input == 20) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let used = meter.used(&key).expect("a test's usage is kept");
            assert_eq!((used.input, used.output), (20, 2));
            // A fresh test starts from nothing.
            meter.forget(&key);
            assert!(meter.last_refusal(&key).is_none() && meter.used(&key).is_none());
        });
    }

    /// A stand-in endpoint behind the meter: the request arrives as sent,
    /// the answer comes back whole, and its usage is reported for the seat.
    #[test]
    fn the_meter_passes_requests_on_and_reports_their_usage() {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        runtime.block_on(async {
            // The endpoint: answers one request with a short event stream.
            let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let up_port = upstream.local_addr().unwrap().port();
            let seen = Arc::new(Mutex::new(String::new()));
            let seen2 = seen.clone();
            tokio::spawn(async move {
                let (mut c, _) = upstream.accept().await.unwrap();
                let mut buf = vec![0u8; 65536];
                let mut got = Vec::new();
                loop {
                    let n = c.read(&mut buf).await.unwrap();
                    got.extend_from_slice(&buf[..n]);
                    if let Some(i) = find(&got, b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&got[..i]).to_lowercase();
                        let len = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        if got.len() >= i + 4 + len {
                            break;
                        }
                    }
                }
                *seen2.lock().unwrap() = String::from_utf8_lossy(&got).to_string();
                let body = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":2}}}\n\n";
                let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{body}", body.len());
                c.write_all(reply.as_bytes()).await.unwrap();
            });

            let meter = Meter::start().await.unwrap();
            let reported = Arc::new(Mutex::new(Vec::<(String, Usage)>::new()));
            let r2 = reported.clone();
            meter.set_report(Arc::new(move |key, u| r2.lock().unwrap().push((key.to_string(), u))));
            let base = meter.route(&format!("http://127.0.0.1:{up_port}/v1"), "team:shop:ai3");
            assert_eq!(base, meter.route(&format!("http://127.0.0.1:{up_port}/v1"), "team:shop:ai3"));

            let answer = reqwest::Client::new()
                .post(format!("{base}/responses"))
                .bearer_auth("sk-test")
                .json(&serde_json::json!({ "model": "deepseek-v4.1-flash", "stream": true, "input": "hi" }))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert!(answer.contains("response.completed") && answer.contains("\"OK\""));
            let req = seen.lock().unwrap().clone();
            assert!(req.starts_with("POST /v1/responses HTTP/1.1"), "{req}");
            assert!(req.to_lowercase().contains("authorization: bearer sk-test"));
            assert!(req.contains("\"model\":\"deepseek-v4.1-flash\""));
            for _ in 0..100 {
                if !reported.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let got = reported.lock().unwrap().clone();
            assert_eq!(got.len(), 1);
            assert_eq!(got[0].0, "team:shop:ai3");
            assert_eq!((got[0].1.input, got[0].1.output, got[0].1.model.as_str()), (100, 2, "deepseek-v4.1-flash"));
        });
    }
}
