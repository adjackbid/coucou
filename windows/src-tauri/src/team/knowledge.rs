// A team's knowledge base: documents the person gave the team — design
// notes, specs, pictures — for its members to work from.
//
// Every document is copied in when it is added, so the original can move or
// change without the team noticing. Each one is either for the leader only
// (the default) or shared with the whole team, and the two kinds live in
// different folders:
//
//   %APPDATA%\Coucou\team-knowledge\<team>\
//     index.json            what is there: names, kinds, who may read them
//     shared\               the documents every member may read
//     leader-<random>\      the leader's own: its name cannot be guessed
//     .removed\             documents taken out, kept 30 days
//
// None of it is in the team's work folder, which every member reads. A member
// that is not the leader is never told where the leader's folder is, cannot
// read it with `knowledge_read`, and is refused at the permission gate if it
// tries a path into it (policy::touches_private).
//
// Coucou reads text and pictures to the members itself; any other file is
// kept as it is and members are told where it is, to open with their own
// tools. Nothing here runs a file or reads a key.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// At most this many documents in a team.
pub const MAX_DOCS: usize = 50;
/// All of a team's documents together.
pub const MAX_TOTAL: u64 = 200 * 1024 * 1024;
/// Text larger than this is kept as a plain file: members open it themselves.
pub const MAX_TEXT: u64 = 2 * 1024 * 1024;
/// A picture larger than this is kept as a plain file: the model would refuse it.
pub const MAX_IMAGE: u64 = 5 * 1024 * 1024;
/// The largest document of any kind.
pub const MAX_FILE: u64 = 20 * 1024 * 1024;
/// Removed documents are kept this long, then deleted.
const KEEP_REMOVED_MS: u64 = 30 * 24 * 60 * 60 * 1000;

const INDEX: &str = "index.json";
const SHARED: &str = "shared";
const REMOVED: &str = ".removed";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    /// Every member may read it.
    Shared,
    /// Only the team's leader may read it. Anything unreadable is this.
    #[default]
    #[serde(other)]
    Leader,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DocKind {
    /// UTF-8 (or UTF-16 with a BOM) text, whatever its extension: md, txt,
    /// json, yaml, csv, code, svg…
    Text,
    /// png, jpeg, gif or webp a model can look at.
    Image,
    /// Anything else: pdf, docx, zip, bmp, text that is not UTF-8, text or
    /// pictures too large to hand over. Kept as it is; members get its path.
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    /// `k` and four hex digits, unique in the team.
    pub id: String,
    /// The name it was added under, for people and members to read.
    pub name: String,
    /// Its file in `shared\` or the leader's folder.
    pub file: String,
    pub kind: DocKind,
    pub bytes: u64,
    #[serde(default)]
    pub visibility: Visibility,
    pub added_at: u64,
    /// Where it was copied from: shown to the person and used to import it
    /// again. Never told to a member or the secretary.
    #[serde(default)]
    pub source: String,
    /// A hash of the content, to notice the same document added twice.
    #[serde(default)]
    pub hash: String,
    /// The person's one line about it; for a picture, what an agent that
    /// cannot see pictures still reads.
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    #[serde(default)]
    pub version: u32,
    /// The leader's folder: `leader-` and 16 random hex digits.
    #[serde(default)]
    pub leader_dir: String,
    #[serde(default)]
    pub docs: Vec<Doc>,
}

/// A document as the Teamwork window shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocView {
    pub id: String,
    pub name: String,
    pub kind: DocKind,
    pub bytes: u64,
    pub visibility: Visibility,
    pub added_at: u64,
    pub source: String,
    pub note: String,
    /// Its file is no longer in the knowledge folder.
    pub missing: bool,
    /// The original is still where it was copied from.
    pub source_exists: bool,
    /// A program or a shortcut: kept, never opened from Coucou.
    pub program: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_docs: usize,
    pub max_bytes: u64,
    pub max_text: u64,
    pub max_image: u64,
    pub max_file: u64,
}

pub fn limits() -> Limits {
    Limits { max_docs: MAX_DOCS, max_bytes: MAX_TOTAL, max_text: MAX_TEXT, max_image: MAX_IMAGE, max_file: MAX_FILE }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeView {
    pub docs: Vec<DocView>,
    pub bytes: u64,
    pub limits: Limits,
}

/// Something that looks like a key, in a text about to be added.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyLike {
    /// From 1.
    pub line: usize,
    /// Its first characters only.
    pub sample: String,
}

/// What adding a document came to: added, or held back for the person to
/// say again that it may go in (it looks like it has a key).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub doc: Option<DocView>,
    pub key_like: Option<KeyLike>,
}

/// `%APPDATA%\Coucou\team-knowledge`.
pub fn root() -> PathBuf {
    crate::settings::team_knowledge_dir()
}

/// A team's knowledge folder. The id must be a plain id (team::is_plain_id).
pub fn team_dir(team: &str) -> PathBuf {
    root().join(team)
}

fn now_ms() -> u64 {
    super::store::now_ms()
}

/// Random hex digits, from the system's random source through std.
fn random_hex(digits: usize) -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    let mut i = 0u64;
    while out.len() < digits {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
        i += 1;
    }
    out.truncate(digits);
    out
}

/// A content hash, to notice duplicates. Not a security measure.
fn hash_of(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// A name that stays a name: no folders, nothing Windows refuses.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['\\', '/']).next().unwrap_or(name);
    let clean: String = base.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let clean = clean.trim().trim_end_matches(['.', ' ']).to_string();
    if clean.is_empty() { "document".to_string() } else { clean }
}

/// The picture's media type, read from its first bytes (never its name).
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// The text in `bytes`, if it is text: UTF-8 (a BOM is dropped) or UTF-16
/// with a BOM, and no NUL anywhere.
pub fn as_text(bytes: &[u8]) -> Option<String> {
    let text = if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8(rest.to_vec()).ok()?
    } else if bytes.len() >= 2 && (bytes[..2] == [0xFF, 0xFE] || bytes[..2] == [0xFE, 0xFF]) {
        let little = bytes[0] == 0xFF;
        let body = &bytes[2..];
        if body.len() % 2 != 0 {
            return None;
        }
        let units: Vec<u16> = body.chunks(2).map(|c| if little { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        String::from_utf16(&units).ok()?
    } else {
        String::from_utf8(bytes.to_vec()).ok()?
    };
    if text.contains('\0') {
        return None;
    }
    Some(text)
}

/// What kind of document these bytes make, and the bytes to keep (text is
/// kept as UTF-8 without a BOM).
pub fn classify(bytes: Vec<u8>) -> (DocKind, Vec<u8>) {
    if sniff_image(&bytes).is_some() {
        let kind = if bytes.len() as u64 <= MAX_IMAGE { DocKind::Image } else { DocKind::File };
        return (kind, bytes);
    }
    // Text is read whole only when it is small enough to be handed over as text.
    if bytes.len() as u64 <= MAX_TEXT * 2 {
        if let Some(text) = as_text(&bytes) {
            let utf8 = text.into_bytes();
            if utf8.len() as u64 <= MAX_TEXT {
                return (DocKind::Text, utf8);
            }
            return (DocKind::File, bytes);
        }
    }
    (DocKind::File, bytes)
}

/// Programs, scripts and shortcuts: kept like anything else, never opened.
pub fn is_program(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    lower.contains('.')
        && matches!(
            ext,
            "exe" | "msi" | "msix" | "bat" | "cmd" | "ps1" | "psm1" | "vbs" | "vbe" | "js" | "jse" | "wsf" | "wsh" | "lnk" | "url" | "scr" | "com" | "cpl" | "hta" | "jar" | "reg" | "appx" | "appref-ms"
        )
}

// ── Keys ──────────────────────────────────────────────────────────────────────

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// How many `ok` characters follow `start` in `line`.
fn run_len(line: &str, start: usize, ok: impl Fn(char) -> bool) -> usize {
    line[start..].chars().take_while(|c| ok(*c)).count()
}

fn sample(s: &str) -> String {
    let head: String = s.chars().take(5).collect();
    format!("{head}…")
}

/// The first line that looks like it holds a key or a password, and the
/// start of what looked like one. Common shapes only: a key a person meant to
/// share is better caught here than in a model provider's log.
pub fn find_key_like(text: &str) -> Option<KeyLike> {
    const PREFIXES: &[(&str, usize, fn(char) -> bool)] = &[
        ("sk-", 20, token_char),
        ("ghp_", 20, token_char),
        ("gho_", 20, token_char),
        ("ghu_", 20, token_char),
        ("ghs_", 20, token_char),
        ("ghr_", 20, token_char),
        ("github_pat_", 20, token_char),
        ("glpat-", 20, token_char),
        ("xoxb-", 10, token_char),
        ("xoxa-", 10, token_char),
        ("xoxp-", 10, token_char),
        ("xoxr-", 10, token_char),
        ("xoxs-", 10, token_char),
        ("AIza", 35, token_char),
    ];
    const WORDS: &[&str] = &["api_key", "apikey", "api-key", "secret", "token", "password", "passwd", "client_secret", "access_key"];
    for (n, line) in text.lines().enumerate() {
        let found = || -> Option<String> {
            if line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----") {
                return Some("-----BEGIN PRIVATE KEY-----".into());
            }
            for (prefix, min, ok) in PREFIXES {
                let mut from = 0;
                while let Some(at) = line[from..].find(prefix) {
                    let at = from + at;
                    // Not the tail of a longer word ("task-…", "disk-…").
                    let before = line[..at].chars().next_back();
                    if !before.is_some_and(|c| c.is_ascii_alphanumeric()) && run_len(line, at + prefix.len(), *ok) >= *min {
                        return Some(line[at..].to_string());
                    }
                    from = at + prefix.len();
                }
            }
            // AWS access key ids: AKIA and 16 capitals or digits.
            if let Some(at) = line.find("AKIA") {
                if run_len(line, at + 4, |c| c.is_ascii_uppercase() || c.is_ascii_digit()) >= 16 {
                    return Some(line[at..].to_string());
                }
            }
            // `password = hunter2hunter2`, `"api_key": "…"`.
            let lower = line.to_ascii_lowercase();
            for word in WORDS {
                let mut from = 0;
                while let Some(at) = lower[from..].find(word) {
                    let end = from + at + word.len();
                    from = end;
                    let rest = &line[end..];
                    let rest = rest.trim_start_matches(['"', '\'']).trim_start();
                    let Some(rest) = rest.strip_prefix([':', '=']) else { continue };
                    let value = rest.trim_start().trim_start_matches(['"', '\'']);
                    let value: String = value.chars().take_while(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | ',' | ';')).collect();
                    // Placeholders are not keys: <your key>, ${TOKEN}, xxxx, ****.
                    let placeholder = value.starts_with(['<', '$', '{', '%']) || value.chars().all(|c| matches!(c, 'x' | 'X' | '*' | '.' | '-' | '_'));
                    if value.chars().count() >= 12 && !placeholder {
                        return Some(value);
                    }
                }
            }
            None
        };
        if let Some(hit) = found() {
            return Some(KeyLike { line: n + 1, sample: sample(&hit) });
        }
    }
    None
}

// ── The folder ────────────────────────────────────────────────────────────────

/// One team's knowledge base on disk.
pub struct Kb {
    dir: PathBuf,
}

impl Kb {
    pub fn of(team: &str) -> Self {
        Self::at(team_dir(team))
    }

    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// What the team has. Nothing on disk yet: an empty index with a leader's
    /// folder name of its own (written with the first document).
    pub fn load(&self) -> Index {
        let read = std::fs::read(self.dir.join(INDEX)).ok().and_then(|b| serde_json::from_slice::<Index>(&b).ok());
        let mut index = read.unwrap_or_default();
        if !is_leader_dir(&index.leader_dir) {
            index.leader_dir = format!("leader-{}", random_hex(16));
        }
        index.version = 1;
        index
    }

    /// Written beside and moved into place, so a crash never leaves half an index.
    pub fn save(&self, index: &Index) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("Could not make {}: {e}", self.dir.display()))?;
        let json = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
        let tmp = self.dir.join("index.json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("Could not save the knowledge base: {e}"))?;
        std::fs::rename(&tmp, self.dir.join(INDEX)).map_err(|e| format!("Could not save the knowledge base: {e}"))
    }

    /// The folder a document of this visibility lives in.
    pub fn folder(&self, index: &Index, visibility: Visibility) -> PathBuf {
        match visibility {
            Visibility::Shared => self.dir.join(SHARED),
            Visibility::Leader => self.dir.join(&index.leader_dir),
        }
    }

    pub fn shared_dir(&self) -> PathBuf {
        self.dir.join(SHARED)
    }

    pub fn path_of(&self, index: &Index, doc: &Doc) -> PathBuf {
        self.folder(index, doc.visibility).join(&doc.file)
    }

    /// What the Teamwork window lists. Removed documents past their time go.
    pub fn view(&self) -> KnowledgeView {
        self.prune_removed(now_ms());
        let index = self.load();
        let docs: Vec<DocView> = index.docs.iter().map(|d| self.doc_view(&index, d)).collect();
        let bytes = index.docs.iter().map(|d| d.bytes).sum();
        KnowledgeView { docs, bytes, limits: limits() }
    }

    pub fn doc_view(&self, index: &Index, d: &Doc) -> DocView {
        DocView {
            id: d.id.clone(),
            name: d.name.clone(),
            kind: d.kind,
            bytes: d.bytes,
            visibility: d.visibility,
            added_at: d.added_at,
            source: d.source.clone(),
            note: d.note.clone(),
            missing: !self.path_of(index, d).is_file(),
            source_exists: !d.source.is_empty() && Path::new(&d.source).is_file(),
            program: is_program(&d.name),
        }
    }

    /// Adds a document, for the leader only. `force`: the person has seen
    /// that it looks like it holds a key and wants it in anyway.
    pub fn add(&self, name: &str, bytes: Vec<u8>, source: &str, force: bool) -> Result<Added, String> {
        let name = clean_name(name);
        let size = bytes.len() as u64;
        if size > MAX_FILE {
            return Err(format!("{name} is larger than {} MB.", MAX_FILE / 1024 / 1024));
        }
        let mut index = self.load();
        if index.docs.len() >= MAX_DOCS {
            return Err(format!("A team keeps at most {MAX_DOCS} documents. Remove one first."));
        }
        let (kind, bytes) = classify(bytes);
        let hash = hash_of(&bytes);
        if let Some(same) = index.docs.iter().find(|d| d.hash == hash && d.bytes == bytes.len() as u64) {
            return Err(format!("{name} is already in the knowledge base, as {}.", same.name));
        }
        let total: u64 = index.docs.iter().map(|d| d.bytes).sum();
        if total + bytes.len() as u64 > MAX_TOTAL {
            return Err(format!("The knowledge base would be larger than {} MB (it holds {} MB).", MAX_TOTAL / 1024 / 1024, total / 1024 / 1024));
        }
        if kind == DocKind::Text && !force {
            let text = String::from_utf8_lossy(&bytes);
            if let Some(hit) = find_key_like(&text) {
                return Ok(Added { doc: None, key_like: Some(hit) });
            }
        }
        let id = loop {
            let id = format!("k{}", random_hex(4));
            if !index.docs.iter().any(|d| d.id == id) {
                break id;
            }
        };
        let doc = Doc {
            id: id.clone(),
            name: name.clone(),
            file: format!("{id}-{name}"),
            kind,
            bytes: bytes.len() as u64,
            visibility: Visibility::Leader,
            added_at: now_ms(),
            source: source.to_string(),
            hash,
            note: String::new(),
        };
        let folder = self.folder(&index, doc.visibility);
        std::fs::create_dir_all(&folder).map_err(|e| format!("Could not make the knowledge folder: {e}"))?;
        std::fs::create_dir_all(self.shared_dir()).map_err(|e| format!("Could not make the knowledge folder: {e}"))?;
        std::fs::write(folder.join(&doc.file), &bytes).map_err(|e| format!("Could not save {name}: {e}"))?;
        index.docs.push(doc.clone());
        self.save(&index)?;
        Ok(Added { doc: Some(self.doc_view(&index, &doc)), key_like: None })
    }

    /// Who may read it, and the person's line about it.
    pub fn update(&self, id: &str, visibility: Option<Visibility>, note: Option<&str>) -> Result<(Doc, Option<Visibility>), String> {
        let mut index = self.load();
        let at = index.docs.iter().position(|d| d.id == id).ok_or("There is no such document.")?;
        let mut was = None;
        if let Some(v) = visibility {
            let doc = index.docs[at].clone();
            if doc.visibility != v {
                let from = self.path_of(&index, &doc);
                let to_dir = self.folder(&index, v);
                std::fs::create_dir_all(&to_dir).map_err(|e| e.to_string())?;
                std::fs::rename(&from, to_dir.join(&doc.file)).map_err(|e| format!("Could not move {}: {e}", doc.name))?;
                was = Some(doc.visibility);
                index.docs[at].visibility = v;
            }
        }
        if let Some(note) = note {
            index.docs[at].note = note.trim().chars().take(500).collect();
        }
        self.save(&index)?;
        Ok((index.docs[at].clone(), was))
    }

    /// The original copied in again, over the old copy: same id, visibility and note.
    pub fn reimport(&self, id: &str, force: bool) -> Result<Added, String> {
        let mut index = self.load();
        let at = index.docs.iter().position(|d| d.id == id).ok_or("There is no such document.")?;
        let doc = index.docs[at].clone();
        let source = Path::new(&doc.source);
        if doc.source.is_empty() || !source.is_file() {
            return Err(format!("The original is no longer at {}.", doc.source));
        }
        let (_, bytes) = read_source(source)?;
        let (kind, bytes) = classify(bytes);
        let total: u64 = index.docs.iter().filter(|d| d.id != id).map(|d| d.bytes).sum();
        if total + bytes.len() as u64 > MAX_TOTAL {
            return Err(format!("The knowledge base would be larger than {} MB.", MAX_TOTAL / 1024 / 1024));
        }
        if kind == DocKind::Text && !force {
            if let Some(hit) = find_key_like(&String::from_utf8_lossy(&bytes)) {
                return Ok(Added { doc: None, key_like: Some(hit) });
            }
        }
        std::fs::write(self.path_of(&index, &doc), &bytes).map_err(|e| format!("Could not save {}: {e}", doc.name))?;
        index.docs[at].kind = kind;
        index.docs[at].bytes = bytes.len() as u64;
        index.docs[at].hash = hash_of(&bytes);
        self.save(&index)?;
        Ok(Added { doc: Some(self.doc_view(&index, &index.docs[at])), key_like: None })
    }

    /// Takes a document out. Its file is kept in `.removed` for a while.
    pub fn remove(&self, id: &str) -> Result<Doc, String> {
        let mut index = self.load();
        let at = index.docs.iter().position(|d| d.id == id).ok_or("There is no such document.")?;
        let doc = index.docs.remove(at);
        let from = self.path_of(&index, &doc);
        if from.is_file() {
            let bin = self.dir.join(REMOVED);
            std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
            std::fs::rename(&from, bin.join(format!("{}-{}", now_ms(), doc.file))).map_err(|e| format!("Could not remove {}: {e}", doc.name))?;
        }
        self.save(&index)?;
        Ok(doc)
    }

    /// Deletes what was removed more than 30 days before `now`.
    pub fn prune_removed(&self, now: u64) {
        let Ok(entries) = std::fs::read_dir(self.dir.join(REMOVED)) else { return };
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(ms) = name.split('-').next().and_then(|m| m.parse::<u64>().ok()) else { continue };
            if now.saturating_sub(ms) > KEEP_REMOVED_MS {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// A document by id or by name (as members and the secretary give it).
    pub fn find<'a>(index: &'a Index, given: &str) -> Option<&'a Doc> {
        let given = given.trim();
        index
            .docs
            .iter()
            .find(|d| d.id.eq_ignore_ascii_case(given))
            .or_else(|| index.docs.iter().find(|d| d.name.eq_ignore_ascii_case(given)))
            .or_else(|| index.docs.iter().find(|d| stem(&d.name).eq_ignore_ascii_case(given)))
    }

    /// The same documents in another team's folder (a copied team), with a
    /// leader's folder name of its own.
    pub fn copy_to(&self, other: &Kb) -> Result<usize, String> {
        let index = self.load();
        if index.docs.is_empty() {
            return Ok(0);
        }
        let mut theirs = other.load();
        let mut copied = 0;
        for doc in &index.docs {
            let from = self.path_of(&index, doc);
            if !from.is_file() || theirs.docs.iter().any(|d| d.hash == doc.hash && d.bytes == doc.bytes) {
                continue;
            }
            let mut doc = doc.clone();
            while theirs.docs.iter().any(|d| d.id == doc.id) {
                doc.id = format!("k{}", random_hex(4));
                doc.file = format!("{}-{}", doc.id, doc.name);
            }
            let to = other.folder(&theirs, doc.visibility);
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(other.shared_dir()).map_err(|e| e.to_string())?;
            std::fs::copy(&from, to.join(&doc.file)).map_err(|e| format!("Could not copy {}: {e}", doc.name))?;
            theirs.docs.push(doc);
            copied += 1;
        }
        other.save(&theirs)?;
        Ok(copied)
    }
}

fn is_leader_dir(name: &str) -> bool {
    name.strip_prefix("leader-").is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A file name without its extension.
pub fn stem(name: &str) -> &str {
    match name.rfind('.') {
        Some(at) if at > 0 => &name[..at],
        _ => name,
    }
}

/// A file the person picked or dropped: its name and bytes, refused before
/// reading when it is too large.
pub fn read_source(path: &Path) -> Result<(String, Vec<u8>), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if meta.len() > MAX_FILE {
        return Err(format!("{name} is larger than {} MB.", MAX_FILE / 1024 / 1024));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read {name}: {e}"))?;
    Ok((name, bytes))
}

/// The documents a member may read: all of them for the leader, the shared
/// ones for everyone else. Every way a document reaches a member goes
/// through here.
pub fn visible_to(index: &Index, is_leader: bool) -> Vec<&Doc> {
    index.docs.iter().filter(|d| is_leader || d.visibility == Visibility::Shared).collect()
}

/// Where the team's documents are and which part every member may read:
/// (the whole folder, its shared part). For the permission gate.
pub fn private_paths(team: &str) -> (PathBuf, PathBuf) {
    let kb = Kb::of(team);
    (kb.dir.clone(), kb.shared_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kb(name: &str) -> (Kb, PathBuf) {
        let base = std::env::temp_dir().join(format!("coucou-kb-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        (Kb::at(base.join("team")), base)
    }

    fn added(kb: &Kb, name: &str, bytes: &[u8]) -> DocView {
        kb.add(name, bytes.to_vec(), &format!("D:\\Docs\\{name}"), false).unwrap().doc.unwrap()
    }

    #[test]
    fn a_document_is_copied_in_for_the_leader_and_moves_when_shared() {
        let (kb, base) = kb("add");
        let doc = added(&kb, "品牌指南.md", "# 品牌\n藍色為主".as_bytes());
        assert_eq!(doc.kind, DocKind::Text);
        assert_eq!(doc.visibility, Visibility::Leader);
        let index = kb.load();
        assert!(index.leader_dir.starts_with("leader-") && index.leader_dir.len() == 23);
        let file = kb.dir().join(&index.leader_dir).join(format!("{}-品牌指南.md", doc.id));
        assert!(file.is_file());

        let (_, was) = kb.update(&doc.id, Some(Visibility::Shared), Some("  全隊都要看  ")).unwrap();
        assert_eq!(was, Some(Visibility::Leader));
        assert!(!file.exists());
        assert!(kb.shared_dir().join(format!("{}-品牌指南.md", doc.id)).is_file());
        let again = kb.load();
        assert_eq!(again.docs[0].note, "全隊都要看");
        // The same leader folder every time it is read.
        assert_eq!(again.leader_dir, index.leader_dir);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_same_document_twice_or_too_much_is_refused() {
        let (kb, base) = kb("refuse");
        added(&kb, "a.md", b"hello");
        assert!(kb.add("b.md", b"hello".to_vec(), "", false).unwrap_err().contains("already in the knowledge base, as a.md"));
        assert!(kb.add("big.bin", vec![1u8; (MAX_FILE + 1) as usize], "", false).unwrap_err().contains("larger than 20 MB"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn any_kind_of_file_goes_in_and_is_sorted_by_what_it_holds() {
        let png = b"\x89PNG\r\n\x1a\n rest".to_vec();
        assert_eq!(classify(png.clone()).0, DocKind::Image);
        assert_eq!(classify(b"\xFF\xD8\xFF\xE0jpeg".to_vec()).0, DocKind::Image);
        assert_eq!(classify(b"RIFF\0\0\0\0WEBPVP8 ".to_vec()).0, DocKind::Image);
        // The name does not count: a picture called .txt is a picture.
        assert_eq!(classify(b"{\"a\": 1}".to_vec()).0, DocKind::Text);
        let (kind, bytes) = classify(b"\xEF\xBB\xBFhi".to_vec());
        assert_eq!((kind, bytes.as_slice()), (DocKind::Text, &b"hi"[..]));
        let utf16 = [0xFF, 0xFE, b'h', 0, b'i', 0].to_vec();
        assert_eq!(classify(utf16), (DocKind::Text, b"hi".to_vec()));
        // Big5 is not UTF-8; NUL is not text; a pdf is a file.
        assert_eq!(classify(vec![0xA4, 0xA4, 0xA4, 0xE5]).0, DocKind::File);
        assert_eq!(classify(b"a\0b".to_vec()).0, DocKind::File);
        assert_eq!(classify(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec()).0, DocKind::File);
        // Too large to hand over as what it is: a file.
        let mut big = b"\x89PNG\r\n\x1a\n".to_vec();
        big.resize((MAX_IMAGE + 1) as usize, 0);
        assert_eq!(classify(big).0, DocKind::File);
        assert_eq!(classify(vec![b'a'; (MAX_TEXT + 1) as usize]).0, DocKind::File);

        let (kb, base) = kb("kinds");
        let pdf = added(&kb, "規格書.pdf", b"%PDF-1.7 \xE2\xE3");
        assert_eq!(pdf.kind, DocKind::File);
        let bat = added(&kb, "setup.bat", b"@echo off");
        assert!(bat.program && !pdf.program);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn text_that_looks_like_it_holds_a_key_waits_for_the_person() {
        for text in [
            "OPENAI=sk-proj-abcdefghijklmnopqrstuvwx",
            "token: ghp_abcdefghijklmnopqrstuvwxyz0123",
            "aws AKIAABCDEFGHIJKLMNOP",
            "maps AIzaSyA1234567890abcdefghijklmnopqrstuv",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "\"api_key\": \"q8wE3rT5yU7iO9pA\"",
            "password = hunter2hunter2",
            "slack xoxb-1234567890-abc",
        ] {
            assert!(find_key_like(&format!("# notes\n{text}\n")).is_some_and(|k| k.line == 2), "missed: {text}");
        }
        for text in [
            "Ask for the task-abcdefghijklmnopqrstuvwxyz list",
            "password: <your password here>",
            "api_key = ${OPENAI_API_KEY}",
            "token: xxxxxxxxxxxxxxxx",
            "max_tokens: 4096",
            "The secret is to keep it simple.",
            "Set a strong password for the admin.",
        ] {
            assert!(find_key_like(text).is_none(), "false alarm: {text}");
        }
        let hit = find_key_like("a\nb\nkey sk-ant-api03-abcdefghijklmnopqrstu").unwrap();
        assert_eq!((hit.line, hit.sample.as_str()), (3, "sk-an…"));

        let (kb, base) = kb("key");
        let held = kb.add("env.md", b"OPENAI=sk-proj-abcdefghijklmnopqrstuvwx".to_vec(), "", false).unwrap();
        assert!(held.doc.is_none() && held.key_like.is_some());
        assert!(kb.load().docs.is_empty());
        let forced = kb.add("env.md", b"OPENAI=sk-proj-abcdefghijklmnopqrstuvwx".to_vec(), "", true).unwrap();
        assert!(forced.doc.is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_removed_document_is_kept_a_while_then_goes() {
        let (kb, base) = kb("remove");
        let doc = added(&kb, "a.md", b"one");
        kb.remove(&doc.id).unwrap();
        assert!(kb.load().docs.is_empty());
        let bin = kb.dir().join(REMOVED);
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 1);
        kb.prune_removed(now_ms() + KEEP_REMOVED_MS / 2);
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 1);
        kb.prune_removed(now_ms() + KEEP_REMOVED_MS + 60_000);
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_document_is_imported_again_from_its_original() {
        let (kb, base) = kb("reimport");
        std::fs::create_dir_all(&base).unwrap();
        let original = base.join("spec.md");
        std::fs::write(&original, b"v1").unwrap();
        let doc = kb.add("spec.md", b"v1".to_vec(), &original.to_string_lossy(), false).unwrap().doc.unwrap();
        assert!(doc.source_exists);
        kb.update(&doc.id, Some(Visibility::Shared), Some("規格")).unwrap();
        std::fs::write(&original, b"version 2").unwrap();
        let again = kb.reimport(&doc.id, false).unwrap().doc.unwrap();
        assert_eq!((again.bytes, again.visibility, again.note.as_str()), (9, Visibility::Shared, "規格"));
        std::fs::remove_file(&original).unwrap();
        assert!(kb.reimport(&doc.id, false).unwrap_err().contains("no longer at"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_leader_reads_everything_and_the_others_only_what_is_shared() {
        let (kb, base) = kb("visible");
        let a = added(&kb, "a.md", b"a");
        let b = added(&kb, "b.md", b"b");
        kb.update(&b.id, Some(Visibility::Shared), None).unwrap();
        let index = kb.load();
        assert_eq!(visible_to(&index, true).len(), 2);
        let theirs: Vec<&str> = visible_to(&index, false).iter().map(|d| d.id.as_str()).collect();
        assert_eq!(theirs, vec![b.id.as_str()]);
        assert!(Kb::find(&index, &a.id).is_some() && Kb::find(&index, "A.MD").is_some() && Kb::find(&index, "a").is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_index_that_cannot_be_read_well_errs_on_the_leader_s_side() {
        let json = r#"{"version":1,"leaderDir":"leader-0123456789abcdef","docs":[
            {"id":"k1","name":"a.md","file":"k1-a.md","kind":"text","bytes":1,"addedAt":1},
            {"id":"k2","name":"b.md","file":"k2-b.md","kind":"text","bytes":1,"addedAt":1,"visibility":"everyone"}]}"#;
        let index: Index = serde_json::from_str(json).unwrap();
        assert!(index.docs.iter().all(|d| d.visibility == Visibility::Leader));
    }

    #[test]
    fn a_copied_team_gets_the_documents_and_a_leader_folder_of_its_own() {
        let (kb, base) = kb("copy");
        let a = added(&kb, "a.md", b"a");
        added(&kb, "b.png", b"\x89PNG\r\n\x1a\nxx");
        kb.update(&a.id, Some(Visibility::Shared), None).unwrap();
        let other = Kb::at(base.join("other"));
        assert_eq!(kb.copy_to(&other).unwrap(), 2);
        let (mine, theirs) = (kb.load(), other.load());
        assert_ne!(mine.leader_dir, theirs.leader_dir);
        assert_eq!(theirs.docs.len(), 2);
        assert_eq!(theirs.docs[0].visibility, Visibility::Shared);
        for d in &theirs.docs {
            assert!(other.path_of(&theirs, d).is_file());
        }
        // Copying again adds nothing twice.
        assert_eq!(kb.copy_to(&other).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn names_stay_names() {
        assert_eq!(clean_name(r"C:\x\..\spec?.md"), "spec_.md");
        assert_eq!(clean_name("   "), "document");
        assert_eq!(stem("首頁草圖.png"), "首頁草圖");
        assert_eq!(stem(".env"), ".env");
    }
}
