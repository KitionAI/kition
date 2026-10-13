/**
 * Opening and saving Markdown documents through their private replica store (`.kition/docs/`), and keeping a
 * document's identity (its KDM document id) on its path as files are renamed, moved, deleted, and copied.
 *
 * The `.md` file is the document; the store only adds editing history. So every store failure degrades to
 * importing the file again (a new identity, no history) and never blocks reading or writing the file.
 */
import { Replica, type ObjectId, type Origin } from '@/lib/kdm'
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

// --- Open -------------------------------------------------------------------

type Loaded = { replica: Replica; rootId: ObjectId; meta: DocumentStoreMeta }

/** The stored replica of `docId`, or `null` when it is missing, damaged, or not this document. */
async function loadStored(docId: string, actor: bigint, options?: Options): Promise<Loaded | null> {
  let entry
  try {
    entry = await readDocumentStore(docId, storeOptions(options))
  } catch (error) {
    if (isWorkspaceChanged(error)) throw error
    warn('could not read a document store entry', error)
    return null
  }
  if (!entry || entry.meta?.docId !== docId || entry.meta.kit !== DOCUMENT_KIT || typeof entry.meta.fileHash !== 'string') return null
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

/**
 * A stored document whose file was renamed or moved outside Kition: an index entry whose path no longer exists
 * and whose last saved file had this file's hash. Rebinds it to `path`.
 */
async function recogniseRenamed(path: string, fileHash: string, entries: Record<string, string>, actor: bigint, options?: Options): Promise<Loaded | null> {
  const others = Object.entries(entries).filter(([entryPath]) => entryPath !== path)
  if (others.length === 0) return null
  let existing: Set<string>
  try {
    const workspace = await listWorkspaceDocuments()
    if (options?.expectedRoot && workspace.root_path !== options.expectedRoot) return null
    existing = filePaths(workspace.items)
  } catch (error) {
    warn('could not list the workspace to recognise a renamed document', error)
    return null
  }
  const liveDocIds = new Set(others.filter(([entryPath]) => existing.has(entryPath)).map(([, docId]) => docId))
  for (const [oldPath, docId] of others) {
    if (existing.has(oldPath) || liveDocIds.has(docId)) continue
    const loaded = await loadStored(docId, actor, options)
    if (!loaded || loaded.meta.fileHash !== fileHash) continue
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
  let meta: DocumentStoreMeta = { ...loaded.meta, path }
  if (meta.fileHash !== fileHash) {
    // What this machine last saved is what the replica holds (edits are saved from an open session), so the
    // replica's text is the base, and merging makes the replica the file's text in small edits.
    const body = documentBody(replica, rootId)
    merged = replica.transact(FILE_IMPORT_ORIGIN, (tx) => mergeExternalText(tx, rootId, body, text, body)) === 'merged'
    meta = makeMeta(replica, path, fileHash, null, style)
    try {
      await storeReplica(replica, meta, options)
    } catch (error) {
      if (isWorkspaceChanged(error)) throw error
      warn('could not store a document after merging its file', error)
    }
  }
  return { replica, rootId, meta, style, fileText, isNew: false, merged }
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
  expectedFileText: string
  expectedRoot?: string
  onStoreError?: (error: unknown) => void
}): Promise<SavedDocument> {
  const { path, opened, expectedFileText } = input
  const fileText = renderText(documentBody(opened.replica, opened.rootId), opened.style)
  const root = input.expectedRoot || (await listWorkspaceDocuments()).root_path
  const written = await writeWorkspaceDocument(path, fileText, { expected_root: root, expected_content: expectedFileText })
  const stamp = written?.mtime_ms !== undefined ? String(written.mtime_ms) : (written?.updated_at ?? null)
  const meta = makeMeta(opened.replica, path, await hashFileText(fileText), stamp, opened.style)
  try {
    await storeReplica(opened.replica, meta, { expectedRoot: root })
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

/** The file at `path` (and its child pages) was deleted: forgets their ids and deletes their stored replicas. */
export async function forgetDocument(path: string, options?: Options): Promise<void> {
  if (!path) return
  const prefix = `${childFolderPath(path)}/`
  const change = await updateIndex((entries) => removeEntries(entries, (entry) => entry === path || entry.startsWith(prefix)), options)
  await dropUnreferenced(change, options)
}

/** The folder was deleted: forgets the ids of the documents inside it and deletes their stored replicas. */
export async function forgetDocumentFolder(folder: string, options?: Options): Promise<void> {
  if (!folder) return
  const change = await updateIndex((entries) => removeEntries(entries, (entry) => entry.startsWith(`${folder}/`)), options)
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
