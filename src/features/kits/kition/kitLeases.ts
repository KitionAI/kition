import { notify } from '@/lib/notify'
import { DocumentLeaseRefused, acquireDocumentLease, documentLeases, onDocumentLeases, releaseDocumentLease } from '@/services/documentLeases'
import { onPresencePeers, presencePeers, setLocalPresence } from '@/services/documentPresence'
import { documentSchemaNotice, setDocumentSchemaNotice } from '@/services/documentSchema'
import { KitRpcError, LEASE_HELD_REASON, type KitConnection, type KitHostHandlers } from '../host/mountKit'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * What Kition serves one kit editor for co-editing (Kit UI protocol sections 7b, 7c, 7e, and 7f):
 * leases on the document's scopes, taken through the document's room (with no co-editing every
 * acquire answers `null` and the kit goes ahead), a notice that never blocks editing for each new
 * conflict object the kit reports, presence: what the person selected goes to the room as their
 * presence (`@/services/documentPresence`), and the kit hears what the others share, and the
 * document's notice when the kit reports that a newer kit edited it (`@/services/documentSchema`,
 * Kition platform rule M5a). `attach` follows the leases and the peers for the opened kit and
 * answers its detach, which also releases what the kit still holds (UI-L1), withdraws its
 * presence, and takes back the notice it reported.
 */
export function kitCollabHandlers(path: string, kitId: string, readOnly: boolean, t: () => Translate) {
  const leased = new Set<string>()
  const shownConflicts = new Set<string>()
  let reportedSchema = false
  const handlers: Pick<KitHostHandlers, 'leases' | 'conflicts' | 'presence' | 'schema'> = {
    leases: {
      acquire: async ({ scope, ttl }) => {
        if (readOnly) throw new KitRpcError(-32000, `${path} is open read-only`, { reason: 'read-only' })
        try {
          const lease = await acquireDocumentLease(path, scope, ttl)
          if (lease) leased.add(scope)
          return { lease }
        } catch (error) {
          if (error instanceof DocumentLeaseRefused) throw new KitRpcError(-32000, error.message, { reason: error.reason === 'held' ? LEASE_HELD_REASON : 'read-only', lease: error.lease })
          // The sync server cannot be reached: nobody to coordinate with, the edit goes ahead.
          return { lease: null }
        }
      },
      release: async ({ scope }) => {
        leased.delete(scope)
        await releaseDocumentLease(path, scope)
      },
      list: () => documentLeases(path),
    },
    conflicts: ({ conflicts }) => {
      const fresh = conflicts.filter((conflict) => !shownConflicts.has(conflict.id))
      for (const conflict of conflicts) shownConflicts.add(conflict.id)
      if (!fresh.length) return
      const translate = t()
      notify.warning(translate('kitEditor.conflictsTitle'), { description: translate('kitEditor.conflictsBody', { count: fresh.length }) })
    },
    // A viewer shares where it looks too; the room never takes an edit from it.
    presence: (presence) => setLocalPresence(path, presence),
    // A newer kit edited the document: the notice offers the update and never blocks editing (a
    // change the kit refuses for a newer schema blocks instead, from the relay).
    schema: ({ reads, newestAuthor }) => {
      reportedSchema = true
      setDocumentSchemaNotice(path, { kit: kitId, reads, needs: newestAuthor, blocked: false })
    },
  }
  const attach = (connection: KitConnection) => {
    const tell = () => connection.leasesChanged(documentLeases(path))
    const stop = onDocumentLeases(path, tell)
    if (documentLeases(path).length) tell()
    const tellPeers = () => connection.peersChanged(presencePeers(path))
    const stopPeers = onPresencePeers(path, tellPeers)
    if (presencePeers(path).length) tellPeers()
    return () => {
      stop()
      stopPeers()
      setLocalPresence(path, null)
      for (const scope of leased) void releaseDocumentLease(path, scope)
      leased.clear()
      // The notice this kit reported goes with it; a blocking one is the relay's.
      if (reportedSchema && documentSchemaNotice(path)?.blocked === false) setDocumentSchemaNotice(path, null)
      reportedSchema = false
    }
  }
  return { handlers, attach }
}
