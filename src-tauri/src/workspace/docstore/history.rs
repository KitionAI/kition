//! A document's version history on this device: `history.json` in its folder,
//! the checkpoints recorded when it was saved, when an agent or a script
//! finished a batch of edits, every few minutes of editing, around a restore,
//! and when a kit or the person named a version (Kit UI protocol section 7m).
//! A checkpoint names the replica version it was taken at (the replica keeps
//! its whole history, so any recorded version can be read again), with its
//! time, author, and origin, and the blobs the replica then named, so a kit
//! can show and restore it.
//!
//! Labelled checkpoints (a name a person gave) and unlabelled ones are kept
//! apart: past `MAX_CHECKPOINTS` unlabelled ones the oldest are thinned,
//! autosaves first; labelled ones are never thinned for them and have their
//! own cap, `MAX_LABELLED_CHECKPOINTS`. When the replica is replaced by one of
//! another lineage, the unlabelled checkpoints go and the labelled ones stay,
//! marked unavailable (the new replica does not reach their versions).

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::blobs::BlobRecord;
use super::read_confined;
use crate::workspace::safety::{assert_safe, invalid, write_atomically};

pub(super) const HISTORY_FILE: &str = "history.json";
const HISTORY_FORMAT: u64 = 1;
/// The most unlabelled checkpoints a document keeps.
pub const MAX_CHECKPOINTS: usize = 200;
/// The most labelled checkpoints a document keeps (the protocol names no
/// number); past it the oldest labelled one goes.
pub const MAX_LABELLED_CHECKPOINTS: usize = 1000;
/// The longest label, author, and version (Kit UI protocol `CHECKPOINT_LABEL_LIMIT`).
const MAX_TEXT: usize = 200;
/// The longest description (Kit UI protocol `CHECKPOINT_DESCRIPTION_LIMIT`).
const MAX_DESCRIPTION: usize = 2000;
/// The origin of checkpoints made while editing, thinned first.
const EDIT_ORIGIN: &str = "edit";
/// The origin of a kit's own checkpoints: the only ones a kit changes.
pub const KIT_ORIGIN: &str = "kit";

/// The errors of the Kit UI protocol's checkpoint requests (`error.data.reason`
/// `not-found`, `history-missing`, `too-long`, `read-only`).
pub const CHECKPOINT_NOT_FOUND: &str = "DOCUMENT_CHECKPOINT_NOT_FOUND";
pub const CHECKPOINT_HISTORY_MISSING: &str = "DOCUMENT_CHECKPOINT_HISTORY_MISSING";
pub const CHECKPOINT_TOO_LONG: &str = "DOCUMENT_CHECKPOINT_TOO_LONG";
pub const CHECKPOINT_READ_ONLY: &str = "DOCUMENT_CHECKPOINT_READ_ONLY";

fn yes() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub time: u64,
    /// `kit`, `save`, `agent`, `script`, `edit`, `restore`, `open`, …
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The replica version (the writer's, in hex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The stored `seq` when the checkpoint was taken, for a stored replica.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blobs: Option<BlobRecord>,
    /// False once the stored replica no longer reaches `version` (it was
    /// replaced by one of another lineage). Written only when false.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub available: bool,
}

impl Checkpoint {
    pub fn is_labelled(&self) -> bool {
        self.label.is_some()
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct History {
    format: u64,
    /// Oldest first.
    #[serde(default)]
    checkpoints: Vec<Checkpoint>,
}

/// What a writer asks to record.
#[derive(Clone, Debug, Default)]
pub struct CheckpointInput {
    pub origin: String,
    pub author: Option<String>,
    pub label: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub time: Option<u64>,
}

/// A page of `list_page`: newest first, at most `limit`, only labelled ones
/// with `labelled`, only those older than the checkpoint `before`.
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub labelled: bool,
    pub before: Option<String>,
    pub limit: usize,
}

/// A change to a kit's checkpoint: `None` keeps a field, an empty string
/// removes it.
#[derive(Clone, Debug, Default)]
pub struct Edit {
    pub label: Option<String>,
    pub description: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// A text field within `limit` characters; empty is none.
fn check_text(value: Option<String>, limit: usize) -> io::Result<Option<String>> {
    match value {
        Some(text) if text.chars().count() > limit => Err(io::Error::other(CHECKPOINT_TOO_LONG)),
        Some(text) if text.is_empty() => Ok(None),
        other => Ok(other),
    }
}

fn check_origin(origin: &str) -> io::Result<()> {
    let valid = !origin.is_empty()
        && origin.len() <= 32
        && origin
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(invalid("invalid checkpoint origin"))
    }
}

/// Checks what a writer asks to record, before anything is written.
pub fn check_input(input: &CheckpointInput) -> io::Result<()> {
    check_origin(&input.origin)?;
    for (value, limit) in [
        (&input.author, MAX_TEXT),
        (&input.label, MAX_TEXT),
        (&input.description, MAX_DESCRIPTION),
        (&input.version, MAX_TEXT),
    ] {
        check_text(value.clone(), limit)?;
    }
    Ok(())
}

fn load(root: &Path, dir: &Path) -> io::Result<History> {
    let Some(bytes) = read_confined(root, &dir.join(HISTORY_FILE))? else {
        return Ok(History::default());
    };
    // A damaged history file reads as no history; the next checkpoint replaces it.
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn save(root: &Path, dir: &Path, history: &mut History) -> io::Result<()> {
    history.format = HISTORY_FORMAT;
    let path = dir.join(HISTORY_FILE);
    assert_safe(root, &path, true)?;
    let mut bytes = serde_json::to_vec_pretty(history).map_err(io::Error::other)?;
    bytes.push(b'\n');
    write_atomically(&path, &bytes)
}

/// The checkpoints, newest first.
pub fn list(root: &Path, dir: &Path) -> io::Result<Vec<Checkpoint>> {
    let mut checkpoints = load(root, dir)?.checkpoints;
    checkpoints.reverse();
    Ok(checkpoints)
}

/// One page of the checkpoints, newest first, and whether older ones remain.
/// An unknown `before` is `CHECKPOINT_NOT_FOUND`.
pub fn list_page(root: &Path, dir: &Path, page: &Page) -> io::Result<(Vec<Checkpoint>, bool)> {
    let newest_first = list(root, dir)?;
    let start = match &page.before {
        None => 0,
        Some(before) => match newest_first.iter().position(|c| &c.id == before) {
            Some(index) => index + 1,
            None => return Err(io::Error::other(CHECKPOINT_NOT_FOUND)),
        },
    };
    let mut matching = newest_first
        .into_iter()
        .skip(start)
        .filter(|checkpoint| !page.labelled || checkpoint.is_labelled());
    let checkpoints: Vec<Checkpoint> = matching.by_ref().take(page.limit).collect();
    let more = matching.next().is_some();
    Ok((checkpoints, more))
}

/// The checkpoint `id`.
pub fn find(root: &Path, dir: &Path, id: &str) -> io::Result<Option<Checkpoint>> {
    Ok(load(root, dir)?
        .checkpoints
        .into_iter()
        .find(|checkpoint| checkpoint.id == id))
}

/// Drops the oldest checkpoints past the caps, never the newest one: past
/// `MAX_CHECKPOINTS` unlabelled ones, autosaves first; past
/// `MAX_LABELLED_CHECKPOINTS` labelled ones, the oldest labelled.
fn thin(checkpoints: &mut Vec<Checkpoint>) {
    for labelled in [false, true] {
        let cap = if labelled {
            MAX_LABELLED_CHECKPOINTS
        } else {
            MAX_CHECKPOINTS
        };
        loop {
            let last = checkpoints.len().saturating_sub(1);
            let kind = |checkpoint: &&Checkpoint| checkpoint.is_labelled() == labelled;
            if checkpoints.iter().filter(kind).count() <= cap {
                break;
            }
            let older = &checkpoints[..last];
            let index = older
                .iter()
                .position(|c| c.is_labelled() == labelled && !labelled && c.origin == EDIT_ORIGIN)
                .or_else(|| older.iter().position(|c| c.is_labelled() == labelled));
            match index {
                Some(index) => {
                    checkpoints.remove(index);
                }
                None => break,
            }
        }
    }
}

/// Records a checkpoint at `head` (the stored version and its blobs, for a
/// stored replica) and answers it. A checkpoint at the version of the newest
/// one is that one; with a label it takes the label, the description, and the
/// origin asked (a kit's request makes it the kit's, Kit UI protocol UI-C1).
pub fn record(
    root: &Path,
    dir: &Path,
    input: CheckpointInput,
    seq: Option<u64>,
    blobs: Option<BlobRecord>,
) -> io::Result<Checkpoint> {
    check_origin(&input.origin)?;
    let author = check_text(input.author, MAX_TEXT)?;
    let label = check_text(input.label, MAX_TEXT)?;
    let description = check_text(input.description, MAX_DESCRIPTION)?;
    let version = check_text(input.version, MAX_TEXT)?;
    let mut history = load(root, dir)?;
    if let Some(last) = history.checkpoints.last_mut()
        && version.is_some()
        && last.available
        && last.version == version
    {
        if label.is_none() {
            return Ok(last.clone());
        }
        last.label = label;
        last.description = description;
        last.origin = input.origin;
        if author.is_some() {
            last.author = author;
        }
        let upgraded = last.clone();
        thin(&mut history.checkpoints);
        save(root, dir, &mut history)?;
        return Ok(upgraded);
    }
    let checkpoint = Checkpoint {
        id: uuid::Uuid::new_v4().to_string(),
        time: input.time.unwrap_or_else(now_ms),
        origin: input.origin,
        author,
        label,
        description,
        version,
        seq,
        blobs,
        available: true,
    };
    history.checkpoints.push(checkpoint.clone());
    thin(&mut history.checkpoints);
    save(root, dir, &mut history)?;
    Ok(checkpoint)
}

/// The kit's checkpoint `id`, for a change: unknown is `CHECKPOINT_NOT_FOUND`,
/// another origin's `CHECKPOINT_READ_ONLY`.
fn kit_checkpoint(history: &History, id: &str) -> io::Result<usize> {
    let Some(index) = history.checkpoints.iter().position(|c| c.id == id) else {
        return Err(io::Error::other(CHECKPOINT_NOT_FOUND));
    };
    if history.checkpoints[index].origin != KIT_ORIGIN {
        return Err(io::Error::other(CHECKPOINT_READ_ONLY));
    }
    Ok(index)
}

/// Renames or redescribes the kit's checkpoint `id` and answers it.
pub fn update(root: &Path, dir: &Path, id: &str, edit: Edit) -> io::Result<Checkpoint> {
    let mut history = load(root, dir)?;
    let index = kit_checkpoint(&history, id)?;
    let checkpoint = &mut history.checkpoints[index];
    if let Some(label) = edit.label {
        checkpoint.label = check_text(Some(label), MAX_TEXT)?;
    }
    if let Some(description) = edit.description {
        checkpoint.description = check_text(Some(description), MAX_DESCRIPTION)?;
    }
    let updated = checkpoint.clone();
    // A label removed makes it an unlabelled one, which counts toward their cap.
    thin(&mut history.checkpoints);
    save(root, dir, &mut history)?;
    Ok(updated)
}

/// Deletes the kit's checkpoint `id`.
pub fn delete(root: &Path, dir: &Path, id: &str) -> io::Result<()> {
    let mut history = load(root, dir)?;
    let index = kit_checkpoint(&history, id)?;
    history.checkpoints.remove(index);
    save(root, dir, &mut history)
}

/// The replica was replaced by one of another lineage, whose history does not
/// hold the recorded versions: the unlabelled checkpoints go, the labelled ones
/// stay as unavailable (without the blobs, which nothing can read any more).
pub fn new_lineage(root: &Path, dir: &Path) -> io::Result<()> {
    let mut history = load(root, dir)?;
    if history.checkpoints.is_empty() {
        return Ok(());
    }
    history.checkpoints.retain(Checkpoint::is_labelled);
    for checkpoint in &mut history.checkpoints {
        checkpoint.available = false;
        checkpoint.seq = None;
        checkpoint.blobs = None;
    }
    save(root, dir, &mut history)
}

/// The blobs the checkpoints name, so they survive a collection.
pub fn blob_records(root: &Path, dir: &Path) -> io::Result<Vec<BlobRecord>> {
    Ok(load(root, dir)?
        .checkpoints
        .into_iter()
        .filter_map(|checkpoint| checkpoint.blobs)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok<T>(result: io::Result<T>) -> T {
        result.unwrap_or_else(|err| panic!("{err}"))
    }

    fn error_text<T: std::fmt::Debug>(result: io::Result<T>) -> String {
        result.err().map(|err| err.to_string()).unwrap_or_default()
    }

    fn input(origin: &str, version: &str) -> CheckpointInput {
        CheckpointInput {
            origin: origin.into(),
            version: Some(version.into()),
            author: Some("user:local".into()),
            ..CheckpointInput::default()
        }
    }

    fn labelled(label: &str, version: &str) -> CheckpointInput {
        CheckpointInput {
            label: Some(label.into()),
            ..input(KIT_ORIGIN, version)
        }
    }

    fn store() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = temp.path().to_path_buf();
        let dir = root.join("doc");
        (temp, root, dir)
    }

    #[test]
    fn records_lists_and_thins_checkpoints() {
        let (_temp, root, dir) = store();
        assert!(ok(list(&root, &dir)).is_empty());
        let first = ok(record(&root, &dir, input("save", "01"), Some(1), None));
        // The same version again is the same checkpoint.
        assert_eq!(
            ok(record(&root, &dir, input("agent", "01"), Some(1), None)),
            first
        );
        let second = ok(record(&root, &dir, input("agent", "02"), Some(2), None));
        assert_eq!(ok(list(&root, &dir)), vec![second.clone(), first.clone()]);
        assert_eq!(ok(find(&root, &dir, &first.id)), Some(first.clone()));
        assert!(record(&root, &dir, input("Not An Origin", "03"), None, None).is_err());
        assert_eq!(
            error_text(record(
                &root,
                &dir,
                labelled(&"x".repeat(201), "03"),
                None,
                None
            )),
            CHECKPOINT_TOO_LONG
        );

        for n in 0..MAX_CHECKPOINTS {
            ok(record(
                &root,
                &dir,
                input("edit", &format!("e{n}")),
                None,
                None,
            ));
        }
        let listed = ok(list(&root, &dir));
        assert_eq!(listed.len(), MAX_CHECKPOINTS);
        // Autosaves went first: the save and the agent checkpoint are kept.
        assert!(listed.iter().any(|checkpoint| checkpoint.id == first.id));
        assert!(listed.iter().any(|checkpoint| checkpoint.id == second.id));

        ok(std::fs::write(dir.join(HISTORY_FILE), b"garbage"));
        assert!(ok(list(&root, &dir)).is_empty());
    }

    #[test]
    fn keeps_descriptions_within_their_limit() {
        let (_temp, root, dir) = store();
        let described = CheckpointInput {
            description: Some("d".repeat(MAX_DESCRIPTION)),
            ..labelled("Draft", "01")
        };
        assert!(check_input(&described).is_ok());
        let kept = ok(record(&root, &dir, described, None, None));
        assert_eq!(
            kept.description.as_deref().map(str::len),
            Some(MAX_DESCRIPTION)
        );
        let longer = CheckpointInput {
            description: Some("d".repeat(MAX_DESCRIPTION + 1)),
            ..labelled("Draft", "02")
        };
        assert_eq!(error_text(check_input(&longer)), CHECKPOINT_TOO_LONG);
        assert_eq!(
            error_text(record(&root, &dir, longer, None, None)),
            CHECKPOINT_TOO_LONG
        );
        // A label keeps the protocol's 200 characters.
        assert!(check_input(&labelled(&"l".repeat(MAX_TEXT), "03")).is_ok());
        assert_eq!(
            error_text(check_input(&labelled(&"l".repeat(MAX_TEXT + 1), "03"))),
            CHECKPOINT_TOO_LONG
        );
        assert_eq!(ok(list(&root, &dir)).len(), 1);
    }

    #[test]
    fn never_thins_labelled_checkpoints_for_unlabelled_ones() {
        let (_temp, root, dir) = store();
        let named = ok(record(
            &root,
            &dir,
            labelled("First draft", "00"),
            None,
            None,
        ));
        for n in 0..MAX_CHECKPOINTS + 20 {
            ok(record(
                &root,
                &dir,
                input("save", &format!("s{n}")),
                None,
                None,
            ));
        }
        let listed = ok(list(&root, &dir));
        assert_eq!(listed.len(), MAX_CHECKPOINTS + 1);
        assert!(listed.iter().any(|checkpoint| checkpoint.id == named.id));
        assert_eq!(
            listed.iter().filter(|c| !c.is_labelled()).count(),
            MAX_CHECKPOINTS
        );
    }

    #[test]
    fn caps_labelled_checkpoints_on_their_own() {
        let checkpoint = |n: usize, label: Option<&str>| Checkpoint {
            id: format!("c{n}"),
            time: n as u64,
            origin: KIT_ORIGIN.into(),
            author: None,
            label: label.map(str::to_owned),
            description: None,
            version: Some(format!("{n:04x}")),
            seq: None,
            blobs: None,
            available: true,
        };
        let mut checkpoints = vec![checkpoint(0, None)];
        checkpoints.extend((1..=MAX_LABELLED_CHECKPOINTS + 1).map(|n| checkpoint(n, Some("v"))));
        thin(&mut checkpoints);
        assert_eq!(
            checkpoints.iter().filter(|c| c.is_labelled()).count(),
            MAX_LABELLED_CHECKPOINTS
        );
        // The oldest labelled one went; the unlabelled one was not taken for it.
        assert_eq!(
            checkpoints
                .iter()
                .take(2)
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            vec!["c0", "c2"]
        );
    }

    #[test]
    fn a_label_at_the_newest_version_upgrades_that_checkpoint() {
        let (_temp, root, dir) = store();
        let saved = ok(record(&root, &dir, input("save", "01"), Some(1), None));
        let named = ok(record(
            &root,
            &dir,
            CheckpointInput {
                description: Some("Before the review".into()),
                ..labelled("Draft", "01")
            },
            Some(1),
            None,
        ));
        assert_eq!(named.id, saved.id);
        assert_eq!(
            (
                named.origin.as_str(),
                named.label.as_deref(),
                named.description.as_deref()
            ),
            (KIT_ORIGIN, Some("Draft"), Some("Before the review"))
        );
        assert_eq!(ok(list(&root, &dir)), vec![named.clone()]);
        // Without a label, the same version answers the checkpoint unchanged.
        assert_eq!(
            ok(record(&root, &dir, input("save", "01"), None, None)),
            named
        );
    }

    #[test]
    fn a_new_lineage_keeps_labelled_checkpoints_as_unavailable() {
        let (_temp, root, dir) = store();
        let record_blobs = BlobRecord {
            hashes: None,
            bundle: Some("ab".into()),
        };
        ok(record(
            &root,
            &dir,
            input("save", "01"),
            Some(1),
            Some(record_blobs.clone()),
        ));
        let named = ok(record(
            &root,
            &dir,
            labelled("Draft", "02"),
            Some(2),
            Some(record_blobs),
        ));
        ok(new_lineage(&root, &dir));
        let listed = ok(list(&root, &dir));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, named.id);
        assert!(!listed[0].available);
        assert_eq!((listed[0].seq, listed[0].blobs.clone()), (None, None));
        assert!(ok(blob_records(&root, &dir)).is_empty());
        // The new replica's checkpoint at the same version is a new one.
        let fresh = ok(record(&root, &dir, labelled("Again", "02"), Some(1), None));
        assert_ne!(fresh.id, named.id);
        assert!(fresh.available);
        // `available` is written only when false.
        let text = ok(std::fs::read_to_string(dir.join(HISTORY_FILE)));
        assert_eq!(text.matches("\"available\"").count(), 1);
    }

    #[test]
    fn lists_pages_newest_first() {
        let (_temp, root, dir) = store();
        let a = ok(record(&root, &dir, labelled("A", "01"), None, None));
        let b = ok(record(&root, &dir, input("save", "02"), None, None));
        let c = ok(record(&root, &dir, labelled("C", "03"), None, None));
        let d = ok(record(&root, &dir, input("agent", "04"), None, None));
        let ids = |page: (Vec<Checkpoint>, bool)| {
            (page.0.into_iter().map(|c| c.id).collect::<Vec<_>>(), page.1)
        };
        let page = |labelled: bool, before: Option<&String>, limit: usize| Page {
            labelled,
            before: before.cloned(),
            limit,
        };
        assert_eq!(
            ids(ok(list_page(&root, &dir, &page(false, None, 200)))),
            (
                vec![d.id.clone(), c.id.clone(), b.id.clone(), a.id.clone()],
                false
            )
        );
        assert_eq!(
            ids(ok(list_page(&root, &dir, &page(true, None, 200)))),
            (vec![c.id.clone(), a.id.clone()], false)
        );
        assert_eq!(
            ids(ok(list_page(&root, &dir, &page(false, None, 2)))),
            (vec![d.id.clone(), c.id.clone()], true)
        );
        assert_eq!(
            ids(ok(list_page(&root, &dir, &page(true, Some(&c.id), 1)))),
            (vec![a.id.clone()], false)
        );
        assert_eq!(
            ids(ok(list_page(&root, &dir, &page(true, Some(&d.id), 1)))),
            (vec![c.id.clone()], true)
        );
        assert_eq!(
            error_text(list_page(
                &root,
                &dir,
                &page(false, Some(&"none".to_owned()), 1)
            )),
            CHECKPOINT_NOT_FOUND
        );
    }

    #[test]
    fn a_kit_updates_and_deletes_only_its_own_checkpoints() {
        let (_temp, root, dir) = store();
        let host = ok(record(
            &root,
            &dir,
            CheckpointInput {
                label: Some("Restored".into()),
                ..input("restore", "01")
            },
            None,
            None,
        ));
        let own = ok(record(
            &root,
            &dir,
            CheckpointInput {
                description: Some("first".into()),
                ..labelled("Draft", "02")
            },
            None,
            None,
        ));
        let rename = |label: Option<&str>, description: Option<&str>| Edit {
            label: label.map(str::to_owned),
            description: description.map(str::to_owned),
        };
        assert_eq!(
            error_text(update(&root, &dir, &host.id, rename(Some("x"), None))),
            CHECKPOINT_READ_ONLY
        );
        assert_eq!(
            error_text(delete(&root, &dir, &host.id)),
            CHECKPOINT_READ_ONLY
        );
        assert_eq!(
            error_text(update(&root, &dir, "none", rename(Some("x"), None))),
            CHECKPOINT_NOT_FOUND
        );
        assert_eq!(
            error_text(delete(&root, &dir, "none")),
            CHECKPOINT_NOT_FOUND
        );

        // An absent field is kept; an empty one removes it.
        let renamed = ok(update(&root, &dir, &own.id, rename(Some("Final"), None)));
        assert_eq!(
            (renamed.label.as_deref(), renamed.description.as_deref()),
            (Some("Final"), Some("first"))
        );
        let cleared = ok(update(&root, &dir, &own.id, rename(None, Some(""))));
        assert_eq!(
            (cleared.label.as_deref(), cleared.description.as_deref()),
            (Some("Final"), None)
        );
        assert_eq!(
            error_text(update(
                &root,
                &dir,
                &own.id,
                rename(None, Some(&"d".repeat(2001)))
            )),
            CHECKPOINT_TOO_LONG
        );
        assert_eq!(ok(find(&root, &dir, &own.id)), Some(cleared));

        ok(delete(&root, &dir, &own.id));
        assert_eq!(ok(find(&root, &dir, &own.id)), None);
        assert_eq!(ok(list(&root, &dir)), vec![host]);
    }
}
