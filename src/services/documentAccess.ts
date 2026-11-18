/**
 * Which documents this person may only view here: documents co-edited in a room where their
 * role is `viewer`. Co-editing sets them; every editor (kit editors, Board, Document, Table)
 * reads them and opens such a document read-only. Empty unless co-editing made it otherwise.
 */
import { useSyncExternalStore } from 'react'

let readOnly: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

/** Replaces the read-only documents (workspace paths). */
export function setReadOnlyDocuments(paths: Iterable<string>) {
  const next = new Set(paths)
  if (next.size === readOnly.size && [...next].every((path) => readOnly.has(path))) return
  readOnly = next
  for (const listener of [...listeners]) listener()
}

/** Whether the document at `path` opens read-only. */
export function isDocumentReadOnly(path: string) {
  return readOnly.has(path)
}

/** Hears changes to the read-only documents; answers an unsubscribe. */
function subscribeReadOnlyDocuments(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether the document at `path` is read-only for this person; follows changes. */
export function useDocumentReadOnly(path: string | undefined): boolean {
  return useSyncExternalStore(subscribeReadOnlyDocuments, () => (path ? readOnly.has(path) : false), () => false)
}
