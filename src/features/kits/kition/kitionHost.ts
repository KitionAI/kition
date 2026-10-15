import { writeKitFile } from '@/api/kits'
import { loadDocumentStore } from '@/features/document/public'
import { readDocumentIndex, readDocumentStore, writeDocumentStore, type KitReplicaMeta } from '@/services/desktop'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import { stampFromHeaders, type KitHost } from '../sdk/kitHost'
import type { StoredReplica } from '../host/mountKit'

/** Kition's workspace as a kit host: files over the loopback API, saves through `PUT /v1/kits/files`. */
export const KITION_KIT_HOST: KitHost = {
  read: async (path) => {
    const response = await fetch(resolveWorkspaceFileURL(path), { cache: 'no-store' })
    if (!response.ok) throw new Error(`could not read ${path} (${response.status})`)
    return { bytes: await response.arrayBuffer(), stamp: stampFromHeaders(response.headers) }
  },
  stamp: async (path) => {
    const response = await fetch(resolveWorkspaceFileURL(path), { method: 'HEAD', cache: 'no-store' })
    return response.ok ? stampFromHeaders(response.headers) : null
  },
  write: async (path, bytes) => {
    await writeKitFile(path, bytes)
  },
  // The workspace file server answers ranged reads; workers need an absolute URL.
  lend: (path) => {
    const root = new URL(resolveWorkspaceFileURL('_').replace(/_$/, ''), window.location.href).href
    return { root, folder: path.split('/').filter(Boolean).slice(0, -1).join('/') }
  },
}

/** A copy of `bytes` in an ArrayBuffer of its own, as the Kit UI protocol carries binary data. */
function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

/**
 * The replica `kitId`'s editor keeps for the workspace file at `path` (Kit UI protocol capability `replica`), from
 * the document store (`.kition/docs/`), or `null`. The document store's index names it, so it follows the file's
 * renames and moves; the kit checks that it still belongs to the file (its `fileStamp`).
 */
export async function readKitReplica(path: string, kitId: string): Promise<StoredReplica | null> {
  const docId = (await readDocumentIndex()).entries[path]
  if (!docId) return null
  const entry = await readDocumentStore<KitReplicaMeta>(docId)
  const meta = entry?.meta
  if (!entry?.blobs || meta?.kit !== kitId || meta.docId !== docId || typeof meta.fileStamp !== 'string') return null
  return { snapshot: buffer(entry.snapshot), blobs: buffer(entry.blobs), fileStamp: meta.fileStamp }
}

/** Stores the replica `kitId`'s editor saved with the workspace file at `path`, under the file's identity. */
export async function writeKitReplica(path: string, kitId: string, replica: StoredReplica): Promise<void> {
  const store = await loadDocumentStore()
  const docId = await store.bindDocumentId(path, () => crypto.randomUUID())
  const meta: KitReplicaMeta = { docId, kit: kitId, path, fileStamp: replica.fileStamp }
  await writeDocumentStore(docId, { meta, snapshot: new Uint8Array(replica.snapshot), blobs: new Uint8Array(replica.blobs) })
}
