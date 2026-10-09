//! Runtime identity, health, the current user, and the end-to-end reset hook.

use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::{get, post};
use kition_ai::models::{self, AiModel};
use kition_core::runtime_info::{self, CAPABILITIES};
use kition_core::{AppError, AppResult};
use kition_http::{AuthConfig, CurrentUser, ok};
use kition_store::seed::hash_password;
use rusqlite::params;
use serde_json::{Value, json};

use crate::app::Deps;

impl axum::extract::FromRef<Deps> for AuthConfig {
    fn from_ref(deps: &Deps) -> Self {
        deps.auth()
    }
}

/// Routes outside the API prefix.
pub fn root_router(deps: &Deps) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(|| async { ok("healthy") }))
        .route("/desktop/runtime", get(desktop_runtime))
        .with_state(deps.clone())
}

/// Routes under the API prefix.
pub fn api_router(deps: &Deps) -> Router {
    let mut router = Router::new().route("/auth/me", get(me));
    if deps.config.e2e_test_mode {
        router = router.route("/e2e/reset", post(e2e_reset));
    }
    router.with_state(deps.clone())
}

async fn root(State(deps): State<Deps>) -> Response {
    ok(json!({
        "app_name": deps.config.name,
        "version": deps.config.version,
        "api_prefix": deps.config.api_prefix,
        "docs_url": "",
    }))
}

async fn desktop_runtime(State(deps): State<Deps>) -> Response {
    let build = runtime_info::current(&deps.config.version);
    ok(json!({
        "pid": std::process::id(),
        "workspace_id": deps.workspace_id,
        "runtime_version": build.runtime_version,
        "protocol_version": build.protocol_version,
        "build_commit": build.build_commit,
        "capabilities": CAPABILITIES,
    }))
}

async fn me(user: CurrentUser) -> Response {
    let user = &user.user;
    ok(json!({
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "nickname": user.nickname,
        "avatar": user.avatar,
        "phone": user.phone,
        "role": user.role,
        "status": user.status,
        "is_active": user.status == "active",
        "daily_quota": user.daily_quota,
        "used_quota": user.used_quota,
        "total_creations": user.total_creations,
        "last_login_at": user.last_login_at,
        "last_login_ip": user.last_login_ip,
        "created_at": user.created_at,
    }))
}

const E2E_PASSWORD: &str = "123456";
const E2E_RESET_TABLES: [&str; 7] = [
    "connections",
    "oauth_usage_logs",
    "oauth_accounts",
    "ai_model_usage_logs",
    "ai_models",
    "oauth_platforms",
    "users",
];

/// Resets accounts and models to a deterministic state for browser tests.
async fn e2e_reset(State(deps): State<Deps>) -> AppResult<Response> {
    let failed = |_| AppError::internal("Failed to reset E2E data");
    let seeded = deps
        .db
        .run(|conn| {
            let tx = conn.transaction()?;
            for table in E2E_RESET_TABLES {
                tx.execute(&format!("DELETE FROM {table}"), [])?;
                tx.execute("DELETE FROM sqlite_sequence WHERE name = ?1", [table])?;
            }
            kition_store::seed::run(&tx)?;
            let password_hash = hash_password(E2E_PASSWORD)?;
            let mut accounts = serde_json::Map::new();
            let mut model_ids = serde_json::Map::new();
            for (key, username, email, role) in [
                ("normal", "e2e_user", "e2e_user@example.com", "user"),
                ("admin", "e2e_admin", "e2e_admin@example.com", "admin"),
            ] {
                let condition = if role == "admin" { "role = 'admin'" } else { "role <> 'admin'" };
                let id: i64 = tx.query_row(
                    &format!(
                        "SELECT id FROM users WHERE {condition} AND status = 'active' AND deleted_at IS NULL \
                         ORDER BY id ASC LIMIT 1"
                    ),
                    [],
                    |row| row.get(0),
                )?;
                tx.execute(
                    "UPDATE users SET username = ?2, email = ?3, nickname = ?2, password_hash = ?4, role = ?5, \
                     status = 'active', last_login_at = NULL, last_login_ip = '', total_creations = 0, \
                     used_quota = 0, updated_at = ?6 WHERE id = ?1",
                    params![id, username, email, password_hash, role, kition_core::now_millis()],
                )?;
                let model = models::insert(
                    &tx,
                    AiModel {
                        id: 0,
                        user_id: id,
                        name: format!("{username}_text_model"),
                        provider: "openai".to_owned(),
                        model_name: "gpt-e2e-deterministic".to_owned(),
                        api_key: "e2e-api-key".to_owned(),
                        base_url: String::new(),
                        is_default: true,
                        is_active: true,
                        is_system_builtin: false,
                        description: "Deterministic seeded model for desktop validation".to_owned(),
                        capabilities: json!(["text"]),
                        created_at: 0,
                        updated_at: 0,
                    },
                )?;
                accounts.insert(
                    key.to_owned(),
                    json!({ "username": username, "password": E2E_PASSWORD, "role": role }),
                );
                model_ids.insert(format!("{key}_model_id"), Value::from(model.id));
            }
            tx.commit()?;
            Ok(json!({
                "users": accounts,
                "artifacts": { "normal_model_id": model_ids.get("normal_model_id").cloned().unwrap_or(Value::Null) },
            }))
        })
        .await
        .map_err(failed)?;
    if let Some(dir) = &deps.workspace_dir {
        let _ = std::fs::remove_file(dir.join("workflow.json"));
        let _ = std::fs::remove_file(dir.join("workflow_runs.json"));
    }
    Ok(ok(seeded))
}
