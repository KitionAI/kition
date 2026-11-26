// Copied from kition-sdk crates/kition-kdm/src/replica.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::mem;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::content::{self, ContentVersion};
use crate::ids::new_lineage;
use crate::merge::MergeConflict;
use crate::read;
use crate::store::op::{Change, Op, inverse_all};
use crate::store::scalar::Scalar;
use crate::store::transform::{edits_any, exclude, inverse_with_places, sequences_of, through};
use crate::store::{Field, Store};
use crate::tool_ids::ToolIds;
use crate::{ActorId, Changes, DocId, KDM_VERSION, KdmError, NodeRef, ObjectId, Origin, OriginKind, Result, Schema, TextRun, Tx, UndoScope};

/// The undo steps a scope keeps; the oldest beyond go.
const MAX_STEPS: usize = 100;

/// The changes a replica keeps in its log (plan 2026-11-24, section 1.7), and the bytes they may
/// hold: the oldest go first beyond either.
const LOG_CHANGES: usize = 10_000;
const LOG_BYTES: usize = 64 << 20;

/// A replica's version (plan 2026-11-24, section 1.3): its line of changes (`lineage`) and how
/// many changes of that line its state holds (`seq`). Two replicas at one version hold one state.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Version(Option<([u8; 16], u64)>);

impl Version {
    /// The version before everything: every version includes it.
    pub fn empty() -> Self {
        Self(None)
    }

    /// The version's bytes: none for the empty version, else the 16 bytes of the lineage and
    /// `seq` as 8 bytes big-endian. Equal versions are equal bytes.
    pub fn encode(&self) -> Vec<u8> {
        match &self.0 {
            None => Vec::new(),
            Some((lineage, seq)) => [lineage.as_slice(), &seq.to_be_bytes()].concat(),
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() {
            return Ok(Self::empty());
        }
        let bad = || KdmError::Encoding(format!("a version is 0 or 24 bytes, not {}", bytes.len()));
        let (lineage, seq) = bytes.split_first_chunk::<16>().ok_or_else(bad)?;
        let seq: [u8; 8] = seq.try_into().map_err(|_| bad())?;
        Ok(Self(Some((*lineage, u64::from_be_bytes(seq)))))
    }

    /// Whether this version holds every change `other` holds: `other` is empty, or on the same
    /// line and not after this one.
    pub fn includes(&self, other: &Version) -> bool {
        match (&self.0, &other.0) {
            (_, None) => true,
            (None, Some(_)) => false,
            (Some((mine, seq)), Some((theirs, other_seq))) => mine == theirs && seq >= other_seq,
        }
    }

    fn at(lineage: [u8; 16], seq: u64) -> Self {
        Self(Some((lineage, seq)))
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

/// Objects and fields written by one undo step. `fields: None` holds the whole object
/// (creation or deletion); an empty set holds its existence and placement only.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UndoTouch {
    pub id: String,
    pub fields: Option<BTreeSet<String>>,
}

/// Merges `more` into `into`, which holds one touch per object sorted by id (and still does
/// afterwards): a touch of an object `into` holds adds its fields, or holds the whole object
/// (`fields: None`) when either does.
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

/// What one [`Replica::undo_in`] or [`Replica::redo_in`] (and [`Replica::undo`], [`Replica::redo`])
/// took off its stack, top first, each step by its write footprint ([`Replica::undo_touches_in`]).
///
/// A step with nothing left to change (its objects gone since, or its own changes cancelling
/// out) is **passed over**: it leaves the stack and changes nothing, and the call goes on to the
/// step below it. When one is taken back (`taken`), the steps passed over on the way join it: the
/// one redo (or undo) step the call leaves brings back all of them together. When none is (the
/// stack was empty, or held only steps to pass over), `taken` is `None`, the steps passed over
/// are gone from the stack all the same, and nothing changed: so [`Replica::can_undo_in`] is
/// true before such a call and false after it, and the call answers that it did nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UndoOutcome {
    /// The steps passed over, top first.
    pub passed: Vec<Vec<UndoTouch>>,
    /// The step taken back, or `None` when none was.
    pub taken: Option<Vec<UndoTouch>>,
}

impl UndoOutcome {
    /// Whether a step was taken back.
    pub fn is_done(&self) -> bool {
        self.taken.is_some()
    }

    /// How many steps the call took off its stack: those passed over and the one taken back.
    pub fn steps(&self) -> usize {
        self.passed.len() + usize::from(self.taken.is_some())
    }
}

/// What one [`Replica::merge_changes`] took into the document: the objects that changed, and the
/// undo scope its one step was recorded in (KitModel M12a).
///
/// A merged draft is a step of the **person** who accepts it, even when an agent made the draft
/// and the merge is recorded with the agent's origin: the person approved it. A kit that keeps an
/// undo history of its own beside the replica's records the step in `scope`, never in the scope
/// of the origin's kind. `scope` is `None` when no step was recorded: the draft changed nothing,
/// or the origin is `system` or `import`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DraftMerge {
    /// The objects that changed.
    pub objects: BTreeSet<ObjectId>,
    /// The undo scope the merge's step was recorded in: [`UndoScope::Person`], or `None` for none.
    pub scope: Option<UndoScope>,
}

/// The operations of one change as the log and the undo history hold them: shared, and, for an
/// undo or redo that took back a change exactly, that change's operations read backwards.
#[derive(Clone, Debug)]
struct Ops {
    ops: Arc<Vec<Op>>,
    /// The change is the inverse of `ops`.
    inverted: bool,
}

impl Ops {
    fn plain(ops: Vec<Op>) -> Self {
        Self { ops: Arc::new(ops), inverted: false }
    }

    /// The change's operations, in the order they applied.
    fn forward(&self) -> Vec<Op> {
        if self.inverted { inverse_all(self.ops.iter()) } else { self.ops.as_ref().clone() }
    }

    /// The change's operations, in the order they applied, each naming the positions it frees or
    /// takes (an exact undo's read with [`inverse_with_places`]): a draft's merge compares and
    /// carries the draft's operations over them.
    fn forward_placed(&self) -> Vec<Op> {
        if self.inverted { inverse_with_places(self.ops.iter()) } else { self.ops.as_ref().clone() }
    }

    /// The operations that take the change back.
    fn backward(&self) -> Vec<Op> {
        if self.inverted { self.ops.as_ref().clone() } else { inverse_all(self.ops.iter()) }
    }

    fn inverse(&self) -> Self {
        Self { ops: Arc::clone(&self.ops), inverted: !self.inverted }
    }

    fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    /// The operations of [`Ops::forward`] that edit the positions of `fields`, for a transform:
    /// an undo's read with every position it frees or takes ([`inverse_with_places`]).
    fn forward_in(&self, fields: &std::collections::HashSet<(&ObjectId, &str)>) -> Vec<Op> {
        if self.inverted {
            inverse_with_places(self.ops.iter()).into_iter().filter(|op| edits_any(op, fields)).collect()
        } else {
            self.ops.iter().filter(|op| edits_any(op, fields)).cloned().collect()
        }
    }
}

/// One change of the log.
#[derive(Clone, Debug)]
struct Entry {
    seq: u64,
    actor: ActorId,
    origin: Origin,
    schema_version: u32,
    ops: Ops,
    /// For an undo or a redo: the changes (by `seq`) it took back. Composed with them it changes
    /// nothing, so a later undo is carried over neither ([`Replica::carried_over`]).
    cancels: Vec<u64>,
    /// About the memory it holds, for the log's limit.
    size: usize,
}

/// The changes of this session, oldest first (plan 2026-11-24, section 1.7).
#[derive(Clone, Debug, Default)]
struct Log {
    /// The version's `seq` before the first entry.
    base: u64,
    entries: VecDeque<Entry>,
    bytes: usize,
}

impl Log {
    fn starting_at(base: u64) -> Self {
        Self { base, entries: VecDeque::new(), bytes: 0 }
    }

    fn push(&mut self, entry: Entry) {
        self.bytes += entry.size;
        self.entries.push_back(entry);
        while self.entries.len() > LOG_CHANGES || (self.bytes > LOG_BYTES && self.entries.len() > 1) {
            let Some(first) = self.entries.pop_front() else { break };
            self.bytes -= first.size;
            self.base = first.seq;
        }
    }

    /// Whether the log holds every change after `seq`.
    fn covers(&self, seq: u64) -> bool {
        seq >= self.base
    }

    fn after(&self, seq: u64) -> impl Iterator<Item = &Entry> {
        self.entries.iter().filter(move |entry| entry.seq > seq)
    }

    fn get(&self, seq: u64) -> Option<&Entry> {
        seq.checked_sub(self.base + 1).and_then(|at| usize::try_from(at).ok()).and_then(|at| self.entries.get(at)).filter(|entry| entry.seq == seq)
    }

    /// Drops the entries after `seq`.
    fn truncate(&mut self, seq: u64) {
        while self.entries.back().is_some_and(|entry| entry.seq > seq) {
            if let Some(last) = self.entries.pop_back() {
                self.bytes -= last.size;
            }
        }
    }
}

/// About the memory a change's operations hold.
fn size_of_ops(ops: &[Op]) -> usize {
    ops.iter()
        .map(|op| {
            192 + match op {
                Op::TextInsert { text, .. } => text.len(),
                Op::TextDelete { was, .. } => was.iter().map(|run| run.insert.len() + 32).sum(),
                Op::Create { object, .. } => 64 * object.fields().count(),
                Op::Delete { was: Some(object), .. } => 64 * object.fields().count(),
                _ => 0,
            }
        })
        .sum()
}

/// One copy of one document.
pub struct Replica {
    store: Store,
    schema: Arc<Schema>,
    actor: ActorId,
    lineage: [u8; 16],
    seq: u64,
    log: Log,
    undo: Histories,
    /// Set between [`Replica::begin_undo_group`] and [`Replica::end_undo_group`].
    grouping: bool,
    changed: Changes,
    /// The newest schema version a change this replica applied was written under (rule M5a).
    author_schema: Option<u32>,
    /// The tool ids of the current state, once read ([`Replica::tool_ids`]); every change of the
    /// state drops them ([`Replica::state_changed`]).
    tool_ids: std::sync::Mutex<Option<Arc<ToolIds>>>,
    /// The objects of the schema's root type ([`Replica::root_id`]), kept as changes create and
    /// delete them.
    roots: BTreeSet<ObjectId>,
}

impl Replica {
    /// A new, empty document. Only one replica creates a document; others [`Replica::load`] it.
    pub fn create(schema: Arc<Schema>, doc_id: DocId, actor: ActorId) -> Result<Self> {
        Self::create_with(schema, doc_id, actor, &Origin::system("create"), |_| Ok(())).map(|(replica, ())| replica)
    }

    /// A new document whose initial content `build` writes before the change log and undo
    /// history start: file imports and other bulk builds.
    pub fn create_with<R>(
        schema: Arc<Schema>,
        doc_id: DocId,
        actor: ActorId,
        origin: &Origin,
        build: impl FnOnce(&mut Tx<'_>) -> Result<R>,
    ) -> Result<(Self, R)> {
        let mut store = Store::new(doc_id, schema.kit.clone(), u64::from(schema.schema_version));
        let (value, ops) = {
            let mut tx = Tx::new(&store, &schema);
            let value = build(&mut tx)?;
            (value, tx.finish())
        };
        if ops.iter().any(|op| matches!(op, Op::SchemaVersion { .. })) && origin.kind != OriginKind::System {
            return Err(raise_refused(origin));
        }
        store.apply_all(ops, &schema).map_err(applying_failed)?;
        let author = schema.schema_version;
        let mut replica = Self::attach(store, schema, actor, new_lineage(), 0);
        replica.author_schema = Some(author);
        Ok((replica, value))
    }

    fn attach(store: Store, schema: Arc<Schema>, actor: ActorId, lineage: [u8; 16], seq: u64) -> Self {
        let roots = roots_of(&store, &schema);
        Self {
            store,
            schema,
            actor,
            lineage,
            seq,
            log: Log::starting_at(seq),
            undo: Histories::default(),
            grouping: false,
            changed: Changes::default(),
            author_schema: None,
            tool_ids: std::sync::Mutex::new(None),
            roots,
        }
    }

    /// Follows the objects of the root type through operations that applied (`forward`) or whose
    /// inverses applied.
    fn track_roots(&mut self, ops: &[Op], forward: bool) {
        let root = self.schema.root.as_str();
        for op in ops {
            match (op, forward) {
                (Op::Create { id, object, .. }, true) | (Op::Delete { id, was: Some(object), .. }, false) => {
                    if &**object.ty() == root {
                        self.roots.insert(id.clone());
                    }
                }
                (Op::Delete { id, .. }, true) | (Op::Create { id, .. }, false) => {
                    self.roots.remove(id);
                }
                _ => {}
            }
        }
    }

    /// The document's root object: the first object (by id) of the schema's root type, without a
    /// walk of the document.
    pub fn root_id(&self) -> Option<ObjectId> {
        self.roots.first().cloned()
    }

    /// The tool ids of the objects `ids`, read only at them ([`ToolIds::of_objects`]) when that is
    /// exact, else the whole document's ([`Replica::tool_ids`]): what a call naming a few objects
    /// (an agent's reply, the root of `model/describe`) costs is those objects.
    pub fn tool_ids_of(&self, ids: &BTreeSet<ObjectId>) -> Arc<ToolIds> {
        let store = &self.store;
        let schema = &self.schema;
        let read = ToolIds::of_objects(schema, ids, &|id| store.object(id).map(|object| object.ty().to_string()), &|id, field| {
            read::register(store, schema, id, field).unwrap_or(Value::Null)
        });
        read.map_or_else(|| self.tool_ids(), Arc::new)
    }

    /// Drops what was read from the state before it changed (the tool ids).
    fn state_changed(&mut self) {
        *self.tool_ids.get_mut().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    /// The tool ids of the current state ([`ToolIds::of_replica`]), read once per state: calls
    /// with no change between them answer one table without reading the document again (an
    /// engine names every agent reply with them, `modelReply`).
    pub fn tool_ids(&self) -> Arc<ToolIds> {
        let mut held = self.tool_ids.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(ids) = held.as_ref() {
            return Arc::clone(ids);
        }
        let ids = Arc::new(ToolIds::of_replica(self));
        *held = Some(Arc::clone(&ids));
        ids
    }

    /// Opens content (a file's `content.json`, on a new line of changes) or a snapshot (the
    /// version it holds) as a writable replica of `actor`. Refuses ([`KdmError::Schema`]) a
    /// document of another kit or of another KDM version, ([`KdmError::NewerSchema`]) one whose
    /// minimum schema version (rule M20) is newer than `schema`'s, and ([`KdmError::Encoding`])
    /// bytes that are not content.
    pub fn load(schema: Arc<Schema>, bytes: &[u8], actor: ActorId) -> Result<Self> {
        let read = content::read(bytes, "KDM content", &schema)?;
        Self::loaded(schema, read, actor)
    }

    /// [`Replica::load`] of the bytes `reader` yields, read in chunks as the parser needs them: a
    /// large `content.json` streamed from a file or a container's entry is never held whole beside
    /// the store it fills. Answers and refuses what `load` does for the same bytes (an error
    /// reading them is [`KdmError::Encoding`]).
    pub fn load_from(schema: Arc<Schema>, reader: impl std::io::Read, actor: ActorId) -> Result<Self> {
        let read = content::read_from(reader, "KDM content", &schema)?;
        Self::loaded(schema, read, actor)
    }

    /// The replica of what [`content::read`] read.
    fn loaded(schema: Arc<Schema>, read: content::Read, actor: ActorId) -> Result<Self> {
        if read.top.as_ref().is_some_and(|top| top.contains_key("changes")) {
            return Err(KdmError::Encoding("not a snapshot: these are changes only (load a snapshot or content)".into()));
        }
        let content = content::decode(read)?;
        let version = content.version;
        let store = Self::checked_store(&schema, content)?;
        let (lineage, seq, author) = match version {
            Some(version) => (version.lineage, version.seq, version.author_schema_version.and_then(|author| u32::try_from(author).ok())),
            None => (new_lineage(), 0, None),
        };
        let mut replica = Self::attach(store, schema, actor, lineage, seq);
        replica.author_schema = author;
        Ok(replica)
    }

    /// The store of `content`, checked against `schema`.
    fn checked_store(schema: &Schema, content: content::Content) -> Result<Store> {
        if content.kit != schema.kit {
            return Err(KdmError::Schema(format!("the document belongs to \"{}\", not `{}`", content.kit, schema.kit)));
        }
        if content.schema_version > u64::from(schema.schema_version) {
            return Err(KdmError::NewerSchema { found: content.schema_version, reads: schema.schema_version });
        }
        let store = Store::from_content(content)?;
        read::check_projected_storage(&store, schema)?;
        Ok(store)
    }

    pub fn doc_id(&self) -> DocId {
        self.store.doc_id
    }

    pub fn actor(&self) -> ActorId {
        self.actor
    }

    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    pub fn version(&self) -> Version {
        Version::at(self.lineage, self.seq)
    }

    /// The document's minimum schema version (rule M20): the version it was created with, or the
    /// largest one a transaction raised it to ([`Tx::raise_schema_version`]).
    pub fn min_schema_version(&self) -> u32 {
        u32::try_from(self.store.schema_version).unwrap_or(u32::MAX)
    }

    /// The newest schema version a change this replica applied in this session was written under
    /// (rule M5a: every change records its author's schema version), or `None` before any. A
    /// version above this replica's schema means someone edits the document with a newer kit.
    pub fn author_schema_version(&self) -> Option<u32> {
        self.author_schema
    }

    /// Runs `f` as one transaction: one change, one undo step (of its origin's scope, M12a), one
    /// origin. Operations are staged while `f` runs and applied only if it succeeds: if `f` fails,
    /// the document, its version, and its exports are unchanged and the error is returned.
    pub fn transact<R>(&mut self, origin: &Origin, f: impl FnOnce(&mut Tx<'_>) -> Result<R>) -> Result<R> {
        let schema = Arc::clone(&self.schema);
        let (value, ops) = {
            let mut tx = Tx::new(&self.store, &schema);
            let value = f(&mut tx)?;
            (value, tx.finish())
        };
        if ops.is_empty() {
            return Ok(value);
        }
        if ops.iter().any(|op| matches!(op, Op::SchemaVersion { .. })) && origin.kind != OriginKind::System {
            return Err(raise_refused(origin));
        }
        let applied = self.store.apply_all(ops, &schema).map_err(applying_failed)?;
        let touches = UndoScope::of(origin.kind).map(|_| touches_of(&applied));
        self.changed.extend(changes_of(&applied));
        let ops = Ops::plain(applied);
        let seq = self.commit(origin, ops.clone(), self.schema.schema_version, Vec::new());
        if let (Some(scope), Some(touches)) = (UndoScope::of(origin.kind), touches) {
            self.undo.record(scope, Part { seq, ops }, touches, self.grouping);
        }
        Ok(value)
    }

    /// Logs an applied change as the next one (an undo or a redo with the changes it `cancels`);
    /// answers its `seq`.
    fn commit(&mut self, origin: &Origin, ops: Ops, schema_version: u32, cancels: Vec<u64>) -> u64 {
        self.state_changed();
        self.track_roots(&ops.ops, !ops.inverted);
        self.seq += 1;
        let size = if ops.inverted { 96 } else { 96 + size_of_ops(&ops.ops) };
        self.author_schema = self.author_schema.max(Some(schema_version));
        let base = self.log.base;
        let size = size + 8 * cancels.len();
        self.log.push(Entry { seq: self.seq, actor: self.actor, origin: origin.clone(), schema_version, ops, cancels, size });
        if self.log.base != base {
            self.undo.drop_before(self.log.base);
        }
        self.seq
    }

    pub fn exists(&self, id: &ObjectId) -> bool {
        self.store.contains(id)
    }

    pub fn object_type(&self, id: &ObjectId) -> Result<String> {
        read::object_type(&self.store, id)
    }

    pub fn get(&self, id: &ObjectId, field: &str) -> Result<Value> {
        read::register(&self.store, &self.schema, id, field)
    }

    pub fn text(&self, id: &ObjectId, field: &str) -> Result<String> {
        Ok(read::text(&self.store, &self.schema, id, field)?.map(|text| text.string()).unwrap_or_default())
    }

    /// A text field as runs of characters with equal marks (rule M19), in order: adjacent runs
    /// differ in their marks, no run is empty, and only the field's declared marks appear. A field
    /// that declares no marks reads as one unmarked run (none when empty). Positions are counted
    /// in Unicode scalar values (`insert.chars().count()`).
    pub fn text_delta(&self, id: &ObjectId, field: &str) -> Result<Vec<TextRun>> {
        read::text_runs(&self.store, &self.schema, id, field)
    }

    pub fn list(&self, id: &ObjectId, field: &str) -> Result<Vec<ObjectId>> {
        Ok(read::list(&self.store, &self.schema, id, field)?.to_vec())
    }

    /// One key of a map field, or `null`.
    pub fn map_get(&self, id: &ObjectId, field: &str, key: &str) -> Result<Value> {
        Ok(read::map(&self.store, &self.schema, id, field)?.and_then(|entries| entries.get_text(key)).map_or(Value::Null, Scalar::to_value))
    }

    /// A map field's keys and values, sorted by key (code point order, as in the canonical state).
    pub fn map_entries(&self, id: &ObjectId, field: &str) -> Result<Vec<(String, Value)>> {
        Ok(read::map(&self.store, &self.schema, id, field)?
            .map(|entries| entries.iter().map(|(key, value)| (key.to_text(), value.to_value())).collect())
            .unwrap_or_default())
    }

    /// The tree's nodes in pre-order (each parent before its children, siblings in order). A node
    /// naming an object the document does not hold is skipped with its subtree, as in
    /// [`Replica::state_json`].
    pub fn tree(&self, id: &ObjectId, field: &str) -> Result<Vec<TreeEntry>> {
        let mut out = Vec::new();
        let Some(tree) = read::tree(&self.store, &self.schema, id, field)? else { return Ok(out) };
        let mut stack: Vec<(&ObjectId, Option<NodeRef>)> = tree.children(None).iter().rev().map(|node| (node, None)).collect();
        while let Some((node, parent)) = stack.pop() {
            if !self.store.contains(node) {
                continue;
            }
            let handle = NodeRef(node.clone());
            stack.extend(tree.children(Some(node)).iter().rev().map(|child| (child, Some(handle.clone()))));
            out.push(TreeEntry { node: handle, object: node.clone(), parent });
        }
        Ok(out)
    }

    /// Ids of the objects of type `ty`, sorted. One pass over the objects.
    pub fn objects_of_type(&self, ty: &str) -> Vec<ObjectId> {
        read::objects_of_type(&self.store, ty)
    }

    /// Every object's id by its type, in one pass: [`Replica::objects_of_type`] for all types.
    pub(crate) fn objects_by_type(&self) -> std::collections::HashMap<String, Vec<ObjectId>> {
        read::objects_by_type(&self.store)
    }

    /// The changes a replica at `since` lacks (plan 2026-11-24, section 1.4): none when `since`
    /// is this version or ahead of it on its line; the changes after it, in order, when `since` is
    /// on this replica's line and in its log; otherwise a snapshot ([`Replica::snapshot`]). The bytes carry the document's
    /// id; see [`Replica::import_changes`].
    pub fn export_changes(&self, since: &Version) -> Result<Vec<u8>> {
        match &since.0 {
            Some((lineage, seq)) if *lineage == self.lineage && *seq <= self.seq && self.log.covers(*seq) => self.changes_bytes(*seq),
            // Ahead on this line: this replica has nothing that one lacks.
            Some((lineage, seq)) if *lineage == self.lineage && *seq > self.seq => self.changes_bytes(self.seq),
            _ => self.snapshot(),
        }
    }

    /// The changes after `seq` (in the log) as bytes.
    fn changes_bytes(&self, seq: u64) -> Result<Vec<u8>> {
        let changes: Vec<Value> = self
            .log
            .after(seq)
            .map(|entry| {
                Change { seq: entry.seq, actor: entry.actor, origin: entry.origin.clone(), schema_version: entry.schema_version, ops: entry.ops.forward() }
                    .to_json()
            })
            .collect();
        let after_actor = self.log.get(seq).map_or(Value::Null, |entry| Value::String(format!("{:016x}", entry.actor.get())));
        let bytes = serde_json::to_vec(&json!({
            "kdm": KDM_VERSION,
            "docId": self.store.doc_id.to_string(),
            "lineage": Uuid::from_bytes(self.lineage).to_string(),
            "after": { "seq": seq, "actor": after_actor },
            "changes": changes,
        }))
        .map_err(|error| KdmError::Encoding(error.to_string()))?;
        Ok(bytes)
    }

    /// Applies another replica's changes or snapshot (plan 2026-11-24, section 1.4) and answers
    /// the objects whose state changed.
    ///
    /// Changes: those this replica has already are skipped, so importing twice is harmless; the
    /// first new one must follow this replica's version, else [`KdmError::Stale`] and nothing
    /// changes, as when an operation's precondition does not hold. Each operation is checked
    /// against the schema as a transaction's is (a field used as another kind, a value a
    /// transaction refuses, an item of another type): a refusal is the transaction's error
    /// ([`KdmError::InvalidValue`]) and the whole import is refused. A snapshot replaces the state
    /// when it is on this replica's line and not behind it (or when this replica has applied no
    /// change yet), else [`KdmError::Stale`]. Bytes that are neither are [`KdmError::Encoding`];
    /// another document's are [`KdmError::WrongDocument`]; changes that raise the minimum schema
    /// version above this replica's schema are [`KdmError::NewerSchema`]. A refused import changes
    /// nothing.
    pub fn import_changes(&mut self, bytes: &[u8]) -> Result<BTreeSet<ObjectId>> {
        // A snapshot's objects are read straight into store objects (never a JSON tree of them).
        let schema = Arc::clone(&self.schema);
        let read = content::read(bytes, "KDM changes", &schema)?;
        let top = read.top.as_ref();
        let doc_id = top.and_then(|top| top.get("docId")).and_then(Value::as_str).ok_or_else(|| KdmError::Encoding("not KDM changes: no `docId`".into()))?;
        let doc_id = DocId::parse(doc_id)?;
        if doc_id != self.store.doc_id {
            return Err(KdmError::WrongDocument { expected: self.store.doc_id.to_string(), found: doc_id.to_string() });
        }
        if top.is_some_and(|top| top.contains_key("changes")) {
            let content::Read { top, .. } = read;
            return self.import_change_list(&Value::Object(top.unwrap_or_default()));
        }
        if read.objects.is_some() {
            return self.import_snapshot(read);
        }
        Err(KdmError::Encoding("not KDM changes: neither changes nor a snapshot".into()))
    }

    fn import_change_list(&mut self, value: &Value) -> Result<BTreeSet<ObjectId>> {
        let bad = |what: &str| KdmError::Encoding(format!("not KDM changes: no valid `{what}`"));
        let lineage = value.get("lineage").and_then(Value::as_str).and_then(|text| Uuid::parse_str(text).ok()).ok_or_else(|| bad("lineage"))?;
        if *lineage.as_bytes() != self.lineage {
            return Err(KdmError::Stale(OTHER_LINE.into()));
        }
        let after = value.get("after").and_then(|after| after.get("seq")).and_then(Value::as_u64).ok_or_else(|| bad("after"))?;
        if after > self.seq {
            return Err(KdmError::Stale(format!("the changes follow version {after}; this replica is at {}", self.seq)));
        }
        let after_actor = value.get("after").and_then(|after| after.get("actor")).and_then(Value::as_str).and_then(|hex| u64::from_str_radix(hex, 16).ok());
        if let (Some(theirs), Some(mine)) = (after_actor, self.log.get(after))
            && theirs != mine.actor.get()
        {
            return Err(KdmError::Stale(DIVERGED.into()));
        }
        let list = value.get("changes").and_then(Value::as_array).ok_or_else(|| bad("changes"))?;
        let changes = list.iter().map(|change| Change::from_json(change, &self.schema)).collect::<Result<Vec<_>>>()?;
        let start = self.seq;
        let author = self.author_schema;
        let mut changed = Changes::default();
        let mut failure = None;
        for change in changes {
            if change.seq <= self.seq {
                // Held already, unless this replica's change of that number is another one.
                if self.log.get(change.seq).is_some_and(|mine| mine.actor != change.actor) {
                    failure = Some(KdmError::Stale(DIVERGED.into()));
                    break;
                }
                continue;
            }
            if change.seq != self.seq + 1 {
                failure = Some(KdmError::Stale(format!("change {} does not follow version {}", change.seq, self.seq)));
                break;
            }
            match self.store.apply_all_checked(change.ops, &self.schema) {
                Ok(applied) => {
                    self.state_changed();
                    self.track_roots(&applied, true);
                    changed.extend(changes_of(&applied));
                    self.seq = change.seq;
                    let ops = Ops::plain(applied);
                    let size = 96 + size_of_ops(&ops.ops);
                    self.author_schema = self.author_schema.max(Some(change.schema_version));
                    let base = self.log.base;
                    self.log.push(Entry {
                        seq: change.seq,
                        actor: change.actor,
                        origin: change.origin,
                        schema_version: change.schema_version,
                        ops,
                        cancels: Vec::new(),
                        size,
                    });
                    if self.log.base != base {
                        self.undo.drop_before(self.log.base);
                    }
                }
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        if failure.is_none() && self.store.schema_version > u64::from(self.schema.schema_version) {
            failure = Some(KdmError::NewerSchema { found: self.store.schema_version, reads: self.schema.schema_version });
        }
        if failure.is_none()
            && let Err(error) = read::check_projected_storage(&self.store, &self.schema)
        {
            failure = Some(error);
        }
        if let Some(error) = failure {
            self.rewind(start)?;
            self.author_schema = author;
            return Err(error);
        }
        let objects = changed.objects().clone();
        self.changed.extend(changed);
        Ok(objects)
    }

    /// Takes back the changes logged after `seq`, newest first (an import that failed part way).
    fn rewind(&mut self, seq: u64) -> Result<()> {
        let undone: Vec<Op> = self.log.after(seq).collect::<Vec<_>>().into_iter().rev().flat_map(|entry| entry.ops.backward()).collect();
        for op in undone {
            let done = self.store.apply(op, &self.schema).map_err(applying_failed)?;
            self.track_roots(std::slice::from_ref(&done), true);
        }
        self.log.truncate(seq);
        self.seq = seq;
        self.state_changed();
        Ok(())
    }

    /// Takes back the changes this replica logged after `version`, newest first: its state,
    /// version and log become what they were at `version`, and the undo and redo steps of those
    /// changes go. For a replica whose changes were refused where they were sent (a scratch
    /// replica whose change the engine did not take): its log up to `version` stays, so
    /// [`Replica::changes_since`] an earlier version still answers, as it would not on a replica
    /// loaded again. Refuses ([`KdmError::HistoryMissing`]) a version on another line, ahead of
    /// this replica, or older than its log; then nothing changes. Answers the objects whose state
    /// changed.
    pub fn take_back_to(&mut self, version: &Version) -> Result<BTreeSet<ObjectId>> {
        let Some((lineage, seq)) = version.0 else { return Err(KdmError::HistoryMissing(VERSION_NOT_HELD.into())) };
        if lineage != self.lineage || seq > self.seq {
            return Err(KdmError::HistoryMissing(VERSION_NOT_HELD.into()));
        }
        if !self.log.covers(seq) {
            return Err(KdmError::HistoryMissing(BEFORE_LOG.into()));
        }
        let objects = changes_of(&self.log.after(seq).flat_map(|entry| entry.ops.forward()).collect::<Vec<_>>()).objects().clone();
        self.rewind(seq)?;
        self.undo.drop_after(seq);
        self.end_undo_group();
        self.changed.extend(Changes::from(objects.clone()));
        Ok(objects)
    }

    fn import_snapshot(&mut self, read: content::Read) -> Result<BTreeSet<ObjectId>> {
        let content = content::decode(read)?;
        let Some(version) = content.version else { return Err(KdmError::Stale("content without a version continues no line of changes".into())) };
        let fresh = self.seq == 0 && self.log.entries.is_empty();
        if !(fresh || (version.lineage == self.lineage && version.seq >= self.seq)) {
            return Err(KdmError::Stale(format!("the snapshot is not ahead of this replica on its line (it is at {})", version.seq)));
        }
        if version.lineage == self.lineage && version.seq == self.seq {
            return Ok(BTreeSet::new());
        }
        let store = Self::checked_store(&self.schema, content)?;
        let mut changed = BTreeSet::new();
        for (id, object) in self.store.objects() {
            if store.object(id) != Some(object) {
                changed.insert(id.clone());
            }
        }
        for (id, _) in store.objects() {
            if !self.store.contains(id) {
                changed.insert(id.clone());
            }
        }
        self.store = store;
        self.state_changed();
        self.roots = roots_of(&self.store, &self.schema);
        self.author_schema = self.author_schema.max(version.author_schema_version.and_then(|author| u32::try_from(author).ok()));
        self.lineage = version.lineage;
        self.seq = version.seq;
        self.log = Log::starting_at(version.seq);
        self.undo = Histories::default();
        self.end_undo_group();
        self.changed.extend(Changes::from(changed.clone()));
        Ok(changed)
    }

    /// The objects changed since the last call (of this or [`Replica::take_changes`]), by local
    /// transactions, undo and redo, or imports.
    pub fn take_changed(&mut self) -> BTreeSet<ObjectId> {
        mem::take(&mut self.changed).into_objects()
    }

    /// [`Replica::take_changed`] with the map keys written, and their values now, in objects whose
    /// only changes were writes to map keys: a projection reads nothing back for them.
    pub fn take_changes(&mut self) -> Changes {
        mem::take(&mut self.changed)
    }

    /// The document's state with its version (data model 7.4, rule C10): for the host's store,
    /// drafts, pages and new replicas. Never written into a person's file
    /// ([`Replica::content_snapshot`] is).
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let version = ContentVersion { lineage: self.lineage, seq: self.seq, author_schema_version: self.author_schema.map(u64::from) };
        content::write(&self.store, Some(version))
    }

    /// The document's **content**: what a kit writes into a person's file (data model 7.4). It
    /// depends on the state alone: a document saved again unchanged is the same bytes, and so is
    /// the same state saved by anyone.
    pub fn content_snapshot(&self) -> Result<Vec<u8>> {
        content::write(&self.store, None)
    }

    /// Undoes the person's last transaction on this replica (the `person` scope, M12a). Changes
    /// from other scopes and imports are kept, including later changes to the same object and to
    /// the same field: a register written since by someone else keeps that value (M12), and text
    /// and list positions follow the changes made since. The objects it changes are reported by
    /// [`Replica::take_changed`]. The answer says which steps the call took ([`UndoOutcome`]).
    pub fn undo(&mut self) -> Result<UndoOutcome> {
        self.undo_or_redo(UndoScope::Person, true)
    }

    /// Redoes the person's last undone transaction, keeping later changes like [`Replica::undo`].
    pub fn redo(&mut self) -> Result<UndoOutcome> {
        self.undo_or_redo(UndoScope::Person, false)
    }

    /// Undoes the last transaction of `scope` on this replica, like [`Replica::undo`] for the person.
    pub fn undo_in(&mut self, scope: UndoScope) -> Result<UndoOutcome> {
        self.undo_or_redo(scope, true)
    }

    /// Redoes the last undone transaction of `scope`, like [`Replica::redo`] for the person.
    pub fn redo_in(&mut self, scope: UndoScope) -> Result<UndoOutcome> {
        self.undo_or_redo(scope, false)
    }

    /// Takes back the top step of `scope`'s undo (or redo) stack as one new change: its parts'
    /// inverses, last first, carried over the changes made since ([`through`]), each fitted to
    /// the state ([`Store::fit`]); a register or map key someone else wrote since keeps that
    /// value. A step that changes nothing that way (its objects gone, or its own changes
    /// cancelling out) is passed over, and the one below it is taken back in the same call; what
    /// the passed steps replayed joins that change. Answers the steps passed over and the one
    /// taken back.
    fn undo_or_redo(&mut self, scope: UndoScope, undo: bool) -> Result<UndoOutcome> {
        self.end_undo_group();
        let schema = Arc::clone(&self.schema);
        let mut applied: Vec<Op> = Vec::new();
        let mut touches: Vec<UndoTouch> = Vec::new();
        let mut taken: Option<Ops> = None;
        let mut kept_changes = Changes::default();
        let mut steps = 0;
        let mut done = false;
        // The changes taken back so far in this call: the parts of the steps passed over and the
        // step's own later parts.
        let mut cancelled: Vec<u64> = Vec::new();
        let mut outcome = UndoOutcome::default();
        while let Some(step) = self.undo.of(scope).pop(undo) {
            steps += 1;
            let before = self.digest(&step.touches);
            let mut kept = false;
            let mut exact = step.parts.len() == 1;
            let start = applied.len();
            for part in step.parts.iter().rev() {
                let backward = part.ops.backward();
                let later = self.carried_over(part.seq, &backward, &cancelled);
                let (ops, moved) = through(backward, &later);
                exact &= !moved;
                for op in ops {
                    // An operation with nothing left to act on (its object gone) is skipped.
                    let Some(fitted) = self.store.fit(op.clone()) else {
                        exact = false;
                        continue;
                    };
                    if !self.holds_what_it_replaces(&fitted) {
                        // Kept: reported with the value it keeps, which is what the replica holds.
                        match &fitted {
                            Op::MapSet { id, field, key, .. } => {
                                let now = match self.store.field(id, field) {
                                    Some(Field::Map(entries)) => entries.get_text(key).map(Scalar::to_value),
                                    _ => None,
                                };
                                kept_changes.insert_map_write(id, field, key, now);
                            }
                            other => {
                                if let Some(id) = other.object() {
                                    kept_changes.insert_object(id.clone());
                                }
                            }
                        }
                        kept = true;
                        exact = false;
                        continue;
                    }
                    exact &= fitted == op;
                    match self.store.apply(fitted, &schema) {
                        Ok(done) => applied.push(done),
                        Err(_) => exact = false,
                    }
                }
                cancelled.push(part.seq);
            }
            merge_undo_touches(&mut touches, &step.touches);
            let changed =
                kept || self.digest(&step.touches) != before || applied.get(start..).is_some_and(|ops| ops.iter().any(|op| touches_outside(op, &step.touches)));
            if !changed {
                outcome.passed.push(step.touches.clone());
            }
            if changed {
                done = true;
                outcome.taken = Some(step.touches.clone());
                if steps == 1 && exact && !kept && step.parts.len() == 1 {
                    taken = step.parts.first().map(|part| part.ops.inverse());
                }
                break;
            }
        }
        if !done {
            self.store.revert(&applied, &schema);
            return Ok(outcome);
        }
        self.changed.extend(kept_changes);
        self.changed.extend(changes_of(&applied));
        let ops = match taken {
            Some(ops) => ops,
            None => Ops::plain(applied),
        };
        let parts = if ops.is_empty() {
            Vec::new()
        } else {
            let origin = Origin::new(if scope == UndoScope::Agent { OriginKind::Agent } else { OriginKind::Person }, "kdm").with_label(if undo {
                "undo"
            } else {
                "redo"
            });
            let seq = self.commit(&origin, ops.clone(), self.schema.schema_version, cancelled);
            vec![Part { seq, ops }]
        };
        self.undo.of(scope).push_replayed(undo, Step { parts, touches });
        Ok(outcome)
    }

    /// The changes logged after `seq` that an undo of a change logged at `seq` (whose inverse is
    /// `backward`) is carried over ([`through`]): their operations on the texts, lists and trees
    /// `backward` edits, without each undo or redo and the changes it took back, and without the
    /// changes `cancelled` (taken back already by this undo). A change and the undo that took it
    /// back compose to nothing: carrying an older step's inverse over the deletion and the
    /// re-insertion would lose the positions inside the re-inserted text or items, so the pair
    /// is taken out ([`exclude`]) and the changes between them become what they do without it.
    /// The most recent step of a scope with nothing but cancelled pairs after it is so undone
    /// exactly, by its own inverse.
    fn carried_over(&self, seq: u64, backward: &[Op], cancelled: &[u64]) -> Vec<Op> {
        let fields = sequences_of(backward);
        if fields.is_empty() {
            return Vec::new();
        }
        // The changes since `seq` by their own `seq`, each as its operations on `fields`.
        let mut segments: Vec<(u64, Vec<Op>)> = Vec::new();
        for entry in self.log.after(seq) {
            let pairs = !entry.cancels.is_empty() && entry.cancels.iter().all(|cancel| segments.iter().any(|(at, _)| at == cancel));
            if pairs {
                Self::take_out(&mut segments, &entry.cancels);
            } else {
                // A change, or an undo of changes not all among these: carried over as it is.
                segments.push((entry.seq, entry.ops.forward_in(&fields)));
            }
        }
        Self::take_out(&mut segments, cancelled);
        segments.into_iter().flat_map(|(_, ops)| ops).collect()
    }

    /// Takes the changes `cancels` (by `seq`, those among `segments`) out of `segments`, newest
    /// first, each with [`exclude`]: the segments after it become what they do without it.
    fn take_out(segments: &mut Vec<(u64, Vec<Op>)>, cancels: &[u64]) {
        let mut cancels: Vec<u64> = cancels.to_vec();
        cancels.sort_unstable();
        for seq in cancels.into_iter().rev() {
            let Some(at) = segments.iter().position(|(held, _)| *held == seq) else { continue };
            let (_, undone) = segments.remove(at);
            if undone.is_empty() {
                continue;
            }
            let (_, later) = segments.split_at_mut(at);
            let mut ops: Vec<Vec<Op>> = later.iter_mut().map(|(_, ops)| mem::take(ops)).collect();
            exclude(&mut ops, &undone);
            for ((_, held), moved) in later.iter_mut().zip(ops) {
                *held = moved;
            }
        }
    }

    /// Whether a register or map key an undo is about to write back still holds the value the
    /// step wrote (M12, M12a): else someone wrote it since, and it keeps their value.
    fn holds_what_it_replaces(&self, op: &Op) -> bool {
        match op {
            Op::Set { id, field, was, .. } => match self.store.field(id, field) {
                None => was.is_null(),
                Some(Field::Value(value)) => value.is(was),
                Some(_) => false,
            },
            Op::MapSet { id, field, key, was, .. } => {
                let now = match self.store.field(id, field) {
                    Some(Field::Map(entries)) => entries.get_text(key),
                    _ => None,
                };
                match (now, was) {
                    (None, None) => true,
                    (Some(now), Some(was)) => now.is(was),
                    _ => false,
                }
            }
            _ => true,
        }
    }

    /// A digest of what `touches` holds now: whether each object exists, and its fields named
    /// there (all of them for `fields: None`), read as [`Replica::state_json`] reads them.
    fn digest(&self, touches: &[UndoTouch]) -> Vec<u8> {
        let mut digest = Sha256::new();
        for touch in touches {
            let id = ObjectId::from_string(touch.id.clone());
            let state = match (&touch.fields, read::object_type(&self.store, &id)) {
                (_, Err(_)) => None,
                (None, Ok(_)) => read::object_json(&self.store, &self.schema, &id).ok(),
                (Some(fields), Ok(ty)) => Some(Value::Array(
                    fields
                        .iter()
                        .map(|name| {
                            let field = self.schema.field(&ty, name).ok();
                            field.and_then(|field| read::field_json(&self.store, &self.schema, &id, name, field).ok()).unwrap_or(Value::Null)
                        })
                        .collect(),
                )),
            };
            digest.update(touch.id.as_bytes());
            digest.update(serde_json::to_vec(&state).unwrap_or_default());
            digest.update([0]);
        }
        digest.finalize().to_vec()
    }

    /// Whether [`Replica::undo`] has a transaction of the person to undo.
    pub fn can_undo(&self) -> bool {
        self.can_undo_in(UndoScope::Person)
    }

    /// Whether [`Replica::redo`] has an undone transaction of the person to redo.
    pub fn can_redo(&self) -> bool {
        self.can_redo_in(UndoScope::Person)
    }

    /// Whether [`Replica::undo_in`] has a transaction of `scope` to undo.
    pub fn can_undo_in(&self, scope: UndoScope) -> bool {
        !self.undo.get(scope).undo.is_empty()
    }

    /// How many undo steps `scope` holds: one per transaction of the scope, or per undo group
    /// ([`Replica::begin_undo_group`]) however many transactions joined it. A kit that keeps an
    /// undo label of its own per step keeps as many labels as this answers (a `model/batch` is one
    /// group: its commands and raw writes make one step, so one label), dropping or adding labels
    /// after each command, batch, merge, undo and redo.
    pub fn undo_depth(&self, scope: UndoScope) -> usize {
        self.undo.get(scope).undo.len()
    }

    /// How many redo steps `scope` holds, like [`Replica::undo_depth`].
    pub fn redo_depth(&self, scope: UndoScope) -> usize {
        self.undo.get(scope).redo.len()
    }

    /// Whether an undo group is open ([`Replica::begin_undo_group`], a `model/batch` while it runs):
    /// a transaction of a scope that already has a step in the group joins it instead of adding one.
    pub fn in_undo_group(&self) -> bool {
        self.grouping
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
    /// when imported changes arrive while it is open, also when they touch what the group changed
    /// (rule M12b). A group spans both undo scopes (M12a): the person's transactions in it are one
    /// person step, and an agent's are one agent step.
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

    /// A draft of this document (standard 2.0 A12): a new writable replica of `actor` with the
    /// same state and version, no undo history and an empty log. Edits made on it stay there until
    /// [`Replica::merge_changes`] takes them into this replica.
    pub fn fork(&self, actor: ActorId) -> Result<Replica> {
        let mut draft = Self::attach(self.store.clone(), Arc::clone(&self.schema), actor, self.lineage, self.seq);
        draft.author_schema = self.author_schema;
        Ok(draft)
    }

    /// A draft of this document as it was at `version` (see [`Replica::fork`]): the current state
    /// with the changes since `version` taken back. `version` must be one this replica has
    /// ([`KdmError::InvalidValue`] otherwise) and its log still holds ([`KdmError::HistoryMissing`]
    /// for an earlier one).
    pub fn fork_at(&self, version: &Version, actor: ActorId) -> Result<Replica> {
        if !self.version().includes(version) {
            return Err(KdmError::InvalidValue { ty: "$draft".into(), field: "version".into(), reason: "names changes this replica does not have".into() });
        }
        let Some((_, seq)) = version.0 else { return Err(KdmError::HistoryMissing(BEFORE_LOG.into())) };
        if seq == self.seq {
            return self.fork(actor);
        }
        if !self.log.covers(seq) {
            return Err(KdmError::HistoryMissing(BEFORE_LOG.into()));
        }
        let store = self.store_at(seq)?;
        let mut draft = Self::attach(store, Arc::clone(&self.schema), actor, self.lineage, seq);
        draft.author_schema = self.author_schema;
        Ok(draft)
    }

    /// The state at `seq`, which the log covers: the current state with the changes since taken
    /// back.
    fn store_at(&self, seq: u64) -> Result<Store> {
        let mut store = self.store.clone();
        let entries: Vec<&Entry> = self.log.after(seq).collect();
        for entry in entries.into_iter().rev() {
            for op in entry.ops.backward() {
                store.apply(op, &self.schema).map_err(applying_failed)?;
            }
        }
        Ok(store)
    }

    /// The objects `touched` (every object the logged changes after `seq` wrote, and the trees
    /// they placed nodes in: [`Replica::touched_since`]) as they were at `seq`, in a store of
    /// their own: the changes since taken back there, without a copy of the document's index.
    fn subset_at(&self, seq: u64, touched: &BTreeSet<ObjectId>) -> Result<Store> {
        let mut store = self.store.subset(touched);
        let entries: Vec<&Entry> = self.log.after(seq).collect();
        for entry in entries.into_iter().rev() {
            for op in entry.ops.backward() {
                store.apply(op, &self.schema).map_err(applying_failed)?;
            }
        }
        Ok(store)
    }

    /// A copy of this document as a **new document** (data model, "A copy is a new document"): the
    /// same objects, ids and content under the new permanent `doc_id`, on a new line of changes,
    /// as a writable replica of `actor` with no history. Refuses ([`KdmError::InvalidValue`])
    /// `doc_id` equal to this document's.
    pub fn copy_as_new_document(&self, doc_id: DocId, actor: ActorId) -> Result<Replica> {
        if doc_id == self.store.doc_id {
            return Err(KdmError::InvalidValue { ty: "$copy".into(), field: "docId".into(), reason: "is this document's; a copy needs a new one".into() });
        }
        let mut store = self.store.clone();
        store.doc_id = doc_id;
        let mut copy = Self::attach(store, Arc::clone(&self.schema), actor, new_lineage(), 0);
        copy.author_schema = Some(self.schema.schema_version);
        Ok(copy)
    }

    /// The canonical state this replica would have after merging `changes` (a draft's) with
    /// [`Replica::merge_changes`], without changing it: the "after" of a draft's comparison
    /// ([`crate::diff::diff_states`]). Refuses what the merge refuses.
    pub fn merged_state(&self, changes: &[u8]) -> Result<Value> {
        let mut merged = self.fork(self.actor)?;
        merged.log = self.log.clone();
        merged.merge_changes(changes, &Origin::system("merged-state"))?;
        merged.state_json()
    }

    /// What merging `changes` (a draft's) would change in this replica now, without changing it:
    /// [`crate::diff::diff_states`] of the state now and [`Replica::merged_state`], read only at
    /// the objects the merge writes instead of building both whole states (a draft's comparison,
    /// `compareChanges`). Refuses what the merge refuses.
    pub fn compare_changes(&self, changes: &[u8]) -> Result<crate::diff::StateDiff> {
        let mut merged = self.fork(self.actor)?;
        merged.log = self.log.clone();
        let touched = merged.merge_changes(changes, &Origin::system("merged-state"))?.objects;
        diff_of_objects(&self.store, &|id: &ObjectId| self.store.contains(id), &merged.store, &self.schema, &touched)
    }

    /// [`crate::diff::diff_states`] of the state at `since` (a version this replica reached and its
    /// log holds, else [`KdmError::HistoryMissing`]) and the state now, read only at the objects
    /// the changes since then wrote: what a merge and the kit's repair after it changed, for the
    /// summary a merge answers.
    pub fn diff_since(&self, since: &Version) -> Result<crate::diff::StateDiff> {
        if !self.version().includes(since) {
            return Err(KdmError::HistoryMissing(VERSION_NOT_HELD.into()));
        }
        let seq = since.0.map_or(0, |(_, seq)| seq);
        if !self.log.covers(seq) {
            return Err(KdmError::HistoryMissing(BEFORE_LOG.into()));
        }
        let touched = self.touched_since(seq);
        let before = self.subset_at(seq, &touched)?;
        let live = |id: &ObjectId| if touched.contains(id) { before.contains(id) } else { self.store.contains(id) };
        diff_of_objects(&before, &live, &self.store, &self.schema, &touched)
    }

    /// The objects the logged changes after `seq` wrote: each operation's object, and the owners
    /// of the trees a creation or deletion placed or took a node in.
    fn touched_since(&self, seq: u64) -> BTreeSet<ObjectId> {
        let mut touched: BTreeSet<ObjectId> = BTreeSet::new();
        for entry in self.log.after(seq) {
            for op in entry.ops.forward_placed() {
                if let Some(id) = op.object() {
                    touched.insert(id.clone());
                }
                if let Op::Delete { trees, .. } | Op::Create { trees, .. } = &op {
                    touched.extend(trees.iter().map(|place| place.owner.clone()));
                }
            }
        }
        touched
    }

    /// Whether this replica and `other` hold the same objects, field by field (and one document,
    /// kit and minimum schema version), compared in the store without building either state: when
    /// true, their [`Replica::state_json`] are equal. (When false they may still be, when one
    /// holds list entries or tree nodes naming no object that the other's content left out.)
    pub fn same_state(&self, other: &Replica) -> bool {
        self.store.same_objects(&other.store)
    }

    /// The collisions that refuse merging `changes` (a draft's) into this replica now
    /// ([`Replica::merge_changes`], data model 6.6, rules D2 to D8), each naming the object, the
    /// field and the map key, list item or tree node; empty when the merge would apply. Refuses
    /// (as the merge does) changes of another document or of another line, and changes the log
    /// cannot place.
    pub fn merge_conflicts(&self, changes: &[u8]) -> Result<Vec<MergeConflict>> {
        let (base, ops) = self.draft_ops(changes)?;
        if ops.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self.merge_plan(base, ops)?.err().unwrap_or_default())
    }

    /// The version a draft's `changes` follow and their operations after it, checked to be of
    /// this document and line and not ahead of this replica.
    fn draft_ops(&self, changes: &[u8]) -> Result<(u64, Vec<Op>)> {
        let value = content::parse(changes, "KDM changes")?;
        let doc_id = DocId::parse(value.get("docId").and_then(Value::as_str).ok_or_else(|| KdmError::Encoding("not KDM changes: no `docId`".into()))?)?;
        if doc_id != self.store.doc_id {
            return Err(KdmError::WrongDocument { expected: self.store.doc_id.to_string(), found: doc_id.to_string() });
        }
        let lineage = value.get("lineage").and_then(Value::as_str).and_then(|text| Uuid::parse_str(text).ok());
        let Some(list) = value.get("changes").and_then(Value::as_array) else {
            return Err(KdmError::Stale("a draft's changes are changes, not a snapshot".into()));
        };
        if lineage.map(|lineage| *lineage.as_bytes()) != Some(self.lineage) {
            return Err(KdmError::Stale(OTHER_LINE.into()));
        }
        let base = value
            .get("after")
            .and_then(|after| after.get("seq"))
            .and_then(Value::as_u64)
            .ok_or_else(|| KdmError::Encoding("not KDM changes: no `after`".into()))?;
        if base > self.seq {
            return Err(KdmError::Stale(format!("the draft follows version {base}; this replica is at {}", self.seq)));
        }
        let drafted = list.iter().map(|change| Change::from_json(change, &self.schema)).collect::<Result<Vec<_>>>()?;
        Ok((base, drafted.into_iter().filter(|change| change.seq > base).flat_map(|change| change.ops).collect()))
    }

    /// A draft's operations `ops` (made at `base`) as they apply to this replica now (data model
    /// 6.6, rules D1 to D8), or the collisions that refuse them.
    fn merge_plan(&self, base: u64, ops: Vec<Op>) -> Result<std::result::Result<Vec<Op>, Vec<MergeConflict>>> {
        if base == self.seq {
            return Ok(Ok(ops));
        }
        if !self.log.covers(base) {
            return Err(KdmError::Stale(BEFORE_LOG.into()));
        }
        let ours: Vec<Op> = self.log.after(base).flat_map(|entry| entry.ops.forward_placed()).collect();
        let before = self.store_at(base)?;
        Ok(crate::merge::plan(ops, &ours, &before, &self.store))
    }

    /// Takes a draft's changes (made on a [`Replica::fork`] of this replica) into this one as one
    /// transaction of its own, with `origin`: one undo step of the person (unless `origin` is
    /// `system` or `import`), even when an agent made the draft and `origin` is the agent's (M12a,
    /// KitAgent A14): the person approved it. Answers the objects that changed and the scope the
    /// step was recorded in ([`DraftMerge`]): a kit with an undo history of its own records the
    /// step there, not in the scope of `origin`'s kind.
    ///
    /// When this replica has not changed since the draft was forked, the draft's operations apply
    /// as they are. When it has, they merge by the rules of data model 6.6 (D2 to D8): by what
    /// each side changed in the end, a register or map key per value, a text strictly, lists and
    /// trees by item, the draft's list and tree positions carried over the document's changes.
    /// A collision refuses the merge ([`KdmError::Stale`], naming each one as
    /// [`Replica::merge_conflicts`] answers it). Also refused: another document's changes
    /// ([`KdmError::WrongDocument`]), changes that do not follow a version of this replica
    /// ([`KdmError::Stale`]), changes that raise the minimum schema version beyond this replica's
    /// ([`KdmError::NewerSchema`]), and operations the schema refuses, checked as
    /// [`Replica::import_changes`] checks them. A refused merge changes nothing.
    pub fn merge_changes(&mut self, changes: &[u8], origin: &Origin) -> Result<DraftMerge> {
        self.merge_changes_repaired(changes, origin, |_, _| Ok(()))
    }

    /// [`Replica::merge_changes`] with the kit's repair of the merged state in the same change:
    /// `repair` runs in a transaction on the merged state with the objects the merge changed, and
    /// its writes join the merge's one change and one undo step (data model 6.6, D9), so one undo
    /// gives back the exact state before the merge and one redo the exact repaired state. A
    /// repair that fails refuses the merge, which then changes nothing.
    pub fn merge_changes_repaired(
        &mut self,
        changes: &[u8],
        origin: &Origin,
        repair: impl FnOnce(&mut Tx<'_>, &BTreeSet<ObjectId>) -> Result<()>,
    ) -> Result<DraftMerge> {
        let (base, ops) = self.draft_ops(changes)?;
        if ops.is_empty() {
            return Ok(DraftMerge::default());
        }
        let ops = match self.merge_plan(base, ops)? {
            Ok(ops) => ops,
            Err(conflicts) => {
                let named: Vec<String> = conflicts.iter().map(ToString::to_string).collect();
                return Err(KdmError::Stale(format!("the draft collides with the document's changes since it was made: {}", named.join("; "))));
            }
        };
        if ops.is_empty() {
            return Ok(DraftMerge::default());
        }
        let schema = Arc::clone(&self.schema);
        let applied = self.store.apply_all_checked(ops, &schema)?;
        if self.store.schema_version > u64::from(schema.schema_version) {
            let found = self.store.schema_version;
            self.store.revert(&applied, &schema);
            return Err(KdmError::NewerSchema { found, reads: schema.schema_version });
        }
        if let Err(error) = read::check_projected_storage(&self.store, &schema) {
            self.store.revert(&applied, &schema);
            return Err(error);
        }
        let merged = changes_of(&applied).objects().clone();
        let repaired = {
            let mut tx = Tx::new(&self.store, &schema);
            repair(&mut tx, &merged).map(|()| tx.finish())
        };
        let mut applied = applied;
        match repaired {
            Ok(ops) if ops.iter().any(|op| matches!(op, Op::SchemaVersion { .. })) => {
                self.store.revert(&applied, &schema);
                return Err(raise_refused(origin));
            }
            Ok(ops) if !ops.is_empty() => match self.store.apply_all(ops, &schema) {
                Ok(more) => applied.extend(more),
                Err(error) => {
                    self.store.revert(&applied, &schema);
                    return Err(applying_failed(error));
                }
            },
            Ok(_) => {}
            Err(error) => {
                self.store.revert(&applied, &schema);
                return Err(error);
            }
        }
        let changes = changes_of(&applied);
        let objects = changes.objects().clone();
        self.changed.extend(changes);
        let scope = UndoScope::of(origin.kind).map(|_| UndoScope::Person);
        let touches = objects.iter().map(|id| UndoTouch { id: id.to_string(), fields: None }).collect();
        let ops = Ops::plain(applied);
        let seq = self.commit(origin, ops.clone(), schema.schema_version, Vec::new());
        if let Some(scope) = scope {
            self.undo.record(scope, Part { seq, ops }, touches, self.grouping);
        }
        Ok(DraftMerge { objects, scope })
    }

    pub fn state_json(&self) -> Result<Value> {
        read::state_json(&self.store, &self.schema)
    }

    /// What changed since `since` (a version this replica reached and its log holds), as a
    /// write's receipt: a [`crate::diff::StateDiff`] without `texts`, its values cut to excerpts,
    /// objects named by their tool ids where the schema declares them (OM9). Only the objects the
    /// changes since then touched are read, now and as they were at `since` (taken back in a
    /// store of their own, [`Replica::subset_at`]), and the tool ids only of the objects the
    /// answer names when that is exact ([`ToolIds::of_objects`]); the answer equals
    /// [`crate::diff::diff_states`] of the two whole states. A version this replica's log does not
    /// hold (another document's, one from before a reload, one older than the log) is
    /// [`KdmError::HistoryMissing`].
    pub fn changes_since(&self, since: &Version) -> Result<crate::diff::StateDiff> {
        if !self.version().includes(since) {
            return Err(KdmError::HistoryMissing(VERSION_NOT_HELD.into()));
        }
        let schema = &self.schema;
        if *since == self.version() {
            return Ok(crate::diff::diff_objects(&[], &Map::new(), &Map::new(), &|_| None, false));
        }
        let seq = since.0.map_or(0, |(_, seq)| seq);
        if !self.log.covers(seq) {
            return Err(KdmError::HistoryMissing(BEFORE_LOG.into()));
        }
        let touched = self.touched_since(seq);
        // The touched objects as they were, taken back in a store of their own; every other
        // object is as it is now.
        let before = self.subset_at(seq, &touched)?;
        let at_since = |id: &ObjectId| if touched.contains(id) { &before } else { &self.store };
        let live = |id: &ObjectId| at_since(id).contains(id);
        let mut old = Map::new();
        let mut new = Map::new();
        for id in &touched {
            if before.contains(id) {
                old.insert(id.to_string(), read::object_json_in(&before, schema, id, &live)?);
            }
            if self.store.contains(id) {
                new.insert(id.to_string(), read::object_json(&self.store, schema, id)?);
            }
        }
        let ids: Vec<String> = touched.iter().map(ToString::to_string).collect();
        let type_of_id = |id: &str| {
            let id = ObjectId::from_string(id);
            read::object_type(&self.store, &id).or_else(|_| read::object_type(&before, &id)).ok()
        };
        let diff = crate::diff::diff_objects(&ids, &old, &new, &type_of_id, false).with_leaf_edits(schema);
        if !schema.has_tool_ids() {
            return Ok(diff);
        }
        // Tool ids of the objects the change set names, read at them, before and now; the whole
        // document's only when one of them needs more of it ([`ToolIds::of_objects`]).
        let named = crate::tool_ids::named_ids(&diff.to_json(), &|id| live(id) || self.store.contains(id));
        let type_at = |store: &Store, id: &ObjectId| store.object(id).map(|object| object.ty().to_string());
        let register_at = |store: &Store, id: &ObjectId, field: &str| read::register(store, schema, id, field).unwrap_or(Value::Null);
        let was = ToolIds::of_objects(schema, &named, &|id| type_at(at_since(id), id), &|id, field| register_at(at_since(id), id, field));
        let now = ToolIds::of_objects(schema, &named, &|id| type_at(&self.store, id), &|id, field| register_at(&self.store, id, field));
        Ok(match (was, now) {
            (Some(was), Some(now)) => diff.with_tool_ids(schema, &was, &now),
            _ => diff.with_tool_ids(schema, &ToolIds::of_replica(&self.fork_at(since, self.actor)?), &self.tool_ids()),
        })
    }

    /// SHA-256 of the canonical state, as lowercase hex.
    pub fn state_hash(&self) -> Result<String> {
        let digest = Sha256::digest(self.state_json()?.to_string().as_bytes());
        Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

/// The objects of `schema`'s root type in `store`.
fn roots_of(store: &Store, schema: &Schema) -> BTreeSet<ObjectId> {
    store.objects().filter(|(_, object)| **object.ty() == *schema.root).map(|(id, _)| id.clone()).collect()
}

/// [`crate::diff::diff_states`] of two states of one document, `before` and `after`, read only at
/// `touched` (the objects every change between them wrote), nodes naming no object left out as
/// `diff_states` leaves them. `before` may hold only `touched`; `before_live` says which objects
/// its state holds.
fn diff_of_objects(
    before: &Store,
    before_live: &dyn Fn(&ObjectId) -> bool,
    after: &Store,
    schema: &Schema,
    touched: &BTreeSet<ObjectId>,
) -> Result<crate::diff::StateDiff> {
    let read = |store: &Store, live: &dyn Fn(&ObjectId) -> bool| -> Result<Map<String, Value>> {
        let mut objects = Map::new();
        for id in touched {
            if store.contains(id) {
                let mut object = read::object_json_in(store, schema, id, live)?;
                crate::diff::with_live_nodes(&mut object, &|node: &str| live(&ObjectId::from_string(node)));
                objects.insert(id.to_string(), object);
            }
        }
        Ok(objects)
    };
    let (old, new) = (read(before, before_live)?, read(after, &|id: &ObjectId| after.contains(id))?);
    let mut ids: Vec<String> = touched.iter().map(ToString::to_string).collect();
    ids.sort();
    let type_of_id = |id: &str| {
        let id = ObjectId::from_string(id);
        read::object_type(after, &id).or_else(|_| read::object_type(before, &id)).ok()
    };
    Ok(crate::diff::diff_objects(&ids, &old, &new, &type_of_id, true))
}

/// The objects and fields applied operations wrote, one touch per object sorted by id (see
/// [`UndoTouch`]): a created or deleted object whole, a field written by name, and an item a list
/// or tree took or let go by its existence and placement.
fn touches_of(ops: &[Op]) -> Vec<UndoTouch> {
    let mut touches: BTreeMap<String, Option<BTreeSet<String>>> = BTreeMap::new();
    for op in ops {
        match op {
            Op::Create { id, .. } | Op::Delete { id, .. } => {
                touches.insert(id.to_string(), None);
            }
            Op::SchemaVersion { .. } => {}
            op => {
                if let (Some(id), Some(field)) = (op.object(), op.field())
                    && let Some(fields) = touches.entry(id.to_string()).or_insert_with(|| Some(BTreeSet::new()))
                {
                    fields.insert(field.to_string());
                }
                let item = match op {
                    Op::ListInsert { item, .. } => Some(item),
                    Op::ListRemove { item: Some(item), .. } | Op::ListMove { item: Some(item), .. } => Some(item),
                    Op::TreeCreate { node, .. } | Op::TreeMove { node, .. } | Op::TreeDelete { node, .. } => Some(node),
                    _ => None,
                };
                if let Some(item) = item {
                    touches.entry(item.to_string()).or_insert_with(|| Some(BTreeSet::new()));
                }
            }
        }
    }
    touches.into_iter().map(|(id, fields)| UndoTouch { id, fields }).collect()
}

/// Whether an operation an undo applied changed an object `touches` does not hold.
fn touches_outside(op: &Op, touches: &[UndoTouch]) -> bool {
    op.object().is_some_and(|id| touches.binary_search_by(|touch| touch.id.as_str().cmp(id.as_str())).is_err())
}

/// The objects applied operations changed ([`Changes`]: with the keys written in map fields).
fn changes_of(ops: &[Op]) -> Changes {
    let mut changes = Changes::default();
    for op in ops {
        match op {
            Op::MapSet { id, field, key, value, .. } => changes.insert_map_write(id, field, key, value.clone()),
            op => {
                if let Some(id) = op.object() {
                    changes.insert_object(id.clone());
                }
                if let Op::Delete { trees, .. } | Op::Create { trees, .. } = op {
                    for place in trees {
                        changes.insert_object(place.owner.clone());
                    }
                }
            }
        }
    }
    changes
}

/// What [`Replica::transact`] answers for a schema raise outside a `system` transaction.
fn raise_refused(origin: &Origin) -> KdmError {
    KdmError::InvalidValue {
        ty: "$meta".into(),
        field: "schemaVersion".into(),
        reason: format!("is raised only in a `system` transaction, not `{}`", origin.kind.as_str()),
    }
}

/// What an import answers for changes of another line.
const OTHER_LINE: &str = "the changes continue another line of changes (another replica's history)";

/// What an import answers for changes that went another way from the same version.
const DIVERGED: &str = "the changes went another way from this replica's version";

/// What a replica answers for a version its log no longer holds.
const BEFORE_LOG: &str = "the version is older than this replica's change log";

/// What [`Replica::changes_since`] answers for a version its history does not hold.
const VERSION_NOT_HELD: &str = "the version is not in this replica's history (another document's, or the document was replaced since)";

/// A failure while applying operations that validation accepted.
fn applying_failed(error: KdmError) -> KdmError {
    KdmError::Engine(format!("applying a validated transaction failed: {error}"))
}

/// A replica's undo histories, one per undo scope (M12a). Each treats the other's transactions
/// as it treats imported changes: they are not its steps, and its undo keeps them.
#[derive(Default)]
struct Histories {
    person: History,
    agent: History,
}

/// The undo and redo steps of one scope, last on top.
#[derive(Default)]
struct History {
    undo: Vec<Step>,
    redo: Vec<Step>,
    /// Whether the top undo step is the open undo group's (M12b): the group's next transaction of
    /// this scope joins it.
    grouped: bool,
}

/// One undo (or redo) step: one change, or the changes of one undo group, with its original
/// write footprint.
struct Step {
    parts: Vec<Part>,
    touches: Vec<UndoTouch>,
}

/// One change of a step: its number in the log and its operations.
#[derive(Clone)]
struct Part {
    seq: u64,
    ops: Ops,
}

impl Histories {
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

    /// Drops the undo and redo steps with a part older than `base`, the log's first change: an
    /// undo carries a part's inverse over every change logged after it ([`through`]), and the log
    /// no longer holds all of those, so the transform would be silently wrong.
    fn drop_before(&mut self, base: u64) {
        for history in [&mut self.person, &mut self.agent] {
            let held = |step: &Step| step.parts.iter().all(|part| part.seq >= base);
            let had = history.undo.len();
            history.undo.retain(held);
            history.redo.retain(held);
            if history.undo.len() < had && history.undo.is_empty() {
                history.grouped = false;
            }
        }
    }

    /// Drops the undo and redo steps with a part newer than `seq`: changes taken back
    /// ([`Replica::take_back_to`]).
    fn drop_after(&mut self, seq: u64) {
        for history in [&mut self.person, &mut self.agent] {
            let held = |step: &Step| step.parts.iter().all(|part| part.seq <= seq);
            history.undo.retain(held);
            history.redo.retain(held);
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

    /// Pushes the step an undo (`undo`) or a redo made onto the other stack.
    fn push_replayed(&mut self, undo: bool, step: Step) {
        if undo {
            self.redo.push(step);
        } else {
            self.push(step);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn replica() -> Replica {
        let schema = Arc::new(Schema::parse(include_str!("../tests/fixtures/test-schema.json")).unwrap());
        Replica::create(schema, DocId::new(), ActorId::from_u64(1).unwrap()).unwrap()
    }

    /// A bulk create (a table's records) is one change in the log, whose undo step refers to it,
    /// and an exact undo shares its operations instead of copying them.
    #[test]
    fn an_exact_undo_and_redo_share_the_operations_of_the_change_they_take_back() {
        let mut replica = replica();
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
        replica.transact(&person, |tx| tx.map_set(&sheet, "cells", "c1", json!("person"))).unwrap();
        assert!(replica.undo().unwrap().is_done());
        let last = replica.log.entries.back().unwrap();
        assert!(last.ops.inverted && last.size < 200);
        assert!(replica.redo().unwrap().is_done());
        assert_eq!(replica.map_get(&sheet, "cells", "c1").unwrap(), json!("person"));
        assert!(!replica.log.entries.back().unwrap().ops.inverted);
    }

    /// A bulk create (a table's records) keeps no note of the cells it writes: its undo step
    /// refers to the one change the log holds. A later write is a step too, and an agent's later
    /// write survives the person's undo of it, as before.
    #[test]
    fn a_transaction_keeps_no_notes_of_the_objects_it_creates() {
        let mut replica = replica();
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
        let step = replica.undo.person.undo.last().unwrap();
        let logged = replica.log.entries.back().unwrap();
        assert_eq!(step.parts.len(), 1);
        assert!(Arc::ptr_eq(&step.parts.first().unwrap().ops.ops, &logged.ops.ops), "the step shares the logged change");
        replica.transact(&person, |tx| tx.map_set(&sheet, "cells", "c1", json!("person"))).unwrap();
        assert_eq!(replica.undo.person.undo.len(), 2);
        replica.transact(&Origin::agent("agent:test"), |tx| tx.map_set(&sheet, "cells", "c1", json!("agent"))).unwrap();
        assert!(replica.undo().unwrap().is_done());
        assert_eq!(replica.map_get(&sheet, "cells", "c1").unwrap(), json!("agent"));
        assert!(replica.undo().unwrap().is_done());
        assert!(!replica.exists(&sheet));
    }

    /// Loading a table replays its stored changes as imports: an import is no undo step and
    /// keeps no notes. After a step of the replica's own, the person's undo keeps another
    /// replica's later write, as before.
    #[test]
    fn an_import_before_any_undo_step_keeps_no_notes() {
        let person = Origin::person("user:test");
        let mut theirs = replica();
        let sheet = theirs.transact(&Origin::system("fixture"), |tx| tx.create("Sheet", serde_json::Map::new())).unwrap();
        let mut mine = Replica::load(Arc::clone(&theirs.schema), &theirs.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
        theirs
            .transact(&person, |tx| {
                for cell in 0..100 {
                    tx.map_set(&sheet, "cells", &format!("c{cell}"), json!(cell))?;
                }
                Ok(())
            })
            .unwrap();
        mine.import_changes(&theirs.export_changes(&mine.version()).unwrap()).unwrap();
        assert!(!mine.can_undo() && !mine.can_redo());
        assert!(mine.undo.person.undo.is_empty() && mine.undo.agent.undo.is_empty());
        mine.transact(&person, |tx| tx.map_set(&sheet, "cells", "c1", json!("mine"))).unwrap();
        theirs.import_changes(&mine.export_changes(&theirs.version()).unwrap()).unwrap();
        theirs.transact(&person, |tx| tx.map_set(&sheet, "cells", "c1", json!("theirs"))).unwrap();
        mine.import_changes(&theirs.export_changes(&mine.version()).unwrap()).unwrap();
        assert!(mine.undo().unwrap().is_done());
        assert_eq!(mine.map_get(&sheet, "cells", "c1").unwrap(), json!("theirs"));
    }

    /// The log keeps at most its number of changes: older versions answer a snapshot and
    /// `HistoryMissing`.
    #[test]
    fn the_log_drops_its_oldest_changes_beyond_its_limit() {
        let mut replica = replica();
        let start = replica.version();
        let person = Origin::system("bulk");
        let sheet = replica.transact(&person, |tx| tx.create("Sheet", serde_json::Map::new())).unwrap();
        let first = replica.version();
        for n in 0..LOG_CHANGES + 5 {
            replica.transact(&person, |tx| tx.map_set(&sheet, "cells", "n", json!(n))).unwrap();
        }
        assert_eq!(replica.log.entries.len(), LOG_CHANGES);
        assert!(matches!(replica.fork_at(&first, ActorId::random()), Err(KdmError::HistoryMissing(_))));
        assert!(matches!(replica.changes_since(&start), Err(KdmError::HistoryMissing(_))));
        let bytes = replica.export_changes(&first).unwrap();
        assert!(serde_json::from_slice::<Value>(&bytes).unwrap().get("objects").is_some(), "an old version gets a snapshot");
        let recent = Version::at(replica.lineage, replica.seq - 3);
        let bytes = replica.export_changes(&recent).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap().get("changes").and_then(Value::as_array).map(Vec::len), Some(3));
        assert!(replica.fork_at(&recent, ActorId::random()).is_ok());
    }
}
