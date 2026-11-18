// Copied from kition-sdk crates/kition-kits/src/tools/journal.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The revision chain: per document, the journal of what changed it through this server, in
//! order, and who: each accepted write by the agent that made it, each change found in the file
//! by `outside`. A result's `revision` names the journal's head (a few characters: the journal's
//! tag and the number of its last entry, `qx7`), and a call's `basis` is a revision it was given:
//! the entries after it are what happened since, and those by others are what the call was not
//! told about.
//!
//! The journal is the document's, shared by every agent connection to this server, and bounded:
//! it keeps the most recent entries within an entry count and an object budget, dropping the
//! oldest first and never the newest (one entry over the budget is kept alone); a basis older than
//! what it keeps is answered as unknown. The budget counts the objects the change sets name, not
//! the document's: a document of any size is journalled.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use serde_json::Value;

/// How many entries a journal keeps at most, unless the server says otherwise.
pub const DEFAULT_ENTRIES: usize = 256;
/// How many objects (across the entries' change sets) a journal keeps at most.
pub const DEFAULT_OBJECTS: usize = 20_000;

/// The author of a change found in the file, made outside this server.
pub const OUTSIDE: &str = "outside";

/// What a headless draft's journal adds to its file's name.
pub const DRAFT: &str = "#draft";
/// What the journal of a file open in its editor adds to the file's name (C3b): the editor's
/// replica is another document than the headless kit's, so its revisions are its own.
pub const EDITOR: &str = "#editor";
/// The author of a change in the open editor that the editor reported as the person's (C3b).
pub const PERSON: &str = "person";
/// The author of a change in the open editor that no agent call of this server made and the
/// editor did not report as the person's (another server's agent, a co-editor).
pub const OTHER: &str = "other";

/// One accepted change of the document.
#[derive(Clone, Debug)]
pub struct Entry {
    pub seq: u64,
    pub author: String,
    /// Its change set (by the ids the tools use), or `None` when what changed is not known: a
    /// kit without an object model, a document read again with unsaved edits, a write whose
    /// change set the kit could not give.
    pub changes: Option<Value>,
}

impl Entry {
    fn objects(&self) -> usize {
        self.changes.as_ref().map_or(1, |changes| {
            ["created", "changed", "moved", "deleted"]
                .iter()
                .map(|list| {
                    changes[*list].as_array().map_or(0, Vec::len)
                        + changes["$unnamed"][*list].as_array().map_or(0, Vec::len)
                        + changes["$objects"][*list].as_array().map_or(0, Vec::len)
                })
                .sum::<usize>()
                .saturating_add(changes["$premises"].as_array().map_or(0, Vec::len))
                .max(1)
        })
    }
}

struct Journal {
    /// Three letters that tell this journal's revisions from another's: drawn from the document
    /// and its file as the journal began (its path, size and modification time), so a server
    /// started again on an unchanged file answers the same revisions, and one started on a file
    /// changed meanwhile, or another document, answers others.
    tag: String,
    head: u64,
    /// The highest entry number no longer kept: a basis below it is not covered.
    dropped: u64,
    entries: VecDeque<Entry>,
    objects: usize,
    /// Who made each step of the agents' undo history, oldest first, and the steps they undid.
    undo: Vec<String>,
    undone: Vec<String>,
    /// The open editor's replica version the journal is up to (C3b): what changed after it was
    /// made by no call of this server yet.
    seen: Option<String>,
    state: Option<Value>,
    inputs: Option<Value>,
    references: HashMap<String, String>,
}

impl Journal {
    fn new(document: &str) -> Self {
        use sha2::Digest as _;
        let file = document.strip_suffix(DRAFT).or_else(|| document.strip_suffix(EDITOR)).unwrap_or(document);
        let seen = std::fs::metadata(file).ok().map(|meta| (meta.len(), meta.modified().ok().and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())));
        let digest = sha2::Sha256::digest(format!("{document}\n{seen:?}").as_bytes());
        let tag = digest.iter().take(3).map(|byte| char::from(b'a' + byte % 26)).collect();
        Self {
            tag,
            head: 0,
            dropped: 0,
            entries: VecDeque::new(),
            objects: 0,
            undo: Vec::new(),
            undone: Vec::new(),
            seen: None,
            state: None,
            inputs: None,
            references: HashMap::new(),
        }
    }

    fn revision(&self) -> String {
        format!("{}{}", self.tag, self.head)
    }
}

/// What the journal says about a `basis`.
#[derive(Debug)]
pub enum Since {
    /// Every entry after it, oldest first.
    Covered(Vec<Entry>),
    /// The journal cannot say what happened since: why.
    Unknown(String),
}

/// The journals of a server's documents, by document.
pub struct Journals {
    documents: Mutex<HashMap<String, Journal>>,
    limits: Mutex<(usize, usize)>,
}

impl Default for Journals {
    fn default() -> Self {
        Self { documents: Mutex::default(), limits: Mutex::new((DEFAULT_ENTRIES, DEFAULT_OBJECTS)) }
    }
}

impl Journals {
    pub fn references(&self, document: &str) -> HashMap<String, String> {
        self.with(document, |journal| journal.references.clone())
    }

    /// Rereads preserve observed raw handles through the same identity pairing as changes.
    /// The registry is bounded; evicted handles require a fresh model observation.
    pub fn remember_references(&self, document: &str, pairs: &Value) {
        let limit = self.limits.lock().unwrap_or_else(PoisonError::into_inner).1;
        self.with(document, |journal| {
            let Some(pairs) = pairs.as_object() else { return };
            for current in journal.references.values_mut() {
                if let Some(next) = pairs.get(current.as_str()).and_then(Value::as_str) {
                    *current = next.to_owned();
                }
            }
            journal.references.extend(pairs.iter().filter_map(|(old, new)| Some((old.clone(), new.as_str()?.to_owned()))));
            if journal.references.len() > limit {
                journal.references.clear();
            }
        });
    }
    pub fn inputs(&self, document: &str) -> Option<Value> {
        self.with(document, |journal| journal.inputs.clone())
    }

    pub fn observe_inputs(&self, document: &str, inputs: Value) {
        let before = self.with(document, |journal| journal.inputs.replace(inputs.clone()));
        if before.as_ref() == Some(&inputs) || before.is_none() && inputs.as_object().is_some_and(serde_json::Map::is_empty) {
            return;
        }
        self.append(
            document,
            OUTSIDE,
            Some(serde_json::json!({
                "created":[],"changed":[],"moved":[],"deleted":[],
                "externalInputs":{"before":before.unwrap_or_else(||serde_json::json!({})),"after":inputs}
            })),
        );
    }

    /// Last observed opaque editor state, absent when the kit cannot expose it.
    pub fn state(&self, document: &str) -> Option<Value> {
        self.with(document, |journal| journal.state.clone().filter(|state| !state.is_null()))
    }
    /// Records editor state independently of document edits and undo history.
    pub fn observe_state(&self, document: &str, state: Value) {
        let before = self.with(document, |journal| journal.state.replace(state.clone()));
        if let Some(before) = before.filter(|before| *before != state) {
            self.append(
                document,
                PERSON,
                Some(serde_json::json!({
                    "created": [], "changed": [], "moved": [], "deleted": [],
                    "editorState": { "before": before, "after": state }
                })),
            );
        }
    }

    /// Keeps at most `entries` entries and `objects` objects per document.
    pub fn set_limits(&self, entries: usize, objects: usize) {
        *self.limits.lock().unwrap_or_else(PoisonError::into_inner) = (entries.max(1), objects.max(1));
    }

    fn with<T>(&self, document: &str, act: impl FnOnce(&mut Journal) -> T) -> T {
        let mut documents = self.documents.lock().unwrap_or_else(PoisonError::into_inner);
        act(documents.entry(document.to_owned()).or_insert_with(|| Journal::new(document)))
    }

    /// The document's revision now.
    pub fn revision(&self, document: &str) -> String {
        self.with(document, |journal| journal.revision())
    }

    pub(crate) fn revision_at(&self, document: &str, seq: u64) -> Option<String> {
        self.with(document, |journal| (seq >= journal.dropped && seq <= journal.head).then(|| format!("{}{seq}", journal.tag)))
    }

    /// Adds a change by `author`; answers the new revision.
    pub fn append(&self, document: &str, author: &str, changes: Option<Value>) -> String {
        let (max_entries, max_objects) = *self.limits.lock().unwrap_or_else(PoisonError::into_inner);
        self.with(document, |journal| {
            journal.head += 1;
            let entry = Entry { seq: journal.head, author: author.to_owned(), changes };
            journal.objects += entry.objects();
            journal.entries.push_back(entry);
            // Old entries go first, and never the newest: the revision handed out before it stays
            // a basis the journal covers, however many objects its change set names.
            while journal.entries.len() > 1 && (journal.entries.len() > max_entries || journal.objects > max_objects) {
                if let Some(dropped) = journal.entries.pop_front() {
                    journal.objects -= dropped.objects();
                    journal.dropped = dropped.seq;
                }
            }
            journal.revision()
        })
    }

    /// The entries after `basis`, or why they are not known: a revision of another journal, one
    /// past the head, or one older than the entries kept.
    pub fn since(&self, document: &str, basis: &str) -> Since {
        self.with(document, |journal| {
            let Some(seq) = basis.strip_prefix(journal.tag.as_str()).and_then(|seq| seq.parse::<u64>().ok()).filter(|seq| *seq <= journal.head) else {
                return Since::Unknown(format!(
                    "`basis` {basis} is no revision of this document as this server knows it (it is now {}): it may come from another document or an earlier server",
                    journal.revision()
                ));
            };
            if seq < journal.dropped {
                return Since::Unknown(format!("`basis` {basis} is older than the changes this server still keeps for the document"));
            }
            Since::Covered(journal.entries.iter().filter(|entry| entry.seq > seq).cloned().collect())
        })
    }

    /// Whether the journal has had any entry.
    pub fn has_entries(&self, document: &str) -> bool {
        self.with(document, |journal| journal.head > 0)
    }

    /// The open editor's replica version the journal is up to, if it follows one (C3b).
    pub fn seen(&self, document: &str) -> Option<String> {
        self.with(document, |journal| journal.seen.clone())
    }

    /// The journal is up to the open editor's replica version `version` (C3b).
    pub fn set_seen(&self, document: &str, version: Option<String>) {
        self.with(document, |journal| journal.seen = version);
    }

    /// The document was read again from its file: its undo history is gone.
    pub fn forget_undo(&self, document: &str) {
        self.with(document, |journal| {
            journal.undo.clear();
            journal.undone.clear();
        });
    }

    /// Who made the agents' last `count` undo steps (`undo`), or the last `count` undone ones
    /// (`redo`), newest first; fewer when the history is shorter.
    pub fn undo_authors(&self, document: &str, redo: bool, count: usize) -> Vec<String> {
        self.with(document, |journal| {
            let stack = if redo { &journal.undone } else { &journal.undo };
            stack.iter().rev().take(count).cloned().collect()
        })
    }

    /// Records the agent `author`'s steps in the agents' undo history: `Some(true)` an undo,
    /// `Some(false)` a redo, `None` an edit.
    pub fn note_step(&self, document: &str, author: &str, undo: Option<bool>) {
        self.with(document, |journal| match undo {
            Some(true) => {
                if let Some(step) = journal.undo.pop() {
                    journal.undone.push(step);
                }
            }
            Some(false) => {
                if let Some(step) = journal.undone.pop() {
                    journal.undo.push(step);
                }
            }
            None => {
                journal.undo.push(author.to_owned());
                journal.undone.clear();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn changed(id: &str) -> Value {
        json!({ "created": [], "changed": [{ "id": id, "type": "T", "fields": ["a"] }], "moved": [], "deleted": [] })
    }

    #[test]
    fn a_revision_is_short_and_names_the_entries_after_it() {
        let journals = Journals::default();
        let start = journals.revision("d");
        assert!(start.len() <= 5, "{start}");
        let first = journals.append("d", "a", Some(changed("x")));
        journals.append("d", "b", Some(changed("y")));
        let Since::Covered(entries) = journals.since("d", &first) else { panic!("covered") };
        assert_eq!(entries.iter().map(|entry| entry.author.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(matches!(journals.since("d", "zz9"), Since::Unknown(_)), "another journal's revision");
    }

    #[test]
    fn a_journal_keeps_its_bounds_and_older_bases_are_unknown() {
        let journals = Journals::default();
        journals.set_limits(2, 100);
        let start = journals.revision("d");
        for id in ["x", "y", "z"] {
            journals.append("d", "a", Some(changed(id)));
        }
        assert!(matches!(journals.since("d", &start), Since::Unknown(_)));
        journals.set_limits(100, 3);
        let recent = journals.revision("d");
        journals.append(
            "d",
            "a",
            Some(json!({ "created": [{ "id": "1" }, { "id": "2" }, { "id": "3" }, { "id": "4" }], "changed": [], "moved": [], "deleted": [] })),
        );
        assert!(
            matches!(journals.since("d", &recent), Since::Covered(entries) if entries.len() == 1),
            "one entry over the object budget is kept alone: the revision before it stays covered"
        );
        let head = journals.revision("d");
        assert!(matches!(journals.since("d", &head), Since::Covered(entries) if entries.is_empty()));
        journals.append("d", "a", Some(changed("w")));
        assert!(matches!(journals.since("d", &recent), Since::Unknown(_)), "the next entry drops it: the basis before it is no longer covered");
        assert!(matches!(journals.since("d", &head), Since::Covered(entries) if entries.len() == 1));
    }
}
