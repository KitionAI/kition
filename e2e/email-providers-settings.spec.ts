import { expect, test } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'

test('stores a provider account once and offers its SMTP delivery settings', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockSuppressLauncher(page, '/tmp/kition-email-providers-vault')

  await page.goto('/settings?section=connections')

  await page.getByLabel('Search email providers').fill('163')
  await expect(page.getByTestId('email-provider-row-163')).toBeVisible()
  await expect(page.getByTestId('email-provider-row-gmail')).toHaveCount(0)
  await page.getByRole('switch', { name: 'Connect 163 Mail' }).click()
  await expect(page.getByRole('heading', { name: '163 Mail' })).toBeVisible()
  await page.getByTestId('email-provider-account-username').fill('person@163.com')
  await page.getByTestId('email-provider-account-password').fill('app-password')
  await page.getByRole('button', { name: 'Save account' }).click()
  await expect(page.getByTestId('email-providers-pane')).toContainText('Account saved.')
  await expect(page.getByTestId('connections-settings-panel')).toBeVisible()
  await expect(page.getByTestId('email-providers-pane')).not.toContainText('Inbox Sync')
})
