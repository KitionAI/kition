import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'presentation-sdk')
const UI_MARKER = path.join(process.cwd(), 'public', 'kits', 'presentation-ui', 'kit-ui.json')
const SDK_WASM = path.join(SDK_DIR, 'kition_presentation_sdk_bg.wasm')

type NodePresentationDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodePresentationSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  PresentationDocument: { create(name: string, width: number, height: number): NodePresentationDocument; open(name: string, bytes: Uint8Array): NodePresentationDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_presentation_sdk.js')).href)) as NodePresentationSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** A real deck made by the same engine the page runs: a title slide, and a second slide with a square. */
async function deckFixture() {
  const sdk = await loadSdk()
  const doc = sdk.PresentationDocument.create('Launch.deckcraft', 960, 540)
  doc.execute('slide.new', '{}')
  doc.execute('shape.insert', JSON.stringify({ preset: 'rect', rect: [380, 170, 200, 200] }))
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

type InspectedSlide = { shapes: Array<{ preset?: string; text?: string }> }

/** The shapes on slide `index` of a saved deck. */
async function shapesIn(bytes: Buffer, index: number) {
  const sdk = await loadSdk()
  const doc = sdk.PresentationDocument.open('Saved.deckcraft', bytes)
  const slide = JSON.parse(doc.execute('slide.inspect', JSON.stringify({ index }))) as InspectedSlide
  doc.free()
  return slide.shapes
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

test('opens a deck in the Presentation kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Presentation kit editor is not built into public/kits/presentation-ui')
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  try {
    const fixture = await deckFixture()
    await fs.writeFile(path.join(host.root, 'Launch.deckcraft'), fixture)
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    const saves: Array<{ path: string | null; bytes: Buffer }> = []
    await page.route('**/api/v1/kits/files?**', async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path')
      const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0)
      saves.push({ path: target, bytes })
      await fulfillJson(route, { code: 200, message: 'success', data: { path: target, bytes: bytes.length } })
    })

    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Launch' }).first().click()

    // Kition shows the kit's editor in a frame, and the kit draws everything in it.
    await expect(page.getByTestId('kit-frame')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await expect(kit.getByTestId('ribbon-tab-home')).toHaveText('Home')
    await expect(kit.getByTestId('deck-slide-1')).toBeVisible()
    // The slide list draws each slide: the second one has its square.
    const darkPixels = () =>
      kit.getByTestId('deck-slide-1').locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
        const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
        let dark = 0
        for (let index = 0; data && index < data.length; index += 4) if (data[index] < 200) dark += 1
        return dark
      })
    await expect.poll(darkPixels, { timeout: 20_000 }).toBeGreaterThan(200)
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // The slide list goes to slide 2; a new slide and Undo work in the kit.
    await kit.getByTestId('deck-slide-1').click()
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 2 of 2')
    await kit.getByTestId('deck-add-slide').click()
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 3 of 3')
    await expect(kit.getByTestId('deck-unsaved')).toBeVisible()
    await kit.getByRole('button', { name: 'Undo' }).click()
    await expect(kit.getByTestId('deck-status')).toHaveText(/of 2$/)
    await kit.getByTestId('deck-add-slide').click()
    await expect(kit.getByTestId('deck-status')).toHaveText(/of 3$/)
    await page.screenshot({ path: testInfo.outputPath('presentation-embedded.png') })

    // Save goes through Kition's file API (host/write).
    await kit.getByTestId('deck-save').click()
    await expect(kit.getByTestId('deck-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Launch.deckcraft'])
    if (canReadBlobBodies(browserName)) {
      const sdk = await loadSdk()
      const reopened = sdk.PresentationDocument.open('Saved.deckcraft', saves[0].bytes)
      expect((JSON.parse(reopened.inspect()) as { slides: unknown[] }).slides).toHaveLength(3)
      reopened.free()
    }
  } finally {
    await host.dispose()
  }
})
