import { expect, type Page } from '@playwright/test'

export async function dismissFirstRunActivation(page: Page) {
  const activation = page.getByTestId('first-run-activation')
  await expect(activation).toBeVisible({ timeout: 30_000 })
  await activation.getByRole('button', { name: 'Skip for now' }).click()
  await expect(activation).toHaveCount(0)
}
