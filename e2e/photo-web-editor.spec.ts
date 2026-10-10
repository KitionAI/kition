import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'photo-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_photo_sdk_bg.wasm')

type NodePhotoSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  PhotoDocument: { create(name: string, width: number, height: number): { save(): Uint8Array; execute(command: string, params: string): string; free(): void } }
}

/** A real PSD written by the same engine the page runs: a background and the named layers. */
async function psdFixture(layers: readonly string[] = ['Ink']) {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_photo_sdk.js')).href)) as NodePhotoSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  const doc = sdk.PhotoDocument.create('Poster.psd', 96, 64)
  for (const name of layers) doc.execute('layer.new.layer', JSON.stringify({ name }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** The colour of the canvas pixel at (`fx`, `fy`) of the canvas, the centre by default. */
function centrePixel(page: Page, fx = 0.5, fy = 0.5) {
  return page.getByTestId('kit-canvas-surface').evaluate((canvas: HTMLCanvasElement, [x, y]) => {
    const context = canvas.getContext('2d')
    const data = context?.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data
    return data ? [data[0], data[1], data[2]] : null
  }, [fx, fy])
}

/** Drags on the canvas between two fractions of its box. */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.getByTestId('kit-canvas-surface').boundingBox())!
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(box.x + box.width * (from[0] + ((to[0] - from[0]) * step) / 8), box.y + box.height * (from[1] + ((to[1] - from[1]) * step) / 8))
  }
  await page.mouse.up()
}

test('edits a PSD in the page with the Photo engine and saves it back to the workspace', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the Photo engine is not built into public/kits/photo-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    const original = await psdFixture()
    await fs.writeFile(path.join(host.root, 'Poster.psd'), original)
    await mockLocalWorkspaceApi(page)
    const saves: Array<{ path: string | null; bytes: Buffer }> = []
    const file = path.join(host.root, 'Poster.psd')
    await page.route('**/workspace-files/Poster.psd', async (route) => {
      const stat = await fs.stat(file)
      await route.fulfill({
        contentType: 'image/vnd.adobe.photoshop',
        // As the runtime's file server: Last-Modified (readable across origins) and the same exposed headers.
        headers: { etag: `"${stat.mtimeMs}-${stat.size}"`, 'last-modified': stat.mtime.toUTCString(), 'access-control-expose-headers': 'ETag,Content-Range,Accept-Ranges' },
        body: await fs.readFile(file),
      })
    })
    /** The agent saves a new version of the file through its own kit connection. */
    const agentSaves = async (layers: readonly string[]) => {
      await fs.writeFile(file, await psdFixture(layers))
      const later = new Date(Date.now() + 5000)
      await fs.utimes(file, later, later)
    }
    await page.route('**/api/v1/kits/files?**', async (route) => {
      const request = route.request()
      const target = new URL(request.url()).searchParams.get('path')
      const bytes = request.postDataBuffer() ?? Buffer.alloc(0)
      saves.push({ path: target, bytes })
      await fs.writeFile(path.join(host.root, 'Poster.psd'), bytes)
      await fulfillJson(route, { code: 200, message: 'success', data: { path: target, bytes: bytes.length } })
    })


    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Poster' }).first().click()

    await expect(page.getByTestId('kit-editor')).toBeVisible()
    await expect(page.getByTestId('kit-status-bar')).toContainText('96 x 64 px, Rgb, 8-bit, 2 layers', { timeout: 30_000 })
    await expect(page.getByTestId('photo-kit-layers')).toContainText('Ink')
    await expect(page.getByTestId('kit-menu-Layer')).toBeVisible()
    await expect(page.getByTestId('photo-web-stats')).toContainText('Render')
    await expect.poll(() => centrePixel(page)).toEqual([255, 255, 255])

    // Paint across the middle of the image with the brush.
    const surface = page.getByTestId('kit-canvas-surface')
    const box = (await surface.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx - 120, cy)
    await page.mouse.down()
    for (let step = 1; step <= 12; step += 1) await page.mouse.move(cx - 120 + step * 20, cy)
    await page.mouse.up()
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()
    await expect.poll(() => centrePixel(page)).toEqual([0, 0, 0])
    await page.screenshot({ path: testInfo.outputPath('photo-web-editor.png') })

    // Undo and redo run in the engine.
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => centrePixel(page)).toEqual([255, 255, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await expect.poll(() => centrePixel(page)).toEqual([0, 0, 0])

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.getByTestId('kit-unsaved')).toHaveCount(0)
    expect(saves).toHaveLength(1)
    expect(saves[0].path).toBe('Poster.psd')
    if (canReadBlobBodies(browserName)) {
      expect(saves[0].bytes.subarray(0, 4).toString()).toBe('8BPS')
      expect(saves[0].bytes.equals(original)).toBe(false)
    }

    // With nothing unsaved, the tab follows the agent's new version of the file.
    await agentSaves(['Ink', 'Agent'])
    await expect(page.getByTestId('photo-kit-layers')).toContainText('Agent', { timeout: 10_000 })
    await expect(page.getByTestId('kit-file-changed')).toHaveCount(0)

    // With unsaved edits, it asks before replacing them.
    await page.mouse.move(cx - 60, cy + 40)
    await page.mouse.down()
    await page.mouse.move(cx + 60, cy + 40)
    await page.mouse.up()
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()
    await agentSaves(['Ink', 'Agent', 'Agent two'])
    await expect(page.getByTestId('kit-file-changed')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('photo-kit-layers')).not.toContainText('Agent two')
    await page.getByTestId('kit-file-reload').click()
    await expect(page.getByTestId('photo-kit-layers')).toContainText('Agent two')
    await expect(page.getByTestId('kit-unsaved')).toHaveCount(0)
    await expect(page.getByTestId('kit-file-changed')).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})

test('selects, fills, draws shapes and text, and crops with the in-page tools', async ({ page, baseURL }) => {
  test.skip(!existsSync(SDK_WASM), 'the Photo engine is not built into public/kits/photo-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    const file = path.join(host.root, 'Poster.psd')
    await fs.writeFile(file, await psdFixture())
    await mockLocalWorkspaceApi(page)
    await page.route('**/workspace-files/Poster.psd', async (route) => {
      await route.fulfill({ contentType: 'image/vnd.adobe.photoshop', headers: { etag: '"1"' }, body: await fs.readFile(file) })
    })
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Poster' }).first().click()
    const status = page.getByTestId('kit-status-bar')
    await expect(status).toContainText('96 x 64 px', { timeout: 30_000 })

    // A marquee around the centre, then the paint bucket fills only the selection.
    await page.getByTestId('photo-tool-RectMarquee').click()
    await drag(page, [0.4, 0.4], [0.6, 0.6])
    await page.getByTestId('photo-tool-PaintBucket').click()
    const box = (await page.getByTestId('kit-canvas-surface').boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect.poll(() => centrePixel(page)).toEqual([0, 0, 0])
    expect(await centrePixel(page, 0.3, 0.5)).toEqual([255, 255, 255])

    // Command shortcuts come from the engine: Cmd+D deselects.
    await page.getByTestId('kit-editor').press('ControlOrMeta+d')
    await page.getByTestId('photo-tool-Rectangle').click()
    await drag(page, [0.3, 0.3], [0.38, 0.38])
    await expect(page.getByTestId('photo-kit-layers')).toContainText('Rectangle', { timeout: 10_000 })

    await page.getByTestId('photo-tool-Type').click()
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.7)
    await page.getByTestId('photo-text-field').fill('Hello')
    await page.getByTestId('photo-text-field').press('Enter')
    await expect(page.getByTestId('photo-kit-layers')).toContainText('Hello', { timeout: 10_000 })

    // The brush-like tools and the magic wand run their own engine commands. They paint pixel
    // layers, so the Background is chosen first (the engine refuses Type layers, as Photoshop does).
    await page.getByTestId('photo-kit-layers').getByText('Background', { exact: true }).click()
    for (const tool of ['Blur', 'Dodge', 'SpotHealing', 'HistoryBrush']) {
      await page.getByTestId(`photo-tool-${tool}`).click()
      await drag(page, [0.2, 0.8], [0.5, 0.85])
    }
    await page.getByTestId('photo-tool-CloneStamp').click()
    await expect(page.getByTestId('photo-clone-hint')).toBeVisible()
    await page.keyboard.down('Alt')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await page.keyboard.up('Alt')
    await expect(page.getByTestId('photo-clone-hint')).toHaveCount(0)
    await drag(page, [0.75, 0.3], [0.8, 0.35])
    await page.getByTestId('photo-tool-MagicWand').click()
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2)
    await expect(page.getByText('The change could not be applied', { exact: true })).toHaveCount(0)

    // Crop proposes an area; Enter applies it.
    await page.getByTestId('photo-tool-Crop').click()
    await drag(page, [0.3, 0.3], [0.7, 0.7])
    await expect(page.getByTestId('photo-crop-apply')).toBeVisible()
    await page.getByTestId('kit-editor').press('Enter')
    await expect(status).not.toContainText('96 x 64 px')
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()
  } finally {
    await host.dispose()
  }
})
