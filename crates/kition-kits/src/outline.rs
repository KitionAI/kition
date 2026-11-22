// Copied from kition-sdk crates/kition-kits/src/outline.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A document's outline: the parts of a file a host can list under it and open the file at (a
//! table file's tables and dashboards, a deck's slides, a workbook's sheets).
//!
//! A kit that has one names the engine command that answers it in its manifest
//! (`kit.json` `outline.command`, platform K24). The command takes no parameters, changes
//! nothing, and answers `{ "items": [{ "id", "title", "kind"?, "view" }] }`: `view` is the place
//! in the document as the Kit UI protocol's `document.view` and `document/reveal` take it, so a
//! host opens the file there without knowing what the part is.
//!
//! The answer comes from the file's open editor when a renderer window has it (the Kit AI
//! bridge), so it shows edits not saved yet; otherwise from the headless kit, which opens the
//! file, answers, and closes it. The headless answer is kept until the file changes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::manager::{Caller, KitError, KitManager};

/// One part of a document.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OutlineItem {
    /// The part's id in the document, as the kit names it.
    pub id: String,
    /// What people call it.
    pub title: String,
    /// What it is, in the kit's words (`table`, `dashboard`, `slide`); a host may show an icon by it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Where it is: the Kit UI `view` that opens the document at it.
    pub view: Value,
}

/// The headless answers kept, by the file's absolute path, with the file's modification time.
static KEPT: Mutex<Option<Kept>> = Mutex::new(None);

type Kept = HashMap<PathBuf, (SystemTime, Vec<OutlineItem>)>;

fn kept(file: &PathBuf, modified: SystemTime) -> Option<Vec<OutlineItem>> {
    let kept = KEPT.lock().unwrap_or_else(PoisonError::into_inner);
    kept.as_ref()?.get(file).filter(|(when, _)| *when == modified).map(|(_, items)| items.clone())
}

fn keep(file: PathBuf, modified: SystemTime, items: &[OutlineItem]) {
    KEPT.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_with(HashMap::new).insert(file, (modified, items.to_vec()));
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The items of an outline command's answer. An answer of another shape is the kit's fault and an
/// error: a host that showed part of it would hide the rest.
pub fn items(command: &str, answer: Option<&Value>) -> Result<Vec<OutlineItem>, KitError> {
    let wrong = |what: String| {
        KitError::Unavailable(format!("the outline command `{command}` {what}; it answers {{ \"items\": [{{ \"id\", \"title\", \"kind\"?, \"view\" }}] }}"))
    };
    let listed = answer.and_then(|answer| answer.get("items")).and_then(Value::as_array).ok_or_else(|| wrong("answered no `items` list".to_owned()))?;
    listed
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let id = item.get("id").and_then(text).ok_or_else(|| wrong(format!("answered item {index} without an `id`")))?;
            let title = item.get("title").and_then(Value::as_str).ok_or_else(|| wrong(format!("answered item {index} without a `title`")))?;
            let view = item.get("view").filter(|view| view.is_object()).ok_or_else(|| wrong(format!("answered item {index} without a `view` object")))?;
            Ok(OutlineItem { id, title: title.to_owned(), kind: item.get("kind").and_then(Value::as_str).map(str::to_owned), view: view.clone() })
        })
        .collect()
}

/// The outline of the workspace file `path`; `None` when its kit declares no outline command.
pub async fn outline(kits: &KitManager, path: &str) -> Result<Option<Vec<OutlineItem>>, KitError> {
    let file = kits.resolve(path)?;
    let kit = kits.kit_for_path(path).ok_or_else(|| KitError::InvalidPath(format!("no kit opens `{path}`")))?;
    let Some(command) = kit.outline else {
        return Ok(None);
    };
    if let Some(document) = kits.bridge().find(path).await
        && document.kit == kit.id
    {
        let answer = kits
            .bridge()
            .call(&document, "run", json!({ "steps": [{ "command": command, "params": {} }], "save": false }))
            .await
            .map_err(|failure| KitError::Unavailable(failure.message))?;
        return items(command, answer["completed"].get(0).and_then(|step| step.get("result"))).map(Some);
    }
    let modified = std::fs::metadata(&file).and_then(|meta| meta.modified()).map_err(|_| KitError::InvalidPath(format!("`{path}` does not exist")))?;
    if let Some(items) = kept(&file, modified) {
        return Ok(Some(items));
    }
    let already_open = kits.open_files().await.iter().any(|(open_kit, open)| *open_kit == kit.id && open == path);
    let view = kits.open(Caller::User, path).await?;
    let executed = kits.execute(Caller::User, kit.id, &view.document_id, command, Map::new()).await;
    if !already_open {
        // Reading an outline leaves nothing open and nothing changed.
        let _ = kits.close(kit.id, &view.document_id, true).await;
    }
    let listed = items(command, executed?.result.as_ref())?;
    keep(file, modified, &listed);
    Ok(Some(listed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_items_of_an_answer() {
        let answer = json!({ "items": [
            { "id": "tbl1", "title": "Tasks", "kind": "table", "view": { "path": "tables/tbl1" } },
            { "id": 7, "title": "", "view": { "path": "dashboards/7" }, "extra": true }
        ] });
        assert_eq!(
            items("file.outline", Some(&answer)).unwrap(),
            vec![
                OutlineItem { id: "tbl1".into(), title: "Tasks".into(), kind: Some("table".into()), view: json!({ "path": "tables/tbl1" }) },
                OutlineItem { id: "7".into(), title: String::new(), kind: None, view: json!({ "path": "dashboards/7" }) },
            ]
        );
        assert_eq!(items("file.outline", Some(&json!({ "items": [] }))).unwrap(), Vec::new());
    }

    #[test]
    fn refuses_an_answer_of_another_shape() {
        for (answer, says) in [
            (None, "answered no `items` list"),
            (Some(json!({ "tables": [] })), "answered no `items` list"),
            (Some(json!({ "items": [{ "title": "Tasks", "view": {} }] })), "answered item 0 without an `id`"),
            (Some(json!({ "items": [{ "id": "a", "view": {} }] })), "answered item 0 without a `title`"),
            (
                Some(json!({ "items": [{ "id": "a", "title": "A", "view": {} }, { "id": "b", "title": "B", "view": "tables/b" }] })),
                "answered item 1 without a `view` object",
            ),
        ] {
            let error = items("file.outline", answer.as_ref()).unwrap_err().to_string();
            assert!(error.contains("`file.outline`") && error.contains(says), "{error}");
        }
    }

    #[test]
    fn serializes_an_item_without_a_missing_kind() {
        let item = OutlineItem { id: "a".into(), title: "A".into(), kind: None, view: json!({ "path": "a" }) };
        assert_eq!(serde_json::to_value(&item).unwrap(), json!({ "id": "a", "title": "A", "view": { "path": "a" } }));
    }
}
