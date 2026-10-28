// Copied from kition-sdk packages/kit-protocol/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The Kit UI protocol, `kition-kit-ui/1` (Kit Harness Protocol (KHP) spec/reference/ui-protocol.md): its messages, and JSON-RPC 2.0
 * over a MessagePort for both sides. A host and an embedded kit UI each make one `KitPeer` on
 * their end of the channel. Framework-free; no dependencies.
 */

export const KIT_UI_PROTOCOL = 'kition-kit-ui/1'

/**
 * The window messages that connect a host and a kit (`kitionKitUi: 1`, protocol section 2): the
 * kit announces each document it loads (`ready`, with an id of its own), the host asks a kit that
 * may have announced before it listened (`hello`), and answers a `ready` with the handshake that
 * hands the kit its port.
 */
export type KitUiHandshake = { kitionKitUi: 1; protocol: string; id?: string }
export type KitUiReady = { kitionKitUi: 1; ready: string; id: string }
export type KitUiHello = { kitionKitUi: 1; hello: string }

const kitUiMessage = (data: unknown): data is Record<string, unknown> => typeof data === 'object' && data !== null && (data as { kitionKitUi?: unknown }).kitionKitUi === 1

export function isHandshake(data: unknown): data is KitUiHandshake {
  return kitUiMessage(data) && typeof data.protocol === 'string'
}

export function isReady(data: unknown): data is KitUiReady {
  return kitUiMessage(data) && typeof data.ready === 'string' && typeof data.id === 'string'
}

export function isHello(data: unknown): data is KitUiHello {
  return kitUiMessage(data) && typeof data.hello === 'string'
}

/**
 * CSS custom properties the kit applies to its root (protocol section 4). `brand` (section 9):
 * `kit` (the default) lets a kit with a brand color use it for its primary tokens; `host` keeps
 * the host's.
 */
export type KitTheme = { colorScheme: 'light' | 'dark'; tokens: Record<string, string>; brand?: 'kit' | 'host' }

/** A button the host adds to the kit's editor (protocol section 9). */
export type KitUiHostButton = {
  /** The host's own name for it; `ui/action` reports it. */
  id: string
  /** `menu:<path>` (end of that menu), `group:<tab>/<group>` (end of that ribbon group), or `action`. */
  place: string
  /** The label per locale; `en-US` is the fallback. */
  label: Record<string, string>
  /** A `@kition/kit-editor` icon name, or a `data:image/…` URL. */
  icon?: string
  /** As `Cmd+Enter`. */
  shortcut?: string
  disabled?: boolean
  pressed?: boolean
}

/**
 * The editor's display modes (section 9): `menus` (tabs open as drop-down menus, no command
 * area), `line` (one row of the selected tab's main commands), `classic` (the full ribbon), and
 * `focus` (no chrome but a small floating bar).
 */
export type KitDisplayMode = 'menus' | 'line' | 'classic' | 'focus'

/** What the host hides, disables, and adds, and what the person hid (protocol section 9). */
export type KitUiConfig = {
  hide?: string[]
  disable?: string[]
  add?: KitUiHostButton[]
  personal?: { hide?: string[] }
  /** The display modes the person may choose (absent or empty: all) and the one the editor opens in. */
  modes?: { allowed?: KitDisplayMode[]; default?: KitDisplayMode }
}

/** One element of a kit's editor, as `ui/elements` lists it. */
export type KitUiElement = { id: string; kind: string; label: string; parent: string | null; hidden: boolean; disabled: boolean }

/** `KitDocumentInit.comments`: who comments in this session, and how. */
export type KitCommentAccess = { me: string | null; name?: string; canComment: boolean; othersReadOnly: boolean }

/**
 * Where in a document (minor version 2.1, `KitLinks 1.0` section 2): a diagnostic target's shape
 * (`objectId`, `path`, `page`, `slide`, `sheet`, `cell`) plus `time`, `heading`, and `blockId`, as
 * the document's kit understands them. A kit that cannot show it ignores it.
 */
export type KitView = {
  objectId?: string
  path?: string
  page?: number
  slide?: number
  sheet?: string
  cell?: string
  time?: number
  heading?: string[]
  blockId?: string
}

/** A `view` checked: an object with only the known members, each of its type; `null` otherwise or when empty. */
export function parseKitView(value: unknown): KitView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const view: KitView = {}
  for (const key of ['objectId', 'path', 'sheet', 'cell', 'blockId'] as const) {
    if (typeof raw[key] === 'string' && raw[key]) view[key] = raw[key] as string
  }
  for (const key of ['page', 'slide'] as const) {
    if (Number.isInteger(raw[key]) && (raw[key] as number) >= 1) view[key] = raw[key] as number
  }
  if (typeof raw.time === 'number' && Number.isFinite(raw.time) && raw.time >= 0) view.time = raw.time
  if (Array.isArray(raw.heading) && raw.heading.length && raw.heading.every((part) => typeof part === 'string')) view.heading = [...raw.heading]
  return Object.keys(view).length ? view : null
}

export type KitDocumentInit = {
  path: string
  name: string
  /** The file as it is now; absent when `create` asks for a new document. */
  bytes?: ArrayBuffer
  version?: string | null
  /**
   * The document is read-only for this session (a viewer): the kit refuses edits on every path
   * with `error.data.reason` `read-only` and offers no Save. It is fixed for the session; a host
   * that changes it opens the kit again (a new page).
   */
  readOnly?: boolean
  /**
   * Who comments and how (minor version 1.6; KHP 2.0 rule M23): the person's principal
   * id (`null` when unknown) and display name, whether they may write comments (a commenter's
   * document is `readOnly` for its content yet takes comments), and whether threads others opened
   * are read-only history (the document is not co-edited now).
   */
  comments?: KitCommentAccess
  create?: { width: number; height: number }
  /**
   * Lent files (standard E5): a same-origin URL of the workspace root that serves ranged reads,
   * and the document's folder in it, for the engine's synchronous reads of linked files.
   */
  lend?: { root: string; folder: string }
  /**
   * Where in the document to show first (minor version 2.1, section 2): the host opened it from a
   * link or its own navigation (`host/open`, OP3). A kit that can show it scrolls to it and
   * selects it; otherwise it ignores it.
   */
  view?: KitView
}

export type InitializeParams = {
  protocol: string
  host: { name: string; version: string }
  document: KitDocumentInit
  theme: KitTheme
  locale: string
  /** The host's own shortcuts, as `Cmd+N`; the kit forwards them (`host/shortcut`). */
  shortcuts: string[]
  /** Optional host methods this host serves: `agent`, `pick-file`, `replica`, `customize`, `lease`, `presence`, `files`, `files-pick`, `print`, `generate`, `action:<id>`, `open-file`, `open-url`, `links-pick`. */
  capabilities: string[]
  /**
   * The capability sets this host serves (KHP `spec/index.md` section 3.1, minor version 1.5), such as
   * `KitModel 1.0` or `KitCollab 1.0`; absent from older hosts.
   */
  capabilitySets?: string[]
  /** The UI configuration (section 9); absent means none. */
  ui?: KitUiConfig
}

export type InitializeResult = { kit: { id: string; version: string }; capabilities: string[] }

export type DocumentState = { dirty: boolean; revision: number; title: string }

export type WriteMode = 'save' | 'export' | 'create'

/**
 * A document's replica as the host stores it (capability `replica`, protocol section 7): the KDM
 * snapshot, the blobs it references, and the stamp of the file it was saved with.
 */
export type StoredReplica = { snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string }

/** Kit AI bridge records (standard A7 to A10), as Kition's runtime defines them. */
export type AiStep = { command: string; params?: Record<string, unknown> }
export type AiRunResult = { completed: Array<{ command: string; changed: boolean; result: unknown }>; saved: boolean }

/**
 * The object model's requests (capability `model`, section 7a; `KitObjectModel 1.0`). `schema` is
 * the kit's KDM schema as the host knows it (`model/schema.json`): a kit whose engine does not
 * describe its own schema runs the batch with it. A refused batch answers an error whose `data`
 * is `ModelErrorData`.
 */
/** `draft: true` runs the batch on the agent's draft (capability `draft-model`, section 7d). */
export type ModelBatchParams = { origin?: unknown; ops?: Array<Record<string, unknown>>; load?: Array<Record<string, unknown>>; schema?: object; draft?: boolean }
/** `version` is the kit's replica version after the batch, when it has one. */
export type ModelBatchResult = { refs: Record<string, string>; results: unknown[]; loaded: Array<{ id: string; type: string; fields: Record<string, unknown> }>; version?: ArrayBuffer | null }
export type ModelErrorData = { code: 'invalid-op' | 'not-found' | 'invalid-value' | 'read-only' | 'command-failed'; index: number | null; message: string }

/**
 * A lease on one scope of a co-edited document (capability `lease`, section 7b): who holds it,
 * and whether that is this session (`self`).
 */
export type KitLease = { scope: string; holder: { principalId: string; name: string; self: boolean } }

/** `error.data.reason` of a refused `host/leaseAcquire`: another session holds the scope (its lease in `data.lease`). */
export const LEASE_HELD_REASON = 'held'

/**
 * Where a person's caret is (capability `presence`, section 7e): a text field of a KDM object, and
 * the offset in it, counted in Unicode scalar values as the object model counts text positions.
 */
export type KitPresenceCaret = { object: string; field: string; offset: number }

/**
 * What this session shares with the other people in its document (`presence/set`, section 7e):
 * the KDM ids of the objects it has selected, its caret, and what it looks at (`viewport`, the
 * kit's own shape: a page, a slide, a rectangle). A viewer shares it too: where they look, never
 * an edit.
 */
export type KitPresence = { selection: string[]; caret?: KitPresenceCaret | null; viewport?: Record<string, unknown> | null }

/** Another person in the document (`presence/peers`, section 7e): who, in which color, and what they share. */
export type KitPeerPresence = { principal: string; name: string; color: string } & KitPresence

/** At most this many selected ids travel in one presence (section 7e); the rest are left out. */
export const PRESENCE_SELECTION_LIMIT = 256

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseCaret(value: unknown): KitPresenceCaret | null {
  if (!isRecord(value)) return null
  const { object, field, offset } = value
  return typeof object === 'string' && typeof field === 'string' && typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? { object, field, offset } : null
}

/**
 * A presence as the other side sent it, checked (neither side trusts the other's shapes): the
 * selection's string ids (at most `PRESENCE_SELECTION_LIMIT`), a well-formed caret, and an object
 * viewport. Anything else is left out; a value that is no object is no presence (`null`).
 */
export function parsePresence(value: unknown): KitPresence | null {
  if (!isRecord(value)) return null
  const selection = Array.isArray(value.selection) ? value.selection.filter((id): id is string => typeof id === 'string').slice(0, PRESENCE_SELECTION_LIMIT) : []
  const caret = parseCaret(value.caret)
  const viewport = isRecord(value.viewport) ? value.viewport : null
  return { selection, ...(caret ? { caret } : {}), ...(viewport ? { viewport } : {}) }
}

/** `presence/peers`' list, checked as `parsePresence` does; peers with no principal or name are left out. */
export function parsePeers(value: unknown): KitPeerPresence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((peer) => {
    const presence = parsePresence(peer)
    if (!presence || !isRecord(peer) || typeof peer.principal !== 'string' || typeof peer.name !== 'string') return []
    return [{ principal: peer.principal, name: peer.name, color: typeof peer.color === 'string' ? peer.color : '', ...presence }]
  })
}

/**
 * A conflict object the kit's repair pass recorded (section 7c, standard 2.0 M22): a merge it
 * could not resolve by itself, kept in the document until someone resolves it.
 */
export type KitConflict = { id: string; kind: string; summary: string }

/**
 * The schema versions of the kit's document (section 7f, minor version 1.8; standard 2.0 rule
 * M5a): `reads` is the schema version the kit's replica reads, `newestAuthor` the newest one its
 * changes were written under, which is above `reads` when a newer kit edited the document.
 */
export type KitSchemaReport = { reads: number; newestAuthor: number }

/** A `document/schema` report, checked: both are whole numbers and a newer kit edited the document; else `null`. */
export function parseSchemaReport(value: unknown): KitSchemaReport | null {
  if (!value || typeof value !== 'object') return null
  const { reads, newestAuthor } = value as { reads?: unknown; newestAuthor?: unknown }
  if (!Number.isSafeInteger(reads) || !Number.isSafeInteger(newestAuthor)) return null
  if ((newestAuthor as number) <= (reads as number) || (reads as number) < 0) return null
  return { reads: reads as number, newestAuthor: newestAuthor as number }
}

/**
 * An agent's draft of the document (capability `draft`, section 7d; standard 2.0 A12 to A15): a
 * fork of the document's replica the agent edits instead of the live document. `open` while the
 * agent works on it, `ready` once it asks for review; `none` when there is no draft.
 */
export type DraftState = 'none' | 'open' | 'ready'
export type DraftInfo = { state: DraftState; revision: number | null }
/** One object a draft created, changed (`fields`: the differing ones), or deleted. */
export type DraftObjectChange = { id: string; type: string; fields: string[] }
/** The object-level comparison of a draft with the live document (standard 2.0 A13). */
export type DraftSummary = {
  created: DraftObjectChange[]
  changed: DraftObjectChange[]
  deleted: DraftObjectChange[]
  texts: Array<{ id: string; field: string; before: string; after: string }>
}
/** `draft/compare`: the summary, and both sides rendered by the kit's engine (base64 PNGs; null when the engine cannot render). */
export type DraftComparison = { summary: DraftSummary; before: string | null; after: string | null }
/** Who a merge is recorded as: the agent, on behalf of the person who started it. */
export type DraftOrigin = { kind: 'agent'; principal: string; label?: string }

/** What a diagnostic is about (KHP 2.0 A21); none set means the whole document. Pages and slides count from 1. */
export type KitDiagnosticTarget = { objectId?: string; path?: string; page?: number; slide?: number; sheet?: string; cell?: string }
/** One thing a kit found wrong with a document (KHP 2.0 A21). `code` is stable (`sheet.formula-error`); `fix` is a command hint, never run on its own. */
export type KitDiagnostic = {
  code: string
  severity: 'error' | 'warning' | 'info'
  target: KitDiagnosticTarget
  message: string
  fix?: { command: string; params?: Record<string, unknown> }
}

/**
 * KitFiles 1.0 (KHP `spec/sets/files.md`; Kit UI protocol section 7g, minor version
 * 1.10): files beyond the open document, reached only through file handles the host grants. A
 * handle is an opaque `fh_…` string bound to one session, one kit, and one principal (FA1, FA5);
 * no path of the host's file system ever reaches the kit (FA-P2, UI-F1).
 */
export const FILE_HANDLE_PREFIX = 'fh_'

/** What a handle allows (FA2): `read` (and list a folder), `create` (a new file, or files in a folder), `write` (replace an existing file). */
export type KitFileRight = 'read' | 'create' | 'write'

/**
 * A handle's stat (FA3). `name` is a display name, the last segment only, untrusted text for the
 * kit; `version` is the host's opaque version stamp, `null` for a created file not committed yet.
 */
export type KitFileStat = {
  handle: string
  name: string
  kind: 'file' | 'folder'
  size?: number
  mime?: string
  version: string | null
  rights: KitFileRight[]
}

/** `files/pick` (FA6): `accept` lists extensions without the dot; `multiple` applies to `open`, `suggestedName` to `save`. */
export type KitFilesPickParams = { purpose: string; mode: 'open' | 'folder' | 'save'; accept: string[]; multiple?: boolean; suggestedName?: string | null }

/** `files/create` (FA7): `folder` is a folder handle with right `create`; without it, the host creates beside the document. */
export type KitFilesCreateParams = { suggestedName: string; mime?: string; folder?: string }

/** `files/write` (FA9): one staged chunk; `offset` is the number of bytes staged so far; `final` commits; `expected` is required on a `write` handle's final chunk. */
export type KitFilesWriteParams = { handle: string; bytes: ArrayBuffer; offset: number; final?: boolean; expected?: string | null }

/** `files/print` (FA11): a PDF the kit rendered, or a handle with right `read` on a PDF. */
export type KitFilesPrintParams = { bytes: ArrayBuffer; mime: 'application/pdf'; title: string } | { handle: string; title: string }

/** The reasons a `files/*` request is refused (`error.data.reason` of a `-32000`; KitFiles 1.0 section 10). */
export const FILE_ERROR_REASONS = ['file-not-granted', 'not-allowed', 'no-gesture', 'already-committed', 'conflict', 'unsaved-edits', 'quota', 'unsupported', 'io-error'] as const
export type KitFileErrorReason = (typeof FILE_ERROR_REASONS)[number]

/** The reason a `files/*` request was refused, from the error the host answered; `null` for any other failure. */
export function fileErrorReason(error: unknown): KitFileErrorReason | null {
  if (!(error instanceof KitRpcError) || error.code !== -32000 || typeof error.data !== 'object' || error.data === null) return null
  const reason = (error.data as { reason?: unknown }).reason
  return (FILE_ERROR_REASONS as readonly string[]).includes(reason as string) ? (reason as KitFileErrorReason) : null
}

/**
 * Host generation (capability `generate`, protocol section 7j, minor version 2.2; a Kition platform
 * request, not KHP): the kit builds the prompt from what its document holds and asks the host for
 * the model call; the host runs the person's model settings and never hands the kit a key (UI-G2).
 */
export type KitGeneratePart = { type: 'text'; text: string } | { type: 'image'; mime: string; bytes: ArrayBuffer } | { type: 'image'; url: string }
export type KitGenerateMessage = { role: 'system' | 'user'; parts: KitGeneratePart[] }
export type KitGenerateParams = {
  /** What the kit generates for (section 7j, minor version 2.4): a defined purpose or the kit's own (`isGeneratePurpose`). */
  purpose: KitGeneratePurpose
  output: 'text' | 'image'
  /** The document's preference, a hint only: the host answers the model it used. */
  model?: string
  messages: KitGenerateMessage[]
  /** `size` is `WIDTHxHEIGHT`, for images; the host may ignore any of them. */
  options?: { maxTokens?: number; temperature?: number; size?: string }
}
export type KitGenerateResult = { text?: string; image?: { mime: string; bytes: ArrayBuffer }; model?: string; usage?: { inputTokens?: number; outputTokens?: number } }

/**
 * The purposes section 7j defines (minor version 2.4), which every host that lists `generate`
 * serves: `ai-field`, an AI field's cell; `rewrite`, text the person selected rewritten as they
 * asked (improve, shorten, expand, change the tone, translate), a suggestion the person accepts
 * or discards before the kit writes it.
 */
export const GENERATE_PURPOSES = ['ai-field', 'rewrite'] as const
export type KitDefinedGeneratePurpose = (typeof GENERATE_PURPOSES)[number]
/** A defined purpose, or a kit's own: `<kit>.<name>` (`note.outline` for `kit.note`), which a host MAY refuse. */
export type KitGeneratePurpose = KitDefinedGeneratePurpose | `${string}.${string}`

const NAME = /^[a-z][a-z0-9-]{0,62}$/

/**
 * Whether a kit may send `purpose` (section 7j): a defined purpose, or one of its own,
 * `<kit>.<name>`, where `<kit>` is its id without `kit.` (`kitId`; unknown: only defined
 * purposes) and `<name>` lowercase letters, digits, and hyphens.
 */
export function isGeneratePurpose(purpose: unknown, kitId?: string | null): purpose is KitGeneratePurpose {
  if (typeof purpose !== 'string') return false
  if ((GENERATE_PURPOSES as readonly string[]).includes(purpose)) return true
  if (!kitId) return false
  const kit = kitId.startsWith('kit.') ? kitId.slice('kit.'.length) : kitId
  return purpose.startsWith(`${kit}.`) && NAME.test(purpose.slice(kit.length + 1))
}

/** The reasons a `host/generate` is refused (`error.data.reason` of a `-32000`). */
export const GENERATE_ERROR_REASONS = ['unavailable', 'not-allowed', 'quota', 'refused', 'too-large', 'timeout', 'failed'] as const
export type KitGenerateErrorReason = (typeof GENERATE_ERROR_REASONS)[number]

/**
 * Host actions (capability `action:<id>`, section 7j): a host feature the kit offers a control
 * for, from a person's gesture only. Defined ids: `workflow.run` (`{ workflowId, tableId, recordId }`)
 * and `design.fromRecord` (`{ title, fields, record? }`); other ids are the host's.
 */
export const HOST_ACTION_CAPABILITY_PREFIX = 'action:'
export type KitActionParams = { id: string; params: Record<string, unknown> }
export type KitActionResult = { done: boolean; message?: string }

/** The reasons a `host/action` is refused (`error.data.reason` of a `-32000`). */
export const ACTION_ERROR_REASONS = ['not-allowed', 'no-gesture', 'not-found', 'failed'] as const
export type KitActionErrorReason = (typeof ACTION_ERROR_REASONS)[number]

/**
 * Opening (capabilities `open-file` and `open-url`, section 7i, minor version 2.1; KitLinks 1.0
 * section 5): the kit asks the host to open a workspace file or a web address, only from a
 * person's gesture (OP1, OP6). `linkRef` names the target as the document stores it: a path
 * relative to the document's folder, a bare name the host resolves (LR4), or a replica id.
 */
export type KitLinkRef = { path?: string; name?: string; docId?: string }
/** `host/open`: `view` is where to show the target (OP3); `create` makes a missing target first (OP4), with `kit` picking the kit when several create its extension. */
export type KitOpenParams = { link: KitLinkRef; view?: KitView; placement?: 'tab' | 'beside'; create?: { kit?: string } }
/** `opened` is `false` when the person cancelled a confirmation (OP8). */
export type KitOpenResult = { opened: boolean }

/** The reasons a `host/open` or `host/openUrl` is refused (`error.data.reason` of a `-32000`; KitLinks 1.0 section 5). */
export const OPEN_ERROR_REASONS = ['not-found', 'no-gesture', 'no-kit', 'not-allowed'] as const
export type KitOpenErrorReason = (typeof OPEN_ERROR_REASONS)[number]

/** The only schemes a host opens (OP7); every other is refused as `not-allowed`. */
export const OPEN_URL_SCHEMES = ['https:', 'http:', 'mailto:'] as const

/** Whether `url` is an absolute address with a scheme a host may open (OP7). */
export function isOpenableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false
  try {
    return (OPEN_URL_SCHEMES as readonly string[]).includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/** A `linkRef` checked: only non-empty string members, at least one of them; `null` otherwise. */
export function parseLinkRef(value: unknown): KitLinkRef | null {
  if (!isRecord(value)) return null
  const link: KitLinkRef = {}
  for (const key of ['path', 'name', 'docId'] as const) {
    if (typeof value[key] === 'string' && value[key]) link[key] = value[key] as string
  }
  return Object.keys(link).length ? link : null
}

/** `host/open`'s params checked: a well-formed link, and only the known members of each optional one; `null` without a link. */
export function parseOpenParams(value: unknown): KitOpenParams | null {
  if (!isRecord(value)) return null
  const link = parseLinkRef(value.link)
  if (!link) return null
  const view = parseKitView(value.view)
  const create = isRecord(value.create) ? (typeof value.create.kit === 'string' && value.create.kit ? { kit: value.create.kit } : {}) : null
  return { link, ...(view ? { view } : {}), placement: value.placement === 'beside' ? 'beside' : 'tab', ...(create ? { create } : {}) }
}

/**
 * Picking a file to link (capability `links-pick`, section 7i, minor version 2.5; rules UI-N2 to
 * UI-N4): the person chooses existing workspace files, which stay where they are. `accept` lists
 * extensions without the dot (at least one); `multiple` lets the person choose several.
 */
export type KitLinksPickParams = { purpose: string; accept: string[]; multiple?: boolean }
/** A file the person chose to link: `path` relative to the document's folder (HC-P2), `name` its last segment, `version` its stamp. */
export type KitPickedLink = { path: string; name: string; version: string | null }

/** `links/pick`'s params checked: a purpose, extensions without the dot (lowercased, at least one), and `multiple`; `null` otherwise. */
export function parseLinksPickParams(value: unknown): KitLinksPickParams | null {
  if (!isRecord(value) || typeof value.purpose !== 'string' || !Array.isArray(value.accept)) return null
  const accept: string[] = []
  for (const item of value.accept) {
    if (typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(item)) return null
    if (!accept.includes(item.toLowerCase())) accept.push(item.toLowerCase())
  }
  if (!accept.length || accept.length > 64) return null
  return { purpose: value.purpose.slice(0, 200), accept, multiple: value.multiple === true }
}

/**
 * Workspace path `to` as the document at `documentPath` links it (HC-P2): relative to the
 * document's folder, with `../` where `to` is elsewhere (`../libraries/Icons.kfig`).
 */
export function linkPathFrom(documentPath: string, to: string) {
  const parts = (path: string) => path.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.')
  const from = parts(documentPath).slice(0, -1)
  const target = parts(to)
  let shared = 0
  while (shared < from.length && shared < target.length - 1 && from[shared] === target[shared]) shared += 1
  return [...from.slice(shared).map(() => '..'), ...target.slice(shared)].join('/')
}

/** The reason a `host/open` or `host/openUrl` was refused, from the error the host answered; `null` for any other failure. */
export function openErrorReason(error: unknown): KitOpenErrorReason | null {
  if (!(error instanceof KitRpcError) || error.code !== -32000 || typeof error.data !== 'object' || error.data === null) return null
  const reason = (error.data as { reason?: unknown }).reason
  return (OPEN_ERROR_REASONS as readonly string[]).includes(reason as string) ? (reason as KitOpenErrorReason) : null
}

/** The reason a `host/generate` or `host/action` was refused, from the error the host answered; `null` for any other failure. */
export function hostRequestErrorReason(error: unknown): KitGenerateErrorReason | KitActionErrorReason | null {
  if (!(error instanceof KitRpcError) || error.code !== -32000 || typeof error.data !== 'object' || error.data === null) return null
  const reason = (error.data as { reason?: unknown }).reason
  if ((GENERATE_ERROR_REASONS as readonly string[]).includes(reason as string)) return reason as KitGenerateErrorReason
  if ((ACTION_ERROR_REASONS as readonly string[]).includes(reason as string)) return reason as KitActionErrorReason
  return null
}

/** Requests the host sends, with their params and results. */
export type HostToKit = {
  'ui/initialize': [InitializeParams, InitializeResult]
  'document/state': [Record<string, never>, DocumentState]
  'document/save': [Record<string, never>, { saved: boolean; version: string | null }]
  /** The engine's diagnostics on the document (capability `check`, minor version 1.9), errors first; `draft: true` checks the agent's draft. */
  'document/check': [{ draft?: boolean }, { diagnostics: KitDiagnostic[] }]
  /** `draft: true` (capability `draft`) inspects, runs on, and previews the agent's draft instead of the live document; `ai/run` opens one if there is none. */
  'ai/inspect': [{ draft?: boolean }, Record<string, unknown>]
  'ai/commands': [{ query: string }, Array<Record<string, unknown>>]
  'ai/run': [{ steps: AiStep[]; save: boolean; draft?: boolean }, AiRunResult]
  'ai/preview': [{ maxSize: number; draft?: boolean }, { png: string }]
  /** The draft (capability `draft`, section 7d). */
  'draft/state': [Record<string, never>, DraftInfo]
  /** The agent asks for review; the agent may call it (through its host). */
  'draft/ready': [Record<string, never>, DraftInfo]
  /** Sends a draft back to the agent; the agent may call it. */
  'draft/reopen': [Record<string, never>, DraftInfo]
  'draft/compare': [{ maxSize?: number; schema?: object }, DraftComparison]
  /** The person's explicit approval only, never a model's: takes the draft into the document as one undo step, and closes it. */
  'draft/merge': [{ origin: DraftOrigin; schema?: object }, { merged: boolean; summary: DraftSummary }]
  /** The person's explicit approval only: drops the draft; the document is untouched. */
  'draft/discard': [Record<string, never>, DraftInfo]
  /** The editor's elements and their state (section 9). */
  'ui/elements': [Record<string, never>, KitUiElement[]]
  'replica/version': [Record<string, never>, { version: ArrayBuffer }]
  'replica/export': [{ since: ArrayBuffer }, { changes: ArrayBuffer; blobs: ArrayBuffer }]
  /** `damage` is what went stale on screen, as the kit's engine reports it. */
  'replica/import': [{ changes: ArrayBuffer; blobs: ArrayBuffer }, { damage: unknown }]
  /** The replica's own id, when the kit's engine has one (minor version 1.3); `null` otherwise. */
  'replica/info': [Record<string, never>, { docId: string | null }]
  'model/describe': [{ schema?: object }, Record<string, unknown>]
  'model/batch': [ModelBatchParams, ModelBatchResult]
}

/** Notifications the host sends. */
export type HostNotifications = {
  'document/fileChanged': { version: string }
  'ui/theme': { theme: KitTheme }
  'ui/locale': { locale: string }
  'ui/focus': Record<string, never>
  /** Replaces the UI configuration (section 9). */
  'ui/configure': { ui: KitUiConfig }
  /** The document's leases changed (capability `lease`, section 7b): the whole list. */
  'lease/changed': { leases: KitLease[] }
  /** The other people in the document and what they share changed (capability `presence`, section 7e): the whole list. */
  'presence/peers': { peers: KitPeerPresence[] }
  /** The host revoked these handles, or they expired (KitFiles FA4); later calls with them fail `file-not-granted`. */
  'files/revoked': { handles: string[] }
  /** Shows `view` in the open document (minor version 2.1, section 7i; OP3), as `document.view` does for a new editor. */
  'document/reveal': { view: KitView }
}

/** Requests the kit sends. */
export type KitToHost = {
  'host/read': [{ path: string; offset?: number; length?: number }, { bytes: ArrayBuffer; version: string; size: number }]
  'host/stamp': [{ path: string }, { version: string | null }]
  'host/write': [{ path: string; bytes: ArrayBuffer; mode: WriteMode; expected?: string | null }, { path: string; version: string }]
  'host/pick': [{ purpose: string; accept: string[] }, { path: string | null }]
  'host/openAgent': [{ prompt?: string }, Record<string, never>]
  'host/replicaRead': [{ path: string }, StoredReplica | null]
  'host/replicaWrite': [{ path: string } & StoredReplica, Record<string, never>]
  /** Keeps what the person hid (capability `customize`, section 9). */
  'host/customize': [{ personal: { hide: string[] } }, Record<string, never>]
  /**
   * Takes (or renews) the lease on `scope` and keeps it until `host/leaseRelease` or the kit
   * closes (capability `lease`, section 7b). `lease` is `null` when there is nobody to coordinate
   * with (the document is not co-edited, or the host is offline): the kit goes ahead.
   */
  'host/leaseAcquire': [{ scope: string; ttl?: number }, { lease: KitLease | null }]
  'host/leaseRelease': [{ scope: string }, Record<string, never>]
  /** The document's leases now (capability `lease`). */
  'host/leases': [Record<string, never>, { leases: KitLease[] }]
  /** Shows the host's picker (capability `files-pick`, section 7g); only from a person's gesture. Empty when the person cancels. */
  'files/pick': [KitFilesPickParams, { files: KitFileStat[] }]
  /** A new file handle with right `create` (capability `files`): an unused name, never an existing file (FA7). */
  'files/create': [KitFilesCreateParams, KitFileStat]
  'files/stat': [{ handle: string }, KitFileStat]
  /** At most `length` bytes from `offset`; possibly fewer. `size` is the whole file's size. */
  'files/read': [{ handle: string; offset?: number; length?: number }, { bytes: ArrayBuffer; version: string; size: number }]
  /** A folder handle's entries that match the grant's `accept`, not recursively, each with right `read`. */
  'files/list': [{ handle: string }, { files: KitFileStat[] }]
  /** One staged chunk; `{ version }` once `final` commits it (FA9). */
  'files/write': [KitFilesWriteParams, { version?: string }]
  /** Drops handles; never an error, even for unknown or expired ones. */
  'files/release': [{ handles: string[] }, Record<string, never>]
  /** Shows the system's print dialog (capability `print`); only from a person's gesture. */
  'files/print': [KitFilesPrintParams, { printed: boolean }]
  /** A model call the host runs for the kit (capability `generate`, section 7j). Image bytes are transferred. */
  'host/generate': [KitGenerateParams, KitGenerateResult]
  /** Runs one of the host's actions (capability `action:<id>`, section 7j); only from a person's gesture. */
  'host/action': [KitActionParams, KitActionResult]
  /** Opens a workspace file in the host (capability `open-file`, section 7i); only from a person's gesture. */
  'host/open': [KitOpenParams, KitOpenResult]
  /** Opens a web address in the system's browser or mail client (capability `open-url`, section 7i); only from a person's gesture. */
  'host/openUrl': [{ url: string }, KitOpenResult]
  /** Asks the person for existing workspace files to link, never copied (capability `links-pick`, section 7i); only from a person's gesture. Empty when the person cancels. */
  'links/pick': [KitLinksPickParams, { links: KitPickedLink[] }]
}

/** Notifications the kit sends. */
export type KitNotifications = {
  'document/changed': DocumentState & { by: 'person' | 'agent' }
  'host/notify': { level: 'info' | 'success' | 'warning' | 'error'; title: string; description?: string }
  'host/shortcut': { key: string; code: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }
  'replica/changed': { version: ArrayBuffer }
  /** A host button was pressed (section 9). */
  'ui/action': { id: string; document: { path: string; dirty: boolean; revision: number } }
  /** The document's unresolved conflict objects changed (section 7c): the whole list. */
  'document/conflicts': { conflicts: KitConflict[] }
  /** A newer kit edited the document (section 7f): the host shows a notice that never blocks. */
  'document/schema': KitSchemaReport
  /** The agent's draft opened, changed, became ready or open again, or closed (capability `draft`). */
  'draft/changed': DraftInfo
  /** What this session shares with the other people in the document changed (capability `presence`, section 7e). */
  'presence/set': KitPresence
}

type Message = { jsonrpc: '2.0'; id?: string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }

/** A failed request: the JSON-RPC error the other side answered. */
export class KitRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
  }
}

type Handler = (params: never) => unknown
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

/** ArrayBuffers in a value, to transfer instead of copying. */
function transferables(value: unknown, out: Transferable[] = [], depth = 0): Transferable[] {
  if (value instanceof ArrayBuffer) out.push(value)
  else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) out.push(value.buffer)
  else if (value && typeof value === 'object' && depth < 4) for (const item of Object.values(value)) transferables(item, out, depth + 1)
  return out
}

/**
 * One side of the protocol on a MessagePort. `Out` and `In` are the request maps this side sends
 * and answers; `OutN` and `InN` the notifications.
 */
export class KitPeer<
  Out extends Record<string, [unknown, unknown]>,
  In extends Record<string, [unknown, unknown]>,
  OutN extends Record<string, unknown>,
  InN extends Record<string, unknown>,
> {
  private next = 1
  private pending = new Map<string, Pending>()
  private handlers = new Map<string, Handler>()
  private listeners = new Map<string, Set<(params: never) => void>>()
  private closed = false

  constructor(private readonly port: MessagePort, private readonly prefix: 'h' | 'k') {
    port.onmessage = (event: MessageEvent<Message>) => void this.receive(event.data)
    port.start()
  }

  /** Answers requests for `method`; a thrown error becomes a JSON-RPC error. */
  handle<M extends keyof In & string>(method: M, handler: (params: In[M][0]) => In[M][1] | Promise<In[M][1]>) {
    this.handlers.set(method, handler as Handler)
  }

  on<M extends keyof InN & string>(method: M, listener: (params: InN[M]) => void) {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(listener as (params: never) => void)
    return () => set.delete(listener as (params: never) => void)
  }

  /** `transfer` hands the params' ArrayBuffers over instead of copying them (the sender loses them). */
  request<M extends keyof Out & string>(method: M, params: Out[M][0], options: { transfer?: boolean } = {}): Promise<Out[M][1]> {
    if (this.closed) return Promise.reject(new KitRpcError(-32000, 'the connection is closed'))
    const id = `${this.prefix}${this.next++}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.post({ jsonrpc: '2.0', id, method, params }, options.transfer)
    })
  }

  notify<M extends keyof OutN & string>(method: M, params: OutN[M]) {
    if (!this.closed) this.post({ jsonrpc: '2.0', method, params })
  }

  close() {
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new KitRpcError(-32000, 'the connection is closed'))
    this.pending.clear()
    this.port.close()
  }

  private post(message: Message, transfer = false) {
    this.port.postMessage(message, transfer ? transferables(message.params ?? message.result) : [])
  }

  private async receive(message: Message) {
    if (!message || message.jsonrpc !== '2.0') return
    if (message.method && message.id !== undefined) {
      const handler = this.handlers.get(message.method)
      if (!handler) return this.post({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not supported` } })
      try {
        const result = await handler(message.params as never)
        // Answers are copied: the answering side may still hold what it answered (a cached file).
        // `null` is an answer (`host/replicaRead` with nothing stored); only no value becomes `{}`.
        this.post({ jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result })
      } catch (error) {
        const failure = error instanceof KitRpcError ? error : new KitRpcError(-32000, error instanceof Error ? error.message : String(error))
        this.post({ jsonrpc: '2.0', id: message.id, error: { code: failure.code, message: failure.message, data: failure.data } })
      }
      return
    }
    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params as never)
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new KitRpcError(message.error.code, message.error.message, message.error.data))
    else pending.resolve(message.result)
  }
}

/** The host's end: sends host-to-kit requests, answers the kit's. */
export type HostPeer = KitPeer<HostToKit, KitToHost, HostNotifications, KitNotifications>
/** The kit's end. */
export type KitSidePeer = KitPeer<KitToHost, HostToKit, KitNotifications, HostNotifications>

/** `Cmd+N` and the like, against a key event: `Cmd` is Meta on macOS and Control elsewhere. */
export function matchesShortcut(shortcut: string, event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean) {
  const parts = shortcut.split('+')
  const key = parts.pop() ?? ''
  const mods = new Set(parts)
  const command = mac ? event.metaKey : event.ctrlKey
  return command === mods.has('Cmd') && event.shiftKey === mods.has('Shift') && event.altKey === mods.has('Alt') && event.key.toLowerCase() === key.toLowerCase()
}
