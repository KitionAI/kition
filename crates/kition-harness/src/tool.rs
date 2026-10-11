//! Tools in the DeepSeek Harness `defineTool` shape (Kit Standard A1): a name,
//! a description, a parameter schema, a canonical output schema with a pure
//! render, an optional pure presentation projection, and the body.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;
use kition_ai::engine::ToolSpec;
use serde_json::{Value, json};

use crate::cancel::Cancel;
use crate::events::ContentBlock;
use crate::schema;

/// What a tool body knows about its call.
pub struct ToolContext {
    pub session_id: String,
    pub call_id: String,
    pub cancel: Cancel,
}

/// A failed body: the message the model sees, plus optional partial output.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolFailure {
    pub message: String,
    pub output: Option<Value>,
}

impl<T: Into<String>> From<T> for ToolFailure {
    fn from(message: T) -> Self {
        Self {
            message: message.into(),
            output: None,
        }
    }
}

pub type ToolFuture = BoxFuture<'static, Result<Value, ToolFailure>>;
type Execute = Arc<dyn Fn(Value, ToolContext) -> ToolFuture + Send + Sync>;
type Render = Arc<dyn Fn(&Value, &Value) -> Vec<ContentBlock> + Send + Sync>;
type Present = Arc<dyn Fn(&Value, &Value) -> Value + Send + Sync>;

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
}

/// The settled outcome of one call: the canonical value, what the model sees,
/// and display-only data.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub value: Value,
    pub content: Vec<ContentBlock>,
    pub is_error: bool,
    pub meta: Option<Value>,
}

impl Settled {
    pub fn error(message: impl Into<String>, output: Option<Value>) -> Self {
        Self {
            value: output.unwrap_or(Value::Null),
            content: vec![ContentBlock::text(message)],
            is_error: true,
            meta: None,
        }
    }
}

/// Starts a tool definition.
pub fn define(name: &str, description: &str) -> ToolBuilder {
    ToolBuilder {
        name: name.to_owned(),
        description: description.to_owned(),
        parameters: json!({}),
        output: json!({ "type": "json" }),
        writes: false,
        execute: None,
        render: None,
        presentation_meta: None,
    }
}

pub struct ToolBuilder {
    name: String,
    description: String,
    parameters: Value,
    output: Value,
    writes: bool,
    execute: Option<Execute>,
    render: Option<Render>,
    presentation_meta: Option<Present>,
}

impl ToolBuilder {
    /// A `ParameterSchemaSpec`.
    pub fn parameters(mut self, spec: Value) -> Self {
        self.parameters = spec;
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

    pub fn build(self) -> Result<ToolDef, String> {
        if !valid_name(&self.name) {
            return Err(format!(
                "tool name `{}` must be 1 to 64 characters of [A-Za-z0-9_]",
                self.name
            ));
        }
        let parameters = schema::parameters_to_json_schema(&self.parameters)
            .map_err(|error| format!("{}: {error}", self.name))?;
        let output_schema = schema::value_to_json_schema(&self.output)
            .map_err(|error| format!("{}: {error}", self.name))?;
        let parameters_validator = Arc::new(
            schema::validator(&parameters).map_err(|error| format!("{}: {error}", self.name))?,
        );
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
        })
    }
}

/// A tool name valid in every provider's tool namespace (Kit Standard A2).
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

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl ToolDef {
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
        let problems = schema::violations(&self.parameters_validator, &args);
        if !problems.is_empty() {
            return Settled::error(format!("invalid arguments: {}", problems.join("; ")), None);
        }
        match (self.execute)(args.clone(), cx).await {
            Err(failure) => Settled::error(failure.message, failure.output),
            Ok(value) => {
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
                Settled {
                    content: (self.render)(&args, &value),
                    meta: self
                        .presentation_meta
                        .as_ref()
                        .map(|present| present(&args, &value)),
                    value,
                    is_error: false,
                }
            }
        }
    }
}

/// Tools by name. A second registration of a name is refused.
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, ToolDef>,
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

    fn cx() -> ToolContext {
        ToolContext {
            session_id: "s".into(),
            call_id: "c".into(),
            cancel: Cancel::default(),
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
}
