//! Definition checks (errors that block saving or running) and per-node
//! canvas diagnostics.

use std::collections::{HashMap, HashSet, VecDeque};

use kition_connections::store::{ConnectionView, STATUS_INVALID};

use crate::cron;
use crate::gofmt::quote;
use crate::template::apply_transform;
use crate::types::*;

type Check = Result<(), String>;

/// Finds the caller's connection by ID.
pub type ConnectionLookup<'a> = &'a dyn Fn(&str) -> Option<ConnectionView>;

fn fail<T>(message: impl Into<String>) -> Result<T, String> {
    Err(message.into())
}

pub fn is_valid_hhmm(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let part = |text: &str, max: i64| crate_atoi(text).is_some_and(|v| (0..=max).contains(&v));
    part(&value[..2], 23) && part(&value[3..], 59)
}

fn crate_atoi(text: &str) -> Option<i64> {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

pub fn validate_body_template(body: &BodyTemplate) -> Check {
    if body.parts.is_empty() {
        return fail("workflow: body must have ≥1 part");
    }
    for (index, part) in body.parts.iter().enumerate() {
        match part.kind.as_str() {
            "text" | "newline" => {}
            "field_ref" => match &part.field_ref {
                None => return fail(format!("workflow: body part {index} field_ref nil")),
                Some(r) if r.node_id.is_empty() || r.field_id.is_empty() => {
                    return fail(format!("workflow: body part {index} field_ref incomplete"));
                }
                Some(_) => {}
            },
            kind => {
                return fail(format!(
                    "workflow: body part {index} unknown kind {}",
                    quote(kind)
                ));
            }
        }
    }
    Ok(())
}

impl WorkflowDefinition {
    /// Structural checks; enabled definitions also get the activation checks.
    pub fn validate(&self) -> Check {
        if self.id.is_empty() {
            return fail("workflow: id required");
        }
        if self.name.is_empty() {
            return fail("workflow: name required");
        }
        if self.trigger.node_id.is_empty() {
            return fail("workflow: trigger required");
        }
        if !self.trigger.trigger_type.is_empty() && !is_trigger_type(&self.trigger.trigger_type) {
            return fail(format!(
                "workflow: unknown trigger type {}",
                quote(&self.trigger.trigger_type)
            ));
        }
        if self.action.node_id.is_empty() {
            return fail("workflow: action required");
        }
        if !self.action.action_type.is_empty() && !is_action_type(&self.action.action_type) {
            return fail(format!(
                "workflow: unknown action type {}",
                quote(&self.action.action_type)
            ));
        }
        if !self.enabled {
            return Ok(());
        }
        self.validate_for_activation()
    }

    /// Everything a definition needs before it can run.
    pub fn validate_for_activation(&self) -> Check {
        let trigger = &self.trigger;
        if trigger.trigger_type.is_empty() {
            return fail("workflow: trigger.type required");
        }
        if !is_trigger_type(&trigger.trigger_type) {
            return fail(format!(
                "workflow: unknown trigger type {}",
                quote(&trigger.trigger_type)
            ));
        }
        if trigger.trigger_type == "scheduled_time" {
            if trigger
                .schedule
                .as_ref()
                .is_none_or(|s| s.cron.trim().is_empty())
            {
                return fail("workflow: trigger.schedule.cron required for scheduled_time");
            }
        } else {
            if trigger.table_id.is_empty() {
                return fail("workflow: trigger.tableId required");
            }
            if trigger.trigger_type == "record_date_reached" {
                let Some(date_field) = trigger
                    .date_field
                    .as_ref()
                    .filter(|d| !d.field_id.trim().is_empty())
                else {
                    return fail(
                        "workflow: trigger.dateField.fieldId required for record_date_reached",
                    );
                };
                let at = date_field.at_time.trim();
                if !at.is_empty() && !is_valid_hhmm(at) {
                    return fail(format!(
                        "workflow: trigger.dateField.atTime {} must be HH:MM (24h)",
                        quote(at)
                    ));
                }
            }
        }
        let action = &self.action;
        if action.action_type.is_empty() {
            return fail("workflow: action.type required");
        }
        if !is_action_type(&action.action_type) {
            return fail(format!(
                "workflow: unknown action type {}",
                quote(&action.action_type)
            ));
        }
        match action.action_type.as_str() {
            "send_email" => {
                if action.to.is_empty() {
                    return fail("workflow: action.to required");
                }
                if action.subject.is_blank() {
                    return fail("workflow: action.subject required");
                }
                validate_body_template(&action.subject)?;
                validate_body_template(&action.body)?;
            }
            "send_notification" => {
                if action.title.trim().is_empty() {
                    return fail("workflow: action.title required for send_notification");
                }
                validate_body_template(&action.body)?;
            }
            "add_record" => {
                let Some(cfg) = &action.add_record else {
                    return fail("workflow: action.addRecord required for add_record");
                };
                if cfg.target_table_id.trim().is_empty() {
                    return fail("workflow: action.addRecord.targetTableId required");
                }
                if cfg.fields.is_empty() {
                    return fail("workflow: action.addRecord.fields must have ≥1 assignment");
                }
                for (i, field) in cfg.fields.iter().enumerate() {
                    if field.field_id.trim().is_empty() {
                        return fail(format!(
                            "workflow: action.addRecord.fields[{i}].fieldId required"
                        ));
                    }
                    validate_body_template(&field.value)
                        .map_err(|err| format!("workflow: action.addRecord.fields[{i}]: {err}"))?;
                }
            }
            "update_record" => {
                let fields = action
                    .update_record
                    .as_ref()
                    .map(|c| c.fields.as_slice())
                    .unwrap_or_default();
                if fields.is_empty() {
                    return fail("workflow: action.updateRecord.fields must have ≥1 assignment");
                }
                for (i, field) in fields.iter().enumerate() {
                    if field.field_id.trim().is_empty() {
                        return fail(format!(
                            "workflow: action.updateRecord.fields[{i}].fieldId required"
                        ));
                    }
                    validate_body_template(&field.value).map_err(|err| {
                        format!("workflow: action.updateRecord.fields[{i}]: {err}")
                    })?;
                }
            }
            "lookup_record" => {
                let Some(cfg) = action.lookup_record.as_ref().filter(|c| {
                    !c.target_table_id.trim().is_empty() && !c.match_field_id.trim().is_empty()
                }) else {
                    return fail(
                        "workflow: action.lookupRecord targetTableId and matchFieldId required",
                    );
                };
                validate_body_template(&cfg.match_value)
                    .map_err(|err| format!("workflow: action.lookupRecord.matchValue: {err}"))?;
                if cfg.write_back.is_empty() {
                    return fail("workflow: action.lookupRecord.writeBack must have ≥1 mapping");
                }
                for (i, mapping) in cfg.write_back.iter().enumerate() {
                    if mapping.source_field_id.trim().is_empty()
                        || mapping.target_field_id.trim().is_empty()
                    {
                        return fail(format!(
                            "workflow: action.lookupRecord.writeBack[{i}] fields required"
                        ));
                    }
                }
            }
            "transform_record" => {
                let operations = action
                    .transform_record
                    .as_ref()
                    .map(|c| c.operations.as_slice())
                    .unwrap_or_default();
                if operations.is_empty() {
                    return fail(
                        "workflow: action.transformRecord.operations must have ≥1 operation",
                    );
                }
                for (i, operation) in operations.iter().enumerate() {
                    if operation.target_field_id.trim().is_empty()
                        || operation.operation.trim().is_empty()
                    {
                        return fail(format!(
                            "workflow: action.transformRecord.operations[{i}] operation and targetFieldId required"
                        ));
                    }
                    validate_body_template(&operation.source).map_err(|err| {
                        format!("workflow: action.transformRecord.operations[{i}]: {err}")
                    })?;
                    if let Err(err) =
                        apply_transform(&operation.operation, "1", &operation.argument)
                        && operation.operation != "domain_from_email"
                    {
                        return fail(format!(
                            "workflow: action.transformRecord.operations[{i}]: {err}"
                        ));
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Checks field references against the trigger table's schema.
    pub fn validate_against_schema(&self, schema: &TableSchema) -> Check {
        if self.trigger.trigger_type == "scheduled_time" && self.trigger.table_id.is_empty() {
            return Ok(());
        }
        if self.trigger.table_id != schema.id {
            return fail(format!(
                "workflow: trigger.tableId {} != schema.ID {}",
                quote(&self.trigger.table_id),
                quote(&schema.id)
            ));
        }
        let known: HashSet<&str> = schema.fields.iter().map(|f| f.id.as_str()).collect();
        let trigger_node = self.trigger.node_id.as_str();
        for (i, part) in self.action.body.parts.iter().enumerate() {
            let Some(r) = part.field_ref.as_ref().filter(|_| part.kind == "field_ref") else {
                continue;
            };
            if r.node_id != trigger_node {
                return fail(format!(
                    "workflow: body part {i} references unknown node {}",
                    quote(&r.node_id)
                ));
            }
            if !known.contains(r.field_id.as_str()) {
                return fail(format!(
                    "workflow: body part {i} references unknown field {}",
                    quote(&r.field_id)
                ));
            }
        }
        let refs = |body: &BodyTemplate| -> Check {
            for (i, part) in body.parts.iter().enumerate() {
                let Some(r) = part.field_ref.as_ref().filter(|_| part.kind == "field_ref") else {
                    continue;
                };
                if r.node_id != trigger_node {
                    return fail(format!(
                        "part {i} references unknown node {}",
                        quote(&r.node_id)
                    ));
                }
                if !known.contains(r.field_id.as_str()) {
                    return fail(format!(
                        "part {i} references unknown field {}",
                        quote(&r.field_id)
                    ));
                }
            }
            Ok(())
        };
        if self.action.action_type == "add_record"
            && let Some(cfg) = &self.action.add_record
        {
            for (i, field) in cfg.fields.iter().enumerate() {
                for (j, part) in field.value.parts.iter().enumerate() {
                    let Some(r) = part.field_ref.as_ref().filter(|_| part.kind == "field_ref")
                    else {
                        continue;
                    };
                    if r.node_id != trigger_node {
                        return fail(format!(
                            "workflow: addRecord.fields[{i}].value part {j} references unknown node {}",
                            quote(&r.node_id)
                        ));
                    }
                    if !known.contains(r.field_id.as_str()) {
                        return fail(format!(
                            "workflow: addRecord.fields[{i}].value part {j} references unknown field {}",
                            quote(&r.field_id)
                        ));
                    }
                }
            }
        }
        if self.action.action_type == "update_record"
            && let Some(cfg) = &self.action.update_record
        {
            for (i, assignment) in cfg.fields.iter().enumerate() {
                if !known.contains(assignment.field_id.as_str()) {
                    return fail(format!(
                        "workflow: updateRecord.fields[{i}] references unknown target field {}",
                        quote(&assignment.field_id)
                    ));
                }
                refs(&assignment.value)
                    .map_err(|err| format!("workflow: updateRecord.fields[{i}]: {err}"))?;
            }
        }
        if self.action.action_type == "transform_record"
            && let Some(cfg) = &self.action.transform_record
        {
            for (i, operation) in cfg.operations.iter().enumerate() {
                if !known.contains(operation.target_field_id.as_str()) {
                    return fail(format!(
                        "workflow: transformRecord.operations[{i}] references unknown target field {}",
                        quote(&operation.target_field_id)
                    ));
                }
                refs(&operation.source)
                    .map_err(|err| format!("workflow: transformRecord.operations[{i}]: {err}"))?;
            }
        }
        if self.action.action_type == "lookup_record"
            && let Some(cfg) = &self.action.lookup_record
        {
            for (i, mapping) in cfg.write_back.iter().enumerate() {
                if !known.contains(mapping.target_field_id.as_str()) {
                    return fail(format!(
                        "workflow: lookupRecord.writeBack[{i}] references unknown target field {}",
                        quote(&mapping.target_field_id)
                    ));
                }
            }
            refs(&cfg.match_value)
                .map_err(|err| format!("workflow: lookupRecord.matchValue: {err}"))?;
        }
        if self.trigger.trigger_type == "record_date_reached"
            && let Some(date_field) = &self.trigger.date_field
        {
            let id = date_field.field_id.trim();
            if !id.is_empty() && !known.contains(id) {
                return fail(format!(
                    "workflow: trigger.dateField.fieldId references unknown field {}",
                    quote(id)
                ));
            }
        }
        if self.trigger.is_record_trigger() {
            for (i, id) in self.trigger.required_fields.iter().enumerate() {
                let id = id.trim();
                if !id.is_empty() && !known.contains(id) {
                    return fail(format!(
                        "workflow: trigger.requiredFields[{i}] references unknown field {}",
                        quote(id)
                    ));
                }
            }
        }
        Ok(())
    }
}

/// Nodes in dependency order, or an error for cycles and dangling edges.
pub fn topo_sort(nodes: &[NodeConfig], edges: &[EdgeConfig]) -> Result<Vec<NodeConfig>, String> {
    if nodes.is_empty() {
        return Ok(Vec::new());
    }
    let by_id: HashMap<&str, &NodeConfig> = nodes.iter().map(|n| (n.node_id.as_str(), n)).collect();
    let mut indegree: HashMap<&str, usize> =
        nodes.iter().map(|n| (n.node_id.as_str(), 0)).collect();
    let mut adjacent: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        if !by_id.contains_key(edge.from.as_str()) {
            return fail(format!(
                "topoSort: edge from unknown node {}",
                quote(&edge.from)
            ));
        }
        if !by_id.contains_key(edge.to.as_str()) {
            return fail(format!(
                "topoSort: edge to unknown node {}",
                quote(&edge.to)
            ));
        }
        adjacent
            .entry(edge.from.as_str())
            .or_default()
            .push(edge.to.as_str());
        *indegree.entry(edge.to.as_str()).or_default() += 1;
    }
    let mut queue: VecDeque<&str> = nodes
        .iter()
        .map(|n| n.node_id.as_str())
        .filter(|id| indegree[id] == 0)
        .collect();
    let mut out = Vec::with_capacity(nodes.len());
    while let Some(id) = queue.pop_front() {
        out.push(by_id[id].clone());
        for next in adjacent.get(id).cloned().unwrap_or_default() {
            if let Some(count) = indegree.get_mut(next) {
                *count -= 1;
                if *count == 0 {
                    queue.push_back(next);
                }
            }
        }
    }
    if out.len() != nodes.len() {
        return fail("topoSort: cycle detected");
    }
    Ok(out)
}

fn issue(
    node_id: &str,
    code: &'static str,
    message: impl Into<String>,
    hint: &str,
    level: &'static str,
) -> NodeIssue {
    NodeIssue {
        node_id: node_id.into(),
        code,
        message: message.into(),
        hint: hint.into(),
        level,
    }
}

const ERROR: &str = "error";
const WARNING: &str = "warning";

/// Per-node diagnostics for the canvas; never fails.
pub fn node_issues(
    def: &WorkflowDefinition,
    connection: Option<ConnectionLookup<'_>>,
) -> Vec<NodeIssue> {
    let mut issues = Vec::new();
    let trigger_id = if def.trigger.node_id.is_empty() {
        "trigger"
    } else {
        def.trigger.node_id.as_str()
    };
    let trigger = &def.trigger;
    if trigger.trigger_type.is_empty() || !is_trigger_type(&trigger.trigger_type) {
        issues.push(issue(
            trigger_id,
            "trigger_type_invalid",
            "Select a trigger event",
            "",
            ERROR,
        ));
    }
    let table_missing = || {
        issue(
            trigger_id,
            "trigger_table_empty",
            "Choose a table for the trigger",
            "",
            ERROR,
        )
    };
    match trigger.trigger_type.as_str() {
        "scheduled_time" => {
            match trigger
                .schedule
                .as_ref()
                .map(|s| s.cron.trim())
                .filter(|c| !c.is_empty())
            {
                None => issues.push(issue(
                    trigger_id,
                    "trigger_schedule_empty",
                    "Set a schedule for the trigger",
                    "Pick a recurrence — e.g. every weekday at 9am.",
                    ERROR,
                )),
                Some(spec) => {
                    if let Err(err) = cron::parse(spec) {
                        issues.push(issue(
                            trigger_id,
                            "trigger_schedule_invalid",
                            "Invalid cron expression",
                            &err,
                            ERROR,
                        ));
                    }
                }
            }
            if let Some(schedule) = &trigger.schedule {
                let tz = schedule.timezone.trim();
                if !tz.is_empty() && cron::load_location(tz).is_err() {
                    issues.push(issue(
                        trigger_id,
                        "trigger_schedule_timezone_invalid",
                        format!("Unknown timezone {tz}"),
                        "Pick an IANA timezone such as America/New_York or Asia/Shanghai. Leave blank for the server's local time.",
                        ERROR,
                    ));
                }
            }
        }
        "record_date_reached" => {
            if trigger.table_id.trim().is_empty() {
                issues.push(table_missing());
            }
            if trigger
                .date_field
                .as_ref()
                .is_none_or(|d| d.field_id.trim().is_empty())
            {
                issues.push(issue(
                    trigger_id,
                    "trigger_date_field_empty",
                    "Pick a date field for the trigger",
                    "Choose the column on the bound table whose date drives the reminder.",
                    ERROR,
                ));
            }
        }
        _ => {
            if trigger.table_id.trim().is_empty() {
                issues.push(table_missing());
            }
        }
    }
    let action_id = if def.action.node_id.is_empty() {
        "action"
    } else {
        def.action.node_id.as_str()
    };
    let action = &def.action;
    if action.action_type.is_empty() || !is_action_type(&action.action_type) {
        issues.push(issue(
            action_id,
            "action_type_invalid",
            "Select an action",
            "",
            ERROR,
        ));
    }
    match action.action_type.as_str() {
        "send_email" => {
            email_issues(def, action_id, &mut issues);
            connection_issues(def, action_id, connection, &mut issues);
        }
        "send_notification" => {
            if action.title.trim().is_empty() {
                issues.push(issue(
                    action_id,
                    "title_empty",
                    "Notification title is required",
                    "This shows as the banner title in macOS notifications.",
                    ERROR,
                ));
            }
            if action.body.parts.is_empty() {
                issues.push(issue(
                    action_id,
                    "body_empty",
                    "Add some content to the notification body",
                    "",
                    ERROR,
                ));
            }
        }
        "add_record" => add_record_issues(def, action_id, &mut issues),
        "update_record" => {
            if action
                .update_record
                .as_ref()
                .is_none_or(|c| c.fields.is_empty())
            {
                issues.push(issue(
                    action_id,
                    "action_update_record_fields_empty",
                    "Add at least one field update",
                    "",
                    ERROR,
                ));
            }
        }
        "lookup_record" => match &action.lookup_record {
            Some(cfg)
                if !cfg.target_table_id.trim().is_empty()
                    && !cfg.match_field_id.trim().is_empty() =>
            {
                if cfg.write_back.is_empty() {
                    issues.push(issue(
                        action_id,
                        "action_lookup_record_writeback_empty",
                        "Add at least one write-back field",
                        "",
                        ERROR,
                    ));
                }
            }
            _ => issues.push(issue(
                action_id,
                "action_lookup_record_incomplete",
                "Choose a lookup table and match field",
                "",
                ERROR,
            )),
        },
        "transform_record"
            if action
                .transform_record
                .as_ref()
                .is_none_or(|c| c.operations.is_empty()) =>
        {
            issues.push(issue(
                action_id,
                "action_transform_record_operations_empty",
                "Add at least one transform operation",
                "",
                ERROR,
            ));
        }
        _ => {}
    }
    issues.extend(graph_issues(def, trigger_id));
    issues
}

fn graph_issues(def: &WorkflowDefinition, trigger_id: &str) -> Vec<NodeIssue> {
    let (nodes, edges) = def.nodes_and_edges();
    if nodes.is_empty() {
        return Vec::new();
    }
    let known: HashSet<&str> = nodes.iter().map(|n| n.node_id.as_str()).collect();
    let mut out = Vec::new();
    for edge in &edges {
        if !edge.branch.trim().is_empty() {
            out.push(issue(
                &edge.from,
                "edge_branch_not_supported",
                "Branching edges aren't supported yet",
                "Remove the branch label — the filter currently runs as single-path (true continues, false terminates).",
                ERROR,
            ));
        }
        if !known.contains(edge.from.as_str()) {
            out.push(issue(
                &edge.to,
                "edge_from_unknown_node",
                "Edge points from a node that doesn't exist",
                &format!(
                    "Source node {} was removed but an edge still references it.",
                    edge.from
                ),
                ERROR,
            ));
            continue;
        }
        if !known.contains(edge.to.as_str()) {
            out.push(issue(
                &edge.from,
                "edge_to_unknown_node",
                "Edge points to a node that doesn't exist",
                &format!(
                    "Target node {} was removed but an edge still references it.",
                    edge.to
                ),
                ERROR,
            ));
        }
    }
    if !out.is_empty() {
        return out;
    }
    if topo_sort(&nodes, &edges).is_err() {
        out.push(issue(
            trigger_id,
            "graph_cycle_detected",
            "Workflow contains a loop",
            "Remove the edge that makes the graph circular — workflows must run from trigger to action without revisiting a node.",
            ERROR,
        ));
    }
    out
}

fn email_issues(def: &WorkflowDefinition, action_id: &str, out: &mut Vec<NodeIssue>) {
    let to = def.action.to.trim();
    if to.is_empty() {
        out.push(issue(
            action_id,
            "to_empty",
            "Recipient is required",
            "Add an email address or pipe a field from the trigger.",
            ERROR,
        ));
    } else if let Some(bad) = to
        .split(',')
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .find(|a| crate::mail::parse_address(a).is_err())
    {
        out.push(issue(
            action_id,
            "to_invalid",
            format!("Invalid email address: {bad}"),
            "Each recipient must be a valid RFC 5322 address.",
            ERROR,
        ));
    }
    if def.action.subject.is_blank() {
        out.push(issue(
            action_id,
            "subject_empty",
            "Subject is required",
            "",
            ERROR,
        ));
    }
    if def.action.body.parts.is_empty() {
        out.push(issue(
            action_id,
            "body_empty",
            "Add some content to the email body",
            "",
            ERROR,
        ));
    }
}

fn add_record_issues(def: &WorkflowDefinition, action_id: &str, out: &mut Vec<NodeIssue>) {
    let Some(cfg) = def
        .action
        .add_record
        .as_ref()
        .filter(|c| !c.target_table_id.trim().is_empty())
    else {
        out.push(issue(
            action_id,
            "action_add_record_target_missing",
            "Pick a target table for this action",
            "The add_record action writes a new row into the table you choose here.",
            ERROR,
        ));
        return;
    };
    let trigger_table = def.trigger.table_id.trim();
    if !trigger_table.is_empty() && trigger_table == cfg.target_table_id.trim() {
        out.push(issue(
            action_id,
            "add_record_target_equals_trigger_table",
            "Action writes back to the trigger table",
            "Pick a different target table — writing into the trigger table would re-fire the trigger and loop forever.",
            ERROR,
        ));
    }
    if !cfg.fields.iter().any(|f| !f.value.parts.is_empty()) {
        out.push(issue(
            action_id,
            "action_add_record_fields_empty",
            "Fill in at least one field",
            "Add a value to at least one of the target table's fields — empty rows are rejected at runtime.",
            ERROR,
        ));
    }
}

fn connection_issues(
    def: &WorkflowDefinition,
    action_id: &str,
    lookup: Option<ConnectionLookup<'_>>,
    out: &mut Vec<NodeIssue>,
) {
    let id = def.action.connection_id.trim();
    if id.is_empty() {
        out.push(issue(
            action_id,
            "connection_missing",
            "No connection selected",
            "Pick or create an SMTP connection so the action can be tested.",
            WARNING,
        ));
        return;
    }
    let Some(lookup) = lookup else { return };
    match lookup(id) {
        None => out.push(issue(
            action_id,
            "connection_missing",
            "The selected connection no longer exists",
            "Open the action and pick a different connection.",
            ERROR,
        )),
        Some(conn) if conn.status == STATUS_INVALID => {
            let message = if !conn.last_error_message.trim().is_empty() {
                conn.last_error_message.trim().to_owned()
            } else if !conn.name.is_empty() {
                format!("Connection {} failed its last test", conn.name)
            } else {
                "The selected connection failed its last test".to_owned()
            };
            out.push(issue(
                action_id,
                "connection_invalid",
                message,
                "Fix or replace the connection to enable this workflow.",
                ERROR,
            ));
        }
        Some(_) => {}
    }
}
