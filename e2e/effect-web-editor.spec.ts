import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'effect-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_effect_sdk_bg.wasm')

type NodeEffectDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodeEffectSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  EffectDocument: { create(name: string, width: number, height: number): NodeEffectDocument }
}

/**
 * A real project made by the same engine the page runs: a 640 x 360, two-second composition
 * with a red solid that fades in over its first second.
 */
async function projectFixture() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_effect_sdk.js')).href)) as NodeEffectSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  const doc = sdk.EffectDocument.create('Intro.ecproj', 640, 360)
  doc.execute('comp.settings', JSON.stringify({ duration: 2 }))
  doc.execute('layer.newSolid', JSON.stringify({ name: 'Red', color: '#ff0000' }))
  const layer = (JSON.parse(doc.inspect()) as { info: { layers: Array<{ id: number }> } }).info.layers[0].id
  doc.execute('prop.addKey', JSON.stringify({ layer, path: 'transform/opacity', time: 0, value: 0 }))
  doc.execute('prop.addKey', JSON.stringify({ layer, path: 'transform/opacity', time: 1, value: 100 }))
  doc.execute('layer.select', JSON.stringify({ layers: [] }))
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
    // As the runtime's file server: Last-Modified (readable across origins) and the same exposed headers.
    const headers = { etag: `"${stat.mtimeMs}-${stat.size}"`, 'last-modified': stat.mtime.toUTCString(), 'access-control-expose-headers': 'ETag,Content-Range,Accept-Ranges', 'content-type': 'application/octet-stream' }
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers, body: '' })
    return route.fulfill({ status: 200, headers, body: await fs.readFile(file) })
  })
}

/** The canvas pixel at the centre. */
function centre(page: Page) {
  return page.getByTestId('kit-canvas-surface').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
    return data ? [data[0], data[1], data[2]] : null
  })
}

test('animates a composition in the page with the Effect engine, saves it, and renders an MP4', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the Effect engine is not built into public/kits/effect-sdk')
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Intro.ecproj'), await projectFixture())
    await mockLocalWorkspaceApi(page)
    // This spec covers Kition's own editor for the kit; the kit's embedded one has effect-embedded.spec.ts.
    await page.route('**/kits/effect-ui/kit-ui.json', (route) => route.fulfill({ status: 404, body: '' }))
    await serveWorkspace(page, host.root)
    const writes: Array<{ path: string | null; bytes: Buffer }> = []
    await page.route('**/api/v1/kits/files?**', async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path')
      const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0)
      writes.push({ path: target, bytes })
      await fulfillJson(route, { code: 200, message: 'success', data: { path: target, bytes: bytes.length } })
    })

    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Intro' }).first().click()

    await expect(page.getByTestId('effect-status')).toContainText('Comp 1: 640 × 360, 30 fps, 1 layers', { timeout: 30_000 })
    await expect(page.getByTestId('kit-menu-Composition')).toBeVisible()
    await expect(page.getByTestId('effect-key')).toHaveCount(2)
    await expect(page.getByTestId('effect-timecode')).toHaveText('0:00:00:00')
    // At 0 s the solid is fully transparent over the black background.
    await expect.poll(() => centre(page)).toEqual([0, 0, 0])

    // Scrubbing the ruler moves the current time; past one second the solid is opaque.
    const ruler = (await page.getByTestId('effect-ruler').boundingBox())!
    await page.mouse.click(ruler.x + ruler.width * 0.75, ruler.y + ruler.height / 2)
    await expect(page.getByTestId('effect-timecode')).toHaveText(/^0:00:01:/)
    await expect.poll(() => centre(page)).toEqual([255, 0, 0])

    // Selecting the layer shows its Transform; moving it away leaves the centre black.
    await page.getByTestId(/^effect-layer-/).first().click()
    await expect(page.getByTestId('effect-properties-panel')).toContainText('Opacity')
    const x = page.getByTestId('effect-value-position-0')
    await x.fill('2000')
    await x.press('Enter')
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()
    await expect.poll(() => centre(page)).toEqual([0, 0, 0])
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => centre(page)).toEqual([255, 0, 0])

    // A new text layer from the transport's menu.
    await page.getByTestId('effect-new-layer').click()
    await page.getByTestId('effect-new-text').click()
    await expect(page.getByTestId('effect-status')).toContainText('2 layers')
    await page.screenshot({ path: testInfo.outputPath('effect-web-editor.png') })

    // Playback runs the time forward from the start.
    await page.getByTestId('effect-timecode').click()
    await page.keyboard.press('Home')
    await expect(page.getByTestId('effect-timecode')).toHaveText('0:00:00:00')
    await page.getByTestId('effect-play').click()
    await expect(page.getByTestId('effect-timecode')).not.toHaveText('0:00:00:00')
    await page.getByTestId('effect-play').click()

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    expect(writes.map((write) => write.path)).toEqual(['Intro.ecproj'])
    if (canReadBlobBodies(browserName)) expect(JSON.parse(writes[0].bytes.toString('utf8')).items).toBeTruthy()

    // Render MP4 writes a new movie beside the project and leaves the project saved.
    await page.getByTestId('effect-render').click()
    await expect(page.getByText('Rendered Intro.mp4')).toBeVisible({ timeout: 60_000 })
    expect(writes.map((write) => write.path)).toEqual(['Intro.ecproj', 'Intro.mp4'])
    if (canReadBlobBodies(browserName)) expect(writes[1].bytes.subarray(4, 8).toString()).toBe('ftyp')
    await expect(page.getByTestId('kit-unsaved')).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})

test('creates a new motion project from the create menu with the Effect engine', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the Effect engine is not built into public/kits/effect-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    // This spec covers Kition's own editor for the kit; the kit's embedded one has effect-embedded.spec.ts.
    await page.route('**/kits/effect-ui/kit-ui.json', (route) => route.fulfill({ status: 404, body: '' }))
    await serveWorkspace(page, host.root)
    const written: string[] = []
    await page.route('**/api/v1/kits/files?**', async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path') ?? ''
      written.push(target)
      await fs.writeFile(path.join(host.root, target), route.request().postDataBuffer() ?? Buffer.alloc(0))
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByTestId('workspace-create-motion').click()

    await expect.poll(() => written, { timeout: 60_000 }).toEqual(['Untitled motion.ecproj'])
    await expect(page.getByTestId('effect-status')).toContainText('Comp 1: 1920 × 1080, 30 fps, 0 layers', { timeout: 60_000 })
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled motion' })).toBeVisible()
  } finally {
    await host.dispose()
  }
})
