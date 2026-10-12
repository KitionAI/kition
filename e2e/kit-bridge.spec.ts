import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'vector-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_vector_sdk_bg.wasm')

type NodeVectorSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  VectorDocument: { create(name: string, width: number, height: number): { save(): Uint8Array; execute(command: string, params: string): string; free(): void } }
}

/** A 400 x 300 pt drawing with one rectangle, made by the engine the page runs. */
async function drawingFixture() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_vector_sdk.js')).href)) as NodeVectorSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  const doc = sdk.VectorDocument.create('Logo.vectorcraft', 400, 300)
  doc.execute('shape.rectangle', JSON.stringify({ x: 20, y: 20, width: 80, height: 60 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

async function serveWorkspace(page: Page, root: string) {
  await page.route('**/workspace-files/**', async (route: Route) => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/workspace-files\//, ''))
    const file = path.join(root, relative)
    if (!file.startsWith(root) || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
    const stat = await fs.stat(file)
    const headers = { etag: `"${stat.mtimeMs}-${stat.size}"`, 'last-modified': stat.mtime.toUTCString(), 'access-control-expose-headers': 'ETag,Content-Range,Accept-Ranges', 'content-type': 'application/octet-stream' }
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers, body: '' })
    return route.fulfill({ status: 200, headers, body: await fs.readFile(file) })
  })
}

/** The runtime's bridge requests, one JSON-RPC message per server-sent event, as `bridge.rs` sends them. */
function bridgeEvents(file: string) {
  const messages = [
    { jsonrpc: '2.0', method: 'bridge.ready', params: { session: 7 } },
    { jsonrpc: '2.0', id: 1, method: 'kit/documents', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'kit/call', params: { path: file, kit: 'kit.vector', tool: 'commands', arguments: { query: 'ellipse' } } },
    { jsonrpc: '2.0', id: 3, method: 'kit/call', params: { path: file, kit: 'kit.vector', tool: 'run', arguments: { steps: [{ command: 'shape.ellipse', params: { x: 200, y: 100, width: 120, height: 120 } }], save: false } } },
    { jsonrpc: '2.0', id: 4, method: 'kit/preview', params: { path: file, maxSize: 200 } },
    { jsonrpc: '2.0', id: 5, method: 'kit/call', params: { path: file, kit: 'kit.vector', tool: 'run', arguments: { steps: [{ command: 'no.such.command' }], save: false } } },
    { jsonrpc: '2.0', id: 6, method: 'kit/call', params: { path: 'other.vectorcraft', kit: 'kit.vector', tool: 'inspect', arguments: {} } },
  ]
  return messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join('')
}

const UI_MARKER = path.join(process.cwd(), 'public', 'kits', 'vector-ui', 'kit-ui.json')

// The same bridge, to Kition's own editor for the kit and to the kit's embedded editor (KitFrame).
for (const editor of ['kition', 'embedded'] as const) {
test(`the agent edits a drawing open in the page through the Kit AI bridge (${editor} editor)`, async ({ page, baseURL }) => {
  test.skip(!existsSync(SDK_WASM), 'the Vector engine is not built into public/kits/vector-sdk')
  test.skip(editor === 'embedded' && !existsSync(UI_MARKER), 'the Vector kit editor is not built into public/kits/vector-ui')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Logo.vectorcraft'), await drawingFixture())
    await mockLocalWorkspaceApi(page)
    if (editor === 'kition') await page.route('**/kits/vector-ui/kit-ui.json', (route) => route.fulfill({ status: 404, body: '' }))
    await serveWorkspace(page, host.root)
    let streams = 0
    await page.route('**/v1/kits/bridge', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      streams += 1
      // The first stream carries the requests; a reconnect is told there is nothing more.
      if (streams > 1) return route.fulfill({ status: 204, body: '' })
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: bridgeEvents('Logo.vectorcraft') })
    })
    const posted: Array<{ session: string | null; message: Record<string, unknown> }> = []
    await page.route('**/v1/kits/bridge?**', async (route) => {
      const url = new URL(route.request().url())
      posted.push({ session: url.searchParams.get('session'), message: route.request().postDataJSON() as Record<string, unknown> })
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })

    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Logo' }).first().click()
    // The editor offers the open drawing to the bridge as soon as it has opened it.
    const view = editor === 'kition' ? page : page.frameLocator('[data-testid="kit-frame-window"]')
    const marks = editor === 'kition' ? { unsaved: 'kit-unsaved', agent: 'kit-agent-edited' } : { unsaved: 'vector-unsaved', agent: 'vector-agent-edited' }
    await expect(view.getByTestId('vector-status')).toContainText('objects', { timeout: 30_000 })

    const answer = async (id: number) => {
      await expect.poll(() => posted.find((entry) => entry.message.id === id), { timeout: 30_000 }).toBeTruthy()
      return posted.find((entry) => entry.message.id === id)!
    }
    const documents = await answer(1)
    expect(documents.session).toBe('7')
    expect(documents.message.result).toEqual({ documents: [{ path: 'Logo.vectorcraft', kit: 'kit.vector', dirty: false, revision: expect.any(Number) }] })

    const commands = (await answer(2)).message.result as { commands: Array<{ id: string; description: string | null }>; total: number }
    expect(commands.commands.map((command) => command.id)).toContain('shape.ellipse')
    expect(commands.commands.find((command) => command.id === 'shape.ellipse')?.description).toContain('Params:')

    // The edit runs in the open editor: it shows at once, unsaved, marked as the agent's.
    const run = (await answer(3)).message.result as { completed: Array<{ command: string; changed: boolean }>; saved: boolean; document: { dirty: boolean; canUndo: boolean } }
    expect(run.completed).toEqual([{ command: 'shape.ellipse', changed: true, result: expect.anything() }])
    expect(run.saved).toBe(false)
    expect(run.document).toMatchObject({ dirty: true, canUndo: true })
    await expect(view.getByTestId('vector-status')).toContainText('2 objects')
    await expect(view.getByTestId(marks.unsaved)).toBeVisible()
    await expect(view.getByTestId(marks.agent)).toBeVisible()
    await expect.poll(() => posted.some((entry) => entry.message.method === 'kit.changed' && (entry.message.params as { by: string }).by === 'agent')).toBe(true)

    const preview = (await answer(4)).message.result as { png: string }
    expect(Buffer.from(preview.png, 'base64').subarray(1, 4).toString()).toBe('PNG')

    // Failures are errors the agent can read, never silent.
    expect((await answer(5)).message.error).toMatchObject({ message: expect.stringContaining('no.such.command') })
    expect((await answer(6)).message.error).toMatchObject({ message: expect.stringContaining('not open in a kit editor') })

    // The agent's edit joined the undo history: the person undoes it like their own.
    await view.getByRole('button', { name: 'Undo' }).click()
    await expect(view.getByTestId('vector-status')).toContainText('1 objects')
    await expect(view.getByTestId(marks.agent)).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})
}
