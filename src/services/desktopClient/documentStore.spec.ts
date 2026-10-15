// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DOCUMENT_INDEX_CONFLICT,
  type DocumentIndex,
  type DocumentStoreEntry,
  type DocumentStoreMeta,
  type KitReplicaMeta,
  deleteDocumentStore,
  isDocumentIndexConflict,
  isValidDocumentId,
  readDocumentIndex,
  readDocumentStore,
  writeDocumentIndex,
  writeDocumentStore,
} from './documentStore'

const DOC = '0199c2a4-7b3e-7cde-8f00-1234567890ab'

function meta(docId: string = DOC, path = 'notes/a.md'): DocumentStoreMeta {
  return {
    docId,
    kit: 'kit.document',
    path,
    fileHash: 'abc',
    fileStamp: null,
    exported: '00ff',
    style: { eol: '\n', bom: false, finalNewline: true },
  }
}

function entry(bytes: number[], path?: string): DocumentStoreEntry {
  return { meta: meta(DOC, path), snapshot: new Uint8Array(bytes) }
}

afterEach(() => {
  delete window.kitionDesktop
  window.localStorage.clear()
})

describe('document ids', () => {
  it('accepts the store pattern only', () => {
    expect(isValidDocumentId(DOC)).toBe(true)
    expect(isValidDocumentId('urn:uuid:a_b-c')).toBe(true)
    expect(isValidDocumentId('x'.repeat(128))).toBe(true)
    for (const bad of ['', '-a', '../a', 'a/b', 'a.b', 'a b', 'x'.repeat(129)]) {
      expect(isValidDocumentId(bad), bad).toBe(false)
    }
  })
})

describe('document store over the desktop bridge', () => {
  it('passes snapshots as base64 and decodes them back', async () => {
    const bridge = {
      ReadDocumentStore: vi.fn().mockResolvedValue({ meta: meta(), snapshot_base64: 'AAEC/w==' }),
      WriteDocumentStore: vi.fn().mockResolvedValue(null),
      DeleteDocumentStore: vi.fn().mockResolvedValue(null),
      ReadDocumentIndex: vi.fn().mockResolvedValue({ entries: { 'a.md': DOC }, version: 'v1' }),
      WriteDocumentIndex: vi.fn().mockResolvedValue({ version: 'v2' }),
    }
    window.kitionDesktop = bridge

    await writeDocumentStore(DOC, entry([0, 1, 2, 255]), { expectedRoot: '/w' })
    expect(bridge.WriteDocumentStore).toHaveBeenCalledWith({
      doc_id: DOC,
      meta: meta(),
      snapshot_base64: 'AAEC/w==',
      expected_root: '/w',
    })
    const read = await readDocumentStore(DOC)
    expect(bridge.ReadDocumentStore).toHaveBeenCalledWith({ doc_id: DOC })
    expect(read?.meta).toEqual(meta())
    expect(Array.from(read?.snapshot || [])).toEqual([0, 1, 2, 255])

    await deleteDocumentStore(DOC, { expectedRoot: '/w' })
    expect(bridge.DeleteDocumentStore).toHaveBeenCalledWith({ doc_id: DOC, expected_root: '/w' })

    const index: DocumentIndex = await readDocumentIndex()
    expect(index).toEqual({ entries: { 'a.md': DOC }, version: 'v1' })
    expect(bridge.ReadDocumentIndex).toHaveBeenCalledWith({})
    await expect(writeDocumentIndex({ 'b.md': DOC }, 'v1', { expectedRoot: '/w' })).resolves.toEqual({ version: 'v2' })
    expect(bridge.WriteDocumentIndex).toHaveBeenCalledWith({ entries: { 'b.md': DOC }, expected_version: 'v1', expected_root: '/w' })

    bridge.ReadDocumentStore.mockResolvedValueOnce(null)
    await expect(readDocumentStore(DOC)).resolves.toBeNull()
    bridge.ReadDocumentStore.mockResolvedValueOnce({ meta: meta(), snapshot_base64: 'not base64!' })
    await expect(readDocumentStore(DOC)).rejects.toThrow('not base64')
  })

  it('refuses bad input before calling the desktop shell', async () => {
    const bridge = {
      ReadDocumentStore: vi.fn(),
      WriteDocumentStore: vi.fn(),
      DeleteDocumentStore: vi.fn(),
      WriteDocumentIndex: vi.fn(),
    }
    window.kitionDesktop = bridge

    await expect(readDocumentStore('../escape')).rejects.toThrow('invalid document id')
    await expect(deleteDocumentStore('a/b')).rejects.toThrow('invalid document id')
    await expect(writeDocumentStore(DOC, { meta: meta('other'), snapshot: new Uint8Array() })).rejects.toThrow('another document')
    await expect(writeDocumentIndex({ '../a.md': DOC }, null)).rejects.toThrow('invalid document path')
    await expect(writeDocumentIndex({ 'a//b.md': DOC }, null)).rejects.toThrow('invalid document path')
    await expect(writeDocumentIndex({ 'a.md': 'bad id' }, null)).rejects.toThrow('invalid document id')
    expect(bridge.ReadDocumentStore).not.toHaveBeenCalled()
    expect(bridge.WriteDocumentStore).not.toHaveBeenCalled()
    expect(bridge.DeleteDocumentStore).not.toHaveBeenCalled()
    expect(bridge.WriteDocumentIndex).not.toHaveBeenCalled()
  })

  it('recognises the guarded index conflict from the desktop shell', async () => {
    window.kitionDesktop = { WriteDocumentIndex: vi.fn().mockRejectedValue(new Error(DOCUMENT_INDEX_CONFLICT)) }
    const failure = await writeDocumentIndex({}, null).catch((error: unknown) => error)
    expect(isDocumentIndexConflict(failure)).toBe(true)
    expect(isDocumentIndexConflict(new Error('disk full'))).toBe(false)
    expect(isDocumentIndexConflict(DOCUMENT_INDEX_CONFLICT)).toBe(true)
  })
})

describe('kit replicas in the document store', () => {
  const kitMeta: KitReplicaMeta = { docId: DOC, kit: 'kit.photo', path: 'art/a.psd', fileStamp: 'v1' }

  it('carries blobs over the desktop bridge', async () => {
    const bridge = {
      ReadDocumentStore: vi.fn().mockResolvedValue({ meta: kitMeta, snapshot_base64: 'AQ==', blobs_base64: 'AgM=' }),
      WriteDocumentStore: vi.fn().mockResolvedValue(null),
    }
    window.kitionDesktop = bridge
    await writeDocumentStore(DOC, { meta: kitMeta, snapshot: new Uint8Array([1]), blobs: new Uint8Array([2, 3]) })
    expect(bridge.WriteDocumentStore).toHaveBeenCalledWith({ doc_id: DOC, meta: kitMeta, snapshot_base64: 'AQ==', blobs_base64: 'AgM=' })
    const read = await readDocumentStore<KitReplicaMeta>(DOC)
    expect(read?.meta.fileStamp).toBe('v1')
    expect(Array.from(read?.blobs || [])).toEqual([2, 3])
    bridge.ReadDocumentStore.mockResolvedValueOnce({ meta: kitMeta, snapshot_base64: 'AQ==', blobs_base64: '%%' })
    await expect(readDocumentStore(DOC)).rejects.toThrow('blobs is not base64')
  })

  it('keeps blobs in local storage, and none for an entry written without', async () => {
    await writeDocumentStore(DOC, { meta: kitMeta, snapshot: new Uint8Array([1]), blobs: new Uint8Array([2, 3]) })
    expect(Array.from((await readDocumentStore<KitReplicaMeta>(DOC))?.blobs || [])).toEqual([2, 3])
    await writeDocumentStore(DOC, entry([4]))
    expect((await readDocumentStore(DOC))?.blobs).toBeUndefined()
  })
})

describe('document store in the browser preview', () => {
  it('keeps entries in local storage', async () => {
    await expect(readDocumentStore(DOC)).resolves.toBeNull()
    await writeDocumentStore(DOC, entry([1, 2, 3]))
    await writeDocumentStore(DOC, entry([4, 5], 'notes/b.md'))
    const read = await readDocumentStore(DOC)
    expect(read?.meta.path).toBe('notes/b.md')
    expect(Array.from(read?.snapshot || [])).toEqual([4, 5])

    await deleteDocumentStore(DOC)
    await expect(readDocumentStore(DOC)).resolves.toBeNull()
    await deleteDocumentStore(DOC)
  })

  it('reads a damaged entry as missing', async () => {
    window.localStorage.setItem(`kition.workspace.document-store.entry.v1:${DOC}`, '{"meta":{},"snapshot_base64":"AA=="}')
    await expect(readDocumentStore(DOC)).resolves.toBeNull()
    window.localStorage.setItem(`kition.workspace.document-store.entry.v1:${DOC}`, JSON.stringify({ meta: meta(), snapshot_base64: '!!' }))
    await expect(readDocumentStore(DOC)).resolves.toBeNull()
    window.localStorage.setItem(`kition.workspace.document-store.entry.v1:${DOC}`, 'not json')
    await expect(readDocumentStore(DOC)).resolves.toBeNull()
  })

  it('guards index writes by version', async () => {
    await expect(readDocumentIndex()).resolves.toEqual({ entries: {}, version: null })
    const first = await writeDocumentIndex({ 'a.md': DOC }, null)
    await expect(readDocumentIndex()).resolves.toEqual({ entries: { 'a.md': DOC }, version: first.version })

    await expect(writeDocumentIndex({}, null)).rejects.toThrow(DOCUMENT_INDEX_CONFLICT)
    const second = await writeDocumentIndex({ 'a.md': DOC, 'b/c.md': 'doc-2' }, first.version)
    expect(second.version).not.toBe(first.version)
    const stale = await writeDocumentIndex({}, first.version).catch((error: unknown) => error)
    expect(isDocumentIndexConflict(stale)).toBe(true)
    expect((await readDocumentIndex()).entries).toEqual({ 'a.md': DOC, 'b/c.md': 'doc-2' })
  })

  it('lets a damaged index be replaced under the version it reads with', async () => {
    window.localStorage.setItem('kition.workspace.document-store.index.v1', 'garbage')
    const damaged = await readDocumentIndex()
    expect(damaged.entries).toEqual({})
    expect(damaged.version).not.toBeNull()
    await expect(writeDocumentIndex({}, null)).rejects.toThrow(DOCUMENT_INDEX_CONFLICT)
    await expect(writeDocumentIndex({ 'a.md': DOC }, damaged.version)).resolves.toHaveProperty('version')
  })

  it('refuses calls meant for another workspace', async () => {
    const options = { expectedRoot: '/Users/alice/Other' }
    await expect(readDocumentStore(DOC, options)).rejects.toThrow('DESIGN_WORKSPACE_CHANGED')
    await expect(writeDocumentStore(DOC, entry([1]), options)).rejects.toThrow('DESIGN_WORKSPACE_CHANGED')
    await expect(readDocumentIndex(options)).rejects.toThrow('DESIGN_WORKSPACE_CHANGED')
    await expect(writeDocumentIndex({}, null, options)).rejects.toThrow('DESIGN_WORKSPACE_CHANGED')
    await expect(writeDocumentIndex({}, null, { expectedRoot: 'browser-local-workspace' })).resolves.toHaveProperty('version')
  })
})
