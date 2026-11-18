// Copied from kition-sdk crates/kition-kit-mock/src/structure.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A workbook whose row edits and sheet renames settle addresses, formulas and owning-map keys.
use std::sync::{Arc, LazyLock};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx};
use serde_json::{Map, Value, json};

pub static STRUCTURE: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_ORDER").as_deref() == Ok("structure"));
static SCHEMA: LazyLock<String> = LazyLock::new(|| {
    let consequence = |fields: Value| json!([{"container":"Sheet","on":["create","delete","move","rename"],"fields":fields}]);
    json!({"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Book","types":{
        "Book":{"fields":{"sheets":{"kind":"list","of":"Sheet"}}},
        "Sheet":{"toolId":{"field":"id","prefix":"sheet:"},"fields":{
            "id":{"kind":"integer","readOnly":true,"optional":true},"name":{"kind":"string"},
            "rows":{"kind":"list","of":"Row"},"cells":{"kind":"map","owns":true,"readOnly":true}},
            "structuralConsequences":consequence(json!(["cells"]))},
        "Row":{"toolId":{"field":"id","prefix":"row:"},"fields":{
            "id":{"kind":"integer","readOnly":true,"optional":true},"name":{"kind":"string","sample":false}}},
        "Cell":{"readOnly":true,"toolId":{"field":"id","prefix":"cell:"},"fields":{
            "id":{"kind":"integer","readOnly":true},"row":{"kind":"integer"},"value":{"kind":"number"},
            "label":{"kind":"string"},"formula":{"kind":"string"},"address":{"kind":"json","position":true}},
            "structuralConsequences":consequence(json!(["label","formula","address.row"]))}
    }})
    .to_string()
});

pub fn schema() -> &'static str {
    &SCHEMA
}

pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    vec![(
        "cell.write",
        "Write cell",
        true,
        json!({"type":"object","properties":{
            "cell":{"type":"string","x-khp-role":"targets","x-khp-types":["Cell"]},"value":{"type":"number"}
        }}),
    )]
}

pub fn under() -> Value {
    json!({"objects":["cell:1"],"premises":[{"id":"cell:1","fields":[],"positions":[]}],
        "covers":{"fields":["address"]},"within":[{"parent":"sheet:1","field":"rows","from":1,"to":2}]})
}

pub fn covered(objects: &[Value]) -> Value {
    json!({"under":["cell:1"],"covered":objects.iter().map(|object|json!({"id":object["id"],"covered":object["id"]=="cell:1"})).collect::<Vec<_>>()})
}

pub fn edit(replica: &mut Replica, params: &Map<String, Value>, origin: &Origin) -> Result<crate::tracks::Edited, String> {
    let names = kition_kdm::tool_ids::ToolIds::of_replica(replica);
    let cell = names.resolve(params["cell"].as_str().ok_or("cell is required")?, |id| replica.exists(id)).map_err(|error| format!("{error:?}"))?;
    replica.transact(origin, |tx| tx.set(&cell, "value", params["value"].clone())).map_err(|error| error.to_string())?;
    Ok(crate::tracks::Edited { result: None, changed: true, selection: None })
}

fn id(text: &str) -> ObjectId {
    ObjectId::from_string(text)
}

pub fn build(text: &str) -> Result<Replica, String> {
    let file: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    Replica::create_with(
        Arc::new(Schema::parse(schema()).map_err(|error| error.to_string())?),
        DocId::new(),
        ActorId::random(),
        &Origin::system("open"),
        |tx| {
            let root = tx.create_with_id("Book", &id("structure-root"), Map::new())?;
            for (index, sheet) in file["sheets"].as_array().into_iter().flatten().enumerate() {
                let object = tx.create_with_id(
                    "Sheet",
                    &id(&format!("sheet-{}", sheet["id"])),
                    Map::from_iter([("id".into(), sheet["id"].clone()), ("name".into(), sheet["name"].clone())]),
                )?;
                tx.list_insert(&root, "sheets", index, &object)?;
                for (index, row) in sheet["rows"].as_array().into_iter().flatten().enumerate() {
                    let row = tx.create_with_id("Row", &id(&format!("row-{}", row["id"])), row.as_object().unwrap().clone())?;
                    tx.list_insert(&object, "rows", index, &row)?;
                }
                for cell in sheet["cells"].as_array().into_iter().flatten() {
                    let mut fields = cell.as_object().unwrap().clone();
                    fields.entry("label").or_insert(json!(""));
                    fields.entry("formula").or_insert(json!(""));
                    fields.entry("address").or_insert(json!({"row":0}));
                    let cell = tx.create_with_id("Cell", &id(&format!("cell-{}", cell["id"])), fields)?;
                    tx.map_set(&object, "cells", cell.as_str(), json!(cell.as_str()))?;
                }
            }
            settle_values(tx)
        },
    )
    .map(|(replica, ())| replica)
    .map_err(|error| error.to_string())
}

fn settle_values(tx: &mut Tx<'_>) -> kition_kdm::Result<()> {
    for ty in ["Sheet", "Row"] {
        let objects = tx.objects_of_type(ty);
        let mut next = objects.iter().filter_map(|id| tx.get(id, "id").ok()?.as_u64()).max().unwrap_or(0) + 1;
        for object in objects {
            if tx.get(&object, "id")?.is_null() {
                tx.set(&object, "id", json!(next))?;
                next += 1;
            }
        }
    }
    for sheet in tx.objects_of_type("Sheet") {
        let name = tx.get(&sheet, "name")?.as_str().unwrap_or_default().to_owned();
        let rows = tx.list_items(&sheet, "rows")?;
        let row_ids: Vec<_> = rows.iter().map(|object| tx.get(object, "id").unwrap()).collect();
        let entries = tx.map_entries(&sheet, "cells")?;
        for (key, _) in &entries {
            tx.map_delete(&sheet, "cells", key)?;
        }
        for (_, value) in entries {
            let cell = id(value.as_str().unwrap());
            let row = tx.get(&cell, "row")?;
            let at = row_ids.iter().position(|candidate| candidate == &row).map_or(0, |at| at + 1);
            tx.set(&cell, "label", json!(format!("{name}!A{at}")))?;
            tx.set(&cell, "formula", json!(format!("=A{at}*2")))?;
            tx.set(&cell, "address", json!({"row":at}))?;
            let cell_id = tx.get(&cell, "id")?;
            tx.map_set(&sheet, "cells", &format!("r{at}:c{cell_id}"), json!(cell.as_str()))?;
        }
    }
    Ok(())
}

pub fn settle(tx: &mut Tx<'_>) -> kition_kdm::Result<()> {
    settle_values(tx)?;
    if std::env::var_os("KITION_KIT_MOCK_STRUCTURE_UNRELATED").is_some()
        && let Some(cell) = tx.objects_of_type("Cell").first()
    {
        let value = tx.get(cell, "value")?.as_f64().unwrap_or(0.0);
        tx.set(cell, "value", json!(value + 1.0))?;
    }
    Ok(())
}

pub fn text_of(replica: &Replica) -> Result<String, String> {
    let mut sheets = Vec::new();
    for sheet in replica.list(&id("structure-root"), "sheets").map_err(|error| error.to_string())? {
        let mut fields = Map::from_iter([("id".into(), replica.get(&sheet, "id").unwrap()), ("name".into(), replica.get(&sheet, "name").unwrap())]);
        fields.insert(
            "rows".into(),
            json!(
                replica
                    .list(&sheet, "rows")
                    .unwrap()
                    .iter()
                    .map(|row| json!({"id":replica.get(row,"id").unwrap(),"name":replica.get(row,"name").unwrap()}))
                    .collect::<Vec<_>>()
            ),
        );
        fields.insert(
            "cells".into(),
            json!(
                replica
                    .map_entries(&sheet, "cells")
                    .unwrap()
                    .iter()
                    .map(|(_, value)| {
                        let cell = id(value.as_str().unwrap());
                        ["id", "row", "value", "label", "formula", "address"]
                            .into_iter()
                            .map(|field| (field.to_owned(), replica.get(&cell, field).unwrap()))
                            .collect::<Map<_, _>>()
                    })
                    .collect::<Vec<_>>()
            ),
        );
        sheets.push(fields);
    }
    Ok(json!({"sheets":sheets}).to_string())
}
