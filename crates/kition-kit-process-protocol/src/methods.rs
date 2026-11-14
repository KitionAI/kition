// Copied from kition-sdk crates/kition-kit-process-protocol/src/methods.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Typed method descriptors: each request and notification names its wire
//! method and its parameter and result types.

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::types::*;

/// A request method.
pub trait RequestMethod {
    const NAME: &'static str;
    type Params: Serialize + DeserializeOwned + Send + Sync;
    type Result: Serialize + DeserializeOwned + Send;
}

/// A request the kit sends to the host on the host connection (section 5.1).
pub trait HostServiceMethod {
    const NAME: &'static str;
    type Params: Serialize + DeserializeOwned + Send + Sync;
    type Result: Serialize + DeserializeOwned + Send;
}

/// A notification method.
pub trait NotificationMethod {
    const NAME: &'static str;
    type Params: Serialize + DeserializeOwned + Send + Sync;
}

macro_rules! requests {
    ($($(#[$doc:meta])* $ty:ident = $name:literal ($params:ty) -> $result:ty;)*) => {
        $(
            $(#[$doc])*
            pub enum $ty {}
            impl RequestMethod for $ty {
                const NAME: &'static str = $name;
                type Params = $params;
                type Result = $result;
            }
        )*
        /// Every request method name.
        pub const REQUESTS: &[&str] = &[$($name),*];
    };
}

macro_rules! notifications {
    ($($(#[$doc:meta])* $ty:ident = $name:literal ($params:ty);)*) => {
        $(
            $(#[$doc])*
            pub enum $ty {}
            impl NotificationMethod for $ty {
                const NAME: &'static str = $name;
                type Params = $params;
            }
        )*
        /// Every notification method name.
        pub const NOTIFICATIONS: &[&str] = &[$($name),*];
    };
}

requests! {
    Initialize = "kit.initialize" (InitializeParams) -> InitializeResult;
    Ping = "kit.ping" (Empty) -> Empty;
    SetPreferences = "kit.setPreferences" (SetPreferencesParams) -> Empty;
    Shutdown = "kit.shutdown" (Empty) -> Empty;
    DocumentOpen = "document.open" (DocumentOpenParams) -> DocumentState;
    DocumentList = "document.list" (Empty) -> DocumentListResult;
    DocumentActivate = "document.activate" (DocumentRef) -> Empty;
    DocumentSave = "document.save" (DocumentRef) -> DocumentWritten;
    DocumentSaveAs = "document.saveAs" (DocumentSaveAsParams) -> DocumentWritten;
    DocumentExport = "document.export" (DocumentExportParams) -> DocumentWritten;
    DocumentClose = "document.close" (DocumentCloseParams) -> Empty;
    /// Host: reads the document's file again, dropping its unsaved edits (a conflict, section 5).
    DocumentReload = "document.reload" (DocumentRef) -> DocumentState;
    CommandsList = "commands.list" (CommandsListParams) -> CommandsListResult;
    CommandsExecute = "commands.execute" (CommandsExecuteParams) -> CommandsExecuteResult;
    ViewScreenshot = "view.screenshot" (ViewScreenshotParams) -> Image;
    ViewDescribe = "view.describe" (DocumentRef) -> ViewDescribeResult;
    /// Optional: a kit with the capability `document-text` (`KitText 1.0`).
    DocumentText = "document.text" (DocumentTextParams) -> DocumentTextResult;
}

macro_rules! host_services {
    ($($(#[$doc:meta])* $ty:ident = $name:literal ($params:ty) -> $result:ty;)*) => {
        $(
            $(#[$doc])*
            pub enum $ty {}
            impl HostServiceMethod for $ty {
                const NAME: &'static str = $name;
                type Params = $params;
                type Result = $result;
            }
        )*
        /// Every request method a kit sends to its host.
        pub const HOST_SERVICES: &[&str] = &[$($name),*];
    };
}

host_services! {
    FilesStat = "files.stat" (FileRef) -> FileStat;
    FilesRead = "files.read" (FilesReadParams) -> FilesReadResult;
    /// A folder handle's files.
    FilesList = "files.list" (FileRef) -> FilesListResult;
    FilesWrite = "files.write" (FilesWriteParams) -> FilesWriteResult;
    FilesCreate = "files.create" (FilesCreateParams) -> FileStat;
    FilesResolve = "files.resolve" (FilesResolveParams) -> FileStat;
    FilesRelease = "files.release" (FilesReleaseParams) -> Empty;
}

notifications! {
    /// Client to kit, once after a successful `kit.initialize`.
    Initialized = "kit.initialized" (Empty);
    /// Client to kit.
    CancelRequest = "$/cancelRequest" (CancelRequestParams);
    /// Host to kit.
    DocumentDidChangeOnDisk = "document.didChangeOnDisk" (DocumentRef);
    /// Kit to all clients.
    DocumentDidChangeState = "document.didChangeState" (DocumentState);
    /// Kit to all clients.
    DocumentDidSave = "document.didSave" (DocumentDidSaveParams);
    /// Kit to all clients.
    CommandsDidChangeEnabled = "commands.didChangeEnabled" (CommandsDidChangeEnabledParams);
    /// Kit to all clients.
    Progress = "kit.progress" (ProgressParams);
    /// Kit to all clients.
    Log = "kit.log" (LogParams);
    /// Host to kit: the handles expired or were revoked.
    FilesRevoked = "files.revoked" (FilesReleaseParams);
}

/// Whether only the `host` role may send this method (protocol section 1).
pub fn is_host_only(method: &str) -> bool {
    matches!(method, "kit.shutdown" | "kit.setPreferences" | "document.activate" | "document.didChangeOnDisk" | "document.reload")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_only_methods() {
        for method in ["kit.shutdown", "kit.setPreferences", "document.activate"] {
            assert!(is_host_only(method), "{method}");
        }
        for method in ["kit.ping", "document.open", "commands.execute", "view.screenshot"] {
            assert!(!is_host_only(method), "{method}");
        }
    }

    #[test]
    fn method_names_are_unique() {
        let mut names: Vec<_> = REQUESTS.iter().chain(NOTIFICATIONS).chain(HOST_SERVICES).collect();
        let count = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), count);
    }
}
