//! The document pane: its guidance, the open data document, and
//! `document_write`.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;

use super::{ToolFactory, offer, ready};
use crate::prompts;
use crate::run::Run;

const PANE: &str = "document";

pub struct DocumentProvider {
    factory: ToolFactory,
    data_document: String,
}

impl DocumentProvider {
    pub async fn load(run: &Arc<Run>, factory: &ToolFactory) -> Self {
        let open = run.pane == PANE
            && run.agent.tables().is_some()
            && run.active_data_document_id != 0
            && run.active_data_table_id == 0;
        let data_document = if open {
            crate::session::active_data_document(run).await
        } else {
            String::new()
        };
        Self {
            factory: factory.clone(),
            data_document,
        }
    }
}

impl Provider for DocumentProvider {
    fn id(&self) -> &str {
        PANE
    }

    fn applies(&self, scene: &TurnScene) -> bool {
        scene.pane == PANE
    }

    fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
        vec![prompts::pane(PANE).join("\n"), self.data_document.clone()]
    }

    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        ready(offer(&self.factory, ["document_write"]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::testing::{factory, fixture, names, scene};

    #[tokio::test]
    async fn offers_document_write_in_the_document_pane_only() {
        let run = Arc::new(fixture(PANE).run);
        let provider = DocumentProvider::load(&run, &factory()).await;
        let scene = scene(&run);
        assert!(provider.applies(&scene));
        assert_eq!(names(&provider, &scene).await, ["document_write"]);
        assert!(provider.prompt(&scene)[0].contains("Kition document pane"));
        let table = TurnScene {
            pane: "table".into(),
            ..scene
        };
        assert!(!provider.applies(&table));
    }
}
