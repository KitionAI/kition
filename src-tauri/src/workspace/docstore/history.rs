//! A document's version history on this device: `history.json` in its folder,
//! the checkpoints recorded when it was saved, when an agent or a script
//! finished a batch of edits, every few minutes of editing, and around a
//! restore. A checkpoint names the replica version it was taken at (the
//! replica keeps its whole history, so any recorded version can be read
//! again), with its time, author, and origin, and the blobs the replica then
//! named, so a kit can show and restore it. Older checkpoints are thinned
//! past `MAX_CHECKPOINTS`, autosaves first.

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::blobs::BlobRecord;
use super::read_confined;
use crate::workspace::safety::{assert_safe, invalid, write_atomically};

pub(super) const HISTORY_FILE: &str = "history.json";
const HISTORY_FORMAT: u64 = 1;
/// The most checkpoints a document keeps.
pub const MAX_CHECKPOINTS: usize = 200;
const MAX_TEXT: usize = 200;
/// The origin of checkpoints made while editing, thinned first.
const EDIT_ORIGIN: &str = "edit";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub time: u64,
    /// `save`, `agent`, `script`, `edit`, `restore`, `open`, …
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The replica version (the writer's, in hex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The stored `seq` when the checkpoint was taken, for a stored replica.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blobs: Option<BlobRecord>,
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
    pub version: Option<String>,
    pub time: Option<u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn check_text(value: Option<String>, what: &str) -> io::Result<Option<String>> {
    match value {
        Some(text) if text.chars().count() > MAX_TEXT => {
            Err(invalid(format!("checkpoint {what} is too long")))
        }
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

fn load(root: &Path, dir: &Path) -> io::Result<History> {
    let Some(bytes) = read_confined(root, &dir.join(HISTORY_FILE))? else {
        return Ok(History::default());
    };
    // A damaged history file reads as no history; the next checkpoint replaces it.
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn save(root: &Path, dir: &Path, history: &History) -> io::Result<()> {
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

/// The checkpoint `id`.
pub fn find(root: &Path, dir: &Path, id: &str) -> io::Result<Option<Checkpoint>> {
    Ok(load(root, dir)?
        .checkpoints
        .into_iter()
        .find(|checkpoint| checkpoint.id == id))
}

/// Records a checkpoint at `head` (the stored version and its blobs, for a
/// stored replica) and answers it. A checkpoint at the version of the newest
/// one is that one.
pub fn record(
    root: &Path,
    dir: &Path,
    input: CheckpointInput,
    seq: Option<u64>,
    blobs: Option<BlobRecord>,
) -> io::Result<Checkpoint> {
    check_origin(&input.origin)?;
    let author = check_text(input.author, "author")?;
    let label = check_text(input.label, "label")?;
    let version = check_text(input.version, "version")?;
    let mut history = load(root, dir)?;
    history.format = HISTORY_FORMAT;
    if let Some(last) = history.checkpoints.last()
        && version.is_some()
        && last.version == version
    {
        return Ok(last.clone());
    }
    let checkpoint = Checkpoint {
        id: uuid::Uuid::new_v4().to_string(),
        time: input.time.unwrap_or_else(now_ms),
        origin: input.origin,
        author,
        label,
        version,
        seq,
        blobs,
    };
    history.checkpoints.push(checkpoint.clone());
    while history.checkpoints.len() > MAX_CHECKPOINTS {
        // The newest checkpoint is never the one thinned.
        let last = history.checkpoints.len() - 1;
        let index = history.checkpoints[..last]
            .iter()
            .position(|checkpoint| checkpoint.origin == EDIT_ORIGIN)
            .unwrap_or(0);
        history.checkpoints.remove(index);
    }
    save(root, dir, &history)?;
    Ok(checkpoint)
}

/// Forgets every checkpoint (the replica was replaced by one of another
/// lineage, whose history does not hold them).
pub fn clear(root: &Path, dir: &Path) -> io::Result<()> {
    let path = dir.join(HISTORY_FILE);
    assert_safe(root, &path, true)?;
    match std::fs::remove_file(&path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
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

    fn input(origin: &str, version: &str) -> CheckpointInput {
        CheckpointInput {
            origin: origin.into(),
            version: Some(version.into()),
            author: Some("user:local".into()),
            ..CheckpointInput::default()
        }
    }

    #[test]
    fn records_lists_and_thins_checkpoints() {
        let temp = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = temp.path().to_path_buf();
        let dir = root.join("doc");
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
        assert!(
            record(
                &root,
                &dir,
                CheckpointInput {
                    label: Some("x".repeat(201)),
                    ..input("save", "03")
                },
                None,
                None
            )
            .is_err()
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
        ok(record(&root, &dir, input("save", "x"), None, None));
        ok(clear(&root, &dir));
        assert!(ok(list(&root, &dir)).is_empty());
    }
}
