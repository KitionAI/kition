import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { deleteDB } from 'idb'
import { openSearchDb, writeSnapshot, readSnapshot, pushDirty, drainDirty, clearDirty, type SearchDB } from './persistence'

const ROOT_HASH = 'abc123def4567890'

let db: SearchDB | null = null

beforeEach(async () => {
  if (db) { db.close(); db = null }
  await deleteDB(`kition-search-${ROOT_HASH}`)
})

afterEach(async () => {
  if (db) { db.close(); db = null }
})

describe('persistence', () => {
  it('reads back what it writes for snapshot', async () => {
    db = await openSearchDb(ROOT_HASH)
    await writeSnapshot(db, new Uint8Array([1, 2, 3, 4]), {
      version: 1, rootPath: '/test', builtAt: Date.now(), docCount: 2,
      sourceVersions: { note: '1', kitable: '1' },
    })
    const snap = await readSnapshot(db)
    expect(snap).not.toBeNull()
    expect(Array.from(snap!.blob)).toEqual([1, 2, 3, 4])
    expect(snap!.meta.docCount).toBe(2)
  })

  it('dirtyQueue accumulates and drains', async () => {
    db = await openSearchDb(ROOT_HASH)
    await pushDirty(db, { type: 'upsert', docIds: ['a'] })
    await pushDirty(db, { type: 'remove', docIds: ['b'] })
    const items = await drainDirty(db)
    expect(items).toHaveLength(2)
    await clearDirty(db)
    expect(await drainDirty(db)).toHaveLength(0)
  })

  it('writeSnapshot returns true on a successful write', async () => {
    db = await openSearchDb(ROOT_HASH)
    const result = await writeSnapshot(db, new Uint8Array([1, 2, 3]), {
      version: 1, rootPath: '/test', builtAt: Date.now(), docCount: 1,
      sourceVersions: { note: '1', kitable: '1' },
    })
    expect(result).toBe(true)
  })

  it('writeSnapshot returns false on QuotaExceededError and does not rethrow', async () => {
    db = await openSearchDb(ROOT_HASH)
    // Spy on IDBObjectStore.prototype.put and make it throw a QuotaExceededError
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    try {
      const result = await writeSnapshot(db, new Uint8Array([9, 8, 7]), {
        version: 1, rootPath: '/test', builtAt: Date.now(), docCount: 5,
        sourceVersions: { note: '1', kitable: '1' },
      })
      expect(result).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('per-rootHash isolation', async () => {
    const db1 = await openSearchDb('hash-aaaa-1111-2222')
    const db2 = await openSearchDb('hash-bbbb-3333-4444')
    await writeSnapshot(db1, new Uint8Array([9]), {
      version: 1, rootPath: '/x', builtAt: 0, docCount: 0,
      sourceVersions: { note: '1', kitable: '1' },
    })
    const snap2 = await readSnapshot(db2)
    db1.close()
    db2.close()
    expect(snap2).toBeNull()
  })
})
