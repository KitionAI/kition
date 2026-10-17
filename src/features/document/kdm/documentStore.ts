/**
 * Opening and saving Markdown documents through their private replica store (`.kition/docs/`), and keeping a
 * document's identity (its KDM document id) on its path as files are renamed, moved, deleted, and copied.
 *
 * The `.md` file is the document; the store only adds editing history. So every store failure degrades to
 * importing the file again (a new identity, no history) and never blocks reading or writing the file.
 */
import { randomActor, Replica, type ObjectId, type Origin } from '@/lib/kdm'
import {
  deleteDocumentStore,
  isDocumentIndexConflict,
  listWorkspaceDocuments,
  readDocumentIndex,
  readDocumentStore,
  writeDocumentIndex,
  writeDocumentStore,
  writeWorkspaceDocument,
  type DocumentStoreMeta,
  type DocumentStoreOptions,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { DOCUMENT_KIT, documentSchema } from './documentSchema'
import { analyzeText, createDocumentReplica, documentBody, documentRootId, renderText, type LineStyle } from './documentText'
import { mergeExternalText } from './documentMerge'

/** The origin of file imports and merges of external changes (not undo steps). */
export const FILE_IMPORT_ORIGIN: Origin = { kind: 'import', principal: 'file' }

/** How often an index update re-reads and retries after another writer changed the index. */
const INDEX_RETRIES = 3
const WORKSPACE_CHANGED = 'DESIGN_WORKSPACE_CHANGED'

export type OpenedDocument = {
  replica: Replica
  /** The `Document` object (`documentRootId`). */
  rootId: ObjectId
  /** As stored, or as created for an import. */
  meta: DocumentStoreMeta
  /** The line style of the file as last read. */
  style: LineStyle
  /** The exact file text read from disk: the guard expectation for the next save. */
  fileText: string
  /** Imported now: there was no usable store entry. */
  isNew: boolean
  /** The file changed since the last save and was merged into the replica on open. */
  merged: boolean
  /** When `merged`: the replica's text before the merge (what this machine last saved). */
  previousText?: string
}

export type SavedDocument = { fileText: string; meta: DocumentStoreMeta }

type Options = { expectedRoot?: string }

// --- Helpers --------------------------------------------------------------

function storeOptions(options?: Options): DocumentStoreOptions | undefined {
  return options?.expectedRoot ? { expectedRoot: options.expectedRoot } : undefined
}

function isWorkspaceChanged(error: unknown) {
  return String((error as { message?: unknown } | null)?.message ?? error ?? '').includes(WORKSPACE_CHANGED)
}

function warn(message: string, error: unknown) {
  console.warn(`[document-store] ${message}`, error)
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** The SHA-256 of the file text's UTF-8 bytes, as lowercase hex (Web Crypto, which Node provides too). */
export async function hashFileText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  // A copy in this realm's ArrayBuffer: some test environments hand out Uint8Arrays from another realm.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer)))
}

/** The replica's version as the store records it (`meta.exported`). */
export function versionHex(replica: Replica): string {
  return toHex(replica.version().encode())
}

/** The workspace path of the folder that holds a file's child pages: its path without the extension. */
export function childFolderPath(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? path.slice(0, slash + 1) + name.slice(0, dot) : path
}

function makeMeta(replica: Replica, path: string, fileHash: string, fileStamp: string | null, style: LineStyle): DocumentStoreMeta {
  return { docId: replica.docId, kit: DOCUMENT_KIT, path, fileHash, fileStamp, exported: versionHex(replica), style: { ...style } }
}

async function storeReplica(replica: Replica, meta: DocumentStoreMeta, options?: Options) {
  await writeDocumentStore(meta.docId, { meta, snapshot: replica.snapshot() }, storeOptions(options))
}

// --- The index ------------------------------------------------------------

let indexQueue: Promise<unknown> = Promise.resolve()

/** Runs index updates of this window one after another, so they do not conflict with each other. */
function queued<T>(task: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(task, task)
  indexQueue = run.catch(() => undefined)
  return run
}

type IndexChange = { before: Record<string, string>; after: Record<string, string> }

/**
 * Applies `change` to the index with a guarded write; `change` answers the new entries, or `null` for no change.
 * On a conflict (another writer changed the index meanwhile) it re-reads and applies `change` again.
 */
function updateIndex(change: (entries: Record<string, string>) => Record<string, string> | null, options?: Options): Promise<IndexChange | null> {
  return queued(async () => {
    let lastConflict: unknown = null
    for (let attempt = 0; attempt <= INDEX_RETRIES; attempt += 1) {
      const index = await readDocumentIndex(storeOptions(options))
      const after = change({ ...index.entries })
      if (after === null) return null
      try {
        await writeDocumentIndex(after, index.version, storeOptions(options))
        return { before: index.entries, after }
      } catch (error) {
        if (!isDocumentIndexConflict(error)) throw error
        lastConflict = error
      }
    }
    throw lastConflict
  })
}

/** Deletes the store entries of documents the index no longer names (best effort). */
async function dropUnreferenced(change: IndexChange | null, options?: Options) {
  if (!change) return
  const kept = new Set(Object.values(change.after))
  const dropped = new Set(Object.values(change.before).filter((docId) => !kept.has(docId)))
  for (const docId of dropped) {
    try {
      await deleteDocumentStore(docId, storeOptions(options))
    } catch (error) {
      if (isWorkspaceChanged(error)) throw error
      warn('could not delete a document store entry', error)
    }
  }
}

/** `entries` with `path` → `docId`, or `null` when it already says so. */
const withEntry = (path: string, docId: string) => (entries: Record<string, string>) => {
  if (entries[path] === docId) return null
  entries[path] = docId
  return entries
}

/** `entries` with the keys `rename` maps moved; `null` when none moved. */
function remapEntries(entries: Record<string, string>, rename: (path: string) => string | null): Record<string, string> | null {
  const moved: [string, string, string][] = []
  for (const [path, docId] of Object.entries(entries)) {
    const target = rename(path)
    if (target !== null && target !== path) moved.push([path, target, docId])
  }
  if (moved.length === 0) return null
  for (const [path] of moved) delete entries[path]
  for (const [, target, docId] of moved) entries[target] = docId
  return entries
}

/** `entries` without the keys `drop` selects; `null` when none. */
function removeEntries(entries: Record<string, string>, drop: (path: string) => boolean): Record<string, string> | null {
  const paths = Object.keys(entries).filter(drop)
  if (paths.length === 0) return null
  for (const path of paths) delete entries[path]
  return entries
}

const branchTarget = (path: string, fromPrefix: string, toPrefix: string) => (path.startsWith(fromPrefix) ? toPrefix + path.slice(fromPrefix.length) : null)

/**
 * Where the index keeps a document whose file is gone until the next prune (`pruneDocumentStore`): a path no file
 * has, so the document is not opened by path, yet a restored or moved file with its hash is still recognised.
 */
const DELETED_PREFIX = '.kition/docs/deleted/'
const deletedPath = (docId: string) => `${DELETED_PREFIX}${docId}`
const isDeletedPath = (path: string) => path.startsWith(DELETED_PREFIX)

/** `entries` with the keys `drop` selects moved to their deleted paths; `null` when none. */
function buryEntries(entries: Record<string, string>, drop: (path: string) => boolean): Record<string, string> | null {
  const paths = Object.keys(entries).filter((path) => !isDeletedPath(path) && drop(path))
  if (paths.length === 0) return null
  for (const path of paths) {
    const docId = entries[path]
    delete entries[path]
    entries[deletedPath(docId)] = docId
  }
  return entries
}

// --- Open -------------------------------------------------------------------

type Loaded = { replica: Replica; rootId: ObjectId; meta: DocumentStoreMeta }

/**
 * The stored replica of `docId`, or `null` when it is missing, damaged, or not this document. With `fileHash`, also
 * `null` when the entry's last saved file had another hash; that is checked before the snapshot is loaded.
 */
async function loadStored(docId: string, actor: bigint, options?: Options, fileHash?: string): Promise<Loaded | null> {
  let entry
  try {
    entry = await readDocumentStore(docId, storeOptions(options))
  } catch (error) {
    if (isWorkspaceChanged(error)) throw error
    warn('could not read a document store entry', error)
    return null
  }
  if (!entry || entry.meta?.docId !== docId || entry.meta.kit !== DOCUMENT_KIT || typeof entry.meta.fileHash !== 'string') return null
  if (fileHash !== undefined && entry.meta.fileHash !== fileHash) return null
  try {
    const replica = Replica.load(documentSchema, entry.snapshot, actor)
    if (replica.docId !== docId) return null
    return { replica, rootId: documentRootId(replica), meta: entry.meta }
  } catch (error) {
    warn('a document store entry is damaged', error)
    return null
  }
}

function filePaths(items: readonly WorkspaceDocumentTreeItem[], into = new Set<string>()): Set<string> {
  for (const item of items) {
    if (item.type === 'file') into.add(item.path)
    if (item.children) filePaths(item.children, into)
  }
  return into
}

// --- The workspace's files ---------------------------------------------------

/** The files of the workspace as last listed or as the app's tree shows them, for one root. */
let knownFiles: { root: string; paths: Set<string> } | null = null

/**
 * The workspace's files as the app's tree shows them (it follows the workspace's changes), so that opening a
 * document does not list the whole workspace to recognise a renamed file. `null` (or an empty tree) forgets them.
 */
export function noteWorkspaceFiles(root: string, items: readonly WorkspaceDocumentTreeItem[] | null) {
  knownFiles = root && items?.length ? { root, paths: filePaths(items) } : null
}

/** Lists the workspace's files now (and keeps them as the known files); `null` when that fails or the root changed. */
async function listFiles(options?: Options): Promise<Set<string> | null> {
  try {
    const workspace = await listWorkspaceDocuments()
    if (options?.expectedRoot && workspace.root_path !== options.expectedRoot) return null
    const paths = filePaths(workspace.items || [])
    knownFiles = paths.size ? { root: workspace.root_path, paths } : null
    return paths
  } catch (error) {
    warn('could not list the workspace', error)
    return null
  }
}

/** The index entries other than `path` that no existing file holds: documents whose files went away. */
function orphans(others: [string, string][], existing: Set<string>): [string, string][] {
  const live = new Set(others.filter(([entryPath]) => existing.has(entryPath)).map(([, docId]) => docId))
  return others.filter(([entryPath, docId]) => !existing.has(entryPath) && !live.has(docId))
}

/**
 * A stored document whose file was renamed or moved outside Kition (or deleted and restored): an index entry
 * whose path no longer exists and whose last saved file had this file's hash. Rebinds it to `path`. The known
 * files spare listing the workspace; a match they suggest is checked against a fresh listing before it is taken.
 */
async function recogniseRenamed(path: string, fileHash: string, entries: Record<string, string>, actor: bigint, options?: Options): Promise<Loaded | null> {
  const others = Object.entries(entries).filter(([entryPath]) => entryPath !== path)
  if (others.length === 0) return null
  const known = options?.expectedRoot && knownFiles?.root === options.expectedRoot ? knownFiles.paths : null
  const existing = known ?? (await listFiles(options))
  if (!existing) return null
  /** The orphans' paths by a listing made now; `null` until one was needed. */
  let confirmed: Set<string> | null = known ? null : new Set(orphans(others, existing).map(([entryPath]) => entryPath))
  for (const [oldPath, docId] of orphans(others, existing)) {
    if (confirmed && !confirmed.has(oldPath)) continue
    const loaded = await loadStored(docId, actor, options, fileHash)
    if (!loaded) continue
    if (!confirmed) {
      const fresh = await listFiles(options)
      if (!fresh) return null
      confirmed = new Set(orphans(others, fresh).map(([entryPath]) => entryPath))
      if (!confirmed.has(oldPath)) continue
    }
    try {
      await updateIndex((current) => {
        if (current[oldPath] !== docId) return withEntry(path, docId)(current)
        delete current[oldPath]
        current[path] = docId
        return current
      }, options)
    } catch (error) {
      if (isWorkspaceChanged(error)) throw error
      warn('could not rebind a renamed document in the index', error)
    }
    return loaded
  }
  return null
}

/** Imports `fileText` as a new document and records it in the store and the index (best effort). */
async function importDocument(path: string, fileText: string, fileHash: string, actor: bigint, replaced: string | null, options?: Options): Promise<OpenedDocument> {
  const { replica, rootId, style } = createDocumentReplica(fileText, actor)
  const meta = makeMeta(replica, path, fileHash, null, style)
  try {
    await storeReplica(replica, meta, options)
    const change = await updateIndex(withEntry(path, meta.docId), options)
    if (replaced) await dropUnreferenced(change, options)
  } catch (error) {
    if (isWorkspaceChanged(error)) throw error
    warn('could not record an imported document in the store', error)
  }
  return { replica, rootId, meta, style, fileText, isNew: true, merged: false }
}

/**
 * Opens the document at `path` whose file now holds `fileText`: its stored replica, with any change made to the
 * file since the last save merged in, or a new replica imported from the file. Store failures fall back to an
 * import; the file is never written.
 */
export async function openDocument(path: string, fileText: string, actor: bigint, options?: Options): Promise<OpenedDocument> {
  const fileHash = await hashFileText(fileText)
  let entries: Record<string, string> = {}
  try {
    entries = (await readDocumentIndex(storeOptions(options))).entries
  } catch (error) {
    if (isWorkspaceChanged(error)) throw error
    warn('could not read the document index', error)
  }

  const docId = entries[path] ?? null
  const loaded = docId ? await loadStored(docId, actor, options) : await recogniseRenamed(path, fileHash, entries, actor, options)
  if (!loaded) return importDocument(path, fileText, fileHash, actor, docId, options)

  const { replica, rootId } = loaded
  const { text, style } = analyzeText(fileText)
  let merged = false
  let previousText: string | undefined
  let meta: DocumentStoreMeta = { ...loaded.meta, path }
  if (meta.fileHash !== fileHash) {
    // What this machine last saved is what the replica holds (edits are saved from an open session), so the
    // replica's text is the base, and merging makes the replica the file's text in small edits.
    const body = documentBody(replica, rootId)
    merged = replica.transact(FILE_IMPORT_ORIGIN, (tx) => mergeExternalText(tx, rootId, body, text, body)) === 'merged'
    if (merged) previousText = body
    meta = makeMeta(replica, path, fileHash, null, style)
    try {
      await storeReplica(replica, meta, options)
    } catch (error) {
      if (isWorkspaceChanged(error)) throw error
      warn('could not store a document after merging its file', error)
    }
  }
  return { replica, rootId, meta, style, fileText, isNew: false, merged, ...(previousText === undefined ? {} : { previousText }) }
}

// --- Save -------------------------------------------------------------------

/**
 * Writes the replica's text, rendered with `style`, to the `.md` file, guarded by `expectedFileText` (what the
 * file held when last read or written), then stores the replica. A guard conflict propagates unchanged; a store
 * failure after the file was written goes to `onStoreError` (the text is safe in the file).
 */
export async function saveDocument(input: {
  path: string
  opened: Pick<OpenedDocument, 'replica' | 'rootId' | 'meta' | 'style'>
  /** What the file holds now; `null` when there must be no file (it is written again after it was deleted). */
  expectedFileText: string | null
  expectedRoot?: string
  onStoreError?: (error: unknown) => void
}): Promise<SavedDocument> {
  const { path, opened, expectedFileText } = input
  // The text, the snapshot, and the version are taken together, before anything is awaited: edits made while the
  // file is written are not in it, so the store must not hold them either (a later discard would resurrect them).
  const fileText = renderText(documentBody(opened.replica, opened.rootId), opened.style)
  const snapshot = opened.replica.snapshot()
  const exported = versionHex(opened.replica)
  const style = { ...opened.style }
  const root = input.expectedRoot || (await listWorkspaceDocuments()).root_path
  const guard = expectedFileText === null
    ? { expected_root: root, expected_content: null, expected_missing: true }
    : { expected_root: root, expected_content: expectedFileText }
  const written = await writeWorkspaceDocument(path, fileText, guard)
  const stamp = written?.mtime_ms !== undefined ? String(written.mtime_ms) : (written?.updated_at ?? null)
  const meta: DocumentStoreMeta = { ...makeMeta(opened.replica, path, await hashFileText(fileText), stamp, style), exported }
  try {
    await writeDocumentStore(meta.docId, { meta, snapshot }, storeOptions({ expectedRoot: root }))
  } catch (error) {
    if (input.onStoreError) input.onStoreError(error)
    else warn('could not store a saved document', error)
  }
  return { fileText, meta }
}

/**
 * Merges the file as it is now (`fileText`) into the replica as an import; `baseText` is the file text this
 * session last read or wrote. Both are raw file texts.
 */
export function mergeFileIntoReplica(opened: Pick<OpenedDocument, 'replica' | 'rootId'>, baseText: string, fileText: string): 'unchanged' | 'merged' {
  const base = analyzeText(baseText).text
  const incoming = analyzeText(fileText).text
  if (base === incoming) return 'unchanged'
  const current = documentBody(opened.replica, opened.rootId)
  return opened.replica.transact(FILE_IMPORT_ORIGIN, (tx) => mergeExternalText(tx, opened.rootId, base, incoming, current))
}

// --- Shared documents --------------------------------------------------------

/**
 * Writes a new Markdown file at `path` (where there must be no file yet) from a document someone
 * shared for co-editing: `bytes` (a KDM snapshot or a full change export) become the file's replica
 * as they are, stored and indexed under `path`, so the file is that same document (its KDM id) and
 * its session co-edits it. Answers the replica version the store holds.
 */
export async function createDocumentFromReplica(path: string, bytes: Uint8Array, options: { expectedRoot: string }): Promise<Uint8Array> {
  const replica = Replica.load(documentSchema, bytes, randomActor())
  const rootId = documentRootId(replica)
  const { style } = analyzeText(documentBody(replica, rootId))
  const meta = makeMeta(replica, path, '', null, style)
  await saveDocument({ path, opened: { replica, rootId, meta, style }, expectedFileText: null, expectedRoot: options.expectedRoot })
  await updateIndex(withEntry(path, replica.docId), options)
  return replica.version().encode()
}

// --- Other kinds of documents ----------------------------------------------

/**
 * The document id the index keeps for the file at `path`, recording `mint()`'s there when it has none: for replicas
 * other editors keep in the store (a kit's, for a file that cannot carry one), whose identity then follows the
 * file's renames and moves like a Markdown document's.
 */
export async function bindDocumentId(path: string, mint: () => string, options?: Options): Promise<string> {
  let docId = ''
  await updateIndex((entries) => {
    docId = entries[path] ?? mint()
    return withEntry(path, docId)(entries)
  }, options)
  return docId
}

// --- Identity across tree operations ----------------------------------------

/**
 * The file at `oldPath` is now at `newPath`; its child pages (the folder named like the file without its
 * extension) moved with it. Keeps their document ids on the new paths.
 */
export async function renameDocument(oldPath: string, newPath: string, options?: Options): Promise<void> {
  if (!oldPath || !newPath || oldPath === newPath) return
  const fromPrefix = `${childFolderPath(oldPath)}/`
  const toPrefix = `${childFolderPath(newPath)}/`
  await updateIndex((entries) => remapEntries(entries, (path) => (path === oldPath ? newPath : branchTarget(path, fromPrefix, toPrefix))), options)
}

/** The folder `oldFolder` is now at `newFolder`: keeps the document ids of every document inside it. */
export async function renameDocumentFolder(oldFolder: string, newFolder: string, options?: Options): Promise<void> {
  if (!oldFolder || !newFolder || oldFolder === newFolder) return
  await updateIndex((entries) => remapEntries(entries, (path) => branchTarget(path, `${oldFolder}/`, `${newFolder}/`)), options)
}

/**
 * The file at `path` (and its child pages) was deleted: their paths no longer name them. Their stored replicas
 * are kept until the next workspace open prunes them (`pruneDocumentStore`), so a file restored meanwhile gets
 * its identity and history back.
 */
export async function forgetDocument(path: string, options?: Options): Promise<void> {
  if (!path) return
  const prefix = `${childFolderPath(path)}/`
  await updateIndex((entries) => buryEntries(entries, (entry) => entry === path || entry.startsWith(prefix)), options)
}

/** The folder was deleted: its documents' paths no longer name them; their replicas are kept until the next prune. */
export async function forgetDocumentFolder(folder: string, options?: Options): Promise<void> {
  if (!folder) return
  await updateIndex((entries) => buryEntries(entries, (entry) => entry.startsWith(`${folder}/`)), options)
}

const prunedRoots = new Set<string>()

/** Prunes the store of the workspace at `root` the first time it opens in this window (best effort, never throws). */
export async function pruneDocumentStoreOnOpen(root: string): Promise<void> {
  if (!root || prunedRoots.has(root)) return
  prunedRoots.add(root)
  try {
    await pruneDocumentStore({ expectedRoot: root })
  } catch (error) {
    warn('could not prune the document store', error)
  }
}

/**
 * Prunes the store when a workspace opens (best effort): deletes the replicas of documents deleted before (in
 * Kition, or outside it and not seen since the previous prune), and keeps the documents whose files went away
 * outside Kition until the next prune, so a file renamed or restored meanwhile is still recognised by its hash.
 */
export async function pruneDocumentStore(options?: Options): Promise<void> {
  const existing = await listFiles(options)
  // An empty listing is more likely a failure than a workspace whose every document is gone.
  if (!existing || existing.size === 0) return
  const change = await updateIndex((entries) => {
    let changed = false
    const next: Record<string, string> = {}
    for (const [path, docId] of Object.entries(entries)) {
      if (isDeletedPath(path)) {
        changed = true
      } else if (existing.has(path)) {
        next[path] = docId
      } else {
        next[deletedPath(docId)] = docId
        changed = true
      }
    }
    return changed ? next : null
  }, options)
  await dropUnreferenced(change, options)
}

/**
 * `copyPath` was written as a copy of `sourcePath`. The copy gets no entry, so it is imported as a new document
 * when opened (two files never share a document id); a stale entry left at `copyPath` is forgotten.
 */
export async function duplicateDocumentIdentity(sourcePath: string, copyPath: string, options?: Options): Promise<void> {
  if (!copyPath || copyPath === sourcePath) return
  const change = await updateIndex((entries) => removeEntries(entries, (entry) => entry === copyPath), options)
  await dropUnreferenced(change, options)
}
