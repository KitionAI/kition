//! The tools of every kit installed in this runtime. A kit's linked-file
//! guidance stays in `prompts::linked_document`, which `CoreProvider` sends.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;

use super::{ToolFactory, offer, ready};
use crate::run::Run;
use crate::tools::kits;

pub struct KitsProvider {
    run: Arc<Run>,
    factory: ToolFactory,
}

impl KitsProvider {
    pub fn new(run: &Arc<Run>, factory: &ToolFactory) -> Self {
        Self {
            run: run.clone(),
            factory: factory.clone(),
        }
    }
}

impl Provider for KitsProvider {
    fn id(&self) -> &str {
        "kits"
    }

    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        let unavailable = kits::unavailable(&self.run);
        let defs = kits::tool_defs();
        let names = defs
            .iter()
            .map(|tool| tool.name.as_str())
            .filter(|name| !unavailable.iter().any(|missing| missing == name));
        ready(offer(&self.factory, names))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::testing::{factory, fixture, names, scene};

    #[tokio::test]
    async fn offers_no_kit_tools_without_installed_kits() {
        let run = Arc::new(fixture("document").run);
        let provider = KitsProvider::new(&run, &factory());
        assert!(names(&provider, &scene(&run)).await.is_empty());
        assert!(provider.prompt(&scene(&run)).is_empty());
    }
}
