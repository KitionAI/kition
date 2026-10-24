/**
 * Opening and saving Markdown documents through their private replica store (`.kition/docs/`). A document's
 * identity (its KDM document id) on its path is the store's index (`@/lib/docstore/documentIndex`).
 *
 * The `.md` file is the document; the store only adds editing history. So every store failure degrades to
 * importing the file again (a new identity, no history) and never blocks reading or writing the file.
 */
import { randomActor, Replica, Version, type ObjectId, type Origin } from '@/lib/kdm'
import {
  appendDocumentStore,
  isDocumentStoreConflict,
  listWorkspaceDocuments,
  readDocumentIndex,
  readDocumentStore,
  writeDocumentStore,
  writeWorkspaceDocument,
  type DocumentCheckpointInput,
  type DocumentStoreMeta,
  type DocumentStoreWritten,
} from '@/services/desktop'
import { dropUnreferenced, isWorkspaceChanged, knownWorkspaceFiles, listFiles, orphans, storeOptions, updateIndex, withEntry, type DocumentIndexOptions } from '@/lib/docstore/documentIndex'
import { DOCUMENT_KIT, documentSchema } from '@kition/document-editor/model'
import { analyzeText, createDocumentReplica, documentBody, documentRootId, renderText, type LineStyle } from '@kition/document-editor/model'
import { mergeExternalText } from '@kition/document-editor/model'

/** The origin of file imports and merges of external changes (not undo steps). */
export const FILE_IMPORT_ORIGIN: Origin = { kind: 'import', principal: 'file' }

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
  /** What the store holds of this replica, so a save appends only what is new; `null`: write a snapshot. */
  stored?: StoredVersion | null
}

/**
 * The replica version the store holds (`seq`, `version`), the `seq` of its snapshot (the changes after it are due for
 * compaction on close), and whether the store asked for a compaction.
 */
export type StoredVersion = { seq: number; version: Version; snapshotSeq: number; compact: boolean }

export type SavedDocument = { fileText: string; meta: DocumentStoreMeta }

type Options = DocumentIndexOptions

function warn(message: string, error: unknown) {
  console.warn(`[document-store] ${message}`, error)
}

// --- Helpers --------------------------------------------------------------

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

function makeMeta(replica: Replica, path: string, fileHash: string, fileStamp: string | null, style: LineStyle): DocumentStoreMeta {
  return { docId: replica.docId, kit: DOCUMENT_KIT, path, fileHash, fileStamp, exported: versionHex(replica), style: { ...style } }
}

function storedAfter(written: DocumentStoreWritten | null, version: Version, snapshotSeq?: number): StoredVersion | null {
  if (!written) return null
  return { seq: written.seq, version, snapshotSeq: snapshotSeq ?? written.seq, compact: written.compact }
}

/** Writes the replica as a whole snapshot; answers what the store then holds. */
async function storeReplica(replica: Replica, meta: DocumentStoreMeta, options?: Options & { checkpoint?: DocumentCheckpointInput }): Promise<StoredVersion | null> {
  const version = replica.version()
  const written = await writeDocumentStore(meta.docId, { meta, snapshot: replica.snapshot() }, { ...storeOptions(options), version: versionHex(replica), ...(options?.checkpoint ? { checkpoint: options.checkpoint } : {}) })
  return storedAfter(written, version)
}

// --- Open -------------------------------------------------------------------

type Loaded = { replica: Replica; rootId: ObjectId; meta: DocumentStoreMeta; stored: StoredVersion | null }

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
    // The snapshot, then the changes saved after it, in order.
    const replica = Replica.load(documentSchema, entry.snapshot, actor)
    if (replica.docId !== docId) return null
    const changes = entry.changes ?? []
    for (const change of changes) replica.importChanges(change)
    // A store that lost a change it named is not appended to: the next save writes a snapshot.
    const stored = typeof entry.seq === 'number' && entry.complete !== false && !replica.hasPendingChanges()
      ? { seq: entry.seq, version: replica.version(), snapshotSeq: entry.seq - changes.length, compact: false }
      : null
    return { replica, rootId: documentRootId(replica), meta: entry.meta, stored }
  } catch (error) {
    warn('a document store entry is damaged', error)
    return null
  }
}

/**
 * A stored document whose file was renamed or moved outside Kition (or deleted and restored): an index entry
 * whose path no longer exists and whose last saved file had this file's hash. Rebinds it to `path`. The known
 * files spare listing the workspace; a match they suggest is checked against a fresh listing before it is taken.
 */
async function recogniseRenamed(path: string, fileHash: string, entries: Record<string, string>, actor: bigint, options?: Options): Promise<Loaded | null> {
  const others = Object.entries(entries).filter(([entryPath]) => entryPath !== path)
  if (others.length === 0) return null
  const known = knownWorkspaceFiles(options?.expectedRoot)
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
  let stored: StoredVersion | null = null
  try {
    stored = await storeReplica(replica, meta, options)
    const change = await updateIndex(withEntry(path, meta.docId), options)
    if (replaced) await dropUnreferenced(change, options)
  } catch (error) {
    if (isWorkspaceChanged(error)) throw error
    warn('could not record an imported document in the store', error)
  }
  return { replica, rootId, meta, style, fileText, isNew: true, merged: false, stored }
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
  let stored = loaded.stored
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
      stored = await storeReplica(replica, meta, options)
    } catch (error) {
      if (isWorkspaceChanged(error)) throw error
      warn('could not store a document after merging its file', error)
      stored = null
    }
  }
  return { replica, rootId, meta, style, fileText, isNew: false, merged, stored, ...(previousText === undefined ? {} : { previousText }) }
}

// --- Save -------------------------------------------------------------------

/**
 * Writes the replica's text, rendered with `style`, to the `.md` file, guarded by `expectedFileText` (what the
 * file held when last read or written), then stores the replica. A guard conflict propagates unchanged; a store
 * failure after the file was written goes to `onStoreError` (the text is safe in the file).
 */
export async function saveDocument(input: {
  path: string
  opened: Pick<OpenedDocument, 'replica' | 'rootId' | 'meta' | 'style' | 'stored'>
  /** What the file holds now; `null` when there must be no file (it is written again after it was deleted). */
  expectedFileText: string | null
  expectedRoot?: string
  onStoreError?: (error: unknown) => void
  /** Records a checkpoint in the document's history with this save. */
  checkpoint?: DocumentCheckpointInput
  /** Writes a whole snapshot (compacts the change log), as when the document closes. */
  compact?: boolean
}): Promise<SavedDocument> {
  const { path, opened, expectedFileText } = input
  // The text, the stored bytes, and the version are taken together, before anything is awaited: edits made while the
  // file is written are not in it, so the store must not hold them either (a later discard would resurrect them).
  // Only the changes since what the store holds are written (rule P5), unless it is due for a compaction.
  const fileText = renderText(documentBody(opened.replica, opened.rootId), opened.style)
  const version = opened.replica.version()
  const exported = versionHex(opened.replica)
  const stored = opened.stored ?? null
  const append = stored && !stored.compact && !input.compact && version.includes(stored.version)
    ? { changes: opened.replica.exportChanges(stored.version), baseSeq: stored.seq, snapshotSeq: stored.snapshotSeq }
    : null
  const snapshot = append ? null : opened.replica.snapshot()
  const style = { ...opened.style }
  const root = input.expectedRoot || (await listWorkspaceDocuments()).root_path
  const guard = expectedFileText === null
    ? { expected_root: root, expected_content: null, expected_missing: true }
    : { expected_root: root, expected_content: expectedFileText }
  const written = await writeWorkspaceDocument(path, fileText, guard)
  const stamp = written?.mtime_ms !== undefined ? String(written.mtime_ms) : (written?.updated_at ?? null)
  const meta: DocumentStoreMeta = { ...makeMeta(opened.replica, path, await hashFileText(fileText), stamp, style), exported }
  const options = { ...storeOptions({ expectedRoot: root }), version: exported, ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}) }
  try {
    if (append) {
      opened.stored = storedAfter(await appendDocumentStore(meta.docId, { meta, changes: append.changes, baseSeq: append.baseSeq }, options), version, append.snapshotSeq)
    } else if (snapshot) {
      opened.stored = storedAfter(await writeDocumentStore(meta.docId, { meta, snapshot }, options), version)
    }
  } catch (error) {
    // The store is elsewhere (another writer) or not writable: the next save writes a whole snapshot.
    opened.stored = null
    if (isDocumentStoreConflict(error)) warn('the document store moved on; the next save stores a snapshot', error)
    else if (input.onStoreError) input.onStoreError(error)
    else warn('could not store a saved document', error)
  }
  return { fileText, meta }
}

/**
 * Folds the changes saved since the stored snapshot into a new snapshot (on a clean close), when the store holds
 * exactly what the replica holds. Best effort: the changes stay readable when it fails.
 */
export async function compactStoredDocument(opened: Pick<OpenedDocument, 'replica' | 'meta' | 'stored'>, options?: Options): Promise<void> {
  const stored = opened.stored
  if (!stored || stored.seq === stored.snapshotSeq || !opened.replica.version().equals(stored.version)) return
  try {
    opened.stored = await storeReplica(opened.replica, opened.meta, options)
  } catch (error) {
    if (!isWorkspaceChanged(error)) warn('could not compact a document in the store', error)
  }
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

