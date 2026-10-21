import { afterEach, describe, expect, it, vi } from 'vitest'
import { KdmError } from '@/lib/kdm'
import { documentSchemaNotice, schemaBlockedPaths, setDocumentSchemaNotice } from '@/services/documentSchema'
import type { CollabReplica } from './collabDocuments'
import { newerSchemaRefusal, watchSchema } from './schemaWatch'

function replica(overrides: Partial<CollabReplica> = {}): CollabReplica {
  return {
    version: vi.fn(async () => new ArrayBuffer(0)),
    exportChanges: vi.fn(async () => ({ changes: new ArrayBuffer(0), blobs: new ArrayBuffer(0) })),
    importChanges: vi.fn(async () => ({ damage: null })),
    onChanged: vi.fn(() => () => undefined),
    docId: vi.fn(async () => 'doc-1'),
    save: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...overrides,
  }
}

const empty = new ArrayBuffer(0)

afterEach(() => {
  setDocumentSchemaNotice('Slide.kitionslide', null)
  setDocumentSchemaNotice('Plan.kiboard', null)
})

describe('newerSchemaRefusal', () => {
  it('reads what a refused import needs, from the KDM and from a kit', () => {
    expect(newerSchemaRefusal(new KdmError('newer-schema', 'the document needs schema version 2; this kit reads schema versions up to 1'))).toEqual({ needs: 2, reads: 1 })
    expect(newerSchemaRefusal(new Error('slide replica: the document needs schema version 5; this kit reads schema versions up to 3'))).toEqual({ needs: 5, reads: 3 })
    expect(newerSchemaRefusal({ message: 'refused', data: { reason: 'newer-schema' } })).toEqual({ needs: Number.NaN, reads: Number.NaN })
    expect(newerSchemaRefusal(new Error('the connection is closed'))).toBeNull()
    expect(newerSchemaRefusal(null)).toBeNull()
  })
})

describe('watchSchema', () => {
  it('keeps a document whose import a newer kit migrated read-only, and still fails the import', async () => {
    const onBlocked = vi.fn()
    const refused = new Error('the document needs schema version 4; this kit reads schema versions up to 3')
    const watched = watchSchema('Slide.kitionslide', 'kit.slide', replica({ importChanges: vi.fn(async () => Promise.reject(refused)) }), { onBlocked })
    await expect(watched.importChanges(empty, empty)).rejects.toBe(refused)
    expect(documentSchemaNotice('Slide.kitionslide')).toEqual({ kit: 'kit.slide', needs: 4, reads: 3, blocked: true })
    expect(schemaBlockedPaths()).toEqual(['Slide.kitionslide'])
    expect(onBlocked).toHaveBeenCalledTimes(1)
    // Other failures say nothing about the schema.
    const failing = watchSchema('Plan.kiboard', 'kit.board', replica({ importChanges: vi.fn(async () => Promise.reject(new Error('offline'))) }))
    await expect(failing.importChanges(empty, empty)).rejects.toThrow('offline')
    expect(documentSchemaNotice('Plan.kiboard')).toBeNull()
  })

  it('notes, without blocking, changes written under a newer schema that the replica took', async () => {
    let newestAuthor: number | null = 2
    const watched = watchSchema('Plan.kiboard', 'kit.board', replica({ schema: () => ({ reads: 2, newestAuthor }) }))
    await watched.importChanges(empty, empty)
    expect(documentSchemaNotice('Plan.kiboard')).toBeNull()
    newestAuthor = 3
    await watched.importChanges(empty, empty)
    expect(documentSchemaNotice('Plan.kiboard')).toEqual({ kit: 'kit.board', needs: 3, reads: 2, blocked: false })
    expect(schemaBlockedPaths()).toEqual([])
  })

  it('never lets a notice that does not block replace one that does', () => {
    setDocumentSchemaNotice('Slide.kitionslide', { kit: 'kit.slide', needs: 4, reads: 3, blocked: true })
    setDocumentSchemaNotice('Slide.kitionslide', { kit: 'kit.slide', needs: 5, reads: 3, blocked: false })
    expect(documentSchemaNotice('Slide.kitionslide')?.blocked).toBe(true)
    setDocumentSchemaNotice('Slide.kitionslide', null)
    expect(documentSchemaNotice('Slide.kitionslide')).toBeNull()
  })
})
