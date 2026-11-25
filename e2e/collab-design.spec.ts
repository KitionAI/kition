import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page, type Route } from '@playwright/test'
import { kitEngine, kitPackageHasReplicaInfo, openInKitFrame, requireKitPackage } from './helpers/embeddedKit'

/**
 * Design on engine contract 2 (`kit.design`, a design is a KDM replica): the agent reads and edits
 * the open design through its object model (`model/describe`, `model/batch` over the Kit AI bridge)
 * while each Undo takes back only its own side's steps (KHP E14a). The replica goes to Kition's
 * store (`.kition/docs/`). Case: kition.agent.kit-object-model/design-open-editor (its steps name
 * this file, which kept the name it had when it also held the co-editing tests).
 */

type NodeDesignDocument = { execute(command: string, params: string): string; inspect(): string; save(): Uint8Array; free(): void }
const engine = kitEngine<{ DesignDocument: { create(name: string, width: number, height: number): NodeDesignDocument; open(name: string, bytes: Uint8Array): NodeDesignDocument } }>('design', 'kition_design_kit')
const missing = 'the Design kit is not built into public/kits/design-ui'

/** A design made by the engine the page runs: the starter frame and a rectangle on it. */
async function screenFixture() {
  const sdk = await engine.load()
  const doc = sdk.DesignDocument.create('Screen.kdesign', 1440, 1024)
  doc.execute('shape.rectangle', JSON.stringify({ x: 120, y: 120, width: 320, height: 200 }))
  doc.execute('select.none', '{}')
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** The number of layers in a saved design, as the engine reads it. */
async function layersOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.DesignDocument.open('Saved.kdesign', bytes)
  const layers = (JSON.parse(doc.inspect()) as { layers: number }).layers
  doc.free()
  return layers
}

/** The open editor's layer count for `file`, as the Kit AI bridge's `inspect` answers it (Kition's development hook). */
async function liveLayers(page: Page, file: string) {
  const live = await page.evaluate(async (wanted) => (window.__KITION_KIT_TEST__ ? window.__KITION_KIT_TEST__.inspect(wanted).catch(() => null) : null), file)
  return ((live?.details as { layers?: number } | undefined)?.layers ?? null) as number | null
}

/** Draws a rectangle with the toolbar's shape tool from (`x`, `y`), fractions of the canvas. */
async function drawRectangle(page: Page, kit: FrameLocator, x: number, y: number) {
  await kit.getByTestId('design-caret-shape').click()
  await kit.getByTestId('design-flyout-tool-rectangle').click()
  const canvas = (await kit.getByTestId('kit-canvas-surface').boundingBox())!
  const from = { x: canvas.x + canvas.width * x, y: canvas.y + canvas.height * y }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 20, from.y + 15, { steps: 5 })
  await page.mouse.move(from.x + 40, from.y + 30, { steps: 5 })
  await page.mouse.up()
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

const call = (id: number, file: string, tool: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'kit/call', params: { path: file, kit: 'kit.design', tool, arguments: args } })

test("the agent reads and edits an open design through its object model, and each Undo takes back only its own side's step", async ({ page, baseURL }) => {
  requireKitPackage('design', engine.built, missing)
  requireKitPackage('design', kitPackageHasReplicaInfo('design', 'kition_design_kit'), 'the Design kit package predates engine contract 2')
  test.setTimeout(180_000)
  const agent = agentBridge()
  const file = 'Screen.kdesign'
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, file, await screenFixture(), {}, { routes: agent.routes })
  try {
    await expect(kit.getByTestId('design-toolbar')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => liveLayers(page, file), { timeout: 60_000 }).toBe(2)
    const layers = kit.getByTestId('design-layers')

    // The agent reads the object model of the open design: the kit.design schema and its layer tree.
    agent.send([call(1, file, 'describe', {}), call(2, file, 'batch', { ops: [], load: [{ target: 'root', fields: ['nodes'] }] })])
    const described = await agent.answer(1)
    expect(described.error).toBeUndefined()
    expect(described.result).toMatchObject({ kit: 'kit.design', root: 'Design', types: expect.objectContaining({ Node: expect.anything() }) })
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
    await kit.getByTestId('design-undo').click()
    await expect.poll(() => liveLayers(page, file)).toBe(3)
    await expect(layers).toContainText('Agent note')

    // The agent's undo (scope `agent`, as Kition's kit tools send it) takes back only its text.
    agent.send([call(5, file, 'run', { steps: [{ command: 'edit.undo', params: { scope: 'agent' } }], save: false })])
    const undone = await agent.answer(5)
    expect(undone.error).toBeUndefined()
    await expect.poll(() => liveLayers(page, file)).toBe(2)
    await expect(layers).not.toContainText('Agent note')

    // Saved, the file is what the editor shows; the replica is in Kition's store.
    await kit.getByTestId('design-save').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 30_000 }).toContain(file)
    expect(await layersOf(saves.at(-1)!.bytes)).toBe(2)
    await expect
      .poll(async () => {
        const index = await fs.readFile(path.join(host.root, '.kition', 'docs', 'index.json'), 'utf8').catch(() => '{}')
        return Object.keys((JSON.parse(index) as { entries?: Record<string, string> }).entries ?? {})
      }, { timeout: 30_000 })
      .toContain(file)
  } finally {
    await host.dispose()
  }
})
