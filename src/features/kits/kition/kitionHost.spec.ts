// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'

import { renameDocument } from '@/lib/docstore/documentIndex'
import { readDocumentIndex } from '@/services/desktop'
import { setRuntimeTokenForTests } from '@/services/runtimeAuth'
import { KITION_KIT_HOST, readKitFile, readKitReplica, stampKitFile, writeKitReplica } from './kitionHost'

const bytes = (...values: number[]) => new Uint8Array(values).buffer

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('the files kits read in Kition (rule LR2)', () => {
  it("reads kits' files and lends their engines the workspace through the kit file service, never Kition's own", async () => {
    const fetched: Array<{ url: string; method: string }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      fetched.push({ url, method: init?.method ?? 'GET' })
      return new Response('abc', { headers: { etag: '"1"' } })
    })
    await expect(readKitFile('Clips/intro.mp4')).resolves.toMatchObject({ stamp: '"1"' })
    await expect(stampKitFile('Shared/a b.png')).resolves.toBe('"1"')
    expect(fetched).toEqual([
      { url: '/kit-files/Clips/intro.mp4', method: 'GET' },
      { url: '/kit-files/Shared/a%20b.png', method: 'HEAD' },
    ])
    // Engines read lent files under this root; the runtime refuses hidden paths and `.kition/` there.
    expect(KITION_KIT_HOST.lend?.('Shared/Poster.psd')).toEqual({ root: new URL('/kit-files/', window.location.href).href, folder: 'Shared' })
    // Kition itself still reads its own files, and the document a kit opens, through the workspace file service.
    await KITION_KIT_HOST.read('Shared/Poster.psd')
    expect(fetched.at(-1)).toEqual({ url: '/workspace-files/Shared/Poster.psd', method: 'GET' })
  })
})

describe("the URLs a kit is given in the desktop app (kit frame isolation, phase 1)", () => {
  afterEach(() => {
    setRuntimeTokenForTests('')
    delete (window as { kitionDesktop?: unknown }).kitionDesktop
  })

  it.each(['Untitled table 2.ktable', 'Untitled board 3.kboard'])('authenticates reads and stamps of %s with a valid file signature', async (path) => {
    window.kitionDesktop = { shell: 'tauri', backendOrigin: 'http://127.0.0.1:18101' } as typeof window.kitionDesktop
    const token = 'k'.repeat(64)
    setRuntimeTokenForTests(token)
    const methods: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      const parsed = new URL(url)
      const match = /^\/_signed\/(\d+)\.(\d+)\.([0-9a-f]+)(\/.*)$/.exec(parsed.pathname)
      if (!match) return new Response(null, { status: 401 })
      const [, expires, length, signature, target] = match
      const expected = createHmac('sha256', token).update(`${expires}\n${target.slice(0, Number(length))}`).digest('hex')
      const valid = signature === expected && Number(expires) > Date.now() / 1000 && target === `/workspace-files/${encodeURIComponent(path)}`
      return new Response(null, { status: valid ? 200 : 401, headers: { etag: '"created"' } })
    })
    await expect(KITION_KIT_HOST.read(path)).resolves.toMatchObject({ stamp: '"created"' })
    await expect(KITION_KIT_HOST.stamp(path)).resolves.toBe('"created"')
    expect(methods).toEqual(['GET', 'HEAD'])
  })

  it('lends a root signed for the kit file service only, never the API token', () => {
    window.kitionDesktop = { shell: 'tauri', backendOrigin: 'http://127.0.0.1:18101' } as typeof window.kitionDesktop
    setRuntimeTokenForTests('launch-token')
    const lent = KITION_KIT_HOST.lend?.('Shared/Poster.psd')
    expect(lent?.folder).toBe('Shared')
    expect(lent?.root).toMatch(/^http:\/\/127\.0\.0\.1:18101\/_signed\/\d+\.11\.[0-9a-f]{64}\/kit-files\/$/)
    expect(lent?.root).not.toContain('launch-token')
  })
})

describe('kit replicas in Kition', () => {
  it('keeps a kit replica under the file’s identity, through renames', async () => {
    await expect(readKitReplica('art/a.psd', 'kit.photo')).resolves.toBeNull()
    await writeKitReplica('art/a.psd', 'kit.photo', { snapshot: bytes(1, 2), blobs: bytes(3), fileStamp: 'v1', version: bytes(1) })
    const docId = (await readDocumentIndex()).entries['art/a.psd']
    expect(docId).toBeTruthy()

    const read = await readKitReplica('art/a.psd', 'kit.photo')
    expect(read?.fileStamp).toBe('v1')
    expect(Array.from(new Uint8Array(read!.snapshot))).toEqual([1, 2])
    expect(Array.from(new Uint8Array(read!.blobs))).toEqual([3])
    // Another kit's editor never takes it.
    await expect(readKitReplica('art/a.psd', 'kit.layout')).resolves.toBeNull()

    // A later save replaces it under the same identity; a rename keeps it.
    await writeKitReplica('art/a.psd', 'kit.photo', { snapshot: bytes(9), blobs: bytes(), fileStamp: 'v2', version: bytes(2) })
    expect((await readDocumentIndex()).entries['art/a.psd']).toBe(docId)
    await renameDocument('art/a.psd', 'art/b.psd')
    await expect(readKitReplica('art/a.psd', 'kit.photo')).resolves.toBeNull()
    const renamed = await readKitReplica('art/b.psd', 'kit.photo')
    expect(renamed?.fileStamp).toBe('v2')
    expect(Array.from(new Uint8Array(renamed!.snapshot))).toEqual([9])
  })

  it('takes no other kit’s entry for a kit replica', async () => {
    const { writeDocumentStore, writeDocumentIndex } = await import('@/services/desktop')
    await writeDocumentIndex({ 'notes/a.md': 'doc-1' }, null)
    await writeDocumentStore('doc-1', {
      meta: { docId: 'doc-1', kit: 'kit.note', path: 'notes/a.md', fileStamp: 'v1' },
      snapshot: new Uint8Array([1]),
      version: '',
    })
    await expect(readKitReplica('notes/a.md', 'kit.photo')).resolves.toBeNull()
  })
})

describe('kit replica writes (Kit UI protocol UI-R6)', () => {
  it('stores the snapshot whole, as the bytes the kit wrote, with the version it carries', async () => {
    const { readDocumentStore } = await import('@/services/desktop')
    // Not KDM bytes at all: the host never reads them.
    const snapshot = new TextEncoder().encode('any bytes').buffer as ArrayBuffer
    const answer = await writeKitReplica('art/a.psd', 'kit.photo', { snapshot, blobs: bytes(7), fileStamp: 'v1', version: bytes(0, 255, 16) }, { checkpoint: { origin: 'save' } })
    // The browser preview keeps no checkpoints.
    expect(answer).toEqual({})
    const docId = (await readDocumentIndex()).entries['art/a.psd']
    const entry = await readDocumentStore(docId)
    expect(new TextDecoder().decode(entry!.snapshot)).toBe('any bytes')
    expect(entry?.version).toBe(btoa(String.fromCharCode(0, 255, 16)))
    // The kit gets it back whatever the file's stamp is now (UI-R1).
    const read = await readKitReplica('art/a.psd', 'kit.photo')
    expect(read?.fileStamp).toBe('v1')
    expect(new TextDecoder().decode(read!.snapshot)).toBe('any bytes')
  })

  it('answers the checkpoint the store recorded with the write, as a kit sees it', async () => {
    const checkpoint = { id: 'c1', time: 1, origin: 'kit', label: 'Draft', version: 'AQ==' }
    const WriteDocumentStore = vi.fn(async () => ({ version: 'AQ==', checkpoint }))
    window.kitionDesktop = {
      ReadDocumentIndex: async () => ({ entries: {}, version: null }),
      WriteDocumentIndex: async () => ({ version: 'i1' }),
      WriteDocumentStore,
    } as unknown as typeof window.kitionDesktop
    try {
      const answer = await writeKitReplica('art/a.psd', 'kit.photo', { snapshot: bytes(5), blobs: bytes(), fileStamp: 'v1', version: bytes(1) }, { checkpoint: { origin: 'kit', label: 'Draft' } })
      expect(answer).toEqual({ checkpoint })
      expect(WriteDocumentStore).toHaveBeenCalledWith(expect.objectContaining({ snapshot_base64: 'BQ==', version: 'AQ==', checkpoint: { origin: 'kit', label: 'Draft' } }))
    } finally {
      delete (window as { kitionDesktop?: unknown }).kitionDesktop
    }
  })
})
