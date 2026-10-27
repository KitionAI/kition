//! The document pane: its guidance and `document_write`.

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;

use super::{ToolFactory, offer, ready};
use crate::prompts;

const PANE: &str = "document";

pub struct DocumentProvider {
    factory: ToolFactory,
}

impl DocumentProvider {
    pub fn new(factory: &ToolFactory) -> Self {
        Self {
            factory: factory.clone(),
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
        vec![prompts::pane(PANE).join("\n")]
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
        let run = fixture(PANE).run;
        let provider = DocumentProvider::new(&factory());
        let scene = scene(&run);
        assert!(provider.applies(&scene));
        assert_eq!(names(&provider, &scene).await, ["document_write"]);
        assert!(provider.prompt(&scene)[0].contains("Kition document pane"));
        let workflow = TurnScene {
            pane: "workflow".into(),
            ..scene
        };
        assert!(!provider.applies(&workflow));
    }
}
