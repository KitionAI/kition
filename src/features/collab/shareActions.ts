/**
 * Sharing a kit document for co-editing, and opening a document someone shared.
 *
 * **Share.** The document is saved first, so its file and the replica stored with it carry the
 * document's KDM identity (`docId`), then its whole history (`replica/export` from nothing) is the
 * room's snapshot; the export's blobs are uploaded before the room is made. The room is recorded
 * (`rooms.ts`), which starts the document's relay.
 *
 * **Open shared.** The link names the room (`room/open`); its snapshot and the blobs it references
 * come from the server. Kition makes the file `Shared/<name>` from them with the kit's engine in a
 * worker (`writeKitFileFromReplica`: the replica opens with no file bytes, is saved as the file's
 * format, and the replica it saved with is stored under the new file's stamp), so the kit's editor
 * opens the file as that same replica, and the relay joins its room.
 */
import { createWorkspaceFolder, listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'
import { KITION_KIT_HOST, mountedKitDocument, writeKitFileFromReplica, type KitSdkManifest } from '@/features/kits/public'
import type { SyncClient } from '@/lib/sync'
import { blobHashCandidates, decodeBlobSection, encodeBlobSection, type BlobEntry } from './blobSection'
import { readRoom, toHex, writeRoom } from './rooms'
import { onlineSyncClient } from './syncConnection'

/** The folder documents opened from a share link go to. */
const SHARED_FOLDER = 'Shared'

/** Whether the document at `path` is open in a kit editor that can be co-edited. */
export function canShareKitDocument(path: string) {
  return Boolean(mountedKitDocument(path)?.connection.capabilities.includes('replica'))
}

async function uploadBlobs(client: SyncClient, entries: BlobEntry[]) {
  if (!entries.length) return
  const { missing } = await client.blobs.has(entries.map((entry) => entry.hash))
  const absent = new Set(missing)
  for (const entry of entries) if (absent.has(entry.hash)) await client.blobs.put(entry.data, 'application/octet-stream')
}

/** Makes a room for the document open at `path` (or answers its existing link); answers the share link. */
export async function shareKitDocument(path: string): Promise<string> {
  const document = mountedKitDocument(path)
  if (!document?.connection.capabilities.includes('replica')) throw new Error(`${path} cannot be co-edited`)
  const client = await onlineSyncClient()
  const { connection } = document
  await connection.save()
  // Asking for the version makes the replica when the document has none yet.
  const version = new Uint8Array(await connection.replica.version())
  const docId = await connection.replica.info()
  if (!docId) throw new Error(`${path} has no replica to share`)
  const existing = readRoom(docId)
  if (existing) return existing.shareLink
  const exported = await connection.replica.exportChanges(new ArrayBuffer(0))
  await uploadBlobs(client, decodeBlobSection(new Uint8Array(exported.blobs)))
  const name = path.split('/').filter(Boolean).pop() || path
  const { shareLink } = await client.createRoom(docId, new Uint8Array(exported.changes), name, document.kitId)
  writeRoom({ docId, shareLink, name, kit: document.kitId, role: 'owner', lastSent: toHex(version) })
  return shareLink
}

/** What Kition knows of a kit to open its shared documents: its engine, and its file extension. */
export type SharedKit = { engine: KitSdkManifest; extension: string }

function folderExists(items: readonly WorkspaceDocumentTreeItem[], path: string) {
  return items.some((item) => item.type === 'folder' && item.path === path)
}

function hasPath(items: readonly WorkspaceDocumentTreeItem[], path: string): boolean {
  return items.some((item) => item.path === path || (item.children ? hasPath(item.children, path) : false))
}

/** `Shared/<name>`, numbered when that exists; makes the folder when it is missing. */
async function sharedPath(name: string, extension: string) {
  const { items } = await listWorkspaceDocuments()
  if (!folderExists(items, SHARED_FOLDER)) await createWorkspaceFolder({ parent_folder: '', name: SHARED_FOLDER })
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Shared document'
  const dot = clean.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot + 1)] : [clean, extension]
  for (let number = 1; number < 1000; number += 1) {
    const candidate = `${SHARED_FOLDER}/${stem}${number === 1 ? '' : ` ${number}`}.${ext}`
    if (!hasPath(items, candidate) && (await KITION_KIT_HOST.stamp(candidate)) == null) return candidate
  }
  throw new Error(`no free name for ${name} in ${SHARED_FOLDER}`)
}

/** The blobs a replica snapshot references that the server holds. */
async function snapshotBlobs(client: SyncClient, snapshot: Uint8Array) {
  const candidates = blobHashCandidates(snapshot)
  if (!candidates.length) return new Uint8Array()
  const { missing } = await client.blobs.has(candidates)
  const absent = new Set(missing)
  const entries: BlobEntry[] = []
  for (const hash of candidates) if (!absent.has(hash)) entries.push({ hash, data: (await client.blobs.get(hash)).data })
  return encodeBlobSection(entries)
}

/**
 * Opens a share link: answers the workspace file the shared document is in here, made the first
 * time (in `Shared/`), or the one an earlier open made. `kitFor` names what Kition knows of the
 * room's kit, or `null` for a kit this build does not have.
 */
export async function openSharedDocument(link: string, kitFor: (kitId: string) => SharedKit | null): Promise<string> {
  const client = await onlineSyncClient()
  const room = await client.openRoom(link.trim())
  const known = readRoom(room.docId)
  if (known?.path && (await KITION_KIT_HOST.stamp(known.path)) != null) return known.path
  const kit = kitFor(room.kit)
  if (!kit) throw new Error(`this build cannot open ${room.kit} documents`)
  const { snapshot } = await client.snapshot(room.docId)
  const blobs = await snapshotBlobs(client, snapshot)
  const path = await sharedPath(room.name, kit.extension)
  const { version } = await writeKitFileFromReplica(kit.engine, path, { snapshot, blobs })
  writeRoom({ docId: room.docId, shareLink: link.trim(), name: room.name, kit: room.kit, role: room.role, lastSent: toHex(version), path })
  return path
}
