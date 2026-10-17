/**
 * Sharing a document for co-editing, and opening a document someone shared: kit documents, boards,
 * Markdown documents, and tables alike (`collabDocuments.ts`).
 *
 * **Share.** The document is saved first, so its file and the replica stored with it carry the
 * document's KDM identity (`docId`), then its whole history (an export from nothing) is the
 * room's snapshot; the export's blobs are uploaded before the room is made. The room is recorded
 * (`rooms.ts`), which starts the document's relay. A view-only link to the same room can be made
 * next to it (`shareViewOnlyLink`).
 *
 * **Open shared.** The link names the room (`room/open`); its snapshot and the blobs it references
 * come from the server, and Kition makes the file `Shared/<name>` from them: a kit document with
 * the kit's engine in a worker (`writeKitFileFromReplica`: the replica opens with no file bytes,
 * is saved as the file's format, and the replica it saved with is stored under the new file's
 * stamp), a board, Markdown document, or table by its own editor's means, each as that same
 * replica, so its editor opens the file as it and the relay joins its room.
 */
import { createTableFromReplica } from '@/api/dataDocumentsReplica'
import { loadDocumentStore } from '@/features/document/public'
import { KITION_KIT_HOST, writeKitFileFromReplica, type KitSdkManifest } from '@/features/kits/public'
import { loadBoardSharedFile } from '@/features/whiteboard/public'
import type { SyncClient } from '@/lib/sync'
import { createWorkspaceFolder, listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'
import { blobHashCandidates, decodeBlobSection, encodeBlobSection, type BlobEntry } from './blobSection'
import { findCollabDocument, HOST_KITS } from './collabDocuments'
import { readRoom, toHex, writeRoom } from './rooms'
import { onlineSyncClient } from './syncConnection'

/** The folder documents opened from a share link go to. */
const SHARED_FOLDER = 'Shared'

/** Whether the document at `path` is open in an editor that can co-edit it. */
export function canShareDocument(path: string) {
  return Boolean(findCollabDocument(path))
}

async function uploadBlobs(client: SyncClient, entries: BlobEntry[]) {
  if (!entries.length) return
  const { missing } = await client.blobs.has(entries.map((entry) => entry.hash))
  const absent = new Set(missing)
  for (const entry of entries) if (absent.has(entry.hash)) await client.blobs.put(entry.data, 'application/octet-stream')
}

/** What sharing answers: the room's editing link, and its id (for a view-only link). */
export type SharedDocument = { docId: string; shareLink: string }

/** Makes a room for the document open at `path` (or answers its existing link). */
export async function shareDocument(path: string): Promise<SharedDocument> {
  const document = findCollabDocument(path)
  if (!document) throw new Error(`${path} cannot be co-edited`)
  const client = await onlineSyncClient()
  const replica = await document.connect()
  try {
    await replica.save()
    // Asking for the version makes the replica when the document has none yet.
    const version = new Uint8Array(await replica.version())
    const docId = await replica.docId()
    if (!docId) throw new Error(`${path} has no replica to share`)
    const existing = readRoom(docId)
    if (existing) return { docId, shareLink: existing.shareLink }
    const exported = await replica.exportChanges(new ArrayBuffer(0))
    await uploadBlobs(client, decodeBlobSection(new Uint8Array(exported.blobs)))
    const name = path.split('/').filter(Boolean).pop() || path
    const { shareLink } = await client.createRoom(docId, new Uint8Array(exported.changes), name, document.kit)
    writeRoom({ docId, shareLink, name, kit: document.kit, role: 'owner', lastSent: toHex(version) })
    return { docId, shareLink }
  } finally {
    replica.dispose()
  }
}

/** A link to the shared document `docId`'s room that lets whoever opens it only view. */
export async function shareViewOnlyLink(docId: string): Promise<string> {
  const client = await onlineSyncClient()
  return (await client.createLink(docId, 'viewer')).shareLink
}

/** What Kition knows of a kit to open its shared documents: its engine, and its file extension. */
export type SharedKit = { engine: KitSdkManifest; extension: string }

function folderExists(items: readonly WorkspaceDocumentTreeItem[], path: string) {
  return items.some((item) => item.type === 'folder' && item.path === path)
}

function hasPath(items: readonly WorkspaceDocumentTreeItem[], path: string): boolean {
  return items.some((item) => item.path === path || (item.children ? hasPath(item.children, path) : false))
}

/** `Shared/<name>`, numbered when that exists; makes the folder when it is missing. Answers the workspace root too. */
async function sharedPath(name: string, extension: string) {
  const { items, root_path: root } = await listWorkspaceDocuments()
  if (!folderExists(items, SHARED_FOLDER)) await createWorkspaceFolder({ parent_folder: '', name: SHARED_FOLDER })
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Shared document'
  const dot = clean.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot + 1)] : [clean, extension]
  for (let number = 1; number < 1000; number += 1) {
    const candidate = `${SHARED_FOLDER}/${stem}${number === 1 ? '' : ` ${number}`}.${ext}`
    if (!hasPath(items, candidate) && (await KITION_KIT_HOST.stamp(candidate)) == null) return { path: candidate, root }
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

function base64(bytes: Uint8Array) {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

function fromBase64(text: string) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

/**
 * Writes a shared document Kition edits itself (a board, a Markdown document, a table) as a new
 * file in `Shared/`: answers its path and the replica version it holds, or `null` for another kit.
 */
async function writeHostFile(kit: string, name: string, snapshot: Uint8Array) {
  if (kit === HOST_KITS.board) {
    const { path, root } = await sharedPath(name, 'kiboard')
    const { writeBoardFileFromReplica } = await loadBoardSharedFile()
    return { path, version: await writeBoardFileFromReplica(path, snapshot, root) }
  }
  if (kit === HOST_KITS.document) {
    const { path, root } = await sharedPath(name, 'md')
    const { createDocumentFromReplica } = await loadDocumentStore()
    return { path, version: await createDocumentFromReplica(path, snapshot, { expectedRoot: root }) }
  }
  if (kit === HOST_KITS.table) {
    const { path } = await sharedPath(name, 'kitable')
    const created = await createTableFromReplica({ path, changes: base64(snapshot) })
    return { path, version: fromBase64(created.version) }
  }
  return null
}

/**
 * Opens a share link: answers the workspace file the shared document is in here, made the first
 * time (in `Shared/`), or the one an earlier open made. `kitFor` names what Kition knows of the
 * room's kit, or `null` for a kit this build does not have.
 */
export async function openSharedDocument(link: string, kitFor: (kitId: string) => SharedKit | null): Promise<string> {
  const client = await onlineSyncClient()
  const shareLink = link.trim()
  const room = await client.openRoom(shareLink)
  const known = readRoom(room.docId)
  if (known?.path && (await KITION_KIT_HOST.stamp(known.path)) != null) {
    // Opened again from another link (a view-only one, or one that now grants more): its role.
    if (known.role !== room.role) writeRoom({ ...known, role: room.role, shareLink })
    return known.path
  }
  const kit = kitFor(room.kit)
  if (!kit && !Object.values<string>(HOST_KITS).includes(room.kit)) throw new Error(`this build cannot open ${room.kit} documents`)
  const { snapshot, seq } = await client.snapshot(room.docId)
  let written = await writeHostFile(room.kit, room.name, snapshot)
  if (!written && kit) {
    const blobs = await snapshotBlobs(client, snapshot)
    const { path } = await sharedPath(room.name, kit.extension)
    const { version } = await writeKitFileFromReplica(kit.engine, path, { snapshot, blobs })
    written = { path, version }
  }
  if (!written) throw new Error(`this build cannot open ${room.kit} documents`)
  const version = toHex(written.version)
  writeRoom({ docId: room.docId, shareLink, name: room.name, kit: room.kit, role: room.role, lastSent: version, seen: { seq, version }, path: written.path })
  return written.path
}
