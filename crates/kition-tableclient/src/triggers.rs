//! Workflow triggers from edits the host did not make itself.
//!
//! Kition's own writes (workflows) publish `RecordCreated` and
//! `RecordUpdated` as they write. Everyone else's edits happen inside the Table kit: the
//! person's and a collaborator's in an open editor, the agent's in the editor or the headless
//! kit. The watcher asks the kit what changed since the version it last saw
//! (`table.changes.since`) when an open editor reports an edit (`kit.changed` on the bridge) or
//! the headless kit saves a file, and publishes the same events for records that people, the
//! agent, or extensions created or updated. Writes under a `system:` or `import:` origin are not
//! reported: the host published its own already, and imports never triggered workflows.
//!
//! The version reported up to is kept per file in the workspace (`.kition/tables/changes.json`),
//! so after a restart the first report starts where the last one stopped: edits made in between
//! are reported, and none is reported twice.

use std::collections::HashMap;
use std::time::Duration;

use kition_core::events::{DomainEvent, RecordCreated, RecordUpdated};
use kition_kits::{Caller, LiveChange, SavedFile};
use serde_json::{Map, Value, json};

use crate::{RecordInfo, Step, TABLE_KIT, TableClient, is_table_path, record_info};

/// The user record events name: Kition runs for one local person.
const USER_ID: i64 = 1;
/// How long a burst of edits in an open editor settles before the watcher asks what changed.
const SETTLE: Duration = Duration::from_millis(400);

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// The record events the workflow engine subscribes to, for a table file's record.
pub mod record_events {
    use super::*;

    pub fn created(path: &str, table_id: &str, record: &RecordInfo) -> DomainEvent {
        DomainEvent::RecordCreated(RecordCreated {
            user_id: USER_ID,
            document_path: path.to_owned(),
            table_id: table_id.to_owned(),
            record_id: record.id.clone(),
            fields: record.values.clone(),
            created_at: now(),
        })
    }

    pub fn updated(
        path: &str,
        table_id: &str,
        record: &RecordInfo,
        previous: Option<Map<String, Value>>,
    ) -> DomainEvent {
        DomainEvent::RecordUpdated(RecordUpdated {
            user_id: USER_ID,
            document_path: path.to_owned(),
            table_id: table_id.to_owned(),
            record_id: record.id.clone(),
            fields: record.values.clone(),
            previous,
            updated_at: now(),
        })
    }
}

/// Whether a write's origin is one the triggers report.
fn reported(origin: &str) -> bool {
    !(origin.starts_with("system:") || origin.starts_with("import:"))
}

/// The records `changes.since` answered as created and as updated by reported origins, as
/// `(table id, record id)`; a record both created and updated is created only.
/// A record of a table, as `(table id, record id)`.
type RecordKey = (String, String);

pub(crate) fn reported_changes(since: &Value) -> (Vec<RecordKey>, Vec<RecordKey>) {
    let pick = |key: &str| -> Vec<RecordKey> {
        let mut out: Vec<RecordKey> = Vec::new();
        for change in since[key].as_array().into_iter().flatten() {
            if !reported(change["origin"].as_str().unwrap_or_default()) {
                continue;
            }
            let id = |value: &Value| match value {
                Value::Number(number) => number.to_string(),
                Value::String(text) => text.clone(),
                _ => String::new(),
            };
            let entry = (id(&change["tableId"]), id(&change["recordId"]));
            if !entry.0.is_empty() && !entry.1.is_empty() && !out.contains(&entry) {
                out.push(entry);
            }
        }
        out
    };
    let created = pick("created");
    let updated = pick("updated")
        .into_iter()
        .filter(|entry| !created.contains(entry))
        .collect();
    (created, updated)
}

/// Follows the bridge's live edits and the headless kit's saves of table files for the life of
/// the process, and publishes record events for them.
pub struct TriggerWatcher;

impl TriggerWatcher {
    pub fn start(client: TableClient) {
        let mut live = client.kits().bridge().subscribe_changes();
        let mut saves = client.kits().subscribe_saves();
        let (settled_tx, mut settled) = tokio::sync::mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            // The paths with a report pending, so a burst of edits asks once.
            let mut pending: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
            loop {
                tokio::select! {
                    change = live.recv() => match change {
                        Ok(LiveChange { path, .. }) if is_table_path(&path) => {
                            if let Some(waiting) = pending.remove(&path) {
                                waiting.abort();
                            }
                            let tx = settled_tx.clone();
                            let settled_path = path.clone();
                            pending.insert(path, tokio::spawn(async move {
                                tokio::time::sleep(SETTLE).await;
                                let _ = tx.send(settled_path);
                            }));
                        }
                        Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    },
                    Some(path) = settled.recv() => {
                        pending.remove(&path);
                        let client = client.clone();
                        tokio::spawn(async move { client.report_live(&path).await });
                    }
                    saved = saves.recv() => match saved {
                        Ok(SavedFile { kit_id, path, document_id }) if kit_id == TABLE_KIT => {
                            let client = client.clone();
                            tokio::spawn(async move { client.report_saved(&path, &document_id).await });
                        }
                        Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    },
                }
            }
        });
    }
}

impl TableClient {
    /// An open editor's edits settled: report what changed since the last version seen.
    async fn report_live(&self, path: &str) {
        let since = self.version(path).unwrap_or_default();
        let Ok(answer) = self
            .request(path, "changes.since", json!({ "version": since }), None)
            .await
        else {
            // A version this replica never reached (another copy's): start from now.
            if let Ok(now) = self
                .request(path, "changes.since", json!({ "version": "" }), None)
                .await
                && let Some(version) = now["version"].as_str()
            {
                self.set_version(path, version.to_owned());
            }
            return;
        };
        if since.is_empty() {
            // Nothing seen yet: everything is older than this report.
            if let Some(version) = answer["version"].as_str() {
                self.set_version(path, version.to_owned());
            }
            return;
        }
        self.publish_changes(path, &answer).await;
    }

    /// The headless kit saved `path` (an agent's edit): report what changed since the last
    /// version seen, on the document it saved.
    async fn report_saved(&self, path: &str, document_id: &str) {
        let since = self.version(path).unwrap_or_default();
        let ask = |version: String| {
            let mut params = Map::new();
            params.insert("version".into(), Value::String(version));
            self.kits().execute(
                Caller::User,
                TABLE_KIT,
                document_id,
                "table.changes.since",
                params,
            )
        };
        // A document the agent closed already is reported with the next change: the cursor
        // stays where it was.
        let answer = match ask(since.clone()).await {
            Ok(executed) => executed.result.map(|answer| answer["result"].clone()),
            Err(_) => ask(String::new())
                .await
                .ok()
                .and_then(|executed| executed.result.map(|answer| answer["result"].clone()))
                .map(|now| json!({ "version": now["version"] })),
        };
        let Some(answer) = answer else { return };
        if since.is_empty() {
            if let Some(version) = answer["version"].as_str() {
                self.set_version(path, version.to_owned());
            }
            return;
        }
        self.publish_changes(path, &answer).await;
    }

    async fn publish_changes(&self, path: &str, answer: &Value) {
        if let Some(version) = answer["version"].as_str() {
            self.set_version(path, version.to_owned());
        }
        let (created, updated) = reported_changes(answer);
        let mut tables: Vec<&String> = created
            .iter()
            .chain(&updated)
            .map(|(table, _)| table)
            .collect();
        tables.sort();
        tables.dedup();
        for table in tables {
            let Ok(page) = self
                .run(
                    path,
                    vec![Step::new("records.list", json!({ "tableId": table.parse::<i64>().map_or_else(|_| json!(table), Value::from) }))],
                    None,
                )
                .await
            else {
                continue;
            };
            let records: Vec<RecordInfo> = page
                .first()
                .and_then(|answer| answer["items"].as_array())
                .map(|items| items.iter().map(record_info).collect())
                .unwrap_or_default();
            for (_, record_id) in created.iter().filter(|(of, _)| of == table) {
                if let Some(record) = records.iter().find(|record| record.id == *record_id) {
                    self.events()
                        .publish(record_events::created(path, table, record));
                }
            }
            for (_, record_id) in updated.iter().filter(|(of, _)| of == table) {
                if let Some(record) = records.iter().find(|record| record.id == *record_id) {
                    self.events()
                        .publish(record_events::updated(path, table, record, None));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_people_agents_and_extensions_not_the_host() {
        let since = json!({
            "version": "v2",
            "created": [
                { "tableId": 1, "recordId": 7, "origin": "person:kit" },
                { "tableId": 1, "recordId": 8, "origin": "system:workflow" },
                { "tableId": 1, "recordId": 9, "origin": "import:import" }
            ],
            "updated": [
                { "tableId": 1, "recordId": 7, "fieldIds": [3], "origin": "person:kit" },
                { "tableId": 2, "recordId": 4, "fieldIds": [1], "origin": "agent:turn-1" },
                { "tableId": 2, "recordId": 5, "fieldIds": [1], "origin": "system:workflow" }
            ],
            "deleted": []
        });
        let (created, updated) = reported_changes(&since);
        assert_eq!(created, vec![("1".to_owned(), "7".to_owned())]);
        assert_eq!(updated, vec![("2".to_owned(), "4".to_owned())]);
    }
}
