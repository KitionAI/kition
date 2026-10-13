import { expect, test } from '@playwright/test'

import { DEFAULT_DOC_PATH, failMarkdownFileWrites, mockDesktopBridge, readDocumentIdOf } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

// Toasts must never cover the tab chrome: a persistent one (a save that keeps failing) would
// otherwise hide the close button of the tab it is about.

test('a persistent save-failure toast leaves the tab strip clickable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Offline\n\nKeep this.\n')
  await page.goto('/')
  const content = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(content).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => readDocumentIdOf(page, DEFAULT_DOC_PATH)).toBeTruthy()
  await failMarkdownFileWrites(page, 'The folder is gone')

  await content.locator('.cm-line', { hasText: 'Keep this.' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Unsaved.')
  const toast = page.locator('[data-sonner-toast]').first()
  await expect(toast).toBeVisible({ timeout: 10_000 })

  const tabBox = await page.locator('.document-tab-list').first().boundingBox()
  expect(tabBox).not.toBeNull()
  // Once it has slid in, the toast sits below the tab strip.
  await expect.poll(async () => (await toast.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(tabBox!.y + tabBox!.height)

  // The close button takes the click (the toast does not intercept it).
  await page.locator('.document-tab-list .document-tab-close').first().click({ timeout: 2_000 })
  await expect(page.getByTestId('document-close-unsaved-confirm')).toBeVisible()
})
