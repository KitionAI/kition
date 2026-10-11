//! The tools of the connected MCP servers.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;

use super::ToolFactory;
use crate::run::Run;

pub struct McpProvider {
    run: Arc<Run>,
    factory: ToolFactory,
}

impl McpProvider {
    pub fn new(run: &Arc<Run>, factory: &ToolFactory) -> Self {
        Self {
            run: run.clone(),
            factory: factory.clone(),
        }
    }
}

impl Provider for McpProvider {
    fn id(&self) -> &str {
        "mcp"
    }

    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        Box::pin(async move {
            Ok(self
                .run
                .agent
                .mcp()
                .tools()
                .await
                .iter()
                .filter_map(|tool| (self.factory)(&tool.model_spec()))
                .collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::ToolInfo;
    use crate::providers::testing::{factory, fixture, names, scene};

    #[tokio::test]
    async fn offers_nothing_without_servers() {
        let run = Arc::new(fixture("document").run);
        assert!(
            names(&McpProvider::new(&run, &factory()), &scene(&run))
                .await
                .is_empty()
        );
    }

    #[test]
    fn names_the_server_in_the_description() {
        let tool = ToolInfo {
            server: "files".into(),
            tool: "list".into(),
            qualified: "mcp__files__list".into(),
            title: String::new(),
            description: " Lists files. ".into(),
            input_schema: None,
        };
        assert_eq!(tool.model_spec().description, "[MCP files] Lists files.");
        let bare = ToolInfo {
            description: String::new(),
            ..tool
        };
        assert_eq!(
            bare.model_spec().description,
            "External MCP tool from files"
        );
    }
}
