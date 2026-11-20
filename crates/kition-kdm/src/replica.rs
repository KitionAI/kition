// Copied from kition-sdk crates/kition-kdm/src/replica.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::mem;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use loro::event::Diff;
use loro::{
    Container, ContainerID, ContainerTrait, Counter, ExportMode, IdSpan, Index, LoroDoc, LoroMap, LoroValue, PeerID, ToJson, TreeID, TreeParentId,
    UndoItemMeta, UndoManager, ValueOrContainer, VersionRange, VersionVector,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{engine, importing};
use crate::read::{self, BIRTH, BIRTH_ROOT, META, OBJECTS, SCHEMA_VERSION};
use crate::value::canonical;
use crate::{ActorId, Changes, DocId, FieldKind, KDM_VERSION, KdmError, NodeRef, ObjectId, Origin, OriginKind, Result, Schema, TextRun, Tx, UndoScope};

/// The origin given to the partial operations of a transaction the engine refused while applying
/// it, and to their reversal, so the undo history never records either.
const ROLLBACK: &str = "kdm-rollback";

/// The engine's origin of its own undo and redo commits (loro 1.16.2), which the replica's own
/// write-backs of registers also take. One scope's undo is, for the other scope's history, a
/// change it did not make.
const ENGINE_UNDO: &str = "undo";

/// The commit origin of a transaction that only writes registers: the replica keeps its undo step
/// itself ([`Part::Registers`]), so the engine's histories never record it.
const REGISTER_STEP: &str = "kdm-registers";

/// The undo steps a scope keeps; the oldest beyond go (the engine's default, which the replica's
/// histories kept before they kept their own steps).
const MAX_STEPS: usize = 100;

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
/// Unlike the TypeScript `Replica`, this one has no `clear_redo`.
pub struct Replica {
    doc: LoroDoc,
    doc_id: DocId,
    schema: Arc<Schema>,
    actor: ActorId,
    undo: Histories,
    /// Set between [`Replica::begin_undo_group`] and [`Replica::end_undo_group`].
    grouping: bool,
    changed: Changes,
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

/// Objects and fields written by one undo step. `fields: None` holds the whole object
/// (creation or deletion); an empty set holds its existence and placement only.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UndoTouch {
    pub id: String,
    pub fields: Option<BTreeSet<String>>,
}

/// Merges `more` into `into`, which holds one touch per object sorted by id (and still does
/// afterwards): a touch of an object `into` holds adds its fields, or holds the whole object
/// (`fields: None`) when either does. Costs O(n + m log m) for `n` held and `m` more touches, so a
/// transaction that writes every record of a large table merges in one pass.
pub(crate) fn merge_undo_touches(into: &mut Vec<UndoTouch>, more: &[UndoTouch]) {
    fn add(held: &mut UndoTouch, touch: &UndoTouch) {
        match (&mut held.fields, &touch.fields) {
            (Some(fields), Some(more)) => fields.extend(more.iter().cloned()),
            _ => held.fields = None,
        }
    }
    let mut adding: Vec<&UndoTouch> = more.iter().collect();
    adding.sort_by(|a, b| a.id.cmp(&b.id));
    let mut held = mem::take(into).into_iter().peekable();
    let mut merged: Vec<UndoTouch> = Vec::with_capacity(held.len() + adding.len());
    for touch in adding {
        merged.extend(std::iter::from_fn(|| held.next_if(|next| next.id < touch.id)));
        match merged.last_mut() {
            Some(last) if last.id == touch.id => add(last, touch),
            _ => match held.next_if(|next| next.id == touch.id) {
                Some(mut next) => {
                    add(&mut next, touch);
                    merged.push(next);
                }
                None => merged.push(touch.clone()),
            },
        }
    }
    merged.extend(held);
    *into = merged;
}

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
        staged.apply(&doc, &schema).map_err(applying_failed)?;
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
        read::check_projected_storage(&doc, &schema)?;
        doc.set_peer_id(actor.get()).map_err(engine)?;
        let undo = Histories::new(&doc);
        Ok(Self {
            doc,
            doc_id,
            schema,
            actor,
            undo,
            grouping: false,
            changed: Changes::default(),
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
        let scope = UndoScope::of(origin.kind);
        // A transaction that only writes registers is an undo step the replica keeps itself: it
        // writes back the values noted here, and never asks the engine for them (the engine's undo
        // looks each one up in the document's history).
        let (writes, entries) = match scope.and_then(|_| staged.register_step(&self.doc)) {
            Some((writes, entries)) => (writes, Some(entries)),
            None => (staged.register_writes(&self.doc), None),
        };
        let touches = staged.undo_touches(&self.doc, &schema);
        let changes = staged.changes();
        if let Err(error) = staged.apply(&self.doc, &schema) {
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
        self.doc.set_next_commit_origin(if entries.is_some() { REGISTER_STEP } else { commit_origin(origin.kind) });
        self.doc.set_next_commit_message(&origin.encode_commit(self.schema.schema_version));
        match (scope, entries) {
            (Some(scope), Some(entries)) => {
                self.doc.commit();
                if !entries.is_empty() {
                    self.undo.record(scope, Part::Registers(entries), touches, self.grouping);
                }
            }
            (Some(scope), None) => {
                let last = self.prepare_engine_step(scope);
                self.doc.commit();
                self.note_engine_step(scope, last, touches);
            }
            (None, _) => self.doc.commit(),
        }
        self.changed.extend(changes);
        self.note_own_writes(writes, scope);
        Ok(value)
    }

    /// Before a commit that is a step of `scope` the engine's history records ([`Part::Engine`]):
    /// the engine keeps as many steps as the replica's history refers to, and this one. Answers
    /// the last serial given to an engine step, for [`Replica::note_engine_step`].
    fn prepare_engine_step(&mut self, scope: UndoScope) -> i64 {
        let history = self.undo.of(scope);
        let items = history.engine_items();
        history.engine.set_max_undo_steps(items + 1);
        self.undo.serial.load(Ordering::Relaxed)
    }

    /// After that commit: notes the step the engine recorded for it, if any (a commit that
    /// changed nothing is no step).
    fn note_engine_step(&mut self, scope: UndoScope, last: i64, touches: Vec<UndoTouch>) {
        if let Some(serial) = history_serial(self.undo.get(scope).engine.top_undo_value()).filter(|serial| *serial > last) {
            self.undo.record(scope, Part::Engine(serial), touches, self.grouping);
        }
    }

    pub fn exists(&self, id: &ObjectId) -> bool {
        read::object_map(&self.doc, id).is_ok()
    }

    /// Whether the engine holds its index of the history for checkouts ([`crate::testing`]).
    pub(crate) fn engine_history_cached(&self) -> bool {
        self.doc.has_history_cache()
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
    /// that names no object is skipped with its subtree, as in [`Replica::state_json`]; so is one
    /// naming a deleted object, which the state keeps.
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
            // A node naming no object, or a deleted one, is skipped with its subtree.
            let Some(object) = read::node_object(&tree, id).filter(|object| self.exists(object)) else { continue };
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

    /// Every object's id by its type, in one pass: [`Replica::objects_of_type`] for all types.
    pub(crate) fn objects_by_type(&self) -> std::collections::HashMap<String, Vec<ObjectId>> {
        read::objects_by_type(&self.doc)
    }

    /// The changes this replica has that a replica at `since` lacks.
    /// Exported bytes carry this document's id; see [`Replica::import_changes`].
    ///
    /// With `Version::empty()` (every change) the bytes always [`Replica::load`] as this document.
    /// A shallow replica (rule M16a) has no changes before its root, so for a `since` that does
    /// not reach its root (the empty version above all) it answers its snapshot: its state at the
    /// root with every change after it, which loads as a shallow replica with the same root and
    /// imports into any replica that has the root, as these changes would. On a full replica, and
    /// for a `since` at or after the root, the bytes are the changes alone.
    pub fn export_changes(&self, since: &Version) -> Result<Vec<u8>> {
        if !self.reaches(since) {
            return self.snapshot();
        }
        let bytes = self.doc.export(ExportMode::updates(&since.0)).map_err(|error| KdmError::Encoding(error.to_string()))?;
        Ok(envelope::wrap(self.doc_id, bytes))
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
        if let Err(error) = read::check_projected_storage(&self.doc, &self.schema) {
            self.restore(&before)?;
            return Err(error);
        }
        if let Some(found) = read::min_schema_version(&self.doc).filter(|found| *found > u64::from(self.schema.schema_version)) {
            self.restore(&before)?;
            return Err(KdmError::NewerSchema { found, reads: self.schema.schema_version });
        }
        let status = imported?;
        // Without an undo or redo step no undo reaches what the import wrote: a later step
        // writes such a register before its own undo can, and then it is this replica's.
        // Loading a document replays its stored changes this way.
        if self.has_steps() {
            self.imported_registers.extend(registers);
        }
        self.note_pending(status.pending.as_ref());
        let objects = changed.objects().clone();
        self.changed.extend(changed);
        Ok(objects)
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
        self.end_undo_group();
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

    /// The objects changed since the last call (of this or [`Replica::take_changes`]), by local
    /// transactions or imports.
    pub fn take_changed(&mut self) -> BTreeSet<ObjectId> {
        mem::take(&mut self.changed).into_objects()
    }

    /// [`Replica::take_changed`] with the map keys written, and their values now, in objects whose
    /// only changes were writes to map keys: a projection reads nothing back for them.
    pub fn take_changes(&mut self) -> Changes {
        mem::take(&mut self.changed)
    }

    /// A compacted copy of the whole document, for fast loading and new replicas.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let bytes = self.doc.export(ExportMode::Snapshot).map_err(|error| KdmError::Encoding(error.to_string()))?;
        Ok(envelope::wrap(self.doc_id, bytes))
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
        Ok(envelope::wrap(self.doc_id, bytes))
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

    /// Whether this replica carries the **document's whole history** (sync protocol S20): it is
    /// full, or it is shallow and its root is the document's birth, so no replica of the document
    /// can hold changes before it. A copy made by [`Replica::copy_as_new_document`] is born at its
    /// root, and every replica loaded from it, its snapshots and its drafts keep that root; a
    /// shallow snapshot taken later ([`Replica::shallow_snapshot`] after more changes) does not.
    ///
    /// The birth is the version the copy recorded in the change that made it, read from this
    /// replica's state **at its root**: a change after the root, which any client may make, never
    /// counts, and a value written in such a change could only name a version before the root it
    /// is part of. A server that trusts no client decides from the bytes alone. Shallow documents
    /// that record no birth (copies made before it was recorded) do not carry it.
    pub fn carries_whole_history(&self) -> bool {
        carries_whole_history(&self.doc)
    }

    /// [`Replica::carries_whole_history`] of the document `bytes` (a snapshot or a full export)
    /// hold, read without a schema, as a sync server reads a room's first state (rule S20).
    /// Bytes that are not a KDM export, or that do not decode, are [`KdmError::Encoding`].
    pub fn snapshot_carries_whole_history(bytes: &[u8]) -> Result<bool> {
        let (_, bytes) = envelope::open(bytes)?;
        let meta = LoroDoc::decode_import_blob_meta(bytes, true).map_err(|error| KdmError::Encoding(error.to_string()))?;
        if meta.mode != loro::EncodedBlobMode::ShallowSnapshot {
            return Ok(true);
        }
        let doc = LoroDoc::new();
        doc.import(bytes).map_err(|error| KdmError::Encoding(error.to_string()))?;
        Ok(carries_whole_history(&doc))
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
        self.end_undo_group();
        self.changed.extend(Changes::from(changed.clone()));
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
        let me = self.actor.get();
        let written = |doc: &LoroDoc| doc.oplog_vv().get(&me).copied().unwrap_or(0);
        let mut registers = Vec::new();
        loop {
            let Some(step) = self.undo.of(scope).pop(undo) else { return Ok(false) };
            let before = written(&self.doc);
            // The parts replay last first; each answers the part that replays it back, and those
            // are kept in the order they replayed, so the step they make replays last first too.
            let mut replayed = Vec::with_capacity(step.parts.len());
            for part in step.parts.into_iter().rev() {
                let back = match part {
                    Part::Engine(serial) => self.replay_engine(scope, undo, serial, &mut registers)?,
                    Part::Registers(entries) => self.write_back(entries, &mut registers)?,
                };
                replayed.extend(back);
            }
            // A step with nothing left to replay (what it wrote is gone: another replica deleted
            // the objects) is dropped, and the one before it replays instead, as the engine does
            // with its own steps.
            if written(&self.doc) != before {
                self.undo.of(scope).push_replayed(undo, Step { parts: replayed, touches: step.touches });
                break;
            }
        }
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
            // What the restore writes is part of what the undo changed (its values are the
            // ones to report).
            let doc = &self.doc;
            let ((), kept, _) = observe_changes(doc, || doc.commit());
            self.changed.extend(kept);
        }
        Ok(true)
    }

    /// Undoes (or redoes) the engine's step `serial` of `scope`, adding the registers it changed
    /// to `registers`. Answers the part that replays it back: the step the engine recorded for
    /// it. The engine has no such step when it has nothing left to replay (an earlier replay
    /// changed nothing, so the engine recorded none); then nothing happens.
    fn replay_engine(&mut self, scope: UndoScope, undo: bool, serial: i64, registers: &mut Vec<Register>) -> Result<Option<Part>> {
        let manager = &mut self.undo.of(scope).engine;
        let top = if undo { manager.top_undo_value() } else { manager.top_redo_value() };
        if history_serial(top) != Some(serial) {
            return Ok(None);
        }
        let last = self.undo.serial.load(Ordering::Relaxed);
        let manager = &mut self.undo.of(scope).engine;
        let (done, changed, written) = observe_changes(&self.doc, || if undo { manager.undo() } else { manager.redo() });
        // The engine's undo checks out across the history after the step and keeps what it read
        // of it parsed and indexed: of a large document's history, more than the document. It
        // reads it again for the next engine step.
        self.doc.release_parsed_history();
        self.changed.extend(changed);
        done.map_err(engine)?;
        registers.extend(written);
        let manager = &self.undo.get(scope).engine;
        let made = history_serial(if undo { manager.top_redo_value() } else { manager.top_undo_value() }).filter(|made| *made > last);
        Ok(made.map(Part::Engine))
    }

    /// Writes back each register of a step the replica keeps ([`Part::Registers`]) to the value
    /// its entry holds, in one commit, as the engine's undo writes back the registers of its own
    /// steps: every one, also when it holds that value already. Like those, the registers another
    /// replica or scope wrote later are then kept ([`Replica::undo_or_redo`]). Adds the registers
    /// it wrote to `registers`, and answers the part that replays it back: each register it
    /// changed, with the value it held before.
    fn write_back(&mut self, entries: Vec<Entry>, registers: &mut Vec<Register>) -> Result<Option<Part>> {
        let mut back = Vec::new();
        let start = registers.len();
        for mut entry in entries {
            let Some(map) = self.entry_map(&entry) else { continue };
            entry.container = map.id();
            let now = match map.get(&entry.key) {
                Some(ValueOrContainer::Value(value)) => Some(value),
                Some(ValueOrContainer::Container(_)) => continue,
                None => None,
            };
            if now == entry.value
                && let Some(value) = &entry.value
            {
                // The engine skips setting a key to the value it holds; deleting it first writes
                // it all the same.
                map.delete(&entry.key).map_err(engine)?;
                map.insert(&entry.key, value.clone()).map_err(engine)?;
            } else {
                put(&map, &entry.key, &entry.value)?;
            }
            match &entry.field {
                Some(field) => {
                    self.changed.insert_map_write(&entry.object, field, &entry.key, entry.value.clone().map(|value| canonical(value.to_json_value())))
                }
                None => self.changed.insert_object(entry.object.clone()),
            }
            registers.push((entry.container.clone(), entry.key.clone()));
            if now != entry.value {
                back.push(Entry { value: now, ..entry });
            }
        }
        if registers.len() > start {
            self.doc.set_next_commit_origin(ENGINE_UNDO);
            self.doc.commit();
        }
        Ok((!back.is_empty()).then_some(Part::Registers(back)))
    }

    /// The map holding an entry's register now: the one it was written in, or, when that one was
    /// deleted (its object deleted and brought back by an undo, which makes it anew), the
    /// object's map now. `None` when the object is gone.
    fn entry_map(&self, entry: &Entry) -> Option<LoroMap> {
        let map = self.doc.get_map(entry.container.clone());
        if !map.is_deleted() {
            return Some(map);
        }
        let object = read::object_map(&self.doc, &entry.object).ok()?;
        match &entry.field {
            None => Some(object),
            Some(field) => match object.get(field) {
                Some(ValueOrContainer::Container(Container::Map(map))) => Some(map),
                _ => None,
            },
        }
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
    fn note_own_writes(&mut self, writes: Vec<crate::tx::RegisterWrite>, scope: Option<UndoScope>) {
        for crate::tx::RegisterWrite { container, key, value } in writes {
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
        self.can_undo_in(UndoScope::Person)
    }

    /// Whether [`Replica::redo`] has an undone transaction of the person to redo.
    pub fn can_redo(&self) -> bool {
        self.can_redo_in(UndoScope::Person)
    }

    /// Whether either scope has a step to undo or redo.
    fn has_steps(&self) -> bool {
        [&self.undo.person, &self.undo.agent].into_iter().any(|history| !history.undo.is_empty() || !history.redo.is_empty())
    }

    /// Whether [`Replica::undo_in`] has a transaction of `scope` to undo.
    pub fn can_undo_in(&self, scope: UndoScope) -> bool {
        !self.undo.get(scope).undo.is_empty()
    }

    /// Whether [`Replica::redo_in`] has an undone transaction of `scope` to redo.
    pub fn can_redo_in(&self, scope: UndoScope) -> bool {
        !self.undo.get(scope).redo.is_empty()
    }

    /// The next undo step's original write footprint, including all transactions of a group.
    /// Reading it changes neither the document nor either history. Empty when no step exists.
    pub fn undo_touches_in(&self, scope: UndoScope) -> Vec<UndoTouch> {
        self.undo.get(scope).undo.last().map(|step| step.touches.clone()).unwrap_or_default()
    }

    /// The next redo step's original write footprint, with the same contract as `undo_touches_in`.
    pub fn redo_touches_in(&self, scope: UndoScope) -> Vec<UndoTouch> {
        self.undo.get(scope).redo.last().map(|step| step.touches.clone()).unwrap_or_default()
    }

    /// Starts an undo group: the transactions until [`Replica::end_undo_group`] undo and redo as
    /// one step. Groups do not nest ([`KdmError::InvalidValue`]). An undo or a redo ends the open
    /// group first, so undo while grouping reverts the group as one step. It stays one undo step
    /// when other replicas' changes arrive while it is open, also when they touch what the group
    /// changed (rule M12b): one undo takes back all of it and keeps their changes. A group spans
    /// both undo scopes (M12a): the person's transactions in it are one person step, and an
    /// agent's are one agent step.
    pub fn begin_undo_group(&mut self) -> Result<()> {
        if self.grouping {
            return Err(KdmError::InvalidValue { ty: "$undo".into(), field: "group".into(), reason: "is already open".into() });
        }
        self.grouping = true;
        Ok(())
    }

    /// Ends the open undo group; does nothing when none is open.
    pub fn end_undo_group(&mut self) {
        self.grouping = false;
        self.undo.person.grouped = false;
        self.undo.agent.grouped = false;
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

    /// A copy of this document as a **new document** (data model, "A copy is a new document"): the
    /// same objects, ids and content under the new permanent `doc_id`, as a writable replica of
    /// `actor`. For a template instantiated twice, a copied file, or the same bytes stored twice:
    /// each copy is its own document, with its own co-editing room. Unlike [`Replica::fork`] (a
    /// draft of the same document, merged back), a copy never merges with its source or another
    /// copy: [`Replica::import_changes`], [`Replica::merge_changes`] and [`Replica::rebase`] refuse
    /// each other's bytes ([`KdmError::WrongDocument`]).
    ///
    /// Answers a replica, as [`Replica::fork`] does, so a host edits it or stores its
    /// [`Replica::snapshot`]. The copy is a shallow replica (rule M16a) rooted at its own first
    /// change: it holds the current state and no history, so no deleted content, no earlier
    /// version and not the source's `docId` travel with it; it forks only at its current version,
    /// and [`Replica::changes_since`] a version before the copy is [`KdmError::HistoryMissing`]. Its
    /// undo and redo histories are empty. Object ids, tree node ids and every value are kept; a
    /// blob is its content-addressed reference, so it resolves wherever the source's blobs do (a
    /// host whose blob store is per document copies the referenced blobs too).
    ///
    /// There is no option to keep the history: the copy would share the source's change ids with
    /// another document's, every earlier version of it would name the source's `docId` (a fork or
    /// a checkout there disagrees with its own envelope), and deleted content would travel.
    ///
    /// Refuses ([`KdmError::InvalidValue`]) `doc_id` equal to this document's. The changes still
    /// pending on this replica are not in the copy.
    pub fn copy_as_new_document(&self, doc_id: DocId, actor: ActorId) -> Result<Replica> {
        if doc_id == self.doc_id {
            return Err(KdmError::InvalidValue { ty: "$copy".into(), field: "docId".into(), reason: "is this document's; a copy needs a new one".into() });
        }
        let encoding = |error: loro::LoroEncodeError| KdmError::Encoding(error.to_string());
        // The current state alone first, so the change that writes the new id is the copy's first
        // and only change, never one the engine merges with the source's last.
        let state = self.doc.export(ExportMode::shallow_snapshot(&self.doc.oplog_frontiers())).map_err(encoding)?;
        let doc = LoroDoc::new();
        crate::marks::configure(&doc, &self.schema);
        doc.import(&state).map_err(importing)?;
        doc.set_peer_id(actor.get()).map_err(engine)?;
        // The change records the copy's root below, its birth: the engine roots a shallow document
        // at its last operation, which is this change's second write, this actor's next operation
        // but one, so the root (as `shallow_root` answers it) is known before the change.
        let mut birth = doc.oplog_vv();
        let next = birth.get(&actor.get()).copied().unwrap_or(0);
        birth.insert(actor.get(), next + 1);
        doc.get_map(META).insert("docId", doc_id.to_string()).map_err(engine)?;
        doc.get_map(BIRTH).insert(BIRTH_ROOT, LoroValue::Binary(birth.encode().into())).map_err(engine)?;
        doc.set_next_commit_origin(OriginKind::System.as_str());
        doc.set_next_commit_message(&Origin::system("new-document").encode_commit(self.schema.schema_version));
        doc.commit();
        // Rooted after that change: the source's id is overwritten, not kept as history.
        let bytes = doc.export(ExportMode::shallow_snapshot(&doc.oplog_frontiers())).map_err(encoding)?;
        let copy = Self::load(Arc::clone(&self.schema), &envelope::wrap(doc_id, bytes), actor)?;
        if !copy.carries_whole_history() {
            return Err(KdmError::Engine("the copy is not rooted at the birth it records".into()));
        }
        Ok(copy)
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
        let message = origin.encode_commit(self.schema.schema_version);
        // A merge is the person's step even when an agent made the draft.
        let scope = UndoScope::of(origin.kind).map(|_| UndoScope::Person);
        let last = scope.map(|scope| self.prepare_engine_step(scope));
        let doc = &self.doc;
        let (applied, changed, registers) = observe_changes(doc, || {
            let applied = doc.apply_diff(diff);
            if applied.is_ok() {
                doc.set_next_commit_origin(scope.map_or(origin.kind.as_str(), UndoScope::as_str));
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
        if let (Some(scope), Some(last)) = (scope, last) {
            // Its footprint: every object it changed, whole.
            self.note_engine_step(scope, last, changed.objects().iter().map(|id| UndoTouch { id: id.to_string(), fields: None }).collect());
        }
        for register in registers {
            let value = match self.doc.get_map(register.0.clone()).get(&register.1) {
                Some(ValueOrContainer::Value(value)) => Some(value),
                Some(ValueOrContainer::Container(_)) => continue,
                None => None,
            };
            self.local_writes.insert(register.clone(), (scope, value.clone()));
            self.own_registers.insert(register, value);
        }
        let objects = changed.objects().clone();
        self.changed.extend(changed);
        Ok(objects)
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
        read::check_projected_storage(&merged, &self.schema)?;
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

    /// What changed since `since` (a version this replica reached), as a write's receipt: a
    /// [`crate::diff::StateDiff`] without `texts`, its values cut to excerpts, objects named by
    /// their tool ids where the schema declares them (OM9). Only the objects the changes since
    /// then touched are read, in this replica and in a fork at `since`; the answer equals
    /// [`crate::diff::diff_states`] of the two whole states. A version this replica's history does
    /// not hold (another document's, one from before a reload, one before a shallow root) is
    /// [`KdmError::HistoryMissing`].
    pub fn changes_since(&self, since: &Version) -> Result<crate::diff::StateDiff> {
        if !self.version().includes(since) {
            return Err(KdmError::HistoryMissing(VERSION_NOT_HELD.into()));
        }
        let schema = &self.schema;
        if *since == self.version() {
            return Ok(crate::diff::diff_objects(&[], &serde_json::Map::new(), &serde_json::Map::new(), &|_| None, false));
        }
        let before = self.fork_at(since, self.actor)?;
        let mut probe = self.fork_at(since, self.actor)?;
        let mut touched = probe.import_changes(&self.export_changes(since)?)?;
        // The trees holding an object deleted since: a tree keeps its node, which reads skip, so
        // the deletion is told at its place in them.
        let deleted: Vec<ObjectId> = touched.iter().filter(|id| !self.exists(id) && before.exists(id)).cloned().collect();
        touched.extend(before.tree_holders(&deleted));
        let read = |doc: &LoroDoc| -> Result<serde_json::Map<String, Value>> {
            let mut objects = serde_json::Map::new();
            let live = |id: &str| read::object_map(doc, &ObjectId::from_string(id)).is_ok();
            for id in &touched {
                if read::object_map(doc, id).is_ok() {
                    let mut object = read::object_json(doc, schema, id)?;
                    crate::diff::with_live_nodes(&mut object, &live);
                    objects.insert(id.to_string(), object);
                }
            }
            Ok(objects)
        };
        let (old, new) = (read(&before.doc)?, read(&self.doc)?);
        let ids: Vec<String> = touched.iter().map(ToString::to_string).collect();
        let type_of_id = |id: &str| {
            let id = ObjectId::from_string(id);
            read::object_type(&self.doc, &id).or_else(|_| read::object_type(&before.doc, &id)).ok()
        };
        let diff = crate::diff::diff_objects(&ids, &old, &new, &type_of_id, false).with_leaf_edits(schema);
        Ok(diff.with_tool_ids(schema, &crate::tool_ids::ToolIds::of_replica(&before), &crate::tool_ids::ToolIds::of_replica(self)))
    }

    /// The objects whose tree fields hold a node naming one of `ids`.
    fn tree_holders(&self, ids: &[ObjectId]) -> BTreeSet<ObjectId> {
        let mut found = BTreeSet::new();
        if ids.is_empty() {
            return found;
        }
        for (owner_type, def) in &self.schema.types {
            for (field, _) in def.fields.iter().filter(|(_, def)| def.kind == FieldKind::Tree) {
                for owner in self.objects_of_type(owner_type) {
                    let Ok(Some(tree)) = read::tree(&self.doc, &self.schema, &owner, field) else { continue };
                    if tree.nodes().into_iter().any(|node| read::node_object(&tree, node).is_some_and(|object| ids.contains(&object))) {
                        found.insert(owner.clone());
                    }
                }
            }
        }
        found
    }

    /// SHA-256 of the canonical state, as lowercase hex.
    pub fn state_hash(&self) -> Result<String> {
        let digest = Sha256::digest(self.state_json()?.to_string().as_bytes());
        Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

/// Whether `doc` is full, or shallow with its state at its root recording that root as its birth
/// ([`Replica::carries_whole_history`]).
fn carries_whole_history(doc: &LoroDoc) -> bool {
    if !doc.is_shallow() {
        return true;
    }
    let root = Version(doc.shallow_since_vv().to_vv());
    let Ok(state) = doc.export(ExportMode::StateOnly(Some(Cow::Owned(doc.shallow_since_frontiers())))) else { return false };
    let at_root = LoroDoc::new();
    if at_root.import(&state).is_err() {
        return false;
    }
    match at_root.get_map(BIRTH).get(BIRTH_ROOT) {
        Some(ValueOrContainer::Value(LoroValue::Binary(bytes))) => Version::decode(&bytes).is_ok_and(|birth| birth == root),
        _ => false,
    }
}

/// What a shallow replica answers for a version before its root; the TypeScript
/// `errors.historyMissing` says the same.
const VERSION_BEFORE_ROOT: &str = "a shallow replica forks only at its current version; read earlier versions from the server";

/// What [`Replica::changes_since`] answers for a version its history does not hold; the
/// TypeScript `changesSince` says the same.
const VERSION_NOT_HELD: &str = "the version is not in this replica's history (another document's, or the document was replaced since)";

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
    person: History,
    agent: History,
    /// The last serial given to a step of either engine history ([`Part::Engine`]).
    serial: Arc<AtomicI64>,
}

/// The undo and redo steps of one scope, last on top. The engine's history of the scope holds
/// the engine steps they refer to.
struct History {
    undo: Vec<Step>,
    redo: Vec<Step>,
    engine: UndoManager,
    /// Whether the top undo step is the open undo group's (M12b): the group's next transaction of
    /// this scope joins it.
    grouped: bool,
}

/// One undo (or redo) step: one transaction, or the transactions of one undo group, as the parts
/// that replay it in order (undone last first), with its original write footprint.
struct Step {
    parts: Vec<Part>,
    touches: Vec<UndoTouch>,
}

/// One transaction of a step, as the history replays it.
enum Part {
    /// A transaction the engine's history recorded, by the serial of its step there: any
    /// transaction but one that only writes registers. The engine undoes it as an inverse of its
    /// operations, transformed over later changes.
    Engine(i64),
    /// A transaction that only writes registers (register fields and keys of map fields of
    /// objects that existed before it): the registers it changed, each with the value to write
    /// back. Undoing it writes them back, and needs nothing of the document's history.
    Registers(Vec<Entry>),
}

/// One register of a [`Part::Registers`]: key `key` of map `container` (the object's own map for
/// a register field, `field`'s map for a key of a map field), and the value to write back
/// (`None`: delete the key).
pub(crate) struct Entry {
    pub(crate) container: ContainerID,
    pub(crate) key: String,
    pub(crate) object: ObjectId,
    pub(crate) field: Option<String>,
    pub(crate) value: Option<LoroValue>,
}

impl Histories {
    fn new(doc: &LoroDoc) -> Self {
        let serial = Arc::new(AtomicI64::new(0));
        Self { person: History::new(doc, UndoScope::Person, &serial), agent: History::new(doc, UndoScope::Agent, &serial), serial }
    }

    fn get(&self, scope: UndoScope) -> &History {
        match scope {
            UndoScope::Person => &self.person,
            UndoScope::Agent => &self.agent,
        }
    }

    fn of(&mut self, scope: UndoScope) -> &mut History {
        match scope {
            UndoScope::Person => &mut self.person,
            UndoScope::Agent => &mut self.agent,
        }
    }

    /// Notes a new transaction of `scope` with its footprint: a new undo step, or the open group's
    /// step of the scope when `grouping`. Clears the scope's redo steps.
    fn record(&mut self, scope: UndoScope, part: Part, touches: Vec<UndoTouch>, grouping: bool) {
        let history = self.of(scope);
        history.redo.clear();
        if grouping
            && history.grouped
            && let Some(step) = history.undo.last_mut()
        {
            step.parts.push(part);
            merge_undo_touches(&mut step.touches, &touches);
            return;
        }
        history.grouped = grouping;
        history.push(Step { parts: vec![part], touches });
    }
}

impl History {
    fn new(doc: &LoroDoc, scope: UndoScope, serial: &Arc<AtomicI64>) -> Self {
        Self { undo: Vec::new(), redo: Vec::new(), engine: undo_manager(doc, scope, serial), grouped: false }
    }

    /// The engine steps the undo steps refer to.
    fn engine_items(&self) -> usize {
        self.undo.iter().flat_map(|step| &step.parts).filter(|part| matches!(part, Part::Engine(_))).count()
    }

    /// Pushes an undo step, dropping the oldest beyond [`MAX_STEPS`].
    fn push(&mut self, step: Step) {
        self.undo.push(step);
        if self.undo.len() > MAX_STEPS {
            self.undo.remove(0);
        }
    }

    /// The top undo step (`undo`) or redo step.
    fn pop(&mut self, undo: bool) -> Option<Step> {
        if undo { self.undo.pop() } else { self.redo.pop() }
    }

    /// Pushes the step an undo (`undo`) or a redo replayed onto the other stack.
    fn push_replayed(&mut self, undo: bool, step: Step) {
        if undo {
            self.redo.push(step);
        } else {
            self.push(step);
        }
    }
}

/// The serial of an engine step, from its value.
fn history_serial(value: Option<LoroValue>) -> Option<i64> {
    match value {
        Some(LoroValue::I64(serial)) => Some(serial),
        _ => None,
    }
}

/// Sets `key` of `map` to `value`, or deletes it.
fn put(map: &LoroMap, key: &str, value: &Option<LoroValue>) -> Result<()> {
    match value {
        Some(value) => map.insert(key, value.clone()).map_err(engine),
        None => map.delete(key).map_err(engine),
    }
}

/// The engine's undo history of `scope` on a replica's document: the transactions of the scope
/// that are not only register writes (those are the replica's own, [`Part::Registers`]).
fn undo_manager(doc: &LoroDoc, scope: UndoScope, serial: &Arc<AtomicI64>) -> UndoManager {
    let mut undo = UndoManager::new(doc);
    undo.set_merge_interval(0);
    // Each step carries a new serial, which the replica's steps refer to it by.
    let pushing = Arc::clone(serial);
    undo.set_on_push(Some(Box::new(move |_, _, _| UndoItemMeta { value: LoroValue::I64(pushing.fetch_add(1, Ordering::Relaxed) + 1), cursors: Vec::new() })));
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
    // Transactions that only write registers are the replica's steps, not the engine's; for
    // the engine's steps they are changes made since, as another replica's are.
    undo.add_exclude_origin_prefix(REGISTER_STEP);
    undo
}

/// Runs `run` while observing which objects change ([`Changes`]: with the keys written in map
/// fields), and which registers inside objects. Change events are observed only during the call:
/// a document-wide subscription makes large local transactions slow to commit.
fn observe_changes<T>(doc: &LoroDoc, run: impl FnOnce() -> T) -> (T, Changes, Vec<Register>) {
    let found = Arc::new(Mutex::new((Changes::default(), Vec::new())));
    let sink = Arc::clone(&found);
    let subscription = doc.subscribe_root(Arc::new(move |event| {
        let Ok(mut found) = sink.lock() else { return };
        let (changes, registers) = &mut *found;
        for diff in event.events.iter() {
            let in_objects = matches!(diff.path.first(), Some((_, Index::Key(key))) if key.to_string() == OBJECTS);
            if !in_objects {
                continue;
            }
            match diff.path.get(1) {
                Some((_, Index::Key(key))) => {
                    let id = ObjectId::from_string(key.to_string());
                    if let Diff::Map(map) = &diff.diff {
                        for (field, value) in map.updated.iter() {
                            if !matches!(value, Some(ValueOrContainer::Container(_))) {
                                registers.push((diff.target.clone(), field.to_string()));
                            }
                        }
                    }
                    // Keys of a map field (the object's map, one level down) set to values or
                    // deleted; any other change is the object's.
                    match (&diff.diff, diff.path.get(2), diff.path.len()) {
                        (Diff::Map(map), Some((_, Index::Key(field))), 3)
                            if map.updated.values().all(|value| !matches!(value, Some(ValueOrContainer::Container(_)))) =>
                        {
                            for (key, value) in map.updated.iter() {
                                let value = match value {
                                    Some(ValueOrContainer::Value(value)) => Some(canonical(value.to_json_value())),
                                    _ => None,
                                };
                                changes.insert_map_write(&id, field.as_ref(), key.as_ref(), value);
                            }
                        }
                        _ => changes.insert_object(id),
                    }
                }
                _ => {
                    if let Diff::Map(map) = &diff.diff {
                        for key in map.updated.keys() {
                            changes.insert_object(ObjectId::from_string(key.to_string()));
                        }
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

    /// Puts the envelope in front of the engine's bytes in their own buffer: a copy would hold a
    /// large document's snapshot twice.
    pub(super) fn wrap(doc_id: DocId, mut bytes: Vec<u8>) -> Vec<u8> {
        let header: Vec<u8> = [MAGIC.as_slice(), doc_id.as_bytes().as_slice()].concat();
        bytes.reserve_exact(header.len());
        bytes.splice(0..0, header);
        bytes
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

    /// A bulk create (a table's records) kept a note of every cell it wrote, which grew the
    /// replica's memory with every record: notes of registers in objects the same transaction
    /// creates are never read, since no undo reaches such a register before a later write replaces
    /// the note (undoing the creation deletes the whole object).
    #[test]
    fn a_transaction_keeps_no_notes_of_the_objects_it_creates() {
        let schema = Arc::new(Schema::parse(include_str!("../tests/fixtures/test-schema.json")).unwrap());
        let mut replica = Replica::create(schema, DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
        let person = Origin::person("user:test");
        let sheet = replica
            .transact(&person, |tx| {
                let sheet = tx.create("Sheet", serde_json::Map::new())?;
                for cell in 0..100 {
                    tx.map_set(&sheet, "cells", &format!("c{cell}"), json!(cell))?;
                }
                Ok(sheet)
            })
            .unwrap();
        assert_eq!((replica.own_registers.len(), replica.local_writes.len()), (0, 0));
        // A later write to one of them is noted, and an agent's later write survives the person's
        // undo of it, as before.
        replica.transact(&person, |tx| tx.map_set(&sheet, "cells", "c1", json!("person"))).unwrap();
        assert_eq!((replica.own_registers.len(), replica.local_writes.len()), (1, 1));
        replica.transact(&Origin::agent("agent:test"), |tx| tx.map_set(&sheet, "cells", "c1", json!("agent"))).unwrap();
        assert!(replica.undo().unwrap());
        assert_eq!(replica.map_get(&sheet, "cells", "c1").unwrap(), json!("agent"));
        assert!(replica.undo().unwrap());
        assert!(!replica.exists(&sheet));
    }

    /// Loading a table replays its stored changes as imports: the replica kept a note of every
    /// cell they wrote, though without undo or redo steps no undo can reach them (a later step
    /// writes such a register before its undo can).
    #[test]
    fn an_import_before_any_undo_step_keeps_no_notes() {
        let schema = Arc::new(Schema::parse(include_str!("../tests/fixtures/test-schema.json")).unwrap());
        let person = Origin::person("user:test");
        let mut theirs = Replica::create(Arc::clone(&schema), DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
        let sheet = theirs.transact(&Origin::system("fixture"), |tx| tx.create("Sheet", serde_json::Map::new())).unwrap();
        let mut mine = Replica::load(schema, &theirs.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
        theirs
            .transact(&person, |tx| {
                for cell in 0..100 {
                    tx.map_set(&sheet, "cells", &format!("c{cell}"), json!(cell))?;
                }
                Ok(())
            })
            .unwrap();
        mine.import_changes(&theirs.export_changes(&mine.version()).unwrap()).unwrap();
        assert!(mine.imported_registers.is_empty());
        // After a step of its own, an import is noted, and the person's undo keeps the other
        // replica's later write, as before.
        mine.transact(&person, |tx| tx.map_set(&sheet, "cells", "c1", json!("mine"))).unwrap();
        theirs.import_changes(&mine.export_changes(&theirs.version()).unwrap()).unwrap();
        theirs.transact(&person, |tx| tx.map_set(&sheet, "cells", "c1", json!("theirs"))).unwrap();
        mine.import_changes(&theirs.export_changes(&mine.version()).unwrap()).unwrap();
        assert_eq!(mine.imported_registers.len(), 1);
        assert!(mine.undo().unwrap());
        assert_eq!(mine.map_get(&sheet, "cells", "c1").unwrap(), json!("theirs"));
    }
}
