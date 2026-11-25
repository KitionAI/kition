// Copied from kition-sdk crates/kition-kit-host/tests/document_identity.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `document.identity` and `document.fork` (Kit Process Protocol section 5.6) through a real kit
//! process: the mock kit with `KITION_KIT_MOCK_FILE_REPLICA=1` keeps its document's replica inside
//! its file, as the board, table, layout, design and scene kits do, so a byte copy of the file is
//! the same document. A host reads the identity a file carries without parsing the kit's format,
//! and forks a file into a new document: a new docId, the same content and object ids, no
//! history, and the source and the fork refuse each other's changes. Without the variable the mock
//! declares neither method and answers both "method not found".
//!
//! Needs the mock kit built (`cargo build -p kition-kit-mock`); skipped locally with a note
//! without it, required in CI.

use std::path::{Path, PathBuf};
use std::time::Duration;

use kition_kit_host::protocol::base64;
use kition_kit_host::{ClientError, HeadlessKit, LaunchOptions};
use serde_json::{Value, json};

mod common;

const LIMIT: Duration = Duration::from_secs(20);

/// Where the mock's file keeps its replica: the text, this line, then the content in base64.
const REPLICA_MARK: &str = "\n%%kition-mock-replica%%\n";

const SECRET: &str = "SECRET-DELETED-BEFORE-THE-FORK";

fn workspace(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kit-identity-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

async fn launch(dir: &Path, file_replica: bool) -> Option<HeadlessKit> {
    launch_with(dir, if file_replica { &[("KITION_KIT_MOCK_FILE_REPLICA", "1")] } else { &[] }).await
}

async fn launch_with(dir: &Path, env: &[(&str, &str)]) -> Option<HeadlessKit> {
    let Some(mock) = common::workspace_binary("kition-kit-mock") else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return None;
    };
    let mut options = LaunchOptions::new(&mock);
    options.workspace = Some(dir.to_path_buf());
    options.env.extend(env.iter().map(|(name, value)| ((*name).into(), (*value).into())));
    Some(HeadlessKit::launch(options).await.unwrap())
}

async fn batch(kit: &HeadlessKit, document: &Value, request: Value) -> Result<Value, ClientError> {
    let mut request = request;
    request["documentId"] = document.clone();
    request["origin"] = json!({ "kind": "person", "principal": "person:test" });
    kit.request("model.batch", request, LIMIT).await
}

/// Every object of the document with its fields, by id: what must be equal in a fork.
async fn objects(kit: &HeadlessKit, path: &str) -> Value {
    let state = kit.open(path, true, LIMIT).await.unwrap();
    let document = state["documentId"].clone();
    let inventory = batch(kit, &document, json!({ "ops": [], "objects": true })).await.unwrap();
    let ids: Vec<Value> = inventory["objects"].as_array().unwrap().iter().map(|object| object["id"].clone()).collect();
    assert!(ids.len() >= 3, "the root and two tags: {inventory}");
    let load: Vec<Value> = ids.iter().map(|id| json!({ "target": id })).collect();
    let loaded = batch(kit, &document, json!({ "ops": [], "load": load })).await.unwrap();
    kit.request("document.close", json!({ "documentId": document }), LIMIT).await.unwrap();
    json!({ "objects": inventory["objects"], "loaded": loaded["loaded"] })
}

/// The replica a mock file embeds, decoded.
fn embedded(file: &Path) -> Vec<u8> {
    let text = std::fs::read_to_string(file).unwrap();
    let (_, replica) = text.split_once(REPLICA_MARK).unwrap_or_else(|| panic!("no replica in {}", file.display()));
    base64::decode(replica.trim()).unwrap()
}

/// What the kit said about a refusal (`error.data.detail`).
fn detail(error: &ClientError) -> String {
    error.data().and_then(|data| data["detail"].as_str()).unwrap_or_default().to_owned()
}

fn holds(bytes: &[u8], needle: &str) -> bool {
    bytes.windows(needle.len()).any(|window| window == needle.as_bytes())
}

/// A document made, edited (a tag made and deleted again on the way) and saved in `path`.
async fn made(kit: &HeadlessKit, path: &str) {
    let state = kit.create(path, "mock.text", LIMIT).await.unwrap();
    let document = state["documentId"].clone();
    let ops = json!([
        { "op": "text.insert", "target": "root", "field": "text", "index": 0, "text": "Kept words" },
        { "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": "kept" } },
        { "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": SECRET }, "ref": "$secret" },
    ]);
    let made = batch(kit, &document, json!({ "ops": ops })).await.unwrap();
    let secret = made["refs"]["$secret"].clone();
    batch(kit, &document, json!({ "ops": [{ "op": "delete", "target": secret }] })).await.unwrap();
    batch(kit, &document, json!({ "ops": [{ "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": "also kept" } }] })).await.unwrap();
    kit.request("document.save", json!({ "documentId": document }), LIMIT).await.unwrap();
    kit.request("document.close", json!({ "documentId": document }), LIMIT).await.unwrap();
}

/// The document's changes, as `model.export` answers them.
async fn changes_of(kit: &HeadlessKit, path: &str) -> (Value, String) {
    let state = kit.open(path, false, LIMIT).await.unwrap();
    let document = state["documentId"].clone();
    let exported = kit.request("model.export", json!({ "documentId": document }), LIMIT).await.unwrap();
    (document, exported["changes"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn a_file_that_embeds_its_replica_tells_its_identity_and_forks_into_a_new_document() {
    let dir = workspace("embedded");
    let Some(kit) = launch(&dir, true).await else { return };
    assert!(kit.serves("document.identity"), "{}", kit.capabilities());
    made(&kit, "a.mocktext").await;

    // The identity the file carries, read without opening it, and the same for a byte copy.
    let source = kit.identity("a.mocktext", LIMIT).await.unwrap();
    let source_id = source.doc_id.clone().expect("a file that embeds its replica has an identity");
    std::fs::copy(dir.join("a.mocktext"), dir.join("copy.mocktext")).unwrap();
    assert_eq!(kit.identity("copy.mocktext", LIMIT).await.unwrap().doc_id.as_deref(), Some(source_id.as_str()), "a byte copy is the same document");

    // A fork is a new document with the same content and object ids.
    let fork = kit.fork("a.mocktext", "b.mocktext", LIMIT).await.unwrap();
    let fork_id = fork.doc_id.clone().expect("the fork's identity");
    assert_ne!(fork_id, source_id);
    assert_eq!(fork.name, "b.mocktext");
    assert!(!fork.version.is_empty());
    assert_eq!(kit.identity("b.mocktext", LIMIT).await.unwrap().doc_id.as_deref(), Some(fork_id.as_str()), "the forked file carries the new id");
    assert_eq!(kit.identity("a.mocktext", LIMIT).await.unwrap().doc_id.as_deref(), Some(source_id.as_str()), "the source is unchanged");
    assert_eq!(objects(&kit, "b.mocktext").await, objects(&kit, "a.mocktext").await, "the same objects, ids and values");
    let text = std::fs::read_to_string(dir.join("b.mocktext")).unwrap();
    assert!(text.starts_with("Kept words"), "{text}");

    // No history: a replica holds the document's state alone (plan 2026-11-24), so the deleted
    // tag's name is in neither the source's replica nor the fork's.
    assert!(!holds(&embedded(&dir.join("a.mocktext")), SECRET), "a replica holds no deleted content");
    assert!(!holds(&embedded(&dir.join("b.mocktext")), SECRET), "deleted content does not travel");

    // The source and the fork refuse each other's changes.
    let (a, a_changes) = changes_of(&kit, "a.mocktext").await;
    let (b, b_changes) = changes_of(&kit, "b.mocktext").await;
    let refused = kit.request("model.import", json!({ "documentId": b, "changes": a_changes }), LIMIT).await.unwrap_err();
    assert!(detail(&refused).contains("belong to document"), "{refused}: {:?}", refused.data());
    let refused = kit.request("model.import", json!({ "documentId": a, "changes": b_changes }), LIMIT).await.unwrap_err();
    assert!(detail(&refused).contains("belong to document"), "{refused}: {:?}", refused.data());
    kit.request("document.close", json!({ "documentId": a }), LIMIT).await.unwrap();
    kit.request("document.close", json!({ "documentId": b }), LIMIT).await.unwrap();

    // A fork of a fork is a third document, with the content still the same.
    let again = kit.fork("b.mocktext", "c.mocktext", LIMIT).await.unwrap();
    let again_id = again.doc_id.expect("the second fork's identity");
    assert!(again_id != source_id && again_id != fork_id, "{again_id}");
    assert_eq!(objects(&kit, "c.mocktext").await, objects(&kit, "a.mocktext").await);

    // A fork never replaces a file.
    let taken = kit.fork("a.mocktext", "b.mocktext", LIMIT).await.unwrap_err();
    assert_eq!(taken.reason(), Some("file_conflict"), "{taken}");
    assert!(detail(&taken).contains("never replaces"), "{taken}: {:?}", taken.data());
    assert_eq!(kit.identity("b.mocktext", LIMIT).await.unwrap().doc_id.as_deref(), Some(fork_id.as_str()), "the first fork is kept");
    kit.shutdown(Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(dir);
}

/// regressions/issue-kdm-shallow-export: the fork is a new document. The mock
/// answers `model.export` as a kit on the change exchange does (the changes since `since`, every
/// change without one), so a host's draft of the fork (`model.export`, then `model.open`) opens,
/// edits through `model.batch`, and merges back with `model.import`; before, every change of a
/// fork did not load ("meta.kit is missing").
#[tokio::test]
async fn a_draft_of_a_forked_file_opens_from_its_changes_and_merges_back() {
    let dir = workspace("fork-draft");
    let Some(kit) = launch_with(&dir, &[("KITION_KIT_MOCK_FILE_REPLICA", "1"), ("KITION_KIT_MOCK_REPLICA", "full")]).await else { return };
    made(&kit, "a.mocktext").await;
    kit.fork("a.mocktext", "b.mocktext", LIMIT).await.unwrap();
    let state = kit.open("b.mocktext", false, LIMIT).await.unwrap();
    let fork = state["documentId"].clone();
    let all = kit.request("model.export", json!({ "documentId": fork }), LIMIT).await.unwrap();
    let draft = kit.request("model.open", json!({ "name": "b.mocktext", "snapshot": all["changes"] }), LIMIT).await.unwrap();
    let draft = draft["documentId"].clone();
    let base = kit.request("model.version", json!({ "documentId": draft }), LIMIT).await.unwrap()["version"].clone();
    let edit = json!({ "ops": [{ "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": "drafted" } }] });
    batch(&kit, &draft, edit).await.unwrap();
    let changes = kit.request("model.export", json!({ "documentId": draft, "since": base }), LIMIT).await.unwrap();
    kit.request("model.import", json!({ "documentId": fork, "changes": changes["changes"] }), LIMIT).await.unwrap();
    let inventory = batch(&kit, &fork, json!({ "ops": [], "objects": true })).await.unwrap();
    let load: Vec<Value> = inventory["objects"].as_array().unwrap().iter().map(|object| json!({ "target": object["id"] })).collect();
    let loaded = batch(&kit, &fork, json!({ "ops": [], "load": load })).await.unwrap();
    let names: Vec<&str> = loaded["loaded"].as_array().unwrap().iter().filter_map(|object| object["fields"]["name"].as_str()).collect();
    assert!(names.contains(&"drafted") && names.contains(&"kept"), "{loaded}");
    // Every change of the fork after the merge still opens as the document.
    let again = kit.request("model.export", json!({ "documentId": fork }), LIMIT).await.unwrap();
    kit.request("model.open", json!({ "name": "b.mocktext", "snapshot": again["changes"] }), LIMIT).await.unwrap();
    kit.shutdown(Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_file_without_a_replica_has_no_identity_and_forks_into_the_same_bytes() {
    let dir = workspace("plain");
    let Some(kit) = launch(&dir, true).await else { return };
    std::fs::write(dir.join("plain.mocktext"), "words a person wrote elsewhere").unwrap();
    assert_eq!(kit.identity("plain.mocktext", LIMIT).await.unwrap().doc_id, None);
    let fork = kit.fork("plain.mocktext", "plain-copy.mocktext", LIMIT).await.unwrap();
    assert_eq!(fork.doc_id, None);
    assert_eq!(std::fs::read(dir.join("plain-copy.mocktext")).unwrap(), std::fs::read(dir.join("plain.mocktext")).unwrap());
    kit.shutdown(Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_kit_that_does_not_declare_the_feature_answers_method_not_found() {
    let dir = workspace("undeclared");
    let Some(kit) = launch(&dir, false).await else { return };
    assert!(!kit.serves("document.identity"), "{}", kit.capabilities());
    std::fs::write(dir.join("a.mocktext"), "text").unwrap();
    for refused in [kit.identity("a.mocktext", LIMIT).await.unwrap_err(), kit.fork("a.mocktext", "b.mocktext", LIMIT).await.unwrap_err()] {
        assert_eq!(refused.rpc().map(|error| error.code), Some(-32601), "{refused}");
    }
    assert!(!dir.join("b.mocktext").exists());
    kit.shutdown(Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(dir);
}
