import type { Page } from '@playwright/test'

export async function selectWorkflowMoreAction(page: Page, actionTestId: string) {
  await page.getByTestId('workflow-home-more-actions').click()
  await page.getByTestId(actionTestId).click()
}
