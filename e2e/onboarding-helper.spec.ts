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

test('lets the next action reach a dialog that covers a late activation, then dismisses it', async ({ page }) => {
  test.setTimeout(20_000)
  await page.setContent(`
    <button id="continue" onclick="this.dataset.clicked = 'true'">Continue</button>
    <div data-testid="first-run-activation" style="display: none; position: fixed; inset: 0; z-index: 1; background: white">
      <button onclick="this.parentElement.remove()">Skip for now</button>
    </div>
    <div id="overlay" style="position: fixed; inset: 0; z-index: 2; background: rgb(0 0 0 / 0.3)"></div>
    <div id="dialog" style="position: fixed; top: 40px; left: 40px; z-index: 3; background: white">
      <button onclick="document.getElementById('overlay').remove(); this.parentElement.remove()">Open</button>
    </div>
  `)
  await dismissFirstRunActivation(page)
  await page.getByTestId('first-run-activation').evaluate((element) => { element.style.display = 'block' })
  await page.getByRole('button', { name: 'Open', exact: true }).click({ timeout: 5_000 })
  await expect(page.locator('#dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 5_000 })
  await expect(page.getByTestId('first-run-activation')).toHaveCount(0)
  await expect(page.locator('#continue')).toHaveAttribute('data-clicked', 'true')
})
