// API keys live in the Windows Credential Manager, never on disk and never in
// the front end — the island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = "fr.louisraille.coucou";

/// Every fixed key Coucou may store. Besides these, `provider:<id>` holds an
/// LLM provider's key. Anything else is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

const PROVIDER_PREFIX: &str = "provider:";

fn allowed(key: &str) -> bool {
    if KNOWN_KEYS.contains(&key) {
        return true;
    }
    // A provider id is what the user typed in settings; keep it to characters
    // that cannot turn into something else in a credential name.
    key.strip_prefix(PROVIDER_PREFIX)
        .map(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .unwrap_or(false)
}

fn entry(key: &str) -> Option<Entry> {
    if !allowed(key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn provider_keys_are_allowed_only_with_a_tame_id() {
        assert!(allowed("anthropic-api-key"));
        assert!(allowed("provider:anthropic"));
        assert!(allowed("provider:local_ollama-2"));
        assert!(!allowed("provider:"));
        assert!(!allowed("provider:a b"));
        assert!(!allowed("provider:../x"));
        assert!(!allowed("something-else"));
    }
}
