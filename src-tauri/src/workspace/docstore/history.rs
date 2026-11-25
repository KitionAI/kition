//! A document's version history on this device: `history.json` in its folder,
//! the checkpoints recorded with the writes of its state (when it was saved,
//! when an agent saved it, when a kit or the person named a version: Kit UI
//! protocol section 7m). A checkpoint is a state: it keeps the snapshot of the
//! write that recorded it in `states/<sha256>` (the same bytes once), with its
//! time, author, origin, the version that snapshot holds, and the blobs it
//! named, so a kit can show and restore it whatever was written since.
//!
//! The store never reads a version: it compares the strings writers give it,
//! so "this save is at the newest checkpoint's version" is a comparison of
//! equal bytes (versions are opaque to the host, section 7).
//!
//! Labelled checkpoints (a name a person gave) and unlabelled ones are kept
//! apart. Past `MAX_CHECKPOINTS` unlabelled ones, or past
//! `MAX_UNLABELLED_BYTES` of their states, the oldest unlabelled ones go,
//! autosaves first; labelled ones are never dropped for them and have a cap of
//! their own, `MAX_LABELLED_CHECKPOINTS`. A document whose state is larger
//! than `LARGE_STATE_BYTES` records unlabelled checkpoints only at the
//! person's saves.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::blobs::BlobRecord;
use super::{read_confined, sha256_hex};
use crate::workspace::safety::{assert_safe, invalid, write_atomically};

pub(super) const HISTORY_FILE: &str = "history.json";
pub(super) const STATES_DIR: &str = "states";
const HISTORY_FORMAT: u64 = 2;
/// The most unlabelled checkpoints a document keeps.
pub const MAX_CHECKPOINTS: usize = 200;
/// The most labelled checkpoints a document keeps (the protocol names no
/// number); past it the oldest labelled one goes.
pub const MAX_LABELLED_CHECKPOINTS: usize = 1000;
/// The most bytes the states of a document's unlabelled checkpoints take
/// together (each state counted once).
pub const MAX_UNLABELLED_BYTES: u64 = 512 << 20;
/// A state larger than this records unlabelled checkpoints only at saves.
pub const LARGE_STATE_BYTES: u64 = 16 << 20;
/// The longest label, author, and version (Kit UI protocol `CHECKPOINT_LABEL_LIMIT`).
const MAX_TEXT: usize = 200;
/// The longest description (Kit UI protocol `CHECKPOINT_DESCRIPTION_LIMIT`).
const MAX_DESCRIPTION: usize = 2000;
/// The origin of checkpoints made while editing, thinned first.
const EDIT_ORIGIN: &str = "edit";
/// The origin of the person's saves.
const SAVE_ORIGIN: &str = "save";
/// The origin of a kit's own checkpoints: the only ones a kit changes.
pub const KIT_ORIGIN: &str = "kit";

/// The errors of the Kit UI protocol's checkpoint requests (`error.data.reason`
/// `not-found`, `too-long`, `read-only`).
pub const CHECKPOINT_NOT_FOUND: &str = "DOCUMENT_CHECKPOINT_NOT_FOUND";
pub const CHECKPOINT_TOO_LONG: &str = "DOCUMENT_CHECKPOINT_TOO_LONG";
pub const CHECKPOINT_READ_ONLY: &str = "DOCUMENT_CHECKPOINT_READ_ONLY";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub time: u64,
    /// `kit`, `save`, `agent`, …
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The version the state holds, as its writer named it.
    pub version: String,
    /// The SHA-256 of the state, `states/<state>`.
    pub state: String,
    /// The state's size in bytes.
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blobs: Option<BlobRecord>,
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
    pub time: Option<u64>,
}

/// The state a checkpoint keeps: the written snapshot, the version it holds,
/// and the blobs it names.
pub struct State<'a> {
    pub snapshot: &'a [u8],
    pub version: &'a str,
    pub blobs: Option<BlobRecord>,
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

/// The limits a history keeps to (`LIMITS`; tests use smaller ones).
#[derive(Clone, Copy, Debug)]
struct Limits {
    unlabelled: usize,
    labelled: usize,
    unlabelled_bytes: u64,
    large_state: u64,
}

const LIMITS: Limits = Limits {
    unlabelled: MAX_CHECKPOINTS,
    labelled: MAX_LABELLED_CHECKPOINTS,
    unlabelled_bytes: MAX_UNLABELLED_BYTES,
    large_state: LARGE_STATE_BYTES,
};

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
    ] {
        check_text(value.clone(), limit)?;
    }
    Ok(())
}

/// Checks a written version: an opaque string the store keeps as it is.
pub fn check_version(version: &str) -> io::Result<()> {
    if version.chars().count() > MAX_TEXT {
        return Err(invalid("a replica version is at most 200 characters"));
    }
    Ok(())
}

fn load(root: &Path, dir: &Path) -> io::Result<History> {
    let Some(bytes) = read_confined(root, &dir.join(HISTORY_FILE))? else {
        return Ok(History::default());
    };
    // A damaged history file, or one of another format, reads as no history;
    // the next checkpoint replaces it.
    let history: History = serde_json::from_slice(&bytes).unwrap_or_default();
    Ok(if history.format == HISTORY_FORMAT {
        history
    } else {
        History::default()
    })
}

fn save(root: &Path, dir: &Path, history: &mut History) -> io::Result<()> {
    history.format = HISTORY_FORMAT;
    let path = dir.join(HISTORY_FILE);
    assert_safe(root, &path, true)?;
    let mut bytes = serde_json::to_vec_pretty(history).map_err(io::Error::other)?;
    bytes.push(b'\n');
    write_atomically(&path, &bytes)
}

fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn state_path(dir: &Path, hash: &str) -> PathBuf {
    dir.join(STATES_DIR).join(hash)
}

/// Keeps `snapshot` as `states/<hash>` unless a file of that size is there: a
/// state file is never changed once written.
fn put_state(root: &Path, dir: &Path, hash: &str, snapshot: &[u8]) -> io::Result<()> {
    let path = state_path(dir, hash);
    assert_safe(root, &path, true)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() == snapshot.len() as u64 => Ok(()),
        Ok(_) => write_atomically(&path, snapshot),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(dir.join(STATES_DIR))?;
            write_atomically(&path, snapshot)
        }
        Err(error) => Err(error),
    }
}

/// The snapshot `checkpoint` keeps, or `None` when its file is missing or
/// does not hash to its name.
pub fn read_state(root: &Path, dir: &Path, checkpoint: &Checkpoint) -> io::Result<Option<Vec<u8>>> {
    if !is_hash(&checkpoint.state) {
        return Ok(None);
    }
    Ok(read_confined(root, &state_path(dir, &checkpoint.state))?
        .filter(|bytes| sha256_hex(bytes) == checkpoint.state))
}

/// Removes the state files no checkpoint names.
fn collect_states(root: &Path, dir: &Path, history: &History) -> io::Result<()> {
    let states = dir.join(STATES_DIR);
    assert_safe(root, &states, true)?;
    let keep: BTreeSet<&str> = history
        .checkpoints
        .iter()
        .map(|c| c.state.as_str())
        .collect();
    let entries = match fs::read_dir(&states) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Temporary files of a write in flight start with a dot; leave them.
        if is_hash(&name) && !keep.contains(name.as_str()) {
            match fs::remove_file(entry.path()) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
        }
    }
    // An empty folder goes too (fails harmlessly when it is not empty).
    let _ = fs::remove_dir(&states);
    Ok(())
}

fn store(root: &Path, dir: &Path, history: &mut History) -> io::Result<()> {
    save(root, dir, history)?;
    collect_states(root, dir, history)
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

/// The bytes the states of the unlabelled checkpoints take, each state once.
fn unlabelled_bytes(checkpoints: &[Checkpoint]) -> u64 {
    let mut seen = BTreeSet::new();
    checkpoints
        .iter()
        .filter(|c| !c.is_labelled() && seen.insert(c.state.as_str()))
        .map(|c| c.size)
        .sum()
}

/// Drops the oldest checkpoints past the limits, never the newest one: past
/// the count or the bytes of unlabelled ones, autosaves first; past the count
/// of labelled ones, the oldest labelled.
fn thin(checkpoints: &mut Vec<Checkpoint>, limits: &Limits) {
    for labelled in [false, true] {
        loop {
            let count = checkpoints
                .iter()
                .filter(|c| c.is_labelled() == labelled)
                .count();
            let over = if labelled {
                count > limits.labelled
            } else {
                count > limits.unlabelled || unlabelled_bytes(checkpoints) > limits.unlabelled_bytes
            };
            if !over {
                break;
            }
            let last = checkpoints.len().saturating_sub(1);
            let older = &checkpoints[..last];
            let index = older
                .iter()
                .position(|c| !labelled && !c.is_labelled() && c.origin == EDIT_ORIGIN)
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

/// Records a checkpoint of `state` and answers it. A checkpoint at the version
/// of the newest one is that one; with a label it takes the label, the
/// description, and the origin asked (a kit's request makes it the kit's, Kit
/// UI protocol UI-C1). Answers `None` when the state is too large for an
/// unlabelled checkpoint of this origin (see the module documentation).
pub fn record(
    root: &Path,
    dir: &Path,
    input: CheckpointInput,
    state: State<'_>,
) -> io::Result<Option<Checkpoint>> {
    record_within(root, dir, input, state, &LIMITS)
}

fn record_within(
    root: &Path,
    dir: &Path,
    input: CheckpointInput,
    state: State<'_>,
    limits: &Limits,
) -> io::Result<Option<Checkpoint>> {
    check_origin(&input.origin)?;
    let author = check_text(input.author, MAX_TEXT)?;
    let label = check_text(input.label, MAX_TEXT)?;
    let description = check_text(input.description, MAX_DESCRIPTION)?;
    check_version(state.version)?;
    let mut history = load(root, dir)?;
    if let Some(last) = history.checkpoints.last_mut()
        && last.version == state.version
    {
        if label.is_none() {
            return Ok(Some(last.clone()));
        }
        last.label = label;
        last.description = description;
        last.origin = input.origin;
        if author.is_some() {
            last.author = author;
        }
        let upgraded = last.clone();
        thin(&mut history.checkpoints, limits);
        store(root, dir, &mut history)?;
        return Ok(Some(upgraded));
    }
    let size = state.snapshot.len() as u64;
    if label.is_none() && size > limits.large_state && input.origin != SAVE_ORIGIN {
        return Ok(None);
    }
    let hash = sha256_hex(state.snapshot);
    put_state(root, dir, &hash, state.snapshot)?;
    let checkpoint = Checkpoint {
        id: uuid::Uuid::new_v4().to_string(),
        time: input.time.unwrap_or_else(now_ms),
        origin: input.origin,
        author,
        label,
        description,
        version: state.version.to_owned(),
        state: hash,
        size,
        blobs: state.blobs,
    };
    history.checkpoints.push(checkpoint.clone());
    thin(&mut history.checkpoints, limits);
    store(root, dir, &mut history)?;
    Ok(Some(checkpoint))
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
    // A label removed makes it an unlabelled one, which counts toward their limits.
    thin(&mut history.checkpoints, &LIMITS);
    store(root, dir, &mut history)?;
    Ok(updated)
}

/// Deletes the kit's checkpoint `id`.
pub fn delete(root: &Path, dir: &Path, id: &str) -> io::Result<()> {
    let mut history = load(root, dir)?;
    let index = kit_checkpoint(&history, id)?;
    history.checkpoints.remove(index);
    store(root, dir, &mut history)
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

    fn some<T>(result: io::Result<Option<T>>) -> T {
        ok(result).unwrap_or_else(|| panic!("nothing recorded"))
    }

    fn error_text<T: std::fmt::Debug>(result: io::Result<T>) -> String {
        result.err().map(|err| err.to_string()).unwrap_or_default()
    }

    fn input(origin: &str) -> CheckpointInput {
        CheckpointInput {
            origin: origin.into(),
            author: Some("user:local".into()),
            ..CheckpointInput::default()
        }
    }

    fn labelled(label: &str) -> CheckpointInput {
        CheckpointInput {
            label: Some(label.into()),
            ..input(KIT_ORIGIN)
        }
    }

    /// A state whose snapshot is the version's bytes.
    fn at(version: &str) -> State<'_> {
        State {
            snapshot: version.as_bytes(),
            version,
            blobs: None,
        }
    }

    fn store_dir() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = temp.path().to_path_buf();
        let dir = root.join("doc");
        (temp, root, dir)
    }

    fn state_files(dir: &Path) -> usize {
        fs::read_dir(dir.join(STATES_DIR))
            .map(Iterator::count)
            .unwrap_or(0)
    }

    #[test]
    fn records_lists_and_thins_checkpoints() {
        let (_temp, root, dir) = store_dir();
        assert!(ok(list(&root, &dir)).is_empty());
        let first = some(record(&root, &dir, input("save"), at("01")));
        // The same version again is the same checkpoint.
        assert_eq!(some(record(&root, &dir, input("agent"), at("01"))), first);
        let second = some(record(&root, &dir, input("agent"), at("02")));
        assert_eq!(ok(list(&root, &dir)), vec![second.clone(), first.clone()]);
        assert_eq!(ok(find(&root, &dir, &first.id)), Some(first.clone()));
        assert!(record(&root, &dir, input("Not An Origin"), at("03")).is_err());
        assert_eq!(
            error_text(record(&root, &dir, labelled(&"x".repeat(201)), at("03"))),
            CHECKPOINT_TOO_LONG
        );

        for n in 0..MAX_CHECKPOINTS {
            some(record(&root, &dir, input("edit"), at(&format!("e{n}"))));
        }
        let listed = ok(list(&root, &dir));
        assert_eq!(listed.len(), MAX_CHECKPOINTS);
        // Autosaves went first: the save and the agent checkpoint are kept.
        assert!(listed.iter().any(|checkpoint| checkpoint.id == first.id));
        assert!(listed.iter().any(|checkpoint| checkpoint.id == second.id));
        // The states of the dropped ones went with them.
        assert_eq!(state_files(&dir), MAX_CHECKPOINTS);

        ok(std::fs::write(dir.join(HISTORY_FILE), b"garbage"));
        assert!(ok(list(&root, &dir)).is_empty());
        // So does a history of another format.
        ok(std::fs::write(
            dir.join(HISTORY_FILE),
            b"{\"format\":1,\"checkpoints\":[]}",
        ));
        assert!(ok(list(&root, &dir)).is_empty());
    }

    #[test]
    fn keeps_each_checkpoints_state() {
        let (_temp, root, dir) = store_dir();
        let one = some(record(
            &root,
            &dir,
            input("save"),
            State {
                snapshot: b"state one",
                version: "v1",
                blobs: None,
            },
        ));
        let two = some(record(
            &root,
            &dir,
            input("save"),
            State {
                snapshot: b"state two",
                version: "v2",
                blobs: None,
            },
        ));
        // The same bytes at another version are kept once.
        let again = some(record(
            &root,
            &dir,
            input("save"),
            State {
                snapshot: b"state one",
                version: "v3",
                blobs: None,
            },
        ));
        assert_eq!(state_files(&dir), 2);
        assert_eq!(again.state, one.state);
        assert_eq!(
            ok(read_state(&root, &dir, &one)).as_deref(),
            Some(&b"state one"[..])
        );
        assert_eq!(
            ok(read_state(&root, &dir, &two)).as_deref(),
            Some(&b"state two"[..])
        );
        assert_eq!(one.size, 9);
        // A damaged state file reads as none.
        ok(fs::write(state_path(&dir, &two.state), b"other"));
        assert_eq!(ok(read_state(&root, &dir, &two)), None);
    }

    #[test]
    fn keeps_descriptions_within_their_limit() {
        let (_temp, root, dir) = store_dir();
        let described = CheckpointInput {
            description: Some("d".repeat(MAX_DESCRIPTION)),
            ..labelled("Draft")
        };
        assert!(check_input(&described).is_ok());
        let kept = some(record(&root, &dir, described, at("01")));
        assert_eq!(
            kept.description.as_deref().map(str::len),
            Some(MAX_DESCRIPTION)
        );
        let longer = CheckpointInput {
            description: Some("d".repeat(MAX_DESCRIPTION + 1)),
            ..labelled("Draft")
        };
        assert_eq!(error_text(check_input(&longer)), CHECKPOINT_TOO_LONG);
        assert_eq!(
            error_text(record(&root, &dir, longer, at("02"))),
            CHECKPOINT_TOO_LONG
        );
        // A label keeps the protocol's 200 characters.
        assert!(check_input(&labelled(&"l".repeat(MAX_TEXT))).is_ok());
        assert_eq!(
            error_text(check_input(&labelled(&"l".repeat(MAX_TEXT + 1)))),
            CHECKPOINT_TOO_LONG
        );
        assert_eq!(ok(list(&root, &dir)).len(), 1);
    }

    #[test]
    fn never_thins_labelled_checkpoints_for_unlabelled_ones() {
        let (_temp, root, dir) = store_dir();
        let named = some(record(&root, &dir, labelled("First draft"), at("00")));
        for n in 0..MAX_CHECKPOINTS + 20 {
            some(record(&root, &dir, input("save"), at(&format!("s{n}"))));
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
            version: format!("{n:04x}"),
            state: format!("{n:064x}"),
            size: 1,
            blobs: None,
        };
        let mut checkpoints = vec![checkpoint(0, None)];
        checkpoints.extend((1..=MAX_LABELLED_CHECKPOINTS + 1).map(|n| checkpoint(n, Some("v"))));
        thin(&mut checkpoints, &LIMITS);
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
    fn keeps_unlabelled_states_within_their_bytes() {
        let (_temp, root, dir) = store_dir();
        let limits = Limits {
            unlabelled_bytes: 100,
            large_state: 1000,
            ..LIMITS
        };
        fn state<'a>(text: &'a [u8], version: &'a str) -> State<'a> {
            State {
                snapshot: text,
                version,
                blobs: None,
            }
        }
        let forty = [b'a'; 40];
        let named = some(record_within(
            &root,
            &dir,
            labelled("Named"),
            state(&[b'n'; 90], "n"),
            &limits,
        ));
        let first = some(record_within(
            &root,
            &dir,
            input("save"),
            state(&forty, "1"),
            &limits,
        ));
        // The same state again costs nothing more.
        some(record_within(
            &root,
            &dir,
            input("save"),
            state(&forty, "2"),
            &limits,
        ));
        let third = some(record_within(
            &root,
            &dir,
            input("save"),
            state(&[b'b'; 40], "3"),
            &limits,
        ));
        assert_eq!(ok(list(&root, &dir)).len(), 4);
        // 40 more bytes go past 100: the oldest unlabelled ones go until it fits; the labelled one stays.
        let fourth = some(record_within(
            &root,
            &dir,
            input("save"),
            state(&[b'c'; 40], "4"),
            &limits,
        ));
        let ids: Vec<String> = ok(list(&root, &dir)).into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec![fourth.id, third.id, named.id]);
        assert!(!ids.contains(&first.id));
        // The newest one stays even when it alone is past the bytes.
        let big = some(record_within(
            &root,
            &dir,
            input("save"),
            state(&[b'd'; 120], "5"),
            &limits,
        ));
        let ids: Vec<String> = ok(list(&root, &dir)).into_iter().map(|c| c.id).collect();
        assert_eq!(ids.first(), Some(&big.id));
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn records_a_large_state_unlabelled_only_at_saves() {
        let (_temp, root, dir) = store_dir();
        let limits = Limits {
            large_state: 10,
            ..LIMITS
        };
        let large = |version: &'static str| State {
            snapshot: b"more than ten bytes",
            version,
            blobs: None,
        };
        assert_eq!(
            ok(record_within(
                &root,
                &dir,
                input("agent"),
                large("1"),
                &limits
            )),
            None
        );
        assert!(ok(list(&root, &dir)).is_empty());
        assert!(
            ok(record_within(
                &root,
                &dir,
                input("save"),
                large("2"),
                &limits
            ))
            .is_some()
        );
        assert!(
            ok(record_within(
                &root,
                &dir,
                labelled("Named"),
                large("3"),
                &limits
            ))
            .is_some()
        );
        assert_eq!(
            ok(record_within(
                &root,
                &dir,
                input(KIT_ORIGIN),
                large("4"),
                &limits
            )),
            None
        );
        // A small state records at any origin.
        assert!(ok(record_within(&root, &dir, input("agent"), at("5"), &limits)).is_some());
        assert_eq!(ok(list(&root, &dir)).len(), 3);
    }

    #[test]
    fn a_label_at_the_newest_version_upgrades_that_checkpoint() {
        let (_temp, root, dir) = store_dir();
        let saved = some(record(&root, &dir, input("save"), at("01")));
        let named = some(record(
            &root,
            &dir,
            CheckpointInput {
                description: Some("Before the review".into()),
                ..labelled("Draft")
            },
            at("01"),
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
        assert_eq!(some(record(&root, &dir, input("save"), at("01"))), named);
        // Versions compare as the bytes they are: another version is another checkpoint.
        assert_ne!(
            some(record(&root, &dir, input("save"), at("01 "))).id,
            named.id
        );
    }

    #[test]
    fn lists_pages_newest_first() {
        let (_temp, root, dir) = store_dir();
        let a = some(record(&root, &dir, labelled("A"), at("01")));
        let b = some(record(&root, &dir, input("save"), at("02")));
        let c = some(record(&root, &dir, labelled("C"), at("03")));
        let d = some(record(&root, &dir, input("agent"), at("04")));
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
        let (_temp, root, dir) = store_dir();
        let host = some(record(
            &root,
            &dir,
            CheckpointInput {
                label: Some("Saved".into()),
                ..input("save")
            },
            at("01"),
        ));
        let own = some(record(
            &root,
            &dir,
            CheckpointInput {
                description: Some("first".into()),
                ..labelled("Draft")
            },
            at("02"),
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

        // A deleted checkpoint's state goes with it.
        assert_eq!(state_files(&dir), 2);
        ok(delete(&root, &dir, &own.id));
        assert_eq!(ok(find(&root, &dir, &own.id)), None);
        assert_eq!(ok(list(&root, &dir)), vec![host]);
        assert_eq!(state_files(&dir), 1);
    }
}
