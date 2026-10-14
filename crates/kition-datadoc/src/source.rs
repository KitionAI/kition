//! Resolving and opening the `.kitable` file behind a document row.

use std::path::{Component, Path, PathBuf};

use kition_core::events::DomainEvent;
use kition_core::{AppError, AppResult};
use kition_kdm::Origin;

use crate::DataDocState;
use crate::index::{self, DataDocument};
use crate::table_documents::{TableHandle, default_origin, table_changed_event};

/// `path`, or `<title>.kitable` when blank.
pub fn default_document_path(path: &str, title: &str) -> String {
    let path = path.trim();
    if !path.is_empty() {
        return path.to_owned();
    }
    let stem = match title.trim() {
        "" => "Untitled data document",
        stem => stem,
    };
    if stem.to_lowercase().ends_with(".kitable") {
        stem.to_owned()
    } else {
        format!("{stem}.kitable")
    }
}

/// Joins a workspace-relative `.kitable` path under `root`.
pub fn resolve_from_root(root: &str, path: &str) -> AppResult<PathBuf> {
    let root = root.trim();
    if root.is_empty() {
        return Err(AppError::bad_request(
            "Workspace directory is not configured",
        ));
    }
    let relative = clean(path.trim());
    if relative.as_os_str().is_empty() || relative == Path::new(".") {
        return Err(AppError::bad_request("Invalid data document path"));
    }
    // On Windows a rooted `\\etc` or drive-relative `C:x` is not absolute,
    // yet joining it replaces the workspace root.
    if !relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(AppError::bad_request(
            "Data document path cannot escape the workspace",
        ));
    }
    let is_kitable = relative
        .extension()
        .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("kitable"));
    if !is_kitable {
        return Err(AppError::bad_request(
            "Data documents must use the .kitable extension",
        ));
    }
    Ok(Path::new(root).join(relative))
}

/// Lexical cleanup like the legacy path handling: drops `.`, folds `..`
/// against preceding components, keeps leading `..`.
fn clean(path: &str) -> PathBuf {
    let mut parts: Vec<Component<'_>> = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match parts.last() {
                Some(Component::Normal(_)) => {
                    parts.pop();
                }
                Some(Component::RootDir) => {}
                _ => parts.push(component),
            },
            other => parts.push(other),
        }
    }
    parts.iter().collect()
}

impl DataDocState {
    pub(crate) fn workspace_root_string(&self) -> String {
        self.workspace_dir.to_string_lossy().into_owned()
    }

    /// The root a by-path request acts on: the client's, else the runtime's.
    pub(crate) fn request_workspace_root(&self, value: &str) -> String {
        match value.trim() {
            "" => self.workspace_root_string(),
            root => root.to_owned(),
        }
    }

    /// Opens the document's file as `origin`, trying its recorded root and then the runtime's
    /// workspace. Records the root that worked. When the file had changed on disk since the
    /// last handle to it closed, publishes the merge as a `table/changed` event, attributed to
    /// `Origin::system("external")` since whoever wrote it is not this request's caller.
    pub(crate) fn open_document_as(
        &self,
        doc: &DataDocument,
        origin: Origin,
    ) -> AppResult<TableHandle> {
        let mut roots: Vec<String> = Vec::new();
        for candidate in [
            doc.workspace_root.trim().to_owned(),
            self.workspace_root_string(),
        ] {
            if !candidate.is_empty() && !roots.contains(&candidate) {
                roots.push(candidate);
            }
        }
        let mut last_error = AppError::bad_request("Workspace directory is not configured");
        for root in roots {
            let path = match resolve_from_root(&root, &doc.path) {
                Ok(path) => path,
                Err(err) => {
                    last_error = err;
                    continue;
                }
            };
            if let Err(err) = std::fs::metadata(&path) {
                if err.kind() == std::io::ErrorKind::NotFound {
                    tracing::debug!(path = %path.display(), document_id = doc.id, "kitable file missing");
                } else {
                    tracing::error!(path = %path.display(), document_id = doc.id, error = %err, "kitable open failed");
                }
                last_error = AppError::from(err);
                continue;
            }
            match self.tables.open(&path, origin.clone()) {
                Ok((mut handle, merge)) => {
                    if doc.id != 0 && doc.workspace_root.trim() != root {
                        let conn = self.db.conn()?;
                        index::set_workspace_root(&conn, doc.id, &root)?;
                    }
                    self.migrate_dashboards_from_meta(doc, &mut handle);
                    if let Some(change) = merge {
                        self.events
                            .publish(DomainEvent::TableChanged(table_changed_event(
                                &doc.id.to_string(),
                                &Origin::system("external"),
                                &doc.path,
                                &change,
                            )));
                    }
                    return Ok(handle);
                }
                Err(err) => {
                    tracing::error!(path = %path.display(), document_id = doc.id, error = %err, "kitable open failed");
                    last_error = err;
                }
            }
        }
        Err(last_error)
    }

    /// Opens the document's file as the default origin.
    pub(crate) fn open_document(&self, doc: &DataDocument) -> AppResult<TableHandle> {
        self.open_document_as(doc, default_origin())
    }

    /// Opens the file as `origin` or fails with the legacy 500 message.
    pub(crate) fn open_or_500_as(
        &self,
        doc: &DataDocument,
        origin: Origin,
    ) -> AppResult<TableHandle> {
        self.open_document_as(doc, origin)
            .map_err(|_| AppError::internal("Failed to open data document"))
    }

    /// Opens the file or fails with the legacy 500 message.
    pub(crate) fn open_or_500(&self, doc: &DataDocument) -> AppResult<TableHandle> {
        self.open_or_500_as(doc, default_origin())
    }

    /// Loads the caller's document named by the `documentId` path segment.
    pub(crate) fn load_document(&self, user_id: i64, id: &str) -> AppResult<DataDocument> {
        let conn = self.db.conn()?;
        index::find(&conn, user_id, id)?
            .ok_or_else(|| AppError::not_found("Data document does not exist"))
    }
}

/// A positive integer path parameter.
pub fn parse_id(value: &str) -> AppResult<i64> {
    match value.parse::<i64>() {
        Ok(id) if id > 0 => Ok(id),
        _ => Err(AppError::bad_request("Invalid ID parameter")),
    }
}

/// `limit` and `offset` query values: non-negative, limit capped at 5000.
pub fn list_window(limit: Option<&String>, offset: Option<&String>) -> (i64, i64) {
    let parse = |value: Option<&String>| {
        value
            .and_then(|v| v.trim().parse::<i64>().ok())
            .unwrap_or(0)
            .max(0)
    };
    (parse(limit).min(5000), parse(offset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_paths() {
        assert_eq!(default_document_path(" a/b.kitable ", "x"), "a/b.kitable");
        assert_eq!(default_document_path("", "Plan"), "Plan.kitable");
        assert_eq!(default_document_path("", "Plan.KITABLE"), "Plan.KITABLE");
        assert_eq!(
            default_document_path("", " "),
            "Untitled data document.kitable"
        );
    }

    #[test]
    fn resolves_inside_workspace() {
        assert_eq!(
            resolve_from_root("/ws", "a/../b.kitable").ok(),
            Some(PathBuf::from("/ws/b.kitable"))
        );
        assert!(resolve_from_root("", "a.kitable").is_err());
        assert!(resolve_from_root("/ws", "../a.kitable").is_err());
        assert!(resolve_from_root("/ws", "/etc/a.kitable").is_err());
        if cfg!(windows) {
            assert!(resolve_from_root("C:\\ws", "\\etc\\a.kitable").is_err());
            assert!(resolve_from_root("C:\\ws", "D:a.kitable").is_err());
            assert!(resolve_from_root("C:\\ws", "D:\\a.kitable").is_err());
        }
        assert!(resolve_from_root("/ws", "a.md").is_err());
        assert!(resolve_from_root("/ws", ".").is_err());
    }

    #[test]
    fn list_windows() {
        let s = |v: &str| Some(v.to_owned());
        assert_eq!(list_window(s("10").as_ref(), s("-3").as_ref()), (10, 0));
        assert_eq!(list_window(s("9999").as_ref(), None), (5000, 0));
        assert_eq!(list_window(s("x").as_ref(), s("4").as_ref()), (0, 4));
    }
}
