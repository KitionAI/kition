/**
 * Documents a newer kit edited than the one this Kition ships (Kition platform rule M5a), by
 * workspace path: the kit reports it (Kit UI protocol section 7f), keeps editing, and only objects
 * of types it does not know refuse edits. Editors show the notice and offer the update.
 */
import { useSyncExternalStore } from 'react'

export type DocumentSchemaNotice = {
  /** The document's kit id (`kit.slide`). */
  kit: string
  /** The newest schema version the kit here reads. */
  reads: number
  /** The schema version the document's changes were written under. */
  needs: number
}

const notices = new Map<string, DocumentSchemaNotice>()
const listeners = new Set<() => void>()

/** Sets the notice of the document at `path`, or clears it (`null`: its kit closed). */
export function setDocumentSchemaNotice(path: string, notice: DocumentSchemaNotice | null) {
  const current = notices.get(path)
  if (notice && current && current.needs >= notice.needs && current.reads === notice.reads && current.kit === notice.kit) return
  if (!notice && !current) return
  if (notice) notices.set(path, notice)
  else notices.delete(path)
  for (const listener of [...listeners]) listener()
}

export function documentSchemaNotice(path: string): DocumentSchemaNotice | null {
  return notices.get(path) ?? null
}

function onDocumentSchemaNotices(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The notice of the document at `path`, following changes. */
export function useDocumentSchemaNotice(path: string | undefined): DocumentSchemaNotice | null {
  return useSyncExternalStore(onDocumentSchemaNotices, () => (path ? (notices.get(path) ?? null) : null), () => null)
}
