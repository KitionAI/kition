import { expect, type Page } from '@playwright/test'

export async function dismissFirstRunActivation(page: Page) {
  const activation = page.getByTestId('first-run-activation')
  try {
    await activation.waitFor({ state: 'visible', timeout: 5_000 })
  } catch {
    return
  }
  await activation.getByRole('button', { name: 'Skip for now' }).click()
  await expect(activation).toHaveCount(0)
}
