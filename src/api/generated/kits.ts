/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/kits.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type KitsKitId = string

export type KitsWorkspacePath = string

export type KitsKitStatus = {
  id: KitsKitId
  name: string
  extensions: string[]
  /**
   * Extensions the kit can create new documents in.
   */
  creates: string[]
  installed: boolean
  /**
   * Kit tabs can show the kit's own editor here: the desktop app on a supported system.
   */
  embeddable: boolean
  /**
   * Environment variable that points at a local build of the kit executable.
   */
  binaryEnv: string
}

export type KitsKitList = {
  kits: KitsKitStatus[]
}

export type KitsOpenRequest = {
  path: KitsWorkspacePath
}

/**
 * Logical pixels relative to the top-left of the window's web content.
 */
export type KitsSurfaceRect = {
  x: number
  y: number
  width: number
  height: number
}

/**
 * POST /v1/kits/surfaces: opens the file in the kit's own editor, kept over `rect`.
 */
export type KitsOpenSurfaceRequest = {
  path: KitsWorkspacePath
  rect: KitsSurfaceRect
  /**
   * @default true
   */
  visible?: boolean
}

export type KitsSurfaceView = {
  surfaceId: number
  document: KitsDocumentView
}

/**
 * PUT /v1/kits/surfaces/{surfaceId}. DELETE on the same path closes the editor.
 */
export type KitsUpdateSurfaceRequest = {
  rect?: KitsSurfaceRect
  visible?: boolean
}

export type KitsCommandView = {
  id: string
  title: string
  description: string | null
  group: string
  mutates: boolean
  enabled: boolean
  /**
   * Menu path in the kit, for example ["Layer", "New"]; empty when the command is not in a menu.
   */
  menu: string[]
  shortcut: string | null
}

/**
 * GET /v1/kits/{kitId}/documents/{documentId}/commands[?query=]
 */
export type KitsCommandList = {
  commands: KitsCommandView[]
}

/**
 * PUT /v1/kits/files?path=: replaces a workspace file a kit edits with the raw request body (application/octet-stream, up to 2 GiB), or writes a kit export (for example an .mp4 from a video project) as a new file; an export never replaces an existing file. In-page editors save and export through it.
 */
export type KitsWriteFileQuery = {
  path: KitsWorkspacePath
}

/**
 * replica: the draft is a KDM replica the kit compares object by object; file: a copy of the file, compared by summaries and renders.
 */
export type KitsDraftMode = "replica" | "file"

/**
 * A draft an agent keeps beside a workspace file over kition-kits-mcp --drafts (Kit Standard A27), as GET /v1/kits/drafts lists it. Only the person merges or discards it (A14).
 */
export type KitsHeadlessDraft = {
  version: 1
  path: KitsWorkspacePath
  kit: KitsKitId
  mode: KitsDraftMode
  /**
   * ready: the agent asked for review.
   */
  state: "open" | "ready"
  /**
   * The file's SHA-256 when the draft forked from it.
   */
  baseSha256: string
  /**
   * Unix milliseconds.
   */
  created: number
  /**
   * Unix milliseconds.
   */
  updated: number
  /**
   * The file changed since the draft forked: merging would drop those edits.
   */
  stale: boolean
}

/**
 * GET /v1/kits/drafts: the workspace's headless drafts, oldest first.
 */
export type KitsDraftList = {
  drafts: KitsHeadlessDraft[]
}

/**
 * GET /v1/kits/drafts/compare?path=&previews=: what merging the draft of path would change. 404 reason not-found when there is none.
 */
export type KitsDraftCompareQuery = {
  path: KitsWorkspacePath
  /**
   * Also render both sides (base64 PNG).
   */
  previews?: boolean
}

export type KitsDraftObjectChange = {
  id: string
  type: string
  fields: string[]
}

export type KitsDraftTextChange = {
  id: string
  field: string
  before: string
  after: string
}

/**
 * The object-level difference (Kit Standard A13) between the file as the draft forked from it and the draft.
 */
export type KitsDraftDiff = {
  created: KitsDraftObjectChange[]
  changed: KitsDraftObjectChange[]
  deleted: KitsDraftObjectChange[]
  texts: KitsDraftTextChange[]
}

export type KitsDraftSides = {
  base?: string
  draft?: string
}

/**
 * The comparison a person reviews before merging: diff for replica drafts whose kit describes its schema (null otherwise, with diffUnavailable), each side's summary, and with previews both sides rendered.
 */
export type KitsDraftComparison = {
  path: KitsWorkspacePath
  kit: KitsKitId
  mode: KitsDraftMode
  state: "open" | "ready"
  stale: boolean
  diff: KitsDraftDiff | null
  /**
   * Why there is no object-level diff.
   */
  diffUnavailable?: string
  summary: KitsDraftSides
  /**
   * base64 PNG renders of each side.
   */
  previews?: (KitsDraftSides)
}

/**
 * POST /v1/kits/drafts/merge: writes the draft as the file. 409 reason stale when the file changed since the draft forked, unless overwrite; 404 reason not-found when there is no draft.
 */
export type KitsDraftMergeRequest = {
  path: KitsWorkspacePath
  /**
   * Replace the file anyway, dropping its newer edits.
   */
  overwrite?: boolean
}

export type KitsDraftMergeResult = {
  path: KitsWorkspacePath
  merged: true
  sha256: string
}

/**
 * POST /v1/kits/drafts/discard: drops the draft; the file stays as it is. 404 reason not-found when there is none.
 */
export type KitsDraftDiscardRequest = {
  path: KitsWorkspacePath
}

export type KitsDraftDiscardResult = {
  path: KitsWorkspacePath
  discarded: true
}

/**
 * POST /v1/kits/documents/new: creates an `Untitled <kit>` file (`Untitled Photo`) in the folder and opens it.
 */
export type KitsCreateRequest = {
  /**
   * Workspace-relative folder; empty for the workspace root.
   */
  folder?: string
  /**
   * @default "psd"
   */
  extension?: string
  /**
   * @default 1920
   */
  width?: number
  /**
   * @default 1080
   */
  height?: number
}

export type KitsDocumentView = {
  kitId: KitsKitId
  documentId: string
  /**
   * Workspace-relative path; null until the document is saved.
   */
  path: KitsWorkspacePath | null
  title: string
  format: string
  readOnly: boolean
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  /**
   * Increments whenever the kit reports a change, including agent edits.
   */
  version: number
  summary: string
  /**
   * Kit-defined structure from view.describe. kit.photo reports width, height, mode, depth, and layers.
   */
  details: Record<string, unknown>
}

export type KitsPhotoLayer = {
  id?: number
  name: string
  kind: string
  visible: boolean
  opacity?: number | null
  blend?: string | null
  selected?: boolean
  /**
   * Nesting inside groups; 0 at the top level.
   */
  depth?: number
}

/**
 * RGBA, each 0 to 1.
 */
export type KitsPhotoColor = number[]

export type KitsPhotoDetails = {
  width: number
  height: number
  mode: string
  depth: number
  layers: KitsPhotoLayer[]
  activeLayer?: number | null
  /**
   * The embedded editor's active tool, for example Brush.
   */
  tool?: string | null
  brushSize?: number | null
  /**
   * 1 is 100%.
   */
  zoom?: number | null
  foreground?: KitsPhotoColor | null
  background?: KitsPhotoColor | null
}

export type KitsExecuteRequest = {
  command: string
  params?: Record<string, unknown>
}

export type KitsExecuteResult = {
  changed: boolean
  result: unknown
  document: KitsDocumentView
}

/**
 * A document open in a kit editor in the renderer (Kit AI bridge, kit/documents).
 */
export type KitsBridgeDocument = {
  path: KitsWorkspacePath
  kit: KitsKitId
  dirty: boolean
  revision: number
}

export type KitsBridgeDocumentsResult = {
  documents: KitsBridgeDocument[]
}

/**
 * kit/call: one of the kit's document tools on the live document. `commands` takes {query}; `run` takes {steps: [{command, params?}], save, draft?}; `inspect` takes {draft?}. With `draft: true` they work on the agent's draft of the document (Kit Standard 2.0 A12); `draft_ready` and `draft_reopen` take {} and answer the draft's {state, revision}. `describe` takes {draft?} and answers the kit's model/describe; `batch` takes {origin, ops, load, save?, draft?} and answers the model/batch {refs, results, loaded} with `saved` (Kit UI protocol section 7a; the agent's `<prefix>_query` and `<prefix>_batch`). `check` takes {draft?} and answers the kit's {diagnostics: [{code, severity, target, message, fix?}]} (Kit Standard 2.0 A21; the agent's `<prefix>_check`), refused with `data.code` `unsupported` by an editor whose kit cannot check. A refusal's JSON-RPC error carries `data` ({code, index, message} for the object model). Merging and discarding a draft are the person's, never a bridge call.
 */
export type KitsBridgeCallParams = {
  path: KitsWorkspacePath
  kit: KitsKitId
  tool: "inspect" | "commands" | "run" | "draft_ready" | "draft_reopen" | "describe" | "batch" | "check"
  arguments: Record<string, unknown>
}

export type KitsBridgeLiveDocument = {
  path: KitsWorkspacePath
  summary: string
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  /**
   * The kit engine's inspect() JSON.
   */
  details: Record<string, unknown>
  draft?: KitsBridgeDraftInfo
}

/**
 * The agent's draft of a kit document (Kit UI protocol section 7d): `open` while the agent works on it, `ready` once it asks for review.
 */
export type KitsBridgeDraftInfo = {
  state: "none" | "open" | "ready"
  revision: number | null
}

export type KitsBridgeInspectResult = {
  document: KitsBridgeLiveDocument
}

export type KitsBridgeCommand = {
  id: string
  title: string
  description: string | null
  enabled: boolean
  mutates: boolean
}

export type KitsBridgeCommandsResult = {
  commands: KitsBridgeCommand[]
  total: number
}

export type KitsBridgeRunStep = {
  command: string
  changed: boolean
  /**
   * The command's JSON result.
   */
  result: unknown
}

export type KitsBridgeRunResult = {
  completed: KitsBridgeRunStep[]
  saved: boolean
  document: KitsBridgeLiveDocument
}

export type KitsBridgePreviewParams = {
  path: KitsWorkspacePath
  maxSize: number
  /**
   * Preview the agent's draft of the document instead.
   */
  draft?: boolean
}

export type KitsBridgePreviewResult = {
  /**
   * The preview as base64 PNG.
   */
  png: string
}

/**
 * kit.changed: a live document changed.
 */
export type KitsBridgeChanged = {
  path: KitsWorkspacePath
  revision: number
  by: "person" | "agent"
}

/**
 * documents.open (renderer to runtime, notification): every Markdown document open in this window's document sessions, the whole list each time it changes and after bridge.ready.
 */
export type KitsBridgeDocumentsOpen = {
  paths: KitsWorkspacePath[]
}

/**
 * document/read: the live text of an open document, unsaved edits included.
 */
export type KitsBridgeDocumentReadParams = {
  path: KitsWorkspacePath
}

export type KitsBridgeDocumentReadResult = {
  open: true
  content: string
} | {
  open: false
}

/**
 * document/apply: the agent's edit to an open document. The session applies and saves it, then answers; a window that does not answer in time (10 s) leaves the runtime to write the file.
 */
export type KitsBridgeDocumentApplyParams = {
  path: KitsWorkspacePath
  /**
   * The document's whole new text; the session applies the difference as the agent's edit.
   */
  content: string
  /**
   * The agent tool that made the edit, such as document_write or apply_patch.
   */
  tool: string
  /**
   * The agent turn the edit belongs to, when known.
   */
  turnId?: string
}

export type KitsBridgeDocumentApplyResult = {
  applied: true
  /**
   * The file content after the session saved.
   */
  content: string
} | {
  applied: false
  /**
   * Why the window did not apply it, such as not-open.
   */
  reason: string
}

/**
 * GET /v1/kits, POST /v1/kits/documents, and /v1/kits/{kitId}/documents/{documentId}[/commands|/save|/preview]. JSON answers use the runtime envelope; /v1/kits/drafts[/compare|/merge|/discard] review the drafts an agent keeps beside files over kition-kits-mcp --drafts; /preview answers image/png. Errors carry data.reason: not_installed, stopped, or a Kit Protocol reason such as document_not_found.
 */
export type KitsContract = KitsKitList
