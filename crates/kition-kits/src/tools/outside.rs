// Copied from kition-sdk crates/kition-kits/src/tools/outside.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Changes made to a file outside the agent's calls: by a person, another agent, or a script.
//!
//! An agent that remembers "slide 20" goes wrong silently when someone else deletes or inserts
//! slides before it: the number then names another slide, and an id it read there may exist on
//! that slide too. Agents re-derive positions after a structural edit they made and saw, but
//! reuse them after one they did not see, even when a `slideId` is offered (khp-bench, tasks/conv
//! "shift" and "unseen"); and a kit that reads the changed file again may number its parts anew.
//! So the tools make such a change visible: the server remembers the file as it was when the
//! agent's last call on it ended, the first call after it changed says so, and a run is refused
//! once rather than run against whatever is now at the place the agent remembers.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde_json::{Value, json};

#[derive(Default)]
struct Seen {
    /// Size and modification time when the agent's last call on the file ended.
    fingerprint: Option<(u64, u128)>,
    /// The document's one-line summary then (`22 slides, 960 × 540 pt`).
    summary: Option<String>,
}

fn table() -> &'static Mutex<HashMap<PathBuf, Seen>> {
    static TABLE: OnceLock<Mutex<HashMap<PathBuf, Seen>>> = OnceLock::new();
    TABLE.get_or_init(Default::default)
}

fn fingerprint(file: &Path) -> Option<(u64, u128)> {
    let meta = std::fs::metadata(file).ok()?;
    Some((meta.len(), meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos()))
}

/// A change made outside the agent's calls, as the next answer reports it.
pub(crate) struct Outside {
    pub(crate) summary: String,
    pub(crate) detail: Value,
}

/// Whether the agent has touched `file` through these tools before.
pub(crate) fn known(file: &Path) -> bool {
    table().lock().is_ok_and(|table| table.contains_key(file))
}

/// Whether `file` changed since the agent's last call on it ended; `now` is the document's summary
/// as the kit reads the file now. `None` when nothing changed.
pub(crate) fn changed(file: &Path, path: &str, now: &str) -> Option<Outside> {
    let (before, was) = {
        let table = table().lock().ok()?;
        let seen = table.get(file)?;
        (seen.fingerprint?, seen.summary.clone())
    };
    if fingerprint(file) == Some(before) {
        return None;
    }
    let what = match &was {
        Some(was) if was != now => format!(": it was {was} and is now {now}"),
        _ => String::new(),
    };
    Some(Outside {
        summary: format!(
            "`{path}` changed outside your calls since your last one (someone else edited it){what}. A slide, page or object you noted before may now be elsewhere or gone, and numbers and ids may name other ones: look again before you edit. Do not undo changes you did not make."
        ),
        detail: json!({ "path": path, "was": was, "now": now }),
    })
}

/// Remembers `file` as it is now, at the end of one of the agent's calls, with the document's
/// summary when the answer has one.
pub(crate) fn remember(file: &Path, summary: Option<&str>) {
    let Ok(mut table) = table().lock() else { return };
    let seen = table.entry(file.to_path_buf()).or_default();
    seen.fingerprint = fingerprint(file);
    if let Some(summary) = summary {
        seen.summary = Some(summary.to_owned());
    }
}
