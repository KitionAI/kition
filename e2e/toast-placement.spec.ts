import { expect, test } from '@playwright/test'

import { installDesktopHost } from './helpers/desktopHost'
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

// A notice raised while Settings is open must not cover the pane's title or its action bar (U14):
// here the Getting Started setup fails on first run, after Settings opened from its URL.
test('a notice raised while Settings is open leaves the pane title and action bar readable', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  const host = await installDesktopHost(page)
  try {
    await page.route('**/onboarding/manifest.json', (route) => route.fulfill({ status: 500, body: 'unavailable' }))
    await page.goto(new URL('/settings?section=display', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()

    const toast = page.getByRole('alert').filter({ hasText: 'Getting Started' })
    await expect(toast).toBeVisible({ timeout: 10_000 })
    const covered = async (selector: string) => {
      const target = await page.locator(selector).first().boundingBox()
      const box = await toast.boundingBox()
      if (!target || !box) return `${selector} or the notice is missing`
      const overlaps = box.y < target.y + target.height && box.y + box.height > target.y
        && box.x < target.x + target.width && box.x + box.width > target.x
      return overlaps ? `covers ${selector}` : 'clear'
    }
    await expect.poll(() => covered('.settings-pane-header')).toBe('clear')
    await expect.poll(() => covered('.settings-action-bar')).toBe('clear')
  } finally {
    await host.dispose()
  }
})
