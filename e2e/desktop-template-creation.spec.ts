import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { mockTemplateCreationApi } from './helpers/templateCreationApi'

for (const template of [
  { id: 'receipt-ocr-database', count: 10, title: 'Receipt OCR Table', assetFolder: 'receipt-ocr-database' },
  { id: 'thumbnail-generator', count: 5, title: 'YouTube & TikTok Thumbnail Generator', assetFolder: 'youtube-tiktok-thumbnail-generator' },
]) {
test(`creates ${template.id} with bundled images and populated cells in Electron`, async ({ baseURL }, testInfo) => {
  test.setTimeout(90_000)
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-template-creation-'))
  const app = await electron.launch({
    executablePath: electronPath, cwd: process.cwd(), args: ['.'],
    env: { ...process.env, KITION_ELECTRON_DEV_SERVER_URL: baseURL!,
      KITION_DESKTOP_SKIP_API: 'true', KITION_ELECTRON_TEST_DATA_DIR: profile },
  })
  try {
    const page = await app.firstWindow()
    await mockLocalWorkspaceApi(page)
    const { records, uploads } = await mockTemplateCreationApi(page)
    await page.addInitScript(() => {
      const draws = { text: [] as string[], images: [] as string[] }
      Object.assign(window, { __templateDraws: draws })
      const fillText = CanvasRenderingContext2D.prototype.fillText
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
        draws.text.push(text)
        return fillText.call(this, text, x, y, maxWidth)
      }
      const drawImage = CanvasRenderingContext2D.prototype.drawImage
      CanvasRenderingContext2D.prototype.drawImage = function (...args: Parameters<typeof drawImage>) {
        if (args[0] instanceof HTMLImageElement && args[0].naturalWidth > 0) draws.images.push(args[0].src)
        return drawImage.apply(this, args)
      }
    })
    await page.goto(new URL('/documents', baseURL!).toString())
    await dismissFirstRunActivation(page)
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    const card = page.getByTestId(`kitable-template-card-${template.id}`)
    await card.hover()
    await card.getByRole('button', { name: 'Use', exact: true }).click()
    // The first table opens the lazy editor bundle on a cold development server.
    await expect(page.getByTestId('kitable-editor')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.data-inline-footer')).toContainText(`${template.count} records`)
    expect(records).toHaveLength(template.count)
    expect(uploads).toEqual([])
    expect(records.every((record) => Object.values(record.values).some((value) =>
      Array.isArray(value) && value.some((item) => typeof item === 'object' && item && 'url' in item && String(item.url).startsWith('kition-bundled:/')),
    ))).toBe(true)
    const firstText = String(records[0].values.field_0).slice(0, 15)
    const expectedImages = records.flatMap((_record, index) => {
      const folder = `/${template.assetFolder}/records/record-${String(index + 1).padStart(2, '0')}/`
      return (template.id === 'receipt-ocr-database'
        ? ['receipt.webp'] : ['face-photo-01.webp', 'thumbnail-16x9-01.webp', 'thumbnail-16x9-02.webp'])
        .map((filename) => `${folder}${filename}`)
    })
    const expectSampleContent = async () => {
      await expect.poll(() => page.evaluate(({ firstText, expectedImages }) => {
        const draws = (window as unknown as { __templateDraws: { text: string[]; images: string[] } }).__templateDraws
        return { text: draws.text.some((text) => text.includes(firstText)),
          images: expectedImages.every((path) => draws.images.some((url) => url.endsWith(path))) }
      }, { firstText, expectedImages })).toEqual({ text: true, images: true })
    }
    await expectSampleContent()
    await page.screenshot({ path: testInfo.outputPath('template-created.png') })
    await page.reload()
    await page.locator('.document-tab-list .document-tab', { hasText: template.title }).click()
    await expect(page.getByTestId('kitable-editor')).toBeVisible()
    await expect(page.locator('.data-inline-footer')).toContainText(`${template.count} records`)
    await expectSampleContent()
    await page.screenshot({ path: testInfo.outputPath('template-reopened.png') })
    expect(uploads).toEqual([])
  } finally {
    await app.close()
    await fs.rm(profile, { recursive: true, force: true })
  }
})

}
