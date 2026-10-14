// The language the app speaks to the person: Traditional Chinese or English.
//
// `settings.language` is "system" (follow the Windows display language),
// "zh-TW" or "en". Text is written as a pair at the place it is used —
// `tr!("資料夾不存在", "The folder doesn't exist")` — and picked when it is
// made: a message already sent, or stored in a log, stays as it was.
//
// Text meant for a model (the secretary's system prompt, a member's brief,
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
}
