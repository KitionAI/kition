import { expect, test } from '@playwright/test'

import { installDesktopHost } from './helpers/desktopHost'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

test('desktop shortcuts keep select-all in inputs', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  expect(baseURL).toBeTruthy()
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    await page.goto(new URL('/settings?section=providers', baseURL as string).toString(), { waitUntil: 'commit' })
    await page.waitForLoadState('domcontentloaded')
    await dismissFirstRunActivation(page)
    // Native input editing follows the host operating system.
    await page.getByRole('button', { name: /OpenAI/ }).click()
    const providerInput = page.getByLabel('API key').first()
    await expect(providerInput).toBeVisible({ timeout: 30_000 })
    await providerInput.fill('ORIGINAL-KEY')
    await providerInput.press('ControlOrMeta+a')
    await providerInput.pressSequentially('CMD-A-REPLACED')
    await expect(providerInput).toHaveValue('CMD-A-REPLACED')
  } finally {
    await host.dispose()
  }
})
