//! `image_search`, the image tool for models without hosted image
//! generation, offered everywhere but the gallery pane.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_harness::provider::{Provider, TurnScene};
use kition_harness::tool::ToolDef;

use super::{ToolFactory, TurnFacts, offer, ready};

pub struct ImagesProvider {
    facts: Arc<TurnFacts>,
    factory: ToolFactory,
}

impl ImagesProvider {
    pub fn new(facts: &Arc<TurnFacts>, factory: &ToolFactory) -> Self {
        Self {
            facts: facts.clone(),
            factory: factory.clone(),
        }
    }
}

impl Provider for ImagesProvider {
    fn id(&self) -> &str {
        "images"
    }

    fn applies(&self, scene: &TurnScene) -> bool {
        scene.pane != "gallery" && !self.facts.hosted_images
    }

    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        ready(offer(&self.factory, ["image_search"]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::testing::factory;

    fn scene(pane: &str) -> TurnScene {
        TurnScene {
            pane: pane.into(),
            ..TurnScene::default()
        }
    }

    #[tokio::test]
    async fn image_search_stands_in_for_hosted_images_outside_the_gallery() {
        let plain = ImagesProvider::new(&Arc::new(TurnFacts::default()), &factory());
        assert!(plain.applies(&scene("document")));
        assert!(!plain.applies(&scene("gallery")));
        let tools = plain.tools(&scene("document")).await.unwrap_or_default();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "image_search");
        let hosted = ImagesProvider::new(
            &Arc::new(TurnFacts {
                hosted_images: true,
                ..TurnFacts::default()
            }),
            &factory(),
        );
        assert!(!hosted.applies(&scene("document")));
    }
}
