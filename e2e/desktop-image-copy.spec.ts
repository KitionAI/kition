import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

test('copies an opened workspace image from its context menu through the desktop clipboard', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(60_000)
  const imageBytes = await fs.readFile(path.join(process.cwd(), 'public', 'logo-mark.png'))
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    await page.route('**/workspace-files/Generated%20preview.png', (route) => route.fulfill({
      contentType: 'image/png', body: imageBytes,
    }))
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.evaluate(async (base64) => {
      await window.kitionDesktop!.ImportWorkspaceFile!({ folder: '', filename: 'Generated preview.png', base64_content: base64 })
    }, imageBytes.toString('base64'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.document-tree-row', { hasText: 'Generated preview' }).first().click()
    const preview = page.locator('.workspace-file-viewer.is-active img')
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await preview.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy image', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('image-copy-menu.png') })
    await page.getByRole('menuitem', { name: 'Copy image', exact: true }).click()
    await expect(page.getByText('Image copied', { exact: true })).toBeVisible()
    expect(host.clipboard.imageSource).toMatch(/\/workspace-files\/Generated%20preview\.png$/)
    expect(host.clipboard.text).toBe('')
  } finally {
    await host.dispose()
  }
})
