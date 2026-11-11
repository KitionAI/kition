//! Builds the workspace agent and the hooks it needs from other features:
//! desktop hooks.

use std::sync::Arc;

use kition_agent::{Agent, AgentConfig, HookDispatch};

use crate::app::Deps;

pub fn build(deps: &Deps) -> Agent {
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
    let agent = Agent::new(AgentConfig {
        db: deps.db.clone(),
        engine: deps.ai.clone(),
        workspace_dir: deps.workspace_dir.clone().unwrap_or_default(),
        upload_dir: deps.upload_dir.clone(),
        policy_path: kition_agent::execpolicy::default_path(),
        hooks: Some(hooks),
        portal_base_url: deps.config.portal_base_url.clone(),
        mcp_path: kition_agent::mcp::default_path(),
        kits: Some(deps.kits.clone()),
    });
    let background = agent.clone();
    tokio::spawn(async move {
        if let Err(error) = background.mcp().reload().await {
            tracing::warn!(error = %error, "failed to load MCP servers");
        }
    });
    agent
}
