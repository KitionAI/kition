//! The media gallery pane: its guidance.

use kition_harness::provider::{Provider, TurnScene};

use crate::prompts;

const PANE: &str = "gallery";

pub struct GalleryProvider;

impl Provider for GalleryProvider {
    fn id(&self) -> &str {
        PANE
    }

    fn applies(&self, scene: &TurnScene) -> bool {
        scene.pane == PANE
    }

    fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
        vec![prompts::pane(PANE).join("\n")]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guides_the_gallery_pane_only() {
        let gallery = TurnScene {
            pane: PANE.into(),
            ..TurnScene::default()
        };
        assert!(GalleryProvider.applies(&gallery));
        assert!(!GalleryProvider.applies(&TurnScene::default()));
        assert!(GalleryProvider.prompt(&gallery)[0].contains("media gallery pane"));
    }
}
