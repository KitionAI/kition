//! Attachments held inside the file: content-addressed blobs.
//!
//! An attachment cell holds a list of attachment values. A value whose `url` is
//! `kition-blob:<sha256>` ([`blob_url`]) names a blob this file holds in `kition_blobs`, keyed by
//! the lowercase hex SHA-256 of its bytes, with the MIME type and name it was stored with. Such a
//! file needs nothing outside itself to show its attachments: a kit embedded in another
//! application reads them from the file, and a co-editor receives them with the changes that
//! reference them (the KDM change carries the hash as text, the bytes travel beside it in a blob
//! section, see [`encode_blob_section`]). Older values that name a workspace path keep working;
//! Kition's runtime turns them into blobs when it writes them again.
//!
//! Blobs are file bookkeeping, not part of the table document: storing one is a plain SQL write,
//! never an undo step, and nothing deletes them (undo may bring back a value that names one).
//! The table is made by the first blob a file stores, so a file without blobs is byte for byte
//! what an older build writes; an older build opens a file with blobs, keeps them, and shows such
//! an attachment by its name.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::file::FileIdentity;
use crate::{KitableError, KitableFile, Result};

/// The URL scheme of an attachment value that names a blob of its file.
pub const BLOB_URL_SCHEME: &str = "kition-blob:";

/// The largest blob a file stores.
pub const MAX_BLOB_BYTES: usize = 50 << 20;

const HASH_LENGTH: usize = 64;
const HEADER_LENGTH: usize = HASH_LENGTH + 8;
/// Hex runs longer than this are not split into every window (they are not hash text).
const LONGEST_RUN: usize = 1024;

const CREATE_TABLE: &str = "CREATE TABLE IF NOT EXISTS kition_blobs (
    hash TEXT PRIMARY KEY,
    mime TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    created_at INTEGER NOT NULL
)";

/// A blob's description.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlobInfo {
    /// Lowercase hex SHA-256 of the bytes.
    pub hash: String,
    /// The MIME type it was stored with; empty when unknown.
    pub mime: String,
    /// The name it was first stored with; empty when unknown.
    pub name: String,
    pub size: u64,
}

/// A blob and its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blob {
    pub info: BlobInfo,
    pub bytes: Vec<u8>,
}

/// Lowercase hex SHA-256 of `bytes`: a blob's hash.
pub fn blob_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether `text` is a blob hash: 64 lowercase hex characters.
pub fn is_blob_hash(text: &str) -> bool {
    text.len() == HASH_LENGTH && text.bytes().all(is_hex)
}

/// The attachment URL that names the blob `hash`.
pub fn blob_url(hash: &str) -> String {
    format!("{BLOB_URL_SCHEME}{hash}")
}

/// The blob hash an attachment URL names, when it names one.
pub fn blob_hash_of_url(url: &str) -> Option<&str> {
    url.trim()
        .strip_prefix(BLOB_URL_SCHEME)
        .filter(|hash| is_blob_hash(hash))
}

/// The attachment value (an attachment cell's list item) for a stored blob, named `name`.
pub fn attachment_value(info: &BlobInfo, name: &str) -> Value {
    let name = match name.trim() {
        "" if info.name.is_empty() => "attachment",
        "" => info.name.as_str(),
        name => name,
    };
    json!({
        "url": blob_url(&info.hash),
        "name": name,
        "mimeType": if info.mime.is_empty() { "application/octet-stream" } else { info.mime.as_str() },
        "sizeBytes": info.size,
        "sha256": info.hash,
    })
}

fn is_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// Every lowercase 64-hex string in `bytes` that could be a blob hash: each 64-character window
/// of every run of hex characters (a hash may sit next to other hex text), as a co-editing relay
/// finds the blobs a change needs.
pub fn blob_hash_candidates(bytes: &[u8]) -> Vec<String> {
    let mut found = std::collections::BTreeSet::new();
    let mut start: Option<usize> = None;
    for index in 0..=bytes.len() {
        if index < bytes.len() && is_hex(bytes[index]) {
            start.get_or_insert(index);
            continue;
        }
        if let Some(run) = start.take() {
            let length = index - run;
            if (HASH_LENGTH..=LONGEST_RUN).contains(&length) {
                for at in run..=index - HASH_LENGTH {
                    if let Ok(text) = std::str::from_utf8(&bytes[at..at + HASH_LENGTH]) {
                        found.insert(text.to_owned());
                    }
                }
            }
        }
    }
    found.into_iter().collect()
}

/// A blob section: `(64-hex SHA-256 as ASCII, u64 little-endian length, bytes)*`, how blobs travel
/// beside replica changes (the Kit UI protocol's `replica/export`, and the runtime's replica
/// routes).
pub fn encode_blob_section<'a>(entries: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> Vec<u8> {
    let mut out = Vec::new();
    for (hash, bytes) in entries {
        out.extend_from_slice(hash.as_bytes());
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

/// The `(hash, bytes)` entries of a blob section; refuses a truncated one or a malformed hash.
pub fn decode_blob_section(section: &[u8]) -> Result<Vec<(String, Vec<u8>)>> {
    let mut entries = Vec::new();
    let mut offset = 0;
    while offset < section.len() {
        let header = section
            .get(offset..offset + HEADER_LENGTH)
            .ok_or_else(|| KitableError::invalid("a blob section ends inside a blob header"))?;
        let hash = std::str::from_utf8(&header[..HASH_LENGTH])
            .ok()
            .filter(|hash| is_blob_hash(hash))
            .ok_or_else(|| {
                KitableError::invalid("a blob section names a blob by no SHA-256 hash")
            })?;
        let mut length = [0u8; 8];
        length.copy_from_slice(&header[HASH_LENGTH..]);
        let length = usize::try_from(u64::from_le_bytes(length))
            .map_err(|_| KitableError::invalid("a blob section ends inside a blob"))?;
        let start = offset + HEADER_LENGTH;
        let end = start
            .checked_add(length)
            .filter(|end| *end <= section.len())
            .ok_or_else(|| KitableError::invalid("a blob section ends inside a blob"))?;
        entries.push((hash.to_owned(), section[start..end].to_vec()));
        offset = end;
    }
    Ok(entries)
}

/// The MIME type of common attachment bytes by their signature; empty when unknown. Blobs that
/// arrive in a blob section carry no type of their own.
pub fn sniff_mime(bytes: &[u8]) -> &'static str {
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    if starts(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if starts(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if starts(b"GIF87a") || starts(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && starts(b"RIFF") && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"avif" | b"avis")
    {
        "image/avif"
    } else if starts(b"%PDF-") {
        "application/pdf"
    } else {
        ""
    }
}

impl KitableFile {
    fn has_blob_table(&self) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kition_blobs'",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Runs a blob write, keeping this handle's view of the file's identity when the file was
    /// its own before the write: a blob is this handle's own write, not someone else's change to
    /// merge.
    fn write_blobs<T>(
        &mut self,
        write: impl FnOnce(&rusqlite::Connection) -> Result<T>,
    ) -> Result<T> {
        self.writable()?;
        let own = !self.changed_on_disk();
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        tx.execute_batch(CREATE_TABLE)?;
        let value = write(&tx)?;
        tx.commit()?;
        if own {
            self.identity = FileIdentity::of(&self.path);
        }
        Ok(value)
    }

    /// Stores `bytes` as a blob (once: the same bytes stored again keep their first MIME type
    /// and name) and answers its description. Refuses empty bytes and bytes over
    /// [`MAX_BLOB_BYTES`], and writes to a read-only handle.
    pub fn put_blob(&mut self, bytes: &[u8], mime: &str, name: &str) -> Result<BlobInfo> {
        if bytes.is_empty() {
            return Err(KitableError::invalid("attachment content is empty"));
        }
        if bytes.len() > MAX_BLOB_BYTES {
            return Err(KitableError::invalid(format!(
                "attachment cannot exceed {}MB",
                MAX_BLOB_BYTES >> 20
            )));
        }
        let hash = blob_hash(bytes);
        let mime = match mime.trim() {
            "" => sniff_mime(bytes),
            mime => mime,
        };
        self.write_blobs(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO kition_blobs (hash, mime, name, size, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![hash, mime, name.trim(), bytes.len() as i64, bytes, kition_time::now_millis()],
            )?;
            Ok(())
        })?;
        self.blob_info(&hash)?
            .ok_or_else(|| KitableError::Kdm("a stored blob could not be read back".into()))
    }

    /// Stores every blob of a blob section ([`decode_blob_section`]) that is not stored yet;
    /// answers how many were new. Refuses the whole section when an entry's bytes do not hash
    /// to its name.
    pub fn add_blob_section(&mut self, section: &[u8]) -> Result<usize> {
        let entries = decode_blob_section(section)?;
        if entries.is_empty() {
            return Ok(0);
        }
        for (hash, bytes) in &entries {
            if blob_hash(bytes) != *hash {
                return Err(KitableError::invalid(format!(
                    "the blob {hash} holds bytes of another hash"
                )));
            }
        }
        self.write_blobs(|conn| {
            let mut added = 0;
            let now = kition_time::now_millis();
            for (hash, bytes) in &entries {
                added += conn.execute(
                    "INSERT OR IGNORE INTO kition_blobs (hash, mime, name, size, bytes, created_at) VALUES (?1, ?2, '', ?3, ?4, ?5)",
                    params![hash, sniff_mime(bytes), bytes.len() as i64, bytes, now],
                )?;
            }
            Ok(added)
        })
    }

    /// The blob `hash`, when the file holds it.
    pub fn blob(&self, hash: &str) -> Result<Option<Blob>> {
        if !is_blob_hash(hash) || !self.has_blob_table()? {
            return Ok(None);
        }
        Ok(self
            .conn
            .query_row(
                "SELECT hash, mime, name, size, bytes FROM kition_blobs WHERE hash = ?1",
                [hash],
                |row| {
                    Ok(Blob {
                        info: BlobInfo {
                            hash: row.get(0)?,
                            mime: row.get(1)?,
                            name: row.get(2)?,
                            size: row.get::<_, i64>(3)?.max(0) as u64,
                        },
                        bytes: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    /// The blob `hash`'s description, when the file holds it.
    pub fn blob_info(&self, hash: &str) -> Result<Option<BlobInfo>> {
        if !is_blob_hash(hash) || !self.has_blob_table()? {
            return Ok(None);
        }
        Ok(self
            .conn
            .query_row(
                "SELECT hash, mime, name, size FROM kition_blobs WHERE hash = ?1",
                [hash],
                |row| {
                    Ok(BlobInfo {
                        hash: row.get(0)?,
                        mime: row.get(1)?,
                        name: row.get(2)?,
                        size: row.get::<_, i64>(3)?.max(0) as u64,
                    })
                },
            )
            .optional()?)
    }

    /// The hashes of every blob the file holds, in order.
    pub fn blob_hashes(&self) -> Result<Vec<String>> {
        if !self.has_blob_table()? {
            return Ok(Vec::new());
        }
        let mut statement = self
            .conn
            .prepare("SELECT hash FROM kition_blobs ORDER BY hash")?;
        let hashes = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(hashes)
    }

    /// A blob section of the blobs among `hashes` the file holds (the others are left out).
    pub fn blob_section<S: AsRef<str>>(&self, hashes: &[S]) -> Result<Vec<u8>> {
        let mut blobs = Vec::new();
        for hash in hashes {
            if let Some(blob) = self.blob(hash.as_ref())? {
                blobs.push(blob);
            }
        }
        Ok(encode_blob_section(blobs.iter().map(|blob| {
            (blob.info.hash.as_str(), blob.bytes.as_slice())
        })))
    }

    /// A blob section of every blob the file holds.
    pub fn all_blobs_section(&self) -> Result<Vec<u8>> {
        self.blob_section(&self.blob_hashes()?)
    }

    /// The blob section a co-editor needs beside `changes` (exported replica changes): every blob
    /// this file holds whose hash the changes name.
    pub fn blobs_for_changes(&self, changes: &[u8]) -> Result<Vec<u8>> {
        if !self.has_blob_table()? {
            return Ok(Vec::new());
        }
        self.blob_section(&blob_hash_candidates(changes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_urls_and_sections_round_trip() {
        let hash = blob_hash(b"abc");
        assert_eq!(
            hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(is_blob_hash(&hash));
        assert!(!is_blob_hash(&hash.to_uppercase()));
        assert_eq!(blob_hash_of_url(&blob_url(&hash)), Some(hash.as_str()));
        assert_eq!(blob_hash_of_url("/workspace-files/a.png"), None);
        assert_eq!(blob_hash_of_url("kition-blob:abc"), None);

        let section = encode_blob_section([(hash.as_str(), b"abc".as_slice())]);
        assert_eq!(section.len(), HEADER_LENGTH + 3);
        let decoded = decode_blob_section(&section).unwrap_or_default();
        assert_eq!(decoded, vec![(hash.clone(), b"abc".to_vec())]);
        assert!(decode_blob_section(&section[..section.len() - 1]).is_err());
        assert!(decode_blob_section(&section[..10]).is_err());
        assert_eq!(decode_blob_section(&[]).unwrap_or_default(), Vec::new());
    }

    #[test]
    fn candidates_find_hashes_inside_other_bytes() {
        let hash = blob_hash(b"picture");
        let mut bytes = b"\x00\x01{\"url\":\"kition-blob:".to_vec();
        bytes.extend_from_slice(hash.as_bytes());
        bytes.extend_from_slice(b"\"}\xff");
        assert_eq!(blob_hash_candidates(&bytes), vec![hash.clone()]);
        // A hash next to more hex text: every 64-character window is a candidate.
        let longer = format!("{hash}ab");
        assert_eq!(blob_hash_candidates(longer.as_bytes()).len(), 3);
        assert!(blob_hash_candidates(b"short").is_empty());
    }

    #[test]
    fn sniffs_common_types() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\n...."), "image/png");
        assert_eq!(sniff_mime(b"\xff\xd8\xff\xe0"), "image/jpeg");
        assert_eq!(sniff_mime(b"GIF89a"), "image/gif");
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
        assert_eq!(sniff_mime(b"%PDF-1.7"), "application/pdf");
        assert_eq!(sniff_mime(b"hello"), "");
    }

    #[test]
    fn attachment_values_name_the_blob() {
        let info = BlobInfo {
            hash: blob_hash(b"x"),
            mime: "image/png".into(),
            name: "a.png".into(),
            size: 1,
        };
        let value = attachment_value(&info, "");
        assert_eq!(value["url"], json!(blob_url(&info.hash)));
        assert_eq!(value["name"], json!("a.png"));
        assert_eq!(value["mimeType"], json!("image/png"));
        assert_eq!(value["sizeBytes"], json!(1));
        assert_eq!(attachment_value(&info, "b.png")["name"], json!("b.png"));
    }
}
