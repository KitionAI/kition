//! The tools of the connected MCP servers.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_ai::engine::ToolSpec;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;

use super::ToolFactory;
use crate::run::Run;

/// The specs with each name once, the first listing kept: a server that
/// lists a tool twice (or repeats a page) must not fail the turn on the
/// registry's duplicate check.
fn unique(specs: Vec<ToolSpec>) -> Vec<ToolSpec> {
    let mut seen = std::collections::HashSet::new();
    specs
        .into_iter()
        .filter(|spec| {
            let first = seen.insert(spec.name.clone());
            if !first {
                tracing::warn!(tool = %spec.name, "MCP tool listed more than once; offering the first");
            }
            first
        })
        .collect()
}

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
            let specs = self.run.agent.mcp().tools().await;
            Ok(unique(specs.iter().map(|tool| tool.model_spec()).collect())
                .iter()
                .filter_map(|spec| (self.factory)(spec))
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
    fn a_tool_listed_twice_is_offered_once() {
        let spec = |description: &str| ToolSpec {
            name: "mcp__files__list".into(),
            description: description.into(),
            input_schema: None,
        };
        let other = ToolSpec {
            name: "mcp__files__read".into(),
            ..spec("other")
        };
        let kept = unique(vec![spec("first"), other.clone(), spec("second")]);
        assert_eq!(kept, vec![spec("first"), other]);
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
