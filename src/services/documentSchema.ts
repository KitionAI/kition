/**
 * Co-edited documents that need a newer kit than this Kition has (Kit Standard 2.0 rules M5a and
 * M20), by workspace path. Co-editing sets them as it relays: a change written under a newer
 * schema than the kit reads makes a notice (`blocked: false`: the kit keeps editing, and only
 * objects of types it does not know refuse edits), and a change the kit refuses because a newer
 * kit migrated the document makes a blocking one (`blocked: true`: the document stays read-only,
 * as it last read it, until the kit is updated; the room keeps every change, so nothing is lost).
 * Editors show the notice and offer the update.
 */
import { useSyncExternalStore } from 'react'

export type DocumentSchemaNotice = {
  /** The document's kit id (`kit.slide`). */
  kit: string
  /** The newest schema version the kit here reads. */
  reads: number
  /** The schema version the document's changes were written under, or require. */
  needs: number
  /** The kit refused the document's changes: it stays read-only here until the kit is updated. */
  blocked: boolean
}

const notices = new Map<string, DocumentSchemaNotice>()
const listeners = new Set<() => void>()

/**
 * Sets the notice of the document at `path`, or clears it (`null`: the document stopped relaying).
 * A blocking notice is never replaced by one that does not block.
 */
export function setDocumentSchemaNotice(path: string, notice: DocumentSchemaNotice | null) {
  const current = notices.get(path)
  if (notice && current?.blocked && !notice.blocked) return
  if (notice && current && current.blocked === notice.blocked && current.needs >= notice.needs && current.reads === notice.reads && current.kit === notice.kit) return
  if (!notice && !current) return
  if (notice) notices.set(path, notice)
  else notices.delete(path)
  for (const listener of [...listeners]) listener()
}

export function documentSchemaNotice(path: string): DocumentSchemaNotice | null {
  return notices.get(path) ?? null
}

/** The documents that stay read-only until their kit is updated. */
export function schemaBlockedPaths(): string[] {
  return [...notices].filter(([, notice]) => notice.blocked).map(([path]) => path)
}

/** Hears any notice change; answers an unsubscribe. */
export function onDocumentSchemaNotices(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The notice of the document at `path`, following changes. */
export function useDocumentSchemaNotice(path: string | undefined): DocumentSchemaNotice | null {
  return useSyncExternalStore(onDocumentSchemaNotices, () => (path ? (notices.get(path) ?? null) : null), () => null)
}
