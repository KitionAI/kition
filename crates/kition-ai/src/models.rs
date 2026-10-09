//! `/models`: the user's AI model configurations.

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use kition_core::coerce::{as_bool, as_str, first_non_empty};
use kition_core::{AppError, AppResult, Millis, now_millis};
use kition_http::{AuthConfig, CurrentUser, JsonBody, ok};
use kition_store::{Db, json_column};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AiModel {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub provider: String,
    pub model_name: String,
    pub api_key: String,
    pub base_url: String,
    pub is_default: bool,
    pub is_active: bool,
    pub is_system_builtin: bool,
    pub description: String,
    pub capabilities: Value,
    pub created_at: Millis,
    pub updated_at: Millis,
}

const COLUMNS: &str = "id, user_id, name, provider, model_name, api_key, base_url, is_default, is_active, \
    is_system_builtin, description, capabilities, created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<AiModel> {
    let text = |i: usize| -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(i)?.unwrap_or_default())
    };
    let flag = |i: usize| -> rusqlite::Result<bool> {
        Ok(row.get::<_, Option<i64>>(i)?.unwrap_or_default() != 0)
    };
    Ok(AiModel {
        id: row.get(0)?,
        user_id: row.get::<_, Option<i64>>(1)?.unwrap_or_default(),
        name: text(2)?,
        provider: text(3)?,
        model_name: text(4)?,
        api_key: text(5)?,
        base_url: text(6)?,
        is_default: flag(7)?,
        is_active: flag(8)?,
        is_system_builtin: flag(9)?,
        description: text(10)?,
        capabilities: json_column(row.get(11)?),
        created_at: row.get::<_, Option<i64>>(12)?.unwrap_or_default(),
        updated_at: row.get::<_, Option<i64>>(13)?.unwrap_or_default(),
    })
}

/// Active models visible to `user_id` (their own plus built-ins), default
/// first, newest first.
pub fn list_visible(conn: &Connection, user_id: i64) -> AppResult<Vec<AiModel>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM ai_models WHERE (user_id = ?1 OR is_system_builtin = 1) AND is_active = 1 \
         ORDER BY is_default DESC, id DESC"
    ))?;
    let rows = statement
        .query_map([user_id], from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A model visible to `user_id`.
pub fn find_visible(conn: &Connection, user_id: i64, id: i64) -> AppResult<Option<AiModel>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM ai_models WHERE id = ?1 AND (user_id = ?2 OR is_system_builtin = 1)"),
            params![id, user_id],
            from_row,
        )
        .optional()?)
}

fn find_owned(conn: &Connection, user_id: i64, id: i64) -> AppResult<Option<AiModel>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM ai_models WHERE id = ?1 AND user_id = ?2"),
            params![id, user_id],
            from_row,
        )
        .optional()?)
}

/// Inserts `model` (its `id` and timestamps are assigned) and returns it.
pub fn insert(conn: &Connection, mut model: AiModel) -> AppResult<AiModel> {
    let now = now_millis();
    conn.execute(
        "INSERT INTO ai_models (user_id, name, provider, model_name, api_key, base_url, is_default, is_active, \
         is_system_builtin, description, capabilities, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            model.user_id,
            model.name,
            model.provider,
            model.model_name,
            model.api_key,
            model.base_url,
            model.is_default,
            model.is_active,
            model.is_system_builtin,
            model.description,
            model.capabilities.to_string(),
            now
        ],
    )?;
    model.id = conn.last_insert_rowid();
    model.created_at = now;
    model.updated_at = now;
    Ok(model)
}

fn save(conn: &Connection, model: &mut AiModel) -> AppResult<()> {
    model.updated_at = now_millis();
    conn.execute(
        "UPDATE ai_models SET name = ?2, provider = ?3, model_name = ?4, api_key = ?5, base_url = ?6, \
         is_default = ?7, is_active = ?8, is_system_builtin = ?9, description = ?10, capabilities = ?11, \
         updated_at = ?12 WHERE id = ?1",
        params![
            model.id,
            model.name,
            model.provider,
            model.model_name,
            model.api_key,
            model.base_url,
            model.is_default,
            model.is_active,
            model.is_system_builtin,
            model.description,
            model.capabilities.to_string(),
            model.updated_at
        ],
    )?;
    Ok(())
}

/// Whether the model advertises `capability`. A model without a string
/// capability list supports everything.
pub fn supports_capability(model: &AiModel, capability: &str) -> bool {
    let capability = capability.trim();
    if capability.is_empty() {
        return true;
    }
    let Some(list) = model.capabilities.as_array() else {
        return true;
    };
    if list.is_empty() || !list.iter().all(Value::is_string) {
        return true;
    }
    list.iter()
        .filter_map(Value::as_str)
        .any(|value| value.trim() == capability)
}

#[derive(Clone)]
pub struct ModelsState {
    pub auth: AuthConfig,
}

impl axum::extract::FromRef<ModelsState> for AuthConfig {
    fn from_ref(state: &ModelsState) -> Self {
        state.auth.clone()
    }
}

pub fn router(auth: AuthConfig) -> Router {
    Router::new()
        .route("/models", get(list).post(create))
        .route("/models/{id}", get(detail).put(update).delete(delete))
        .with_state(ModelsState { auth })
}

fn db(state: &ModelsState) -> Db {
    state.auth.db.clone()
}

async fn list(
    State(state): State<ModelsState>,
    user: CurrentUser,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> AppResult<Response> {
    let capability = query.get("capability").cloned().unwrap_or_default();
    let user_id = user.id;
    let models = db(&state)
        .run(move |conn| list_visible(conn, user_id))
        .await
        .map_err(|_| AppError::internal("Failed to query models"))?;
    let visible: Vec<AiModel> = models
        .into_iter()
        .filter(|model| capability.is_empty() || supports_capability(model, &capability))
        .collect();
    Ok(ok(visible))
}

async fn detail(
    State(state): State<ModelsState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let not_found = || AppError::not_found("Model does not exist");
    let id: i64 = id.parse().map_err(|_| not_found())?;
    let user_id = user.id;
    let model = db(&state)
        .run(move |conn| find_visible(conn, user_id, id))
        .await?
        .ok_or_else(not_found)?;
    Ok(ok(model))
}

async fn create(
    State(state): State<ModelsState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<Map<String, Value>>,
) -> AppResult<Response> {
    let field = |key: &str| request.get(key).unwrap_or(&Value::Null);
    let model = AiModel {
        id: 0,
        user_id: user.id,
        name: first_non_empty(&[as_str(field("name")), "Untitled Model"]).to_owned(),
        provider: first_non_empty(&[as_str(field("provider")), "openai"]).to_owned(),
        model_name: first_non_empty(&[as_str(field("model_name")), "gpt-4.1-mini"]).to_owned(),
        api_key: as_str(field("api_key")).to_owned(),
        base_url: as_str(field("base_url")).to_owned(),
        is_default: as_bool(field("is_default")),
        is_active: field("is_active").is_null() || as_bool(field("is_active")),
        is_system_builtin: as_bool(field("is_system_builtin")),
        description: as_str(field("description")).to_owned(),
        capabilities: field("capabilities").clone(),
        created_at: 0,
        updated_at: 0,
    };
    let created = db(&state)
        .run(move |conn| {
            if model.is_default {
                conn.execute(
                    "UPDATE ai_models SET is_default = 0 WHERE user_id = ?1",
                    [model.user_id],
                )?;
            }
            insert(conn, model)
        })
        .await
        .map_err(|_| AppError::internal("Failed to create model"))?;
    Ok(ok(created))
}

async fn update(
    State(state): State<ModelsState>,
    user: CurrentUser,
    Path(id): Path<String>,
    JsonBody(request): JsonBody<Map<String, Value>>,
) -> AppResult<Response> {
    let not_found = || AppError::not_found("Model does not exist");
    let id: i64 = id.parse().map_err(|_| not_found())?;
    let user_id = user.id;
    let database = db(&state);
    let mut model = database
        .run(move |conn| find_owned(conn, user_id, id))
        .await?
        .ok_or_else(not_found)?;

    for (key, target) in [
        ("name", &mut model.name),
        ("provider", &mut model.provider),
        ("model_name", &mut model.model_name),
    ] {
        let value = request.get(key).map(as_str).unwrap_or_default();
        if !value.is_empty() {
            *target = value.to_owned();
        }
    }
    for (key, target) in [
        ("api_key", &mut model.api_key),
        ("base_url", &mut model.base_url),
        ("description", &mut model.description),
    ] {
        if let Some(value) = request.get(key) {
            *target = as_str(value).to_owned();
        }
    }
    if let Some(value) = request.get("is_default") {
        model.is_default = as_bool(value);
    }
    if let Some(value) = request.get("is_active") {
        model.is_active = as_bool(value);
    }
    if let Some(value) = request.get("capabilities") {
        model.capabilities = value.clone();
    }

    let saved = database
        .run(move |conn| {
            if model.is_default {
                conn.execute(
                    "UPDATE ai_models SET is_default = 0 WHERE user_id = ?1 AND id <> ?2",
                    params![model.user_id, model.id],
                )?;
            }
            save(conn, &mut model)?;
            Ok(model)
        })
        .await
        .map_err(|_| AppError::internal("Failed to update model"))?;
    Ok(ok(saved))
}

async fn delete(
    State(state): State<ModelsState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let user_id = user.id;
    db(&state)
        .run(move |conn| {
            conn.execute(
                "DELETE FROM ai_models WHERE id = ?1 AND user_id = ?2",
                params![id, user_id],
            )?;
            Ok(())
        })
        .await
        .map_err(|_| AppError::internal("Failed to delete model"))?;
    Ok(ok(serde_json::json!({ "message": "Model deleted" })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(capabilities: Value) -> AiModel {
        AiModel {
            id: 1,
            user_id: 1,
            name: String::new(),
            provider: String::new(),
            model_name: String::new(),
            api_key: String::new(),
            base_url: String::new(),
            is_default: false,
            is_active: true,
            is_system_builtin: false,
            description: String::new(),
            capabilities,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn capability_matching() {
        assert!(supports_capability(
            &model(serde_json::json!(["text", " image "])),
            "image"
        ));
        assert!(!supports_capability(
            &model(serde_json::json!(["text"])),
            "image"
        ));
        assert!(supports_capability(&model(Value::Null), "image"));
        assert!(supports_capability(&model(serde_json::json!([])), "image"));
        assert!(supports_capability(
            &model(serde_json::json!([1, "text"])),
            "image"
        ));
        assert!(supports_capability(
            &model(serde_json::json!(["text"])),
            " "
        ));
    }

    #[test]
    fn insert_and_query() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        let mut first = model(serde_json::json!(["text"]));
        first.name = "a".to_owned();
        let first = insert(&conn, first).unwrap_or_else(|err| panic!("{err}"));
        let mut second = model(Value::Null);
        second.is_default = true;
        let second = insert(&conn, second).unwrap_or_else(|err| panic!("{err}"));
        let listed = list_visible(&conn, 1).unwrap_or_default();
        assert_eq!(
            listed.iter().map(|m| m.id).collect::<Vec<_>>(),
            vec![second.id, first.id]
        );
        assert_eq!(listed[1].capabilities, serde_json::json!(["text"]));
        assert_eq!(listed[0].capabilities, Value::Null);
        assert!(
            find_visible(&conn, 2, first.id)
                .unwrap_or_default()
                .is_none()
        );
    }
}
