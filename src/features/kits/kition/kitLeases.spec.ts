import { describe, expect, it, vi } from 'vitest'
import { localPresence, setPresencePeers } from '@/services/documentPresence'
import { documentSchemaNotice, setDocumentSchemaNotice } from '@/services/documentSchema'
import type { KitConnection } from '../host/mountKit'
import { kitCollabHandlers } from './kitLeases'

describe('kitCollabHandlers presence (Kit UI protocol section 7e)', () => {
  it('keeps what the person shares for co-editing, tells the kit what the others share, and withdraws it when the kit closes', () => {
    const path = 'Shared/Deck.kitionslide'
    const { handlers, attach } = kitCollabHandlers(path, 'kit.slide', true, () => ((key: string) => key) as never)
    // A viewer (read-only) shares its selection too.
    handlers.presence?.({ selection: ['shape-1'] })
    expect(localPresence(path)).toEqual({ selection: ['shape-1'] })

    const alice = { principal: 'u:alice', name: 'Alice', color: '#e5484d', selection: ['shape-2'] }
    setPresencePeers(path, [alice])
    const peersChanged = vi.fn()
    const connection = { leasesChanged: vi.fn(), peersChanged } as unknown as KitConnection
    const detach = attach(connection)
    // The peers known when it opened, then every change.
    expect(peersChanged).toHaveBeenLastCalledWith([alice])
    setPresencePeers(path, [])
    expect(peersChanged).toHaveBeenLastCalledWith([])

    detach()
    expect(localPresence(path)).toBeNull()
    setPresencePeers(path, [alice])
    expect(peersChanged).toHaveBeenCalledTimes(2)
    setPresencePeers(path, [])
  })
})

describe('kitCollabHandlers schema reports (Kit UI protocol section 7f)', () => {
  const connection = { leasesChanged: vi.fn(), peersChanged: vi.fn() } as unknown as KitConnection

  it("shows a notice that does not block when the kit reports a newer kit's edits, and takes it back when the kit closes", () => {
    const path = 'Shared/Newer.kitionslide'
    const { handlers, attach } = kitCollabHandlers(path, 'kit.slide', false, () => ((key: string) => key) as never)
    const detach = attach(connection)
    handlers.schema?.({ reads: 2, newestAuthor: 3 })
    expect(documentSchemaNotice(path)).toEqual({ kit: 'kit.slide', reads: 2, needs: 3, blocked: false })
    detach()
    expect(documentSchemaNotice(path)).toBeNull()
  })

  it('leaves a blocking notice to the relay that set it', () => {
    const path = 'Shared/Blocked.kitionslide'
    const { handlers, attach } = kitCollabHandlers(path, 'kit.slide', false, () => ((key: string) => key) as never)
    const detach = attach(connection)
    setDocumentSchemaNotice(path, { kit: 'kit.slide', reads: 2, needs: 4, blocked: true })
    handlers.schema?.({ reads: 2, newestAuthor: 3 })
    expect(documentSchemaNotice(path)?.blocked).toBe(true)
    detach()
    expect(documentSchemaNotice(path)?.blocked).toBe(true)
    setDocumentSchemaNotice(path, null)
  })
})
