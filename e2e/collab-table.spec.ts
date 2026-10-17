import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openKitWorkspace } from './helpers/embeddedKit'
import { DOC_MARKER, emitTableReplicaChanged, mockKitableDataDocumentApi } from './helpers/kitableApi'
import { fulfillJson } from './helpers/mockApi'
import {
  DEV_PRINCIPALS,
  kitionProSkipReason,
  openSharedLink,
  openTabMenu,
  recordWebSockets,
  shareFromTab,
  shareViewOnlyFromTab,
  signedIn,
  startKitionPro,
  syncNetwork,
  useSyncServer,
} from './helpers/kitionPro'

// Co-editing a table (`.kitable`) between two windows through the Kition Pro sync server. No e2e
// spec runs the real runtime, so each window's runtime is the Kitable mock
// (`mockKitableDataDocumentApi`): the table's KDM replica is a real one kept in the page (its
// exports are what the mock's `replica/export` answers, and a local edit is announced with
// `table/replica-changed`, as the runtime does), and the mock records what the relay imports. The
// relays, the room, the share and open flows, and the viewer's read-only editor are the real ones.

type Mock = Awaited<ReturnType<typeof mockKitableDataDocumentApi>>

/** A small table schema under the Table kit's id: the server and the relay only read envelopes and versions. */
const TABLE_SCHEMA = { kdm: 1, kit: 'kit.table', schemaVersion: 1, root: 'Base', types: { Base: { fields: { title: { kind: 'text' }, rows: { kind: 'list', of: 'Row' } } }, Row: { fields: { title: { kind: 'string' } } } } }

/**
 * The page's stand-in for the runtime's replica of the table: made (or loaded from `from`, a
 * full export in base64), kept on `window`, and answered as base64 exports and versions.
 */
async function pageReplica(page: Page, docId: string, from: string | null) {
  return page.evaluate(async ({ schema, id, snapshot }) => {
    const kdm = await import(/* @vite-ignore */ new URL('/src/lib/kdm/index.ts', window.location.href).href)
    const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
    const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
    const parsed = kdm.parseSchema(schema)
    const replica = snapshot
      ? kdm.Replica.load(parsed, fromBase64(snapshot), kdm.randomActor())
      : kdm.Replica.createWith(parsed, id, kdm.randomActor(), kdm.system('create'), (tx: { create: (type: string, init: object) => string }) => tx.create('Base', {})).replica
    const state = window as unknown as { __tableReplica: unknown; __tableReplicaBytes: () => { changes: string; version: string } }
    state.__tableReplica = replica
    state.__tableReplicaBytes = () => ({ changes: toBase64(replica.exportChanges()), version: toBase64(replica.version().encode()) })
    return state.__tableReplicaBytes()
  }, { schema: TABLE_SCHEMA, id: docId, snapshot: from })
}

/** A local edit of the page's table replica (a row titled `title`); answers its export and version. */
async function editRow(page: Page, title: string) {
  return page.evaluate(async (rowTitle) => {
    const kdm = await import(/* @vite-ignore */ new URL('/src/lib/kdm/index.ts', window.location.href).href)
    const state = window as unknown as { __tableReplica: any; __tableReplicaBytes: () => { changes: string; version: string } }
    const replica = state.__tableReplica
    const root = replica.objectsOfType('Base')[0]
    replica.transact(kdm.person('user:e2e', 'edit'), (tx: any) => {
      const row = tx.create('Row', { title: rowTitle })
      tx.listInsert(root, 'rows', tx.list(root, 'rows').length, row)
    })
    return state.__tableReplicaBytes()
  }, title)
}

/** Imports changes (base64) into the page's table replica, as the runtime would; answers the row titles. */
async function importAndReadRows(page: Page, changes: string[]) {
  return page.evaluate((all) => {
    const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
    const replica = (window as unknown as { __tableReplica: any }).__tableReplica
    for (const bytes of all) if (bytes) replica.importChanges(fromBase64(bytes))
    const root = replica.objectsOfType('Base')[0]
    return (replica.list(root, 'rows') as string[]).map((row) => replica.get(row, 'title') as string).sort()
  }, changes)
}

/** Sets what the mock's replica routes answer, and announces the change as the runtime does. */
async function announce(page: Page, mock: Mock, bytes: { changes: string; version: string }, documentPath: string) {
  mock.replica.changes = bytes.changes
  mock.replica.version = bytes.version
  await emitTableReplicaChanged(page, { documentPath, docId: mock.replica.docId, version: bytes.version })
}

/** A window with the Kitable mock as its runtime; `files` go to its workspace. */
async function openTableWorkspace(page: Page, baseURL: string, token: string | null, files: Record<string, Buffer>, extraRoutes?: (page: Page, mock: Mock) => Promise<void>) {
  const session = token ? signedIn(token) : null
  let mock!: Mock
  const workspace = await openKitWorkspace(page, baseURL, files, {
    ...(session ?? {}),
    routes: async (target) => {
      await session?.routes(target)
      mock = await mockKitableDataDocumentApi(target)
      // The runtime lists the table file at its workspace path, so the tree opens its tables.
      mock.document.path = Object.keys(files).find((name) => name.endsWith('.kitable')) ?? mock.document.path
      // Opens the kit bridge stream before the app connects, so notifications arrive at once.
      await emitTableReplicaChanged(target, { documentPath: '.none.kitable', docId: '', version: '' })
      await extraRoutes?.(target, mock)
    },
  })
  return { ...workspace, mock }
}

/** Makes `Shared/<name>` in Bob's workspace when his app creates the shared table (the mock writes no file). */
function createSharedTable(root: () => string, initial: () => { changes: string; version: string }) {
  return async (page: Page, mock: Mock) => {
    await page.route('**/api/v1/data-documents/replica/create', async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as { path?: string; changes?: string }
      const target = path.join(root(), body.path ?? '')
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, DOC_MARKER)
      mock.replica.created.push({ path: body.path ?? '', changes: body.changes ?? '' })
      mock.document.path = body.path ?? mock.document.path
      mock.replica.changes = body.changes ?? ''
      mock.replica.version = initial().version
      return fulfillJson(route, { code: 200, data: { documentId: '1', documentPath: body.path, docId: mock.replica.docId, version: mock.replica.version } })
    })
  }
}

async function openTasks(page: Page) {
  await page.locator('.document-tree-row', { hasText: 'Tasks' }).first().click()
  await expect(page.getByTestId('kitable-editor')).toBeVisible({ timeout: 30_000 })
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

test('co-edits a table between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openTableWorkspace(pageA, baseURL!, DEV_PRINCIPALS.alice, { 'Tasks.kitable': Buffer.from(DOC_MARKER) })
    const shared = await pageReplica(pageA, a.mock.replica.docId, null)
    a.mock.replica.changes = shared.changes
    a.mock.replica.version = shared.version
    await openTasks(pageA)
    const link = await shareFromTab(pageA, 'Tasks')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: Shared/Tasks.kitable, made from the room's snapshot (replica/create).
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    let bobRoot = ''
    const b = await openTableWorkspace(pageB, baseURL!, DEV_PRINCIPALS.bob, {}, createSharedTable(() => bobRoot, () => shared))
    bobRoot = b.host.root
    await openSharedLink(pageB, link)
    await expect(pageB.getByTestId('kitable-editor')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => b.mock.replica.created.map((entry) => entry.path)).toEqual(['Shared/Tasks.kitable'])
    await pageReplica(pageB, b.mock.replica.docId, b.mock.replica.created[0].changes)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Alice's runtime commits an edit: within a second Bob's runtime imports it.
    const edited = await editRow(pageA, 'From Alice')
    const importedBefore = b.mock.replica.imported.length
    await announce(pageA, a.mock, edited, 'Tasks.kitable')
    const at = Date.now()
    await expect.poll(() => b.mock.replica.imported.slice(importedBefore).includes(edited.changes), { timeout: 5_000, intervals: [20] }).toBe(true)
    const live = Date.now() - at
    testInfo.annotations.push({ type: 'live edit to the other window', description: `${live} ms` })
    expect(live).toBeLessThan(1_000)
    expect(await importAndReadRows(pageB, b.mock.replica.imported)).toEqual(['From Alice'])

    // Bob goes offline and edits; Alice edits meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    await announce(pageB, b.mock, await editRow(pageB, 'From Bob offline'), 'Shared/Tasks.kitable')
    await announce(pageA, a.mock, await editRow(pageA, 'From Alice meanwhile'), 'Tasks.kitable')
    await pageA.waitForTimeout(500)
    expect(await importAndReadRows(pageA, a.mock.replica.imported)).not.toContain('From Bob offline')

    // Back online: each runtime got the other's edits, and the replicas agree.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    const everything = ['From Alice', 'From Alice meanwhile', 'From Bob offline']
    await expect.poll(() => importAndReadRows(pageA, a.mock.replica.imported), { timeout: 60_000 }).toEqual(everything)
    await expect.poll(() => importAndReadRows(pageB, b.mock.replica.imported), { timeout: 60_000 }).toEqual(everything)
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('a viewer of a shared table cannot change it', async ({ browser, baseURL }, testInfo) => {
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(240_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  try {
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openTableWorkspace(pageA, baseURL!, DEV_PRINCIPALS.alice, { 'Tasks.kitable': Buffer.from(DOC_MARKER) })
    const shared = await pageReplica(pageA, a.mock.replica.docId, null)
    a.mock.replica.changes = shared.changes
    a.mock.replica.version = shared.version
    await openTasks(pageA)
    const { viewLink } = await shareViewOnlyFromTab(pageA, 'Tasks')

    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    let bobRoot = ''
    const b = await openTableWorkspace(pageB, baseURL!, DEV_PRINCIPALS.bob, {}, createSharedTable(() => bobRoot, () => shared))
    bobRoot = b.host.root
    const writes: string[] = []
    pageB.on('request', (request) => {
      if (request.method() === 'POST' && /\/data-documents\/\d+\/transact$/.test(new URL(request.url()).pathname)) writes.push(request.url())
    })
    await openSharedLink(pageB, viewLink)
    await expect(pageB.getByTestId('kitable-editor')).toHaveAttribute('data-read-only', 'true', { timeout: 30_000 })
    await expect(pageB.locator('.document-tab-list [data-testid="collab-view-only"]')).toBeVisible({ timeout: 15_000 })
    await pageB.locator('.data-inline-add-record-button').first().click({ timeout: 5_000 }).catch(() => undefined)
    await pageB.waitForTimeout(500)
    expect(writes).toEqual([])

    // A viewer's relay never pushes: Bob's runtime announcing a change sends nothing to the room.
    await pageReplica(pageB, b.mock.replica.docId, b.mock.replica.created[0].changes)
    const importedBefore = a.mock.replica.imported.length
    await announce(pageB, b.mock, await editRow(pageB, 'From the viewer'), 'Shared/Tasks.kitable')
    await pageB.waitForTimeout(1_000)
    expect(a.mock.replica.imported.length).toBe(importedBefore)
    // Alice's edits still reach him.
    const edited = await editRow(pageA, 'From Alice')
    await announce(pageA, a.mock, edited, 'Tasks.kitable')
    await expect.poll(() => b.mock.replica.imported.includes(edited.changes), { timeout: 10_000 }).toBe(true)
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a table opens as before, with no sync connection and no replica calls', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const replicaCalls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/data-documents/replica/')) replicaCalls.push(request.url())
  })
  const { host } = await openTableWorkspace(page, baseURL!, null, { 'Tasks.kitable': Buffer.from(DOC_MARKER) })
  try {
    await openTasks(page)
    await openTabMenu(page, 'Tasks', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('kitable-editor')).not.toHaveAttribute('data-read-only', 'true')
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
    expect(replicaCalls).toEqual([])
  } finally {
    await host.dispose()
  }
})
