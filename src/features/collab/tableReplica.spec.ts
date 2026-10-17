import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DataDocumentsReplicaReplicaChanged } from '@/api/generated/data-documents-replica'

const api = vi.hoisted(() => ({
  getTableReplicaVersion: vi.fn(),
  exportTableReplica: vi.fn(),
  importTableReplica: vi.fn(),
}))
vi.mock('@/api/dataDocumentsReplica', () => api)

const bridge = vi.hoisted(() => ({
  listeners: new Set<(params: DataDocumentsReplicaReplicaChanged) => void>(),
}))
vi.mock('@/services/runtimeBridge', () => ({
  onTableReplicaChanged: (listener: (params: DataDocumentsReplicaReplicaChanged) => void) => {
    bridge.listeners.add(listener)
    return () => bridge.listeners.delete(listener)
  },
}))

import { createTableRelayReplica } from './tableReplica'

const bytes = (...values: number[]) => new Uint8Array(values).buffer
const emit = (params: DataDocumentsReplicaReplicaChanged) => {
  for (const listener of [...bridge.listeners]) listener(params)
}

afterEach(() => {
  vi.clearAllMocks()
  bridge.listeners.clear()
})

describe('createTableRelayReplica', () => {
  it('answers the replica version as bytes', async () => {
    api.getTableReplicaVersion.mockResolvedValue({ documentId: '1', documentPath: 'a.kitable', docId: 'd', version: 'AQID' })
    const replica = createTableRelayReplica('a.kitable')
    expect(new Uint8Array(await replica.version())).toEqual(new Uint8Array([1, 2, 3]))
    expect(api.getTableReplicaVersion).toHaveBeenCalledWith({ path: 'a.kitable' })
  })

  it('exports the changes since a version, with no blobs', async () => {
    api.exportTableReplica.mockResolvedValue({ documentId: '1', documentPath: 'a.kitable', docId: 'd', version: 'AQ==', changes: 'BAUG' })
    const replica = createTableRelayReplica('a.kitable')
    const exported = await replica.exportChanges(bytes(9, 8))
    expect(api.exportTableReplica).toHaveBeenCalledWith({ path: 'a.kitable', since: 'CQg=' })
    expect(new Uint8Array(exported.changes)).toEqual(new Uint8Array([4, 5, 6]))
    expect(exported.blobs.byteLength).toBe(0)
  })

  it('exports everything from an empty version', async () => {
    api.exportTableReplica.mockResolvedValue({ documentId: '1', documentPath: 'a.kitable', docId: 'd', version: '', changes: '' })
    await createTableRelayReplica('a.kitable').exportChanges(new ArrayBuffer(0))
    expect(api.exportTableReplica).toHaveBeenCalledWith({ path: 'a.kitable', since: '' })
  })

  it('imports changes as base64 and ignores blobs', async () => {
    const answer = { documentId: '1', documentPath: 'a.kitable', docId: 'd', version: 'AQ==', change: {} }
    api.importTableReplica.mockResolvedValue(answer)
    const replica = createTableRelayReplica('folder/a.kitable')
    await expect(replica.importChanges(bytes(255, 0, 7), bytes(1))).resolves.toBe(answer)
    expect(api.importTableReplica).toHaveBeenCalledWith({ path: 'folder/a.kitable', changes: '/wAH' })
  })

  it('round-trips large byte strings', async () => {
    const large = new Uint8Array(200_000).map((_, index) => index % 251)
    let sent = ''
    api.importTableReplica.mockImplementation(async (payload: { changes: string }) => {
      sent = payload.changes
      return {}
    })
    api.exportTableReplica.mockImplementation(async () => ({ documentId: '1', documentPath: 'a.kitable', docId: 'd', version: '', changes: sent }))
    const replica = createTableRelayReplica('a.kitable')
    await replica.importChanges(large.buffer, new ArrayBuffer(0))
    const back = await replica.exportChanges(new ArrayBuffer(0))
    expect(new Uint8Array(back.changes)).toEqual(large)
  })

  it('reports table/replica-changed for its own file only', () => {
    const replica = createTableRelayReplica('./folder/a.kitable')
    const seen: number[][] = []
    const stop = replica.onChanged((version) => seen.push([...new Uint8Array(version)]))
    emit({ documentPath: 'other.kitable', docId: 'd', version: 'AQ==' })
    emit({ documentPath: 'folder/a.kitable', docId: 'd', version: 'AgM=' })
    expect(seen).toEqual([[2, 3]])
    stop()
    emit({ documentPath: 'folder/a.kitable', docId: 'd', version: 'BA==' })
    expect(seen).toEqual([[2, 3]])
  })

  it('dispose ends every subscription, and later ones are inert', () => {
    const replica = createTableRelayReplica('a.kitable')
    const listener = vi.fn()
    replica.onChanged(listener)
    replica.onChanged(listener)
    expect(bridge.listeners.size).toBe(2)
    replica.dispose()
    expect(bridge.listeners.size).toBe(0)
    replica.onChanged(listener)
    expect(bridge.listeners.size).toBe(0)
    emit({ documentPath: 'a.kitable', docId: 'd', version: 'AQ==' })
    expect(listener).not.toHaveBeenCalled()
  })
})
