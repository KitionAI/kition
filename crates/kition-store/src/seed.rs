//! Default rows created on startup when seeding is enabled.

use kition_core::{AppError, AppResult, now_millis};
use rusqlite::{Connection, params};

use crate::users::{self, NewUser};

pub fn run(conn: &Connection) -> AppResult<()> {
    seed_admin_user(conn)?;
    seed_workspace_user(conn)?;
    seed_oauth_platforms(conn)
}

/// bcrypt cost used by the legacy runtime.
const BCRYPT_COST: u32 = 10;

/// A bcrypt hash in the `$2a$10$` format the legacy runtime produced.
pub fn hash_password(password: &str) -> AppResult<String> {
    bcrypt::hash_with_result(password, BCRYPT_COST)
        .map(|parts| parts.format_for_version(bcrypt::Version::TwoA))
        .map_err(AppError::unhandled)
}

fn seed_admin_user(conn: &Connection) -> AppResult<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM users WHERE role = 'admin' AND deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    if count > 0 {
        return Ok(());
    }
    users::insert(
        conn,
        &NewUser {
            username: "admin",
            email: "admin@example.com",
            password_hash: &hash_password("admin123456")?,
            nickname: "Administrator",
            role: "admin",
            status: "active",
            daily_quota: 999_999,
        },
    )?;
    Ok(())
}

fn seed_workspace_user(conn: &Connection) -> AppResult<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM users WHERE role <> 'admin' AND status = 'active' AND deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    if count > 0 {
        return Ok(());
    }
    users::insert(
        conn,
        &NewUser {
            username: "workspace",
            email: "workspace@local",
            password_hash: &hash_password("workspace-local")?,
            nickname: "Local Workspace",
            role: "user",
            status: "active",
            daily_quota: 999_999,
        },
    )?;
    Ok(())
}

fn seed_oauth_platforms(conn: &Connection) -> AppResult<()> {
    let count: i64 =
        conn.query_row("SELECT COUNT(*) FROM oauth_platforms", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let now = now_millis();
    for (platform_id, name, login_url) in [
        ("openai", "OpenAI", "https://platform.openai.com"),
        ("claude", "Claude", "https://claude.ai"),
        ("gemini", "Gemini", "https://gemini.google.com"),
    ] {
        conn.execute(
            "INSERT INTO oauth_platforms (platform_id, platform_name, description, login_url, platform_icon, \
             o_auth_config, litellm_config, quota_config, is_enabled, created_at, updated_at) \
             VALUES (?1, ?2, ?3, '', '', ?4, NULL, ?5, 1, ?6, ?6)",
            params![
                platform_id,
                name,
                format!("{name} OAuth integration"),
                serde_json::json!({ "login_url": login_url }).to_string(),
                serde_json::json!({ "daily_tokens": 100_000 }).to_string(),
                now
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[test]
    fn seeds_once() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        run(&conn).unwrap_or_else(|err| panic!("{err}"));
        run(&conn).unwrap_or_else(|err| panic!("{err}"));
        let users: i64 = conn
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
            .unwrap_or_default();
        let platforms: i64 = conn
            .query_row("SELECT COUNT(*) FROM oauth_platforms", [], |row| row.get(0))
            .unwrap_or_default();
        assert_eq!((users, platforms), (2, 3));
        let hash: String = conn
            .query_row(
                "SELECT password_hash FROM users WHERE username = 'workspace'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_default();
        assert!(hash.starts_with("$2a$10$"));
        assert!(bcrypt::verify("workspace-local", &hash).unwrap_or(false));
    }
}
