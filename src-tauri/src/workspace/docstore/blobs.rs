//! A kit replica's blobs as content-addressed files, `blobs/<sha256>`, in its
//! document's folder.
//!
//! A kit hands its blobs over as one bundle (Kit UI protocol section 7):
//! `(64-character hex SHA-256, u64 little-endian length, bytes) * N`. The store
//! keeps each blob of a bundle in its own file named by its hash, so a save
//! writes only the blobs that are new, and records the bundle's hashes in order
//! so the bundle reads back byte for byte. A bundle it cannot split (another
//! encoding, or a blob whose bytes do not hash to its name) is kept whole,
//! as one content-addressed file.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{read_confined, sha256_hex};
use crate::workspace::safety::{assert_safe, write_atomically};

pub(super) const BLOBS_DIR: &str = "blobs";
const HASH_LEN: usize = 64;

/// Which blob files make up a bundle: the bundle's blobs in order, or the
/// bundle kept whole.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hashes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<String>,
}

impl BlobRecord {
    /// Every blob file the record names.
    pub fn files(&self) -> impl Iterator<Item = &str> {
        self.hashes
            .iter()
            .flatten()
            .chain(self.bundle.iter())
            .map(String::as_str)
    }
}

fn is_hash(text: &str) -> bool {
    text.len() == HASH_LEN
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The blobs of `bundle`, when every one is named by the SHA-256 of its bytes.
fn split(bundle: &[u8]) -> Option<Vec<(String, &[u8])>> {
    let mut blobs = Vec::new();
    let mut at = 0usize;
    while at < bundle.len() {
        let hash_end = at.checked_add(HASH_LEN)?;
        let hash = std::str::from_utf8(bundle.get(at..hash_end)?).ok()?;
        let len_end = hash_end.checked_add(8)?;
        let len: [u8; 8] = bundle.get(hash_end..len_end)?.try_into().ok()?;
        let len = usize::try_from(u64::from_le_bytes(len)).ok()?;
        let data_end = len_end.checked_add(len)?;
        let data = bundle.get(len_end..data_end)?;
        if !is_hash(hash) || sha256_hex(data) != hash {
            return None;
        }
        blobs.push((hash.to_owned(), data));
        at = data_end;
    }
    Some(blobs)
}

fn blob_path(dir: &Path, hash: &str) -> PathBuf {
    dir.join(BLOBS_DIR).join(hash)
}

/// Writes `bytes` as the blob file `hash` unless a file of that size is there:
/// a blob file is never changed once written.
fn put(root: &Path, dir: &Path, hash: &str, bytes: &[u8]) -> io::Result<()> {
    let path = blob_path(dir, hash);
    assert_safe(root, &path, true)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() == bytes.len() as u64 => Ok(()),
        Ok(_) => write_atomically(&path, bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => write_atomically(&path, bytes),
        Err(error) => Err(error),
    }
}

/// Keeps the blobs of `bundle` in `dir/blobs/` and answers the record naming them.
pub fn store(root: &Path, dir: &Path, bundle: &[u8]) -> io::Result<BlobRecord> {
    match split(bundle) {
        Some(blobs) => {
            let mut written = BTreeSet::new();
            for (hash, data) in &blobs {
                if written.insert(hash.as_str()) {
                    put(root, dir, hash, data)?;
                }
            }
            Ok(BlobRecord {
                hashes: Some(blobs.into_iter().map(|(hash, _)| hash).collect()),
                bundle: None,
            })
        }
        None => {
            let hash = sha256_hex(bundle);
            put(root, dir, &hash, bundle)?;
            Ok(BlobRecord {
                hashes: None,
                bundle: Some(hash),
            })
        }
    }
}

/// A blob file's bytes, or `None` when it is missing or does not hash to its name.
fn get(root: &Path, dir: &Path, hash: &str) -> io::Result<Option<Vec<u8>>> {
    if !is_hash(hash) {
        return Ok(None);
    }
    Ok(read_confined(root, &blob_path(dir, hash))?.filter(|bytes| sha256_hex(bytes) == hash))
}

/// The bundle `record` names, byte for byte as stored, or `None` when a blob is
/// missing or damaged.
pub fn load(root: &Path, dir: &Path, record: &BlobRecord) -> io::Result<Option<Vec<u8>>> {
    if let Some(hash) = &record.bundle {
        return get(root, dir, hash);
    }
    let mut out = Vec::new();
    for hash in record.hashes.iter().flatten() {
        let Some(data) = get(root, dir, hash)? else {
            return Ok(None);
        };
        out.extend_from_slice(hash.as_bytes());
        out.extend_from_slice(&(data.len() as u64).to_le_bytes());
        out.extend_from_slice(&data);
    }
    Ok(Some(out))
}

/// Removes the blob files no record in `keep` names.
pub fn collect_garbage<'a>(
    root: &Path,
    dir: &Path,
    keep: impl IntoIterator<Item = &'a BlobRecord>,
) -> io::Result<()> {
    let blobs = dir.join(BLOBS_DIR);
    assert_safe(root, &blobs, true)?;
    let keep: BTreeSet<&str> = keep.into_iter().flat_map(BlobRecord::files).collect();
    let entries = match fs::read_dir(&blobs) {
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
    let _ = fs::remove_dir(&blobs);
    Ok(())
}

#[cfg(test)]
pub(super) fn bundle(blobs: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for data in blobs {
        out.extend_from_slice(sha256_hex(data).as_bytes());
        out.extend_from_slice(&(data.len() as u64).to_le_bytes());
        out.extend_from_slice(data);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok<T>(result: io::Result<T>) -> T {
        result.unwrap_or_else(|err| panic!("{err}"))
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir.join(BLOBS_DIR))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn keeps_each_blob_once_and_reads_the_bundle_back() {
        let temp = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = temp.path().to_path_buf();
        let dir = root.join("doc");
        let first = bundle(&[b"one", b"two", b"one"]);
        let record = ok(store(&root, &dir, &first));
        assert_eq!(record.hashes.as_ref().map(Vec::len), Some(3));
        assert_eq!(names(&dir).len(), 2);
        assert_eq!(ok(load(&root, &dir, &record)), Some(first));

        // An empty bundle is no blobs at all.
        let empty = ok(store(&root, &dir, b""));
        assert_eq!(empty.hashes, Some(Vec::new()));
        assert_eq!(ok(load(&root, &dir, &empty)), Some(Vec::new()));

        // A bundle that does not split is kept whole.
        let odd = b"not a bundle".to_vec();
        let whole = ok(store(&root, &dir, &odd));
        assert_eq!(whole.bundle, Some(sha256_hex(&odd)));
        assert_eq!(ok(load(&root, &dir, &whole)), Some(odd));
        let mut forged = bundle(&[b"x"]);
        let last = forged.len() - 1;
        forged[last] = b'y';
        assert!(ok(store(&root, &dir, &forged)).bundle.is_some());

        // A damaged or missing blob reads as no bundle.
        let hash = sha256_hex(b"two");
        ok(fs::write(dir.join(BLOBS_DIR).join(&hash), b"TWO"));
        assert_eq!(ok(load(&root, &dir, &record)), None);
        ok(fs::remove_file(dir.join(BLOBS_DIR).join(&hash)));
        assert_eq!(ok(load(&root, &dir, &record)), None);

        // Only what a record names survives a collection.
        let kept = ok(store(&root, &dir, &bundle(&[b"two"])));
        ok(collect_garbage(&root, &dir, [&kept]));
        assert_eq!(names(&dir), vec![hash]);
    }
}
