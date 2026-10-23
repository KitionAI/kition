// Copied from kition-sdk crates/kition-kdm/src/replica.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::mem;
use std::sync::{Arc, Mutex};

use loro::event::Diff;
use loro::{
    ContainerID, Counter, ExportMode, IdSpan, Index, LoroDoc, LoroError, LoroValue, PeerID, ToJson, TreeID, TreeParentId, UndoManager, ValueOrContainer,
    VersionRange, VersionVector,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{engine, importing};
use crate::read::{self, META, OBJECTS, SCHEMA_VERSION};
use crate::{ActorId, DocId, KDM_VERSION, KdmError, NodeRef, ObjectId, Origin, OriginKind, Result, Schema, TextRun, Tx, UndoScope};

/// The origin given to the partial operations of a transaction the engine refused while applying
/// it, and to their reversal, so the undo history never records either.
const ROLLBACK: &str = "kdm-rollback";

/// The engine's origin of its own undo and redo commits (loro 1.16.2). One scope's undo is, for the
/// other scope's history, a change it did not make.
const ENGINE_UNDO: &str = "undo";

/// The engine's commit origin for a transaction of `kind`: the name of the undo scope it joins
/// (M12a), or its kind when it is no undo step. Only the undo histories read it; it is local to the
/// replica and never exported (the commit message carries the origin).
fn commit_origin(kind: OriginKind) -> &'static str {
    UndoScope::of(kind).map_or(kind.as_str(), UndoScope::as_str)
}

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
    undo: Histories,
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
    /// The undo scope of this replica's last write to each register (`None`: a `system` or
    /// `import` transaction), with the value written. An undo in one scope keeps the value another
    /// scope wrote later, as it keeps another replica's (M12a). Pruned at each undo and redo.
    local_writes: HashMap<Register, (Option<UndoScope>, Option<LoroValue>)>,
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
        doc.set_next_commit_origin(commit_origin(origin.kind));
        doc.set_next_commit_message(&origin.encode_commit(schema.schema_version));
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
        let undo = Histories::new(&doc);
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
            local_writes: HashMap::new(),
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

    /// The newest schema version any change of this replica was written under (rule M5a: every
    /// commit records its author's schema version), or `None` when no change records one (they
    /// all predate the rule). A version above this replica's schema means someone edits the
    /// document with a newer kit: objects of types this schema lacks read as their `$type` only
    /// and refuse edits here ([`KdmError::UnknownType`]), and a host asks the person to update the
    /// kit. A shallow replica (rule M16a) sees only the changes after its root.
    pub fn author_schema_version(&self) -> Option<u32> {
        let start = self.doc.shallow_since_vv();
        let mut newest = None;
        for (peer, end) in self.doc.oplog_vv().iter() {
            let mut counter = start.get(peer).copied().unwrap_or(0);
            while counter < *end {
                let Some(change) = self.doc.get_change(loro::ID::new(*peer, counter)) else { break };
                let version = change.message.as_deref().and_then(Origin::decode_commit).and_then(|(_, version)| version);
                newest = newest.max(version);
                let next = change.id.counter.saturating_add(i32::try_from(change.len).unwrap_or(i32::MAX));
                if next <= counter {
                    break;
                }
                counter = next;
            }
        }
        newest
    }

    /// Runs `f` as one transaction: one commit, one undo step (of its origin's scope, M12a), one origin. Operations are staged
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
                self.doc.set_next_commit_message(&Origin::system("rollback").encode_commit(self.schema.schema_version));
                self.doc.commit();
            }
            return Err(applying_failed(error));
        }
        self.doc.set_next_commit_origin(commit_origin(origin.kind));
        self.doc.set_next_commit_message(&origin.encode_commit(self.schema.schema_version));
        self.doc.commit();
        self.changed.extend(touched);
        self.note_own_writes(writes, UndoScope::of(origin.kind));
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
    /// [`KdmError::WrongDocument`] and change nothing. On a shallow replica, changes that depend on
    /// history before its root (made by a replica that had not seen the root yet) are
    /// [`KdmError::HistoryMissing`] and change nothing; see [`Replica::rebase`].
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
        let before = self.doc.oplog_vv();
        let doc = &self.doc;
        let (imported, changed, registers) = observe_changes(doc, || doc.import(bytes).map_err(importing));
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

    /// Replaces the document with its history up to `version`, dropping every change applied
    /// since. Changes still pending stay recorded in `pending`: they are missing again, and a
    /// sync fetches them. A shallow replica stays shallow, with the same root.
    fn restore(&mut self, version: &VersionVector) -> Result<()> {
        let doc =
            if self.doc.is_shallow() { shallow_fork_at(&self.doc, version)? } else { self.doc.fork_at(&self.doc.vv_to_frontiers(version)).map_err(engine)? };
        crate::marks::configure(&doc, &self.schema);
        doc.set_peer_id(self.actor.get()).map_err(engine)?;
        self.undo = Histories::new(&doc);
        self.doc = doc;
        // No undo history is left to protect registers from.
        self.imported_registers.clear();
        self.kept_registers.clear();
        self.own_registers.clear();
        self.local_writes.clear();
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

    /// A **shallow snapshot** (standard 2.0 rule M16a): the document's current state with only the
    /// history after `at`, for a device that holds a large document without its whole history.
    /// [`Replica::load`] opens it as a shallow replica, which edits, exports, imports, and merges
    /// like a full one; history before its root stays with whoever holds it (the sync server).
    ///
    /// The root is the latest version at or before `at` that every later change descends from
    /// (the engine moves it back past changes made concurrently with `at`, so they stay in the
    /// retained history); `Version::empty()` keeps the whole history. `at` must be a version this
    /// replica has ([`KdmError::InvalidValue`] otherwise); on a shallow replica, an `at` before its
    /// own root is its root.
    pub fn shallow_snapshot(&self, at: &Version) -> Result<Vec<u8>> {
        if !self.version().includes(at) {
            return Err(KdmError::InvalidValue { ty: "$shallow".into(), field: "version".into(), reason: "names changes this replica does not have".into() });
        }
        let frontiers = if self.reaches(at) { self.doc.vv_to_frontiers(&at.0) } else { self.doc.shallow_since_frontiers() };
        let bytes = self.doc.export(ExportMode::shallow_snapshot(&frontiers)).map_err(|error| KdmError::Encoding(error.to_string()))?;
        Ok(envelope::wrap(self.doc_id, &bytes))
    }

    /// Whether this replica holds only part of the document's history: it was loaded from a
    /// [`Replica::shallow_snapshot`] (or from a snapshot of a shallow replica).
    pub fn is_shallow(&self) -> bool {
        self.doc.is_shallow()
    }

    /// The version a shallow replica's retained history starts at (its root): it has every change
    /// after it, and none of the history it summarizes. `None` for a full replica.
    pub fn shallow_root(&self) -> Option<Version> {
        self.is_shallow().then(|| Version(self.doc.shallow_since_vv().to_vv()))
    }

    /// Whether `version` is at or after this replica's shallow root: always, on a full replica.
    fn reaches(&self, version: &Version) -> bool {
        self.shallow_root().is_none_or(|root| version.includes(&root))
    }

    /// Replaces this replica's document with `snapshot` (a full or shallow snapshot of the same
    /// document, as a server answers it) plus every change this replica has that `snapshot`
    /// lacks, and answers the objects whose state changed. For a shallow replica whose import
    /// failed with [`KdmError::HistoryMissing`]: a newer snapshot from the server holds the
    /// changes it could not take, rooted early enough for them, and this replica's own changes
    /// (pushed or not) are kept on top. The state is what importing every change of both would
    /// give.
    ///
    /// Refuses ([`KdmError::WrongDocument`]) a snapshot of another document, what
    /// [`Replica::load`] refuses, and ([`KdmError::HistoryMissing`]) a shallow snapshot whose root
    /// is after changes of this replica it lacks; a refused rebase changes nothing. Clears the undo
    /// and redo history, like any load.
    pub fn rebase(&mut self, snapshot: &[u8]) -> Result<BTreeSet<ObjectId>> {
        let (doc_id, _) = envelope::open(snapshot)?;
        if doc_id != self.doc_id {
            return Err(KdmError::WrongDocument { expected: self.doc_id.to_string(), found: doc_id.to_string() });
        }
        let mut base = Self::load(Arc::clone(&self.schema), snapshot, self.actor)?;
        if !base.version().includes(&self.version()) {
            base.import_changes(&self.export_changes(&base.version())?)?;
            if !base.version().includes(&self.version()) {
                // This replica is shallow and the snapshot is older than its root: the changes in
                // between are in neither.
                return Err(KdmError::HistoryMissing(SNAPSHOT_BEFORE_ROOT.into()));
            }
        }
        let objects = |value: Value| match value {
            Value::Object(mut state) => match state.remove(OBJECTS) {
                Some(Value::Object(objects)) => objects,
                _ => serde_json::Map::new(),
            },
            _ => serde_json::Map::new(),
        };
        let before = objects(self.state_json()?);
        let after = objects(base.state_json()?);
        let changed: BTreeSet<ObjectId> =
            before.keys().chain(after.keys()).filter(|id| before.get(*id) != after.get(*id)).map(|id| ObjectId::from_string(id.clone())).collect();
        self.doc = base.doc;
        self.undo = base.undo;
        self.imported_registers.clear();
        self.kept_registers.clear();
        self.own_registers.clear();
        self.local_writes.clear();
        for (peer, end) in base.pending {
            let known = self.pending.entry(peer).or_insert(end);
            *known = (*known).max(end);
        }
        self.note_pending(None);
        self.reopen_undo_group();
        self.changed.extend(changed.iter().cloned());
        Ok(changed)
    }

    /// Undoes the person's last transaction on this replica (the `person` scope, M12a). Changes from
    /// other replicas and from other scopes (an agent's) are kept, including later changes to the
    /// same object and to the same field: a register another replica or scope wrote after the
    /// undone transaction keeps that value (M12). The objects it changes are reported by
    /// [`Replica::take_changed`].
    pub fn undo(&mut self) -> Result<bool> {
        self.undo_or_redo(UndoScope::Person, true)
    }

    /// Redoes the person's last undone transaction, keeping other replicas' and scopes' later
    /// changes and reporting what it changes like [`Replica::undo`].
    pub fn redo(&mut self) -> Result<bool> {
        self.undo_or_redo(UndoScope::Person, false)
    }

    /// Undoes the last transaction of `scope` on this replica, like [`Replica::undo`] for the person.
    pub fn undo_in(&mut self, scope: UndoScope) -> Result<bool> {
        self.undo_or_redo(scope, true)
    }

    /// Redoes the last undone transaction of `scope`, like [`Replica::redo`] for the person.
    pub fn redo_in(&mut self, scope: UndoScope) -> Result<bool> {
        self.undo_or_redo(scope, false)
    }

    fn undo_or_redo(&mut self, scope: UndoScope, undo: bool) -> Result<bool> {
        self.end_undo_group();
        // Who wrote each register's current value, when an undo must keep it: another replica
        // (`None`), or another scope of this one.
        let mut others: Vec<(Register, Option<LoroValue>, Option<Option<UndoScope>>)> =
            self.others_registers().into_iter().map(|(register, value)| (register, value, None)).collect();
        others.extend(self.other_scopes_registers(scope).into_iter().map(|(register, value, by)| (register, value, Some(by))));
        let manager = self.undo.of(scope);
        let (done, changed, registers) = observe_changes(&self.doc, || if undo { manager.undo() } else { manager.redo() }.map_err(engine));
        self.changed.extend(changed);
        let done = done?;
        for register in &registers {
            let map = self.doc.get_map(register.0.clone());
            let value = match map.get(&register.1) {
                Some(ValueOrContainer::Value(value)) => Some(value),
                Some(ValueOrContainer::Container(_)) => continue,
                None => None,
            };
            self.own_registers.insert(register.clone(), value.clone());
            self.local_writes.insert(register.clone(), (Some(scope), value));
        }
        // The engine's inverse operation sets a register back even when another replica or another
        // scope wrote it later; put those back to that value, in a `system` commit (not an undo
        // step), so the result is as if the undo had skipped them.
        let touched: HashSet<&Register> = registers.iter().collect();
        let mut restored = false;
        for (register, value, by) in others {
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
            match by {
                // Still the other scope's write, for its own undo and for this scope's next one.
                Some(by) => {
                    self.local_writes.insert(register, (by, value));
                }
                None => {
                    self.local_writes.remove(&register);
                    self.kept_registers.insert(register, value);
                }
            }
            restored = true;
        }
        if restored {
            self.doc.set_next_commit_origin(OriginKind::System.as_str());
            self.doc.set_next_commit_message(&Origin::system("keep-later-changes").encode_commit(self.schema.schema_version));
            self.doc.commit();
        }
        Ok(done)
    }

    /// The registers whose current value this replica wrote in another scope than `scope` (or in
    /// a `system` or `import` transaction), with that value and its scope. Forgets the writes
    /// whose value was changed since by anyone.
    fn other_scopes_registers(&mut self, scope: UndoScope) -> Vec<(Register, Option<LoroValue>, Option<UndoScope>)> {
        let doc = &self.doc;
        let me = self.actor.get();
        let mut out = Vec::new();
        self.local_writes.retain(|register, (by, value)| {
            let map = doc.get_map(register.0.clone());
            let now = match map.get(&register.1) {
                Some(ValueOrContainer::Value(now)) => Some(now),
                Some(ValueOrContainer::Container(_)) => return false,
                None => None,
            };
            if &now != value || map.get_last_editor(&register.1) != Some(me) {
                return false;
            }
            if *by != Some(scope) {
                out.push((register.clone(), now, *by));
            }
            true
        });
        out
    }

    /// Records the registers a local transaction of `scope` wrote, with their values.
    fn note_own_writes(&mut self, writes: Vec<(ObjectId, Option<String>, String, Option<Value>)>, scope: Option<UndoScope>) {
        for (id, field, key, value) in writes {
            let Ok(object) = read::object_map(&self.doc, &id) else { continue };
            let container = match field {
                None => loro::ContainerTrait::id(&object),
                Some(field) => match object.get(&field) {
                    Some(ValueOrContainer::Container(loro::Container::Map(map))) => loro::ContainerTrait::id(&map),
                    _ => continue,
                },
            };
            let value = value.map(crate::value::to_loro);
            self.local_writes.insert((container.clone(), key.clone()), (scope, value.clone()));
            self.own_registers.insert((container, key), value);
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

    /// Whether [`Replica::undo`] has a transaction of the person to undo.
    pub fn can_undo(&self) -> bool {
        self.undo.person.can_undo()
    }

    /// Whether [`Replica::redo`] has an undone transaction of the person to redo.
    pub fn can_redo(&self) -> bool {
        self.undo.person.can_redo()
    }

    /// Whether [`Replica::undo_in`] has a transaction of `scope` to undo.
    pub fn can_undo_in(&self, scope: UndoScope) -> bool {
        self.undo.get(scope).can_undo()
    }

    /// Whether [`Replica::redo_in`] has an undone transaction of `scope` to redo.
    pub fn can_redo_in(&self, scope: UndoScope) -> bool {
        self.undo.get(scope).can_redo()
    }

    /// Starts an undo group: the transactions until [`Replica::end_undo_group`] undo and redo as
    /// one step. Groups do not nest ([`KdmError::InvalidValue`]). An undo or a redo ends the open
    /// group first, so undo while grouping reverts the group as one step. An import that changes
    /// what the group changed splits it in two undo steps: the transactions before the import and
    /// those after it. A group spans both undo scopes (M12a): the person's transactions in it are
    /// one person step, and an agent's are one agent step.
    pub fn begin_undo_group(&mut self) -> Result<()> {
        if self.grouping {
            return Err(KdmError::InvalidValue { ty: "$undo".into(), field: "group".into(), reason: "is already open".into() });
        }
        self.undo.person.group_start().map_err(engine)?;
        if let Err(error) = self.undo.agent.group_start() {
            self.undo.person.group_end();
            return Err(engine(error));
        }
        self.grouping = true;
        Ok(())
    }

    /// Ends the open undo group; does nothing when none is open.
    pub fn end_undo_group(&mut self) {
        if self.grouping {
            self.undo.person.group_end();
            self.undo.agent.group_end();
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
        let started = |result: std::result::Result<(), LoroError>| matches!(result, Ok(()) | Err(LoroError::UndoGroupAlreadyStarted));
        if !(started(self.undo.person.group_start()) && started(self.undo.agent.group_start())) {
            self.undo.person.group_end();
            self.undo.agent.group_end();
            self.grouping = false;
        }
    }

    /// A draft of this document (standard 2.0 A12): a new writable replica of `actor` holding
    /// every change this one has, with no undo history. Edits made on it stay there until
    /// [`Replica::merge_changes`] takes them into another replica of the document.
    pub fn fork(&self, actor: ActorId) -> Result<Replica> {
        self.fork_at(&self.version(), actor)
    }

    /// A draft of this document as it was at `version` (see [`Replica::fork`]). `version` must be
    /// one this replica has reached ([`KdmError::InvalidValue`] otherwise). A shallow replica
    /// forks only at its current version ([`KdmError::HistoryMissing`] otherwise): earlier
    /// versions are read from the server.
    pub fn fork_at(&self, version: &Version, actor: ActorId) -> Result<Replica> {
        if !self.version().includes(version) {
            return Err(KdmError::InvalidValue { ty: "$draft".into(), field: "version".into(), reason: "names changes this replica does not have".into() });
        }
        let doc = if !self.is_shallow() {
            self.doc.fork_at(&self.doc.vv_to_frontiers(&version.0)).map_err(engine)?
        } else if *version == self.version() {
            self.doc.fork()
        } else {
            // The engine forks a shallow document only as a whole; the TypeScript one has no other
            // way to make one at an earlier version, so neither implementation does.
            return Err(KdmError::HistoryMissing(VERSION_BEFORE_ROOT.into()));
        };
        crate::marks::configure(&doc, &self.schema);
        Self::attach(doc, self.doc_id, Arc::clone(&self.schema), actor)
    }

    /// The canonical state this replica would have after importing `changes`, without changing it:
    /// the "after" of a draft's comparison ([`crate::diff::diff_states`]). Refuses changes that
    /// depend on changes this replica lacks, like [`Replica::merge_changes`].
    pub fn merged_state(&self, changes: &[u8]) -> Result<Value> {
        let merged = self.merged_doc(changes)?;
        read::state_json(&merged, &self.schema)
    }

    /// Takes another replica's changes (a draft's, made on a [`Replica::fork`]) into this one as
    /// one transaction of its own, with `origin`: one undo step of the person (unless `origin` is
    /// `system` or `import`), labelled as `origin` says. A draft's merge is the person's step even
    /// when an agent made the draft (M12a, KitAgent A14): the person approved it. The result is the state a CRDT import would give, so
    /// edits made here (or imported) since the draft was forked are kept; only the operations
    /// that turn this state into the merged one are written, under this replica's actor. Answers
    /// the objects that changed.
    ///
    /// The draft's changes themselves are not imported: merging the same changes twice writes
    /// their effect twice (text inserted twice, for instance), so a host merges a draft once.
    /// Refuses ([`KdmError::InvalidValue`]) changes that depend on changes this replica lacks,
    /// changes of another document ([`KdmError::WrongDocument`]), and changes that raise the
    /// minimum schema version beyond this replica's ([`KdmError::NewerSchema`]); a refused merge
    /// changes nothing.
    pub fn merge_changes(&mut self, changes: &[u8], origin: &Origin) -> Result<BTreeSet<ObjectId>> {
        let merged = self.merged_doc(changes)?;
        let from = self.doc.oplog_frontiers();
        let to = merged.oplog_frontiers();
        if from == to {
            return Ok(BTreeSet::new());
        }
        let diff = merged.diff(&from, &to).map_err(engine)?;
        let doc = &self.doc;
        let message = origin.encode_commit(self.schema.schema_version);
        let scope = UndoScope::of(origin.kind);
        let (applied, changed, registers) = observe_changes(doc, || {
            let applied = doc.apply_diff(diff);
            if applied.is_ok() {
                doc.set_next_commit_origin(scope.map_or(origin.kind.as_str(), |_| UndoScope::Person.as_str()));
                doc.set_next_commit_message(&message);
                doc.commit();
            }
            applied
        });
        if let Err(error) = applied {
            // The engine refused part of a difference it computed itself: put back what it
            // applied, outside the undo history, as `transact` does.
            self.doc.set_next_commit_origin(ROLLBACK);
            self.doc.commit();
            if self.doc.oplog_frontiers() != from {
                self.doc.revert_to(&from).map_err(engine)?;
                self.doc.set_next_commit_origin(ROLLBACK);
                self.doc.set_next_commit_message(&Origin::system("rollback").encode_commit(self.schema.schema_version));
                self.doc.commit();
            }
            return Err(engine(error));
        }
        for register in registers {
            let value = match self.doc.get_map(register.0.clone()).get(&register.1) {
                Some(ValueOrContainer::Value(value)) => Some(value),
                Some(ValueOrContainer::Container(_)) => continue,
                None => None,
            };
            self.local_writes.insert(register.clone(), (scope.map(|_| UndoScope::Person), value.clone()));
            self.own_registers.insert(register, value);
        }
        self.changed.extend(changed.iter().cloned());
        Ok(changed)
    }

    /// A copy of this document with `changes` imported, checked as [`Replica::merge_changes`] checks them.
    fn merged_doc(&self, changes: &[u8]) -> Result<LoroDoc> {
        let (doc_id, bytes) = envelope::open(changes)?;
        if doc_id != self.doc_id {
            return Err(KdmError::WrongDocument { expected: self.doc_id.to_string(), found: doc_id.to_string() });
        }
        let merged = self.doc.fork();
        crate::marks::configure(&merged, &self.schema);
        let status = merged.import(bytes).map_err(importing)?;
        if status.pending.is_some() {
            return Err(KdmError::InvalidValue { ty: "$draft".into(), field: "changes".into(), reason: "depend on changes this replica does not have".into() });
        }
        if let Some(found) = read::min_schema_version(&merged).filter(|found| *found > u64::from(self.schema.schema_version)) {
            return Err(KdmError::NewerSchema { found, reads: self.schema.schema_version });
        }
        Ok(merged)
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

/// What a shallow replica answers for a version before its root; the TypeScript
/// `errors.historyMissing` says the same.
const VERSION_BEFORE_ROOT: &str = "a shallow replica forks only at its current version; read earlier versions from the server";

/// What [`Replica::rebase`] answers for a snapshot older than a shallow replica's root.
const SNAPSHOT_BEFORE_ROOT: &str = "the snapshot is older than this shallow replica's root; rebase it on a newer one";

/// A shallow document as it was at `version` (at or after its root), with the same root: its
/// state at the root, then its retained changes up to `version`. The engine has no `fork_at` for
/// shallow documents.
fn shallow_fork_at(doc: &LoroDoc, version: &VersionVector) -> Result<LoroDoc> {
    let root = doc.shallow_since_frontiers();
    let encoding = |error: loro::LoroEncodeError| KdmError::Encoding(error.to_string());
    let forked = LoroDoc::new();
    forked.import(&doc.export(ExportMode::StateOnly(Some(Cow::Borrowed(&root)))).map_err(encoding)?).map_err(engine)?;
    let spans: Vec<IdSpan> = version.sub_iter(&forked.oplog_vv()).collect();
    if !spans.is_empty() {
        forked.import(&doc.export(ExportMode::UpdatesInRange { spans: Cow::Owned(spans) }).map_err(encoding)?).map_err(engine)?;
    }
    if forked.oplog_vv() != *version {
        return Err(KdmError::HistoryMissing(VERSION_BEFORE_ROOT.into()));
    }
    Ok(forked)
}

/// A replica's undo histories, one per undo scope (M12a). Each treats the other's transactions
/// as it treats other replicas' changes: they are not its steps, and its undo keeps them.
struct Histories {
    person: UndoManager,
    agent: UndoManager,
}

impl Histories {
    fn new(doc: &LoroDoc) -> Self {
        Self { person: undo_manager(doc, UndoScope::Person), agent: undo_manager(doc, UndoScope::Agent) }
    }

    fn get(&self, scope: UndoScope) -> &UndoManager {
        match scope {
            UndoScope::Person => &self.person,
            UndoScope::Agent => &self.agent,
        }
    }

    fn of(&mut self, scope: UndoScope) -> &mut UndoManager {
        match scope {
            UndoScope::Person => &mut self.person,
            UndoScope::Agent => &mut self.agent,
        }
    }
}

/// The undo history of `scope` on a replica's document.
fn undo_manager(doc: &LoroDoc, scope: UndoScope) -> UndoManager {
    let mut undo = UndoManager::new(doc);
    undo.set_merge_interval(0);
    undo.add_exclude_origin_prefix(ROLLBACK);
    // `system` transactions (repairs, migrations) are not undo steps: undo skips them like
    // changes from another replica, and they survive the undo of earlier transactions.
    undo.add_exclude_origin_prefix(OriginKind::System.as_str());
    // `import` transactions (changes merged from a file edited elsewhere) are not undo steps
    // either: a person's undo never reverts another tool's edit.
    undo.add_exclude_origin_prefix(OriginKind::Import.as_str());
    // The other scope's transactions, and its undo and redo, are not this scope's steps.
    let other = match scope {
        UndoScope::Person => UndoScope::Agent,
        UndoScope::Agent => UndoScope::Person,
    };
    undo.add_exclude_origin_prefix(other.as_str());
    undo.add_exclude_origin_prefix(ENGINE_UNDO);
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
