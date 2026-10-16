import { KitEngine } from '../sdk/kitEngine'
import type { KitSdkManifest } from '../sdk/kitSdk'
import { KITION_KIT_HOST, writeKitReplica } from './kitionHost'

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

/**
 * Makes the workspace file `path` from a KDM replica alone (a document shared with this person,
 * from its sync room's snapshot and blobs): the kit's engine opens the replica in a worker with no
 * file bytes, saves it as the file's format, and the replica it saved with goes to the document
 * store under the written file's stamp, so the kit's editor then opens the file as that same
 * replica (same document id). Answers the replica's version as saved.
 */
export async function writeKitFileFromReplica(manifest: KitSdkManifest, path: string, replica: { snapshot: Uint8Array; blobs: Uint8Array }) {
  const name = path.split('/').filter(Boolean).pop() || path
  const engine = await KitEngine.open(manifest, name, new ArrayBuffer(0), KITION_KIT_HOST.lend?.(path) ?? null, { snapshot: buffer(replica.snapshot), blobs: buffer(replica.blobs) })
  try {
    const bytes = await engine.save()
    const snapshot = await engine.invoke<Uint8Array>('snapshot')
    const blobs = await engine.invoke<Uint8Array>('blobs')
    const version = await engine.invoke<Uint8Array>('version')
    await KITION_KIT_HOST.write(path, bytes)
    const fileStamp = await KITION_KIT_HOST.stamp(path)
    if (!fileStamp) throw new Error(`could not read back ${path}`)
    await writeKitReplica(path, manifest.kitId, { snapshot: buffer(snapshot), blobs: buffer(blobs), fileStamp })
    return { version }
  } finally {
    engine.dispose()
  }
}
