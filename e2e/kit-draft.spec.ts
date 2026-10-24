import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { serveWorkspace } from './helpers/embeddedKit'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'slide-ui', 'engine')
const SDK_WASM = path.join(SDK_DIR, 'kition_slide_sdk_bg.wasm')
const UI_MARKER = path.join(process.cwd(), 'public', 'kits', 'slide-ui', 'kit-ui.json')
const UI_ASSETS = path.join(process.cwd(), 'public', 'kits', 'slide-ui', 'assets')

type NodeSlideSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  SlideDocument: { create(name: string, width: number, height: number): { save(): Uint8Array; execute(command: string, params: string): string; free(): void } }
}

/** A two-slide slide file made by the engine the page runs. */
async function slideFixture() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_slide_sdk.js')).href)) as NodeSlideSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  const doc = sdk.SlideDocument.create('Launch.kitionslide', 960, 540)
  doc.execute('slide.new', '{}')
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** Whether the built Slide package carries a kit-ui that keeps drafts (protocol section 7d). */
async function packageKeepsDrafts() {
  if (!existsSync(UI_ASSETS)) return false
  for (const name of await fs.readdir(UI_ASSETS)) {
    if (name.endsWith('.js') && (await fs.readFile(path.join(UI_ASSETS, name), 'utf8')).includes('draft/merge')) return true
  }
  return false
}

/**
 * The runtime's bridge requests for an agent run in draft mode, one JSON-RPC message per
 * server-sent event, as `bridge.rs` sends them for `slide_run` with `draft: true` and
 * `slide_draft_ready`.
 */
function draftRunEvents(file: string) {
  const messages = [
    { jsonrpc: '2.0', method: 'bridge.ready', params: { session: 9 } },
    { jsonrpc: '2.0', id: 1, method: 'kit/call', params: { path: file, kit: 'kit.slide', tool: 'run', arguments: { steps: [{ command: 'slide.new', params: {} }], save: false, draft: true } } },
    { jsonrpc: '2.0', id: 2, method: 'kit/preview', params: { path: file, maxSize: 200, draft: true } },
    { jsonrpc: '2.0', id: 3, method: 'kit/call', params: { path: file, kit: 'kit.slide', tool: 'draft_ready', arguments: {} } },
  ]
  return messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join('')
}

test("the agent edits a slide file as a draft; the person reviews it, merges it, and undoes the merge", async ({ page, baseURL }) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Slide kit is not built into public/kits/slide-ui')
  test.skip(!(await packageKeepsDrafts()), 'the Slide package predates agent drafts; rebuild it with scripts/build-kit-ui.sh slide --ui-only')
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Launch.kitionslide'), await slideFixture())
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    let streams = 0
    await page.route('**/v1/kits/bridge', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      streams += 1
      if (streams > 1) return route.fulfill({ status: 204, body: '' })
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: draftRunEvents('Launch.kitionslide') })
    })
    const posted: Array<Record<string, unknown>> = []
    await page.route('**/v1/kits/bridge?**', async (route) => {
      posted.push(route.request().postDataJSON() as Record<string, unknown>)
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })
    const saves: string[] = []
    await page.route('**/api/v1/kits/files?**', async (route) => {
      saves.push(new URL(route.request().url()).searchParams.get('path') ?? '')
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })

    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Launch' }).first().click()
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })

    const answer = async (id: number) => {
      await expect.poll(() => posted.find((message) => message.id === id), { timeout: 30_000 }).toBeTruthy()
      return posted.find((message) => message.id === id)!
    }
    // The agent's run went to its draft: the slide file the person sees is unchanged, and nothing is saved.
    const run = (await answer(1)).result as { completed: Array<{ command: string; changed: boolean }>; saved: boolean; document: { summary: string } }
    expect(run.completed).toEqual([{ command: 'slide.new', changed: true, result: expect.anything() }])
    expect(run.saved).toBe(false)
    expect(run.document.summary).toContain('draft')
    const preview = (await answer(2)).result as { png: string }
    expect(Buffer.from(preview.png, 'base64').subarray(1, 4).toString()).toBe('PNG')
    expect((await answer(3)).result).toMatchObject({ state: 'ready' })
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2')
    await expect(kit.getByTestId('slides-unsaved')).toHaveCount(0)
    expect(saves).toEqual([])

    // The tab and the editor say there is a draft to review.
    await expect(page.getByTestId('document-tab-draft')).toHaveAttribute('data-state', 'ready')
    await expect(page.getByTestId('kit-draft-banner')).toHaveAttribute('data-state', 'ready')

    // The review compares the slide file with the draft merged, both drawn by the kit.
    await page.getByTestId('kit-draft-review').click()
    await expect(page.getByTestId('kit-draft-summary')).toContainText('added', { timeout: 30_000 })
    await expect(page.getByTestId('kit-draft-before').locator('img')).toBeVisible()
    await expect(page.getByTestId('kit-draft-after').locator('img')).toBeVisible()

    // The person merges it: one edit of the slide file, marked as the agent's, not saved yet.
    await page.getByTestId('kit-draft-merge').click()
    await expect(page.getByTestId('kit-draft-banner')).toHaveCount(0)
    await expect(page.getByTestId('document-tab-draft')).toHaveCount(0)
    await expect(kit.getByTestId('slides-status')).toHaveText(/of 3$/, { timeout: 30_000 })
    await expect(kit.getByTestId('slides-unsaved')).toBeVisible()
    await expect.poll(() => posted.some((message) => message.method === 'kit.changed' && (message.params as { by: string }).by === 'agent')).toBe(true)

    // One Undo takes the whole merge back.
    await kit.getByRole('button', { name: 'Undo' }).click()
    await expect(kit.getByTestId('slides-status')).toHaveText(/of 2$/)
  } finally {
    await host.dispose()
  }
})
