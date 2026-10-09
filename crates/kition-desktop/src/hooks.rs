//! User-configured shell hooks fired by desktop and Agent lifecycle events.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use kition_core::{AppError, AppResult, Millis, now_millis};
use kition_store::Db;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const EVENTS: [&str; 7] = [
    "task_started",
    "task_completed",
    "task_failed",
    "tool_called",
    "user_input_needed",
    "session_started",
    "on_quit",
];

#[derive(Debug, Clone, Default)]
pub struct Hook {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub event: String,
    pub matcher: String,
    pub command: String,
    pub workdir: String,
    pub timeout_seconds: i64,
    pub enabled: bool,
    pub last_run_at: Option<Millis>,
    pub last_exit_code: Option<i64>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

const COLUMNS: &str = "id, user_id, name, event, matcher, command, workdir, timeout_seconds, enabled, last_run_at, last_exit_code, \
    created_at, updated_at";

fn from_row(r: &Row<'_>) -> rusqlite::Result<Hook> {
    let text = |i: usize| -> rusqlite::Result<String> {
        Ok(r.get::<_, Option<String>>(i)?.unwrap_or_default())
    };
    Ok(Hook {
        id: r.get(0)?,
        user_id: r.get(1)?,
        name: text(2)?,
        event: text(3)?,
        matcher: text(4)?,
        command: text(5)?,
        workdir: text(6)?,
        timeout_seconds: r.get::<_, Option<i64>>(7)?.unwrap_or(5),
        enabled: r.get::<_, Option<bool>>(8)?.unwrap_or(true),
        last_run_at: r.get(9)?,
        last_exit_code: r.get(10)?,
        created_at: r.get::<_, Option<i64>>(11)?.unwrap_or_default(),
        updated_at: r.get::<_, Option<i64>>(12)?.unwrap_or_default(),
    })
}

/// Keeps an absolute workdir's basename but replaces its parents with a
/// short hash, so API responses never echo full local paths.
pub(crate) fn redact_workdir(path: &str) -> String {
    if path.is_empty() || !Path::new(path).is_absolute() {
        return path.to_owned();
    }
    let base = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".into());
    format!(
        "{base}#{}",
        hex::encode(&Sha256::digest(path.as_bytes())[..4])
    )
}

#[derive(Debug, Serialize)]
pub struct HookView {
    pub id: i64,
    pub name: String,
    pub event: String,
    pub matcher: String,
    pub command: String,
    pub workdir: String,
    pub timeout_seconds: i64,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<Millis>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit_code: Option<i64>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

impl From<Hook> for HookView {
    fn from(h: Hook) -> Self {
        Self {
            id: h.id,
            workdir: redact_workdir(&h.workdir),
            name: h.name,
            event: h.event,
            matcher: h.matcher,
            command: h.command,
            timeout_seconds: h.timeout_seconds,
            enabled: h.enabled,
            last_run_at: h.last_run_at,
            last_exit_code: h.last_exit_code,
            created_at: h.created_at,
            updated_at: h.updated_at,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct HookInput {
    pub name: String,
    pub event: String,
    pub matcher: String,
    pub command: String,
    pub workdir: String,
    pub timeout_seconds: i64,
    pub enabled: Option<bool>,
}

impl HookInput {
    /// Trims the fields and checks their limits (lengths in bytes).
    pub fn validate(&mut self) -> AppResult<()> {
        for field in [
            &mut self.name,
            &mut self.event,
            &mut self.matcher,
            &mut self.command,
            &mut self.workdir,
        ] {
            *field = field.trim().to_owned();
        }
        let fail = |message: &str| Err(AppError::bad_request(message));
        if !(1..=60).contains(&self.name.len()) {
            return fail("Hook name length must be between 1 and 60");
        }
        if !EVENTS.contains(&self.event.as_str()) {
            return fail("Unsupported hook event");
        }
        if !(1..=1024).contains(&self.command.len()) {
            return fail("Hook command length must be between 1 and 1024");
        }
        if !(1..=300).contains(&self.timeout_seconds) {
            return fail("Timeout must be between 1 and 300 seconds");
        }
        if self.matcher.len() > 120 {
            return fail("Matcher must not exceed 120 characters");
        }
        if self.workdir.len() > 512 {
            return fail("Workdir must not exceed 512 characters");
        }
        Ok(())
    }
}

pub(crate) fn list(conn: &Connection, user_id: i64) -> AppResult<Vec<HookView>> {
    let mut statement =
        conn.prepare(&format!("SELECT {COLUMNS} FROM desktop_hooks WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY id ASC"))?;
    let hooks = statement
        .query_map([user_id], from_row)?
        .collect::<Result<Vec<_>, _>>();
    Ok(hooks
        .map_err(|_| AppError::internal("Failed to read hooks"))?
        .into_iter()
        .map(HookView::from)
        .collect())
}

/// A user's hook by the raw path ID; non-numeric IDs match nothing.
pub(crate) fn find(conn: &Connection, user_id: i64, raw_id: &str) -> AppResult<Option<Hook>> {
    let Ok(id) = raw_id.trim().parse::<i64>() else {
        return Ok(None);
    };
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM desktop_hooks WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL"),
        params![id, user_id],
        from_row,
    )
    .optional()
    .map_err(|_| AppError::internal("Failed to read hook"))
}

pub(crate) fn create(conn: &Connection, user_id: i64, input: HookInput) -> AppResult<HookView> {
    let now = now_millis();
    conn.execute(
        "INSERT INTO desktop_hooks (user_id, name, event, matcher, command, workdir, timeout_seconds, enabled, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            user_id,
            input.name,
            input.event,
            input.matcher,
            input.command,
            input.workdir,
            input.timeout_seconds,
            input.enabled.unwrap_or(true),
            now
        ],
    )
    .map_err(|_| AppError::internal("Failed to create hook"))?;
    let id = conn.last_insert_rowid();
    find(conn, user_id, &id.to_string())?
        .map(HookView::from)
        .ok_or_else(|| AppError::internal("Failed to create hook"))
}

pub(crate) fn update(conn: &Connection, hook: &Hook, input: HookInput) -> AppResult<HookView> {
    conn.execute(
        "UPDATE desktop_hooks SET name = ?1, event = ?2, matcher = ?3, command = ?4, workdir = ?5, timeout_seconds = ?6, \
         enabled = COALESCE(?7, enabled), updated_at = ?8 WHERE id = ?9 AND user_id = ?10",
        params![
            input.name,
            input.event,
            input.matcher,
            input.command,
            input.workdir,
            input.timeout_seconds,
            input.enabled,
            now_millis(),
            hook.id,
            hook.user_id
        ],
    )
    .map_err(|_| AppError::internal("Failed to update hook"))?;
    find(conn, hook.user_id, &hook.id.to_string())
        .map_err(|_| AppError::internal("Failed to read updated hook"))?
        .map(HookView::from)
        .ok_or_else(|| AppError::internal("Failed to read updated hook"))
}

/// Soft-deletes a hook; false when nothing matched.
pub(crate) fn delete(conn: &Connection, user_id: i64, raw_id: &str) -> AppResult<bool> {
    let Ok(id) = raw_id.trim().parse::<i64>() else {
        return Ok(false);
    };
    let changed = conn
        .execute(
            "UPDATE desktop_hooks SET deleted_at = ?1 WHERE id = ?2 AND user_id = ?3 AND deleted_at IS NULL",
            params![now_millis(), id, user_id],
        )
        .map_err(|_| AppError::internal("Failed to delete hook"))?;
    Ok(changed > 0)
}

pub(crate) fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".into())
}

/// Event metadata hooks can match against.
#[derive(Debug, Clone, Default)]
pub struct Event {
    pub name: String,
    pub tool_name: String,
    pub stage: String,
}

/// `path.Match` glob semantics: `*`, `?`, `[...]` (with `^` negation and
/// ranges), and `\` escapes; `/` is never matched by a wildcard. A
/// malformed pattern matches nothing.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    fn class(pattern: &[char], mut i: usize, c: char) -> Option<(bool, usize)> {
        let negated = pattern.get(i) == Some(&'^');
        if negated {
            i += 1;
        }
        let mut matched = false;
        let mut first = true;
        loop {
            let mut lo = *pattern.get(i)?;
            if lo == ']' && !first {
                return Some((matched != negated, i + 1));
            }
            first = false;
            if lo == '\\' {
                i += 1;
                lo = *pattern.get(i)?;
            }
            i += 1;
            let mut hi = lo;
            if pattern.get(i) == Some(&'-') && pattern.get(i + 1).is_some_and(|c| *c != ']') {
                hi = pattern[i + 1];
                i += 2;
                if hi == '\\' {
                    hi = *pattern.get(i)?;
                    i += 1;
                }
            }
            if lo <= c && c <= hi {
                matched = true;
            }
        }
    }
    fn walk(p: &[char], n: &[char]) -> Option<bool> {
        match p.first() {
            None => Some(n.is_empty()),
            Some('*') => {
                let rest = &p[1..];
                for split in 0..=n.len() {
                    if split > 0 && n[split - 1] == '/' {
                        break;
                    }
                    if walk(rest, &n[split..])? {
                        return Some(true);
                    }
                }
                // Validate the rest of the pattern even when nothing matched.
                walk(rest, &[]).map(|_| false)
            }
            Some('?') => match n.first() {
                Some(c) if *c != '/' => walk(&p[1..], &n[1..]),
                _ => walk(&p[1..], &[]).map(|_| false),
            },
            Some('[') => {
                let Some(c) = n.first().copied().filter(|c| *c != '/') else {
                    class(p, 1, '\0')?;
                    return Some(false);
                };
                let (ok, next) = class(p, 1, c)?;
                if ok {
                    walk(&p[next..], &n[1..])
                } else {
                    walk(&p[next..], &[]).map(|_| false)
                }
            }
            Some('\\') => {
                let literal = *p.get(1)?;
                if n.first() == Some(&literal) {
                    walk(&p[2..], &n[1..])
                } else {
                    walk(&p[2..], &[]).map(|_| false)
                }
            }
            Some(literal) => {
                if n.first() == Some(literal) {
                    walk(&p[1..], &n[1..])
                } else {
                    walk(&p[1..], &[]).map(|_| false)
                }
            }
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    walk(&p, &n).unwrap_or(false)
}

fn matcher_allows(matcher: &str, event: &Event) -> bool {
    let pattern = matcher.trim();
    if pattern.is_empty() {
        return true;
    }
    let target = if event.tool_name.is_empty() {
        &event.stage
    } else {
        &event.tool_name
    };
    glob_match(pattern, target)
}

/// Runs matching hooks in the background and records each exit code.
#[derive(Clone)]
pub struct HookRunner {
    pub db: Db,
    /// Hook logs go to `<logs_dir>/hooks`.
    pub logs_dir: Option<PathBuf>,
    pub workspace_dir: Option<PathBuf>,
}

impl HookRunner {
    pub fn dispatch(&self, user_id: i64, event: Event) {
        if user_id <= 0 || event.name.trim().is_empty() {
            return;
        }
        let runner = self.clone();
        tokio::spawn(async move {
            let db = runner.db.clone();
            let name = event.name.clone();
            let hooks = db
                .run(move |conn| {
                    let mut statement = conn.prepare(&format!(
                        "SELECT {COLUMNS} FROM desktop_hooks WHERE user_id = ?1 AND event = ?2 AND enabled = 1 AND deleted_at IS NULL"
                    ))?;
                    Ok(statement.query_map(params![user_id, name], from_row)?.collect::<Result<Vec<_>, _>>()?)
                })
                .await;
            let hooks = match hooks {
                Ok(hooks) => hooks,
                Err(err) => {
                    tracing::warn!(error = %err, "failed to load desktop hooks");
                    return;
                }
            };
            for hook in hooks
                .into_iter()
                .filter(|h| matcher_allows(&h.matcher, &event))
            {
                let runner = runner.clone();
                tokio::spawn(async move { runner.run_one(hook).await });
            }
        });
    }

    async fn run_one(&self, hook: Hook) {
        let workdir = if hook.workdir.is_empty() {
            self.workspace_dir.clone()
        } else {
            Some(PathBuf::from(&hook.workdir))
        };
        let timeout = Duration::from_secs(
            u64::try_from(hook.timeout_seconds)
                .unwrap_or(0)
                .clamp(1, 300),
        );
        let timeout = if hook.timeout_seconds <= 0 {
            Duration::from_secs(5)
        } else {
            timeout
        };
        let exit_code = self.run_shell(&hook, workdir.as_deref(), timeout).await;
        let now = now_millis();
        let db = self.db.clone();
        let (id, user_id) = (hook.id, hook.user_id);
        let result = db
            .run(move |conn| {
                conn.execute(
                    "UPDATE desktop_hooks SET last_run_at = ?1, last_exit_code = ?2, updated_at = ?1 WHERE id = ?3 AND user_id = ?4",
                    params![now, exit_code, id, user_id],
                )?;
                Ok(())
            })
            .await;
        if let Err(err) = result {
            tracing::warn!(error = %err, "failed to record a desktop hook result");
        }
    }

    async fn run_shell(&self, hook: &Hook, workdir: Option<&Path>, timeout: Duration) -> i64 {
        let mut command = tokio::process::Command::new(login_shell());
        command
            .arg("-lc")
            .arg(&hook.command)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        if let Some(dir) = workdir.filter(|d| !d.as_os_str().is_empty()) {
            command.current_dir(dir);
        }
        let log = self.open_log(hook.id);
        match &log {
            Some((_, file)) => {
                use std::io::Write;
                let mut header = file.try_clone().ok();
                if let Some(header) = header.as_mut() {
                    let _ = writeln!(
                        header,
                        "[{}] event={} command={:?} workdir={:?} timeout={}s",
                        now_millis(),
                        hook.event,
                        hook.command,
                        workdir.map(|d| d.display().to_string()).unwrap_or_default(),
                        hook.timeout_seconds
                    );
                }
                command.stdout(
                    file.try_clone()
                        .map(Stdio::from)
                        .unwrap_or_else(|_| Stdio::null()),
                );
                command.stderr(
                    file.try_clone()
                        .map(Stdio::from)
                        .unwrap_or_else(|_| Stdio::null()),
                );
            }
            None => {
                command.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
        let exit_code = match command.spawn() {
            Err(_) => -1,
            Ok(mut child) => match tokio::time::timeout(timeout, child.wait()).await {
                Ok(Ok(status)) => status.code().map_or(-1, i64::from),
                Ok(Err(_)) => -1,
                Err(_) => {
                    let _ = child.kill().await;
                    -1
                }
            },
        };
        if let Some((path, mut file)) = log {
            use std::io::Write;
            let _ = writeln!(
                file,
                "[{}] exit_code={exit_code} log={}",
                now_millis(),
                path.display()
            );
        }
        exit_code
    }

    fn open_log(&self, hook_id: i64) -> Option<(PathBuf, std::fs::File)> {
        let dir = self.logs_dir.as_ref()?.join("hooks");
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join(format!("{hook_id}-{}.log", now_millis() / 1000));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        Some((path, file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_like_path_match() {
        assert!(glob_match("exec_*", "exec_command"));
        assert!(!glob_match("exec_*", "exec/command"));
        assert!(glob_match("a?c", "abc"));
        assert!(glob_match("[a-c]x", "bx"));
        assert!(!glob_match("[^a-c]x", "bx"));
        assert!(glob_match("\\*", "*"));
        assert!(!glob_match("[", "a"), "malformed patterns match nothing");
        assert!(!glob_match("a*[", "abc"));
        assert!(glob_match("*", ""));
        assert!(matcher_allows("", &Event::default()));
        assert!(matcher_allows(
            "plan*",
            &Event {
                stage: "planning".into(),
                ..Event::default()
            }
        ));
    }

    #[test]
    fn validates_and_redacts() {
        let mut input = HookInput {
            name: " n ".into(),
            event: "on_quit".into(),
            command: "true".into(),
            timeout_seconds: 5,
            ..Default::default()
        };
        assert!(input.validate().is_ok());
        assert_eq!(input.name, "n");
        input.event = "nope".into();
        assert_eq!(
            input.validate().err().map(|e| e.message.clone()),
            Some("Unsupported hook event".to_owned())
        );
        assert_eq!(redact_workdir("rel/dir"), "rel/dir");
        let redacted = redact_workdir("/tmp/project");
        assert!(redacted.starts_with("project#") && redacted.len() == "project#".len() + 8);
    }

    #[tokio::test]
    async fn runs_hooks_and_records_exit_codes() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let logs = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        {
            let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
            for (command, matcher) in [("exit 3", ""), ("exit 0", "other_*")] {
                let input = HookInput {
                    name: "h".into(),
                    event: "task_failed".into(),
                    matcher: matcher.into(),
                    command: command.into(),
                    timeout_seconds: 5,
                    ..Default::default()
                };
                create(&conn, 1, input).unwrap_or_else(|err| panic!("{err}"));
            }
        }
        let runner = HookRunner {
            db: db.clone(),
            logs_dir: Some(logs.path().to_path_buf()),
            workspace_dir: None,
        };
        runner.dispatch(
            1,
            Event {
                name: "task_failed".into(),
                tool_name: "exec_command".into(),
                ..Event::default()
            },
        );
        let mut codes = Vec::new();
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
            codes = list(&conn, 1)
                .unwrap_or_default()
                .into_iter()
                .map(|h| h.last_exit_code)
                .collect();
            if codes[0].is_some() {
                break;
            }
        }
        assert_eq!(codes, vec![Some(3), None]);
        assert!(
            std::fs::read_dir(logs.path().join("hooks"))
                .map(|d| d.count())
                .unwrap_or(0)
                >= 1
        );
    }
}
