//! The host table client against the headless Table kit: files no editor has open are read,
//! written as a host feature (never an undo step), saved, and reported to workflow triggers.
//!
//! Runs when the kit's executable is found: `KITION_KIT_TABLE_BINARY`, or a debug build in the
//! sibling checkout (`../kition-table/target/debug/kit-table`). Otherwise it is skipped.

use std::path::PathBuf;
use std::time::Duration;

use kition_core::events::{DomainEvent, EventBus};
use kition_kits::{Caller, KITS, KitManager};
use kition_tableclient::{TableClient, TriggerWatcher};
use serde_json::{Map, Value, json};

fn executable() -> Option<PathBuf> {
    if let Some(path) =
        std::env::var_os("KITION_KIT_TABLE_BINARY").filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(path));
    }
    let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../kition-table/target/debug/kit-table")
        .with_extension(std::env::consts::EXE_EXTENSION);
    sibling.is_file().then_some(sibling)
}

fn values(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

async fn next_event(
    events: &mut tokio::sync::broadcast::Receiver<DomainEvent>,
) -> Option<DomainEvent> {
    tokio::time::timeout(Duration::from_secs(10), events.recv())
        .await
        .ok()?
        .ok()
}

#[tokio::test(flavor = "multi_thread")]
async fn host_features_write_closed_files_through_the_kit() {
    let Some(executable) = executable() else {
        eprintln!(
            "skipped: build kit-table (cargo build -p kit-table in ../kition-table) or set KITION_KIT_TABLE_BINARY"
        );
        return;
    };
    let kit = KITS
        .iter()
        .find(|kit| kit.id == "kit.table")
        .unwrap_or_else(|| panic!("no table kit"));
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(
        Some(dir.path().to_path_buf()),
        vec![(kit, Some(executable))],
    );
    let bus = EventBus::default();
    let client = TableClient::new(kits.clone(), bus.clone());
    TriggerWatcher::start(client.clone());
    let mut events = bus.subscribe();

    let tables = client
        .create_file("crm/Leads.ktable", Some("Leads"))
        .await
        .unwrap_or_else(|err| panic!("create: {err}"));
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].title, "Leads");
    assert!(dir.path().join("crm/Leads.ktable").is_file());
    assert!(
        client.create_file("crm/Leads.ktable", None).await.is_err(),
        "an existing file is never replaced"
    );
    assert_eq!(client.table_files(), vec!["crm/Leads.ktable".to_owned()]);
    let table = tables[0].clone();
    let title = table
        .fields
        .iter()
        .find(|field| field.primary)
        .unwrap_or_else(|| panic!("no primary field"));

    // A workflow's record, by field id: saved to the file, reported, and not the person's undo.
    let stamp = client.stamp("crm/Leads.ktable");
    assert!(stamp.is_some() && client.stamp("crm/Missing.ktable").is_none());
    let record = client
        .create_record(
            "crm/Leads.ktable",
            &table.id,
            &values(json!({ title.id.clone(): "Ada" })),
            "system:workflow",
        )
        .await
        .unwrap_or_else(|err| panic!("create record: {err}"));
    assert_eq!(record.values.get(&title.name), Some(&json!("Ada")));
    assert_ne!(
        client.stamp("crm/Leads.ktable"),
        stamp,
        "a write changes the stamp search reads again by"
    );
    match next_event(&mut events).await {
        Some(DomainEvent::RecordCreated(created)) => {
            assert_eq!(created.document_path, "crm/Leads.ktable");
            assert_eq!(created.table_id, table.id);
            assert_eq!(created.record_id, record.id);
        }
        other => panic!("expected RecordCreated, got {other:?}"),
    }
    let reread = client
        .records("crm/Leads.ktable", &table.id)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(reread.len(), 1, "the write reached the file");
    let history = client
        .request("crm/Leads.ktable", "historyState", json!({}), None)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_ne!(
        history["canUndo"], true,
        "host writes are not undo steps: {history}"
    );

    let updated = client
        .update_record(
            "crm/Leads.ktable",
            &table.id,
            &record.id,
            &values(json!({ "Title": "Ada Lovelace" })),
            "system:workflow",
        )
        .await
        .unwrap_or_else(|err| panic!("update: {err}"));
    assert_eq!(updated.get(&title.name), Some(&json!("Ada Lovelace")));
    match next_event(&mut events).await {
        Some(DomainEvent::RecordUpdated(update)) => {
            assert_eq!(update.record_id, record.id);
            assert_eq!(
                update
                    .previous
                    .as_ref()
                    .and_then(|values| values.get(&title.name)),
                Some(&json!("Ada"))
            );
        }
        other => panic!("expected RecordUpdated, got {other:?}"),
    }

    // The agent edits the file headless and saves: the watcher reports the new record.
    let view = kits
        .open(Caller::Agent, "crm/Leads.ktable")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    kits.execute(
        Caller::Agent,
        "kit.table",
        &view.document_id,
        "table.records.create",
        values(json!({ "tableId": table.id.parse::<i64>().unwrap_or_default(), "values": { title.name.clone(): "Grace" } })),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    kits.save(Caller::Agent, "kit.table", &view.document_id)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    match next_event(&mut events).await {
        Some(DomainEvent::RecordCreated(created)) => {
            assert_eq!(created.fields.get(&title.name), Some(&json!("Grace")));
        }
        other => panic!("expected the agent's RecordCreated, got {other:?}"),
    }
    kits.close("kit.table", &view.document_id, false)
        .await
        .unwrap_or_else(|err| panic!("{err}"));

    let described = client
        .describe_cached("crm/Leads.ktable")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(described.tables.len(), 1);
    assert!(
        described
            .document_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
    );
    let attachment = client
        .put_attachment(
            "crm/Leads.ktable",
            &table.id,
            "a.txt",
            "text/plain",
            b"hello",
            "system:design",
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert!(
        attachment.is_object() || attachment.is_array(),
        "{attachment}"
    );
    assert!(
        client
            .records("crm/Missing.ktable", "1")
            .await
            .is_err_and(|err| err.not_found)
    );
}

/// The agent adds a record to `path` headless and saves it; answers the document, which the
/// caller closes once the watcher reported it.
async fn agent_adds(
    kits: &KitManager,
    path: &str,
    table_id: &str,
    field: &str,
    value: &str,
) -> String {
    let view = kits
        .open(Caller::Agent, path)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    kits.execute(
        Caller::Agent,
        "kit.table",
        &view.document_id,
        "table.records.create",
        values(json!({ "tableId": table_id.parse::<i64>().unwrap_or_default(), "values": { field: value } })),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    kits.save(Caller::Agent, "kit.table", &view.document_id)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    view.document_id
}

#[tokio::test(flavor = "multi_thread")]
async fn triggers_resume_after_a_restart_without_dropping_or_replaying_edits() {
    let Some(executable) = executable() else {
        eprintln!("skipped: no kit-table executable");
        return;
    };
    let kit = KITS
        .iter()
        .find(|kit| kit.id == "kit.table")
        .unwrap_or_else(|| panic!("no table kit"));
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let path = "Leads.ktable";

    // Before the restart: the host reads the file (a workflow is set up on it), so its cursor is
    // the file's version then; Grace is reported.
    let (table_id, field) = {
        let kits = KitManager::new(
            Some(dir.path().to_path_buf()),
            vec![(kit, Some(executable.clone()))],
        );
        let bus = EventBus::default();
        let client = TableClient::new(kits.clone(), bus.clone());
        TriggerWatcher::start(client.clone());
        let mut events = bus.subscribe();
        let tables = client
            .create_file(path, Some("Leads"))
            .await
            .unwrap_or_else(|err| panic!("create: {err}"));
        let table = tables[0].clone();
        let field = table
            .fields
            .iter()
            .find(|field| field.primary)
            .map(|field| field.name.clone())
            .unwrap_or_default();
        let document = agent_adds(&kits, path, &table.id, &field, "Grace").await;
        match next_event(&mut events).await {
            Some(DomainEvent::RecordCreated(created)) => {
                assert_eq!(created.fields.get(&field), Some(&json!("Grace")));
            }
            other => panic!("expected Grace's RecordCreated, got {other:?}"),
        }
        let _ = kits.close("kit.table", &document, false).await;
        kits.shutdown().await;
        (table.id, field)
    };
    assert!(dir.path().join(".kition/tables/changes.json").is_file());
    // While the runtime is down (or before its watcher heard of it), the agent adds Ada.
    {
        let kits = KitManager::new(
            Some(dir.path().to_path_buf()),
            vec![(kit, Some(executable.clone()))],
        );
        let document = agent_adds(&kits, path, &table_id, &field, "Ada").await;
        let _ = kits.close("kit.table", &document, false).await;
        kits.shutdown().await;
    }

    // After the restart: the next report carries Ada's record, made while no watcher ran, and
    // Linus's, and not Grace's again.
    let kits = KitManager::new(
        Some(dir.path().to_path_buf()),
        vec![(kit, Some(executable))],
    );
    let bus = EventBus::default();
    let client = TableClient::new(kits.clone(), bus.clone());
    TriggerWatcher::start(client);
    let mut events = bus.subscribe();
    agent_adds(&kits, path, &table_id, &field, "Linus").await;
    let mut names = Vec::new();
    while let Some(event) = next_event(&mut events).await {
        if let DomainEvent::RecordCreated(created) = event {
            names.push(created.fields.get(&field).cloned().unwrap_or_default());
        }
        if names.len() == 2 {
            break;
        }
    }
    assert_eq!(names, vec![json!("Ada"), json!("Linus")]);
    assert!(
        tokio::time::timeout(Duration::from_millis(800), events.recv())
            .await
            .is_err(),
        "nothing else is reported"
    );
}
