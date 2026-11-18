//! Read-only local analysis folders: their prompt block and the `source_*`
//! tools, with the Git tools when a folder is a repository.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;

use super::{ToolFactory, offer, ready};
use crate::run::Run;
use crate::sources;

pub struct LocalSourcesProvider {
    run: Arc<Run>,
    factory: ToolFactory,
}

impl LocalSourcesProvider {
    pub fn new(run: &Arc<Run>, factory: &ToolFactory) -> Self {
        Self {
            run: run.clone(),
            factory: factory.clone(),
        }
    }
}

impl Provider for LocalSourcesProvider {
    fn id(&self) -> &str {
        "local_sources"
    }

    fn applies(&self, _scene: &TurnScene) -> bool {
        !self.run.local_sources.is_empty()
    }

    fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
        vec![sources::prompt_context(&self.run.local_sources)]
    }

    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        ready(offer(
            &self.factory,
            sources::tool_names(&self.run.local_sources),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::testing::{factory, fixture, names, scene};

    #[tokio::test]
    async fn offers_the_source_tools_while_a_folder_is_attached() {
        let bare = Arc::new(fixture("document").run);
        assert!(!LocalSourcesProvider::new(&bare, &factory()).applies(&scene(&bare)));
        let folder = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let mut attached = fixture("document");
        attached.run.local_sources = vec![sources::LocalSource {
            id: "notes".into(),
            label: "Notes".into(),
            root: folder.path().to_path_buf(),
            git: false,
        }];
        let run = Arc::new(attached.run);
        let provider = LocalSourcesProvider::new(&run, &factory());
        let scene = scene(&run);
        assert!(provider.applies(&scene));
        assert_eq!(
            names(&provider, &scene).await.len(),
            sources::CORE_TOOLS.len()
        );
        assert!(provider.prompt(&scene)[0].contains("`notes` (Notes; read-only source)"));
    }
}
