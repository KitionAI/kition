import { expect, test } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'
import { seedWorkflow } from './helpers/seedWorkflow'

/**
 * Template field-binding banner (WF-U4).
 *
 * When createWorkflowFromTemplate downgrades a `field_ref_by_name` part
 * to its fallback text because the schema didn't have the field, the
 * launcher stashes the unresolved name list under
 * `sessionStorage[kition:workflow:template-unresolved:<workflowId>]` and then
 * navigates to /workflow. WorkflowHomePage drains the key on the first
 * render for that selection and shows a dismissible amber banner so the
 * user knows their template downgraded silently.
 *
 * We exercise the consumer side here — seed sessionStorage with a
 * representative payload before navigating, then assert the banner
 * renders with the expected field names and can be dismissed.
 */

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
})

test('shows the unresolved-template banner when sessionStorage carries field names', async ({ page }) => {
  await seedWorkflow(page, { id: 'auto_seed' })
  // The banner is keyed on the workflow id. Inject the handoff before
  // navigating so it's already in sessionStorage by the time WorkflowHomePage
  // mounts and reads it. We list two field names so we can assert the
  // pluralised "2 template fields couldn't be matched" label.
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem(
        'kition:workflow:template-unresolved:auto_seed',
        JSON.stringify(['Name', 'Company']),
      )
    } catch {
      // sessionStorage may be unavailable in some test contexts; the
      // assertion below will fail with a clearer message in that case.
    }
  })
  await page.goto('/workflow/auto_seed')

  const banner = page.getByTestId('workflow-home-template-unresolved-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(/2 template fields couldn't be matched/)
  await expect(banner).toContainText('Name, Company')
})

test('Dismiss button hides the banner and the key is drained from sessionStorage', async ({ page }) => {
  await seedWorkflow(page, { id: 'auto_seed' })
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem(
        'kition:workflow:template-unresolved:auto_seed',
        JSON.stringify(['Name']),
      )
    } catch {}
  })
  await page.goto('/workflow/auto_seed')

  const banner = page.getByTestId('workflow-home-template-unresolved-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(/1 template field couldn't be matched/)

  await page.getByTestId('workflow-home-template-unresolved-dismiss').click()
  await expect(banner).toHaveCount(0)

  // The page drains the key on the first selection effect — by the time the
  // banner is visible the key should already be gone from sessionStorage.
  const remaining = await page.evaluate(() =>
    window.sessionStorage.getItem('kition:workflow:template-unresolved:auto_seed'),
  )
  expect(remaining).toBeNull()
})

test('singular and plural copy switch on the field-name count', async ({ page }) => {
  await seedWorkflow(page, { id: 'auto_seed' })
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem(
        'kition:workflow:template-unresolved:auto_seed',
        JSON.stringify(['Email']),
      )
    } catch {}
  })
  await page.goto('/workflow/auto_seed')

  const banner = page.getByTestId('workflow-home-template-unresolved-banner')
  await expect(banner).toContainText(/1 template field couldn't be matched/)
  await expect(banner).not.toContainText(/template fields couldn't/)
})

test('does not render the banner when sessionStorage carries an empty list', async ({ page }) => {
  await seedWorkflow(page, { id: 'auto_seed' })
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem('kition:workflow:template-unresolved:auto_seed', JSON.stringify([]))
    } catch {}
  })
  await page.goto('/workflow/auto_seed')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  await expect(page.getByTestId('workflow-home-template-unresolved-banner')).toHaveCount(0)
})
