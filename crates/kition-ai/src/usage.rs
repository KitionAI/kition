//! `/admin/model-usage`: AI call logs and aggregate statistics.

use std::collections::HashMap;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use chrono::{Datelike, Local, TimeZone};
use kition_core::coerce::parse_positive_or;
use kition_core::{AppError, AppResult, Millis};
use kition_http::{AuthConfig, CurrentUser, ok, require_admin};
use kition_store::json_column;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row, params_from_iter};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageLog {
    pub id: i64,
    pub user_id: i64,
    pub ai_model_id: i64,
    pub creation_id: Option<i64>,
    pub provider: String,
    pub model_name: String,
    pub tool: String,
    pub request_type: String,
    pub input_content: String,
    pub output_content: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub status: String,
    pub error_message: String,
    pub response_time_ms: i64,
    pub extra_data: Value,
    pub created_at: Millis,
}

const COLUMNS: &str = "id, user_id, ai_model_id, creation_id, provider, model_name, tool, request_type, \
    input_content, output_content, prompt_tokens, completion_tokens, total_tokens, status, error_message, \
    response_time_ms, extra_data, created_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<UsageLog> {
    let text = |i: usize| -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(i)?.unwrap_or_default())
    };
    let int = |i: usize| -> rusqlite::Result<i64> {
        Ok(row.get::<_, Option<i64>>(i)?.unwrap_or_default())
    };
    Ok(UsageLog {
        id: row.get(0)?,
        user_id: int(1)?,
        ai_model_id: int(2)?,
        creation_id: row.get(3)?,
        provider: text(4)?,
        model_name: text(5)?,
        tool: text(6)?,
        request_type: text(7)?,
        input_content: text(8)?,
        output_content: text(9)?,
        prompt_tokens: int(10)?,
        completion_tokens: int(11)?,
        total_tokens: int(12)?,
        status: text(13)?,
        error_message: text(14)?,
        response_time_ms: int(15)?,
        extra_data: json_column(row.get(16)?),
        created_at: int(17)?,
    })
}

/// A model call to log.
#[derive(Debug, Clone, Default)]
pub struct NewUsage {
    pub user_id: i64,
    pub provider: String,
    pub model_name: String,
    pub tool: String,
    pub request_type: String,
    pub input_content: String,
    pub output_content: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub status: String,
    pub error_message: String,
    pub response_time_ms: i64,
    pub extra_data: Value,
}

/// Appends a usage log row.
pub fn record(conn: &Connection, usage: &NewUsage) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ai_model_usage_logs (user_id, ai_model_id, provider, model_name, tool, request_type, \
         input_content, output_content, prompt_tokens, completion_tokens, total_tokens, status, error_message, \
         response_time_ms, extra_data, created_at) VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        rusqlite::params![
            usage.user_id,
            usage.provider,
            usage.model_name,
            usage.tool,
            usage.request_type,
            usage.input_content,
            usage.output_content,
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.total_tokens,
            if usage.status.is_empty() { "success" } else { usage.status.as_str() },
            usage.error_message,
            usage.response_time_ms,
            usage.extra_data.to_string(),
            kition_core::now_millis(),
        ],
    )?;
    Ok(())
}

#[derive(Clone)]
struct UsageState {
    auth: AuthConfig,
}

impl axum::extract::FromRef<UsageState> for AuthConfig {
    fn from_ref(state: &UsageState) -> Self {
        state.auth.clone()
    }
}

pub fn router(auth: AuthConfig) -> Router {
    Router::new()
        .route("/admin/model-usage/logs", get(logs))
        .route("/admin/model-usage/logs/{id}", get(detail))
        .route("/admin/model-usage/stats", get(stats))
        .with_state(UsageState { auth })
}

async fn logs(
    State(state): State<UsageState>,
    user: CurrentUser,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Response> {
    require_admin(&user)?;
    let page = parse_positive_or(query.get("page").map(String::as_str), 1);
    let page_size = parse_positive_or(query.get("page_size").map(String::as_str), 20).min(100);
    let mut conditions = Vec::new();
    let mut values = Vec::new();
    for key in ["provider", "tool", "status", "user_id"] {
        if let Some(value) = query.get(key).filter(|value| !value.is_empty()) {
            conditions.push(format!("{key} = ?"));
            values.push(SqlValue::Text(value.clone()));
        }
    }
    let filter = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let failed = || AppError::internal("Failed to query call logs");
    let (total, items) = state
        .auth
        .db
        .run(move |conn| {
            let total: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM ai_model_usage_logs{filter}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )?;
            let mut statement = conn.prepare(&format!(
                "SELECT {COLUMNS} FROM ai_model_usage_logs{filter} ORDER BY id DESC LIMIT {page_size} OFFSET {}",
                (page - 1) * page_size
            ))?;
            let items = statement
                .query_map(params_from_iter(values.iter()), from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((total, items))
        })
        .await
        .map_err(|_| failed())?;
    Ok(ok(
        json!({ "total": total, "page": page, "page_size": page_size, "items": items }),
    ))
}

async fn detail(
    State(state): State<UsageState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    require_admin(&user)?;
    let item = state
        .auth
        .db
        .run(move |conn| {
            Ok(conn
                .query_row(
                    &format!("SELECT {COLUMNS} FROM ai_model_usage_logs WHERE id = ?1"),
                    [id],
                    from_row,
                )
                .optional()?)
        })
        .await?
        .ok_or_else(|| AppError::not_found("Call log does not exist"))?;
    Ok(ok(item))
}

#[derive(Serialize)]
struct GroupTotal {
    #[serde(rename = "Provider", skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(rename = "Tool", skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(rename = "Count")]
    count: i64,
    #[serde(rename = "TotalTokens")]
    total_tokens: i64,
}

async fn stats(State(state): State<UsageState>, user: CurrentUser) -> AppResult<Response> {
    require_admin(&user)?;
    let (today_start, week_start) = day_and_week_start();
    let body = state
        .auth
        .db
        .run(move |conn| {
            let aggregate = |condition: &str, param: Option<Millis>| -> AppResult<(i64, i64)> {
                let sql = format!(
                    "SELECT COUNT(*), COALESCE(SUM(total_tokens), 0) FROM ai_model_usage_logs{condition}"
                );
                let result = match param {
                    Some(value) => conn.query_row(&sql, [value], |row| Ok((row.get(0)?, row.get(1)?))),
                    None => conn.query_row(&sql, [], |row| Ok((row.get(0)?, row.get(1)?))),
                }?;
                Ok(result)
            };
            let (total_calls, total_tokens) = aggregate("", None)?;
            let (today_calls, today_tokens) = aggregate(" WHERE created_at >= ?1", Some(today_start))?;
            let (week_calls, _) = aggregate(" WHERE created_at >= ?1", Some(week_start))?;
            let failed_calls: i64 = conn.query_row(
                "SELECT COUNT(*) FROM ai_model_usage_logs WHERE status = 'failed'",
                [],
                |row| row.get(0),
            )?;
            let by_provider = group_totals(conn, "provider")?;
            let by_tool = group_totals(conn, "tool")?;
            let success_rate = if total_calls > 0 {
                (total_calls - failed_calls) as f64 * 100.0 / total_calls as f64
            } else {
                0.0
            };
            Ok(json!({
                "overview": {
                    "total_calls": total_calls,
                    "today_calls": today_calls,
                    "week_calls": week_calls,
                    "total_tokens": total_tokens,
                    "today_tokens": today_tokens,
                    "failed_calls": failed_calls,
                    "success_rate": success_rate,
                },
                "by_provider": by_provider,
                "by_tool": by_tool,
            }))
        })
        .await?;
    Ok(ok(body))
}

fn group_totals(conn: &Connection, column: &str) -> AppResult<Vec<GroupTotal>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {column}, COUNT(*) AS count, COALESCE(SUM(total_tokens), 0) FROM ai_model_usage_logs \
         GROUP BY {column} ORDER BY count DESC"
    ))?;
    let is_provider = column == "provider";
    let rows = statement
        .query_map([], |row| {
            let key = row.get::<_, Option<String>>(0)?.unwrap_or_default();
            Ok(GroupTotal {
                provider: is_provider.then(|| key.clone()),
                tool: (!is_provider).then_some(key),
                count: row.get(1)?,
                total_tokens: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Local midnight today and local midnight on the most recent Sunday, in
/// Unix milliseconds.
fn day_and_week_start() -> (Millis, Millis) {
    let now = Local::now();
    let today = now.date_naive();
    let midnight = |date: chrono::NaiveDate| {
        date.and_hms_opt(0, 0, 0)
            .and_then(|naive| Local.from_local_datetime(&naive).earliest())
            .map_or(0, |time| time.timestamp_millis())
    };
    let days_since_sunday = i64::from(today.weekday().num_days_from_sunday());
    let sunday = today - chrono::Duration::days(days_since_sunday);
    (midnight(today), midnight(sunday))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn week_starts_before_or_at_today() {
        let (today, week) = day_and_week_start();
        assert!(week <= today);
        assert!(today - week < 7 * 24 * 3600 * 1000 + 3600 * 1000);
    }
}
