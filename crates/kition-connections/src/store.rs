//! The `connections` table.

use kition_core::{AppResult, Millis, now_millis};
use kition_store::{Db, json_column};
use rusqlite::{Connection as Sql, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::secret::{SecretBag, SecretStore};

pub const CHANNEL_EMAIL_SMTP: &str = "email_smtp";
pub const STATUS_PENDING: &str = "pending";
pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_INVALID: &str = "invalid";

#[derive(Debug, Clone, PartialEq)]
pub struct Connection {
    pub id: String,
    pub user_id: i64,
    pub channel: String,
    pub name: String,
    pub settings: Map<String, Value>,
    pub secret_json: String,
    pub status: String,
    pub last_verified_at: Option<Millis>,
    pub last_error_code: String,
    pub last_error_message: String,
    pub created_at: Millis,
    pub updated_at: Millis,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub id: String,
    pub channel: String,
    pub name: String,
    pub settings: Map<String, Value>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<Millis>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_error_code: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_error_message: String,
    pub used_by_count: usize,
    pub created_at: Millis,
    pub updated_at: Millis,
}

impl Connection {
    pub fn view(&self, used_by: usize) -> ConnectionView {
        ConnectionView {
            id: self.id.clone(),
            channel: self.channel.clone(),
            name: self.name.clone(),
            settings: self.settings.clone(),
            status: self.status.clone(),
            last_verified_at: self.last_verified_at,
            last_error_code: self.last_error_code.clone(),
            last_error_message: self.last_error_message.clone(),
            used_by_count: used_by,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: i64,
    pub message: String,
    pub error_code: String,
}

impl Serialize for TestResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = Map::new();
        map.insert("ok".into(), Value::Bool(self.ok));
        if self.latency_ms != 0 {
            map.insert("latencyMs".into(), Value::from(self.latency_ms));
        }
        if !self.message.is_empty() {
            map.insert("message".into(), Value::String(self.message.clone()));
        }
        if !self.error_code.is_empty() {
            map.insert("errorCode".into(), Value::String(self.error_code.clone()));
        }
        Value::Object(map).serialize(serializer)
    }
}

const COLUMNS: &str = "id, user_id, channel, name, settings_json, secret_json, status, last_verified_at, \
    last_error_code, last_error_message, created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Connection> {
    let text = |i: usize| -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(i)?.unwrap_or_default())
    };
    Ok(Connection {
        id: row.get(0)?,
        user_id: row.get::<_, Option<i64>>(1)?.unwrap_or_default(),
        channel: text(2)?,
        name: text(3)?,
        settings: json_column(row.get(4)?)
            .as_object()
            .cloned()
            .unwrap_or_default(),
        secret_json: text(5)?,
        status: text(6)?,
        last_verified_at: row.get(7)?,
        last_error_code: text(8)?,
        last_error_message: text(9)?,
        created_at: row.get::<_, Option<i64>>(10)?.unwrap_or_default(),
        updated_at: row.get::<_, Option<i64>>(11)?.unwrap_or_default(),
    })
}

pub struct UpsertInput {
    pub channel: String,
    pub name: String,
    pub settings: Option<Map<String, Value>>,
    pub secrets: SecretBag,
}

/// Settings never store secret material.
fn clean_settings(settings: Option<Map<String, Value>>) -> Map<String, Value> {
    let mut settings = settings.unwrap_or_default();
    for key in ["password", "secret", "secrets"] {
        settings.remove(key);
    }
    settings
}

#[derive(Clone)]
pub struct Store {
    pub db: Db,
    pub secrets: SecretStore,
}

impl Store {
    pub fn list(&self, conn: &Sql, user_id: i64) -> AppResult<Vec<Connection>> {
        let mut statement = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM connections WHERE user_id = ?1 ORDER BY created_at DESC"
        ))?;
        Ok(statement
            .query_map([user_id], from_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get(&self, conn: &Sql, user_id: i64, id: &str) -> AppResult<Option<Connection>> {
        Ok(conn
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM connections WHERE user_id = ?1 AND id = ?2 LIMIT 1"
                ),
                params![user_id, id],
                from_row,
            )
            .optional()?)
    }

    pub fn first_by_channel(
        &self,
        conn: &Sql,
        user_id: i64,
        channel: &str,
    ) -> AppResult<Option<Connection>> {
        Ok(conn
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM connections WHERE user_id = ?1 AND channel = ?2 ORDER BY created_at ASC LIMIT 1"
                ),
                params![user_id, channel],
                from_row,
            )
            .optional()?)
    }

    pub fn count_by_channel(&self, conn: &Sql, user_id: i64, channel: &str) -> AppResult<i64> {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM connections WHERE user_id = ?1 AND channel = ?2",
            params![user_id, channel],
            |row| row.get(0),
        )?)
    }

    pub fn create(
        &self,
        conn: &Sql,
        user_id: i64,
        input: UpsertInput,
    ) -> Result<Connection, String> {
        let settings = clean_settings(input.settings);
        let secret_json = self.secrets.seal(&input.secrets)?;
        let now = now_millis();
        let row = Connection {
            id: format!("conn_{}", uuid::Uuid::new_v4().simple()),
            user_id,
            channel: input.channel.trim().to_owned(),
            name: input.name.trim().to_owned(),
            settings,
            secret_json,
            status: STATUS_PENDING.to_owned(),
            last_verified_at: None,
            last_error_code: String::new(),
            last_error_message: String::new(),
            created_at: now,
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO connections (id, user_id, channel, name, settings_json, secret_json, status, last_verified_at, \
             last_error_code, last_error_message, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, '', '', ?8, ?8)",
            params![
                row.id,
                row.user_id,
                row.channel,
                row.name,
                Value::Object(row.settings.clone()).to_string(),
                row.secret_json,
                row.status,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(row)
    }

    pub fn save(&self, conn: &Sql, row: &mut Connection) -> AppResult<()> {
        row.updated_at = now_millis();
        conn.execute(
            "UPDATE connections SET channel = ?2, name = ?3, settings_json = ?4, secret_json = ?5, status = ?6, \
             last_verified_at = ?7, last_error_code = ?8, last_error_message = ?9, updated_at = ?10 WHERE id = ?1",
            params![
                row.id,
                row.channel,
                row.name,
                Value::Object(row.settings.clone()).to_string(),
                row.secret_json,
                row.status,
                row.last_verified_at,
                row.last_error_code,
                row.last_error_message,
                row.updated_at
            ],
        )?;
        Ok(())
    }

    /// Applies a name/settings/secrets update; `None` when the row is missing.
    pub fn update(
        &self,
        conn: &Sql,
        user_id: i64,
        id: &str,
        input: UpsertInput,
    ) -> Result<Option<Connection>, String> {
        let Some(mut row) = self.get(conn, user_id, id).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        if !input.name.trim().is_empty() {
            row.name = input.name.trim().to_owned();
        }
        if input.settings.is_some() {
            row.settings = clean_settings(input.settings);
        }
        if !input.secrets.is_empty() {
            row.secret_json = self.secrets.seal(&input.secrets)?;
        }
        self.save(conn, &mut row).map_err(|e| e.to_string())?;
        Ok(Some(row))
    }

    pub fn delete(&self, conn: &Sql, user_id: i64, id: &str) -> AppResult<bool> {
        Ok(conn.execute(
            "DELETE FROM connections WHERE user_id = ?1 AND id = ?2",
            params![user_id, id],
        )? > 0)
    }

    pub fn open_secrets(&self, row: &Connection) -> Result<SecretBag, String> {
        self.secrets.open(&row.secret_json)
    }

    pub fn mark_test_result(
        &self,
        conn: &Sql,
        row: &mut Connection,
        result: &TestResult,
    ) -> AppResult<()> {
        row.last_verified_at = Some(now_millis());
        if result.ok {
            row.status = STATUS_ACTIVE.to_owned();
            row.last_error_code.clear();
            row.last_error_message.clear();
        } else {
            row.status = STATUS_INVALID.to_owned();
            row.last_error_code = result.error_code.clone();
            row.last_error_message = result.message.clone();
        }
        self.save(conn, row)
    }

    pub fn mark_invalid(&self, conn: &Sql, user_id: i64, id: &str, code: &str, message: &str) {
        let _ = conn.execute(
            "UPDATE connections SET status = ?3, last_error_code = ?4, last_error_message = ?5, updated_at = ?6 \
             WHERE user_id = ?1 AND id = ?2",
            params![user_id, id, STATUS_INVALID, code, message, now_millis()],
        );
    }
}
