import { writeKitFile } from '@/api/kits'
import { bindDocumentId } from '@/lib/docstore/documentIndex'
import { readDocumentIndex, readDocumentStore, uint8ArrayToBase64, writeDocumentStore, type DocumentCheckpointInput, type KitReplicaMeta } from '@/services/desktop'
import { resolveKitFilesRootURL, resolveKitFileURL, resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import { stampFromHeaders, type KitHost } from '../engine/kitHost'
import type { KitCheckpoint, StoredReplica, WrittenReplica } from '@kition/sdk/host'
import { saveFailureText } from './kitFailures'
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
  // A failed write tells the kit why in plain words (the system's error goes to the console).
  write: async (path, bytes) => {
    try {
      await writeKitFile(path, bytes)
    } catch (error) {
      throw new Error(saveFailureText(error))
    }
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

/**
 * The replica `kitId`'s editor keeps for the workspace file at `path` (Kit UI protocol capability `replica`), from
 * the document store (`.kition/docs/`), or `null`. The document store's index names it, so it follows the file's
 * renames and moves. It is handed over whatever the file's stamp (UI-R1): the kit opens the file with it and records a
 * file that differs as one change. The host never reads the snapshot's bytes.
 */
export async function readKitReplica(path: string, kitId: string): Promise<StoredReplica | null> {
  const docId = (await readDocumentIndex()).entries[path]
  if (!docId) return null
  const entry = await readDocumentStore(docId)
  const meta = entry?.meta
  if (!entry?.blobs || meta?.kit !== kitId || meta.docId !== docId || typeof meta.fileStamp !== 'string') return null
  return { snapshot: buffer(entry.snapshot), blobs: buffer(entry.blobs), fileStamp: meta.fileStamp }
}

/**
 * Stores the replica `kitId`'s editor saved with the workspace file at `path`, under the file's identity: the snapshot
 * whole, as opaque bytes, with `replica.version`, the version it holds (UI-R6), which the store compares as bytes (a
 * write at the newest checkpoint's version answers that checkpoint). `checkpoint` records the save in the history,
 * keeping this snapshot, and the answer names it as a kit sees it (`host/replicaWrite`).
 */
export async function writeKitReplica(path: string, kitId: string, replica: WrittenReplica, options: { checkpoint?: DocumentCheckpointInput } = {}): Promise<{ checkpoint?: KitCheckpoint }> {
  const docId = await bindDocumentId(path, () => crypto.randomUUID())
  const meta: KitReplicaMeta = { docId, kit: kitId, path, fileStamp: replica.fileStamp }
  const written = await writeDocumentStore(
    docId,
    { meta, snapshot: new Uint8Array(replica.snapshot), version: uint8ArrayToBase64(new Uint8Array(replica.version)), blobs: new Uint8Array(replica.blobs) },
    options.checkpoint ? { checkpoint: options.checkpoint } : {},
  )
  return written.checkpoint ? { checkpoint: written.checkpoint } : {}
}
