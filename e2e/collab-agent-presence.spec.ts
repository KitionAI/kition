import { expect, test, type Page, type Route } from '@playwright/test'
import { fulfillJson } from './helpers/mockApi'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, shareFromTab, signedIn, startKitionPro, useSyncServer } from './helpers/kitionPro'

type NodeVectorDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ VectorDocument: { create(name: string, width: number, height: number): NodeVectorDocument } }>('vector', 'kition_vector_sdk')

/** A drawing with one rectangle, made by the same engine the page runs. */
async function drawingFixture() {
  const sdk = await engine.load()
  const doc = sdk.VectorDocument.create('Plan.kvector', 400, 300)
  doc.execute('shape.rectangle', JSON.stringify({ x: 20, y: 20, width: 120, height: 90 }))
  doc.execute('select.none', '{}')
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/**
 * The runtime's side of the Kit AI bridge for one window, as `bridge.rs` streams it: once `go`
 * resolves, the agent edits `file` live (`kit/call` run). Answers what the window posted back.
 */
async function agentBridge(page: Page, file: string, go: Promise<void>) {
  const posted: Array<Record<string, unknown>> = []
  let streams = 0
  await page.route('**/v1/kits/bridge', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    streams += 1
    // The first stream carries the agent's request; a reconnect is told there is nothing more.
    if (streams > 1) return route.fulfill({ status: 204, body: '' })
    await go
    const messages = [
      { jsonrpc: '2.0', method: 'bridge.ready', params: { session: 3 } },
      { jsonrpc: '2.0', id: 1, method: 'kit/call', params: { path: file, kit: 'kit.vector', tool: 'run', arguments: { steps: [{ command: 'shape.ellipse', params: { x: 220, y: 120, width: 90, height: 90 } }], save: false } } },
    ]
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join('') })
  })
  await page.route('**/v1/kits/bridge?**', async (route: Route) => {
    posted.push(route.request().postDataJSON() as Record<string, unknown>)
    await fulfillJson(route, { code: 200, message: 'success', data: {} })
  })
  return posted
}

const peers = (page: Page) => page.locator('.document-tab-list [data-testid="collab-peer"]')

test("the agent's edit on a shared drawing shows the agent in every viewer's presence", async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Vector kit editor is not built into public/kits/vector-ui')
  test.skip(!kitPackageHasReplicaInfo('vector', 'kition_vector_sdk'), 'the Vector kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh vector')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(240_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  try {
    // Alice opens her drawing, with her agent ready to edit it, and shares it.
    let startAgent = () => {}
    const agentGo = new Promise<void>((resolve) => (startAgent = resolve))
    let posted: Array<Record<string, unknown>> = []
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const signedInAlice = signedIn(DEV_PRINCIPALS.alice)
    const a = await openInKitFrame(pageA, baseURL!, 'Plan.kvector', await drawingFixture(), {}, {
      ...signedInAlice,
      routes: async (page) => {
        await signedInAlice.routes(page)
        posted = await agentBridge(page, 'Plan.kvector', agentGo)
      },
    })
    await expect(a.kit.getByTestId('vector-status')).toContainText('1 objects', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Plan')
    await expect(pageA.locator('.document-tab-list [data-testid="collab-status"]')).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: he sees Alice, and no agent yet.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('vector-status')).toContainText('1 objects', { timeout: 60_000 })
    await expect(peers(pageB).first()).toHaveAttribute('data-peer', 'Alice', { timeout: 15_000 })
    await expect(peers(pageB).and(pageB.locator('[data-agent="true"]'))).toHaveCount(0)

    // Alice's agent edits the drawing in her open editor: Bob sees the edit, and the agent with it.
    startAgent()
    await expect.poll(() => posted.find((message) => message.id === 1), { timeout: 30_000 }).toBeTruthy()
    expect(posted.find((message) => message.id === 1)?.result).toMatchObject({ completed: [{ command: 'shape.ellipse', changed: true }] })
    await expect(a.kit.getByTestId('vector-status')).toContainText('2 objects')
    await expect(kitB.getByTestId('vector-status')).toContainText('2 objects', { timeout: 15_000 })
    const agentOnB = pageB.locator('.document-tab-list [data-testid="collab-peer"][data-agent="true"]')
    await expect(agentOnB).toHaveAttribute('data-peer', 'Agent', { timeout: 15_000 })
    await expect(agentOnB).toHaveCSS('background-color', 'rgb(86, 69, 212)')
    await expect(pageB.locator('.document-tab-list [data-testid="collab-presence"]')).toHaveAttribute('aria-label', /Alice, Agent/)
    // Alice sees her own agent at work too.
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"][data-agent="true"]')).toHaveAttribute('data-peer', 'Agent', { timeout: 15_000 })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})
