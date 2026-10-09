//! Builds the workspace agent and the hooks it needs from other features:
//! desktop hooks, SMTP connections, data tables, and open workflows.

use std::collections::HashMap;
use std::sync::Arc;

use kition_agent::{Agent, AgentConfig, HookDispatch, SmtpConfigurator, WorkflowPrompt};
use kition_connections::store::{CHANNEL_EMAIL_SMTP, UpsertInput};
use kition_connections::{SecretBag, Store};
use kition_workflow::store::{ActionPatch, WorkflowPatch};
use kition_workflow::types::WorkflowDefinition;
use serde_json::{Map, Value, json};

use crate::app::Deps;

fn truncate(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}...")
    } else {
        head
    }
}

fn render(template: &kition_workflow::types::BodyTemplate) -> String {
    kition_workflow::template::render(template, &HashMap::new()).0
}

/// The prompt block for the workflow the user has open.
pub fn describe_workflow(def: &WorkflowDefinition) -> String {
    let mut lines = vec![
        "Active workflow the user is editing (pane = workflow):".to_owned(),
        format!("- ID: {}", def.id),
    ];
    let mut push = |label: &str, value: &str| {
        if !value.trim().is_empty() {
            lines.push(format!("- {label}: {}", value.trim()));
        }
    };
    push("Name", &def.name);
    push("Description", &truncate(def.description.trim(), 240));
    push("Enabled", if def.enabled { "yes" } else { "no (draft)" });
    let trigger = &def.trigger;
    push(
        "Trigger type",
        if trigger.trigger_type.trim().is_empty() {
            "(unset)"
        } else {
            &trigger.trigger_type
        },
    );
    push(
        "Trigger table id",
        if trigger.table_id.trim().is_empty() {
            "(unbound)"
        } else {
            &trigger.table_id
        },
    );
    if let Some(schedule) = &trigger.schedule {
        push("Trigger schedule cron", &schedule.cron);
        push("Trigger schedule timezone", &schedule.timezone);
    }
    if let Some(date) = &trigger.date_field {
        push("Trigger date field id", &date.field_id);
        push("Trigger date field time", &date.at_time);
    }
    let required: Vec<&str> = trigger
        .required_fields
        .iter()
        .map(|f| f.trim())
        .filter(|f| !f.is_empty())
        .collect();
    if !required.is_empty() {
        push("Trigger required fields", &required.join(", "));
    }
    let action = &def.action;
    push("Action type", &action.action_type);
    push("Action connection id", &action.connection_id);
    match action.action_type.as_str() {
        "send_email" => {
            push("Action recipient", &action.to);
            push(
                "Action subject template",
                &truncate(&render(&action.subject), 160),
            );
            push(
                "Action body template",
                &truncate(&render(&action.body), 320),
            );
        }
        "send_notification" => {
            push("Action notification title", &truncate(&action.title, 160));
            push(
                "Action body template",
                &truncate(&render(&action.body), 320),
            );
        }
        "add_record" => {
            if let Some(add) = &action.add_record {
                push("Action target table id", &add.target_table_id);
                push("Action target document id", &add.target_document_id);
                for assignment in add.fields.iter().take(8) {
                    if !assignment.field_id.trim().is_empty() {
                        lines.push(format!(
                            "- Action field assignment: {} \u{2190} {}",
                            assignment.field_id.trim(),
                            truncate(&render(&assignment.value), 120)
                        ));
                    }
                }
                if add.fields.len() > 8 {
                    lines.push(format!(
                        "- Action field assignments truncated ({} more not shown)",
                        add.fields.len() - 8
                    ));
                }
            }
        }
        _ => {}
    }
    lines.push("Use this context to anchor suggestions on the actual trigger / action / bound table instead of asking the user to repeat their workflow setup.".into());
    lines.join("\n")
}

fn text(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// `configure_smtp_connection`: saves (and tests) an SMTP connection and
/// optionally attaches it to a workflow.
async fn configure_smtp(
    store: Store,
    workflows: Arc<kition_workflow::store::Store>,
    user_id: i64,
    input: Value,
) -> Result<(String, Value), String> {
    let name = text(&input, "name");
    let host = text(&input, "host");
    let username = text(&input, "username");
    let password = text(&input, "password");
    let from = text(&input, "from");
    let existing_id = text(&input, "existingConnectionId");
    let workflow_id = text(&input, "workflowId");
    let port = input
        .get("port")
        .and_then(Value::as_i64)
        .filter(|p| *p > 0)
        .unwrap_or(587);
    let tls = match text(&input, "tlsMode") {
        mode if mode.is_empty() => "starttls".to_owned(),
        mode => mode,
    };
    if name.is_empty() || host.is_empty() || from.is_empty() || username.is_empty() {
        return Err("name, host, username and from are required".into());
    }
    if existing_id.is_empty() && password.is_empty() {
        return Err("password is required when creating a new connection".into());
    }
    let mut settings = Map::new();
    settings.insert("host".into(), json!(host));
    settings.insert("port".into(), json!(port));
    settings.insert("username".into(), json!(username));
    settings.insert("tlsMode".into(), json!(tls));
    settings.insert("from".into(), json!(from));
    settings.insert("fromName".into(), json!(text(&input, "fromName")));
    let mut secrets = SecretBag::new();
    if !password.is_empty() {
        secrets.insert("password".into(), password);
    }
    let conn = store.db.conn().map_err(|e| e.to_string())?;
    let mut validate_secrets = secrets.clone();
    if validate_secrets.is_empty()
        && !existing_id.is_empty()
        && let Some(existing) = store
            .get(&conn, user_id, &existing_id)
            .map_err(|e| e.to_string())?
    {
        validate_secrets = store.open_secrets(&existing).unwrap_or_default();
    }
    kition_connections::channel::validate(&settings, &validate_secrets)?;
    let mut row = if existing_id.is_empty() {
        store.create(
            &conn,
            user_id,
            UpsertInput {
                channel: CHANNEL_EMAIL_SMTP.into(),
                name: name.clone(),
                settings: Some(settings),
                secrets,
            },
        )?
    } else {
        store
            .update(
                &conn,
                user_id,
                &existing_id,
                UpsertInput {
                    channel: String::new(),
                    name: name.clone(),
                    settings: Some(settings),
                    secrets,
                },
            )?
            .ok_or_else(|| format!("connection {existing_id:?} not found"))?
    };
    drop(conn);
    let bag = match store.open_secrets(&row) {
        Ok(bag) => bag,
        Err(error) => {
            if existing_id.is_empty()
                && let Ok(conn) = store.db.conn()
            {
                let _ = store.delete(&conn, user_id, &row.id);
            }
            return Err(error);
        }
    };
    let result = kition_connections::channel::test(&row, &bag).await;
    let conn = store.db.conn().map_err(|e| e.to_string())?;
    if !result.ok {
        let reason = if result.message.trim().is_empty() {
            result.error_code.clone()
        } else {
            result.message.clone()
        };
        if existing_id.is_empty() {
            let _ = store.delete(&conn, user_id, &row.id);
            return Err(format!("SMTP test failed: {}", reason.trim()));
        }
        let _ = store.mark_test_result(&conn, &mut row, &result);
        return Err(format!("SMTP test failed after update: {}", reason.trim()));
    }
    let _ = store.mark_test_result(&conn, &mut row, &result);
    let view = row.view(0);
    let mut output = json!({
        "id": view.id, "name": view.name, "channel": view.channel,
        "status": view.status, "settings": view.settings,
    });
    let mut summary = format!(
        "SMTP connection {:?} saved (id={}, host={host}:{port}, from={from}, tls={tls}). Status: {}.",
        view.name, view.id, view.status
    );
    if !workflow_id.is_empty() {
        let patch = WorkflowPatch {
            action: Some(ActionPatch {
                connection_id: Some(view.id.clone()),
                ..ActionPatch::default()
            }),
            ..WorkflowPatch::default()
        };
        match workflows.update(&workflow_id, patch) {
            Ok(def) => {
                summary.push_str(&format!(
                    " Attached to workflow {:?} (action.connectionId={}).",
                    def.name, view.id
                ));
                output["workflow_id"] = json!(def.id);
                output["workflow_attached"] = json!(true);
            }
            Err(error) => {
                let reason = match error {
                    kition_workflow::store::UpdateError::NotFound => {
                        "workflow not found".to_owned()
                    }
                    kition_workflow::store::UpdateError::Invalid(reason)
                    | kition_workflow::store::UpdateError::Write(reason) => reason,
                };
                summary.push_str(&format!(" (workflow_attach_failed: {reason})"));
                output["workflow_attach_error"] = json!(reason);
            }
        }
    }
    Ok((summary, output))
}

pub fn build(
    deps: &Deps,
    tables: Option<kition_datadoc::DataDocState>,
    workflows: Arc<kition_workflow::store::Store>,
) -> Agent {
    let runner = deps.hook_runner();
    let hooks: HookDispatch = Arc::new(move |user_id, name, tool_name, stage, _status| {
        runner.dispatch(
            user_id,
            kition_desktop::HookEvent {
                name: name.to_owned(),
                tool_name: tool_name.to_owned(),
                stage: stage.to_owned(),
            },
        );
    });
    let store = deps.connections.clone();
    let smtp_workflows = workflows.clone();
    let smtp: SmtpConfigurator = Arc::new(move |user_id, input| {
        let (store, workflows) = (store.clone(), smtp_workflows.clone());
        Box::pin(configure_smtp(store, workflows, user_id, input))
    });
    let workflow_prompt: WorkflowPrompt =
        Arc::new(move |id| workflows.get(id).map(|def| describe_workflow(&def)));
    let agent = Agent::new(AgentConfig {
        db: deps.db.clone(),
        engine: deps.ai.clone(),
        workspace_dir: deps.workspace_dir.clone().unwrap_or_default(),
        upload_dir: deps.upload_dir.clone(),
        policy_path: kition_agent::execpolicy::default_path(),
        hooks: Some(hooks),
        smtp: Some(smtp),
        tables,
        portal_base_url: deps.config.portal_base_url.clone(),
        mcp_path: kition_agent::mcp::default_path(),
        workflow_prompt: Some(workflow_prompt),
    });
    let background = agent.clone();
    tokio::spawn(async move {
        if let Err(error) = background.mcp().reload().await {
            tracing::warn!(error = %error, "failed to load MCP servers");
        }
    });
    agent
}
