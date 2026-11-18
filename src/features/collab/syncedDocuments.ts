/**
 * A person's documents across their devices (kition-sync 1.9): the rooms they are a member of
 * that are not in this workspace yet, the folders one can be opened into, and the account setting
 * "Sync all my documents".
 */
import type { RoomListing } from '@/lib/sync'
import { listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'
import { receiveAccountSettings } from './accountSettings'
import { documentIsHere } from './shareActions'
import { onlineSyncClient } from './syncConnection'

/** The documents this person syncs (or co-edits) that are not in this workspace yet, most recently changed first. */
export async function listDocumentsElsewhere(): Promise<RoomListing[]> {
  const client = await onlineSyncClient()
  const rooms = await client.listAllRooms()
  const here = await Promise.all(rooms.map((room) => documentIsHere(room.docId)))
  return rooms.filter((_, index) => !here[index]).sort((a, b) => b.updated - a.updated)
}

/** Hears this person's document list change on the server; answers an unsubscribe. */
export async function onDocumentListChanged(listener: () => void) {
  const client = await onlineSyncClient()
  return client.onRoomsChanged(() => listener())
}

function folders(items: readonly WorkspaceDocumentTreeItem[]): string[] {
  return items.flatMap((item) => (item.type === 'folder' ? [item.path, ...folders(item.children ?? [])] : []))
}

/** Every folder of the workspace (the root is `''`), for choosing where a document opens. */
export async function workspaceFolders(): Promise<string[]> {
  const { items } = await listWorkspaceDocuments()
  return ['', ...folders(items).sort((a, b) => a.localeCompare(b))]
}

/** Turns "Sync all my documents" on or off for this person, on every device. */
export async function setSyncAllDocuments(on: boolean) {
  const client = await onlineSyncClient()
  receiveAccountSettings(await client.updateAccountSettings({ syncAll: on }))
}

/** Reads this person's account settings from the server (connecting when needed). */
export async function refreshAccountSettings() {
  const client = await onlineSyncClient()
  receiveAccountSettings(await client.accountSettings())
}
