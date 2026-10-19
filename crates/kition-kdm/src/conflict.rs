// Copied from kition-sdk crates/kition-kdm/src/conflict.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Conflict objects (Kition Kit Standard 2.0, rule M22).
//!
//! A kit's repair pass after a merge (`KitModel::validate`) makes the merged state valid again,
//! deterministically, on every replica. Some merges it cannot resolve by itself: an edit a peer
//! made against a file another peer rewrote in full, two incompatible constraint edits. It then
//! records a **conflict object**: an object of the reserved type `Conflict` that keeps what could
//! not be kept, for the editor to show and a person (or an agent) to resolve. A later transaction
//! resolves it by deleting the object.
//!
//! Repairs run on every replica, so the conflict a repair records has an id derived from what it
//! is about ([`conflict_id`]): replicas that record the same conflict concurrently create the same
//! object, and keep one ([`Tx::create_with_id`]); a replica that already has it (from a peer, or
//! resolved since) records nothing.
//!
//! A kit that records conflicts declares the type in its schema exactly as [`CONFLICT_TYPE_JSON`].

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{KdmError, ObjectId, Replica, Result, Tx};

/// The reserved type name of conflict objects.
pub const CONFLICT_TYPE: &str = "Conflict";

/// The `Conflict` type's definition, as a kit adds it to its `model/schema.json` `types`.
pub const CONFLICT_TYPE_JSON: &str = r#"{ "fields": { "kind": { "kind": "string" }, "summary": { "kind": "string" }, "objects": { "kind": "json" }, "kept": { "kind": "json", "optional": true }, "by": { "kind": "string", "optional": true } } }"#;

/// One conflict: what kind (the kit's own name, as `pdf.droppedEdit`), a sentence for people, the
/// objects or kit keys it concerns, the version the merge could not keep, and who made it (an
/// actor or principal id, when known).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    pub kind: String,
    pub summary: String,
    pub objects: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

/// The id of the conflict of `kind` about `key` (any string that names it among that kind's
/// conflicts, such as an overlay key and the base it was written against): the same on every
/// replica, and a valid object id whatever `key` holds.
pub fn conflict_id(kind: &str, key: &str) -> ObjectId {
    let mut hash = Sha256::new();
    hash.update(kind.as_bytes());
    hash.update([0]);
    hash.update(key.as_bytes());
    let digest = hash.finalize();
    let hex: String = digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect();
    ObjectId::from_string(format!("conflict-{hex}"))
}

/// Records `conflict` under `conflict_id(&conflict.kind, key)` in a repair transaction. Answers
/// the new object's id, or `None` when the document already has that conflict. Fails as
/// [`Tx::create_with_id`] does otherwise (a schema without `Conflict`). A repair records a
/// conflict while it repairs what caused it (and so does not find the cause again), so a resolved
/// conflict stays resolved.
pub fn record_conflict(tx: &mut Tx<'_>, key: &str, conflict: &Conflict) -> Result<Option<ObjectId>> {
    let id = conflict_id(&conflict.kind, key);
    if tx.exists(&id) {
        return Ok(None);
    }
    let mut fields = Map::new();
    fields.insert("kind".into(), Value::String(conflict.kind.clone()));
    fields.insert("summary".into(), Value::String(conflict.summary.clone()));
    fields.insert("objects".into(), Value::Array(conflict.objects.iter().cloned().map(Value::String).collect()));
    if let Some(kept) = &conflict.kept {
        fields.insert("kept".into(), kept.clone());
    }
    if let Some(by) = &conflict.by {
        fields.insert("by".into(), Value::String(by.clone()));
    }
    match tx.create_with_id(CONFLICT_TYPE, &id, fields) {
        Ok(id) => Ok(Some(id)),
        // The id is taken in this transaction (recorded, or resolved, already).
        Err(KdmError::InvalidValue { field, .. }) if field == "$id" => Ok(None),
        Err(error) => Err(error),
    }
}

/// Resolves a conflict: deletes its object.
pub fn resolve_conflict(tx: &mut Tx<'_>, id: &ObjectId) -> Result<()> {
    tx.delete(id)
}

fn read(get: impl Fn(&str) -> Result<Value>) -> Result<Conflict> {
    let text = |value: Value| value.as_str().map(str::to_owned);
    let objects = get("objects")?;
    Ok(Conflict {
        kind: text(get("kind")?).unwrap_or_default(),
        summary: text(get("summary")?).unwrap_or_default(),
        objects: objects.as_array().map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect()).unwrap_or_default(),
        kept: get("kept").ok().filter(|value| !value.is_null()),
        by: get("by").ok().and_then(text),
    })
}

/// The document's unresolved conflicts, by id. Empty for a schema without `Conflict`.
pub fn conflicts(replica: &Replica) -> Result<Vec<(ObjectId, Conflict)>> {
    if !replica.schema().types.contains_key(CONFLICT_TYPE) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for id in replica.objects_of_type(CONFLICT_TYPE) {
        out.push((id.clone(), read(|field| replica.get(&id, field))?));
    }
    out.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::{ActorId, DocId, Origin, Schema};

    fn schema() -> Arc<Schema> {
        let text = format!(
            r#"{{ "kdm": 1, "kit": "kit.test", "schemaVersion": 1, "root": "Doc", "types": {{ "Doc": {{ "fields": {{ "title": {{ "kind": "string" }} }} }}, "Conflict": {CONFLICT_TYPE_JSON} }} }}"#
        );
        Arc::new(Schema::parse(&text).unwrap())
    }

    fn dropped(key: &str) -> Conflict {
        Conflict {
            kind: "test.dropped".into(),
            summary: format!("{key} was dropped"),
            objects: vec![key.into()],
            kept: Some(json!({ "x": 1 })),
            by: Some("actor-1".into()),
        }
    }

    #[test]
    fn ids_are_deterministic_and_valid() {
        let id = conflict_id("pdf.droppedEdit", "12 at epoch a.b");
        assert_eq!(id, conflict_id("pdf.droppedEdit", "12 at epoch a.b"));
        assert_ne!(id, conflict_id("pdf.droppedEdit", "13 at epoch a.b"));
        assert_ne!(id, conflict_id("other", "12 at epoch a.b"));
        assert!(id.as_str().starts_with("conflict-") && id.as_str().len() == 41);
    }

    #[test]
    fn replicas_recording_one_conflict_keep_one_object_and_resolving_ends_it() {
        let mut a = Replica::create(schema(), DocId::new(), ActorId::random()).unwrap();
        let mut b = Replica::load(schema(), &a.snapshot().unwrap(), ActorId::random()).unwrap();
        let repair = Origin::system("repair");
        // Both replicas run the same repair concurrently.
        let made_a = a.transact(&repair, |tx| record_conflict(tx, "k1", &dropped("k1"))).unwrap();
        let made_b = b.transact(&repair, |tx| record_conflict(tx, "k1", &dropped("k1"))).unwrap();
        assert_eq!(made_a, made_b);
        assert!(made_a.is_some());
        let (before_a, before_b) = (a.version(), b.version());
        a.import_changes(&b.export_changes(&before_a).unwrap()).unwrap();
        b.import_changes(&a.export_changes(&before_b).unwrap()).unwrap();
        assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
        let found = conflicts(&a).unwrap();
        assert_eq!(found, vec![(made_a.clone().unwrap(), dropped("k1"))]);

        // Recording it again records nothing; resolving deletes it.
        assert_eq!(a.transact(&repair, |tx| record_conflict(tx, "k1", &dropped("k1"))).unwrap(), None);
        let id = made_a.unwrap();
        a.transact(&Origin::person("p"), |tx| resolve_conflict(tx, &id)).unwrap();
        assert!(conflicts(&a).unwrap().is_empty());
        b.import_changes(&a.export_changes(&b.version()).unwrap()).unwrap();
        assert!(conflicts(&b).unwrap().is_empty());
    }

    #[test]
    fn a_schema_without_conflicts_has_none_and_refuses_to_record_one() {
        let schema =
            Arc::new(Schema::parse(r#"{ "kdm": 1, "kit": "kit.test", "schemaVersion": 1, "root": "Doc", "types": { "Doc": { "fields": {} } } }"#).unwrap());
        let mut replica = Replica::create(schema, DocId::new(), ActorId::random()).unwrap();
        assert!(conflicts(&replica).unwrap().is_empty());
        assert!(replica.transact(&Origin::system("repair"), |tx| record_conflict(tx, "k", &dropped("k"))).is_err());
    }
}
