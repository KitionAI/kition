//! The whiteboard pane: its guidance, the attached board context, and
//! `whiteboard_propose_patch` while a board is attached.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;
use serde_json::Value;

use super::{ToolFactory, offer, ready};
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
        ready(offer(&self.factory, names))
    }
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
}
