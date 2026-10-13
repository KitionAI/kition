//! Tells the renderer when a workspace file changes outside Kition. Events
//! are debounced per file, and the desktop's own saves are ignored.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use serde_json::{Value, json};

use super::files::mtime_ms;

const SELF_WRITE_TTL: Duration = Duration::from_millis(800);
const DEBOUNCE: Duration = Duration::from_millis(100);

type SelfWrites = Arc<Mutex<HashMap<PathBuf, Instant>>>;

pub struct WorkspaceWatcher {
    _watcher: RecommendedWatcher,
    self_writes: SelfWrites,
}

impl WorkspaceWatcher {
    pub fn start(root: &Path, emit: impl Fn(Value) + Send + 'static) -> notify::Result<Self> {
        let root = root.to_path_buf();
        let real_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let self_writes: SelfWrites = Arc::default();
        let (sender, receiver) = mpsc::channel::<notify::Event>();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
                Ok(event) => {
                    let _ = sender.send(event);
                }
                Err(error) => eprintln!("workspace-watcher error: {error}"),
            })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;

        let writes = self_writes.clone();
        std::thread::Builder::new()
            .name("workspace-watcher".into())
            .spawn(move || debounce_loop(&receiver, &root, &real_root, &writes, &emit))
            .map_err(|error| notify::Error::generic(&error.to_string()))?;
        Ok(Self {
            _watcher: watcher,
            self_writes,
        })
    }

    /// Ignores events for `path` until the save it is about to make settles.
    pub fn mark_self_write(&self, path: &Path) {
        self.self_writes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(path.to_path_buf(), Instant::now() + SELF_WRITE_TTL);
    }
}

struct Pending {
    event_type: &'static str,
    deadline: Instant,
}

fn debounce_loop(
    receiver: &mpsc::Receiver<notify::Event>,
    root: &Path,
    real_root: &Path,
    self_writes: &SelfWrites,
    emit: &impl Fn(Value),
) {
    let mut pending: HashMap<String, (PathBuf, Pending)> = HashMap::new();
    loop {
        let timeout = pending
            .values()
            .map(|(_, item)| item.deadline.saturating_duration_since(Instant::now()))
            .min()
            .unwrap_or(Duration::from_secs(3600));
        match receiver.recv_timeout(timeout) {
            Ok(event) => {
                for path in &event.paths {
                    let Some(relative) = relative_path(root, real_root, path) else {
                        continue;
                    };
                    if is_ignored(&relative) || is_self_write(self_writes, root, real_root, path) {
                        continue;
                    }
                    let Some(event_type) = classify(&event.kind, path) else {
                        continue;
                    };
                    pending.insert(
                        relative,
                        (
                            path.clone(),
                            Pending {
                                event_type,
                                deadline: Instant::now() + DEBOUNCE,
                            },
                        ),
                    );
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        let due: Vec<String> = pending
            .iter()
            .filter(|(_, (_, item))| item.deadline <= now)
            .map(|(key, _)| key.clone())
            .collect();
        for key in due {
            if let Some((path, item)) = pending.remove(&key) {
                let mtime = std::fs::metadata(&path).ok().map(|m| mtime_ms(&m));
                emit(json!({ "path": key, "eventType": item.event_type, "mtimeMs": mtime }));
            }
        }
    }
}

fn relative_path(root: &Path, real_root: &Path, path: &Path) -> Option<String> {
    let relative = path
        .strip_prefix(root)
        .or_else(|_| path.strip_prefix(real_root))
        .ok()?;
    let parts: Vec<String> = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Option<_>>()?;
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn is_ignored(relative: &str) -> bool {
    let parts: Vec<&str> = relative.split('/').collect();
    if parts
        .iter()
        .any(|part| matches!(*part, ".git" | "node_modules" | ".kition"))
    {
        return true;
    }
    let name = parts.last().copied().unwrap_or_default();
    name == ".DS_Store" || name.ends_with(".tmp") || name.ends_with('~')
}

fn is_self_write(self_writes: &SelfWrites, root: &Path, real_root: &Path, path: &Path) -> bool {
    let mut writes = self_writes.lock().unwrap_or_else(PoisonError::into_inner);
    let now = Instant::now();
    writes.retain(|_, expires| *expires >= now);
    if writes.contains_key(path) {
        return true;
    }
    // Native events may report the canonical path of the workspace root.
    path.strip_prefix(real_root)
        .map(|relative| writes.contains_key(&root.join(relative)))
        .unwrap_or(false)
}

fn classify(kind: &EventKind, path: &Path) -> Option<&'static str> {
    if matches!(kind, EventKind::Access(_)) {
        return None;
    }
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Some(if matches!(kind, EventKind::Create(_)) {
            "add"
        } else {
            "change"
        }),
        Ok(_) => None,
        Err(_) if matches!(kind, EventKind::Create(_)) => None,
        Err(_) => Some("unlink"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_internal_paths() {
        assert!(is_ignored(".kition/state.json"));
        assert!(is_ignored(".kition/docs/index.json"));
        assert!(is_ignored(".kition/docs/doc-1/snapshot.bin"));
        assert!(is_ignored("a/node_modules/x.js"));
        assert!(is_ignored("a/.DS_Store"));
        assert!(is_ignored("a/.doc.md.1.x.tmp"));
        assert!(is_ignored("a/doc.md~"));
        assert!(!is_ignored("a/doc.md"));
    }

    #[test]
    fn reports_external_changes_but_not_self_writes() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = dir.path().to_path_buf();
        let (sender, receiver) = mpsc::channel();
        let watcher = WorkspaceWatcher::start(&root, move |event| {
            let _ = sender.send(event);
        })
        .unwrap_or_else(|err| panic!("{err}"));
        std::thread::sleep(Duration::from_millis(300));

        let own = root.join("own.md");
        watcher.mark_self_write(&own);
        std::fs::write(&own, "mine").unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(root.join("theirs.md"), "external").unwrap_or_else(|err| panic!("{err}"));

        let mut paths = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(event) = receiver.recv_timeout(Duration::from_millis(200)) {
                paths.push(event["path"].as_str().unwrap_or_default().to_owned());
            }
            if paths.iter().any(|path| path == "theirs.md") {
                break;
            }
        }
        assert!(paths.iter().any(|path| path == "theirs.md"), "{paths:?}");
        assert!(!paths.iter().any(|path| path == "own.md"), "{paths:?}");
    }
}
