//! Per-user desktop notification preferences.

use kition_core::{AppError, AppResult, now_millis};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Policy {
    #[serde(default)]
    pub system_notifications_enabled: bool,
    #[serde(default)]
    pub on_task_completed: bool,
    #[serde(default)]
    pub on_task_failed: bool,
    #[serde(default)]
    pub on_user_input_needed: bool,
    #[serde(default)]
    pub long_running_threshold_seconds: i64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            system_notifications_enabled: true,
            on_task_completed: true,
            on_task_failed: true,
            on_user_input_needed: true,
            long_running_threshold_seconds: 0,
        }
    }
}

pub(crate) fn read(conn: &Connection, user_id: i64) -> AppResult<Policy> {
    let row = conn
        .query_row(
            "SELECT system_notifications_enabled, on_task_completed, on_task_failed, on_user_input_needed, long_running_threshold_seconds \
             FROM desktop_notification_policies WHERE user_id = ?1",
            [user_id],
            |r| {
                Ok(Policy {
                    system_notifications_enabled: r.get(0)?,
                    on_task_completed: r.get(1)?,
                    on_task_failed: r.get(2)?,
                    on_user_input_needed: r.get(3)?,
                    long_running_threshold_seconds: r.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| AppError::internal("Failed to read notification settings"))?;
    Ok(row.unwrap_or_default())
}

/// Saves the policy, clamping the long-running threshold to 0..=3600 seconds.
pub(crate) fn write(conn: &Connection, user_id: i64, mut policy: Policy) -> AppResult<Policy> {
    policy.long_running_threshold_seconds = policy.long_running_threshold_seconds.clamp(0, 3600);
    let now = now_millis();
    conn.execute(
        "INSERT INTO desktop_notification_policies (user_id, system_notifications_enabled, on_task_completed, on_task_failed, \
         on_user_input_needed, long_running_threshold_seconds, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) \
         ON CONFLICT(user_id) DO UPDATE SET system_notifications_enabled = excluded.system_notifications_enabled, \
         on_task_completed = excluded.on_task_completed, on_task_failed = excluded.on_task_failed, \
         on_user_input_needed = excluded.on_user_input_needed, \
         long_running_threshold_seconds = excluded.long_running_threshold_seconds, updated_at = excluded.updated_at",
        params![
            user_id,
            policy.system_notifications_enabled,
            policy.on_task_completed,
            policy.on_task_failed,
            policy.on_user_input_needed,
            policy.long_running_threshold_seconds,
            now
        ],
    )
    .map_err(|_| AppError::internal("Failed to save notification settings"))?;
    Ok(policy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kition_store::Db;

    #[test]
    fn defaults_then_saves_with_clamping() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(read(&conn, 1).ok(), Some(Policy::default()));
        let saved = write(
            &conn,
            1,
            Policy {
                on_task_failed: false,
                long_running_threshold_seconds: 9999,
                ..Policy::default()
            },
        )
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(saved.long_running_threshold_seconds, 3600);
        assert_eq!(read(&conn, 1).ok(), Some(saved.clone()));
        let again = write(
            &conn,
            1,
            Policy {
                long_running_threshold_seconds: -5,
                ..saved
            },
        )
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(
            read(&conn, 1)
                .map(|p| p.long_running_threshold_seconds)
                .ok(),
            Some(0)
        );
        assert!(!again.on_task_failed);
    }
}
