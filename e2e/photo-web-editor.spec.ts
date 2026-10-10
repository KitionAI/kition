import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'photo-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_photo_sdk_bg.wasm')

type NodePhotoSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  PhotoDocument: { create(name: string, width: number, height: number): { save(): Uint8Array; execute(command: string, params: string): string; free(): void } }
}

/** A real two-layer PSD written by the same engine the page runs. */
async function psdFixture() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_photo_sdk.js')).href)) as NodePhotoSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  const doc = sdk.PhotoDocument.create('Poster.psd', 96, 64)
  doc.execute('layer.new.layer', JSON.stringify({ name: 'Ink' }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** The colour of the canvas pixel at the centre of the image area. */
function centrePixel(page: Page) {
  return page.getByTestId('photo-web-canvas-surface').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')
    const data = context?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
    return data ? [data[0], data[1], data[2]] : null
  })
}

test('edits a PSD in the page with the Photo engine and saves it back to the workspace', async ({ page, baseURL }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the Photo engine is not built into public/kits/photo-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    const original = await psdFixture()
    await fs.writeFile(path.join(host.root, 'Poster.psd'), original)
    await mockLocalWorkspaceApi(page)
    const saves: Array<{ path: string | null; bytes: Buffer }> = []
    await page.route('**/workspace-files/Poster.psd', async (route) => {
      await route.fulfill({ contentType: 'image/vnd.adobe.photoshop', body: await fs.readFile(path.join(host.root, 'Poster.psd')) })
    })
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

    await expect(page.getByTestId('photo-web-editor')).toBeVisible()
    await expect(page.getByTestId('photo-status-bar')).toContainText('96 x 64 px, Rgb, 8-bit, 2 layers', { timeout: 30_000 })
    await expect(page.getByTestId('photo-kit-layers')).toContainText('Ink')
    await expect(page.getByTestId('photo-menu-Layer')).toBeVisible()
    await expect(page.getByTestId('photo-web-stats')).toContainText('Render')
    await expect.poll(() => centrePixel(page)).toEqual([255, 255, 255])

    // Paint across the middle of the image with the brush.
    const surface = page.getByTestId('photo-web-canvas-surface')
    const box = (await surface.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx - 120, cy)
    await page.mouse.down()
    for (let step = 1; step <= 12; step += 1) await page.mouse.move(cx - 120 + step * 20, cy)
    await page.mouse.up()
    await expect(page.getByTestId('photo-kit-unsaved')).toBeVisible()
    await expect.poll(() => centrePixel(page)).toEqual([0, 0, 0])
    await expect(page.getByTestId('photo-web-stats')).toContainText('Stroke')
    await page.screenshot({ path: testInfo.outputPath('photo-web-editor.png') })

    // Undo and redo run in the engine.
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => centrePixel(page)).toEqual([255, 255, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await expect.poll(() => centrePixel(page)).toEqual([0, 0, 0])

    await page.getByTestId('photo-kit-save').click()
    await expect(page.getByText('Image saved', { exact: true })).toBeVisible()
    await expect(page.getByTestId('photo-kit-unsaved')).toHaveCount(0)
    expect(saves).toHaveLength(1)
    expect(saves[0].path).toBe('Poster.psd')
    expect(saves[0].bytes.subarray(0, 4).toString()).toBe('8BPS')
    expect(saves[0].bytes.equals(original)).toBe(false)
  } finally {
    await host.dispose()
  }
})
