import { writeKitFile } from '@/api/kits'
import { bindDocumentId } from '@/lib/docstore/documentIndex'
import {
  appendDocumentStore,
  isDocumentStoreConflict,
  readDocumentIndex,
  readDocumentStore,
  readDocumentStoreHead,
  writeDocumentStore,
  type DocumentCheckpointInput,
  type KitReplicaMeta,
} from '@/services/desktop'
import { resolveKitFilesRootURL, resolveKitFileURL, resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import { stampFromHeaders, type KitHost } from '../sdk/kitHost'
import type { StoredReplica } from '../host/mountKit'
import { runtimeFetch } from '@/services/runtimeAuth'

/**
 * Whether the app's own page answered instead of the runtime's file service: the web preview runs
 * no runtime, and its server answers any path with the app.
 */
function answeredWithTheApp(response: Response, url: string, path: string) {
  const sameOrigin = typeof window !== 'undefined' && new URL(response.url || url, window.location.href).origin === window.location.origin
  return sameOrigin && /text\/html/i.test(response.headers.get('content-type') ?? '') && !/\.html?$/i.test(path)
}

async function readFile(url: string, path: string) {
  const response = await runtimeFetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`could not read ${path} (${response.status})`)
  if (answeredWithTheApp(response, url, path)) throw new Error("Kits read files through Kition's runtime, which the web preview does not run.")
  return { bytes: await response.arrayBuffer(), stamp: stampFromHeaders(response.headers) }
}

async function stampFile(url: string) {
  const response = await runtimeFetch(url, { method: 'HEAD', cache: 'no-store' })
  return response.ok ? stampFromHeaders(response.headers) : null
}

/**
 * Kition's workspace as a kit host: files over the loopback API, new files through
 * `PUT /v1/kits/files`. Kition reads its own files, and the documents it opens in kits, through
 * the workspace file service; kits' engines read the files their documents name (lent files)
 * through the kit file service, which never serves hidden paths or `.kition/` (rule LR2).
 */
export const KITION_KIT_HOST: KitHost = {
  read: (path) => readFile(resolveWorkspaceFileURL(path), path),
  stamp: (path) => stampFile(resolveWorkspaceFileURL(path)),
  write: async (path, bytes) => {
    await writeKitFile(path, bytes)
  },
  // The kit file server answers ranged reads; workers need an absolute URL. The root is signed
  // for the kit file service only (a kit is never given the API token).
  lend: (path) => {
    const root = new URL(resolveKitFilesRootURL(), window.location.href).href
    return { root, folder: path.split('/').filter(Boolean).slice(0, -1).join('/') }
  },
}

/** A workspace file a kit reads (`host/read`), through the kit file service (rule LR2). */
export const readKitFile = (path: string) => readFile(resolveKitFileURL(path), path)

/** The stamp of a workspace file a kit asks after (`host/stamp`), through the kit file service (rule LR2). */
export const stampKitFile = (path: string) => stampFile(resolveKitFileURL(path))

/** A copy of `bytes` in an ArrayBuffer of its own, as the Kit UI protocol carries binary data. */
function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

const loadReplicaBytes = () => import('@/lib/replicaHistory/replicaBytes')

/** The documents whose stored change log is due for compaction (the store asked), by document id. */
const compactDue = new Set<string>()
/** The replica a kit last stored as appended changes, by path: what a clean close compacts into a snapshot. */
const appended = new Map<string, { docId: string; kitId: string; replica: StoredReplica; version: string }>()

/**
 * The replica `kitId`'s editor keeps for the workspace file at `path` (Kit UI protocol capability `replica`), from
 * the document store (`.kition/docs/`), or `null`. The document store's index names it, so it follows the file's
 * renames and moves; the kit checks that it still belongs to the file (its `fileStamp`). The store keeps a snapshot and
 * the changes saved after it; the kit gets them as one snapshot.
 */
export async function readKitReplica(path: string, kitId: string): Promise<StoredReplica | null> {
  const docId = (await readDocumentIndex()).entries[path]
  if (!docId) return null
  const entry = await readDocumentStore<KitReplicaMeta>(docId)
  const meta = entry?.meta
  if (!entry?.blobs || meta?.kit !== kitId || meta.docId !== docId || typeof meta.fileStamp !== 'string') return null
  // A store that lost a change it named holds an older replica than the file: open the file plainly.
  if (entry.complete === false) return null
  let snapshot = entry.snapshot
  if (entry.changes?.length) {
    try {
      snapshot = (await loadReplicaBytes()).mergeReplica(entry.snapshot, entry.changes).bytes
    } catch (error) {
      console.warn('[kit] could not read the stored replica', error)
      return null
    }
  }
  return { snapshot: buffer(snapshot), blobs: buffer(entry.blobs), fileStamp: meta.fileStamp }
}

/**
 * Stores the replica `kitId`'s editor saved with the workspace file at `path`, under the file's identity. When it
 * continues the stored replica only its new changes are appended (rule P5); a replica made anew (the file changed
 * elsewhere) replaces it and starts its version history over. `checkpoint` records the save in that history.
 */
export async function writeKitReplica(path: string, kitId: string, replica: StoredReplica, options: { checkpoint?: DocumentCheckpointInput } = {}): Promise<void> {
  const docId = await bindDocumentId(path, () => crypto.randomUUID())
  const snapshot = new Uint8Array(replica.snapshot)
  const blobs = new Uint8Array(replica.blobs)
  let replicaId: string | undefined
  let version: string | undefined
  let delta: { changes: Uint8Array; baseSeq: number } | null = null
  let newLineage = false
  try {
    const bytes = await loadReplicaBytes()
    replicaId = bytes.replicaIdOf(snapshot)
    const head = await readDocumentStoreHead<KitReplicaMeta>(docId)
    if (head && head.meta.kit === kitId && head.meta.replicaId) {
      if (head.meta.replicaId !== replicaId) {
        newLineage = true
      } else if (head.seq !== null && head.version && !compactDue.has(docId)) {
        const found = bytes.changesSince(snapshot, bytes.fromHex(head.version), replicaId)
        if (found) delta = { changes: found.changes, baseSeq: head.seq }
        else newLineage = true
      }
    }
    version = bytes.toHex(bytes.versionOf([snapshot]))
  } catch {
    // Not KDM bytes the store can follow: it keeps them whole.
    replicaId = undefined
  }
  const meta: KitReplicaMeta = { docId, kit: kitId, path, fileStamp: replica.fileStamp, ...(replicaId ? { replicaId } : {}) }
  const writeOptions = { ...(version ? { version } : {}), ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}) }
  if (delta) {
    try {
      const written = await appendDocumentStore(docId, { meta, changes: delta.changes, baseSeq: delta.baseSeq, blobs }, writeOptions)
      if (written.compact) compactDue.add(docId)
      appended.set(path, { docId, kitId, replica, version: version ?? '' })
      return
    } catch (error) {
      if (!isDocumentStoreConflict(error)) throw error
    }
  }
  await writeDocumentStore(docId, { meta, snapshot, blobs }, { ...writeOptions, ...(newLineage ? { lineage: 'new' as const } : {}) })
  compactDue.delete(docId)
  appended.delete(path)
}

/**
 * Folds the changes a kit appended for `path` into one snapshot, when its editor closes (best effort): the store then
 * opens the replica without replaying them.
 */
export async function compactKitReplica(path: string): Promise<void> {
  const last = appended.get(path)
  if (!last) return
  appended.delete(path)
  try {
    const head = await readDocumentStoreHead<KitReplicaMeta>(last.docId)
    // Only what the store holds now: never a replica another save replaced meanwhile.
    if (!head || head.version !== last.version || head.meta.path !== path) return
    await writeDocumentStore(last.docId, { meta: head.meta, snapshot: new Uint8Array(last.replica.snapshot), blobs: new Uint8Array(last.replica.blobs) }, { version: last.version })
    compactDue.delete(last.docId)
  } catch (error) {
    console.warn('[kit] could not compact the stored replica', error)
  }
}
