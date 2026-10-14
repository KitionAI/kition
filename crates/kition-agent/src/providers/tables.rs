//! Data tables: the open table, the table execution rules, a reused table
//! plan, the data-table guidance, the table pane, and the data-table tools.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;

use super::{ToolFactory, TurnFacts, catalog_spec, offer, ready};
use crate::run::Run;
use crate::tools::tables;
use crate::{catalog, prompts};

const PANE: &str = "table";

/// The data-table tools the catalog offers.
fn tool_names() -> Vec<&'static str> {
    catalog::tools()
        .iter()
        .map(|tool| tool.name.as_str())
        .filter(|name| name.starts_with("data_table_") || *name == "table_upsert_records")
        .filter(|name| catalog_spec(name).is_some())
        .collect()
}

/// The data table the user has open, as a prompt block; empty without
/// table support or an open table.
async fn active_table_context(run: &Run) -> String {
    let Some(state) = run.agent.tables().cloned() else {
        return String::new();
    };
    let context = tables::TableContext {
        user_id: run.user_id,
        active_document_path: run.active_document_path.clone(),
        document_id: run.active_data_document_id,
        table_id: run.active_data_table_id,
        origin: tables::run_origin(run.session_id),
    };
    tokio::task::spawn_blocking(move || tables::active_table_context(&state, &context))
        .await
        .unwrap_or_default()
}

pub struct TablesProvider {
    run: Arc<Run>,
    facts: Arc<TurnFacts>,
    factory: ToolFactory,
    table_context: String,
}

impl TablesProvider {
    pub async fn load(run: &Arc<Run>, facts: &Arc<TurnFacts>, factory: &ToolFactory) -> Self {
        Self {
            run: run.clone(),
            facts: facts.clone(),
            factory: factory.clone(),
            table_context: active_table_context(run).await,
        }
    }
}

impl Provider for TablesProvider {
    fn id(&self) -> &str {
        "tables"
    }

    fn prompt(&self, scene: &TurnScene) -> Vec<String> {
        let mut sections = vec![self.table_context.clone()];
        if self.run.active_data_table_id != 0 {
            sections.push(prompts::table_execution(&self.run.execution_mode));
        }
        if let Some(plan) = &self.facts.table_plan {
            sections.push(prompts::table_plan(plan));
        }
        if tool_names()
            .iter()
            .any(|name| *name == "data_table_add_records" || *name == "table_upsert_records")
        {
            sections.push(prompts::table_lines().join("\n"));
        }
        if scene.pane == PANE {
            sections.push(prompts::pane(PANE).join("\n"));
        }
        sections
    }

    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        ready(offer(&self.factory, tool_names()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::testing::{factory, fixture, names, scene};

    #[tokio::test]
    async fn offers_the_data_table_tools_with_their_guidance() {
        let mut fixture = fixture(PANE);
        fixture.run.active_data_table_id = 2;
        let run = Arc::new(fixture.run);
        let facts = Arc::new(TurnFacts {
            table_plan: Some(serde_json::json!({ "summary": "Import" })),
            ..TurnFacts::default()
        });
        let provider = TablesProvider::load(&run, &facts, &factory()).await;
        let scene = scene(&run);
        let offered = names(&provider, &scene).await;
        assert!(offered.contains(&"data_table_add_records".to_owned()));
        assert!(offered.contains(&"table_upsert_records".to_owned()));
        let prompt = provider.prompt(&scene).join("\n\n");
        assert!(prompt.contains(prompts::table_lines()[0]));
        assert!(prompt.contains(&prompts::table_execution("apply")));
        assert!(prompt.contains("Import"));
        assert!(prompt.contains("Kition table pane"));
        let document = TurnScene {
            pane: "document".into(),
            ..scene
        };
        assert!(
            !provider
                .prompt(&document)
                .join("\n")
                .contains("Kition table pane")
        );
    }
}
