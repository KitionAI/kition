import fs from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { installDesktopHost } from './helpers/desktopHost'

import {
  changeDocumentIndexExternally,
  failDocumentIndexWrites,
  failDocumentStoreWrites,
  readDocumentStoreState,
} from './helpers/documentStore'
import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

/** The renderer's store client, loaded by the page from the Vite dev server. */
const CLIENT_MODULE = '/src/services/desktopClient/documentStore.ts'
const DOC = '0199c2a4-7b3e-7cde-8f00-1234567890ab'
const META = {
  docId: DOC,
  kit: 'kit.document' as const,
  path: 'table-test.md',
  fileHash: 'abc',
  fileStamp: null,
  exported: '00',
  style: { eol: '\n', bom: false, finalNewline: true },
}

declare global {
  interface Window {
    __KITION_DOCUMENT_STORE_CLIENT__?: typeof import('../src/services/desktopClient/documentStore')
  }
}

/**
 * Opens a Markdown document and loads the store client into `window.__KITION_DOCUMENT_STORE_CLIENT__`. The open
 * document's session keeps its own replica in the store; the tests work next to it (another path, another id).
 */
async function openFixture(page: Page, reload = false) {
  if (reload) {
    await page.reload()
  } else {
    await mockLocalWorkspaceApi(page)
    // `other.md` exists, so the store prune of a workspace open keeps the index entry the tests give it.
    await mockDesktopBridge(page, '# Store\n', { 'other.md': '# Other\n' })
    await page.goto('/')
  }
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(async (clientModule) => {
    window.__KITION_DOCUMENT_STORE_CLIENT__ = await import(/* @vite-ignore */ new URL(clientModule, window.location.href).href)
  }, CLIENT_MODULE)
  // The session of the open document has stored its replica.
  await expect.poll(async () => (await readDocumentStoreState(page)).index.entries['table-test.md']).toBeTruthy()
}

test.describe('document replica store over the mock desktop bridge', () => {
  test('stores replicas and the guarded index, and keeps them across a reload', async ({ page }) => {
    await openFixture(page)
    const before = await readDocumentStoreState(page)

    const read = await page.evaluate(async ({ docId, meta }) => {
      const store = window.__KITION_DOCUMENT_STORE_CLIENT__!
      await store.writeDocumentStore(docId, { meta, snapshot: new Uint8Array([0, 1, 2, 255]) })
      const entry = await store.readDocumentStore(docId)
      return { meta: entry?.meta, snapshot: Array.from(entry?.snapshot || []) }
    }, { docId: DOC, meta: META })
    expect(read).toEqual({ meta: META, snapshot: [0, 1, 2, 255] })

    const versions = await page.evaluate(async (docId) => {
      const store = window.__KITION_DOCUMENT_STORE_CLIENT__!
      const current = await store.readDocumentIndex()
      const first = await store.writeDocumentIndex({ ...current.entries, 'other.md': docId }, current.version)
      const stale = await store.writeDocumentIndex({}, current.version)
        .then(() => 'written', (error: unknown) => (store.isDocumentIndexConflict(error) ? 'conflict' : String(error)))
      return { current: current.version, first: first.version, stale }
    }, DOC)
    expect(versions.current).toEqual(expect.any(String))
    expect(versions.first).toEqual(expect.any(String))
    expect(versions.first).not.toBe(versions.current)
    expect(versions.stale).toBe('conflict')

    let state = await readDocumentStoreState(page)
    expect(state.entries[DOC]).toEqual({ meta: META, snapshotBase64: 'AAEC/w==' })
    expect(state.index).toEqual({ entries: { ...before.index.entries, 'other.md': DOC }, version: versions.first })
    expect(state.entryWrites - before.entryWrites).toBe(1)
    expect(state.indexWrites - before.indexWrites).toBe(2)

    await openFixture(page, true)
    const afterReload = await page.evaluate(async (docId) => {
      const store = window.__KITION_DOCUMENT_STORE_CLIENT__!
      return {
        snapshot: Array.from((await store.readDocumentStore(docId))?.snapshot || []),
        index: await store.readDocumentIndex(),
      }
    }, DOC)
    expect(afterReload.snapshot).toEqual([0, 1, 2, 255])
    expect(afterReload.index.entries).toEqual(expect.objectContaining({ 'other.md': DOC }))

    const beforeDelete = await readDocumentStoreState(page)
    await page.evaluate((docId) => window.__KITION_DOCUMENT_STORE_CLIENT__!.deleteDocumentStore(docId), DOC)
    state = await readDocumentStoreState(page)
    expect(state.entries[DOC]).toBeUndefined()
    expect(state.deletes - beforeDelete.deletes).toBe(1)
  })

  test('fails writes on request and conflicts after another writer changes the index', async ({ page }) => {
    await openFixture(page)
    const before = await readDocumentStoreState(page)

    await failDocumentStoreWrites(page, 'disk full')
    await failDocumentIndexWrites(page, 'index locked')
    const failures = await page.evaluate(async ({ docId, meta }) => {
      const store = window.__KITION_DOCUMENT_STORE_CLIENT__!
      const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
      return {
        entry: await store.writeDocumentStore(docId, { meta, snapshot: new Uint8Array([1]) }).then(() => 'written', message),
        index: await store.writeDocumentIndex({}, null).then(() => 'written', message),
        invalid: await store.readDocumentStore('../escape').then(() => 'read', message),
      }
    }, { docId: DOC, meta: META })
    expect(failures).toEqual({ entry: 'disk full', index: 'index locked', invalid: 'invalid document id' })
    let state = await readDocumentStoreState(page)
    expect(state.entries[DOC]).toBeUndefined()
    expect(state.entryWrites - before.entryWrites).toBe(1)
    expect(state.indexWrites - before.indexWrites).toBe(1)

    await failDocumentStoreWrites(page, null)
    await failDocumentIndexWrites(page, null)
    const version = await page.evaluate(async (docId) => {
      const store = window.__KITION_DOCUMENT_STORE_CLIENT__!
      const current = await store.readDocumentIndex()
      return (await store.writeDocumentIndex({ 'a.md': docId }, current.version)).version
    }, DOC)
    await changeDocumentIndexExternally(page, { 'b.md': DOC })
    const outcome = await page.evaluate(async (expected) => {
      const store = window.__KITION_DOCUMENT_STORE_CLIENT__!
      return store.writeDocumentIndex({}, expected)
        .then(() => 'written', (error: unknown) => (store.isDocumentIndexConflict(error) ? 'conflict' : String(error)))
    }, version)
    expect(outcome).toBe('conflict')
    state = await readDocumentStoreState(page)
    expect(state.index.entries).toEqual({ 'b.md': DOC })
  })
})

test('the desktop shell stand-in keeps the store in .kition/docs out of the tree and out of Git', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Note.md'), '# Note\n')
    await mockLocalWorkspaceApi(page)
    await page.goto(new URL('/documents', baseURL as string).toString(), { waitUntil: 'commit' })
    await expect(page.getByTestId('document-tree')).toBeVisible({ timeout: 30_000 })
    await page.evaluate(async (clientModule) => {
      window.__KITION_DOCUMENT_STORE_CLIENT__ = await import(/* @vite-ignore */ new URL(clientModule, window.location.href).href)
    }, CLIENT_MODULE)

    // The open note's session stores its replica first; this test writes next to it.
    await expect.poll(() => page.evaluate(async () => (
      (await window.__KITION_DOCUMENT_STORE_CLIENT__!.readDocumentIndex()).entries['Note.md'] ?? null
    )), { timeout: 15_000 }).not.toBeNull()
    const result = await page.evaluate(async ({ docId, meta }) => {
      const store = window.__KITION_DOCUMENT_STORE_CLIENT__!
      await store.writeDocumentStore(docId, { meta: { ...meta, path: 'Other.md' }, snapshot: new Uint8Array([7, 8, 9]) })
      const current = await store.readDocumentIndex()
      const { version } = await store.writeDocumentIndex({ ...current.entries, 'Other.md': docId }, current.version)
      const entry = await store.readDocumentStore(docId)
      return { version, snapshot: Array.from(entry?.snapshot || []), index: await store.readDocumentIndex() }
    }, { docId: DOC, meta: META })
    expect(result.snapshot).toEqual([7, 8, 9])
    expect(result.index.version).toBe(result.version)
    expect(result.index.entries).toEqual(expect.objectContaining({ 'Other.md': DOC }))

    const store = path.join(host.root, '.kition', 'docs')
    expect(await fs.readFile(path.join(store, '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n')
    expect([...await fs.readFile(path.join(store, DOC, 'snapshot.bin'))]).toEqual([7, 8, 9])
    expect(JSON.parse(await fs.readFile(path.join(store, 'index.json'), 'utf8')).entries).toEqual(expect.objectContaining({ 'Other.md': DOC }))
    expect(host.calls.map((call) => call.command)).toEqual(expect.arrayContaining(['write_document_store', 'write_document_index', 'read_document_store']))
    await expect(page.getByTestId('document-tree')).not.toContainText('.kition')
  } finally {
    await host.dispose()
  }
})
