import { expect, test } from '@playwright/test'

import {
  apiFetch,
  assertRealWorkflowEnv,
  createRealEmailConnectionFromSettings,
  createRealWorkflowFixture,
  fetchWorkflows,
  installNoRouteGuard,
  installRealDesktopSettings,
  openWorkflowNewForFixture,
  resetRealBackend,
  sendRealTestEmail,
  testRealConnection,
  type RealWorkflowFixture,
  waitForRun,
} from './helpers/realWorkflow'

/**
 * End-to-end check of the AI build flow against the real Go API + a real
 * OpenAI-compatible provider + a real SMTP server. Verifies:
 *
 *   1. WorkflowHomePage mounts and renders the streaming preview row while
 *      the SSE stream is in flight (streamingPreview is wired by
 *      WorkflowRoute).
 *   2. When workflow.created arrives, the synthetic row gets replaced by
 *      the persisted workflow without a separate page swap — selectedId
 *      flips from `__streaming__` to the real UUID and the URL is
 *      replaceState'd to `/workflow`.
 *   3. The home page editor can drive a real send-test against the wired SMTP
 *      connection and the row lands in the run history with status=ok.
 *
 * Why this is its own file rather than a tweak to workflow-real.spec.ts: that
 * suite starts via the workspace "Create" button → table-picker dialog, but
 * the picker dialog is currently broken on main (testid
 * `workflow-table-picker-options` no longer exists in the source). We bypass
 * by injecting workflow context directly via openWorkflowNewForFixture, which
 * lands us on the same `/workflow/new` route the picker would route to.
 */
test.describe.serial('workflow real AI build', () => {
  let fixture: RealWorkflowFixture
  let workflowId = ''
  let connectionId = ''

  test.beforeAll(async () => {
    assertRealWorkflowEnv()
    await resetRealBackend()
    fixture = await createRealWorkflowFixture()
  })

  test.beforeEach(async ({ page }) => {
    installNoRouteGuard(page)
    await installRealDesktopSettings(page)
  })

  test('AI build streams SSE inside WorkflowHomePage, swaps synthetic row to persisted workflow, delivers a real test email', async ({ page }) => {
    test.setTimeout(180_000)

    const connection = await createRealEmailConnectionFromSettings(page)
    connectionId = String(connection.id)
    expect(connection.status).toBe('active')
    await expect.poll(async () => {
      const result = await testRealConnection(connectionId)
      return result.ok
    }).toBe(true)

    // createRealEmailConnectionFromSettings leaves the Settings modal open.
    // Navigate away first so it unmounts before pushing the workflow context;
    // otherwise the modal stays z-stacked above the workflow surface and
    // every subsequent click is intercepted by the connection-card it left
    // behind.
    await page.goto('/documents')

    await openWorkflowNewForFixture(page, fixture)
    await page.getByTestId('workflow-launcher-cta-ai').click()
    await expect(page.getByTestId('workflow-table-name')).toHaveValue(fixture.tableName)
    await page.getByTestId('workflow-prompt').fill([
      'Create an workflow named "AI Build Surface E2E".',
      `When a record is created in the "${fixture.tableName}" table, send an email to ${fixture.recipient}.`,
      'Use subject exactly "AI Build Surface check".',
      'The email body must use field references, not literal braces:',
      '- text "Lead name: " followed by the First Name field',
      '- newline',
      '- text "Company: " followed by the Company field',
    ].join('\n'))
    await page.getByTestId('workflow-launcher-ai-submit').click()

    // 1. Home page mounts immediately as the streaming shell.
    await expect(page.getByTestId('workflow-home-page')).toBeVisible({ timeout: 120_000 })

    // 2. workflow.created arrives → workflow row exists in DB with the bound
    //    table id. Real-AI runs can take ~30-60s.
    await expect.poll(async () => {
      const workflows = await fetchWorkflows()
      return workflows.find((item) => String(item.trigger?.tableId) === fixture.tableId) ? 'ready' : 'pending'
    }, { timeout: 120_000 }).toBe('ready')
    const workflows = await fetchWorkflows()
    const built = workflows.find((item) => String(item.trigger?.tableId) === fixture.tableId)
    expect(built, JSON.stringify(workflows)).toBeTruthy()
    workflowId = String(built!.id)
    expect(built!.enabled).toBe(false)
    expect(built!.action?.connectionId).toBe(connectionId)
    expect(JSON.stringify(built!.action?.body || {})).toContain('"field_ref"')

    // 3. URL flips to /workflow with selectedWorkflowId at the persisted id.
    await expect.poll(async () => page.evaluate(() => window.location.pathname)).toBe('/workflow')
    await expect.poll(async () => page.evaluate(() => (window.history.state as { selectedWorkflowId?: string } | null)?.selectedWorkflowId)).toBe(workflowId)
    await expect(page.getByTestId('workflow-home-page')).toBeVisible({ timeout: 30_000 })

    // 4. Smoke the send-test path through the API — proves the SMTP
    //    connection wired into the AI-generated action actually delivers.
    //    We use the API rather than the browser button so this assertion
    //    doesn't depend on every editor input being settled.
    await sendRealTestEmail(workflowId, fixture.recipient)
    const run = await waitForRun(workflowId)
    expect(run.status).toBe('ok')
    expect(run.connectionId).toBe(connectionId)

    // Cleanup.
    await apiFetch(`/workflows/${workflowId}`, { method: 'DELETE' })
  })
})
