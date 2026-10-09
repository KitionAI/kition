//! The `users` table.

use kition_core::{AppResult, Millis, now_millis};
use rusqlite::{Connection, OptionalExtension, Row, params};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub password_hash: String,
    pub nickname: String,
    pub avatar: String,
    pub phone: String,
    pub role: String,
    pub status: String,
    pub daily_quota: i64,
    pub used_quota: i64,
    pub total_creations: i64,
    pub last_login_at: Option<Millis>,
    pub last_login_ip: String,
    pub created_at: Millis,
    pub updated_at: Millis,
}

const COLUMNS: &str = "id, username, email, password_hash, nickname, avatar, phone, role, status, \
    daily_quota, used_quota, total_creations, last_login_at, last_login_ip, created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<User> {
    let text = |index: usize| -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(index)?.unwrap_or_default())
    };
    let int = |index: usize| -> rusqlite::Result<i64> {
        Ok(row.get::<_, Option<i64>>(index)?.unwrap_or_default())
    };
    Ok(User {
        id: row.get(0)?,
        username: text(1)?,
        email: text(2)?,
        password_hash: text(3)?,
        nickname: text(4)?,
        avatar: text(5)?,
        phone: text(6)?,
        role: text(7)?,
        status: text(8)?,
        daily_quota: int(9)?,
        used_quota: int(10)?,
        total_creations: int(11)?,
        last_login_at: row.get(12)?,
        last_login_ip: text(13)?,
        created_at: int(14)?,
        updated_at: int(15)?,
    })
}

/// A live (not soft-deleted) user by ID.
pub fn find_by_id(conn: &Connection, id: i64) -> AppResult<Option<User>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM users WHERE id = ?1 AND deleted_at IS NULL"),
            [id],
            from_row,
        )
        .optional()?)
}

/// The single local profile used when authentication is disabled: the first
/// active non-admin user, then the first active admin, then any active user.
pub fn find_local_user(conn: &Connection) -> AppResult<Option<User>> {
    let queries = [
        "role <> 'admin' AND status = 'active' AND deleted_at IS NULL",
        "role = 'admin' AND status = 'active' AND deleted_at IS NULL",
        "status = 'active' AND deleted_at IS NULL",
    ];
    for condition in queries {
        let user = conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM users WHERE {condition} ORDER BY id ASC LIMIT 1"),
                [],
                from_row,
            )
            .optional()?;
        if user.is_some() {
            return Ok(user);
        }
    }
    Ok(None)
}

pub struct NewUser<'a> {
    pub username: &'a str,
    pub email: &'a str,
    pub password_hash: &'a str,
    pub nickname: &'a str,
    pub role: &'a str,
    pub status: &'a str,
    pub daily_quota: i64,
}

pub fn insert(conn: &Connection, user: &NewUser<'_>) -> AppResult<i64> {
    let now = now_millis();
    conn.execute(
        "INSERT INTO users (username, email, password_hash, nickname, avatar, phone, role, status, \
         daily_quota, used_quota, total_creations, last_login_ip, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, '', '', ?5, ?6, ?7, 0, 0, '', ?8, ?8)",
        params![
            user.username,
            user.email,
            user.password_hash,
            user.nickname,
            user.role,
            user.status,
            user.daily_quota,
            now
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[test]
    fn local_user_prefers_active_non_admin() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(find_local_user(&conn).unwrap_or_default(), None);
        let new = |username: &'static str, role: &'static str| NewUser {
            username,
            email: username,
            password_hash: "h",
            nickname: username,
            role,
            status: "active",
            daily_quota: 1,
        };
        let admin = insert(&conn, &new("admin", "admin")).unwrap_or_default();
        assert_eq!(
            find_local_user(&conn).ok().flatten().map(|u| u.id),
            Some(admin)
        );
        let local = insert(&conn, &new("workspace", "user")).unwrap_or_default();
        assert_eq!(
            find_local_user(&conn).ok().flatten().map(|u| u.id),
            Some(local)
        );
        let found = find_by_id(&conn, local).ok().flatten();
        assert_eq!(found.map(|u| u.username), Some("workspace".to_owned()));
    }
}
