//! The design pane: its guidance, the attached artboard context, and
//! `design_propose_patch` while an artboard is attached.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;
use serde_json::Value;

use super::{ToolFactory, offer, ready};
use crate::prompts;
use crate::run::Run;
use crate::tools::canvas;

const PANE: &str = "design";

pub struct DesignProvider {
    context: Option<Value>,
    factory: ToolFactory,
}

impl DesignProvider {
    pub fn new(run: &Arc<Run>, factory: &ToolFactory) -> Self {
        Self {
            context: run.design.clone(),
            factory: factory.clone(),
        }
    }
}

impl Provider for DesignProvider {
    fn id(&self) -> &str {
        PANE
    }

    fn applies(&self, scene: &TurnScene) -> bool {
        scene.pane == PANE
    }

    fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
        let mut sections = vec![prompts::pane(PANE).join("\n")];
        sections.extend(self.context.as_ref().map(canvas::design_prompt));
        sections
    }

    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        let names = self.context.as_ref().map(|_| "design_propose_patch");
        ready(offer(&self.factory, names))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::testing::{factory, fixture, names, scene};

    #[tokio::test]
    async fn proposes_patches_only_with_an_artboard_attached() {
        let bare = Arc::new(fixture(PANE).run);
        let scene = scene(&bare);
        let provider = DesignProvider::new(&bare, &factory());
        assert!(names(&provider, &scene).await.is_empty());
        assert_eq!(provider.prompt(&scene).len(), 1);
        let mut attached = fixture(PANE);
        attached.run.design = Some(serde_json::json!({ "type": "design.context" }));
        let provider = DesignProvider::new(&Arc::new(attached.run), &factory());
        let tool = "design_propose_patch";
        assert_eq!(names(&provider, &scene).await, [tool]);
        assert!(provider.prompt(&scene)[1].starts_with("Active Kition design context"));
    }
}
