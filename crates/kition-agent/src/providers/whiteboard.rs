//! The whiteboard pane: its guidance, the attached board context, and
//! `whiteboard_propose_patch` while a board is attached.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;
use serde_json::Value;

use super::{ToolFactory, ToolShape, offer_shaped, ready};
use crate::prompts;
use crate::run::Run;
use crate::tools::canvas;

const PANE: &str = "whiteboard";

pub struct WhiteboardProvider {
    context: Option<Value>,
    factory: ToolFactory,
}

impl WhiteboardProvider {
    pub fn new(run: &Arc<Run>, factory: &ToolFactory) -> Self {
        Self {
            context: run.whiteboard.clone(),
            factory: factory.clone(),
        }
    }
}

impl Provider for WhiteboardProvider {
    fn id(&self) -> &str {
        PANE
    }

    fn applies(&self, scene: &TurnScene) -> bool {
        scene.pane == PANE
    }

    fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
        let mut sections = vec![prompts::pane(PANE).join("\n")];
        sections.extend(self.context.as_ref().map(canvas::whiteboard_prompt));
        sections
    }

    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        let names = self.context.as_ref().map(|_| "whiteboard_propose_patch");
        ready(offer_shaped(&self.factory, names, &patch_shape()))
    }
}

/// `whiteboard_propose_patch` logs a summary of the patch and presents the patch itself.
fn patch_shape() -> ToolShape {
    super::patch_shape("whiteboard.patch")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::testing::{factory, fixture, names, scene};

    #[tokio::test]
    async fn proposes_patches_only_with_a_board_attached() {
        let bare = Arc::new(fixture(PANE).run);
        let scene = scene(&bare);
        let provider = WhiteboardProvider::new(&bare, &factory());
        assert!(names(&provider, &scene).await.is_empty());
        assert_eq!(provider.prompt(&scene).len(), 1);
        let mut attached = fixture(PANE);
        attached.run.whiteboard = Some(serde_json::json!({ "type": "whiteboard.context" }));
        let provider = WhiteboardProvider::new(&Arc::new(attached.run), &factory());
        let tool = "whiteboard_propose_patch";
        assert_eq!(names(&provider, &scene).await, [tool]);
        assert!(provider.prompt(&scene)[1].starts_with("Active Kition Whiteboard context"));
    }

    fn patch() -> Value {
        serde_json::json!({
            "type": "whiteboard.patch", "schema_version": 1, "summary": "Add a child",
            "operations": [
                { "op": "element.create", "element": { "id": "n2", "kind": "mind_node", "bounds": {} } },
                { "op": "element.delete", "element_id": "n1" },
            ],
        })
    }

    #[test]
    fn the_patch_tool_logs_a_summary_and_presents_the_patch() {
        let shape = patch_shape();
        let log = shape
            .log_arguments
            .unwrap_or_else(|| panic!("no log projection"));
        assert_eq!(
            log(&patch()),
            serde_json::json!({
                "type": "whiteboard.patch", "schema_version": 1,
                "summary_chars": 11, "operation_count": 2,
            })
        );
        let present = shape
            .presentation_meta
            .unwrap_or_else(|| panic!("no presentation projection"));
        let output = serde_json::json!({ "awaiting_user_review": true, "operation_count": 2 });
        assert_eq!(
            present(&patch(), &output),
            serde_json::json!({ "kind": "whiteboard.patch", "patch": patch() })
        );
    }

    #[tokio::test]
    async fn the_offered_patch_tool_carries_its_projections() {
        let mut attached = fixture(PANE);
        attached.run.whiteboard = Some(serde_json::json!({ "type": "whiteboard.context" }));
        let run = Arc::new(attached.run);
        let provider = WhiteboardProvider::new(&run, &factory());
        let tools = provider
            .tools(&scene(&run))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
        let tool = tools.first().unwrap_or_else(|| panic!("no tool"));
        assert_eq!(tool.logged_arguments(&patch())["summary_chars"], 11);
        let cx = kition_harness::tool::ToolContext {
            session_id: "agent:1".into(),
            call_id: "call_1".into(),
            cancel: kition_harness::cancel::Cancel::default(),
            pause: kition_harness::tool::Pause::default(),
        };
        let settled = tool.run(patch(), cx).await;
        assert_eq!(
            settled.meta.map(|meta| meta["patch"].clone()),
            Some(patch())
        );
    }
}
