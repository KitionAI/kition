import { describe, expect, it, vi } from 'vitest'
import { DocumentLeaseRefused, acquireDocumentLease, documentLeases, onDocumentLeases, releaseDocumentLease, setDocumentLeaseProvider, type DocumentLease, type DocumentLeaseProvider } from './documentLeases'

const alice: DocumentLease = { scope: 'layer:a', holder: { principalId: 'p1', name: 'Alice', self: false } }

function provider() {
  let leases: DocumentLease[] = []
  const listeners = new Set<() => void>()
  const released: string[] = []
  const fake: DocumentLeaseProvider & { set: (next: DocumentLease[]) => void; released: string[] } = {
    released,
    set: (next) => {
      leases = next
      for (const listener of listeners) listener()
    },
    acquire: async (scope) => {
      if (scope === alice.scope) throw new DocumentLeaseRefused('held', alice)
      return { scope, holder: { principalId: 'p2', name: 'Bob', self: true } }
    },
    release: async (scope) => {
      released.push(scope)
    },
    list: () => leases,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return fake
}

describe('documentLeases', () => {
  it('answers no lease for a document that is not co-edited', async () => {
    expect(await acquireDocumentLease('Solo.psd', 'layer:a')).toBeNull()
    expect(documentLeases('Solo.psd')).toEqual([])
    await releaseDocumentLease('Solo.psd', 'layer:a')
  })

  it('routes a co-edited document\'s leases to its provider and tells watchers of changes', async () => {
    const heard = vi.fn()
    const stopWatching = onDocumentLeases('Poster.psd', heard)
    const fake = provider()
    const withdraw = setDocumentLeaseProvider('Poster.psd', fake)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(await acquireDocumentLease('Poster.psd', 'layer:b')).toMatchObject({ holder: { name: 'Bob', self: true } })
    await expect(acquireDocumentLease('Poster.psd', 'layer:a')).rejects.toMatchObject({ reason: 'held', lease: alice })
    await releaseDocumentLease('Poster.psd', 'layer:b')
    expect(fake.released).toEqual(['layer:b'])
    fake.set([alice])
    expect(heard).toHaveBeenCalledTimes(2)
    expect(documentLeases('Poster.psd')).toEqual([alice])
    // Withdrawn (the document stopped relaying): no leases, and watchers hear it.
    withdraw()
    expect(heard).toHaveBeenCalledTimes(3)
    expect(documentLeases('Poster.psd')).toEqual([])
    fake.set([])
    expect(heard).toHaveBeenCalledTimes(3)
    stopWatching()
  })
})
