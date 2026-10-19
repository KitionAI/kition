import { describe, expect, it, vi } from 'vitest'
import { localPresence, setPresencePeers } from '@/services/documentPresence'
import type { KitConnection } from '../host/mountKit'
import { kitCollabHandlers } from './kitLeases'

describe('kitCollabHandlers presence (Kit UI protocol section 7e)', () => {
  it('keeps what the person shares for co-editing, tells the kit what the others share, and withdraws it when the kit closes', () => {
    const path = 'Shared/Deck.kitionslide'
    const { handlers, attach } = kitCollabHandlers(path, true, () => ((key: string) => key) as never)
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
