//! Server-side message localization for error responses.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Locale {
    En,
    Zh,
}

impl Locale {
    pub const DEFAULT: Locale = Locale::En;

    pub fn as_str(self) -> &'static str {
        match self {
            Locale::En => "en-US",
            Locale::Zh => "zh-CN",
        }
    }

    fn exact(value: &str) -> Option<Self> {
        match value {
            "en-US" => Some(Locale::En),
            "zh-CN" => Some(Locale::Zh),
            _ => None,
        }
    }

    /// Maps any language tag to a supported locale, defaulting to English.
    pub fn normalize(value: &str) -> Self {
        let value = value.trim();
        if value.is_empty() {
            return Self::DEFAULT;
        }
        if let Some(locale) = Self::exact(value) {
            return locale;
        }
        let primary = value
            .split('-')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        match primary.as_str() {
            "zh" => Locale::Zh,
            "en" => Locale::En,
            _ => Self::DEFAULT,
        }
    }

    /// Picks the highest-weighted supported locale from an `Accept-Language`
    /// header; ties go to the earliest entry.
    pub fn from_accept_language(header: &str) -> Self {
        let mut best: Option<(Locale, f64)> = None;
        for token in header
            .split(',')
            .map(str::trim)
            .filter(|token| !token.is_empty())
        {
            let (tag, params) = match token.split_once(';') {
                Some((tag, params)) => (tag.trim(), Some(params)),
                None => (token, None),
            };
            let mut q = 1.0;
            for param in params.into_iter().flat_map(|params| params.split(';')) {
                if let Some(value) = param.trim().strip_prefix("q=")
                    && let Ok(parsed) = value.parse::<f64>()
                {
                    q = parsed;
                }
            }
            if tag.is_empty() || q <= 0.0 {
                continue;
            }
            let locale = Self::normalize(tag);
            if best.is_none_or(|(_, best_q)| q > best_q) {
                best = Some((locale, q));
            }
        }
        best.map_or(Self::DEFAULT, |(locale, _)| locale)
    }
}

fn tables() -> &'static HashMap<Locale, HashMap<String, String>> {
    static TABLES: OnceLock<HashMap<Locale, HashMap<String, String>>> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut tables = HashMap::new();
        for (locale, raw) in [
            (Locale::En, include_str!("../locales/en-US.json")),
            (Locale::Zh, include_str!("../locales/zh-CN.json")),
        ] {
            let mut flat = HashMap::new();
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) {
                flatten("", &map, &mut flat);
            }
            tables.insert(locale, flat);
        }
        tables
    })
}

fn flatten(prefix: &str, map: &serde_json::Map<String, Value>, out: &mut HashMap<String, String>) {
    for (key, value) in map {
        let full = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        match value {
            Value::String(text) => {
                out.insert(full, text.clone());
            }
            Value::Object(inner) => flatten(&full, inner, out),
            _ => {}
        }
    }
}

/// Translates `key`, falling back to English and then to the key itself.
/// `${name}` placeholders are replaced from `args`.
pub fn t(locale: Locale, key: &str, args: &[(String, String)]) -> String {
    let tables = tables();
    let template = tables
        .get(&locale)
        .and_then(|table| table.get(key))
        .or_else(|| {
            tables
                .get(&Locale::DEFAULT)
                .and_then(|table| table.get(key))
        })
        .cloned()
        .unwrap_or_else(|| key.to_owned());
    if args.is_empty() || !template.contains("${") {
        return template;
    }
    args.iter().fold(template, |text, (name, value)| {
        text.replace(&format!("${{{name}}}"), value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_language_tags() {
        for (input, want) in [
            ("en-US", Locale::En),
            ("zh-CN", Locale::Zh),
            ("zh", Locale::Zh),
            ("zh-Hans-CN", Locale::Zh),
            ("en", Locale::En),
            ("en-GB", Locale::En),
            ("fr-FR", Locale::En),
            ("", Locale::En),
            ("  zh-CN  ", Locale::Zh),
        ] {
            assert_eq!(Locale::normalize(input), want, "{input}");
        }
    }

    #[test]
    fn parses_accept_language() {
        for (input, want) in [
            ("", Locale::En),
            ("zh-CN", Locale::Zh),
            ("en-US,en;q=0.9", Locale::En),
            ("zh-CN,zh;q=0.9,en;q=0.8", Locale::Zh),
            ("fr-FR,en;q=0.5", Locale::En),
            ("fr-FR", Locale::En),
            ("en;q=0.5,zh-CN;q=0.9", Locale::Zh),
            ("*", Locale::En),
            ("fr-FR,zh;q=0.5", Locale::En),
        ] {
            assert_eq!(Locale::from_accept_language(input), want, "{input}");
        }
    }

    #[test]
    fn translates_with_fallbacks() {
        assert_eq!(
            t(Locale::En, "common.internal_error", &[]),
            "Internal server error"
        );
        assert_ne!(
            t(Locale::Zh, "common.internal_error", &[]),
            "Internal server error"
        );
        assert_eq!(t(Locale::En, "missing.key", &[]), "missing.key");
    }
}
