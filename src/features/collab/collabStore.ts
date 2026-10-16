/** Which open documents are co-edited right now, and who else is in each one: for the tab's indicators. */
import { useSyncExternalStore } from 'react'
import type { Presence } from '@/lib/sync'

export type DocumentCollab = { docId: string; peers: Presence[] }

const documents = new Map<string, DocumentCollab>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Marks the document at `path` co-edited (or not, with `null`). */
export function setDocumentCollab(path: string, value: DocumentCollab | null) {
  if (value) documents.set(path, value)
  else documents.delete(path)
  emit()
}

/** The other people in the document's room (`self` is this person's principal id, left out). */
export function setDocumentPeers(path: string, peers: Presence[], self: string | undefined) {
  const current = documents.get(path)
  if (!current) return
  const others = peers.filter((peer) => peer.principalId !== self)
  documents.set(path, { ...current, peers: others.filter((peer, index) => others.findIndex((other) => other.principalId === peer.principalId) === index) })
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The co-editing state of the document at `path`, or `null` when it is not shared. */
export function useDocumentCollab(path: string | undefined): DocumentCollab | null {
  return useSyncExternalStore(subscribe, () => (path ? documents.get(path) ?? null : null), () => null)
}
