// Copied from kition-sdk crates/kition-kdm/src/comment.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Comments (Kition Kit Standard 2.0, rule M23).
//!
//! People discuss a document in **comment threads** anchored to its objects. A thread is an object
//! of the reserved type `CommentThread`: where it is anchored (`anchor`, a JSON value naming an
//! object and optionally a field and a range in it), whether it is resolved, and its comments in
//! order. Each comment is an object of the reserved type `Comment`: who wrote it (`author`, a
//! principal id; a file's own author name for comments imported from a file), their display name
//! when it was written, the text, and when (`created`, ISO 8601 UTC).
//!
//! Comments live beside the content, never inside it: a thread points at its object, and nothing
//! in the content points back. So a principal that may only comment (the `commenter` role of the
//! sync protocol, 1.6) changes only `CommentThread` and `Comment` objects, which a server checks
//! by the objects a change touches, without knowing the kit.
//!
//! A kit that keeps comments declares both types in its schema as [`COMMENT_THREAD_TYPE_JSON`] and
//! [`COMMENT_TYPE_JSON`] (it MAY add optional register fields of its own, such as an author's
//! initials a file format keeps).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{KdmError, ObjectId, Replica, Result, Tx};

/// The reserved type name of comment threads.
pub const COMMENT_THREAD_TYPE: &str = "CommentThread";
/// The reserved type name of comments.
pub const COMMENT_TYPE: &str = "Comment";

/// The `CommentThread` type's definition, as a kit adds it to its `model/schema.json` `types`.
pub const COMMENT_THREAD_TYPE_JSON: &str =
    r#"{ "fields": { "anchor": { "kind": "json" }, "resolved": { "kind": "boolean", "optional": true }, "comments": { "kind": "list", "of": "Comment" } } }"#;

/// The `Comment` type's definition, as a kit adds it to its `model/schema.json` `types`.
pub const COMMENT_TYPE_JSON: &str = r#"{ "fields": { "author": { "kind": "string" }, "name": { "kind": "string", "optional": true }, "body": { "kind": "text" }, "created": { "kind": "string" } } }"#;

/// Whether `ty` is one of the comment types: the only types a commenter's change may touch.
pub fn is_comment_type(ty: &str) -> bool {
    ty == COMMENT_THREAD_TYPE || ty == COMMENT_TYPE
}

/// Where a thread is anchored: an object of the document, and optionally a field of it and a range
/// in that field (character offsets in a `text` field when the thread was made; `quote` is the
/// text the range held then, so an editor can find it again after edits around it). A kit MAY add
/// keys of its own (a point on a slide, a cell), kept in `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommentAnchor {
    pub object: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<AnchorRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl CommentAnchor {
    /// An anchor on a whole object.
    pub fn object(id: &ObjectId) -> Self {
        Self { object: id.as_str().to_owned(), field: None, range: None, quote: None, extra: Map::new() }
    }
}

/// A range of characters in a `text` field: `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnchorRange {
    pub start: u64,
    pub end: u64,
}

/// A comment to write: who, their display name, the text, and when (ISO 8601 UTC).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewComment {
    pub author: String,
    pub name: Option<String>,
    pub body: String,
    pub created: String,
}

/// One comment as read back.
#[derive(Debug, Clone, PartialEq)]
pub struct Comment {
    pub id: ObjectId,
    pub author: String,
    pub name: Option<String>,
    pub body: String,
    pub created: String,
}

/// One thread as read back: its comments in order (the first one opened it).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentThread {
    pub id: ObjectId,
    /// The anchor as stored (a [`CommentAnchor`] when the kit wrote one; read it with
    /// [`CommentThread::anchor`]).
    pub anchor: Value,
    pub resolved: bool,
    pub comments: Vec<Comment>,
}

impl CommentThread {
    /// The anchor, when it is a well-formed [`CommentAnchor`].
    pub fn anchor(&self) -> Option<CommentAnchor> {
        serde_json::from_value(self.anchor.clone()).ok()
    }
}

fn comment_object(tx: &mut Tx<'_>, comment: &NewComment) -> Result<ObjectId> {
    let mut fields = Map::new();
    fields.insert("author".into(), Value::String(comment.author.clone()));
    if let Some(name) = &comment.name {
        fields.insert("name".into(), Value::String(name.clone()));
    }
    fields.insert("created".into(), Value::String(comment.created.clone()));
    let id = tx.create(COMMENT_TYPE, fields)?;
    if !comment.body.is_empty() {
        tx.text_insert(&id, "body", 0, &comment.body)?;
    }
    Ok(id)
}

fn thread_of(tx: &Tx<'_>, thread: &ObjectId) -> Result<()> {
    let ty = tx.object_type(thread)?;
    if ty != COMMENT_THREAD_TYPE {
        return Err(KdmError::InvalidValue { ty, field: "$id".into(), reason: format!("{thread} is not a {COMMENT_THREAD_TYPE}") });
    }
    Ok(())
}

/// Opens a thread at `anchor` with its first comment; answers the thread's and the comment's ids.
/// Fails as [`Tx::create`] does for a schema without the comment types.
pub fn add_thread(tx: &mut Tx<'_>, anchor: &CommentAnchor, comment: &NewComment) -> Result<(ObjectId, ObjectId)> {
    let anchor = serde_json::to_value(anchor).map_err(|error| KdmError::InvalidValue {
        ty: COMMENT_THREAD_TYPE.into(),
        field: "anchor".into(),
        reason: error.to_string(),
    })?;
    let mut fields = Map::new();
    fields.insert("anchor".into(), anchor);
    fields.insert("resolved".into(), Value::Bool(false));
    let thread = tx.create(COMMENT_THREAD_TYPE, fields)?;
    let first = comment_object(tx, comment)?;
    tx.list_insert(&thread, "comments", 0, &first)?;
    Ok((thread, first))
}

/// Adds `comment` at the end of `thread`; answers its id.
pub fn reply(tx: &mut Tx<'_>, thread: &ObjectId, comment: &NewComment) -> Result<ObjectId> {
    thread_of(tx, thread)?;
    let id = comment_object(tx, comment)?;
    let len = tx.list_items(thread, "comments")?.len();
    tx.list_insert(thread, "comments", len, &id)?;
    Ok(id)
}

/// Resolves `thread` (or opens it again).
pub fn set_resolved(tx: &mut Tx<'_>, thread: &ObjectId, resolved: bool) -> Result<()> {
    thread_of(tx, thread)?;
    tx.set(thread, "resolved", Value::Bool(resolved))
}

/// Deletes one comment of `thread`; deleting its last comment deletes the thread.
pub fn delete_comment(tx: &mut Tx<'_>, thread: &ObjectId, comment: &ObjectId) -> Result<()> {
    thread_of(tx, thread)?;
    let items = tx.list_items(thread, "comments")?;
    let index = items.iter().position(|item| item == comment).ok_or_else(|| KdmError::NotFound(comment.to_string()))?;
    tx.list_remove(thread, "comments", index)?;
    tx.delete(comment)?;
    if items.len() == 1 {
        tx.delete(thread)?;
    }
    Ok(())
}

/// Deletes `thread` and its comments.
pub fn delete_thread(tx: &mut Tx<'_>, thread: &ObjectId) -> Result<()> {
    thread_of(tx, thread)?;
    for comment in tx.list_items(thread, "comments")? {
        if tx.exists(&comment) {
            tx.delete(&comment)?;
        }
    }
    tx.delete(thread)
}

fn read_comment(replica: &Replica, id: &ObjectId) -> Result<Comment> {
    let text = |field: &str| replica.get(id, field).map(|value| value.as_str().map(str::to_owned));
    Ok(Comment {
        id: id.clone(),
        author: text("author")?.unwrap_or_default(),
        name: text("name").ok().flatten(),
        body: replica.text(id, "body")?,
        created: text("created")?.unwrap_or_default(),
    })
}

/// The document's comment threads, oldest first (by their first comment's `created`, then id),
/// with their live comments in order. Empty for a schema without the comment types.
pub fn threads(replica: &Replica) -> Result<Vec<CommentThread>> {
    let types = &replica.schema().types;
    if !types.contains_key(COMMENT_THREAD_TYPE) || !types.contains_key(COMMENT_TYPE) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for id in replica.objects_of_type(COMMENT_THREAD_TYPE) {
        let mut comments = Vec::new();
        for comment in replica.list(&id, "comments")? {
            // A comment a concurrent delete removed while another replica replied stays listed
            // but gone: skip it.
            if replica.exists(&comment) && replica.object_type(&comment)? == COMMENT_TYPE {
                comments.push(read_comment(replica, &comment)?);
            }
        }
        let resolved = replica.get(&id, "resolved").ok().and_then(|value| value.as_bool()).unwrap_or(false);
        out.push(CommentThread { id: id.clone(), anchor: replica.get(&id, "anchor")?, resolved, comments });
    }
    let opened = |thread: &CommentThread| thread.comments.first().map(|comment| comment.created.clone()).unwrap_or_default();
    out.sort_by(|a, b| opened(a).cmp(&opened(b)).then_with(|| a.id.as_str().cmp(b.id.as_str())));
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{ActorId, DocId, Origin, Schema};

    fn schema() -> Arc<Schema> {
        let text = format!(
            r#"{{ "kdm": 1, "kit": "kit.test", "schemaVersion": 1, "root": "Doc", "types": {{ "Doc": {{ "fields": {{ "title": {{ "kind": "string" }}, "body": {{ "kind": "text" }} }} }}, "CommentThread": {COMMENT_THREAD_TYPE_JSON}, "Comment": {COMMENT_TYPE_JSON} }} }}"#
        );
        Arc::new(Schema::parse(&text).unwrap())
    }

    fn said(author: &str, body: &str, created: &str) -> NewComment {
        NewComment { author: author.into(), name: Some(author.to_uppercase()), body: body.into(), created: created.into() }
    }

    fn sync(a: &mut Replica, b: &mut Replica) {
        let (before_a, before_b) = (a.version(), b.version());
        a.import_changes(&b.export_changes(&before_a).unwrap()).unwrap();
        b.import_changes(&a.export_changes(&before_b).unwrap()).unwrap();
    }

    #[test]
    fn threads_open_reply_resolve_and_read_back() {
        let mut doc = Replica::create(schema(), DocId::new(), ActorId::random()).unwrap();
        let object = ObjectId::from_string("root");
        let anchor = CommentAnchor {
            range: Some(AnchorRange { start: 2, end: 5 }),
            quote: Some("llo".into()),
            field: Some("body".into()),
            ..CommentAnchor::object(&object)
        };
        let (thread, first) =
            doc.transact(&Origin::person("alice"), |tx| add_thread(tx, &anchor, &said("alice", "Is this right?", "2026-10-19T10:00:00Z"))).unwrap();
        let second = doc.transact(&Origin::person("bob"), |tx| reply(tx, &thread, &said("bob", "Yes.", "2026-10-19T10:01:00Z"))).unwrap();
        doc.transact(&Origin::person("alice"), |tx| set_resolved(tx, &thread, true)).unwrap();

        let found = threads(&doc).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, thread);
        assert!(found[0].resolved);
        assert_eq!(found[0].anchor(), Some(anchor));
        assert_eq!(
            found[0].comments.iter().map(|comment| (&comment.id, comment.body.as_str(), comment.author.as_str())).collect::<Vec<_>>(),
            vec![(&first, "Is this right?", "alice"), (&second, "Yes.", "bob")]
        );
        assert_eq!(found[0].comments[1].name.as_deref(), Some("BOB"));

        // Deleting the last comment deletes the thread.
        doc.transact(&Origin::person("bob"), |tx| delete_comment(tx, &thread, &second)).unwrap();
        assert_eq!(threads(&doc).unwrap()[0].comments.len(), 1);
        doc.transact(&Origin::person("alice"), |tx| delete_comment(tx, &thread, &first)).unwrap();
        assert!(threads(&doc).unwrap().is_empty());
        assert!(!doc.exists(&thread));
    }

    #[test]
    fn concurrent_replies_both_survive_and_replicas_converge() {
        let mut a = Replica::create(schema(), DocId::new(), ActorId::random()).unwrap();
        let object = ObjectId::from_string("root");
        let (thread, _) =
            a.transact(&Origin::person("alice"), |tx| add_thread(tx, &CommentAnchor::object(&object), &said("alice", "One", "2026-10-19T10:00:00Z"))).unwrap();
        let mut b = Replica::load(schema(), &a.snapshot().unwrap(), ActorId::random()).unwrap();
        a.transact(&Origin::person("alice"), |tx| reply(tx, &thread, &said("alice", "Two", "2026-10-19T10:02:00Z"))).unwrap();
        b.transact(&Origin::person("bob"), |tx| reply(tx, &thread, &said("bob", "Three", "2026-10-19T10:02:00Z"))).unwrap();
        sync(&mut a, &mut b);
        assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
        let mut bodies: Vec<String> = threads(&a).unwrap()[0].comments.iter().map(|comment| comment.body.clone()).collect();
        bodies.sort();
        assert_eq!(bodies, vec!["One", "Three", "Two"]);
        assert_eq!(threads(&a).unwrap(), threads(&b).unwrap());
    }

    #[test]
    fn threads_sort_by_when_they_opened_and_other_types_are_refused() {
        let mut doc = Replica::create(schema(), DocId::new(), ActorId::random()).unwrap();
        let object = ObjectId::from_string("root");
        let (late, _) =
            doc.transact(&Origin::person("a"), |tx| add_thread(tx, &CommentAnchor::object(&object), &said("a", "late", "2026-10-19T11:00:00Z"))).unwrap();
        let (early, _) =
            doc.transact(&Origin::person("a"), |tx| add_thread(tx, &CommentAnchor::object(&object), &said("a", "early", "2026-10-19T09:00:00Z"))).unwrap();
        assert_eq!(threads(&doc).unwrap().iter().map(|thread| thread.id.clone()).collect::<Vec<_>>(), vec![early, late.clone()]);
        // A comment is not a thread.
        let comment = doc.list(&late, "comments").unwrap().remove(0);
        assert!(doc.transact(&Origin::person("a"), |tx| set_resolved(tx, &comment, true)).is_err());
        assert!(is_comment_type("Comment") && is_comment_type("CommentThread") && !is_comment_type("Doc"));
    }

    #[test]
    fn a_schema_without_comments_has_none_and_refuses_to_add_one() {
        let schema =
            Arc::new(Schema::parse(r#"{ "kdm": 1, "kit": "kit.test", "schemaVersion": 1, "root": "Doc", "types": { "Doc": { "fields": {} } } }"#).unwrap());
        let mut replica = Replica::create(schema, DocId::new(), ActorId::random()).unwrap();
        assert!(threads(&replica).unwrap().is_empty());
        let object = ObjectId::from_string("root");
        assert!(replica.transact(&Origin::person("a"), |tx| add_thread(tx, &CommentAnchor::object(&object), &said("a", "x", "t"))).is_err());
    }
}
