//! Tools in the DeepSeek Harness `defineTool` shape (KHP A1): a name,
//! a description, a parameter schema, a canonical output schema with a pure
//! render, an optional pure presentation projection, and the body.

use std::collections::BTreeMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use kition_ai::engine::ToolSpec;
use serde_json::{Value, json};

use crate::cancel::Cancel;
use crate::events::{ContentBlock, EventBody};
use crate::schema;

/// What a tool body knows about its call.
#[derive(Debug)]
pub struct ToolContext {
    pub session_id: String,
    pub call_id: String,
    pub turn: u32,
    pub cancel: Cancel,
    pub pause: Pause,
    /// Events the body adds to the log (dsh tools append through
    /// `exec.agent.session.append`).
    pub emit: Emits,
}

/// Events a tool body asks the driver to log right after its result; they
/// are dropped when the call fails. Cheap to clone.
#[derive(Debug, Clone, Default)]
pub struct Emits {
    events: Arc<std::sync::Mutex<Vec<EventBody>>>,
}

impl Emits {
    pub fn push(&self, body: EventBody) {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(body);
    }

    /// Everything pushed so far, once.
    pub fn take(&self) -> Vec<EventBody> {
        std::mem::take(
            &mut *self
                .events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
}

/// Lets a tool body end the turn after its result is recorded, for example
/// to wait for the person's approval. Cheap to clone.
#[derive(Debug, Clone, Default)]
pub struct Pause {
    reason: Arc<std::sync::Mutex<Option<String>>>,
}

impl Pause {
    pub fn request(&self, reason: impl Into<String>) {
        *self
            .reason
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(reason.into());
    }

    /// The requested reason, once.
    pub fn take(&self) -> Option<String> {
        self.reason
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

/// A failed body: the message the model sees, plus optional partial progress.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolFailure {
    pub message: String,
    /// Partial progress the model sees after the message; never logged as
    /// the call's value.
    pub detail: Option<Value>,
}

impl<T: Into<String>> From<T> for ToolFailure {
    fn from(message: T) -> Self {
        Self {
            message: message.into(),
            detail: None,
        }
    }
}

pub type ToolFuture = BoxFuture<'static, Result<Value, ToolFailure>>;
type Execute = Arc<dyn Fn(Value, ToolContext) -> ToolFuture + Send + Sync>;
type Render = Arc<dyn Fn(&Value, &Value) -> Vec<ContentBlock> + Send + Sync>;
type Present = Arc<dyn Fn(&Value, &Value) -> Value + Send + Sync>;
type Project = Arc<dyn Fn(&Value) -> Value + Send + Sync>;

/// A registered tool. Cheap to clone.
#[derive(Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// The compiled JSON Schema sent to the model.
    pub parameters: Value,
    /// The compiled schema every successful value must satisfy.
    pub output_schema: Value,
    /// Whether the tool changes the workspace; policies gate these.
    pub writes: bool,
    parameters_validator: Arc<jsonschema::Validator>,
    output_validator: Arc<jsonschema::Validator>,
    execute: Execute,
    render: Render,
    presentation_meta: Option<Present>,
    log_arguments: Option<Project>,
}

impl std::fmt::Debug for ToolDef {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ToolDef")
            .field("name", &self.name)
            .field("writes", &self.writes)
            .field("parameters", &self.parameters)
            .finish_non_exhaustive()
    }
}

/// The settled outcome of one call: the canonical value, what the model sees,
/// and display-only data.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub value: Value,
    pub content: Vec<ContentBlock>,
    pub is_error: bool,
    pub meta: Option<Value>,
    /// Extra model input from policies, logged as one `user/message` after
    /// all results of the step (DeepSeek Harness `additionalContexts`).
    pub context: Vec<ContentBlock>,
}

impl Settled {
    /// An error outcome. `value` is always `Value::Null` (dsh logs `null` as
    /// the `tool/result` value on failure) and `meta` is always `None`.
    /// `content` carries the message, plus a second text block with
    /// `detail` serialized as compact JSON when it is given, so the model
    /// still sees partial progress such as completed steps.
    pub fn error(message: impl Into<String>, detail: Option<Value>) -> Self {
        let mut content = vec![ContentBlock::text(message)];
        if let Some(detail) = detail {
            content.push(ContentBlock::text(detail.to_string()));
        }
        Self {
            value: Value::Null,
            content,
            is_error: true,
            meta: None,
            context: Vec::new(),
        }
    }
}

/// Starts a tool definition.
pub fn define(name: &str, description: &str) -> ToolBuilder {
    ToolBuilder {
        name: name.to_owned(),
        description: description.to_owned(),
        parameters: json!({}),
        unchecked: None,
        output: json!({ "type": "json" }),
        writes: false,
        execute: None,
        render: None,
        presentation_meta: None,
        log_arguments: None,
    }
}

pub struct ToolBuilder {
    name: String,
    description: String,
    parameters: Value,
    unchecked: Option<Value>,
    output: Value,
    writes: bool,
    execute: Option<Execute>,
    render: Option<Render>,
    presentation_meta: Option<Present>,
    log_arguments: Option<Project>,
}

impl ToolBuilder {
    /// A `ParameterSchemaSpec`.
    pub fn parameters(mut self, spec: Value) -> Self {
        self.parameters = spec;
        self
    }

    /// A raw JSON Schema sent to the model as is. Arguments are not validated
    /// against it; the body validates its own input. For existing tools whose
    /// schemas predate `ParameterSchemaSpec`.
    pub fn unchecked_parameters(mut self, schema: Value) -> Self {
        self.unchecked = Some(schema);
        self
    }

    /// A `ValueSchemaSpec` for the canonical output; defaults to `json`.
    pub fn output(mut self, spec: Value) -> Self {
        self.output = spec;
        self
    }

    pub fn writes(mut self) -> Self {
        self.writes = true;
        self
    }

    pub fn execute<F, Fut>(mut self, body: F) -> Self
    where
        F: Fn(Value, ToolContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, ToolFailure>> + Send + 'static,
    {
        self.execute = Some(Arc::new(
            move |args: Value, cx: ToolContext| -> ToolFuture { Box::pin(body(args, cx)) },
        ));
        self
    }

    /// Pure projection of arguments and value to model content.
    pub fn render(
        mut self,
        render: impl Fn(&Value, &Value) -> Vec<ContentBlock> + Send + Sync + 'static,
    ) -> Self {
        self.render = Some(Arc::new(render));
        self
    }

    /// Pure projection of arguments and value to display-only data.
    pub fn presentation_meta(
        mut self,
        present: impl Fn(&Value, &Value) -> Value + Send + Sync + 'static,
    ) -> Self {
        self.presentation_meta = Some(Arc::new(present));
        self
    }

    /// Pure projection of the arguments to the copy written to the session
    /// log (`assistant/message` and `tool/call`), for example to redact a
    /// password. The body still receives the real arguments. Defaults to
    /// the identity.
    pub fn log_arguments(
        mut self,
        project: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) -> Self {
        self.log_arguments = Some(Arc::new(project));
        self
    }

    pub fn build(self) -> Result<ToolDef, String> {
        if !valid_name(&self.name) {
            return Err(format!(
                "tool name `{}` must be 1 to 64 characters of [A-Za-z0-9_-]",
                self.name
            ));
        }
        let (parameters, parameters_validator) = match self.unchecked {
            Some(schema) => (schema, schema::validator(&json!({}))),
            None => {
                let parameters = schema::parameters_to_json_schema(&self.parameters)
                    .map_err(|error| format!("{}: {error}", self.name))?;
                let validator = schema::validator(&parameters);
                (parameters, validator)
            }
        };
        let parameters_validator =
            Arc::new(parameters_validator.map_err(|error| format!("{}: {error}", self.name))?);
        let output_schema = schema::value_to_json_schema(&self.output)
            .map_err(|error| format!("{}: {error}", self.name))?;
        let output_validator = Arc::new(
            schema::validator(&output_schema).map_err(|error| format!("{}: {error}", self.name))?,
        );
        let execute = self
            .execute
            .ok_or_else(|| format!("{}: no execute body", self.name))?;
        let render: Render = match self.render {
            Some(render) => render,
            None => {
                Arc::new(|_args: &Value, value: &Value| vec![ContentBlock::text(value.to_string())])
            }
        };
        Ok(ToolDef {
            name: self.name,
            description: self.description,
            parameters,
            output_schema,
            writes: self.writes,
            parameters_validator,
            output_validator,
            execute,
            render,
            presentation_meta: self.presentation_meta,
            log_arguments: self.log_arguments,
        })
    }
}

/// A tool name valid in every provider's tool namespace (KHP A2).
pub fn tool_name(prefix: &str, command: &str) -> String {
    format!("{prefix}_{command}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// `normalize_calls` (`llm.rs`) keeps a tool call's unparseable JSON visible
/// as `{"raw": "..."}` rather than discarding it. If the tool itself does
/// not declare a `raw` parameter, that shape can only mean the model's JSON
/// did not parse; refusing it here, before schema validation, tells the
/// model so directly instead of reporting a confusing schema violation (or,
/// worse, running the body with an argument it never intended).
fn malformed_raw_argument<'a>(parameters: &Value, args: &'a Value) -> Option<&'a str> {
    let object = args.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let raw = object.get("raw")?.as_str()?;
    let declares_raw = parameters
        .get("properties")
        .and_then(|properties| properties.get("raw"))
        .is_some();
    if declares_raw { None } else { Some(raw) }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

impl ToolDef {
    /// The arguments as they may be logged. A projection that panics logs
    /// a placeholder rather than the real arguments.
    pub fn logged_arguments(&self, args: &Value) -> Value {
        match &self.log_arguments {
            None => args.clone(),
            Some(project) => std::panic::catch_unwind(AssertUnwindSafe(|| project(args)))
                .unwrap_or_else(|_panic| json!("[arguments not logged]")),
        }
    }

    pub fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema: Some(self.parameters.clone()),
        }
    }

    /// Validates the arguments, runs the body, checks the value against the
    /// output schema, and renders it. Never panics; failures are `Settled` errors.
    pub async fn run(&self, args: Value, cx: ToolContext) -> Settled {
        if cx.cancel.is_cancelled() {
            return Settled::error("tool call aborted before dispatch", None);
        }
        if let Some(raw) = malformed_raw_argument(&self.parameters, &args) {
            let truncated: String = raw.chars().take(200).collect();
            return Settled::error(
                format!(
                    "Error: the arguments for {} were not valid JSON: {truncated}",
                    self.name
                ),
                None,
            );
        }
        let problems = schema::violations(&self.parameters_validator, &args);
        if !problems.is_empty() {
            return Settled::error(format!("invalid arguments: {}", problems.join("; ")), None);
        }
        let outcome = AssertUnwindSafe((self.execute)(args.clone(), cx))
            .catch_unwind()
            .await;
        let value = match outcome {
            Err(_panic) => {
                return Settled::error(format!("{} failed unexpectedly", self.name), None);
            }
            Ok(Err(failure)) => return Settled::error(failure.message, failure.detail),
            Ok(Ok(value)) => value,
        };
        let problems = schema::violations(&self.output_validator, &value);
        if !problems.is_empty() {
            return Settled::error(
                format!(
                    "{} returned output outside its schema: {}",
                    self.name,
                    problems.join("; ")
                ),
                None,
            );
        }
        let content = match std::panic::catch_unwind(AssertUnwindSafe(|| {
            (self.render)(&args, &value)
        })) {
            Ok(content) => content,
            Err(_panic) => {
                return Settled::error(format!("{} could not present its output", self.name), None);
            }
        };
        let meta = match self.presentation_meta.as_ref() {
            None => None,
            Some(present) => {
                // `null` means this result has nothing to present.
                match std::panic::catch_unwind(AssertUnwindSafe(|| present(&args, &value))) {
                    Ok(meta) => Some(meta).filter(|meta| !meta.is_null()),
                    Err(_panic) => {
                        return Settled::error(
                            format!("{} could not present its output", self.name),
                            None,
                        );
                    }
                }
            }
        };
        Settled {
            content,
            meta,
            value,
            is_error: false,
            context: Vec::new(),
        }
    }
}

/// Tools by name. A second registration of a name is refused.
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, ToolDef>,
}

impl std::fmt::Debug for ToolRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ToolRegistry")
            .field("tools", &self.tools.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl ToolRegistry {
    pub fn register(&mut self, tool: ToolDef) -> Result<(), String> {
        if self.tools.contains_key(&tool.name) {
            return Err(format!("tool `{}` is already registered", tool.name));
        }
        self.tools.insert(tool.name.clone(), tool);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<&ToolDef> {
        self.tools.get(name)
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools.values().map(ToolDef::spec).collect()
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    fn echo() -> ToolDef {
        define("echo", "Echo text")
            .parameters(json!({ "text": { "type": "string", "required": true } }))
            .output(json!({
                "type": "object", "additionalProperties": false,
                "properties": { "text": { "type": "string", "required": true } }
            }))
            .execute(|args, _cx| async move { Ok(json!({ "text": args["text"] })) })
            .render(|_args, value| {
                vec![ContentBlock::text(
                    value["text"].as_str().unwrap_or_default(),
                )]
            })
            .presentation_meta(|args, _value| json!({ "title": format!("Echo {}", args["text"]) }))
            .build()
            .unwrap_or_else(|error| panic!("{error}"))
    }

    #[tokio::test]
    async fn a_null_presentation_is_no_meta() {
        let tool = define("quiet", "q")
            .execute(|_, _| async { Ok(json!({})) })
            .presentation_meta(|_, _| Value::Null)
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(tool.run(json!({}), cx()).await.meta, None);
    }

    fn cx() -> ToolContext {
        ToolContext {
            session_id: "s".into(),
            call_id: "c".into(),
            turn: 1,
            cancel: Cancel::default(),
            pause: Pause::default(),
            emit: Emits::default(),
        }
    }

    #[tokio::test]
    async fn validates_runs_and_renders() {
        let settled = echo().run(json!({ "text": "hi" }), cx()).await;
        assert!(!settled.is_error);
        assert_eq!(settled.value, json!({ "text": "hi" }));
        assert_eq!(settled.content, vec![ContentBlock::text("hi")]);
        assert_eq!(settled.meta, Some(json!({ "title": "Echo \"hi\"" })));
        let bad = echo().run(json!({}), cx()).await;
        assert!(bad.is_error);
        assert!(
            matches!(&bad.content[0], ContentBlock::Text { text } if text.starts_with("invalid arguments"))
        );
    }

    #[tokio::test]
    async fn output_outside_its_schema_is_an_error() {
        let liar = define("liar", "Returns the wrong shape")
            .output(json!({ "type": "string" }))
            .execute(|_, _| async { Ok(json!(42)) })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(liar.run(json!({}), cx()).await.is_error);
    }

    #[test]
    fn names_are_provider_safe_and_unique() {
        assert_eq!(tool_name("film", "timeline.razor"), "film_timeline_razor");
        let mut registry = ToolRegistry::default();
        assert!(registry.register(echo()).is_ok());
        assert!(registry.register(echo()).is_err());
        assert_eq!(registry.specs()[0].name, "echo");
        assert!(
            define("bad.name", "x")
                .execute(|_, _| async { Ok(Value::Null) })
                .build()
                .is_err()
        );
        assert!(define("no_body", "x").build().is_err());
    }

    #[tokio::test]
    async fn panic_in_body_settles_as_error() {
        let boom = define("boom", "panics")
            .execute(|_, _| async { panic!("kaboom") })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        let settled = boom.run(json!({}), cx()).await;
        assert!(settled.is_error);
        assert_eq!(settled.value, Value::Null);
        assert_eq!(
            settled.content,
            vec![ContentBlock::text("boom failed unexpectedly")]
        );
    }

    #[tokio::test]
    async fn panic_in_render_settles_as_error() {
        let boom = define("boom_render", "renders badly")
            .execute(|_, _| async { Ok(Value::Null) })
            .render(|_, _| panic!("kaboom"))
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        let settled = boom.run(json!({}), cx()).await;
        assert!(settled.is_error);
        assert_eq!(settled.value, Value::Null);
        assert_eq!(
            settled.content,
            vec![ContentBlock::text(
                "boom_render could not present its output"
            )]
        );
    }

    #[tokio::test]
    async fn failure_detail_becomes_a_second_content_block_value_stays_null() {
        let tool = define("partial", "partial failure")
            .execute(|_, _| async {
                Err(ToolFailure {
                    message: "boom".into(),
                    detail: Some(json!({ "done": 1 })),
                })
            })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        let settled = tool.run(json!({}), cx()).await;
        assert!(settled.is_error);
        assert_eq!(settled.value, Value::Null);
        assert_eq!(
            settled.content,
            vec![
                ContentBlock::text("boom"),
                ContentBlock::text("{\"done\":1}")
            ]
        );
    }

    #[tokio::test]
    async fn plain_failure_has_a_single_content_block() {
        let tool = define("plain_fail", "plain failure")
            .execute(|_, _| async { Err("plain".into()) })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        let settled = tool.run(json!({}), cx()).await;
        assert!(settled.is_error);
        assert_eq!(settled.value, Value::Null);
        assert_eq!(settled.content, vec![ContentBlock::text("plain")]);
    }

    #[tokio::test]
    async fn cancelled_before_dispatch_skips_the_body() {
        let context = cx();
        context.cancel.cancel();
        let settled = echo().run(json!({ "text": "hi" }), context).await;
        assert!(settled.is_error);
        assert_eq!(settled.value, Value::Null);
        assert_eq!(
            settled.content,
            vec![ContentBlock::text("tool call aborted before dispatch")]
        );
    }

    #[test]
    fn writes_flag_is_set_by_the_builder() {
        let tool = define("writer", "writes")
            .writes()
            .execute(|_, _| async { Ok(Value::Null) })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(tool.writes);
    }

    #[test]
    fn spec_input_schema_matches_the_compiled_parameters() {
        let tool = echo();
        assert_eq!(tool.spec().input_schema, Some(tool.parameters.clone()));
    }

    #[test]
    fn build_fails_on_an_invalid_parameter_spec_with_a_name_prefixed_error() {
        let error = define("bad_params", "x")
            .parameters(json!({ "x": { "type": "object" } }))
            .execute(|_, _| async { Ok(Value::Null) })
            .build()
            .err()
            .unwrap_or_default();
        assert!(error.starts_with("bad_params:"), "{error}");
    }

    #[tokio::test]
    async fn malformed_json_arguments_settle_as_an_error_without_running_the_body() {
        let ran = Arc::new(AtomicBool::new(false));
        let body_ran = ran.clone();
        let tool = define("no_raw_param", "has no raw parameter")
            .execute(move |_args, _cx| {
                let body_ran = body_ran.clone();
                async move {
                    body_ran.store(true, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        let settled = tool.run(json!({ "raw": "{\"a\":" }), cx()).await;
        assert!(settled.is_error);
        assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(settled.value, Value::Null);
        assert!(
            matches!(
                &settled.content[0],
                ContentBlock::Text { text }
                    if text == "Error: the arguments for no_raw_param were not valid JSON: {\"a\":"
            ),
            "{:?}",
            settled.content
        );
    }

    #[tokio::test]
    async fn a_tool_declaring_a_raw_parameter_still_runs() {
        let tool = define("has_raw_param", "declares raw")
            .parameters(json!({ "raw": { "type": "string", "required": true } }))
            .execute(|args, _cx| async move { Ok(json!({ "raw": args["raw"] })) })
            .output(json!({
                "type": "object", "additionalProperties": false,
                "properties": { "raw": { "type": "string", "required": true } }
            }))
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        let settled = tool.run(json!({ "raw": "{\"a\":" }), cx()).await;
        assert!(!settled.is_error);
        assert_eq!(settled.value, json!({ "raw": "{\"a\":" }));
    }

    #[tokio::test]
    async fn unchecked_parameters_are_sent_as_is_and_not_validated() {
        let schema = json!({ "type": "object", "properties": { "n": { "type": "integer" } }, "required": ["n"] });
        let tool = define("catalog-tool", "Catalog")
            .unchecked_parameters(schema.clone())
            .execute(|args, _| async move { Ok(args) })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(tool.spec().input_schema, Some(schema));
        let settled = tool.run(json!({ "n": "not a number" }), cx()).await;
        assert!(!settled.is_error, "{settled:?}");
    }

    #[tokio::test]
    async fn a_body_can_ask_to_pause_the_turn() {
        let tool = define("ask", "Asks")
            .execute(|_, cx| async move {
                cx.pause.request("Run `rm`?");
                Ok(json!({ "requires": "approval" }))
            })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        let context = cx();
        let pause = context.pause.clone();
        assert!(!tool.run(json!({}), context).await.is_error);
        assert_eq!(pause.take().as_deref(), Some("Run `rm`?"));
        assert_eq!(pause.take(), None);
    }

    #[test]
    fn debug_shows_tool_names_not_their_full_definitions() {
        let mut registry = ToolRegistry::default();
        registry
            .register(echo())
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            format!("{registry:?}"),
            r#"ToolRegistry { tools: ["echo"] }"#
        );
    }
}
