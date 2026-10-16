// The language the app speaks to the person: Traditional Chinese or English.
//
// `settings.language` is "system" (follow the Windows display language),
// "zh-TW" or "en". Text is written as a pair at the place it is used —
// `tr!("資料夾不存在", "The folder doesn't exist")` — and picked when it is
// made: a message already sent, or stored in a log, stays as it was.
//
// Text meant for a model (Agent Center's system prompt, a member's brief,
// tool descriptions) is not translated; `reply_language` adds the one line
// that says which language to answer the person in.

use std::sync::atomic::{AtomicU8, Ordering};

const EN: u8 = 0;
const ZH: u8 = 1;

static LANG: AtomicU8 = AtomicU8::new(EN);

/// "zh-TW" or "en" for a `settings.language` value.
pub fn effective(language: &str) -> &'static str {
    match language {
        "zh-TW" => "zh-TW",
        "en" => "en",
        _ => system(),
    }
}

/// The Windows display language, as one of the two the app speaks.
pub fn system() -> &'static str {
    if system_is_chinese() {
        "zh-TW"
    } else {
        "en"
    }
}

#[cfg(windows)]
fn system_is_chinese() -> bool {
    // LANGID: the low 10 bits are the primary language; LANG_CHINESE = 0x04.
    let id = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    primary_is_chinese(id)
}

#[cfg(not(windows))]
fn system_is_chinese() -> bool {
    std::env::var("LANG").map(|l| l.starts_with("zh")).unwrap_or(false)
}

fn primary_is_chinese(langid: u16) -> bool {
    langid & 0x3ff == 0x04
}

/// Sets the language from `settings.language`. True when it changed.
pub fn set(language: &str) -> bool {
    let next = if effective(language) == "zh-TW" { ZH } else { EN };
    LANG.swap(next, Ordering::Relaxed) != next
}

pub fn is_zh() -> bool {
    LANG.load(Ordering::Relaxed) == ZH
}

/// "zh-TW" or "en": what the windows are told at boot and on a change.
pub fn current() -> &'static str {
    if is_zh() {
        "zh-TW"
    } else {
        "en"
    }
}

/// The line appended to text meant for a model, so it answers the person in
/// the language the app is set to.
pub fn reply_language() -> &'static str {
    if is_zh() {
        "Reply to the user in Traditional Chinese (繁體中文, Taiwan usage)."
    } else {
        "Reply to the user in English."
    }
}

/// `tr!(zh, en)` — the Chinese text first, then the English. Both arguments
/// are evaluated only for the language in use.
#[macro_export]
macro_rules! tr {
    ($zh:expr, $en:expr $(,)?) => {
        if $crate::i18n::is_zh() {
            ($zh).into()
        } else {
            ($en).into()
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn langids_map_to_the_two_languages() {
        assert!(primary_is_chinese(0x0404)); // zh-TW
        assert!(primary_is_chinese(0x0804)); // zh-CN
        assert!(primary_is_chinese(0x0c04)); // zh-HK
        assert!(!primary_is_chinese(0x0409)); // en-US
        assert!(!primary_is_chinese(0x0411)); // ja-JP
    }

    #[test]
    fn explicit_choices_win_over_the_system() {
        assert_eq!(effective("zh-TW"), "zh-TW");
        assert_eq!(effective("en"), "en");
        assert!(matches!(effective("system"), "zh-TW" | "en"));
        assert!(matches!(effective("anything else"), "zh-TW" | "en"));
    }

    // ── Leak scan ──────────────────────────────────────────────────────────
    //
    // Every Chinese string in the sources must be one half of a tr!() pair,
    // unless it is in a log line, in a test, or in code marked
    // `// i18n: model-facing` (text for a model, which is not translated).

    fn is_cjk(c: char) -> bool {
        matches!(c as u32, 0x3400..=0x9fff | 0xf900..=0xfaff | 0x3000..=0x303f | 0xff00..=0xffef)
    }

    /// Byte ranges of the source that are exempt, and the string literals found.
    struct Scan {
        strings: Vec<(usize, String)>,
        exempt: Vec<(usize, usize)>,
    }

    /// Where the item starting at `from` ends: the brace that closes its first
    /// `{`, or the `;` that comes before any `{`.
    fn item_end(src: &[char], from: usize) -> usize {
        let mut i = from;
        let mut depth = 0usize;
        while i < src.len() {
            match src[i] {
                '"' => i = skip_string(src, i),
                'r' if src.get(i + 1) == Some(&'#') || (src.get(i + 1) == Some(&'"') && !ident(src, i)) => i = skip_raw(src, i),
                '/' if src.get(i + 1) == Some(&'/') => {
                    while i < src.len() && src[i] != '\n' {
                        i += 1;
                    }
                }
                '\'' => i = skip_char(src, i),
                '{' => {
                    depth += 1;
                    i += 1;
                }
                '}' => {
                    depth = depth.saturating_sub(1);
                    i += 1;
                    if depth == 0 {
                        return i;
                    }
                }
                ';' if depth == 0 => return i + 1,
                _ => i += 1,
            }
        }
        src.len()
    }

    /// The parenthesis that closes the one at `open`.
    fn paren_end(src: &[char], open: usize) -> usize {
        let mut i = open;
        let mut depth = 0usize;
        while i < src.len() {
            match src[i] {
                '"' => {
                    i = skip_string(src, i);
                    continue;
                }
                'r' if src.get(i + 1) == Some(&'#') || (src.get(i + 1) == Some(&'"') && !ident(src, i)) => {
                    i = skip_raw(src, i);
                    continue;
                }
                '\'' => {
                    i = skip_char(src, i);
                    continue;
                }
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return i + 1;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        src.len()
    }

    fn ident(src: &[char], i: usize) -> bool {
        i > 0 && (src[i - 1].is_alphanumeric() || src[i - 1] == '_')
    }

    fn skip_string(src: &[char], at: usize) -> usize {
        let mut i = at + 1;
        while i < src.len() && src[i] != '"' {
            i += if src[i] == '\\' { 2 } else { 1 };
        }
        i + 1
    }

    fn skip_raw(src: &[char], at: usize) -> usize {
        let mut i = at + 1;
        let mut hashes = 0;
        while src.get(i) == Some(&'#') {
            hashes += 1;
            i += 1;
        }
        if src.get(i) != Some(&'"') {
            return at + 1; // an identifier starting with r, not a raw string
        }
        i += 1;
        while i < src.len() {
            if src[i] == '"' && (0..hashes).all(|k| src.get(i + 1 + k) == Some(&'#')) {
                return i + 1 + hashes;
            }
            i += 1;
        }
        src.len()
    }

    /// A char literal, or a lifetime ('a): skipped either way.
    fn skip_char(src: &[char], at: usize) -> usize {
        if src.get(at + 1) == Some(&'\\') {
            let mut i = at + 2;
            while i < src.len() && src[i] != '\'' {
                i += 1;
            }
            return i + 1;
        }
        if src.get(at + 2) == Some(&'\'') {
            return at + 3;
        }
        at + 1
    }

    fn starts(src: &[char], i: usize, word: &str) -> bool {
        word.chars().enumerate().all(|(k, c)| src.get(i + k) == Some(&c))
    }

    fn scan(text: &str) -> Scan {
        let src: Vec<char> = text.chars().collect();
        let mut out = Scan { strings: vec![], exempt: vec![] };
        let mut i = 0;
        while i < src.len() {
            let c = src[i];
            if c == '/' && src.get(i + 1) == Some(&'/') {
                let start = i;
                while i < src.len() && src[i] != '\n' {
                    i += 1;
                }
                let line: String = src[start..i].iter().collect();
                if line.contains("i18n: model-facing") {
                    let end = item_end(&src, i);
                    out.exempt.push((i, end));
                }
                continue;
            }
            if c == '/' && src.get(i + 1) == Some(&'*') {
                while i + 1 < src.len() && !(src[i] == '*' && src[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
                continue;
            }
            if starts(&src, i, "#[cfg(test)]") {
                let end = item_end(&src, i + 12);
                out.exempt.push((i, end));
                i = end;
                continue;
            }
            // tr!(…), log lines and printing are exempt as a whole.
            for word in ["tr!(", "log::line(", "eprintln!(", "println!(", "panic!(", "unreachable!("] {
                if starts(&src, i, word) && !ident(&src, i) {
                    let open = i + word.len() - 1;
                    out.exempt.push((i, paren_end(&src, open)));
                }
            }
            if c == '"' {
                let end = skip_string(&src, i);
                out.strings.push((i, src[i + 1..end.saturating_sub(1).max(i + 1)].iter().collect()));
                i = end;
                continue;
            }
            if c == 'r' && !ident(&src, i) && (src.get(i + 1) == Some(&'#') || src.get(i + 1) == Some(&'"')) {
                let end = skip_raw(&src, i);
                if end > i + 1 {
                    out.strings.push((i, src[i..end].iter().collect()));
                    i = end;
                    continue;
                }
            }
            if c == '\'' {
                i = skip_char(&src, i);
                continue;
            }
            i += 1;
        }
        out
    }

    fn rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let p = entry.path();
            if p.is_dir() {
                rust_files(&p, out);
            } else if p.extension().is_some_and(|e| e == "rs") {
                out.push(p);
            }
        }
    }

    #[test]
    fn no_chinese_outside_tr() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = vec![];
        rust_files(&root, &mut files);
        let mut found = vec![];
        for path in files {
            // This file holds the reply-language line, which is for a model.
            if path.ends_with("i18n.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            let s = scan(&text);
            let chars: Vec<char> = text.chars().collect();
            for (at, value) in &s.strings {
                if !value.chars().any(is_cjk) || s.exempt.iter().any(|(a, b)| at >= a && at < b) {
                    continue;
                }
                let line = chars[..*at].iter().filter(|&&c| c == '\n').count() + 1;
                let rel = path.strip_prefix(&root).unwrap().display().to_string().replace('\\', "/");
                found.push(format!("{rel}:{line} {}", value.chars().take(40).collect::<String>()));
            }
        }
        assert!(found.is_empty(), "{} Chinese string(s) outside tr!():\n{}", found.len(), found.join("\n"));
    }

    #[test]
    fn the_scan_sees_what_it_should() {
        let src = r##"
fn shown() -> String { "看得到".into() }
fn paired() -> String { tr!("中文", "English") }
fn logged() { log::line(format!("記錄 {}", 1)); }
// i18n: model-facing
fn prompt() -> &'static str { "給模型看的" }
const BRIEF: &str = "也是給模型"; // not marked: counted
#[cfg(test)]
mod tests { fn t() { assert_eq!("測試", "測試"); } }
fn raw() -> &'static str { r#"原始"# }
"##;
        let s = scan(src);
        let leaks: Vec<&str> = s
            .strings
            .iter()
            .filter(|(at, v)| v.chars().any(is_cjk) && !s.exempt.iter().any(|(a, b)| at >= a && at < b))
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(leaks, vec!["看得到", "也是給模型", "r#\"原始\"#"]);
    }
}
