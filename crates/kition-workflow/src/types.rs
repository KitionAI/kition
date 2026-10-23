//! Workflow definitions and run records, with the legacy JSON shapes.

use kition_core::Millis;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::govec::GoVec;

/// The on-disk schema version written with every definition.
pub const SCHEMA_VER_CURRENT: i64 = 2;

pub const KIND_TRIGGER: &str = "trigger";
pub const KIND_ACTION: &str = "action";
pub const KIND_FILTER: &str = "filter";

pub const TRIGGER_TYPES: [&str; 5] = [
    "record_created",
    "record_updated",
    "record_created_or_updated",
    "scheduled_time",
    "record_date_reached",
];
pub const ACTION_TYPES: [&str; 6] = [
    "send_email",
    "send_notification",
    "add_record",
    "update_record",
    "lookup_record",
    "transform_record",
];

pub fn is_trigger_type(value: &str) -> bool {
    TRIGGER_TYPES.contains(&value)
}

pub fn is_action_type(value: &str) -> bool {
    ACTION_TYPES.contains(&value)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FieldRef {
    #[serde(default, rename = "nodeId")]
    pub node_id: String,
    #[serde(default, rename = "fieldId")]
    pub field_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BodyPart {
    #[serde(default)]
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, rename = "fieldRef", skip_serializing_if = "Option::is_none")]
    pub field_ref: Option<FieldRef>,
}

impl BodyPart {
    pub fn text(text: &str) -> Self {
        Self {
            kind: "text".into(),
            text: text.into(),
            field_ref: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BodyTemplate {
    #[serde(default)]
    pub parts: GoVec<BodyPart>,
}

impl BodyTemplate {
    /// A one-text-part template; empty text gives an empty template.
    pub fn plain(text: &str) -> Self {
        if text.is_empty() {
            Self::default()
        } else {
            Self {
                parts: vec![BodyPart::text(text)].into(),
            }
        }
    }

    /// True when no part shows anything.
    pub fn is_blank(&self) -> bool {
        !self
            .parts
            .iter()
            .any(|p| p.kind == "field_ref" || (p.kind == "text" && !p.text.trim().is_empty()))
    }
}

/// Subjects accept the legacy plain-string form as well as a template.
pub fn deserialize_subject<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BodyTemplate, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::Null => Ok(BodyTemplate::default()),
        Value::String(text) => Ok(BodyTemplate::plain(&text)),
        other => serde_json::from_value(other).map_err(D::Error::custom),
    }
}

fn deserialize_optional_subject<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BodyTemplate>, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(BodyTemplate::plain(&text))),
        other => serde_json::from_value(other)
            .map(Some)
            .map_err(D::Error::custom),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ScheduleConfig {
    #[serde(default)]
    pub cron: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub timezone: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DateFieldConfig {
    #[serde(default, rename = "fieldId")]
    pub field_id: String,
    #[serde(default, rename = "atTime", skip_serializing_if = "String::is_empty")]
    pub at_time: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TriggerConfig {
    #[serde(default, rename = "nodeId")]
    pub node_id: String,
    #[serde(default, rename = "type", skip_serializing_if = "String::is_empty")]
    pub trigger_type: String,
    /// The table file's workspace-relative path (`Leads.ktable`).
    #[serde(
        default,
        rename = "documentPath",
        skip_serializing_if = "String::is_empty"
    )]
    pub document_path: String,
    /// The table file's stable identity (its KDM root object id), which finds it again when the
    /// path no longer names it.
    #[serde(
        default,
        rename = "documentId",
        skip_serializing_if = "String::is_empty"
    )]
    pub document_id: String,
    #[serde(default, rename = "tableId", skip_serializing_if = "String::is_empty")]
    pub table_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<ScheduleConfig>,
    #[serde(default, rename = "dateField", skip_serializing_if = "Option::is_none")]
    pub date_field: Option<DateFieldConfig>,
    #[serde(
        default,
        rename = "requiredFields",
        skip_serializing_if = "GoVec::is_empty"
    )]
    pub required_fields: GoVec<String>,
}

impl TriggerConfig {
    /// Triggers that carry a record (and can be gated by required fields).
    pub fn is_record_trigger(&self) -> bool {
        matches!(
            self.trigger_type.as_str(),
            "record_created"
                | "record_updated"
                | "record_created_or_updated"
                | "record_date_reached"
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FieldAssignment {
    #[serde(default, rename = "fieldId")]
    pub field_id: String,
    #[serde(default)]
    pub value: BodyTemplate,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AddRecordConfig {
    /// The target table file's workspace-relative path; empty for the trigger's file.
    #[serde(
        default,
        rename = "targetDocumentPath",
        skip_serializing_if = "String::is_empty"
    )]
    pub target_document_path: String,
    /// The target table file's stable identity (its KDM root object id).
    #[serde(
        default,
        rename = "targetDocumentId",
        skip_serializing_if = "String::is_empty"
    )]
    pub target_document_id: String,
    #[serde(default, rename = "targetTableId")]
    pub target_table_id: String,
    #[serde(default)]
    pub fields: GoVec<FieldAssignment>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdateRecordConfig {
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub fields: GoVec<FieldAssignment>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WriteBackMapping {
    #[serde(default, rename = "sourceFieldId")]
    pub source_field_id: String,
    #[serde(default, rename = "targetFieldId")]
    pub target_field_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LookupRecordConfig {
    /// The target table file's workspace-relative path; empty for the trigger's file.
    #[serde(
        default,
        rename = "targetDocumentPath",
        skip_serializing_if = "String::is_empty"
    )]
    pub target_document_path: String,
    /// The target table file's stable identity (its KDM root object id).
    #[serde(
        default,
        rename = "targetDocumentId",
        skip_serializing_if = "String::is_empty"
    )]
    pub target_document_id: String,
    #[serde(default, rename = "targetTableId")]
    pub target_table_id: String,
    #[serde(default, rename = "matchFieldId")]
    pub match_field_id: String,
    #[serde(default, rename = "matchValue")]
    pub match_value: BodyTemplate,
    #[serde(default, rename = "writeBack")]
    pub write_back: GoVec<WriteBackMapping>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TransformOperation {
    #[serde(default)]
    pub source: BodyTemplate,
    #[serde(default)]
    pub operation: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub argument: String,
    #[serde(default, rename = "targetFieldId")]
    pub target_field_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TransformRecordConfig {
    #[serde(default)]
    pub operations: GoVec<TransformOperation>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ActionConfig {
    #[serde(default, rename = "nodeId")]
    pub node_id: String,
    #[serde(default, rename = "type", skip_serializing_if = "String::is_empty")]
    pub action_type: String,
    #[serde(
        default,
        rename = "connectionId",
        skip_serializing_if = "String::is_empty"
    )]
    pub connection_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub to: String,
    #[serde(default, deserialize_with = "deserialize_subject")]
    pub subject: BodyTemplate,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default)]
    pub body: BodyTemplate,
    #[serde(default, rename = "addRecord", skip_serializing_if = "Option::is_none")]
    pub add_record: Option<AddRecordConfig>,
    #[serde(
        default,
        rename = "updateRecord",
        skip_serializing_if = "Option::is_none"
    )]
    pub update_record: Option<UpdateRecordConfig>,
    #[serde(
        default,
        rename = "lookupRecord",
        skip_serializing_if = "Option::is_none"
    )]
    pub lookup_record: Option<LookupRecordConfig>,
    #[serde(
        default,
        rename = "transformRecord",
        skip_serializing_if = "Option::is_none"
    )]
    pub transform_record: Option<TransformRecordConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NodeConfig {
    #[serde(default, rename = "nodeId")]
    pub node_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub config: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EdgeConfig {
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub to: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FilterConfig {
    #[serde(default, rename = "nodeId")]
    pub node_id: String,
    #[serde(default, rename = "type")]
    pub filter_type: String,
    #[serde(default)]
    pub expression: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mode: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct NodeIssue {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub hint: String,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub level: &'static str,
}

/// A workflow: canonical trigger and action plus extra graph nodes (filters)
/// and explicit edges.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorkflowDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub trigger: TriggerConfig,
    pub action: ActionConfig,
    pub extra_nodes: Vec<NodeConfig>,
    pub extra_edges: Vec<EdgeConfig>,
}

impl WorkflowDefinition {
    /// The node graph: trigger, extra nodes, action; explicit edges or the
    /// implicit linear chain.
    pub fn nodes_and_edges(&self) -> (Vec<NodeConfig>, Vec<EdgeConfig>) {
        let has_legacy = !self.trigger.node_id.is_empty() || !self.action.node_id.is_empty();
        if !has_legacy && self.extra_nodes.is_empty() {
            return (Vec::new(), Vec::new());
        }
        let mut nodes = Vec::with_capacity(2 + self.extra_nodes.len());
        if !self.trigger.node_id.is_empty()
            && let Ok(config) = serde_json::to_value(&self.trigger)
        {
            nodes.push(NodeConfig {
                node_id: self.trigger.node_id.clone(),
                kind: KIND_TRIGGER.into(),
                config,
            });
        }
        nodes.extend(self.extra_nodes.iter().cloned());
        if !self.action.node_id.is_empty()
            && let Ok(config) = serde_json::to_value(&self.action)
        {
            nodes.push(NodeConfig {
                node_id: self.action.node_id.clone(),
                kind: KIND_ACTION.into(),
                config,
            });
        }
        let mut edges = Vec::new();
        if !self.extra_edges.is_empty() {
            edges.extend(self.extra_edges.iter().cloned());
        } else if !self.trigger.node_id.is_empty() && !self.action.node_id.is_empty() {
            let mut previous = self.trigger.node_id.clone();
            for node in &self.extra_nodes {
                edges.push(EdgeConfig {
                    from: previous,
                    to: node.node_id.clone(),
                    branch: String::new(),
                });
                previous = node.node_id.clone();
            }
            edges.push(EdgeConfig {
                from: previous,
                to: self.action.node_id.clone(),
                branch: String::new(),
            });
        }
        (nodes, edges)
    }
}

impl Serialize for WorkflowDefinition {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct View<'a> {
            id: &'a str,
            name: &'a str,
            description: &'a str,
            enabled: bool,
            trigger: &'a TriggerConfig,
            action: &'a ActionConfig,
            #[serde(rename = "schemaVer")]
            schema_ver: i64,
            nodes: Vec<NodeConfig>,
            edges: Vec<EdgeConfig>,
        }
        let (nodes, edges) = self.nodes_and_edges();
        View {
            id: &self.id,
            name: &self.name,
            description: &self.description,
            enabled: self.enabled,
            trigger: &self.trigger,
            action: &self.action,
            schema_ver: SCHEMA_VER_CURRENT,
            nodes,
            edges,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for WorkflowDefinition {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            #[serde(default)]
            id: String,
            #[serde(default)]
            name: String,
            #[serde(default)]
            description: String,
            #[serde(default)]
            enabled: bool,
            #[serde(default)]
            trigger: Option<TriggerConfig>,
            #[serde(default)]
            action: Option<ActionConfig>,
            #[serde(default)]
            nodes: Option<Vec<NodeConfig>>,
            #[serde(default)]
            edges: Option<Vec<EdgeConfig>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let mut def = WorkflowDefinition {
            id: raw.id,
            name: raw.name,
            description: raw.description,
            enabled: raw.enabled,
            trigger: raw.trigger.unwrap_or_default(),
            action: raw.action.unwrap_or_default(),
            extra_nodes: Vec::new(),
            extra_edges: Vec::new(),
        };
        let nodes = raw.nodes.unwrap_or_default();
        if def.trigger.node_id.is_empty() && def.action.node_id.is_empty() && !nodes.is_empty() {
            for node in nodes {
                match node.kind.as_str() {
                    KIND_TRIGGER => {
                        let mut trigger: TriggerConfig = config_of(&node).map_err(|err| {
                            D::Error::custom(format!(
                                "workflow: trigger node {:?} config: {err}",
                                node.node_id
                            ))
                        })?;
                        if trigger.node_id.is_empty() {
                            trigger.node_id = node.node_id.clone();
                        }
                        def.trigger = trigger;
                    }
                    KIND_ACTION => {
                        let mut action: ActionConfig = config_of(&node).map_err(|err| {
                            D::Error::custom(format!(
                                "workflow: action node {:?} config: {err}",
                                node.node_id
                            ))
                        })?;
                        if action.node_id.is_empty() {
                            action.node_id = node.node_id.clone();
                        }
                        def.action = action;
                    }
                    KIND_FILTER => def.extra_nodes.push(node),
                    _ => {}
                }
            }
        } else {
            def.extra_nodes = nodes
                .into_iter()
                .filter(|n| n.kind == KIND_FILTER)
                .collect();
        }
        let edges = raw.edges.unwrap_or_default();
        if !edges.is_empty() && !def.extra_nodes.is_empty() {
            def.extra_edges = edges;
        }
        Ok(def)
    }
}

/// Decodes a node's config; a missing config is the default.
pub fn config_of<T: for<'de> Deserialize<'de> + Default>(
    node: &NodeConfig,
) -> Result<T, serde_json::Error> {
    if node.config.is_null() {
        Ok(T::default())
    } else {
        serde_json::from_value(node.config.clone())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FieldSchema {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableSchema {
    pub id: String,
    pub name: String,
    pub fields: Vec<FieldSchema>,
}

fn is_empty_map(map: &Option<Map<String, Value>>) -> bool {
    map.as_ref().is_none_or(Map::is_empty)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NodeOutcome {
    #[serde(default, rename = "nodeId")]
    pub node_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub status: String,
    #[serde(
        default,
        rename = "startedAt",
        deserialize_with = "kition_core::time::flexible::required"
    )]
    pub started_at: Millis,
    #[serde(
        default,
        rename = "finishedAt",
        deserialize_with = "kition_core::time::flexible::required"
    )]
    pub finished_at: Millis,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RunRecord {
    #[serde(default)]
    pub id: String,
    #[serde(default, rename = "workflowId")]
    pub workflow_id: String,
    #[serde(default, rename = "triggerEvent")]
    pub trigger_event: String,
    #[serde(default, rename = "recordId")]
    pub record_id: String,
    #[serde(
        default,
        rename = "documentPath",
        skip_serializing_if = "String::is_empty"
    )]
    pub document_path: String,
    #[serde(default, rename = "tableId", skip_serializing_if = "String::is_empty")]
    pub table_id: String,
    #[serde(default, rename = "userId", skip_serializing_if = "is_zero")]
    pub user_id: i64,
    #[serde(
        default,
        rename = "connectionId",
        skip_serializing_if = "String::is_empty"
    )]
    pub connection_id: String,
    #[serde(
        default,
        rename = "startedAt",
        deserialize_with = "kition_core::time::flexible::required"
    )]
    pub started_at: Millis,
    #[serde(
        default,
        rename = "finishedAt",
        deserialize_with = "kition_core::time::flexible::required"
    )]
    pub finished_at: Millis,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
    #[serde(
        default,
        rename = "errorCode",
        skip_serializing_if = "String::is_empty"
    )]
    pub error_code: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(
        default,
        rename = "failingNodeId",
        skip_serializing_if = "String::is_empty"
    )]
    pub failing_node_id: String,
    #[serde(
        default,
        rename = "triggerFields",
        skip_serializing_if = "is_empty_map"
    )]
    pub trigger_fields: Option<Map<String, Value>>,
    #[serde(
        default,
        rename = "nodeOutcomes",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub node_outcomes: Vec<NodeOutcome>,
    #[serde(
        default,
        rename = "skipReason",
        skip_serializing_if = "String::is_empty"
    )]
    pub skip_reason: String,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

/// A record value counts as empty when null, blank text, or an empty
/// list or object; numbers and booleans are never empty.
pub fn is_field_value_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.trim().is_empty(),
        Some(Value::Array(items)) => items.is_empty(),
        Some(Value::Object(map)) => map.is_empty(),
        Some(_) => false,
    }
}

/// The first required field without a value, or empty when all are set.
pub fn missing_required_field(required: &[String], fields: &Map<String, Value>) -> String {
    required
        .iter()
        .map(|id| id.trim())
        .find(|id| !id.is_empty() && is_field_value_empty(fields.get(*id)))
        .unwrap_or_default()
        .to_owned()
}

/// Optional subject in patch requests: `null` and absent mean "unchanged".
pub fn optional_subject<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BodyTemplate>, D::Error> {
    deserialize_optional_subject(deserializer)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn round_trips_the_legacy_shape() {
        let raw = json!({
            "id": "w1", "name": "N", "enabled": false,
            "trigger": {"nodeId": "t", "type": "record_created", "tableId": "5"},
            "action": {"nodeId": "a", "type": "send_email", "to": "x@y.z", "subject": "Hello", "body": {"parts": []}}
        });
        let def: WorkflowDefinition = serde_json::from_value(raw).unwrap_or_default();
        assert_eq!(
            def.action.subject.parts.as_slice(),
            &[BodyPart::text("Hello")]
        );
        let out = serde_json::to_value(&def).unwrap_or_default();
        assert_eq!(out["schemaVer"], json!(2));
        assert_eq!(
            out["action"]["subject"],
            json!({"parts": [{"kind": "text", "text": "Hello"}]})
        );
        assert_eq!(out["action"]["body"], json!({"parts": []}));
        assert_eq!(out["edges"], json!([{"from": "t", "to": "a"}]));
        assert_eq!(
            out["nodes"][0]["config"],
            json!({"nodeId": "t", "type": "record_created", "tableId": "5"})
        );
        assert_eq!(out["description"], json!(""));
        let empty = serde_json::to_value(WorkflowDefinition::default()).unwrap_or_default();
        assert_eq!(
            (empty["nodes"].clone(), empty["action"]["subject"].clone()),
            (json!([]), json!({"parts": null}))
        );
    }

    #[test]
    fn reads_the_node_graph_shape() {
        let raw = json!({
            "id": "w2", "name": "G",
            "nodes": [
                {"nodeId": "t", "kind": "trigger", "config": {"type": "record_updated", "tableId": "1"}},
                {"nodeId": "f", "kind": "filter", "config": {"expression": "t.x == 1"}},
                {"nodeId": "a", "kind": "action", "config": {"type": "send_notification", "title": "Hi"}}
            ],
            "edges": [{"from": "t", "to": "f"}, {"from": "f", "to": "a"}]
        });
        let def: WorkflowDefinition = serde_json::from_value(raw).unwrap_or_default();
        assert_eq!(
            (def.trigger.node_id.as_str(), def.action.title.as_str()),
            ("t", "Hi")
        );
        assert_eq!(def.extra_nodes.len(), 1);
        assert_eq!(def.extra_edges.len(), 2);
        let fields = |v: Value| json!({"a": v}).as_object().cloned().unwrap_or_default();
        assert!(missing_required_field(&["a".into()], &fields(json!(0))).is_empty());
        assert_eq!(
            missing_required_field(&["a".into()], &fields(json!(" "))),
            "a"
        );
    }
}
