import { expect, test } from '@playwright/test'

import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

// The command and search palettes (Mod+K, Mod+Shift+F) are covered by
// app-shell.spec.ts; this file covers the tab shortcut and its guards.

test('Cmd/Ctrl+W closes the active tab and ignores extra modifiers', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Hello\n\nBody text', {}, 'notes/hello.md')
  await page.goto('/')
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })
  const tabs = page.locator('.document-tab-list .document-tab')
  await expect(tabs).toHaveCount(1)

  await page.locator('.document-editor .cm-content').click()
  await page.keyboard.press('Control+Shift+W')
  await expect(tabs).toHaveCount(1)
  await page.keyboard.press('Control+Alt+W')
  await expect(tabs).toHaveCount(1)

  await page.keyboard.press('Control+W')
  await expect(tabs).toHaveCount(0)
})
