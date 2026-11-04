import { expect, type Page } from '@playwright/test'

export async function dismissFirstRunActivation(page: Page) {
  const activation = page.getByTestId('first-run-activation')
  // Empty workspaces seed their guide asynchronously. Handle activation when it
  // actually appears, including after the caller has started its next action.
  await page.addLocatorHandler(activation, async () => {
    await activation.getByRole('button', { name: 'Skip for now' }).click()
    await expect(activation).toHaveCount(0)
  })
  await expect(activation).not.toBeVisible()
}
