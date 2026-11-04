import { expect, test } from '@playwright/test'
import { dismissFirstRunActivation } from './helpers/onboarding'

for (const delayed of [true, false]) {
  test(`dismisses ${delayed ? 'late' : 'visible'} activation before the next workspace action`, async ({ page }) => {
    await page.setContent(`
      <button id="continue" onclick="this.dataset.clicked = 'true'">Continue</button>
      <div data-testid="first-run-activation" style="display: ${delayed ? 'none' : 'block'}; position: fixed; inset: 0; background: white">
        <button onclick="this.parentElement.remove()">Skip for now</button>
      </div>
    `)
    await dismissFirstRunActivation(page)
    if (delayed) {
      await page.getByTestId('first-run-activation').evaluate((element) => { element.style.display = 'block' })
    }
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 3_000 })
    await expect(page.getByTestId('first-run-activation')).toHaveCount(0)
    await expect(page.locator('#continue')).toHaveAttribute('data-clicked', 'true')
  })
}
