/**
 * A document's version history: the checkpoints this device recorded in the document store, each keeping the
 * document's state when it was recorded. A past version is shown from its own snapshot and restored by the document's
 * kit as one new change (`replica/restore`), never by replacing the document.
 */
import type { KitCheckpoint } from '@kition/sdk/protocol'
import { readDocumentHistory, readDocumentIndex, readKitCheckpoint } from '@/services/desktop'
import type { HistoryDocument } from './historyDocuments'

export type HistoryEntry = KitCheckpoint

/** The document as of a checkpoint: the bytes its kit opens. */
export type HistoryPreview = { snapshot: Uint8Array; blobs: Uint8Array }

/** The document's id in the store (its history's), or `null` when the store has none for its path. */
async function storeIdFor(path: string): Promise<string | null> {
  return (await readDocumentIndex()).entries[path] ?? null
}

/** This device's checkpoints of `document`, newest first. */
export async function loadHistory(document: HistoryDocument): Promise<HistoryEntry[]> {
  const storeId = await storeIdFor(document.path)
  return storeId ? readDocumentHistory(storeId) : []
}

/** The document as of `entry`: the snapshot and blobs the checkpoint keeps. */
export async function previewOf(document: HistoryDocument, entry: HistoryEntry): Promise<HistoryPreview> {
  const storeId = await storeIdFor(document.path)
  if (!storeId) throw new Error(`no history of ${document.path}`)
  const { snapshot, blobs } = await readKitCheckpoint(storeId, entry.id)
  return { snapshot, blobs }
}

/** Restores `entry` as one new change of the person's, which Undo takes back. */
export async function restoreEntry(document: HistoryDocument, entry: HistoryEntry, label: string): Promise<void> {
  const { snapshot, blobs } = await previewOf(document, entry)
  await document.restore(snapshot, blobs, label)
}
