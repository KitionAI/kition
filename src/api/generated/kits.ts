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
 * PUT /v1/kits/files?path=&document=: writes the raw request body (application/octet-stream, up to 2 GiB) to a workspace file. With document, it saves the document an in-page editor opened: path must be that document, a file a kit edits, and only it is replaced. Without document, it makes a new file a kit edits or a kit export (for example an .mp4 from a video project) and never replaces an existing file. In-page editors save, export, and make new files through it.
 */
export type KitsWriteFileQuery = {
  path: KitsWorkspacePath
  /**
   * The document an in-page editor opened, when the write saves it; path must name the same file.
   */
  document?: KitsWorkspacePath
}

/**
 * A grant session: one kit editor page, bound to its kit, the person, and the document it opened. 128 random bits.
 */
export type KitsGrantSessionId = string

/**
 * A file handle (KitFiles FA1): opaque, 128 random bits, bound to one grant session. The runtime keeps the path it names; no answer carries a path.
 */
export type KitsFileHandle = string

/**
 * read: files/read and files/stat, and files/list on a folder. create: write a new file once (never replacing one), or files/create in a folder. write: replace an existing file with an expected version (FA2).
 */
export type KitsFileRight = "read" | "create" | "write"

export type KitsFileKind = "file" | "folder"

/**
 * How a handle was granted (KitFiles section 3): the person's pick or drop, files/create, an entry of a granted folder, or a file an agent's command names.
 */
export type KitsGrantFlow = "pick" | "drop" | "create" | "list" | "agent"

/**
 * data.reason of a refused /v1/kits/grants request (KitFiles section 10): 403 file-not-granted (unknown, expired, released, or foreign handle or session, or a right the handle lacks) and not-allowed (outside the workspace, a hidden path or a link out of it, an extension outside the kit's manifest, a write in a read-only session); 409 already-committed, conflict (a create that would replace a file, or a stale expected version), and unsaved-edits; 413 quota; 500 io-error. Malformed parameters are 400 with data.reason null.
 */
export type KitsFileErrorReason = "file-not-granted" | "not-allowed" | "already-committed" | "conflict" | "unsaved-edits" | "quota" | "io-error"

/**
 * The kit manifest's files lists (K15), extensions without the dot. A grant outside them is refused not-allowed; without them every grant is.
 */
export type KitsFilesManifest = {
  read?: string[]
  create?: string[]
  folders?: boolean
  print?: boolean
}

/**
 * POST /v1/kits/grants/sessions: opens a grant session for a kit's editor page. Its handles expire when it ends (DELETE /v1/kits/grants/sessions/{session}) or after twelve hours unused.
 */
export type KitsGrantSessionRequest = {
  kit: KitsKitId
  /**
   * The document the editor opened; files/create without a folder makes files beside it.
   */
  document?: KitsWorkspacePath
  files?: KitsFilesManifest
  /**
   * A read-only document: no write grants (FA17).
   */
  readOnly?: boolean
}

/**
 * The answer to POST /v1/kits/grants/sessions.
 */
export type KitsGrantSession = {
  session: KitsGrantSessionId
}

/**
 * A handle as the kit sees it (FA3): GET /v1/kits/grants/{handle}?session=, and the answer of POST /v1/kits/grants and /v1/kits/grants/create.
 */
export type KitsFileStat = {
  handle: KitsFileHandle
  /**
   * The last path segment only; untrusted text.
   */
  name: string
  kind: KitsFileKind
  size?: number
  mime?: string
  /**
   * The file's opaque version stamp; null for a created file not committed yet.
   */
  version: string | null
  rights: KitsFileRight[]
}

/**
 * POST /v1/kits/grants: grants a handle on a workspace file or folder the person picked or dropped. read and write need an existing file; create needs a new name in an existing folder and never replaces a file (conflict). A folder takes read, and create when the manifest lists create.
 */
export type KitsGrantRequest = {
  session: KitsGrantSessionId
  path: KitsWorkspacePath
  kind: KitsFileKind
  rights: KitsFileRight[]
  /**
   * For a folder: the extensions files/list answers, within the manifest's read list.
   */
  accept?: string[]
  flow: "pick" | "drop"
}

/**
 * POST /v1/kits/grants/create: files/create (FA7). A handle with right create on a new file beside the session's document, or in a folder handle with right create, under an unused name (Report 2.pdf when Report.pdf exists). Only the last segment of suggestedName counts, sanitised (FA15); its extension must be in the manifest's create list. The file appears when committed.
 */
export type KitsCreateFileRequest = {
  session: KitsGrantSessionId
  suggestedName: string
  mime?: string
  folder?: KitsFileHandle
}

/**
 * GET /v1/kits/grants/{handle}/list?session=: files/list on a folder handle with right read. Its visible files the grant accepts, not recursively, each a new handle with right read.
 */
export type KitsFileList = {
  files: KitsFileStat[]
}

/**
 * GET /v1/kits/grants/{handle}/content?session=&offset=&length=: files/read. The body is the bytes (application/octet-stream) from offset, at most length and at most 8 MiB; ETag is the file's version and Kition-File-Size the whole file's size, so the caller reads on.
 */
export type KitsReadFileQuery = {
  session: KitsGrantSessionId
  offset?: number
  length?: number
}

/**
 * PUT /v1/kits/grants/{handle}/content?session=&offset=&final=&expected=: files/write, one chunk (the raw request body, application/octet-stream, up to 64 MiB). offset must equal the bytes staged so far. Chunks are staged in a temporary file; final commits atomically. A create handle commits once and never replaces a file; a write handle commits only while the file's version is still expected, which the final chunk carries, and not while an editor has the file open with unsaved edits. A failed commit drops the staged bytes.
 */
export type KitsWriteChunkQuery = {
  session: KitsGrantSessionId
  offset: number
  final?: boolean
  expected?: string
}

/**
 * The answer to a files/write chunk: {} while staging, the committed file's version after the final chunk.
 */
export type KitsWriteChunkResult = {
  version?: string
}

/**
 * POST /v1/kits/grants/release: files/release. Unknown and expired handles are ignored; staged writes of released handles are dropped.
 */
export type KitsReleaseRequest = {
  session: KitsGrantSessionId
  handles: KitsFileHandle[]
}

/**
 * A handle as the person sees it (FA16).
 */
export type KitsGrantView = {
  handle: KitsFileHandle
  /**
   * The last path segment only; untrusted text.
   */
  name: string
  kind: KitsFileKind
  size?: number
  mime?: string
  /**
   * The file's opaque version stamp; null for a created file not committed yet.
   */
  version: string | null
  rights: KitsFileRight[]
  flow: KitsGrantFlow
}

/**
 * One entry of a session's grant log (KitFiles section 7): every grant, commit, release, and revocation, with the file's display name only.
 */
export type KitsGrantLogEntry = {
  /**
   * Milliseconds since the Unix epoch.
   */
  at: number
  event: "grant" | "commit" | "release" | "revoke"
  handle: KitsFileHandle
  flow: KitsGrantFlow
  kit: KitsKitId
  principal: string
  rights: KitsFileRight[]
  kind: KitsFileKind
  name: string
}

/**
 * GET /v1/kits/grants/sessions/{session}: what the session holds now and its grant log (FA16).
 */
export type KitsGrantSessionView = {
  session: KitsGrantSessionId
  kit: KitsKitId
  document: KitsWorkspacePath | null
  readOnly: boolean
  grants: KitsGrantView[]
  log: KitsGrantLogEntry[]
}

/**
 * The answer to DELETE /v1/kits/grants/sessions/{session}: the handles that expired with it.
 */
export type KitsGrantSessionEnd = {
  revoked: KitsFileHandle[]
}

/**
 * replica: the draft is a KDM replica the kit compares object by object; file: a copy of the file, compared by summaries and renders.
 */
export type KitsDraftMode = "replica" | "file"

/**
 * A draft an agent keeps beside a workspace file over kition-kits-mcp --drafts (KHP A27), as GET /v1/kits/drafts lists it. Only the person merges or discards it (A14).
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
 * The object-level difference (KHP A13) between the file as the draft forked from it and the draft.
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
 * POST /v1/kits/documents/new: creates an untitled file (`Untitled photo`, the kit's base name) in the folder and opens it.
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
 * kit/call: one of the kit's document tools on the live document. `commands` takes {query}; `run` takes {steps: [{command, params?}], save, draft?}; `inspect` takes {draft?}. With `draft: true` they work on the agent's draft of the document (KHP A12); `draft_ready` and `draft_reopen` take {} and answer the draft's {state, revision}. `describe` takes {draft?} and answers the kit's model/describe; `batch` takes {origin, ops, load, save?, draft?} and answers the model/batch {refs, results, loaded} with `saved` (Kit UI protocol section 7a; the agent's `<prefix>_query` and `<prefix>_batch`). `check` takes {draft?} and answers the kit's {diagnostics: [{code, severity, target, message, fix?}]} (KHP A21; the agent's `<prefix>_check`), refused with `data.code` `unsupported` by an editor whose kit cannot check. A refusal's JSON-RPC error carries `data` ({code, index, message} for the object model). Merging and discarding a draft are the person's, never a bridge call.
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
 * GET /v1/kits, POST /v1/kits/documents, and /v1/kits/{kitId}/documents/{documentId}[/commands|/save|/preview]. JSON answers use the runtime envelope; /v1/kits/drafts[/compare|/merge|/discard] review the drafts an agent keeps beside files over kition-kits-mcp --drafts; /preview answers image/png. Errors carry data.reason: not_installed, stopped, or a Kit Protocol reason such as document_not_found. /v1/kits/grants serves file grants to in-page kit editors (Kition platform KitFiles 1.0): sessions, handles, reads, staged writes, and releases; their refusals carry a KitFiles reason (fileErrorReason).
 */
export type KitsContract = KitsKitList
