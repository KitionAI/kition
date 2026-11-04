import { expect, type Page } from '@playwright/test'

export async function dismissFirstRunActivation(page: Page) {
  const activation = page.getByTestId('first-run-activation')
  // Empty workspaces seed their guide asynchronously. Handle activation when it
  // actually appears, including after the caller has started its next action.
  // Another dialog may cover it (opening a shared link right after start): then
  // the caller's action goes ahead, and a later action dismisses activation.
  await page.addLocatorHandler(
    activation,
    async () => {
      try {
        await activation.getByRole('button', { name: 'Skip for now' }).click({ timeout: 1_000 })
      } catch {
        return
      }
      await expect(activation).toHaveCount(0)
    },
    { noWaitAfter: true },
  )
  await expect(activation).not.toBeVisible()
}
