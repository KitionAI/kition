/**
 * The identity index of the workspace's document store (`.kition/docs/`): which document id (KDM document id) each
 * workspace file has, kept on the file's path as files are renamed, moved, deleted, restored, and copied, for every
 * editor that keeps a replica beside a file (kits, through `host/replicaRead` and `host/replicaWrite`). Index
 * failures never block reading or writing a file.
 */
import {
  deleteDocumentStore,
  isDocumentIndexConflict,
  listWorkspaceDocuments,
  readDocumentIndex,
  recordDocumentCheckpoint,
  writeDocumentIndex,
  type DocumentCheckpointInput,
  type DocumentStoreOptions,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'

/** How often an index update re-reads and retries after another writer changed the index. */
const INDEX_RETRIES = 3
const WORKSPACE_CHANGED = 'DESIGN_WORKSPACE_CHANGED'

/** `expectedRoot`: the workspace the caller works in; a write to another one is refused. */
export type DocumentIndexOptions = { expectedRoot?: string }
type Options = DocumentIndexOptions

export function storeOptions(options?: Options): DocumentStoreOptions | undefined {
  return options?.expectedRoot ? { expectedRoot: options.expectedRoot } : undefined
}

export function isWorkspaceChanged(error: unknown) {
  return String((error as { message?: unknown } | null)?.message ?? error ?? '').includes(WORKSPACE_CHANGED)
}

function warn(message: string, error: unknown) {
  console.warn(`[document-store] ${message}`, error)
}

/** The workspace path of the folder that holds a file's child pages: its path without the extension. */
export function childFolderPath(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? path.slice(0, slash + 1) + name.slice(0, dot) : path
}

// --- The index ------------------------------------------------------------

let indexQueue: Promise<unknown> = Promise.resolve()

/** Runs index updates of this window one after another, so they do not conflict with each other. */
function queued<T>(task: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(task, task)
  indexQueue = run.catch(() => undefined)
  return run
}

export type IndexChange = { before: Record<string, string>; after: Record<string, string> }

/**
 * Applies `change` to the index with a guarded write; `change` answers the new entries, or `null` for no change.
 * On a conflict (another writer changed the index meanwhile) it re-reads and applies `change` again.
 */
export function updateIndex(change: (entries: Record<string, string>) => Record<string, string> | null, options?: Options): Promise<IndexChange | null> {
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
export async function dropUnreferenced(change: IndexChange | null, options?: Options) {
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
export const withEntry = (path: string, docId: string) => (entries: Record<string, string>) => {
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

/** The workspace's files as last listed or noted for `root`, or `null` when none are known for it. */
export function knownWorkspaceFiles(root: string | undefined): Set<string> | null {
  return root && knownFiles?.root === root ? knownFiles.paths : null
}

/** Lists the workspace's files now (and keeps them as the known files); `null` when that fails or the root changed. */
export async function listFiles(options?: Options): Promise<Set<string> | null> {
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
export function orphans(others: [string, string][], existing: Set<string>): [string, string][] {
  const live = new Set(others.filter(([entryPath]) => existing.has(entryPath)).map(([, docId]) => docId))
  return others.filter(([entryPath, docId]) => !existing.has(entryPath) && !live.has(docId))
}

// --- Document ids -------------------------------------------------------------

/**
 * The document id the index keeps for the file at `path`, recording `mint()`'s there when it has none: for the
 * replicas editors keep in the store (a kit's, for a file that cannot carry one), whose identity then follows the
 * file's renames and moves.
 */
export async function bindDocumentId(path: string, mint: () => string, options?: Options): Promise<string> {
  let docId = ''
  await updateIndex((entries) => {
    docId = entries[path] ?? mint()
    return withEntry(path, docId)(entries)
  }, options)
  return docId
}

/**
 * Records a checkpoint in the version history of the file at `path` under the file's identity: for documents whose
 * file holds their replica (boards), so the history names only the version. Best effort.
 */
export async function recordFileCheckpoint(path: string, input: DocumentCheckpointInput, options?: Options): Promise<void> {
  try {
    const docId = await bindDocumentId(path, () => crypto.randomUUID(), options)
    await recordDocumentCheckpoint(docId, input, storeOptions(options))
  } catch (error) {
    if (!isWorkspaceChanged(error)) warn('could not record a checkpoint', error)
  }
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
