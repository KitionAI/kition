// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { renameDocument } from '@/features/document/kdm/documentStore'
import { readDocumentIndex } from '@/services/desktop'
import { readKitReplica, writeKitReplica } from './kitionHost'

const bytes = (...values: number[]) => new Uint8Array(values).buffer

afterEach(() => {
  window.localStorage.clear()
})

describe('kit replicas in Kition', () => {
  it('keeps a kit replica under the file’s identity, through renames', async () => {
    await expect(readKitReplica('art/a.psd', 'kit.photo')).resolves.toBeNull()
    await writeKitReplica('art/a.psd', 'kit.photo', { snapshot: bytes(1, 2), blobs: bytes(3), fileStamp: 'v1' })
    const docId = (await readDocumentIndex()).entries['art/a.psd']
    expect(docId).toBeTruthy()

    const read = await readKitReplica('art/a.psd', 'kit.photo')
    expect(read?.fileStamp).toBe('v1')
    expect(Array.from(new Uint8Array(read!.snapshot))).toEqual([1, 2])
    expect(Array.from(new Uint8Array(read!.blobs))).toEqual([3])
    // Another kit's editor never takes it.
    await expect(readKitReplica('art/a.psd', 'kit.design')).resolves.toBeNull()

    // A later save replaces it under the same identity; a rename keeps it.
    await writeKitReplica('art/a.psd', 'kit.photo', { snapshot: bytes(9), blobs: bytes(), fileStamp: 'v2' })
    expect((await readDocumentIndex()).entries['art/a.psd']).toBe(docId)
    await renameDocument('art/a.psd', 'art/b.psd')
    await expect(readKitReplica('art/a.psd', 'kit.photo')).resolves.toBeNull()
    const renamed = await readKitReplica('art/b.psd', 'kit.photo')
    expect(renamed?.fileStamp).toBe('v2')
    expect(Array.from(new Uint8Array(renamed!.snapshot))).toEqual([9])
  })

  it('takes no Markdown document’s entry for a kit replica', async () => {
    const { writeDocumentStore, writeDocumentIndex } = await import('@/services/desktop')
    await writeDocumentIndex({ 'notes/a.md': 'doc-1' }, null)
    await writeDocumentStore('doc-1', {
      meta: { docId: 'doc-1', kit: 'kit.document', path: 'notes/a.md', fileHash: 'h', fileStamp: null, exported: '00', style: { eol: '\n', bom: false, finalNewline: true } },
      snapshot: new Uint8Array([1]),
    })
    await expect(readKitReplica('notes/a.md', 'kit.photo')).resolves.toBeNull()
  })
})
