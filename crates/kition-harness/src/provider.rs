//! The provider seam. Every pane and kit contributes to a turn through one
//! interface: prompt sections and tools. The driver never names a pane or a
//! kit (Kit Standard section 2, the capability seam model).

use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::Value;

use crate::tool::{ToolDef, ToolRegistry};

/// What the person has in front of them when the turn starts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnScene {
    /// The pane id, such as `document`, `table`, `whiteboard`, or a kit id.
    pub pane: String,
    /// The workspace-relative path of the open file, if any.
    pub active_path: String,
    /// The person's language, BCP 47.
    pub language: String,
    /// Pane-specific context, such as a whiteboard description.
    pub extra: Value,
}

pub trait Provider: Send + Sync {
    fn id(&self) -> &str;

    /// Whether the provider takes part in a turn with this scene.
    fn applies(&self, _scene: &TurnScene) -> bool {
        true
    }

    /// System prompt sections, in order.
    fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
        Vec::new()
    }

    /// Tools for this turn. Async because kit providers ask the kit.
    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// The system prompt and tools for one turn.
pub struct Assembly {
    pub system: String,
    pub tools: ToolRegistry,
}

pub async fn assemble(
    base: &str,
    providers: &[Arc<dyn Provider>],
    scene: &TurnScene,
) -> Result<Assembly, String> {
    let mut sections = vec![base.trim().to_owned()];
    let mut tools = ToolRegistry::default();
    for provider in providers.iter().filter(|provider| provider.applies(scene)) {
        sections.extend(
            provider
                .prompt(scene)
                .into_iter()
                .map(|section| section.trim().to_owned()),
        );
        for tool in provider
            .tools(scene)
            .await
            .map_err(|error| format!("{}: {error}", provider.id()))?
        {
            tools
                .register(tool)
                .map_err(|error| format!("{}: {error}", provider.id()))?;
        }
    }
    let system = sections
        .into_iter()
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(Assembly { system, tools })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::define;

    struct Fixed {
        id: &'static str,
        pane: &'static str,
        tool: &'static str,
    }

    impl Provider for Fixed {
        fn id(&self) -> &str {
            self.id
        }

        fn applies(&self, scene: &TurnScene) -> bool {
            self.pane.is_empty() || scene.pane == self.pane
        }

        fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
            vec![format!("{} rules", self.id)]
        }

        fn tools<'a>(
            &'a self,
            _scene: &'a TurnScene,
        ) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
            Box::pin(async move {
                Ok(vec![
                    define(self.tool, "test")
                        .execute(|_, _| async { Ok(Value::Null) })
                        .build()?,
                ])
            })
        }
    }

    fn scene(pane: &str) -> TurnScene {
        TurnScene {
            pane: pane.into(),
            ..TurnScene::default()
        }
    }

    #[tokio::test]
    async fn assembles_only_applicable_providers_in_order() {
        let providers: Vec<Arc<dyn Provider>> = vec![
            Arc::new(Fixed {
                id: "documents",
                pane: "",
                tool: "document_read",
            }),
            Arc::new(Fixed {
                id: "photo",
                pane: "photo",
                tool: "photo_inspect",
            }),
            Arc::new(Fixed {
                id: "tables",
                pane: "table",
                tool: "data_table_schema",
            }),
        ];
        let assembly = assemble("Base.", &providers, &scene("photo"))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(assembly.system, "Base.\n\ndocuments rules\n\nphoto rules");
        assert!(assembly.tools.get("photo_inspect").is_some());
        assert!(assembly.tools.get("data_table_schema").is_none());
    }

    #[tokio::test]
    async fn duplicate_tools_name_the_provider() {
        let providers: Vec<Arc<dyn Provider>> = vec![
            Arc::new(Fixed {
                id: "a",
                pane: "",
                tool: "same",
            }),
            Arc::new(Fixed {
                id: "b",
                pane: "",
                tool: "same",
            }),
        ];
        let error = assemble("", &providers, &scene(""))
            .await
            .err()
            .unwrap_or_default();
        assert!(error.starts_with("b:"), "{error}");
    }
}
