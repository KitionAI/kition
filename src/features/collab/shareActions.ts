/**
 * Sharing a document for co-editing, and opening a document someone shared: kit documents and
 * Markdown documents alike (`collabDocuments.ts`).
 *
 * **Share.** The document is saved first, so its file and the replica stored with it carry the
 * document's KDM identity (`docId`), then its whole history (an export from nothing) is the
 * room's snapshot; the export's blobs are uploaded before the room is made. The room is recorded
 * (`rooms.ts`), which starts the document's relay. Links granting less (comment, view) can be made
 * next to it (`createShareLink`), and the room's owner manages its members and links.
 *
 * **Open shared.** The link names the room (`room/open`); its snapshot and the blobs it references
 * come from the server, and Kition makes the file `Shared/<name>` from them: a kit document with
 * the kit's engine in a worker (`writeKitFileFromReplica`: the replica opens with no file bytes,
 * is saved as the file's format, and the replica it saved with is stored under the new file's
 * stamp), a Markdown document by its own editor's means, each as that same replica,
 * so its editor opens the file as it and the relay joins its room.
 */
import { loadDocumentStore } from '@/features/document/public'
import { KITION_KIT_HOST, writeKitFileFromReplica, type KitSdkManifest } from '@/features/kits/public'
import { blobHashCandidates, decodeBlobSection, encodeBlobSection, SyncRpcError, type BlobEntry, type Role, type RoomListing, type RoomMembersResult, type SyncClient } from '@/lib/sync'
import { createWorkspaceFolder, listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'
import { findCollabDocument, HOST_KITS, type CollabReplica } from './collabDocuments'
import { readRoom, toHex, writeRoom } from './rooms'
import { onlineSyncClient } from './syncConnection'

/** The folder documents opened from a share link go to. */
const SHARED_FOLDER = 'Shared'

/** Whether the document at `path` is open in an editor that can co-edit it. */
export function canShareDocument(path: string) {
  return Boolean(findCollabDocument(path))
}

/** Uploads a document's blobs for its room (blobs belong to the documents that upload them). */
async function uploadBlobs(client: SyncClient, docId: string, entries: BlobEntry[]) {
  if (!entries.length) return
  const { missing } = await client.blobs.has(docId, entries.map((entry) => entry.hash))
  const absent = new Set(missing)
  for (const entry of entries) if (absent.has(entry.hash)) await client.blobs.put(docId, entry.data, 'application/octet-stream')
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
    if (existing?.shareLink) return { docId, shareLink: existing.shareLink }
    if (existing) {
      // Synced to this person's devices (a private room, or one opened from their list): its
      // first link shares it.
      const role = existing.role === 'owner' ? 'editor' : existing.role
      const { shareLink } = await client.createLink(docId, role)
      writeRoom({ ...existing, shareLink })
      return { docId, shareLink }
    }
    const exported = await replica.exportChanges(new ArrayBuffer(0))
    await uploadBlobs(client, docId, decodeBlobSection(new Uint8Array(exported.blobs)))
    const name = path.split('/').filter(Boolean).pop() || path
    const { shareLink } = await client.createRoom(docId, new Uint8Array(exported.changes), name, document.kit)
    writeRoom({ docId, shareLink, name, kit: document.kit, role: 'owner', lastSent: toHex(version), path })
    return { docId, shareLink }
  } finally {
    replica.dispose()
  }
}

/** What a share link lets whoever opens it do. */
export type LinkRole = Exclude<Role, 'owner'>

/** A new link to the shared document `docId`'s room granting `role` (never more than this person's own). */
export async function createShareLink(docId: string, role: LinkRole): Promise<string> {
  const client = await onlineSyncClient()
  return (await client.createLink(docId, role)).shareLink
}

/** The room's members and working links (its owner and editors may list them). */
export async function listRoomMembers(docId: string): Promise<RoomMembersResult> {
  const client = await onlineSyncClient()
  return client.members(docId)
}

/** The owner gives another member `role`. */
export async function changeMemberRole(docId: string, principalId: string, role: LinkRole) {
  const client = await onlineSyncClient()
  await client.setRole(docId, principalId, role)
}

/** The owner removes another member from the room. */
export async function removeRoomMember(docId: string, principalId: string) {
  const client = await onlineSyncClient()
  await client.removeMember(docId, principalId)
}

/** The owner revokes a share link: it no longer opens the document. */
export async function revokeShareLink(docId: string, shareLink: string) {
  const client = await onlineSyncClient()
  await client.revokeLink(docId, shareLink)
}

/** This person's role in the shared document `docId`'s room, as last known here. */
export function roomRole(docId: string): Role | null {
  return readRoom(docId)?.role ?? null
}

/** This person's principal id on the sync server, once connected. */
export async function ownPrincipalId(): Promise<string | null> {
  return (await onlineSyncClient()).principal?.id ?? null
}

/** What Kition knows of a kit to open its shared documents: its engine, and its file extension. */
export type SharedKit = { engine: KitSdkManifest; extension: string }

function folderExists(items: readonly WorkspaceDocumentTreeItem[], path: string) {
  return items.some((item) => item.type === 'folder' && item.path === path)
}

function hasPath(items: readonly WorkspaceDocumentTreeItem[], path: string): boolean {
  return items.some((item) => item.path === path || (item.children ? hasPath(item.children, path) : false))
}

/**
 * `<folder>/<name>` (`folder` empty: the workspace root), numbered when that exists; makes the
 * `Shared` folder when it is the one asked for and missing. Answers the workspace root too.
 */
async function freePath(folder: string, name: string, extension: string) {
  const { items, root_path: root } = await listWorkspaceDocuments()
  if (folder === SHARED_FOLDER && !folderExists(items, SHARED_FOLDER)) await createWorkspaceFolder({ parent_folder: '', name: SHARED_FOLDER })
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Shared document'
  const dot = clean.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot + 1)] : [clean, extension]
  for (let number = 1; number < 1000; number += 1) {
    const candidate = `${folder ? `${folder}/` : ''}${stem}${number === 1 ? '' : ` ${number}`}.${ext}`
    if (!hasPath(items, candidate) && (await KITION_KIT_HOST.stamp(candidate)) == null) return { path: candidate, root }
  }
  throw new Error(`no free name for ${name} in ${folder || 'the workspace'}`)
}

/** The blobs a replica snapshot of `docId` references that its room holds. */
async function snapshotBlobs(client: SyncClient, docId: string, snapshot: Uint8Array) {
  const candidates = blobHashCandidates(snapshot)
  if (!candidates.length) return new Uint8Array()
  const { missing } = await client.blobs.has(docId, candidates)
  const absent = new Set(missing)
  const entries: BlobEntry[] = []
  for (const hash of candidates) if (!absent.has(hash)) entries.push({ hash, data: (await client.blobs.get(docId, hash)).data })
  return encodeBlobSection(entries)
}

/**
 * Writes a shared document Kition edits itself (a Markdown document) as a new
 * file in `folder`: answers its path and the replica version it holds, or `null` for another kit.
 */
async function writeHostFile(client: SyncClient, docId: string, kit: string, name: string, snapshot: Uint8Array, folder: string) {
  if (kit === HOST_KITS.document) {
    const { path, root } = await freePath(folder, name, 'md')
    const { createDocumentFromReplica } = await loadDocumentStore()
    return { path, version: await createDocumentFromReplica(path, snapshot, { expectedRoot: root }) }
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
  return writeRoomHere(client, { ...room, shareLink }, SHARED_FOLDER, kitFor)
}

/** Whether this build can open documents of the kit `kitId` (`kitFor` as for `openSharedDocument`). */
export function canOpenKit(kitId: string, kitFor: (kitId: string) => SharedKit | null) {
  return Boolean(kitFor(kitId)) || Object.values<string>(HOST_KITS).includes(kitId)
}

/**
 * Makes a new workspace file in `folder` from the room's state (a new replica of the same
 * document, its blobs with it), and records the room so the file relays from the `seq` that
 * state is at. Nothing local is converted or overwritten: the file is always a new one.
 */
async function writeRoomHere(client: SyncClient, room: { docId: string; name: string; kit: string; role: Role; shareLink: string }, folder: string, kitFor: (kitId: string) => SharedKit | null) {
  const kit = kitFor(room.kit)
  if (!canOpenKit(room.kit, kitFor)) throw new Error(`this build cannot open ${room.kit} documents`)
  const { snapshot, seq } = await client.snapshot(room.docId)
  let written = await writeHostFile(client, room.docId, room.kit, room.name, snapshot, folder)
  if (!written && kit) {
    const blobs = await snapshotBlobs(client, room.docId, snapshot)
    const { path } = await freePath(folder, room.name, kit.extension)
    const { version } = await writeKitFileFromReplica(kit.engine, path, { snapshot, blobs })
    written = { path, version }
  }
  if (!written) throw new Error(`this build cannot open ${room.kit} documents`)
  const version = toHex(written.version)
  writeRoom({ docId: room.docId, shareLink: room.shareLink, name: room.name, kit: room.kit, role: room.role, lastSent: version, seen: { seq, version }, path: written.path })
  return written.path
}

/** Whether the document `docId` is in this workspace: it has a room record here whose file (if it names one) exists. */
export async function documentIsHere(docId: string) {
  const known = readRoom(docId)
  if (!known) return false
  return !known.path || (await KITION_KIT_HOST.stamp(known.path)) != null
}

/**
 * Opens a document from this person's list of synced documents (`rooms/list`) in `folder` (empty:
 * the workspace root): answers the workspace file, made the first time, or the one already here.
 */
export async function openSyncedDocument(room: RoomListing, folder: string, kitFor: (kitId: string) => SharedKit | null): Promise<string> {
  const client = await onlineSyncClient()
  const known = readRoom(room.docId)
  if (known?.path && (await KITION_KIT_HOST.stamp(known.path)) != null) return known.path
  return writeRoomHere(client, { docId: room.docId, name: room.name, kit: room.kit, role: room.role, shareLink: known?.shareLink ?? '' }, folder, kitFor)
}

/**
 * Makes a private room for the document `replica` stands for (kition-sync 1.9): it syncs to this
 * person's own devices, with no share link. The replica's whole history is the room's snapshot,
 * its blobs go up first, and the room is recorded, which starts its relay. A room that already
 * exists for the document (made on another device) is attached instead when this person is a
 * member of it, so the document is never converted: the relay merges both sides.
 */
export async function syncReplicaToMyDevices(client: SyncClient, replica: CollabReplica, docId: string, path: string, kit: string) {
  if (readRoom(docId)) return
  const version = new Uint8Array(await replica.version())
  const exported = await replica.exportChanges(new ArrayBuffer(0))
  await uploadBlobs(client, docId, decodeBlobSection(new Uint8Array(exported.blobs)))
  const name = path.split('/').filter(Boolean).pop() || path
  try {
    const { shareLink } = await client.createPrivateRoom(docId, new Uint8Array(exported.changes), name, kit)
    writeRoom({ docId, shareLink: shareLink ?? '', name, kit, role: 'owner', lastSent: toHex(version), path })
  } catch (error) {
    if (!(error instanceof SyncRpcError && error.reason === 'conflict')) throw error
    const listed = (await client.listAllRooms()).find((room) => room.docId === docId)
    if (!listed) throw error
    // Joined from nothing: the relay sends this replica's changes and takes the room's.
    writeRoom({ docId, shareLink: '', name: listed.name, kit: listed.kit, role: listed.role, path })
  }
}

/** Syncs the document open at `path` to this person's devices (a private room); answers its id. */
export async function syncDocumentToMyDevices(path: string): Promise<{ docId: string }> {
  const document = findCollabDocument(path)
  if (!document) throw new Error(`${path} cannot be synced`)
  const client = await onlineSyncClient()
  const replica = await document.connect()
  try {
    // Saved first, so the file carries the replica (and its document id) it syncs.
    await replica.save()
    await replica.version()
    const docId = await replica.docId()
    if (!docId) throw new Error(`${path} has no replica to sync`)
    await syncReplicaToMyDevices(client, replica, docId, path, document.kit)
    return { docId }
  } finally {
    replica.dispose()
  }
}
