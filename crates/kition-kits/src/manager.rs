//! Running kits for the open workspace.
//!
//! A kit starts on first use in the `headless` surface with the workspace folder as its only
//! root; it serves previews, kit tabs in the browser, and the agent. A kit tab in the desktop app
//! starts its own kit process in the `embedded` surface instead, whose native editor window the
//! runtime keeps over the tab (`surfaces.rs`). Each kit process gets two connections: the `host`
//! connection serves people, and an `agent` connection serves agent tools, so the kit itself
//! enforces the agent's role and URI limits. Kits stop when the manager is dropped, which happens
//! when the runtime restarts for another workspace.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use kition_kit_host::{ClientError, KitClient, KitProcess, LaunchOptions};
use kition_kit_protocol::launch::Surface;
use kition_kit_protocol::methods::{self, NotificationMethod, RequestMethod};
use kition_kit_protocol::types::*;
use kition_kit_protocol::{ErrorReason, PROTOCOL_VERSION};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::surfaces::SurfaceKit;

/// What [`KitManager::write_file`] may do to its target.
#[derive(Debug, Clone, Copy)]
pub enum FileWrite<'a> {
    /// Saves `document`, the file an editor opened: only that file is replaced.
    Save { document: &'a str },
    /// Makes a new file (a new document, or an export); an existing file is never replaced.
    New,
}

/// A kit Kition knows how to use.
#[derive(Debug)]
pub struct KitDefinition {
    pub id: &'static str,
    pub name: &'static str,
    /// The environment variable that points at a local build of the kit executable.
    pub binary_env: &'static str,
    /// Lowercase extensions, without the dot, that open in this kit.
    pub extensions: &'static [&'static str],
    /// Extensions Kition can create new documents in, with the kit's format id for each.
    pub creates: &'static [(&'static str, &'static str)],
    /// A new document's name before its extension and number (`kit.json` `creates[].baseName`),
    /// for example `Untitled photo`.
    pub base_name: &'static str,
    /// Whether the kit's own editor can be embedded in a desktop tab.
    pub embeds: bool,
    /// Extensions the kit's in-page editor writes as new files: its exports (`mp4` from a video
    /// project) and the files it keeps beside its documents (images pasted into a note). They are
    /// only ever new files: `write_file` never replaces an existing one with them.
    pub exports: &'static [&'static str],
    /// How the agent's tools for this kit read (`kit.json` `agent`).
    pub agent: KitAgent,
}

/// The words the agent's tools for a kit use. The tools are `<prefix>_inspect`,
/// `<prefix>_commands`, and `<prefix>_run` (Kition Kit Standard A3).
#[derive(Debug)]
pub struct KitAgent {
    /// `kit.json` `agent.prefix`.
    pub prefix: &'static str,
    /// What one file is, for example `layered image`.
    pub noun: &'static str,
    /// The file types as people know them, for example `PSD, PSB, or .kphoto`.
    pub formats: &'static str,
    /// What `<prefix>_inspect` reports.
    pub reports: &'static str,
    /// What the commands cover.
    pub covers: &'static str,
    /// Keywords that find commands, for example `` `brightness` or `new layer` ``.
    pub queries: &'static str,
    /// One command id, as an example.
    pub command: &'static str,
}

pub const KITS: &[KitDefinition] = &[
    KitDefinition {
        id: "kit.html",
        name: "HTML",
        binary_env: "KITION_KIT_HTML_BINARY",
        extensions: &["html", "htm"],
        creates: &[("html", "html")],
        base_name: "Untitled HTML",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "html",
            noun: "HTML document",
            formats: "HTML (.html or .htm)",
            reports: "its HTML source, viewport, and undo state",
            covers: "HTML source replacement and undo/redo; HTML/CSS rendering and bounded JavaScript with supplied resources",
            queries: "`Replace HTML` or `Undo`",
            command: "html.setSource",
        },
    },
    KitDefinition {
        id: "kit.photo",
        name: "Photo",
        binary_env: "KITION_KIT_PHOTO_BINARY",
        extensions: &["psd", "psb", "kphoto"],
        creates: &[("psd", "psd"), ("psb", "psb"), ("kphoto", "kphoto")],
        base_name: "Untitled photo",
        embeds: true,
        exports: &[],
        agent: KitAgent {
            prefix: "photo",
            noun: "layered image",
            formats: "PSD, PSB, or .kphoto",
            reports: "its size, color mode, bit depth, and layers",
            covers: "layers, adjustments, filters, selections, transforms, type, and more",
            queries: "`brightness`, `gaussian blur`, or `new layer`",
            command: "layer.new.layer",
        },
    },
    // Edited in the page through its SDK; `kit-film` serves the agent.
    KitDefinition {
        id: "kit.film",
        name: "Film",
        binary_env: "KITION_KIT_FILM_BINARY",
        extensions: &["kfilm"],
        creates: &[],
        base_name: "Untitled film",
        embeds: false,
        exports: &["mp4"],
        agent: KitAgent {
            prefix: "film",
            noun: "video project",
            formats: ".kfilm",
            reports: "its sequences, tracks, clips, and playhead",
            covers: "clips, the timeline, trimming, transitions, titles, audio, and more",
            queries: "`split`, `place clip`, or `color matte`",
            command: "timeline.place",
        },
    },
    // Edited in the page through its SDK.
    KitDefinition {
        id: "kit.vector",
        name: "Vector",
        binary_env: "KITION_KIT_VECTOR_BINARY",
        extensions: &["kvector"],
        creates: &[],
        base_name: "Untitled vector",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "vector",
            noun: "vector drawing",
            formats: ".kvector",
            reports: "its artboards, layers, objects, and selection",
            covers: "shapes, paths, paint, type, alignment, effects, artboards, and more",
            queries: "`rectangle`, `align`, or `stroke`",
            command: "shape.rectangle",
        },
    },
    // Edited in the page through its SDK; renders are new MP4 files.
    KitDefinition {
        id: "kit.effect",
        name: "Effect",
        binary_env: "KITION_KIT_EFFECT_BINARY",
        extensions: &["keffect"],
        creates: &[],
        base_name: "Untitled effect",
        embeds: false,
        exports: &["mp4"],
        agent: KitAgent {
            prefix: "effect",
            noun: "motion graphics project",
            formats: ".keffect",
            reports: "its active composition, layers, and their keyframe times",
            covers: "compositions, layers, keyframes, effects, masks, text, and more",
            queries: "`new solid`, `add keyframe`, or `gaussian blur`",
            command: "layer.newSolid",
        },
    },
    // Edited in the page through its SDK.
    KitDefinition {
        id: "kit.design",
        name: "Design",
        binary_env: "KITION_KIT_DESIGN_BINARY",
        extensions: &["kdesign"],
        creates: &[],
        base_name: "Untitled design",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "design",
            noun: "page layout",
            formats: ".kdesign",
            reports: "its pages, spreads, frames, stories, styles, and swatches",
            covers: "pages, frames, text, styles, swatches, tables, and more",
            queries: "`text frame`, `paragraph style`, or `insert page`",
            command: "frame.create",
        },
    },
    // Edited in the page through its SDK.
    KitDefinition {
        id: "kit.cad",
        name: "CAD",
        binary_env: "KITION_KIT_CAD_BINARY",
        extensions: &["dxf"],
        creates: &[],
        base_name: "Untitled CAD",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "cad",
            noun: "CAD drawing",
            formats: ".dxf",
            reports: "its layers, object count, current layer, and command prompt",
            covers: "drawing, modifying, dimensions, layers, blocks, and AutoCAD-style commands; `commandLine` runs any command-line entry",
            queries: "`circle`, `layer`, or `dimension`",
            command: "circle",
        },
    },
    // Edited in the page through its SDK; PowerPoint files too.
    KitDefinition {
        id: "kit.slide",
        name: "Kition Slide",
        binary_env: "KITION_KIT_SLIDE_BINARY",
        extensions: &["kslide", "pptx"],
        creates: &[],
        base_name: "Untitled slide",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "slide",
            noun: "slide file",
            formats: ".kslide and .pptx",
            reports: "its slides, the current slide, and the selection",
            covers: "slides, layouts, text, shapes, pictures, tables, charts, transitions, animations, and more",
            queries: "`new slide`, `text box`, or `transition`",
            command: "shape.insert",
        },
    },
    // Edited in the page through its SDK.
    KitDefinition {
        id: "kit.doc",
        name: "Doc",
        binary_env: "KITION_KIT_DOC_BINARY",
        extensions: &["docx"],
        creates: &[],
        base_name: "Untitled document",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "doc",
            noun: "doc",
            formats: ".docx",
            reports: "its pages, word count, and the selection",
            covers: "typing, styles, fonts, paragraphs, lists, tables, pictures, headers and footers, references, review, and more",
            queries: "`bold`, `heading`, or `insert table`",
            command: "text.insert",
        },
    },
    // Edited in the page through its SDK.
    KitDefinition {
        id: "kit.sheet",
        name: "Sheet",
        binary_env: "KITION_KIT_SHEET_BINARY",
        extensions: &["xlsx"],
        creates: &[],
        base_name: "Untitled sheet",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "sheet",
            noun: "spreadsheet",
            formats: ".xlsx",
            reports: "its sheets, the used range, the selection, and the active cell",
            covers: "cells, formulas, formatting, sorting, filtering, tables, charts, PivotTables, and more; `cell.set` enters a value or formula",
            queries: "`cell`, `sort`, or `format`",
            command: "cell.set",
        },
    },
    // Edited in the page through its SDK.
    KitDefinition {
        id: "kit.pdf",
        name: "PDF",
        binary_env: "KITION_KIT_PDF_BINARY",
        extensions: &["pdf"],
        creates: &[],
        base_name: "Untitled PDF",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "pdf",
            noun: "PDF",
            formats: ".pdf",
            reports: "its pages and labels, whether it can be edited, and its form fields",
            covers: "pages, text, comments, forms, bookmarks, links, watermarks, redaction, measuring, accessibility, and more",
            queries: "`rotate`, `comment`, or `watermark`",
            command: "page_rotate",
        },
    },
    // Edited in the page through its SDK; `kit-table` serves the agent and the host table client
    // (workflows) for files no editor has open.
    KitDefinition {
        id: "kit.table",
        name: "Table",
        binary_env: "KITION_KIT_TABLE_BINARY",
        extensions: &["ktable"],
        creates: &[("ktable", "ktable")],
        base_name: "Untitled table",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "table",
            noun: "table file",
            formats: ".ktable",
            reports: "its tables, fields, views, and record counts",
            covers: "tables, fields, records, views, filters, sorting, grouping, links, dashboards, and more; `table.records.create` adds a record",
            queries: "`records`, `fields`, or `views`",
            command: "table.records.create",
        },
    },
    // Edited in the page through its SDK; `kit-board` serves the agent for files no editor has open.
    KitDefinition {
        id: "kit.board",
        name: "Board",
        binary_env: "KITION_KIT_BOARD_BINARY",
        extensions: &["kboard"],
        creates: &[("kboard", "kboard")],
        base_name: "Untitled board",
        embeds: false,
        exports: &["png", "svg", "pdf"],
        agent: KitAgent {
            prefix: "board",
            noun: "board",
            formats: ".kboard",
            reports: "its pages, frames, and element counts",
            covers: "shapes, sticky notes, text, connectors, frames, mind maps, templates, layout, pages, and more; `element.create` adds elements",
            queries: "`connector`, `frame`, or `mindmap`",
            command: "element.create",
        },
    },
    // Edited in the page through its SDK; `kit-note` serves the agent for notes no editor has open.
    KitDefinition {
        id: "kit.note",
        name: "Note",
        binary_env: "KITION_KIT_NOTE_BINARY",
        extensions: &["md", "markdown"],
        creates: &[("md", "markdown")],
        base_name: "Untitled note",
        embeds: false,
        exports: &["html", "pdf", "png", "jpg", "gif", "webp", "svg", "avif"],
        agent: KitAgent {
            prefix: "note",
            noun: "note",
            formats: "Markdown (.md)",
            reports: "its outline, properties, links, tables, tasks, and comment threads",
            covers: "text, headings, lists, tasks, tables, properties, links, comments, templates, and more; `text.insert` adds text",
            queries: "`table`, `property`, or `comment`",
            command: "text.insert",
        },
    },
    // Edited in the page through its SDK; `kit-cube` serves the agent.
    KitDefinition {
        id: "kit.cube",
        name: "Cube",
        binary_env: "KITION_KIT_CUBE_BINARY",
        extensions: &["kcube"],
        creates: &[("kcube", "kcube")],
        base_name: "Untitled cube",
        embeds: false,
        exports: &["glb", "gltf", "obj", "stl", "fbx", "usda", "usdz", "png"],
        agent: KitAgent {
            prefix: "cube",
            noun: "3D scene",
            formats: ".kcube",
            reports: "its objects (meshes, curves, texts, armatures, lights, cameras, empties) with transforms, materials, modifiers, constraints, and animation, the images, the frame, the mode, and the selection",
            covers: "adding primitives, curves, and text, transforms, parenting, edit-mode modeling (extrude, inset, bevel, loop cut, knife, dissolve, bridge, bisect, spin), sculpting (sculpt.stroke), modifiers, seams and UV unwrapping, image and normal-map textures, materials, lights, cameras, armatures, skinning, constraints and IK, shape keys, keyframe animation, rigid body and cloth physics, particles and hair, Geometry Nodes (nodes.*), fast and path-traced rendering, glTF/FBX/USD (usda, usdc, usdz)/OBJ/STL import and export, and .blend import; rotations are in degrees and Z is up",
            queries: "`cube`, `extrude`, or `modifier`",
            command: "add.cube",
        },
    },
    // Edited in the page through its SDK; `kit-fig` serves the agent.
    KitDefinition {
        id: "kit.fig",
        name: "Fig",
        binary_env: "KITION_KIT_FIG_BINARY",
        extensions: &["kfig"],
        creates: &[("kfig", "fig")],
        base_name: "Untitled fig",
        embeds: false,
        exports: &[],
        agent: KitAgent {
            prefix: "fig",
            noun: "interface design",
            formats: ".kfig",
            reports: "its pages, layer count, selection, tool, and undo state",
            covers: "frames, shapes, text, auto layout, components, styles, variables, prototyping, and more",
            queries: "`rectangle`, `auto layout`, or `component`",
            command: "shape.rectangle",
        },
    },
];

/// Who is asking: a person in a kit tab or the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    User,
    Agent,
}

#[derive(Debug, thiserror::Error)]
pub enum KitError {
    #[error("`{0}` is not a known kit")]
    UnknownKit(String),
    #[error(
        "{name} is not installed. Set {binary_env} to the kit's headless executable and restart Kition."
    )]
    NotInstalled {
        name: &'static str,
        binary_env: &'static str,
    },
    #[error("open a workspace folder first")]
    NoWorkspace,
    #[error("{0}")]
    InvalidPath(String),
    #[error("{name} could not start: {detail}")]
    Launch { name: &'static str, detail: String },
    #[error("{name} stopped. Open the file again.")]
    Stopped { name: &'static str },
    #[error("{0}")]
    Unavailable(String),
    #[error("{message}")]
    Kit {
        reason: Option<ErrorReason>,
        message: String,
    },
    /// An object-model failure (`model.batch`, `model.describe`): the kit's `data.model`, whose
    /// `code` is a `BatchErrorCode` (`invalid-op`, `not-found`, `invalid-value`, `read-only`,
    /// `command-failed`) and `index` the operation that failed.
    #[error("{message}")]
    Model {
        code: String,
        index: Option<usize>,
        message: String,
    },
}

impl KitError {
    pub(crate) fn from_client(kit: &'static KitDefinition, error: ClientError) -> Self {
        match error {
            ClientError::Rpc(error) => {
                let detail = error
                    .data
                    .as_ref()
                    .and_then(|data| data.get("detail"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let message = match detail {
                    Some(detail) if !detail.is_empty() => format!("{}: {detail}", error.message),
                    _ => error.message.clone(),
                };
                Self::Kit {
                    reason: error.reason(),
                    message,
                }
            }
            ClientError::Closed | ClientError::Io(_) => Self::Stopped { name: kit.name },
            other => Self::Kit {
                reason: None,
                message: other.to_string(),
            },
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub extensions: Vec<&'static str>,
    /// Extensions this kit can create new documents in.
    pub creates: Vec<&'static str>,
    pub installed: bool,
    /// Whether kit tabs can show the kit's own editor here (desktop app on a supported OS).
    pub embeddable: bool,
    pub binary_env: &'static str,
}

/// A document open in a kit, as Kition shows it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentView {
    pub kit_id: &'static str,
    pub document_id: String,
    /// Workspace-relative, `/`-separated; `None` until the document is saved.
    pub path: Option<String>,
    pub title: String,
    pub format: String,
    pub read_only: bool,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Increments whenever the kit reports a change, so views know when to refresh.
    pub version: u64,
    pub summary: String,
    /// Kit-defined structure from `view.describe`, for example layers.
    pub details: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandView {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub group: String,
    /// JSON Schema for the command's params, as the kit's `commands.list` gives it.
    pub params: Value,
    pub mutates: bool,
    pub enabled: bool,
    pub menu: Vec<String>,
    pub shortcut: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteView {
    pub changed: bool,
    pub result: Option<Value>,
    pub document: DocumentView,
}

type Versions = Arc<Mutex<HashMap<String, u64>>>;

/// One kit process and its two connections.
pub(crate) struct RunningKit {
    pub(crate) process: tokio::sync::Mutex<KitProcess>,
    pub(crate) host: Arc<KitClient>,
    pub(crate) agent: Arc<KitClient>,
    versions: Versions,
    /// The kit's own window has keyboard focus (embedded surfaces).
    pub(crate) focused: Arc<AtomicBool>,
    /// Woken by focus notifications.
    pub(crate) focus_changed: Arc<tokio::sync::Notify>,
}

impl RunningKit {
    pub(crate) fn client(&self, caller: Caller) -> &KitClient {
        match caller {
            Caller::User => &self.host,
            Caller::Agent => &self.agent,
        }
    }

    fn version(&self, document_id: &str) -> u64 {
        self.versions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(document_id)
            .copied()
            .unwrap_or(0)
    }

    pub(crate) async fn stop(&self) {
        let _ = self.host.call::<methods::Shutdown>(&Empty {}).await;
        let mut process = self.process.lock().await;
        if process
            .wait_for_exit(kition_kit_protocol::launch::SHUTDOWN_TIMEOUT)
            .await
            .is_none()
        {
            process.kill().await;
        }
    }
}

/// Which kit process serves a document: the shared headless one or a tab's embedded one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Headless,
    Surface(u64),
}

/// Document ids from embedded surfaces carry their surface: `s<surface>::<kit document id>`.
pub(crate) fn split_document_id(id: &str) -> (Target, &str) {
    if let Some(rest) = id.strip_prefix('s')
        && let Some((surface, inner)) = rest.split_once("::")
        && let Ok(surface) = surface.parse()
    {
        return (Target::Surface(surface), inner);
    }
    (Target::Headless, id)
}

fn external_document_id(target: Target, inner: &str) -> String {
    match target {
        Target::Headless => inner.to_owned(),
        Target::Surface(surface) => format!("s{surface}::{inner}"),
    }
}

pub(crate) struct Inner {
    workspace: Option<PathBuf>,
    /// Known kits and their executables, when installed.
    kits: Vec<(&'static KitDefinition, Option<PathBuf>)>,
    running: tokio::sync::Mutex<HashMap<&'static str, Arc<RunningKit>>>,
    pub(crate) surfaces: tokio::sync::Mutex<HashMap<u64, Arc<SurfaceKit>>>,
    pub(crate) next_surface: AtomicU64,
    /// Kit editors open in the renderer, for the agent (`bridge.rs`).
    bridge: Arc<crate::bridge::Bridge>,
    /// Each kit's object model as `model.describe` last answered it (the kit's schema, which is
    /// the same for all its documents): the agent's `<prefix>_query` and `<prefix>_batch`
    /// argument schemas are generated from it.
    described: Mutex<HashMap<&'static str, Value>>,
    /// Whether an agent's draft of a file no editor has open lives headless (`drafts.rs`):
    /// `kition-kits-mcp` turns it on; Kition keeps drafts in the person's open editor.
    headless_drafts: AtomicBool,
    /// The headless kits' draft documents, by workspace path.
    pub(crate) draft_documents: tokio::sync::Mutex<HashMap<String, String>>,
    /// The file grants kits hold (`grants.rs`, KitFiles 1.0).
    grants: crate::grants::GrantStore,
    /// Every headless save of a workspace file, for whoever follows file edits (the host table
    /// client's triggers).
    saves: tokio::sync::broadcast::Sender<SavedFile>,
}

/// A headless document saved to its workspace file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedFile {
    pub kit_id: &'static str,
    /// Workspace-relative, `/`-separated.
    pub path: String,
    /// The headless document, still open after the save.
    pub document_id: String,
}

/// The kits of one workspace. Cheap to clone.
#[derive(Clone)]
pub struct KitManager {
    pub(crate) inner: Arc<Inner>,
}

impl KitManager {
    /// Kits for `workspace`, with executables from each kit's environment variable.
    pub fn from_env(workspace: Option<PathBuf>) -> Self {
        let kits = KITS
            .iter()
            .map(|kit| {
                let binary = std::env::var_os(kit.binary_env)
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from);
                (kit, binary)
            })
            .collect();
        Self::new(workspace, kits)
    }

    pub fn new(
        workspace: Option<PathBuf>,
        kits: Vec<(&'static KitDefinition, Option<PathBuf>)>,
    ) -> Self {
        let workspace = workspace.map(|dir| std::fs::canonicalize(&dir).unwrap_or(dir));
        Self {
            inner: Arc::new(Inner {
                grants: crate::grants::GrantStore::new(workspace.clone()),
                workspace,
                kits,
                running: tokio::sync::Mutex::new(HashMap::new()),
                surfaces: tokio::sync::Mutex::new(HashMap::new()),
                next_surface: AtomicU64::new(1),
                bridge: Arc::default(),
                described: Mutex::default(),
                headless_drafts: AtomicBool::new(false),
                draft_documents: tokio::sync::Mutex::default(),
                saves: tokio::sync::broadcast::channel(256).0,
            }),
        }
    }

    /// Keeps an agent's drafts of files no editor has open in the headless kits, stored in the
    /// workspace's `.kition/drafts/` (`drafts.rs`), instead of refusing them.
    #[must_use]
    pub fn with_headless_drafts(self) -> Self {
        self.inner.headless_drafts.store(true, Ordering::Relaxed);
        self
    }

    /// Whether drafts of files no editor has open live headless.
    pub fn headless_drafts(&self) -> bool {
        self.inner.headless_drafts.load(Ordering::Relaxed)
    }

    /// The workspace folder, if there is one.
    pub fn workspace_dir(&self) -> Option<&Path> {
        self.inner.workspace.as_deref()
    }

    /// The file grants kits hold in this workspace (KitFiles 1.0).
    pub fn grants(&self) -> &crate::grants::GrantStore {
        &self.inner.grants
    }

    /// `files/write` through a handle: stages the chunk, and the final one commits. A final
    /// chunk that replaces a file is refused while an editor has that file open with unsaved
    /// edits (FA14).
    pub async fn write_granted(
        &self,
        session: &str,
        principal: &str,
        handle: &str,
        chunk: crate::grants::WriteChunk<'_>,
    ) -> Result<Option<String>, crate::grants::FileError> {
        let grants = self.grants();
        let unsaved = match grants.replaces(session, principal, handle) {
            Some(path) if chunk.last => self
                .inner
                .bridge
                .find(&path)
                .await
                .is_some_and(|document| document.dirty),
            _ => false,
        };
        grants.write(session, principal, handle, chunk, unsaved)
    }

    /// A Kit Protocol request to the kit's headless executable that names no document (or names
    /// it in `params`): `model.open`, `model.export`, `model.save`.
    pub(crate) async fn headless_request(
        &self,
        caller: Caller,
        kit: &'static KitDefinition,
        method: &str,
        params: Value,
    ) -> Result<Value, KitError> {
        let running = self.instance(kit, Target::Headless).await?;
        running
            .client(caller)
            .request(method, params, None)
            .await
            .map_err(|error| KitError::from_client(kit, error))
    }

    /// The Kit AI bridge to the renderer's open kit editors.
    pub fn bridge(&self) -> &Arc<crate::bridge::Bridge> {
        &self.inner.bridge
    }

    pub fn statuses(&self) -> Vec<KitStatus> {
        let host = crate::host::current();
        self.inner
            .kits
            .iter()
            .map(|(kit, binary)| KitStatus {
                id: kit.id,
                name: kit.name,
                extensions: kit.extensions.to_vec(),
                creates: kit
                    .creates
                    .iter()
                    .map(|(extension, _)| *extension)
                    .collect(),
                installed: binary.as_deref().is_some_and(Path::is_file),
                embeddable: kit.embeds && host.known && crate::surfaces::SUPPORTED,
                binary_env: kit.binary_env,
            })
            .collect()
    }

    /// The kit's object model as `model.describe` last answered it, when one was asked for.
    pub fn described(&self, kit_id: &str) -> Option<Value> {
        self.inner
            .described
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .find(|(id, _)| **id == kit_id)
            .map(|(_, described)| described.clone())
    }

    /// Keeps what `model.describe` answered for `kit_id` (a live editor's or a headless kit's).
    pub fn remember_described(&self, kit_id: &str, described: &Value) {
        let Ok(kit) = self.definition(kit_id) else {
            return;
        };
        if described.get("types").is_some_and(Value::is_object) {
            self.inner
                .described
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(kit.id, described.clone());
        }
    }

    /// The definitions of the kits this manager knows.
    pub fn definitions(&self) -> impl Iterator<Item = &'static KitDefinition> + '_ {
        self.inner.kits.iter().map(|(kit, _)| *kit)
    }

    pub(crate) fn definition(&self, id: &str) -> Result<&'static KitDefinition, KitError> {
        self.inner
            .kits
            .iter()
            .map(|(kit, _)| *kit)
            .find(|kit| kit.id == id)
            .ok_or_else(|| KitError::UnknownKit(id.to_owned()))
    }

    /// The kit that opens a workspace path, by extension.
    pub fn kit_for_path(&self, path: &str) -> Option<&'static KitDefinition> {
        let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
        self.inner
            .kits
            .iter()
            .map(|(kit, _)| *kit)
            .find(|kit| kit.extensions.contains(&extension.as_str()))
    }

    fn workspace(&self) -> Result<&Path, KitError> {
        self.inner.workspace.as_deref().ok_or(KitError::NoWorkspace)
    }

    /// Starts the headless kit if it is not running and returns it.
    async fn running(&self, kit: &'static KitDefinition) -> Result<Arc<RunningKit>, KitError> {
        let mut running = self.inner.running.lock().await;
        if let Some(existing) = running.get(kit.id) {
            if !existing.host.is_closed() {
                return Ok(Arc::clone(existing));
            }
            running.remove(kit.id);
        }
        let started = Arc::new(self.launch(kit, Surface::Headless).await?);
        running.insert(kit.id, Arc::clone(&started));
        Ok(started)
    }

    pub(crate) async fn launch(
        &self,
        kit: &'static KitDefinition,
        surface: Surface,
    ) -> Result<RunningKit, KitError> {
        let workspace = self.workspace()?;
        let binary = self
            .inner
            .kits
            .iter()
            .find(|(known, _)| known.id == kit.id)
            .and_then(|(_, binary)| binary.as_ref())
            .filter(|path| path.is_file())
            .ok_or(KitError::NotInstalled {
                name: kit.name,
                binary_env: kit.binary_env,
            })?;
        let launch_error = |detail: String| KitError::Launch {
            name: kit.name,
            detail,
        };
        let process = KitProcess::launch(LaunchOptions::new(binary, surface))
            .await
            .map_err(|error| launch_error(error.to_string()))?;
        let root = url::Url::from_directory_path(workspace)
            .map(String::from)
            .map_err(|()| launch_error("the workspace path is not absolute".into()))?;
        let params = |role: Role| InitializeParams {
            protocol_version: PROTOCOL_VERSION,
            token: process.token().to_owned(),
            role,
            client: ClientInfo {
                name: "Kition".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            locale: (role == Role::Host).then(|| "en-US".to_owned()),
            appearance: (role == Role::Host).then_some(Appearance::Light),
            reserved_shortcuts: Vec::new(),
            workspace_roots: if role == Role::Host {
                vec![root.clone()]
            } else {
                Vec::new()
            },
        };
        let connect = |role: Role| {
            let params = params(role);
            let process = &process;
            async move {
                let client = process
                    .connect()
                    .await
                    .map_err(|error| format!("cannot connect: {error}"))?;
                let result = client
                    .initialize(&params)
                    .await
                    .map_err(|error| format!("kit.initialize failed: {error}"))?;
                if result.kit.id != kit.id {
                    return Err(format!(
                        "the executable is `{}`, not `{}`",
                        result.kit.id, kit.id
                    ));
                }
                Ok::<_, String>(Arc::new(client))
            }
        };
        let host = connect(Role::Host).await.map_err(launch_error)?;
        let agent = connect(Role::Agent).await.map_err(launch_error)?;
        let versions: Versions = Arc::default();
        let focused = Arc::new(AtomicBool::new(false));
        let focus_changed = Arc::new(tokio::sync::Notify::new());
        tokio::spawn(watch_notifications(
            Arc::clone(&host),
            Arc::clone(&versions),
            Arc::clone(&focused),
            Arc::clone(&focus_changed),
        ));
        // The agent connection receives the same notifications; drain them.
        let drained = Arc::clone(&agent);
        tokio::spawn(async move { while drained.next_notification().await.is_some() {} });
        tracing::info!(kit = kit.id, surface = surface.as_env(), pid = ?process.id(), "kit started");
        Ok(RunningKit {
            process: tokio::sync::Mutex::new(process),
            host,
            agent,
            versions,
            focused,
            focus_changed,
        })
    }

    async fn instance(
        &self,
        kit: &'static KitDefinition,
        target: Target,
    ) -> Result<Arc<RunningKit>, KitError> {
        match target {
            Target::Headless => self.running(kit).await,
            Target::Surface(id) => self
                .inner
                .surfaces
                .lock()
                .await
                .get(&id)
                .map(|surface| Arc::clone(&surface.running))
                .ok_or(KitError::Stopped { name: kit.name }),
        }
    }

    async fn call<M: RequestMethod>(
        &self,
        kit: &'static KitDefinition,
        target: Target,
        caller: Caller,
        params: &M::Params,
    ) -> Result<(Arc<RunningKit>, M::Result), KitError> {
        let running = self.instance(kit, target).await?;
        match running.client(caller).call::<M>(params).await {
            Ok(result) => Ok((running, result)),
            Err(error) => {
                let error = KitError::from_client(kit, error);
                if matches!(error, KitError::Stopped { .. }) {
                    match target {
                        Target::Headless => {
                            self.inner.running.lock().await.remove(kit.id);
                        }
                        Target::Surface(id) => {
                            self.inner.surfaces.lock().await.remove(&id);
                        }
                    }
                }
                Err(error)
            }
        }
    }

    pub(crate) fn file_uri(&self, path: &str) -> Result<String, KitError> {
        let absolute = self.resolve(path)?;
        if !absolute.is_file() {
            return Err(KitError::InvalidPath(format!("`{path}` does not exist")));
        }
        url::Url::from_file_path(&absolute)
            .map(String::from)
            .map_err(|()| KitError::InvalidPath(format!("`{path}` is not a local file")))
    }

    /// Opens a workspace file in the kit that handles its extension. The agent works on the
    /// editor a tab shows for the file, when there is one, so the person sees its edits live.
    pub async fn open(&self, caller: Caller, path: &str) -> Result<DocumentView, KitError> {
        let kit = self
            .kit_for_path(path)
            .ok_or_else(|| KitError::InvalidPath(format!("no kit opens `{path}`")))?;
        let target = match caller {
            Caller::Agent => self
                .surface_for_path(path)
                .await
                .map_or(Target::Headless, |surface| Target::Surface(surface.id)),
            Caller::User => Target::Headless,
        };
        let params = DocumentOpenParams {
            uri: self.file_uri(path)?,
            read_only: None,
            create: None,
        };
        let (running, state) = self
            .call::<methods::DocumentOpen>(kit, target, caller, &params)
            .await?;
        self.view(kit, target, &running, caller, state).await
    }

    /// Creates a new document in `folder` (workspace-relative, `""` for the root) with an
    /// unused name from the kit's base name (`Untitled photo`), saves it so it appears in the workspace,
    /// and opens it.
    pub async fn create(
        &self,
        caller: Caller,
        folder: &str,
        extension: &str,
        options: Map<String, Value>,
    ) -> Result<DocumentView, KitError> {
        let extension = extension.trim_start_matches('.').to_ascii_lowercase();
        let (kit, format) = self
            .inner
            .kits
            .iter()
            .find_map(|(kit, _)| {
                kit.creates
                    .iter()
                    .find(|(known, _)| *known == extension)
                    .map(|(_, format)| (*kit, *format))
            })
            .ok_or_else(|| KitError::InvalidPath(format!("no kit creates .{extension} files")))?;
        let directory = if folder.trim().trim_matches('/').is_empty() {
            self.workspace()?.to_path_buf()
        } else {
            self.resolve(folder)?
        };
        if !directory.is_dir() {
            return Err(KitError::InvalidPath(format!(
                "`{folder}` is not a workspace folder"
            )));
        }
        let base = kit.base_name;
        let target_path = (1..1000)
            .map(|n| {
                let name = if n == 1 {
                    format!("{base}.{extension}")
                } else {
                    format!("{base} {n}.{extension}")
                };
                directory.join(name)
            })
            .find(|path| !path.exists())
            .ok_or_else(|| {
                KitError::InvalidPath("too many untitled files in this folder".into())
            })?;
        let uri = url::Url::from_file_path(&target_path)
            .map(String::from)
            .map_err(|()| KitError::InvalidPath("the folder is not a local path".into()))?;
        let params = DocumentOpenParams {
            uri,
            read_only: None,
            create: Some(CreateDocument {
                format: format.to_owned(),
                options: Some(options),
            }),
        };
        let (_, state) = self
            .call::<methods::DocumentOpen>(kit, Target::Headless, caller, &params)
            .await?;
        let saved = DocumentRef {
            document_id: state.document_id.clone(),
        };
        let (running, _) = self
            .call::<methods::DocumentSave>(kit, Target::Headless, caller, &saved)
            .await?;
        let (_, state) = self
            .state(kit, Target::Headless, caller, &saved.document_id)
            .await?;
        self.view(kit, Target::Headless, &running, caller, state)
            .await
    }

    pub async fn document(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: &str,
    ) -> Result<DocumentView, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let (running, state) = self.state(kit, target, caller, inner).await?;
        self.view(kit, target, &running, caller, state).await
    }

    async fn state(
        &self,
        kit: &'static KitDefinition,
        target: Target,
        caller: Caller,
        document_id: &str,
    ) -> Result<(Arc<RunningKit>, DocumentState), KitError> {
        let (running, list) = self
            .call::<methods::DocumentList>(kit, target, caller, &Empty {})
            .await?;
        let state = list
            .documents
            .into_iter()
            .find(|document| document.document_id == document_id)
            .ok_or(KitError::Kit {
                reason: Some(ErrorReason::DocumentNotFound),
                message: "the document is not open".into(),
            })?;
        Ok((running, state))
    }

    pub(crate) async fn view(
        &self,
        kit: &'static KitDefinition,
        target: Target,
        running: &RunningKit,
        caller: Caller,
        state: DocumentState,
    ) -> Result<DocumentView, KitError> {
        let described = running
            .client(caller)
            .call::<methods::ViewDescribe>(&DocumentRef {
                document_id: state.document_id.clone(),
            })
            .await
            .map_err(|error| KitError::from_client(kit, error))?;
        Ok(DocumentView {
            kit_id: kit.id,
            version: running.version(&state.document_id),
            path: state.uri.as_deref().and_then(|uri| self.relative(uri)),
            document_id: external_document_id(target, &state.document_id),
            title: state.title,
            format: state.format,
            read_only: state.read_only,
            dirty: state.dirty,
            can_undo: state.can_undo,
            can_redo: state.can_redo,
            summary: described.summary,
            details: described.state,
        })
    }

    /// A PNG of the document, at most `max_size` pixels on its longer side. An embedded editor
    /// answers with its window.
    pub async fn preview(
        &self,
        kit_id: &str,
        document_id: &str,
        max_size: u32,
    ) -> Result<Vec<u8>, KitError> {
        use base64::Engine as _;
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let params = ViewScreenshotParams {
            document_id: inner.to_owned(),
            scope: ScreenshotScope::Canvas,
            max_size: Some(max_size.clamp(16, 4096)),
        };
        let (_, image) = self
            .call::<methods::ViewScreenshot>(kit, target, Caller::User, &params)
            .await?;
        base64::engine::general_purpose::STANDARD
            .decode(image.data)
            .map_err(|error| KitError::Kit {
                reason: None,
                message: format!("the kit sent an unreadable image: {error}"),
            })
    }

    /// Commands, optionally limited to those whose id, title, or description contains `query`.
    pub async fn commands(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: Option<&str>,
        query: Option<&str>,
    ) -> Result<Vec<CommandView>, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = document_id.map_or((Target::Headless, None), |id| {
            let (target, inner) = split_document_id(id);
            (target, Some(inner))
        });
        let params = CommandsListParams {
            document_id: inner.map(str::to_owned),
            groups: None,
        };
        let (_, list) = self
            .call::<methods::CommandsList>(kit, target, caller, &params)
            .await?;
        // Ranked, not all-words: each command scores the words of the query it contains (in its
        // id, title, description or menu, with a few synonyms and plurals); the best come first.
        // A query no command shares a word with still answers the closest commands, never none.
        let terms: Vec<Vec<String>> = query
            .unwrap_or_default()
            .split_whitespace()
            .map(|term| search_variants(&term.to_lowercase()))
            .collect();
        let fields: Vec<(String, String, String)> = list
            .commands
            .iter()
            .map(|command| {
                (
                    command.id.to_lowercase(),
                    command.title.to_lowercase(),
                    format!(
                        "{} {:?}",
                        command.description.as_deref().unwrap_or_default(),
                        command.menu
                    )
                    .to_lowercase(),
                )
            })
            .collect();
        let has = |(id, title, rest): &(String, String, String), v: &str| {
            id.contains(v) || title.contains(v) || rest.contains(v)
        };
        let n = fields.len() as f64;
        let weights: Vec<f64> = terms
            .iter()
            .map(|variants| {
                let df = fields
                    .iter()
                    .filter(|f| variants.iter().any(|v| has(f, v)))
                    .count() as f64;
                ((n + 1.0) / (df + 1.0)).ln() + 0.1
            })
            .collect();
        let mut scored: Vec<(f64, _)> = list
            .commands
            .into_iter()
            .zip(fields.iter())
            .map(|(command, (id, title, rest))| {
                let score: f64 = terms
                    .iter()
                    .zip(&weights)
                    .map(|(variants, weight)| {
                        let field = if variants.iter().any(|v| id.contains(v.as_str())) {
                            3.0
                        } else if variants.iter().any(|v| title.contains(v.as_str())) {
                            2.0
                        } else if variants.iter().any(|v| rest.contains(v.as_str())) {
                            1.0
                        } else if variants.iter().any(|v| {
                            v.len() >= 4 && (id.contains(&v[..4]) || title.contains(&v[..4]))
                        }) {
                            0.5
                        } else {
                            0.0
                        };
                        field * weight
                    })
                    .sum();
                (score, command)
            })
            .collect();
        if !terms.is_empty() && scored.iter().any(|(score, _)| *score > 0.0) {
            scored.retain(|(score, _)| *score > 0.0);
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        Ok(scored
            .into_iter()
            .map(|(_, command)| command)
            .map(|command| CommandView {
                id: command.id,
                title: command.title,
                description: command.description,
                group: command.group,
                params: command.params,
                mutates: command.mutates,
                enabled: command.enabled,
                menu: command.menu,
                shortcut: command.shortcut,
            })
            .collect())
    }

    pub async fn execute(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: &str,
        command: &str,
        params: Map<String, Value>,
    ) -> Result<ExecuteView, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let request = CommandsExecuteParams {
            document_id: inner.to_owned(),
            command: command.to_owned(),
            params,
            origin: match caller {
                Caller::User => Origin::User,
                Caller::Agent => Origin::Agent,
            },
        };
        let (_, executed) = self
            .call::<methods::CommandsExecute>(kit, target, caller, &request)
            .await?;
        let document = self.document(caller, kit_id, document_id).await?;
        Ok(ExecuteView {
            changed: executed.changed,
            result: executed.result,
            document,
        })
    }

    /// The kit's diagnostics on the document (Kit Standard 2.0 A21, `document.check`):
    /// `{ "diagnostics": [...] }`, or `None` when the running kit predates the method.
    pub async fn check(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: &str,
    ) -> Result<Option<Value>, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let running = self.instance(kit, target).await?;
        match running
            .client(caller)
            .request(
                "document.check",
                serde_json::json!({ "documentId": inner }),
                None,
            )
            .await
        {
            Ok(answer) => Ok(Some(answer)),
            Err(ClientError::Rpc(error)) if error.code == -32601 => Ok(None),
            Err(error) => Err(KitError::from_client(kit, error)),
        }
    }

    /// An object-model request of the Kit Protocol (`model.describe`, `model.batch`) on an open
    /// document; `params` gets the document's id. A refused batch is [`KitError::Model`]; a kit
    /// that serves no object model answers [`KitError::Kit`] with no reason (method not found).
    pub async fn model(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: &str,
        method: &str,
        mut params: Map<String, Value>,
    ) -> Result<Value, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        params.insert("documentId".into(), Value::String(inner.to_owned()));
        let running = self.instance(kit, target).await?;
        match running
            .client(caller)
            .request(method, Value::Object(params), None)
            .await
        {
            Ok(answer) => {
                if method == "model.describe" {
                    self.remember_described(kit.id, &answer);
                }
                Ok(answer)
            }
            Err(ClientError::Rpc(error))
                if error
                    .data
                    .as_ref()
                    .and_then(|data| data.get("model"))
                    .is_some_and(Value::is_object) =>
            {
                let model = &error
                    .data
                    .as_ref()
                    .map_or(Value::Null, |data| data["model"].clone());
                Err(KitError::Model {
                    code: model["code"].as_str().unwrap_or("invalid-op").to_owned(),
                    index: model["index"]
                        .as_u64()
                        .and_then(|index| usize::try_from(index).ok()),
                    message: model["message"]
                        .as_str()
                        .map_or_else(|| error.message.clone(), str::to_owned),
                })
            }
            Err(error) => {
                let error = KitError::from_client(kit, error);
                if matches!(error, KitError::Stopped { .. }) {
                    match target {
                        Target::Headless => {
                            self.inner.running.lock().await.remove(kit.id);
                        }
                        Target::Surface(id) => {
                            self.inner.surfaces.lock().await.remove(&id);
                        }
                    }
                }
                Err(error)
            }
        }
    }

    /// Closes the running headless kits' documents of the workspace file `path`, dropping their
    /// unsaved changes: the file changed under them.
    pub async fn close_file(&self, path: &str) {
        let running: Vec<Arc<RunningKit>> =
            self.inner.running.lock().await.values().cloned().collect();
        for kit in running {
            let Ok(list) = kit.host.call::<methods::DocumentList>(&Empty {}).await else {
                continue;
            };
            for document in list.documents {
                let here = document.uri.as_deref().and_then(|uri| self.relative(uri));
                if here.as_deref() == Some(path) {
                    let params = DocumentCloseParams {
                        document_id: document.document_id,
                        discard_changes: Some(true),
                    };
                    let _ = kit.host.call::<methods::DocumentClose>(&params).await;
                }
            }
        }
    }

    /// The workspace files open in the running headless kits, as `(kit id, path)`.
    pub async fn open_files(&self) -> Vec<(&'static str, String)> {
        let running: Vec<(&'static str, Arc<RunningKit>)> = self
            .inner
            .running
            .lock()
            .await
            .iter()
            .map(|(id, kit)| (*id, Arc::clone(kit)))
            .collect();
        let mut files = Vec::new();
        for (kit_id, kit) in running {
            let Ok(list) = kit.agent.call::<methods::DocumentList>(&Empty {}).await else {
                continue;
            };
            files.extend(
                list.documents
                    .iter()
                    .filter_map(|document| document.uri.as_deref())
                    .filter_map(|uri| self.relative(uri))
                    .map(|path| (kit_id, path)),
            );
        }
        files
    }

    pub async fn save(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: &str,
    ) -> Result<DocumentView, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let params = DocumentRef {
            document_id: inner.to_owned(),
        };
        self.call::<methods::DocumentSave>(kit, target, caller, &params)
            .await?;
        let view = self.document(caller, kit_id, document_id).await?;
        if let (Target::Headless, Some(path)) = (target, view.path.clone()) {
            let _ = self.inner.saves.send(SavedFile {
                kit_id: view.kit_id,
                path,
                document_id: document_id.to_owned(),
            });
        }
        Ok(view)
    }

    /// Hears every headless save of a workspace file from now on.
    pub fn subscribe_saves(&self) -> tokio::sync::broadcast::Receiver<SavedFile> {
        self.inner.saves.subscribe()
    }

    pub async fn close(
        &self,
        kit_id: &str,
        document_id: &str,
        discard_changes: bool,
    ) -> Result<(), KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let params = DocumentCloseParams {
            document_id: inner.to_owned(),
            discard_changes: Some(discard_changes),
        };
        self.call::<methods::DocumentClose>(kit, target, Caller::User, &params)
            .await?;
        Ok(())
    }

    /// Writes `bytes` to the workspace file `path`, crash-safely: the bytes go to a temporary file
    /// beside the target, which is then renamed over it. `write` says what the write may do: a
    /// save replaces only the document it names, which some kit edits; any other write makes a new
    /// file and never replaces one (the in-page editors' `host/write` modes, Kit UI protocol). So
    /// one kit's editor never overwrites another file, its own kind or another kit's.
    pub fn write_file(
        &self,
        path: &str,
        bytes: &[u8],
        write: FileWrite<'_>,
    ) -> Result<(), KitError> {
        let edited = self.kit_for_path(path).is_some();
        let target = self.resolve(path)?;
        match write {
            FileWrite::Save { document } => {
                if !edited {
                    return Err(KitError::InvalidPath(format!("no kit edits `{path}`")));
                }
                if self.resolve(document)? != target {
                    return Err(KitError::InvalidPath(format!(
                        "`{path}` is not `{document}`, the document this save is for"
                    )));
                }
            }
            FileWrite::New => {
                let extension = path
                    .rsplit_once('.')
                    .map(|(_, extension)| extension.to_ascii_lowercase())
                    .unwrap_or_default();
                let export = self
                    .inner
                    .kits
                    .iter()
                    .any(|(kit, _)| kit.exports.contains(&extension.as_str()));
                if !edited && !export {
                    return Err(KitError::InvalidPath(format!("no kit edits `{path}`")));
                }
                if target.exists() {
                    return Err(KitError::InvalidPath(format!(
                        "`{path}` exists; a new file never replaces one"
                    )));
                }
            }
        }
        let missing = || KitError::InvalidPath(format!("the folder of `{path}` does not exist"));
        let parent = target.parent().ok_or_else(missing)?;
        if !parent.is_dir() {
            // A new file may start a folder of its own (an image pasted into a note goes to the
            // note's attachments folder); a save writes over its document where it is.
            match write {
                FileWrite::New => self.make_folders(path, parent)?,
                FileWrite::Save { .. } => return Err(missing()),
            }
        }
        let name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let temporary = parent.join(format!(".{name}.kition-{}.tmp", std::process::id()));
        let written =
            std::fs::write(&temporary, bytes).and_then(|()| std::fs::rename(&temporary, &target));
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(KitError::Kit {
                reason: Some(ErrorReason::IoError),
                message: format!("could not save `{path}`: {}", error.kind()),
            });
        }
        Ok(())
    }

    /// Makes the missing folders of a new file at `path` (`folder`, inside the workspace): never
    /// through a link out of the workspace, and never a hidden folder.
    fn make_folders(&self, path: &str, folder: &Path) -> Result<(), KitError> {
        let workspace = self.workspace()?;
        let invalid = || KitError::InvalidPath(format!("`{path}` is not a workspace path"));
        let mut existing = folder;
        while !existing.exists() {
            existing = existing.parent().ok_or_else(invalid)?;
        }
        let real = std::fs::canonicalize(existing).map_err(|_| invalid())?;
        if !real.starts_with(workspace) || !real.is_dir() {
            return Err(invalid());
        }
        let made = folder.strip_prefix(existing).map_err(|_| invalid())?;
        if made
            .components()
            .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
        {
            return Err(invalid());
        }
        std::fs::create_dir_all(real.join(made)).map_err(|error| KitError::Kit {
            reason: Some(ErrorReason::IoError),
            message: format!("could not make the folder of `{path}`: {}", error.kind()),
        })
    }

    /// Asks every running kit, headless and embedded, to exit.
    pub async fn shutdown(&self) {
        let mut stopping: Vec<Arc<RunningKit>> = self
            .inner
            .running
            .lock()
            .await
            .drain()
            .map(|(_, kit)| kit)
            .collect();
        stopping.extend(
            self.inner
                .surfaces
                .lock()
                .await
                .drain()
                .map(|(_, surface)| Arc::clone(&surface.running)),
        );
        for kit in stopping {
            kit.stop().await;
        }
    }

    /// Resolves a workspace-relative path without letting it leave the workspace.
    pub(crate) fn resolve(&self, path: &str) -> Result<PathBuf, KitError> {
        let workspace = self.workspace()?;
        let invalid = || KitError::InvalidPath(format!("`{path}` is not a workspace path"));
        let trimmed = path.trim().trim_start_matches('/');
        if trimmed.is_empty() || trimmed.contains('\\') {
            return Err(invalid());
        }
        let mut absolute = workspace.to_path_buf();
        for part in trimmed.split('/') {
            if part.is_empty() || part == "." || part == ".." || Path::new(part).is_absolute() {
                return Err(invalid());
            }
            absolute.push(part);
        }
        match std::fs::canonicalize(&absolute) {
            Ok(real) if real.starts_with(workspace) => Ok(real),
            Ok(_) => Err(invalid()),
            Err(_) => Ok(absolute),
        }
    }

    fn relative(&self, uri: &str) -> Option<String> {
        let workspace = self.inner.workspace.as_deref()?;
        let path = url::Url::parse(uri).ok()?.to_file_path().ok()?;
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        let relative = path.strip_prefix(workspace).ok()?;
        let parts: Option<Vec<&str>> = relative
            .components()
            .map(|component| match component {
                Component::Normal(part) => part.to_str(),
                _ => None,
            })
            .collect();
        Some(parts?.join("/"))
    }
}

async fn watch_notifications(
    host: Arc<KitClient>,
    versions: Versions,
    focused: Arc<AtomicBool>,
    focus_changed: Arc<tokio::sync::Notify>,
) {
    while let Some(notification) = host.next_notification().await {
        match notification.method.as_str() {
            methods::DocumentDidChangeState::NAME => {
                let Some(id) = notification
                    .params
                    .as_ref()
                    .and_then(|params| params.get("documentId"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                *versions
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .entry(id.to_owned())
                    .or_default() += 1;
            }
            methods::SurfaceDidFocus::NAME | methods::SurfaceDidBlur::NAME => {
                focused.store(
                    notification.method == methods::SurfaceDidFocus::NAME,
                    Ordering::SeqCst,
                );
                focus_changed.notify_waiters();
            }
            _ => {}
        }
    }
    // The connection closed: wake surface watchers so they notice.
    focus_changed.notify_waiters();
}

/// A query word and the words it may be written as in a command (plural, synonyms).
fn search_variants(term: &str) -> Vec<String> {
    let mut out = vec![term.to_owned()];
    if term.len() > 3 && term.ends_with('s') {
        out.push(term[..term.len() - 1].to_owned());
    }
    let synonyms: &[(&str, &[&str])] = &[
        ("colour", &["color"]),
        ("color", &["colour", "fill"]),
        ("reorder", &["move", "order"]),
        ("remove", &["delete"]),
        ("erase", &["delete"]),
        ("copy", &["duplicate"]),
        ("enter", &["edit"]),
        ("change", &["set", "edit"]),
        ("modify", &["set", "edit"]),
        ("replace", &["set"]),
        ("values", &["data", "series"]),
        ("value", &["data", "series"]),
        ("resize", &["size", "bounds"]),
        ("position", &["move", "bounds"]),
        ("typeface", &["font"]),
        ("bigger", &["grow", "size"]),
    ];
    for (word, alts) in synonyms {
        if term == *word {
            out.extend(alts.iter().map(|a| (*a).to_owned()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_document_ids_round_trip() {
        assert_eq!(split_document_id("7"), (Target::Headless, "7"));
        assert_eq!(
            split_document_id("s3::art/cover.psd"),
            (Target::Surface(3), "art/cover.psd")
        );
        assert_eq!(
            external_document_id(Target::Surface(3), "art/cover.psd"),
            "s3::art/cover.psd"
        );
        assert_eq!(split_document_id("sx::a"), (Target::Headless, "sx::a"));
    }
}
