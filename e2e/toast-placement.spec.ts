import { expect, test } from '@playwright/test'

import { openNote } from './helpers/noteKit'

// Toasts must never cover the tab chrome: one about the workspace (here, a file no application
// could open) would otherwise hide the close button of the tab beside it.

test('a workspace error toast leaves the tab strip clickable', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openNote(page, baseURL!, 'Offline.md', '# Offline\n\nKeep this.\n', { 'data.json': Buffer.from('{}') }, {
    desktop: { overrides: { open_workspace_file: () => 'No application can open data.json' } },
  })
  // A JSON file opens in the system's application, which fails here.
  await page.locator('.document-tree-row', { hasText: 'data.json' }).first().click()
  const toast = page.locator('.kui-toast').first()
  await expect(toast).toBeVisible({ timeout: 10_000 })

  const tabBox = await page.locator('.document-tab-list').first().boundingBox()
  expect(tabBox).not.toBeNull()
  // Once it has slid in, the toast sits below the tab strip.
  await expect.poll(async () => (await toast.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(tabBox!.y + tabBox!.height)

  // The close button takes the click (the toast does not intercept it).
  const tabs = page.locator('.document-tab-list .document-tab')
  const open = await tabs.count()
  await page.locator('.document-tab-list .document-tab-close').first().click({ timeout: 2_000 })
  await expect(tabs).toHaveCount(open - 1)
})
