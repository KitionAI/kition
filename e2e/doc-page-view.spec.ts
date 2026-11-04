import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'

type Doc = { save(): Uint8Array; free(): void }
const engine = kitEngine<{ DocDocument: { create(name: string, width: number, height: number): Doc } }>('doc', 'kition_doc_sdk')

test.use({ viewport: { width: 2048, height: 1140 }, deviceScaleFactor: 2 })

async function blankFixture() {
  const sdk = await engine.load()
  const document = sdk.DocDocument.create('Blank.docx', 612, 792)
  const bytes = Buffer.from(document.save())
  document.free()
  return bytes
}

test('blank documents open at reading scale with margin corner marks', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(60_000)
  const bytes = await blankFixture()
  const { host, kit, saves } = await openInKitFrame(page, baseURL!, 'Blank.docx', bytes)
  try {
    await expect(kit.getByTestId('doc-status')).toHaveText('Page 1 of 1', { timeout: 30_000 })
    await expect(kit.getByTestId('kit-zoom')).toHaveText('133%')
    await page.screenshot({ path: testInfo.outputPath('blank-page-view.png') })
    const overlay = kit.getByTestId('kit-canvas-surface')
    await expect.poll(() => overlay.evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let guides = 0
      const caretRows = new Set<number>()
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] === 200 && pixels[i + 1] === 196 && pixels[i + 2] === 190 && pixels[i + 3] > 0) guides += 1
        if (pixels[i] === 20 && pixels[i + 1] === 20 && pixels[i + 2] === 20 && pixels[i + 3] > 0) caretRows.add(Math.floor(i / 4 / canvas.width))
      }
      const caretHeight = caretRows.size / window.devicePixelRatio
      return guides > 40 && caretHeight > 8 && caretHeight < 32 ? 'ready' : JSON.stringify({ guides, caretHeight })
    })).toBe('ready')
    await expect(kit.getByTestId('doc-unsaved')).toHaveCount(0)
    expect(saves).toHaveLength(0)
    await page.screenshot({ path: testInfo.outputPath('blank-page-view.png') })
  } finally {
    await host.dispose()
  }
})

test('document paper stays close to the toolbar in tall windows', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 2048, height: 1800 })
  const { host, kit, saves } = await openInKitFrame(page, baseURL!, 'Blank.docx', await blankFixture())
  try {
    await expect(kit.getByTestId('doc-status')).toHaveText('Page 1 of 1', { timeout: 30_000 })
    const surface = kit.getByTestId('kit-canvas-surface')
    for (const height of [1800, 800, 1500]) {
      await page.setViewportSize({ width: 2048, height })
      await expect.poll(async () => {
        const gap = await surface.evaluate((canvas: HTMLCanvasElement) => {
          const pixels = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), 0, 1, canvas.height).data
          for (let y = 0; y < canvas.height; y += 1) {
            if (pixels[y * 4] === 255 && pixels[y * 4 + 1] === 255 && pixels[y * 4 + 2] === 255) return y / window.devicePixelRatio
          }
          return canvas.clientHeight
        })
        return gap >= 16 && gap <= 24 ? 'ready' : `${gap}px`
      }).toBe('ready')
      await expect(kit.getByTestId('kit-zoom')).toHaveText('133%')
    }
    await expect(kit.getByTestId('doc-unsaved')).toHaveCount(0)
    expect(saves).toHaveLength(0)
    await page.screenshot({ path: testInfo.outputPath('compact-page-gap.png') })
  } finally {
    await host.dispose()
  }
})
