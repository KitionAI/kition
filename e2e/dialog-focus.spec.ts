import { expect, test } from '@playwright/test'

import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

test('the settings dialog keeps Tab inside and hands focus back on Escape', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Hello', {}, 'notes/hello.md')
  await page.goto('/')
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })

  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
  await settingsButton.focus()
  await settingsButton.press('Enter')
  const dialog = page.locator('section[role="dialog"][aria-labelledby="settings-title"]')
  await expect(dialog).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true)

  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true)
  }
  await page.keyboard.press('Shift+Tab')
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(settingsButton).toBeFocused()
})
