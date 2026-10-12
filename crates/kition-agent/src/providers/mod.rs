//! Everything a pane, the local sources, the kits, or MCP add to a turn,
//! one provider each. The turn assembles them and never names a pane or a
//! kit.

mod core;
mod design;
mod document;
mod gallery;
mod images;
mod kits;
mod mcp;
mod sources;
mod tables;
mod whiteboard;
mod workflow;

use std::sync::Arc;

use kition_ai::engine::ToolSpec;
use kition_harness::provider::Provider;
use kition_harness::tool::{ToolBuilder, ToolDef};
use serde_json::{Value, json};

use crate::catalog::SkillDef;
use crate::run::Run;

/// What the request says about this turn beyond `Run`.
#[derive(Debug, Clone, Default)]
pub struct TurnFacts {
    pub prompt_context: String,
    pub active_workflow_id: String,
    pub table_plan: Option<Value>,
    pub skills: Vec<SkillDef>,
    pub hosted_web_search: bool,
    pub hosted_images: bool,
}

/// Projects a tool's arguments to the copy written to the session log.
pub type LogArguments = Arc<dyn Fn(&Value) -> Value + Send + Sync>;

/// Projects a tool's arguments and output value to display-only data.
pub type PresentationMeta = Arc<dyn Fn(&Value, &Value) -> Value + Send + Sync>;

/// What a provider says about how one of its tools is logged and shown.
/// Unset projections keep the factory's defaults.
#[derive(Clone, Default)]
pub struct ToolShape {
    pub log_arguments: Option<LogArguments>,
    pub presentation_meta: Option<PresentationMeta>,
}

impl ToolShape {
    /// `builder` with this shape's projections; an unset log projection
    /// falls back to `default_log`.
    pub fn apply(&self, builder: ToolBuilder, default_log: Option<LogArguments>) -> ToolBuilder {
        let mut builder = builder;
        if let Some(project) = self.log_arguments.clone().or(default_log) {
            builder = builder.log_arguments(move |args| project(args));
        }
        if let Some(present) = self.presentation_meta.clone() {
            builder = builder.presentation_meta(move |args, value| present(args, value));
        }
        builder
    }
}

/// Builds one tool from a catalog or MCP spec and the providing provider's
/// shape; `None` when the harness cannot offer it (the factory logs why).
pub type ToolFactory = Arc<dyn Fn(&ToolSpec, &ToolShape) -> Option<ToolDef> + Send + Sync>;

/// Tools a provider other than `CoreProvider` offers.
pub fn owned_elsewhere(name: &str) -> bool {
    matches!(
        name,
        "document_write"
            | "image_search"
            | "table_upsert_records"
            | "whiteboard_propose_patch"
            | "design_propose_patch"
    ) || name.starts_with("data_table_")
        || crate::sources::CORE_TOOLS.contains(&name)
        || crate::sources::GIT_TOOLS.contains(&name)
        || crate::tools::kits::tool_defs()
            .iter()
            .any(|tool| tool.name == name)
}

/// The providers of one turn, in assembly order. Async because some
/// providers load their prompt state (recent images, the open table) up
/// front: `Provider::prompt` is synchronous.
pub async fn providers(
    run: &Arc<Run>,
    facts: &Arc<TurnFacts>,
    factory: &ToolFactory,
) -> Vec<Arc<dyn Provider>> {
    vec![
        Arc::new(core::CoreProvider::load(run, facts, factory).await),
        Arc::new(document::DocumentProvider::load(run, factory).await),
        Arc::new(images::ImagesProvider::new(facts, factory)),
        Arc::new(tables::TablesProvider::load(run, facts, factory).await),
        Arc::new(workflow::WorkflowProvider::new(run, facts)),
        Arc::new(gallery::GalleryProvider),
        Arc::new(whiteboard::WhiteboardProvider::new(run, factory)),
        Arc::new(design::DesignProvider::new(run, factory)),
        Arc::new(sources::LocalSourcesProvider::new(run, factory)),
        Arc::new(kits::KitsProvider::new(run, factory)),
        Arc::new(mcp::McpProvider::new(run, factory)),
    ]
}

/// The catalog spec of `name` as a model tool spec, if the catalog offers
/// it at all (`exposure` is not `hidden`).
pub fn catalog_spec(name: &str) -> Option<ToolSpec> {
    crate::catalog::tool(name)
        .filter(|tool| tool.exposure != "hidden")
        .map(|tool| ToolSpec {
            name: tool.name.clone(),
            description: tool.description.clone(),
            input_schema: tool.input_schema.clone(),
        })
}

/// The catalog tools among `names`, built by `factory`.
fn offer<'a>(factory: &ToolFactory, names: impl IntoIterator<Item = &'a str>) -> Vec<ToolDef> {
    offer_shaped(factory, names, &ToolShape::default())
}

/// The catalog tools among `names`, built by `factory` with `shape`.
fn offer_shaped<'a>(
    factory: &ToolFactory,
    names: impl IntoIterator<Item = &'a str>,
    shape: &ToolShape,
) -> Vec<ToolDef> {
    names
        .into_iter()
        .filter_map(catalog_spec)
        .filter_map(|spec| factory(&spec, shape))
        .collect()
}

/// The shape of a canvas patch tool (`whiteboard.patch`, `design.patch`):
/// the log keeps only the envelope and counts (the patch text can be long
/// and holds user content), and the result carries the proposed patch for
/// display. A successful call means the runtime accepted the patch as
/// sent, so the arguments are the validated patch.
fn patch_shape(kind: &'static str) -> ToolShape {
    ToolShape {
        log_arguments: Some(Arc::new(|input: &Value| {
            json!({
                "type": input["type"],
                "schema_version": input["schema_version"],
                "summary_chars": input["summary"].as_str().unwrap_or_default().chars().count(),
                "operation_count": input["operations"].as_array().map_or(0, Vec::len),
            })
        })),
        presentation_meta: Some(Arc::new(move |input: &Value, _value: &Value| {
            json!({
                "kind": kind,
                "patch": {
                    "type": input["type"],
                    "schema_version": input["schema_version"],
                    "summary": input["summary"],
                    "operations": input["operations"],
                },
            })
        })),
    }
}

/// A finished tool list as the provider seam's future.
fn ready<'a>(tools: Vec<ToolDef>) -> futures::future::BoxFuture<'a, Result<Vec<ToolDef>, String>> {
    Box::pin(std::future::ready(Ok(tools)))
}

#[cfg(test)]
pub(crate) mod testing {
    //! A `Run` and a tool factory for provider unit tests.

    use std::sync::{Arc, Mutex};

    use kition_ai::engine::{Engine, RuntimeModel, ToolSpec};
    use kition_harness::provider::TurnScene;
    use kition_harness::tool::define;
    use serde_json::Value;

    use super::{ToolFactory, ToolShape};
    use crate::run::{Agent, AgentConfig, Run};
    use crate::stream::Emitter;

    /// Keeps the temporary folders of a test agent alive.
    pub struct Fixture {
        pub run: Run,
        _dirs: Vec<tempfile::TempDir>,
    }

    pub fn fixture(pane: &str) -> Fixture {
        let dirs: Vec<tempfile::TempDir> = (0..3)
            .map(|_| tempfile::tempdir().unwrap_or_else(|error| panic!("{error}")))
            .collect();
        let db = kition_store::Db::open_in_memory().unwrap_or_else(|error| panic!("{error}"));
        let agent = Agent::new(AgentConfig {
            db,
            engine: Engine::new(dirs[1].path().to_path_buf(), None),
            workspace_dir: dirs[0].path().to_path_buf(),
            upload_dir: dirs[1].path().to_path_buf(),
            policy_path: Some(dirs[2].path().join("execpolicy.toml")),
            hooks: None,
            smtp: None,
            tables: None,
            portal_base_url: String::new(),
            mcp_path: None,
            workflow_prompt: None,
            kits: None,
        });
        let run = Run {
            agent,
            emitter: Emitter::channel().0,
            live: std::sync::Arc::new(|_| {}),
            user_id: 1,
            session_id: 1,
            active_document_path: String::new(),
            active_data_document_id: 0,
            active_data_table_id: 0,
            execution_mode: "apply".into(),
            task_mode: "auto".into(),
            pane: pane.into(),
            whiteboard: None,
            design: None,
            model: RuntimeModel::default(),
            prompt: "hi".into(),
            attachments: Vec::new(),
            local_sources: Vec::new(),
            approved_command: Mutex::new(None),
            language: String::new(),
            source: "user",
        };
        Fixture { run, _dirs: dirs }
    }

    /// Builds every spec as a no-op tool with its provider's shape.
    pub fn factory() -> ToolFactory {
        Arc::new(|spec: &ToolSpec, shape: &ToolShape| {
            let builder =
                define(&spec.name, &spec.description).execute(|_, _| async { Ok(Value::Null) });
            shape.apply(builder, None).build().ok()
        })
    }

    pub fn scene(run: &Run) -> TurnScene {
        TurnScene {
            pane: run.pane.clone(),
            active_path: run.active_document_path.clone(),
            language: run.language.clone(),
            extra: Value::Null,
        }
    }

    /// The names of the tools a provider offers in `scene`.
    pub async fn names(
        provider: &dyn kition_harness::provider::Provider,
        scene: &TurnScene,
    ) -> Vec<String> {
        provider
            .tools(scene)
            .await
            .unwrap_or_else(|error| panic!("{error}"))
            .iter()
            .map(|tool| tool.name.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_owned_by_a_pane_provider_are_not_core_tools() {
        for name in [
            "document_write",
            "image_search",
            "data_table_add_records",
            "data_table_create",
            "table_upsert_records",
            "whiteboard_propose_patch",
            "design_propose_patch",
            "source_read",
            "source_git_log",
        ] {
            assert!(owned_elsewhere(name), "{name}");
        }
        for tool in crate::tools::kits::tool_defs() {
            assert!(owned_elsewhere(&tool.name), "{}", tool.name);
        }
        for name in [
            "document_read",
            "web_search",
            "image_generation",
            "exec_command",
        ] {
            assert!(!owned_elsewhere(name), "{name}");
        }
    }

    #[test]
    fn catalog_specs_carry_the_catalog_schema() {
        let spec = catalog_spec("document_read").unwrap_or_default();
        assert_eq!(spec.name, "document_read");
        assert!(spec.input_schema.is_some());
        assert!(catalog_spec("no_such_tool").is_none());
    }
}
