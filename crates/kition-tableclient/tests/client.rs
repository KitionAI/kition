//! The host table client against the headless Table kit: files no editor has open are read,
//! written as a host feature (never an undo step), and saved.
//!
//! Runs when the kit's executable is found: `KITION_KIT_TABLE_BINARY`, or a debug build in the
//! sibling checkout (`../kition-table/target/debug/kition-table`). Otherwise it is skipped.

use std::path::PathBuf;

use kition_kits::{Caller, KitManager};
use kition_tableclient::TableClient;
use serde_json::{Map, Value, json};

fn executable() -> Option<PathBuf> {
    if let Some(path) =
        std::env::var_os("KITION_KIT_TABLE_BINARY").filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(path));
    }
    let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../kition-table/target/debug/kition-table")
        .with_extension(std::env::consts::EXE_EXTENSION);
    sibling.is_file().then_some(sibling)
}

fn values(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// The table kit `executable` was built from (its repository's kit.json).
fn table_kit(executable: &std::path::Path) -> &'static kition_kits::KitDefinition {
    let Some(manifest) = kition_kits::definitions::manifest_beside(executable) else {
        panic!("{}: no kit.json above it names it", executable.display())
    };
    kition_kits::KitDefinition::from_manifest_text(&manifest)
        .unwrap_or_else(|error| panic!("{error}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn host_features_write_closed_files_through_the_kit() {
    let Some(executable) = executable() else {
        eprintln!(
            "skipped: build kition-table (cargo build -p kition-table in ../kition-table) or set KITION_KIT_TABLE_BINARY"
        );
        return;
    };
    let kit = table_kit(&executable);
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(
        Some(dir.path().to_path_buf()),
        vec![(kit, Some(executable))],
    );
    let client = TableClient::new(kits.clone());

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

    // A host feature's record, by field id: saved to the file, and not the person's undo.
    let stamp = client.stamp("crm/Leads.ktable");
    assert!(stamp.is_some() && client.stamp("crm/Missing.ktable").is_none());
    let record = client
        .create_record(
            "crm/Leads.ktable",
            &table.id,
            &values(json!({ title.id.clone(): "Ada" })),
            "system:host",
        )
        .await
        .unwrap_or_else(|err| panic!("create record: {err}"));
    assert_eq!(record.values.get(&title.name), Some(&json!("Ada")));
    assert_ne!(
        client.stamp("crm/Leads.ktable"),
        stamp,
        "a write changes the file's stamp"
    );
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
            "system:host",
        )
        .await
        .unwrap_or_else(|err| panic!("update: {err}"));
    assert_eq!(updated.get(&title.name), Some(&json!("Ada Lovelace")));

    // The agent edits the file headless and saves.
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
    assert_eq!(
        attachment["mimeType"], "text/plain",
        "the attachment keeps the MIME type it was put with: {attachment}"
    );
    assert!(
        client
            .records("crm/Missing.ktable", "1")
            .await
            .is_err_and(|err| err.not_found)
    );
}
