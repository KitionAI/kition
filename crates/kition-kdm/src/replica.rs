// Copied from kition-sdk crates/kition-kdm/src/replica.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::collections::{BTreeSet, HashMap, HashSet};
use std::mem;
use std::sync::{Arc, Mutex};

use loro::event::Diff;
use loro::{
    ContainerID, Counter, ExportMode, Frontiers, Index, LoroDoc, LoroError, LoroValue, PeerID, ToJson, TreeID, TreeParentId, UndoManager, ValueOrContainer,
    VersionRange, VersionVector,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::engine;
use crate::read::{self, META, OBJECTS, SCHEMA_VERSION};
use crate::{ActorId, DocId, KDM_VERSION, KdmError, NodeRef, ObjectId, Origin, OriginKind, Result, Schema, TextRun, Tx};

/// The origin given to the partial operations of a transaction the engine refused while applying
/// it, and to their reversal, so the undo history never records either.
const ROLLBACK: &str = "kdm-rollback";

/// A replica's version: the set of changes it contains. Exchanged to ask for what is missing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version(VersionVector);

impl Version {
    pub fn empty() -> Self {
        Self(VersionVector::default())
    }

    pub fn encode(&self) -> Vec<u8> {
        self.0.encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        VersionVector::decode(bytes).map(Self).map_err(|error| KdmError::Encoding(error.to_string()))
    }

    /// Whether every change in `other` is in this version. Versions are partially ordered: of two
    /// replicas that changed concurrently, neither version includes the other.
    pub fn includes(&self, other: &Version) -> bool {
        self.0.includes_vv(&other.0)
    }
}

/// One node of a tree field, as [`Replica::tree`] lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    pub node: NodeRef,
    /// The object the node names.
    pub object: ObjectId,
    /// `None` for a root.
    pub parent: Option<NodeRef>,
}

/// One copy of one document.
///
/// Unlike the TypeScript `Replica`, this one has no `clear_redo`: the engine's Rust API (loro
/// 1.16.2) clears the redo stack only together with the undo stack.
pub struct Replica {
    doc: LoroDoc,
    doc_id: DocId,
    schema: Arc<Schema>,
    actor: ActorId,
    undo: UndoManager,
    /// Set between [`Replica::begin_undo_group`] and [`Replica::end_undo_group`].
    grouping: bool,
    changed: BTreeSet<ObjectId>,
    /// For each replica whose changes an import could not apply yet, the counter just past the
    /// last of them. They are applied (and no longer pending) once [`Replica::version`] reaches it.
    pending: HashMap<PeerID, Counter>,
    /// Registers an import changed: the candidates for another replica's later write, which an
    /// undo or redo must keep (M12). Pruned at each undo and redo.
    imported_registers: HashSet<Register>,
    /// Registers an undo or redo put back to another replica's value, with that value: still that
    /// replica's write for the next undo or redo, though this replica wrote it last.
    kept_registers: HashMap<Register, Option<LoroValue>>,
    /// The value this replica last wrote to each register (`None`: deleted it). Another replica's
    /// later write of the same value is not a change an undo must keep (a script's own undo that
    /// puts back this replica's value, for instance).
    own_registers: HashMap<Register, Option<LoroValue>>,
}

/// A register: one key of a map container inside an object (a register field, or one key of a
/// `map` field).
type Register = (ContainerID, String);

impl Replica {
    /// A new, empty document. Only one replica creates a document; others [`Replica::load`] it.
    pub fn create(schema: Arc<Schema>, doc_id: DocId, actor: ActorId) -> Result<Self> {
        Self::create_with(schema, doc_id, actor, &Origin::system("create"), |_| Ok(())).map(|(replica, ())| replica)
    }

    /// A new document whose initial content `build` writes in the creating commit, before undo
    /// history starts: file imports and other bulk builds. Undo bookkeeping grows faster than
    /// linearly with a transaction's size, so bulk content must not go through [`Replica::transact`].
    pub fn create_with<R>(
        schema: Arc<Schema>,
        doc_id: DocId,
        actor: ActorId,
        origin: &Origin,
        build: impl FnOnce(&mut Tx<'_>) -> Result<R>,
    ) -> Result<(Self, R)> {
        let doc = LoroDoc::new();
        doc.set_peer_id(actor.get()).map_err(engine)?;
        crate::marks::configure(&doc, &schema);
        // Written before `build` runs, so its transaction reads the document's schema version.
        let meta = doc.get_map(META);
        meta.insert("docId", doc_id.to_string()).map_err(engine)?;
        meta.insert("kit", schema.kit.clone()).map_err(engine)?;
        meta.insert(SCHEMA_VERSION, i64::from(schema.schema_version)).map_err(engine)?;
        meta.insert("kdm", i64::from(KDM_VERSION)).map_err(engine)?;
        let (value, staged) = {
            let mut tx = Tx::new(&doc, &schema);
            let value = build(&mut tx)?;
            (value, tx.finish())
        };
        // The new document is discarded on failure, so nothing needs reverting.
        staged.apply(&doc, &schema, |_| {}).map_err(applying_failed)?;
        doc.set_next_commit_origin(origin.kind.as_str());
        doc.set_next_commit_message(&origin.encode());
        doc.commit();
        Ok((Self::attach(doc, doc_id, schema, actor)?, value))
    }

    /// Opens a snapshot (or a full change export) as a new writable replica of `actor`. Refuses
    /// ([`KdmError::Schema`]) a document of another kit or of another KDM version, and
    /// ([`KdmError::NewerSchema`]) one whose minimum schema version (rule M20) is newer than
    /// `schema`'s.
    ///
    /// A snapshot holds the changes its replica applied, not those still pending on it (see
    /// [`Replica::has_pending_changes`]): the loaded replica has none pending, and fetches those
    /// changes again when it syncs.
    pub fn load(schema: Arc<Schema>, bytes: &[u8], actor: ActorId) -> Result<Self> {
        let (doc_id, bytes) = envelope::open(bytes)?;
        let doc = LoroDoc::new();
        crate::marks::configure(&doc, &schema);
        let status = doc.import(bytes).map_err(|error| KdmError::Encoding(error.to_string()))?;
        let meta = |key: &str| match doc.get_map(META).get(key) {
            Some(ValueOrContainer::Value(value)) => value.to_json_value(),
            _ => Value::Null,
        };
        let kit = meta("kit");
        if kit.is_null() {
            return Err(KdmError::Encoding("not a snapshot: meta.kit is missing (load a snapshot or a full export, not changes only)".into()));
        }
        if kit.as_str() != Some(schema.kit.as_str()) {
            return Err(KdmError::Schema(format!("the document belongs to {kit}, not `{}`", schema.kit)));
        }
        let kdm = meta("kdm");
        if kdm.as_u64() != Some(u64::from(KDM_VERSION)) {
            return Err(KdmError::Schema(format!("the document uses kdm {kdm}; this build reads {KDM_VERSION}")));
        }
        match read::min_schema_version(&doc) {
            Some(found) if found <= u64::from(schema.schema_version) => {}
            Some(found) => return Err(KdmError::NewerSchema { found, reads: schema.schema_version }),
            None => {
                return Err(KdmError::Schema(format!(
                    "the document has schema version {}; this kit reads schema versions up to {}",
                    meta(SCHEMA_VERSION),
                    schema.schema_version
                )));
            }
        }
        // The envelope and the document must agree; anything else is corrupt or forged bytes.
        if meta("docId").as_str().map(DocId::parse).and_then(std::result::Result::ok) != Some(doc_id) {
            return Err(KdmError::Encoding(format!("the bytes are labelled as document {doc_id}, but hold another")));
        }
        let mut replica = Self::attach(doc, doc_id, schema, actor)?;
        replica.note_pending(status.pending.as_ref());
        Ok(replica)
    }

    fn attach(doc: LoroDoc, doc_id: DocId, schema: Arc<Schema>, actor: ActorId) -> Result<Self> {
        doc.set_peer_id(actor.get()).map_err(engine)?;
        let undo = undo_manager(&doc);
        Ok(Self {
            doc,
            doc_id,
            schema,
            actor,
            undo,
            grouping: false,
            changed: BTreeSet::new(),
            pending: HashMap::new(),
            imported_registers: HashSet::new(),
            kept_registers: HashMap::new(),
            own_registers: HashMap::new(),
        })
    }

    pub fn doc_id(&self) -> DocId {
        self.doc_id
    }

    pub fn actor(&self) -> ActorId {
        self.actor
    }

    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    pub fn version(&self) -> Version {
        Version(self.doc.oplog_vv())
    }

    /// The document's minimum schema version (rule M20): the version it was created with, or the
    /// largest one a transaction raised it to ([`Tx::raise_schema_version`]). Never more than
    /// this replica's schema version: loads and imports refuse such documents.
    pub fn min_schema_version(&self) -> u32 {
        read::min_schema_version(&self.doc).and_then(|found| u32::try_from(found).ok()).unwrap_or(0)
    }

    /// Runs `f` as one transaction: one commit, one undo step, one origin. Operations are staged
    /// while `f` runs and applied only if it succeeds: if `f` fails, the document, its version,
    /// and its exports are unchanged and the error is returned.
    pub fn transact<R>(&mut self, origin: &Origin, f: impl FnOnce(&mut Tx<'_>) -> Result<R>) -> Result<R> {
        let schema = Arc::clone(&self.schema);
        let (value, staged) = {
            let mut tx = Tx::new(&self.doc, &schema);
            let value = f(&mut tx)?;
            (value, tx.finish())
        };
        if staged.is_empty() {
            return Ok(value);
        }
        if staged.raises_schema() && origin.kind != OriginKind::System {
            return Err(KdmError::InvalidValue {
                ty: "$meta".into(),
                field: "schemaVersion".into(),
                reason: format!("is raised only in a `system` transaction, not `{}`", origin.kind.as_str()),
            });
        }
        let before = self.doc.state_frontiers();
        let writes = staged.register_writes();
        let mut touched = BTreeSet::new();
        if let Err(error) = staged.apply(&self.doc, &schema, |id| {
            touched.insert(id.clone());
        }) {
            // Validation should have made this impossible: an operation the overlay accepted was
            // refused by the engine, so this is a validation bug. Some operations may already be
            // applied and the engine cannot abort, so they are committed and reverted. Both
            // commits reach other replicas, and the reversal can overwrite a collaborator's
            // concurrent edits to the same fields; that is the cost of this last-resort path.
            self.doc.set_next_commit_origin(ROLLBACK);
            self.doc.commit();
            if self.doc.state_frontiers() != before {
                self.doc.revert_to(&before).map_err(engine)?;
                self.doc.set_next_commit_origin(ROLLBACK);
                self.doc.set_next_commit_message(&Origin::system("rollback").encode());
                self.doc.commit();
            }
            return Err(applying_failed(error));
        }
        self.doc.set_next_commit_origin(origin.kind.as_str());
        self.doc.set_next_commit_message(&origin.encode());
        self.doc.commit();
        self.changed.extend(touched);
        self.note_own_writes(writes);
        Ok(value)
    }

    pub fn exists(&self, id: &ObjectId) -> bool {
        read::object_map(&self.doc, id).is_ok()
    }

    pub fn object_type(&self, id: &ObjectId) -> Result<String> {
        read::object_type(&self.doc, id)
    }

    pub fn get(&self, id: &ObjectId, field: &str) -> Result<Value> {
        read::register(&self.doc, &self.schema, id, field)
    }

    pub fn text(&self, id: &ObjectId, field: &str) -> Result<String> {
        Ok(read::text(&self.doc, &self.schema, id, field)?.map(|text| text.to_string()).unwrap_or_default())
    }

    /// A text field as runs of characters with equal marks (rule M19), in order: adjacent runs
    /// differ in their marks, no run is empty, and only the field's declared marks appear. A field
    /// that declares no marks reads as one unmarked run (none when empty). Positions are counted
    /// in Unicode scalar values (`insert.chars().count()`).
    pub fn text_delta(&self, id: &ObjectId, field: &str) -> Result<Vec<TextRun>> {
        read::text_runs(&self.doc, &self.schema, id, field)
    }

    pub fn list(&self, id: &ObjectId, field: &str) -> Result<Vec<ObjectId>> {
        Ok(read::list(&self.doc, &self.schema, id, field)?.map(|list| read::list_items(&list)).transpose()?.unwrap_or_default())
    }

    /// One key of a map field, or `null`.
    pub fn map_get(&self, id: &ObjectId, field: &str, key: &str) -> Result<Value> {
        Ok(read::map(&self.doc, &self.schema, id, field)?.map_or(Value::Null, |map| read::map_value(&map, key)))
    }

    /// A map field's keys and values, sorted by key (code point order, as in the canonical state).
    /// Each value reads as [`Replica::map_get`] reads it. Reads the whole map.
    pub fn map_entries(&self, id: &ObjectId, field: &str) -> Result<Vec<(String, Value)>> {
        Ok(read::map(&self.doc, &self.schema, id, field)?.map(|map| read::map_entries(&map)).unwrap_or_default())
    }

    /// The tree's nodes in pre-order (each parent before its children, siblings in order). A node
    /// that names no object is skipped with its subtree, as in [`Replica::state_json`].
    pub fn tree(&self, id: &ObjectId, field: &str) -> Result<Vec<TreeEntry>> {
        let mut out = Vec::new();
        let Some(tree) = read::tree(&self.doc, &self.schema, id, field)? else { return Ok(out) };
        let mut stack: Vec<(TreeID, Option<NodeRef>)> = Vec::new();
        let push_children = |stack: &mut Vec<(TreeID, Option<NodeRef>)>, parent: TreeParentId, parent_ref: Option<NodeRef>| {
            for node in tree.children(parent).unwrap_or_default().into_iter().rev() {
                stack.push((node, parent_ref.clone()));
            }
        };
        push_children(&mut stack, TreeParentId::Root, None);
        while let Some((id, parent)) = stack.pop() {
            let Some(object) = read::node_object(&tree, id) else { continue };
            let node = NodeRef::committed(id);
            out.push(TreeEntry { node: node.clone(), object, parent });
            push_children(&mut stack, TreeParentId::Node(id), Some(node));
        }
        Ok(out)
    }

    /// Ids of the objects of type `ty`, sorted. One pass over the objects, so it suits large
    /// documents; it costs O(objects) per call.
    pub fn objects_of_type(&self, ty: &str) -> Vec<ObjectId> {
        read::objects_of_type(&self.doc, ty)
    }

    /// The changes this replica has that a replica at `since` lacks.
    /// Exported bytes carry this document's id; see [`Replica::import_changes`].
    pub fn export_changes(&self, since: &Version) -> Result<Vec<u8>> {
        let bytes = self.doc.export(ExportMode::updates(&since.0)).map_err(|error| KdmError::Encoding(error.to_string()))?;
        Ok(envelope::wrap(self.doc_id, &bytes))
    }

    /// Applies changes from another replica or from storage, in any order, any number of times.
    /// Answers the objects whose state changed.
    /// Bytes that are not a KDM export are [`KdmError::Encoding`]; changes of another document are
    /// [`KdmError::WrongDocument`] and change nothing.
    ///
    /// Changes that raise the document's minimum schema version (rule M20) above this replica's
    /// schema are [`KdmError::NewerSchema`] and change nothing: the state, the version, the
    /// exports, and the changes still pending are as before the import. The engine cannot check
    /// changes without applying them, so the replica is rebuilt from its history before the
    /// import; that clears its undo and redo history.
    pub fn import_changes(&mut self, bytes: &[u8]) -> Result<BTreeSet<ObjectId>> {
        let (doc_id, bytes) = envelope::open(bytes)?;
        if doc_id != self.doc_id {
            return Err(KdmError::WrongDocument { expected: self.doc_id.to_string(), found: doc_id.to_string() });
        }
        let before = self.doc.oplog_frontiers();
        let doc = &self.doc;
        let (imported, changed, registers) = observe_changes(doc, || doc.import(bytes).map_err(|error| KdmError::Encoding(error.to_string())));
        if let Some(found) = read::min_schema_version(&self.doc).filter(|found| *found > u64::from(self.schema.schema_version)) {
            self.restore(&before)?;
            return Err(KdmError::NewerSchema { found, reads: self.schema.schema_version });
        }
        let status = imported?;
        self.imported_registers.extend(registers);
        self.note_pending(status.pending.as_ref());
        self.changed.extend(changed.iter().cloned());
        self.reopen_undo_group();
        Ok(changed)
    }

    /// Replaces the document with its history up to `frontiers`, dropping every change applied
    /// since. Changes still pending stay recorded in `pending`: they are missing again, and a
    /// sync fetches them.
    fn restore(&mut self, frontiers: &Frontiers) -> Result<()> {
        let doc = self.doc.fork_at(frontiers).map_err(engine)?;
        crate::marks::configure(&doc, &self.schema);
        doc.set_peer_id(self.actor.get()).map_err(engine)?;
        self.undo = undo_manager(&doc);
        self.doc = doc;
        // No undo history is left to protect registers from.
        self.imported_registers.clear();
        self.kept_registers.clear();
        self.own_registers.clear();
        self.reopen_undo_group();
        Ok(())
    }

    /// Whether this replica holds imported changes it could not apply yet, because they depend on
    /// changes it has not received. Importing changes out of order is legitimate (they are applied
    /// as soon as what they depend on arrives); a replica that stays in this state is missing
    /// changes, which a sync from [`Replica::version`] fetches. Pending changes are not in
    /// [`Replica::version`], the state, or the exports.
    pub fn has_pending_changes(&self) -> bool {
        let applied = self.doc.oplog_vv();
        self.pending.iter().any(|(peer, end)| applied.get(peer).copied().unwrap_or(0) < *end)
    }

    /// Records the changes an import left pending, and forgets those applied since.
    fn note_pending(&mut self, parked: Option<&VersionRange>) {
        for (peer, (_, end)) in parked.into_iter().flat_map(VersionRange::iter) {
            let known = self.pending.entry(*peer).or_insert(*end);
            *known = (*known).max(*end);
        }
        let applied = self.doc.oplog_vv();
        self.pending.retain(|peer, end| applied.get(peer).copied().unwrap_or(0) < *end);
    }

    /// The objects changed since the last call, by local transactions or imports.
    pub fn take_changed(&mut self) -> BTreeSet<ObjectId> {
        mem::take(&mut self.changed)
    }

    /// A compacted copy of the whole document, for fast loading and new replicas.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let bytes = self.doc.export(ExportMode::Snapshot).map_err(|error| KdmError::Encoding(error.to_string()))?;
        Ok(envelope::wrap(self.doc_id, &bytes))
    }

    /// Undoes this replica's last transaction. Changes from other replicas are kept, including
    /// later changes to the same object and to the same field: a register another replica wrote
    /// after the undone transaction keeps that value (M12). The objects it changes are reported by
    /// [`Replica::take_changed`].
    pub fn undo(&mut self) -> Result<bool> {
        self.undo_or_redo(true)
    }

    /// Redoes the last undone transaction, keeping other replicas' later changes and reporting
    /// what it changes like [`Replica::undo`].
    pub fn redo(&mut self) -> Result<bool> {
        self.undo_or_redo(false)
    }

    fn undo_or_redo(&mut self, undo: bool) -> Result<bool> {
        self.end_undo_group();
        let others = self.others_registers();
        let manager = &mut self.undo;
        let (done, changed, registers) = observe_changes(&self.doc, || if undo { manager.undo() } else { manager.redo() }.map_err(engine));
        self.changed.extend(changed);
        let done = done?;
        // The engine's inverse operation sets a register back even when another replica wrote it
        // later; put those back to the other replica's value, in a `system` commit (not an undo
        // step), so the result is as if the undo had skipped them.
        for register in &registers {
            let map = self.doc.get_map(register.0.clone());
            match map.get(&register.1) {
                Some(ValueOrContainer::Value(value)) => {
                    self.own_registers.insert(register.clone(), Some(value));
                }
                Some(ValueOrContainer::Container(_)) => {}
                None => {
                    self.own_registers.insert(register.clone(), None);
                }
            }
        }
        let touched: HashSet<&Register> = registers.iter().collect();
        let mut restored = false;
        for (register, value) in others {
            if !touched.contains(&register) {
                continue;
            }
            let map = self.doc.get_map(register.0.clone());
            let now = match map.get(&register.1) {
                Some(ValueOrContainer::Value(value)) => Some(value),
                Some(ValueOrContainer::Container(_)) => continue,
                None => None,
            };
            if now == value {
                continue;
            }
            match &value {
                Some(value) => map.insert(&register.1, value.clone()).map_err(engine)?,
                None => map.delete(&register.1).map_err(engine)?,
            }
            self.kept_registers.insert(register, value);
            restored = true;
        }
        if restored {
            self.doc.set_next_commit_origin(OriginKind::System.as_str());
            self.doc.set_next_commit_message(&Origin::system("keep-later-changes").encode());
            self.doc.commit();
        }
        Ok(done)
    }

    /// Records the registers a local transaction wrote, with their values.
    fn note_own_writes(&mut self, writes: Vec<(ObjectId, Option<String>, String, Option<Value>)>) {
        for (id, field, key, value) in writes {
            let Ok(object) = read::object_map(&self.doc, &id) else { continue };
            let container = match field {
                None => loro::ContainerTrait::id(&object),
                Some(field) => match object.get(&field) {
                    Some(ValueOrContainer::Container(loro::Container::Map(map))) => loro::ContainerTrait::id(&map),
                    _ => continue,
                },
            };
            self.own_registers.insert((container, key), value.map(crate::value::to_loro));
        }
    }

    /// The registers whose current value another replica wrote, with that value (`None`: deleted
    /// there): an import changed them and another peer wrote them last, or an earlier undo or
    /// redo kept them for another replica and nothing changed them since. Prunes both candidate
    /// sets of registers that are this replica's own again.
    fn others_registers(&mut self) -> Vec<(Register, Option<LoroValue>)> {
        let doc = &self.doc;
        let me = self.actor.get();
        let current = |register: &Register| {
            let map = doc.get_map(register.0.clone());
            let value = match map.get(&register.1) {
                Some(ValueOrContainer::Value(value)) => Some(Some(value)),
                Some(ValueOrContainer::Container(_)) => None,
                None => Some(None),
            };
            (map, value)
        };
        let mut out = Vec::new();
        self.kept_registers.retain(|register, kept| match current(register) {
            (_, Some(value)) if &value == kept => {
                out.push((register.clone(), value));
                true
            }
            _ => false,
        });
        let own = &self.own_registers;
        self.imported_registers.retain(|register| {
            if self.kept_registers.contains_key(register) {
                return true;
            }
            let (map, value) = current(register);
            match (map.get_last_editor(&register.1), value) {
                // Another replica wrote this replica's own value again: nothing to keep.
                (Some(peer), Some(value)) if peer != me && own.get(register) == Some(&value) => true,
                (Some(peer), Some(value)) if peer != me => {
                    out.push((register.clone(), value));
                    true
                }
                _ => false,
            }
        });
        out
    }

    /// Whether [`Replica::undo`] has a transaction of this replica to undo.
    pub fn can_undo(&self) -> bool {
        self.undo.can_undo()
    }

    /// Whether [`Replica::redo`] has an undone transaction to redo.
    pub fn can_redo(&self) -> bool {
        self.undo.can_redo()
    }

    /// Starts an undo group: the transactions until [`Replica::end_undo_group`] undo and redo as
    /// one step. Groups do not nest ([`KdmError::InvalidValue`]). An undo or a redo ends the open
    /// group first, so undo while grouping reverts the group as one step. An import that changes
    /// what the group changed splits it in two undo steps: the transactions before the import and
    /// those after it.
    pub fn begin_undo_group(&mut self) -> Result<()> {
        if self.grouping {
            return Err(KdmError::InvalidValue { ty: "$undo".into(), field: "group".into(), reason: "is already open".into() });
        }
        self.undo.group_start().map_err(engine)?;
        self.grouping = true;
        Ok(())
    }

    /// Ends the open undo group; does nothing when none is open.
    pub fn end_undo_group(&mut self) {
        if self.grouping {
            self.undo.group_end();
            self.grouping = false;
        }
    }

    /// After an import, makes sure the open group is still open in the engine: the engine ends it
    /// when the import changes what the group changed, and then the group goes on as a new one.
    /// Starting a group the engine still has open changes nothing; if the engine can start none,
    /// no group is open any more.
    fn reopen_undo_group(&mut self) {
        if !self.grouping {
            return;
        }
        match self.undo.group_start() {
            Ok(()) | Err(LoroError::UndoGroupAlreadyStarted) => {}
            Err(_) => self.grouping = false,
        }
    }

    pub fn state_json(&self) -> Result<Value> {
        read::state_json(&self.doc, &self.schema)
    }

    /// SHA-256 of the canonical state, as lowercase hex.
    pub fn state_hash(&self) -> Result<String> {
        let digest = Sha256::digest(self.state_json()?.to_string().as_bytes());
        Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

/// The undo manager of a replica's document.
fn undo_manager(doc: &LoroDoc) -> UndoManager {
    let mut undo = UndoManager::new(doc);
    undo.set_merge_interval(0);
    undo.add_exclude_origin_prefix(ROLLBACK);
    // `system` transactions (repairs, migrations) are not undo steps: undo skips them like
    // changes from another replica, and they survive the undo of earlier transactions.
    undo.add_exclude_origin_prefix(OriginKind::System.as_str());
    // `import` transactions (changes merged from a file edited elsewhere) are not undo steps
    // either: a person's undo never reverts another tool's edit.
    undo.add_exclude_origin_prefix(OriginKind::Import.as_str());
    undo
}

/// Runs `run` while observing which objects change, and which registers inside objects. Change
/// events are observed only during the call: a document-wide subscription makes large local
/// transactions slow to commit.
fn observe_changes<T>(doc: &LoroDoc, run: impl FnOnce() -> T) -> (T, BTreeSet<ObjectId>, Vec<Register>) {
    let found = Arc::new(Mutex::new((BTreeSet::new(), Vec::new())));
    let sink = Arc::clone(&found);
    let subscription = doc.subscribe_root(Arc::new(move |event| {
        let Ok(mut found) = sink.lock() else { return };
        let (set, registers) = &mut *found;
        for diff in event.events.iter() {
            let in_objects = matches!(diff.path.first(), Some((_, Index::Key(key))) if key.to_string() == OBJECTS);
            if !in_objects {
                continue;
            }
            match diff.path.get(1) {
                Some((_, Index::Key(key))) => {
                    set.insert(ObjectId::from_string(key.to_string()));
                    if let Diff::Map(map) = &diff.diff {
                        for (field, value) in map.updated.iter() {
                            if !matches!(value, Some(ValueOrContainer::Container(_))) {
                                registers.push((diff.target.clone(), field.to_string()));
                            }
                        }
                    }
                }
                _ => {
                    if let Diff::Map(map) = &diff.diff {
                        set.extend(map.updated.keys().map(|key| ObjectId::from_string(key.to_string())));
                    }
                }
            }
        }
    }));
    let value = run();
    drop(subscription);
    let (changed, registers) = found.lock().map(|mut found| mem::take(&mut *found)).unwrap_or_default();
    (value, changed, registers)
}

/// Every byte string a replica exports: 4-byte magic, the 16-byte document UUID, then the engine's
/// bytes. The id keeps two documents from being merged by mistake.
mod envelope {
    use crate::{DocId, KdmError, Result};

    const MAGIC: &[u8; 4] = b"KDM\x01";

    pub(super) fn wrap(doc_id: DocId, bytes: &[u8]) -> Vec<u8> {
        [MAGIC.as_slice(), doc_id.as_bytes().as_slice(), bytes].concat()
    }

    pub(super) fn open(bytes: &[u8]) -> Result<(DocId, &[u8])> {
        let not_kdm = || KdmError::Encoding("the bytes are not a KDM export".into());
        let (magic, rest) = bytes.split_first_chunk::<4>().ok_or_else(not_kdm)?;
        if magic != MAGIC {
            return Err(not_kdm());
        }
        let (doc_id, rest) = rest.split_first_chunk::<16>().ok_or_else(not_kdm)?;
        Ok((DocId::from_bytes(*doc_id), rest))
    }
}

/// An engine failure while applying operations that validation accepted.
fn applying_failed(error: KdmError) -> KdmError {
    KdmError::Engine(format!("applying a validated transaction failed: {error}"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_engine_failure_while_applying_is_reverted_out_of_undo_history() {
        let schema = Arc::new(Schema::parse(include_str!("../tests/fixtures/test-schema.json")).unwrap());
        let mut replica = Replica::create(schema, DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
        let person = Origin::person("user:test");
        let shape = replica
            .transact(&person, |tx| {
                let mut fields = serde_json::Map::new();
                for (key, value) in [("kind", json!("rect")), ("x", json!(10)), ("y", json!(20))] {
                    fields.insert(key.into(), value);
                }
                tx.create("Shape", fields)
            })
            .unwrap();
        replica.take_changed();
        crate::op::FAIL_AT.with(|at| at.set(Some(2)));
        let error = replica
            .transact(&person, |tx| {
                tx.set(&shape, "x", json!(99))?;
                tx.text_insert(&shape, "label", 0, "partial")?;
                tx.set(&shape, "y", json!(5))
            })
            .unwrap_err();
        assert!(matches!(&error, KdmError::Engine(message) if message.contains("forced failure")), "{error:?}");
        assert_eq!(replica.get(&shape, "x").unwrap(), json!(10));
        assert_eq!(replica.text(&shape, "label").unwrap(), "");
        assert!(replica.take_changed().is_empty());
        // The partial commit and its reversal are not undo steps: undo reverts the creation.
        assert!(replica.undo().unwrap());
        assert!(!replica.exists(&shape));
    }
}
