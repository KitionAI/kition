import { expect, test } from '@playwright/test'

import {
  assertRealWorkflowEnv,
  createRealFailingRun,
  createRealWorkflowFixture,
  createRealEmailConnectionFromSettings,
  createRealRecord,
  deleteRealDataDocument,
  fetchWorkflow,
  fetchWorkflows,
  fetchConnections,
  installNoRouteGuard,
  installRealDesktopSettings,
  openWorkflowDetailPage,
  openWorkflowIndexPage,
  openWorkflowAiNewPage,
  patchRealWorkflow,
  resetRealBackend,
  sendRealTestEmail,
  testRealConnection,
  type RealWorkflowFixture,
  waitForRun,
} from './helpers/realWorkflow'
import { selectWorkflowMoreAction } from './helpers/workflowUi'

const keepArtifacts = process.env.KITION_WORKFLOW_E2E_KEEP_ARTIFACTS === '1'

test.describe.serial('workflow real no-mock e2e', () => {
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

  // After the kition-workflow-design route split (2026-06-21) the surface
  // is now two pages:
  //   /workflow          → WorkflowIndexPage   (list of workflows)
  //   /workflow/{id}     → WorkflowHomePage    (single workflow detail)
  // The standalone WorkflowAiBuildSurface is gone — AI build now streams
  // into WorkflowHomePage via streamingPreview, and after workflow.created
  // arrives WorkflowRoute flips back to the index page. These tests are
  // structured around that flow.

  test('opens from sidebar, lists real tables, and builds a workflow through real SSE', async ({ page }) => {
    test.setTimeout(180_000)

    const connection = await createRealEmailConnectionFromSettings(page)
    connectionId = String(connection.id)
    expect(connection.status).toBe('active')
    await expect.poll(async () => {
      const result = await testRealConnection(connectionId)
      return result.ok
    }).toBe(true)
    const connections = await fetchConnections()
    const rawConnections = JSON.stringify(connections)
    expect(rawConnections).toContain(connectionId)
    expect(rawConnections).not.toContain(String(process.env.KITION_SMTP_PASSWORD))

    await openWorkflowIndexPage(page)
    await expect(page.getByTestId('workspace-workflow-workbench')).toBeVisible()
    await expect(page.getByTestId('workflow-route-overlay')).toHaveCount(0)

    // Index → "New Workflow" → mode chooser → "Chat with AI" lands on the
    // AI prompt surface. WorkflowRoute reads URL synchronously at render
    // time and doesn't subscribe to popstate — clicking through the
    // dialog only nudges history.state, which can leave Shell's
    // workflowContext setState a no-op when the value is already null,
    // and WorkflowRoute won't re-render. openWorkflowAiNewPage takes the
    // shortcut from /documents so Shell's popstate listener fires with
    // a clean transition into mode 'build' (because we pass the fixture
    // as workflowContext — that also preselects the table so the user
    // doesn't have to drive the inline picker). Dialog → submit
    // coverage lives in vitest (WorkflowRoute.spec.tsx).
    await openWorkflowAiNewPage(page, fixture)
    await expect(page.getByTestId('workflow-table-name')).toHaveValue(fixture.tableName)

    await page.getByTestId('workflow-prompt').fill([
      'Create an workflow named "Workflow E2E Lead Alert".',
      `When a record is created in the "${fixture.tableName}" table, send an email to ${fixture.recipient}.`,
      'Use subject exactly "New lead created".',
      'The email body must use field references, not literal braces:',
      '- text "Lead name: " followed by the First Name field',
      '- newline',
      '- text "Company: " followed by the Company field',
    ].join('\n'))
    await page.getByTestId('workflow-launcher-ai-submit').click()

    // The build endpoint is the load-bearing signal — it both proves the
    // submit click reached the backend and gives us a stable id to reuse
    // across the rest of the suite. Don't race the streaming-banner DOM:
    // with a fast model it disappears before Playwright can latch on, and
    // the chip/canvas test ids only exist during the brief streaming
    // preview window — neither contract is observable post-completion.
    await expect.poll(async () => {
      const items = await fetchWorkflows()
      return items.find((item) => String(item.trigger?.tableId) === fixture.tableId) ? 1 : 0
    }, { timeout: 120_000 }).toBe(1)

    const workflows = await fetchWorkflows()
    const built = workflows.find((item) => String(item.trigger?.tableId) === fixture.tableId)
    expect(built, JSON.stringify(workflows)).toBeTruthy()
    workflowId = String(built!.id)
    expect(built!.enabled).toBe(false)
    expect(built!.action?.connectionId).toBe(connectionId)
    expect(JSON.stringify(built!.action?.body || {})).toContain('"field_ref"')

    // Once streaming completes WorkflowRoute resets build state and the
    // route's resolver flips back to mode 'index' — the index page renders
    // the new row carrying the persisted workflow id.
    await expect(page.getByTestId('workflow-index-page')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator(`[data-testid="workflow-index-row"][data-workflow-id="${workflowId}"]`)).toBeVisible()
  })

  test('preserves field references and validates edits in detail mode', async ({ page }) => {
    test.setTimeout(90_000)
    test.skip(!workflowId, 'build test must create a real workflow first')

    await openWorkflowDetailPage(page, workflowId)

    // Action drawer opens via the action node card. Action drawer owns the
    // To / Connection / Body fields — they're no longer in a sidebar.
    await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
    await expect(page.getByTestId('workflow-home-to')).toHaveValue(fixture.recipient)
    await expect(page.getByTestId('workflow-home-connection')).toHaveValue(connectionId)
    await expect(page.getByTestId('workflow-home-body')).toBeVisible()
    // The body editor migrated from BodyTemplateEditor (select-based) to
    // TemplateTokenInput (inline contenteditable). Chips carry the new
    // template-token-chip testid.
    await expect.poll(async () => page.locator('[data-testid="template-token-chip"]').count()).toBeGreaterThanOrEqual(2)

    // Edit the action and verify the save bar flips to dirty.
    const updatedRecipient = `updated-${fixture.recipient}`
    await page.getByTestId('workflow-home-to').fill(updatedRecipient)
    await expect(page.getByTestId('workflow-home-save-bar')).toBeVisible()
    await page.getByTestId('workflow-home-save').click()
    await expect(page.getByTestId('workflow-home-save-bar')).toHaveCount(0)

    const afterSave = await fetchWorkflow(workflowId)
    expect(afterSave.action.to).toBe(updatedRecipient)
    const bodyJSON = JSON.stringify(afterSave.action.body)
    expect(bodyJSON).toContain('"field_ref"')
    expect(bodyJSON).not.toContain(`{{${fixture.fields.firstName}}}`)
    expect(bodyJSON).not.toContain(`{{${fixture.fields.company}}}`)

    // Empty recipient → validation error + discard restores the saved value.
    await page.getByTestId('workflow-home-to').fill('')
    await expect(page.getByText('Recipient is required')).toBeVisible()
    await expect(page.getByTestId('workflow-home-save')).toBeDisabled()
    await page.getByTestId('workflow-home-discard').click()
    await expect(page.getByTestId('workflow-home-to')).toHaveValue(updatedRecipient)

    // Toggling status persists through API + reload.
    await page.getByTestId('status-toggle').click()
    await expect(page.getByTestId('status-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await fetchWorkflow(workflowId)).enabled).toBe(true)

    await page.reload()
    await expect(page.getByTestId('workflow-home-page')).toBeVisible()
    await expect(page.getByTestId('status-toggle')).toHaveAttribute('aria-pressed', 'true')
  })

  test('runs a real test email, records trigger history, and renders history/log tabs', async ({ page }) => {
    test.setTimeout(150_000)
    test.skip(!workflowId, 'build test must create a real workflow first')

    await openWorkflowDetailPage(page, workflowId)

    // Run test from the topbar — uses send-test under the hood and produces
    // a run in the workflow's history.
    await page.getByTestId('workflow-home-run-test').click()
    await expect(page.getByTestId('workflow-home-run-test-status')).toContainText('Test email delivered', { timeout: 30_000 })
    await expect(page.getByTestId('workflow-home-run-test-preview')).toContainText(fixture.recipient)
    await expect(page.getByTestId('workflow-home-run-test-body')).not.toContainText('{{')

    // History opens from the workflow More menu. Rows are indexed
     // (`run-row-{n}`) because the surface needs stable selectors for the
     // retry button, even before runs reorder on refresh.
    await selectWorkflowMoreAction(page, 'workflow-home-history')
    await expect(page.getByTestId('run-history-panel')).toBeVisible()
    await expect(page.getByTestId('run-row-0')).toContainText(fixture.recipient, { timeout: 15_000 })
    await expect(page.getByTestId('run-row-0')).toContainText('[TEST] New lead created')

    // Trigger a real record-created event and wait for the corresponding run.
    const record = await createRealRecord(fixture)
    const run = await waitForRun(workflowId, { recordId: String(record.id) })
    expect(run.status).toBe('ok')
    expect(run.connectionId).toBe(connectionId)
    expect(String(run.body)).toContain('Bieber')
    expect(String(run.body)).toContain('Kition Labs')

    // Switch back to configuration then back to history to verify the new
    // row shows up (history panel auto-refreshes when re-mounted).
    await selectWorkflowMoreAction(page, 'workflow-home-view-configuration')
    await selectWorkflowMoreAction(page, 'workflow-home-history')
    await expect(page.getByTestId('run-row-0')).toContainText(fixture.recipient, { timeout: 15_000 })
    await expect(page.getByTestId('run-row-0')).toContainText('New lead created')
    await expect(page.getByTestId('run-history-time').first()).not.toHaveText(/^\d{1,2}:\d{2}(:\d{2})?$/)
    await page.getByTestId('run-row-0').click()
    await expect(page.getByTestId('run-row-0')).toContainText('Bieber')

    // Logs opens from the same More menu and shows the underlying event log.
    await selectWorkflowMoreAction(page, 'workflow-home-logs')
    await expect(page.getByTestId('workflow-home-logs-tab')).toContainText('record.created')
    await expect(page.getByTestId('workflow-home-logs-tab')).toContainText('ok')
  })

  test('surfaces a failed send-test run inside the history panel', async ({ page }) => {
    test.setTimeout(90_000)
    test.skip(!workflowId, 'build test must create a real workflow first')

    const failedRun = await createRealFailingRun(workflowId, fixture.recipient)
    expect(failedRun.status).toBe('error')
    expect(String(failedRun.error)).toContain('email recipient invalid')

    await openWorkflowDetailPage(page, workflowId)
    await selectWorkflowMoreAction(page, 'workflow-home-history')
    await expect(page.getByTestId('run-history-panel')).toBeVisible()
    await expect(page.getByTestId('run-row-0')).toContainText('Failed', { timeout: 15_000 })
    // The error message lives inside the expanded body — collapsed rows
    // only show status / time / to / subject.
    await page.getByTestId('run-row-0').click()
    await expect(page.getByTestId('run-row-0')).toContainText('email recipient invalid')

    // The index page should also flag this workflow as failing.
    await openWorkflowIndexPage(page)
    await expect(page.locator(`[data-testid="workflow-index-row"][data-workflow-id="${workflowId}"]`))
      .toHaveAttribute('data-workflow-status', 'failing')

    await patchRealWorkflow(workflowId, { action: { to: fixture.recipient } })
    await sendRealTestEmail(workflowId)
  })

  test('keeps Run test useful when the source data document is unavailable', async ({ page }) => {
    test.setTimeout(60_000)
    test.skip(!workflowId, 'build test must create a real workflow first')

    await deleteRealDataDocument(fixture.documentId)
    await openWorkflowDetailPage(page, workflowId)
    // Body editor renders the fallback (raw field id chips) instead of
    // crashing on the missing schema.
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toBeVisible()
    await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
    await expect(page.getByTestId('workflow-home-body')).toBeVisible()
    await page.getByTestId('workflow-home-run-test').click()
    await expect(page.getByTestId('workflow-home-run-test-status')).toContainText('Test email delivered', { timeout: 30_000 })
    await expect(page.getByTestId('workflow-home-run-test-body')).not.toContainText('{{')
    await expect(page.getByText('Failed to open data document')).toHaveCount(0)
  })

  test('requires delete confirmation and clears selection after delete', async ({ page }) => {
    test.setTimeout(60_000)
    test.skip(!workflowId, 'build test must create a real workflow first')

    await openWorkflowDetailPage(page, workflowId)

    // Cancel keeps the workflow.
    await selectWorkflowMoreAction(page, 'workflow-home-delete')
    await expect(page.getByTestId('workflow-home-confirm')).toBeVisible()
    await page.getByTestId('workflow-home-confirm-cancel').click()
    expect(await fetchWorkflow(workflowId)).toBeTruthy()

    // Confirm deletes from the backend; the index page no longer carries
    // the row.
    await selectWorkflowMoreAction(page, 'workflow-home-delete')
    await page.getByTestId('workflow-home-confirm-ok').click()
    await expect.poll(async () => {
      const workflows = await fetchWorkflows()
      return workflows.some((item) => String(item.id) === workflowId)
    }).toBe(false)

    await openWorkflowIndexPage(page)
    await expect(page.locator(`[data-testid="workflow-index-row"][data-workflow-id="${workflowId}"]`))
      .toHaveCount(0)
  })

  test('retains a test-workspace workflow artifact when requested', async ({ page }) => {
    test.setTimeout(180_000)
    test.skip(!keepArtifacts, 'artifact retention is only enabled for persistent test-workspace runs')
    test.skip(!connectionId, 'connection must be created through Settings first')

    const retainedFixture = await createRealWorkflowFixture()
    const retainedName = `Workflow E2E Retained ${Date.now().toString(36)}`

    await openWorkflowAiNewPage(page, retainedFixture)
    await expect(page.getByTestId('workflow-table-name')).toHaveValue(retainedFixture.tableName)

    await page.getByTestId('workflow-prompt').fill([
      `Create an workflow named "${retainedName}".`,
      `When a record is created in the "${retainedFixture.tableName}" table, send an email to ${retainedFixture.recipient}.`,
      'Use subject exactly "Retained workflow test".',
      'The email body must say "Retained lead: " followed by the First Name field.',
    ].join('\n'))
    await page.getByTestId('workflow-launcher-ai-submit').click()

    await expect.poll(async () => {
      const items = await fetchWorkflows()
      return items.find((item) => item.name === retainedName || String(item.trigger?.tableId) === retainedFixture.tableId) ? 1 : 0
    }, { timeout: 120_000 }).toBe(1)
    const workflows = await fetchWorkflows()
    const retained = workflows.find((item) => item.name === retainedName || String(item.trigger?.tableId) === retainedFixture.tableId)
    expect(retained, JSON.stringify(workflows)).toBeTruthy()
    const retainedId = String(retained!.id)
    expect(retained!.action?.connectionId).toBe(connectionId)

    await openWorkflowDetailPage(page, retainedId)
    await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
    await expect(page.getByTestId('workflow-home-connection')).toHaveValue(connectionId)
    await page.getByTestId('workflow-home-run-test').click()
    await expect(page.getByTestId('workflow-home-run-test-status')).toContainText('Test email delivered', { timeout: 30_000 })

    const retainedRun = await waitForRun(retainedId)
    expect(retainedRun.status).toBe('ok')
    expect(retainedRun.connectionId).toBe(connectionId)
    expect(await fetchWorkflow(retainedId)).toBeTruthy()
  })
})
