//! The design pane: its guidance, the attached artboard context, and
//! `design_propose_patch` while an artboard is attached.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;
use serde_json::Value;

use super::{ToolFactory, ToolShape, offer_shaped, ready};
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
        ready(offer_shaped(&self.factory, names, &patch_shape()))
    }
}

/// `design_propose_patch` logs a summary of the patch and presents the patch itself.
fn patch_shape() -> ToolShape {
    super::patch_shape("design.patch")
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

    #[test]
    fn the_patch_tool_logs_a_summary_and_presents_the_patch() {
        let patch = serde_json::json!({
            "type": "design.patch", "schema_version": 1, "summary": "Retitle",
            "operations": [{ "op": "text.set", "layer_id": "t1", "text": "Hi" }],
        });
        let shape = patch_shape();
        let log = shape
            .log_arguments
            .unwrap_or_else(|| panic!("no log projection"));
        assert_eq!(
            log(&patch),
            serde_json::json!({
                "type": "design.patch", "schema_version": 1,
                "summary_chars": 7, "operation_count": 1,
            })
        );
        let present = shape
            .presentation_meta
            .unwrap_or_else(|| panic!("no presentation projection"));
        assert_eq!(
            present(&patch, &Value::Null),
            serde_json::json!({ "kind": "design.patch", "patch": patch })
        );
    }
}
