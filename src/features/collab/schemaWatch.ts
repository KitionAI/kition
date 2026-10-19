/**
 * Schema evolution in co-edited documents (Kit Standard 2.0 rules M5a and M20): the relay side of
 * a document, watched for changes a newer kit made.
 *
 * - A change the replica refuses because a newer kit's migration raised the document's minimum
 *   schema version (`newer-schema`) leaves the replica as it was: the document stays read-only
 *   here, as it last read it, until the kit is updated (`@/services/documentSchema`, blocking).
 *   The refusal still fails the import, so the relay never reports the room's position past it:
 *   the change is pulled again once the kit can read it.
 * - A change written under a newer schema that migrated nothing imports as usual (the replica keeps
 *   what it does not know, and refuses edits only to objects of types it lacks); a replica that
 *   can tell its changes' author schema versions (`schema`, Kition's own editors) gets a notice
 *   that does not block.
 */
import { setDocumentSchemaNotice } from '@/services/documentSchema'
import type { CollabReplica } from './collabDocuments'

/** What a replica needs and reads, as a refused import reports it. */
export type SchemaRefusal = { needs: number; reads: number }

const NEWER_SCHEMA = /the document needs schema version (\d+); this kit reads schema versions up to (\d+)/

/**
 * The newer schema an import was refused for, from a KDM error (`newer-schema`, from Kition's own
 * replicas) or a kit's refusal (`replica/import`, whose message carries the KDM's), or `null`.
 */
export function newerSchemaRefusal(error: unknown): SchemaRefusal | null {
  if (!error || typeof error !== 'object') return null
  const message = String((error as { message?: unknown }).message ?? '')
  const found = NEWER_SCHEMA.exec(message)
  if (found) return { needs: Number(found[1]), reads: Number(found[2]) }
  const reason = (error as { reason?: unknown; data?: { reason?: unknown } }).reason ?? (error as { data?: { reason?: unknown } }).data?.reason
  return reason === 'newer-schema' ? { needs: Number.NaN, reads: Number.NaN } : null
}

/**
 * `replica` with its imports watched for changes a newer kit made (see above). `onBlocked` runs
 * when an import is refused for a newer schema.
 */
export function watchSchema(path: string, kit: string, replica: CollabReplica, options: { onBlocked?: () => void } = {}): CollabReplica {
  return {
    ...replica,
    importChanges: async (changes, blobs) => {
      let result: unknown
      try {
        result = await replica.importChanges(changes, blobs)
      } catch (error) {
        const refusal = newerSchemaRefusal(error)
        if (refusal) {
          setDocumentSchemaNotice(path, { kit, needs: refusal.needs, reads: refusal.reads, blocked: true })
          options.onBlocked?.()
        }
        throw error
      }
      const schema = replica.schema?.()
      if (schema && schema.newestAuthor !== null && schema.newestAuthor > schema.reads) {
        setDocumentSchemaNotice(path, { kit, needs: schema.newestAuthor, reads: schema.reads, blocked: false })
      }
      return result
    },
  }
}
