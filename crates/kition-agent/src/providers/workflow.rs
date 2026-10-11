//! The workflow pane: its guidance and the open workflow.

use std::sync::Arc;

use kition_harness::provider::{Provider, TurnScene};

use super::TurnFacts;
use crate::prompts;
use crate::run::Run;

const PANE: &str = "workflow";

pub struct WorkflowProvider {
    run: Arc<Run>,
    facts: Arc<TurnFacts>,
}

impl WorkflowProvider {
    pub fn new(run: &Arc<Run>, facts: &Arc<TurnFacts>) -> Self {
        Self {
            run: run.clone(),
            facts: facts.clone(),
        }
    }
}

impl Provider for WorkflowProvider {
    fn id(&self) -> &str {
        PANE
    }

    fn applies(&self, scene: &TurnScene) -> bool {
        scene.pane == PANE
    }

    fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
        let mut sections = vec![prompts::pane(PANE).join("\n")];
        let id = self.facts.active_workflow_id.trim();
        if !id.is_empty() {
            sections.push(self.run.agent.workflow_prompt(id));
        }
        sections
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::testing::{fixture, scene};

    #[test]
    fn guides_the_workflow_pane_only() {
        let run = Arc::new(fixture(PANE).run);
        let facts = Arc::new(TurnFacts {
            active_workflow_id: "wf-1".into(),
            ..TurnFacts::default()
        });
        let provider = WorkflowProvider::new(&run, &facts);
        let scene = scene(&run);
        assert!(provider.applies(&scene));
        assert!(provider.prompt(&scene)[0].contains("Kition workflow pane"));
        assert!(!provider.applies(&TurnScene::default()));
    }
}
