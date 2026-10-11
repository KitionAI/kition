//! The parts of every turn: the linked file, attachments, recent images,
//! skills, the task and execution modes, the general tool guidance, the
//! client's prompt context, and every catalog tool no other provider owns.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;

use super::{ToolFactory, TurnFacts, offer, owned_elsewhere, ready};
use crate::run::Run;
use crate::store::{self, AgentArtifact};
use crate::{attachments, catalog, prompts};

pub struct CoreProvider {
    run: Arc<Run>,
    facts: Arc<TurnFacts>,
    factory: ToolFactory,
    recent_images: String,
}

/// The session's last eight saved images, oldest first.
async fn recent_images(run: &Run) -> Vec<AgentArtifact> {
    let (id, user) = (run.session_id, run.user_id);
    let mut images: Vec<AgentArtifact> = run
        .agent
        .with_db(move |conn| store::recent_artifacts(conn, id, user, 40))
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.kind == "image" || a.mime_type.starts_with("image/"))
        .take(8)
        .collect();
    images.reverse();
    images
}

/// Whether `CoreProvider` offers the catalog tool `name` for this model.
fn offers(name: &str, facts: &TurnFacts) -> bool {
    !owned_elsewhere(name)
        && (name != "web_search" || facts.hosted_web_search)
        && (name != "image_generation" || facts.hosted_images)
}

impl CoreProvider {
    pub async fn load(run: &Arc<Run>, facts: &Arc<TurnFacts>, factory: &ToolFactory) -> Self {
        Self {
            run: run.clone(),
            facts: facts.clone(),
            factory: factory.clone(),
            recent_images: prompts::recent_images(&recent_images(run).await),
        }
    }
}

impl Provider for CoreProvider {
    fn id(&self) -> &str {
        "core"
    }

    fn prompt(&self, scene: &TurnScene) -> Vec<String> {
        let run = &self.run;
        let mut sections = Vec::new();
        if !scene.active_path.is_empty() {
            sections.push(prompts::linked_document(&scene.active_path));
        }
        sections.push(attachments::prompt_block(&run.attachments));
        sections.push(self.recent_images.clone());
        sections.push(catalog::skill_prompt(&self.facts.skills));
        sections.push(prompts::task_mode(&run.task_mode).to_owned());
        sections.push(prompts::WEB_RESEARCH.to_owned());
        sections.push(prompts::execution_mode(&run.execution_mode).to_owned());
        sections.push(prompts::general_lines().join("\n"));
        sections.push(self.facts.prompt_context.trim().to_owned());
        sections
    }

    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        let names = catalog::tools()
            .iter()
            .map(|tool| tool.name.as_str())
            .filter(|name| offers(name, &self.facts));
        ready(offer(&self.factory, names))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::testing::{factory, fixture, names, scene};

    #[tokio::test]
    async fn offers_hosted_tools_only_when_the_model_has_them() {
        let fixture = fixture("document");
        let run = Arc::new(fixture.run);
        let scene = scene(&run);
        let plain = CoreProvider::load(&run, &Arc::new(TurnFacts::default()), &factory()).await;
        let offered = names(&plain, &scene).await;
        assert!(offered.contains(&"document_read".to_owned()));
        assert!(!offered.contains(&"web_search".to_owned()));
        assert!(!offered.contains(&"image_generation".to_owned()));
        assert!(
            !offered.iter().any(|name| owned_elsewhere(name)),
            "{offered:?}"
        );
        let hosted = Arc::new(TurnFacts {
            hosted_web_search: true,
            hosted_images: true,
            ..TurnFacts::default()
        });
        let offered = names(&CoreProvider::load(&run, &hosted, &factory()).await, &scene).await;
        assert!(offered.contains(&"web_search".to_owned()));
        assert!(offered.contains(&"image_generation".to_owned()));
    }

    #[tokio::test]
    async fn links_the_open_file_and_carries_the_prompt_context() {
        let mut fixture = fixture("document");
        fixture.run.active_document_path = "Notes/a.md".into();
        let run = Arc::new(fixture.run);
        let facts = Arc::new(TurnFacts {
            prompt_context: "  From the client.  ".into(),
            ..TurnFacts::default()
        });
        let provider = CoreProvider::load(&run, &facts, &factory()).await;
        let prompt = provider.prompt(&scene(&run));
        assert_eq!(prompt[0], prompts::linked_document("Notes/a.md"));
        assert_eq!(prompt.last().map(String::as_str), Some("From the client."));
        assert!(!prompt.join("\n").contains("Available tools:"));
    }
}
