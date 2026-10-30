//! Runtime configuration.
//!
//! Mirrors the legacy loader exactly: a TOML file whose keys are matched
//! case-insensitively, with a fixed set of environment overrides. An empty
//! environment variable counts as unset. MySQL settings are intentionally not
//! supported; the desktop runtime stores data in SQLite only.

use std::path::{Path, PathBuf};

use toml::Value;

/// Environment variable that names the configuration file.
pub const CONFIG_ENV: &str = "KITION_API_CONFIG";

const DEFAULT_CONFIG_PATH: &str = "../config/local.toml";
const DEFAULT_API_PREFIX: &str = "/api/v1";
const DEFAULT_HTTP_PORT: i64 = 8001;
const DEFAULT_LOG_LEVEL: &str = "info";
const DEFAULT_PORTAL_BASE_URL: &str = "https://kition.ai";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AppConfig {
    pub name: String,
    pub version: String,
    pub api_prefix: String,
    pub jwt_secret: String,
    pub portal_base_url: String,
    pub disable_auth: bool,
    pub e2e_test_mode: bool,
    pub access_token_expire_minutes: i64,
    pub refresh_token_expire_days: i64,
    pub auto_migrate: bool,
    pub auto_seed: bool,
    pub http_port: i64,
    /// This launch's API token (`kition_http::gate`). Never read from a file or the environment:
    /// the process that embeds the runtime sets it, or the runtime makes one when it starts.
    pub api_token: String,
    /// Where the runtime writes the token for trusted local clients (`kition-acp`), readable by
    /// this account only: `KITION_API_TOKEN_FILE`, then `server.http.tokenFile`, else `api-token`
    /// beside the database. Never inside a folder the runtime serves.
    pub api_token_file: String,
    /// Origins allowed besides the desktop renderer, named exactly: the dev server the renderer
    /// is served from in development. Set by the embedding process only.
    pub allowed_origins: Vec<String>,
    pub log_level: String,
    pub upload_dir: String,
    pub workspace_dir: String,
    /// A folder with one folder per kit package holding its `kit.json` (Kition's `public/kits`):
    /// where the runtime finds the kits it knows (`KITION_KITS_DIR`, then `kits.dir`).
    pub kits_dir: String,
    /// Kit manifests (`kit.json` text) the embedding process hands over, as the desktop shell
    /// does with the kit packages it serves. Set by the embedding process only.
    pub kit_manifests: Vec<String>,
    pub sqlite_path: String,
    pub smtp_host: String,
    pub smtp_port: i64,
    pub smtp_username: String,
    pub smtp_password: String,
    pub smtp_from: String,
    pub smtp_from_name: String,
    pub smtp_tls_mode: String,
    pub smtp_proxy: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("read config {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("read config {path}: {source}")]
    Parse {
        path: PathBuf,
        source: Box<toml::de::Error>,
    },
}

/// Resolves the configuration path: an explicit path, then `KITION_API_CONFIG`,
/// then the development default.
pub fn resolve_config_path(
    explicit: Option<&str>,
    env: &dyn Fn(&str) -> Option<String>,
) -> PathBuf {
    if let Some(path) = explicit.filter(|value| !value.trim().is_empty()) {
        return PathBuf::from(path);
    }
    match env(CONFIG_ENV) {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => PathBuf::from(DEFAULT_CONFIG_PATH),
    }
}

/// Loads configuration from `path`, applying overrides read through `env`.
pub fn load(path: &Path, env: &dyn Fn(&str) -> Option<String>) -> Result<AppConfig, ConfigError> {
    let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    let root: Value = toml::from_str(&text).map_err(|source| ConfigError::Parse {
        path: path.to_path_buf(),
        source: Box::new(source),
    })?;
    Ok(from_value(&root, env))
}

fn from_value(root: &Value, env: &dyn Fn(&str) -> Option<String>) -> AppConfig {
    let file = Lookup(root);
    let env_str = |key: &str| env(key).unwrap_or_default();

    let mut cfg = AppConfig {
        name: file.string("app.name"),
        version: file.string("app.version"),
        api_prefix: file.string("app.apiPrefix"),
        jwt_secret: file.string("app.jwtSecret"),
        portal_base_url: first_non_empty(&[
            env_str("KITION_PORTAL_BASE_URL"),
            file.string("portal.baseURL"),
        ]),
        disable_auth: file.bool("app.disableAuth"),
        e2e_test_mode: file.bool("app.e2eTestMode"),
        access_token_expire_minutes: file.int("app.accessTokenExpireMinutes"),
        refresh_token_expire_days: file.int("app.refreshTokenExpireDays"),
        auto_migrate: file.bool("app.autoMigrate"),
        auto_seed: file.bool("app.autoSeed"),
        http_port: first_non_empty_int(
            &env_str("KITION_DESKTOP_API_PORT"),
            file.int("server.http.port"),
        ),
        api_token: String::new(),
        api_token_file: first_non_empty(&[
            env_str("KITION_API_TOKEN_FILE"),
            file.string("server.http.tokenFile"),
        ]),
        allowed_origins: Vec::new(),
        log_level: file.string("logger.default.level"),
        upload_dir: first_non_empty(&[
            env_str("KITION_DESKTOP_UPLOAD_DIR"),
            file.string("storage.uploadDir"),
        ]),
        workspace_dir: first_non_empty(&[
            env_str("KITION_DESKTOP_WORKSPACE_DIR"),
            file.string("storage.workspaceDir"),
        ]),
        kits_dir: first_non_empty(&[env_str("KITION_KITS_DIR"), file.string("kits.dir")]),
        kit_manifests: Vec::new(),
        sqlite_path: first_non_empty(&[
            env_str("KITION_DESKTOP_SQLITE_PATH"),
            file.string("sqlite.path"),
        ]),
        smtp_host: first_non_empty(&[env_str("KITION_SMTP_HOST"), file.string("smtp.host")]),
        smtp_port: first_non_empty_int(&env_str("KITION_SMTP_PORT"), file.int("smtp.port")),
        smtp_username: first_non_empty(&[
            env_str("KITION_SMTP_USERNAME"),
            file.string("smtp.username"),
        ]),
        smtp_password: first_non_empty(&[
            env_str("KITION_SMTP_PASSWORD"),
            file.string("smtp.password"),
        ]),
        smtp_from: first_non_empty(&[env_str("KITION_SMTP_FROM"), file.string("smtp.from")]),
        smtp_from_name: first_non_empty(&[
            env_str("KITION_SMTP_FROM_NAME"),
            file.string("smtp.fromName"),
        ]),
        smtp_tls_mode: first_non_empty(&[
            env_str("KITION_SMTP_TLS_MODE"),
            file.string("smtp.tlsMode"),
        ]),
        smtp_proxy: first_non_empty(&[
            env_str("KITION_SMTP_PROXY"),
            file.string("smtp.proxy"),
            env_str("HTTPS_PROXY"),
            env_str("https_proxy"),
        ]),
    };
    if cfg.api_prefix.is_empty() {
        cfg.api_prefix = DEFAULT_API_PREFIX.to_owned();
    }
    if cfg.http_port == 0 {
        cfg.http_port = DEFAULT_HTTP_PORT;
    }
    if cfg.log_level.is_empty() {
        cfg.log_level = DEFAULT_LOG_LEVEL.to_owned();
    }
    if cfg.portal_base_url.trim().is_empty() {
        cfg.portal_base_url = DEFAULT_PORTAL_BASE_URL.to_owned();
    }
    cfg
}

fn first_non_empty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn first_non_empty_int(env_value: &str, fallback: i64) -> i64 {
    let trimmed = env_value.trim();
    if trimmed.is_empty() {
        return fallback;
    }
    trimmed.parse().unwrap_or(fallback)
}

/// Dotted, case-insensitive key lookup with lenient scalar conversion.
struct Lookup<'a>(&'a Value);

impl Lookup<'_> {
    fn get(&self, dotted: &str) -> Option<&Value> {
        let mut current = self.0;
        for segment in dotted.split('.') {
            let table = current.as_table()?;
            current = table
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(segment))
                .map(|(_, value)| value)?;
        }
        Some(current)
    }

    fn string(&self, key: &str) -> String {
        match self.get(key) {
            Some(Value::String(value)) => value.clone(),
            Some(Value::Integer(value)) => value.to_string(),
            Some(Value::Float(value)) => value.to_string(),
            Some(Value::Boolean(value)) => value.to_string(),
            _ => String::new(),
        }
    }

    fn int(&self, key: &str) -> i64 {
        match self.get(key) {
            Some(Value::Integer(value)) => *value,
            Some(Value::Float(value)) => *value as i64,
            Some(Value::String(value)) => value.trim().parse().unwrap_or(0),
            Some(Value::Boolean(value)) => i64::from(*value),
            _ => 0,
        }
    }

    fn bool(&self, key: &str) -> bool {
        match self.get(key) {
            Some(Value::Boolean(value)) => *value,
            Some(Value::String(value)) => {
                matches!(value.trim(), "1" | "t" | "T" | "true" | "TRUE" | "True")
            }
            Some(Value::Integer(value)) => *value != 0,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const SAMPLE: &str = r#"
[app]
name = "Kition Desktop API"
version = "2.0.0"
apiPrefix = "/api/v1"
disableAuth = true
accessTokenExpireMinutes = 120

[portal]
baseURL = "https://devapi.kition.ai"

[server]
  [server.http]
    port = 18101

[sqlite]
path = "./data/test.db"

[storage]
uploadDir = "./uploads"
workspaceDir = "./workspace"

[logger.default]
level = "error"

[smtp]
proxy = "http://file-proxy"
"#;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |key| map.get(key).cloned()
    }

    fn parse(env: &dyn Fn(&str) -> Option<String>) -> AppConfig {
        let root: Value =
            toml::from_str(SAMPLE).unwrap_or_else(|err| panic!("sample config: {err}"));
        from_value(&root, env)
    }

    #[test]
    fn reads_file_values() {
        let cfg = parse(&env_from(&[]));
        assert_eq!(cfg.name, "Kition Desktop API");
        assert_eq!(cfg.api_prefix, "/api/v1");
        assert!(cfg.disable_auth);
        assert_eq!(cfg.access_token_expire_minutes, 120);
        assert_eq!(cfg.http_port, 18101);
        assert_eq!(cfg.sqlite_path, "./data/test.db");
        assert_eq!(cfg.log_level, "error");
        assert_eq!(cfg.portal_base_url, "https://devapi.kition.ai");
        assert_eq!(cfg.smtp_proxy, "http://file-proxy");
    }

    #[test]
    fn keys_match_case_insensitively() {
        let root: Value = toml::from_str("[APP]\nAPIPREFIX = \"/x\"\n[Server.HTTP]\nPort = 9\n")
            .unwrap_or_else(|err| panic!("config: {err}"));
        let cfg = from_value(&root, &env_from(&[]));
        assert_eq!(cfg.api_prefix, "/x");
        assert_eq!(cfg.http_port, 9);
    }

    #[test]
    fn environment_overrides_file() {
        let cfg = parse(&env_from(&[
            ("KITION_DESKTOP_API_PORT", " 4242 "),
            ("KITION_DESKTOP_SQLITE_PATH", "/tmp/override.db"),
            ("KITION_PORTAL_BASE_URL", "https://example.test"),
        ]));
        assert_eq!(cfg.http_port, 4242);
        assert_eq!(cfg.sqlite_path, "/tmp/override.db");
        assert_eq!(cfg.portal_base_url, "https://example.test");
    }

    #[test]
    fn the_api_token_never_comes_from_configuration() {
        let root: Value = toml::from_str(
            "[app]\napiToken = \"from-file\"\n[server.http]\ntoken = \"t\"\ntokenFile = \"/run/kition/api-token\"\n",
        )
        .unwrap_or_else(|err| panic!("config: {err}"));
        let cfg = from_value(&root, &env_from(&[("KITION_API_TOKEN", "from-env")]));
        assert_eq!(cfg.api_token, "");
        assert_eq!(cfg.api_token_file, "/run/kition/api-token");
        let cfg = from_value(
            &root,
            &env_from(&[("KITION_API_TOKEN_FILE", "/tmp/elsewhere")]),
        );
        assert_eq!(cfg.api_token_file, "/tmp/elsewhere");
    }

    #[test]
    fn empty_or_invalid_environment_falls_back() {
        let cfg = parse(&env_from(&[
            ("KITION_DESKTOP_API_PORT", "nope"),
            ("KITION_DESKTOP_SQLITE_PATH", ""),
        ]));
        assert_eq!(cfg.http_port, 18101);
        assert_eq!(cfg.sqlite_path, "./data/test.db");
    }

    #[test]
    fn defaults_apply_to_missing_values() {
        let root: Value = toml::from_str("").unwrap_or_else(|err| panic!("config: {err}"));
        let cfg = from_value(&root, &env_from(&[]));
        assert_eq!(cfg.api_prefix, "/api/v1");
        assert_eq!(cfg.http_port, 8001);
        assert_eq!(cfg.log_level, "info");
        assert_eq!(cfg.portal_base_url, "https://kition.ai");
    }

    #[test]
    fn smtp_proxy_falls_back_to_https_proxy() {
        let root: Value = toml::from_str("").unwrap_or_else(|err| panic!("config: {err}"));
        let cfg = from_value(&root, &env_from(&[("https_proxy", "http://lower")]));
        assert_eq!(cfg.smtp_proxy, "http://lower");
    }

    #[test]
    fn resolves_config_path_in_priority_order() {
        let env = env_from(&[(CONFIG_ENV, " /etc/kition.toml ")]);
        assert_eq!(
            resolve_config_path(Some("a.toml"), &env),
            PathBuf::from("a.toml")
        );
        assert_eq!(
            resolve_config_path(None, &env),
            PathBuf::from("/etc/kition.toml")
        );
        assert_eq!(
            resolve_config_path(None, &env_from(&[])),
            PathBuf::from(DEFAULT_CONFIG_PATH)
        );
    }

    #[test]
    fn load_reports_missing_file() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"));
        let err = load(&dir.path().join("missing.toml"), &env_from(&[]));
        assert!(matches!(err, Err(ConfigError::Read { .. })));
    }
}
