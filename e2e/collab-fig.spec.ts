import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page, type Route } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, openTabMenu, recordWebSockets, replicaCounters, sameReplicas, shareFromTab, signedIn, startKitionPro, syncNetwork, useSyncServer } from './helpers/kitionPro'

/**
 * Fig on engine contract 2 (`kit.fig`, a design is a KDM replica): two people co-edit a `.kfig`
 * live and across going offline, and in one window the agent reads and edits the open design
 * through its object model (`model/describe`, `model/batch` over the Kit AI bridge) while each
 * Undo takes back only its own side's steps (KHP E14a). The replica goes to Kition's store
 * (`.kition/docs/`). Cases: kition.kit-collab.fig/live-and-offline, kition.agent.kit-object-model/fig-open-editor.
 */

type NodeFigDocument = { execute(command: string, params: string): string; inspect(): string; save(): Uint8Array; free(): void }
const engine = kitEngine<{ FigDocument: { create(name: string, width: number, height: number): NodeFigDocument; open(name: string, bytes: Uint8Array): NodeFigDocument } }>('fig', 'kition_fig_sdk')
const missing = 'the Fig kit is not built into public/kits/fig-ui (scripts/build-kit-ui.sh fig)'

/** A design made by the engine the page runs: the starter frame and a rectangle on it. */
async function screenFixture() {
  const sdk = await engine.load()
  const doc = sdk.FigDocument.create('Screen.kfig', 1440, 1024)
  doc.execute('shape.rectangle', JSON.stringify({ x: 120, y: 120, width: 320, height: 200 }))
  doc.execute('select.none', '{}')
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** The number of layers in a saved design, as the engine reads it. */
async function layersOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.FigDocument.open('Saved.kfig', bytes)
  const layers = (JSON.parse(doc.inspect()) as { layers: number }).layers
  doc.free()
  return layers
}

/** The open editor's layer count for `file`, as the Kit AI bridge's `inspect` answers it (Kition's development hook). */
async function liveLayers(page: Page, file: string) {
  const live = await page.evaluate(async (wanted) => (window.__KITION_KIT_TEST__ ? window.__KITION_KIT_TEST__.inspect(wanted).catch(() => null) : null), file)
  return ((live?.details as { layers?: number } | undefined)?.layers ?? null) as number | null
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

/** Draws a rectangle with the toolbar's shape tool from (`x`, `y`), fractions of the canvas. */
async function drawRectangle(page: Page, kit: FrameLocator, x: number, y: number) {
  await kit.getByTestId('fig-caret-shape').click()
  await kit.getByTestId('fig-flyout-tool-rectangle').click()
  const canvas = (await kit.getByTestId('kit-canvas-surface').boundingBox())!
  const from = { x: canvas.x + canvas.width * x, y: canvas.y + canvas.height * y }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 20, from.y + 15, { steps: 5 })
  await page.mouse.move(from.x + 40, from.y + 30, { steps: 5 })
  await page.mouse.up()
}

/** The replica version at `file` once it stops changing. */
async function settledVersion(page: Page, file: string) {
  let previous = ''
  await expect
    .poll(async () => {
      const next = JSON.stringify(await replicaCounters(page, file))
      const stable = next === previous
      previous = next
      return stable
    }, { timeout: 10_000, intervals: [30] })
    .toBe(true)
  return previous
}

/**
 * The runtime's side of the Kit AI bridge for one window, as `bridge.rs` streams it: each `send`
 * is one stream of requests (the window reconnects for the next), and `answer` waits for the
 * window's reply to a request id.
 */
function agentBridge() {
  const posted: Array<Record<string, unknown>> = []
  const waiting: Array<(messages: Array<Record<string, unknown>>) => void> = []
  const queued: Array<Array<Record<string, unknown>>> = []
  let session = 10
  const next = () => new Promise<Array<Record<string, unknown>>>((resolve) => (queued.length ? resolve(queued.shift()!) : waiting.push(resolve)))
  const routes = async (page: Page) => {
    await page.route('**/v1/kits/bridge', async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const messages = await next()
      session += 1
      const events = [{ jsonrpc: '2.0', method: 'bridge.ready', params: { session } }, ...messages]
      // `retry` makes the window's EventSource come back at once for the next stream.
      const body = `retry: 100\n\n${events.map((message) => `data: ${JSON.stringify(message)}\n\n`).join('')}`
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body }).catch(() => undefined)
    })
    await page.route('**/v1/kits/bridge?**', async (route: Route) => {
      posted.push(route.request().postDataJSON() as Record<string, unknown>)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, message: 'success', data: {} }) })
    })
  }
  const send = (messages: Array<Record<string, unknown>>) => {
    const resolve = waiting.shift()
    if (resolve) resolve(messages)
    else queued.push(messages)
  }
  const answer = async (id: number) => {
    await expect.poll(() => posted.find((message) => message.id === id), { timeout: 30_000 }).toBeTruthy()
    return posted.find((message) => message.id === id)! as { result?: Record<string, unknown>; error?: { message: string } }
  }
  return { routes, send, answer }
}

const call = (id: number, file: string, tool: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'kit/call', params: { path: file, kit: 'kit.fig', tool, arguments: args } })

test('co-edits a Fig design between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, missing)
  test.skip(!kitPackageHasReplicaInfo('fig', 'kition_fig_sdk'), 'the Fig kit package predates engine contract 2; build it with scripts/build-kit-ui.sh fig')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her design and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Screen.kfig', await screenFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('fig-toolbar')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => liveLayers(pageA, 'Screen.kfig'), { timeout: 60_000 }).toBe(2)
    const link = await shareFromTab(pageA, 'Screen')
    expect(link).toMatch(/\/s\/\S+$/)
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the design is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('fig-toolbar')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => liveLayers(pageB, 'Shared/Screen.kfig'), { timeout: 60_000 }).toBe(2)
    expect(existsSync(path.join(b.host.root, 'Shared', 'Screen.kfig'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Screen.kfig', pageB, 'Shared/Screen.kfig'), { timeout: 15_000 }).toBe('same')

    // Alice draws a rectangle: within a second Bob's replica has it, and his editor shows it.
    const drawBaseline = JSON.stringify(await replicaCounters(pageB, 'Shared/Screen.kfig'))
    await drawRectangle(pageA, a.kit, 0.4, 0.4)
    const drawn = Date.now()
    await expect.poll(() => liveLayers(pageA, 'Screen.kfig')).toBe(3)
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Screen.kfig')), { intervals: [10] }).not.toBe(drawBaseline)
    const aliceVersion = await settledVersion(pageA, 'Screen.kfig')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Screen.kfig')), { timeout: 5_000, intervals: [20] }).toBe(aliceVersion)
    const drawLive = Date.now() - drawn
    testInfo.annotations.push({ type: 'live draw to the other window', description: `${drawLive} ms` })
    expect(drawLive).toBeLessThan(1_000)
    await expect.poll(() => liveLayers(pageB, 'Shared/Screen.kfig'), { timeout: 5_000 }).toBe(3)

    // Bob draws one too: Alice's design follows.
    await drawRectangle(pageB, kitB, 0.6, 0.6)
    await expect.poll(() => liveLayers(pageB, 'Shared/Screen.kfig')).toBe(4)
    const bobVersion = await settledVersion(pageB, 'Shared/Screen.kfig')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Screen.kfig')), { timeout: 5_000, intervals: [20] }).toBe(bobVersion)
    await expect.poll(() => liveLayers(pageA, 'Screen.kfig'), { timeout: 5_000 }).toBe(4)

    // Bob goes offline and draws a rectangle; Alice draws one meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    await drawRectangle(pageB, kitB, 0.3, 0.7)
    await expect.poll(() => liveLayers(pageB, 'Shared/Screen.kfig')).toBe(5)
    await drawRectangle(pageA, a.kit, 0.7, 0.3)
    await expect.poll(() => liveLayers(pageA, 'Screen.kfig')).toBe(5)

    // Back online, both merge on their own: the same replica, with both new rectangles.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => sameReplicas(pageA, 'Screen.kfig', pageB, 'Shared/Screen.kfig'), { timeout: 60_000 }).toBe('same')
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    await expect.poll(() => liveLayers(pageA, 'Screen.kfig')).toBe(6)
    await expect.poll(() => liveLayers(pageB, 'Shared/Screen.kfig')).toBe(6)
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test("the agent reads and edits an open Fig design through its object model, and each Undo takes back only its own side's step", async ({ page, baseURL }) => {
  test.skip(!engine.built, missing)
  test.skip(!kitPackageHasReplicaInfo('fig', 'kition_fig_sdk'), 'the Fig kit package predates engine contract 2; build it with scripts/build-kit-ui.sh fig')
  test.setTimeout(180_000)
  // A sync server is configured, but nobody is signed in: co-editing stays off.
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const agent = agentBridge()
  const file = 'Screen.kfig'
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, file, await screenFixture(), {}, { routes: agent.routes })
  try {
    await expect(kit.getByTestId('fig-toolbar')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => liveLayers(page, file), { timeout: 60_000 }).toBe(2)
    const layers = kit.getByTestId('fig-layers')

    // The agent reads the object model of the open design: the kit.fig schema and its layer tree.
    agent.send([call(1, file, 'describe', {}), call(2, file, 'batch', { ops: [], load: [{ target: 'root', fields: ['nodes'] }] })])
    const described = await agent.answer(1)
    expect(described.error).toBeUndefined()
    expect(described.result).toMatchObject({ kit: 'kit.fig', root: 'Fig', types: expect.objectContaining({ Node: expect.anything() }) })
    const read = await agent.answer(2)
    expect(read.error).toBeUndefined()
    const nodes = ((read.result?.loaded as Array<{ fields: { nodes: Array<{ object: string; parent: string | null }> } }>)[0]?.fields.nodes) ?? []
    const pageObject = nodes.find((node) => node.parent === null)?.object
    expect(pageObject).toBeTruthy()

    // It renames the page with a batch: the editor shows the new name.
    agent.send([call(3, file, 'batch', { ops: [{ op: 'set', target: pageObject, field: 'name', value: 'Cover' }], load: [{ target: pageObject, fields: ['name'] }] })])
    const renamed = await agent.answer(3)
    expect(renamed.error).toBeUndefined()
    expect(renamed.result?.loaded).toEqual([expect.objectContaining({ id: pageObject, fields: { name: 'Cover' } })])
    await expect.poll(async () => {
      const live = await page.evaluate(async (wanted) => window.__KITION_KIT_TEST__?.inspect(wanted).catch(() => null) ?? null, file)
      return ((live?.details as { pages?: Array<{ name: string }> } | undefined)?.pages ?? []).map((entry) => entry.name)
    }, { timeout: 15_000 }).toEqual(['Cover'])

    // The person draws a rectangle; then the agent adds a text layer beside the frame.
    await drawRectangle(page, kit, 0.45, 0.45)
    await expect.poll(() => liveLayers(page, file)).toBe(3)
    agent.send([call(4, file, 'run', { steps: [{ command: 'text.create', params: { text: 'Agent note', x: 1600, y: 100 } }], save: false })])
    const added = await agent.answer(4)
    expect(added.error).toBeUndefined()
    expect(added.result).toMatchObject({ completed: [{ command: 'text.create', changed: true }] })
    await expect.poll(() => liveLayers(page, file)).toBe(4)
    await expect(layers).toContainText('Agent note', { timeout: 15_000 })

    // The person's Undo takes back the person's rectangle, not the agent's newer text.
    await kit.getByTestId('fig-undo').click()
    await expect.poll(() => liveLayers(page, file)).toBe(3)
    await expect(layers).toContainText('Agent note')

    // The agent's undo (scope `agent`, as Kition's kit tools send it) takes back only its text.
    agent.send([call(5, file, 'run', { steps: [{ command: 'edit.undo', params: { scope: 'agent' } }], save: false })])
    const undone = await agent.answer(5)
    expect(undone.error).toBeUndefined()
    await expect.poll(() => liveLayers(page, file)).toBe(2)
    await expect(layers).not.toContainText('Agent note')

    // Saved, the file is what the editor shows; the replica is in Kition's store, and no sync
    // connection was made.
    await kit.getByTestId('fig-save').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 30_000 }).toContain(file)
    expect(await layersOf(saves.at(-1)!.bytes)).toBe(2)
    await expect
      .poll(async () => {
        const index = await fs.readFile(path.join(host.root, '.kition', 'docs', 'index.json'), 'utf8').catch(() => '{}')
        return Object.keys((JSON.parse(index) as { entries?: Record<string, string> }).entries ?? {})
      }, { timeout: 30_000 })
      .toContain(file)
    await openTabMenu(page, 'Screen', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
