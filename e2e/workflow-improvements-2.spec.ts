import { expect, test, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'
import { seedWorkflow } from './helpers/seedWorkflow'
import { selectWorkflowMoreAction } from './helpers/workflowUi'

/**
 * Additional e2e coverage for the P0/P1 workflow work — focuses on flows
 * that need server-side mock orchestration (PATCH round-trip, validation,
 * filter dry-run) and are too involved to fit into workflow-improvements.spec.ts.
 */

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
})

test('A1 drawer SaveBar appears when editing the action field', async ({ page }) => {
  await seedWorkflow(page)
  await page.goto('/workflow/auto_seed')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // Action node is selected by default; drawer is open with the email
  // properties panel. Subject migrated from native input → TemplateTokenInput
  // (contenteditable), so target the inner -editor host for fill/value
  // assertions.
  const subjectEditor = page.getByTestId('workflow-home-subject-editor')
  await expect(subjectEditor).toBeVisible()
  await subjectEditor.fill('Different subject')
  // In-drawer save bar surfaces.
  await expect(page.getByTestId('workflow-drawer-savebar')).toBeVisible()
  await expect(page.getByTestId('workflow-drawer-save')).toBeEnabled()
})

test('A1 Discard reverts the change and dismisses the SaveBar', async ({ page }) => {
  await seedWorkflow(page, { action: { subject: 'Original' } })
  await page.goto('/workflow/auto_seed')
  const subjectEditor = page.getByTestId('workflow-home-subject-editor')
  await subjectEditor.fill('Changed')
  await expect(page.getByTestId('workflow-drawer-discard')).toBeVisible()
  await page.getByTestId('workflow-drawer-discard').click()
  await expect(subjectEditor).toContainText('Original')
  await expect(page.getByTestId('workflow-drawer-savebar')).toHaveCount(0)
})

test('A4 validate endpoint runs once after the draft settles', async ({ page }) => {
  let validateCalls = 0
  await seedWorkflow(page)
  await page.route('**/v1/workflows/auto_seed/validate', (route: Route) => {
    validateCalls += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ issues: [] }) })
  })
  await page.goto('/workflow/auto_seed')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // Type a few quick keystrokes — debounce should collapse them.
  const subjectEditor = page.getByTestId('workflow-home-subject-editor')
  await subjectEditor.fill('A')
  await subjectEditor.fill('AB')
  await subjectEditor.fill('ABC')
  // Wait past the debounce window.
  await page.waitForTimeout(500)
  expect(validateCalls).toBeLessThanOrEqual(2)
  expect(validateCalls).toBeGreaterThan(0)
})

test('A4 server warning renders as advisory text but Save still works', async ({ page }) => {
  await seedWorkflow(page)
  await page.route('**/v1/workflows/auto_seed/validate', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      issues: [{ nodeId: 'action_1', code: 'connection_missing', message: 'No connection selected', level: 'warning' }],
    }) }),
  )
  await page.goto('/workflow/auto_seed')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // Wait for the debounced validate call to land.
  await page.waitForTimeout(500)
  // The action node should report status="amber" (warning-only) rather
  // than red — server warnings don't escalate past amber unless the
  // local status is already red.
  const actionNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')
  await expect(actionNode).toHaveAttribute('data-status', /amber|green/)
  // Modify subject — save bar appears and is enabled.
  await page.getByTestId('workflow-home-subject-editor').fill('Hello')
  await expect(page.getByTestId('workflow-drawer-save')).toBeEnabled()
})

test('A4 server error blocks Save and disables the button', async ({ page }) => {
  await seedWorkflow(page)
  await page.route('**/v1/workflows/auto_seed/validate', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      issues: [{ nodeId: 'action_1', code: 'to_invalid', message: 'Invalid email address: foo@', level: 'error' }],
    }) }),
  )
  await page.goto('/workflow/auto_seed')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // Trigger a dirty state.
  await page.getByTestId('workflow-home-subject-editor').fill('Test')
  await page.waitForTimeout(500)
  await expect(page.getByTestId('workflow-drawer-save')).toBeDisabled()
})

test('B1 inserting a filter then saving sends nodes/edges in PATCH body', async ({ page }) => {
  let lastPatch: Record<string, unknown> | null = null
  await seedWorkflow(page, {
    patchResponder: (body) => {
      lastPatch = body as Record<string, unknown>
      return {
        id: 'auto_seed',
        name: 'Seeded Workflow',
        description: '',
        enabled: false,
        schemaVer: 2,
        trigger: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads', documentId: 'doc_1' },
        action: { nodeId: 'action_1', type: 'send_email', to: 'team@example.com', subject: 'New Lead', body: { parts: [{ kind: 'text', text: 'Hi team' }] }, connectionId: 'conn_a' },
        nodes: (body as Record<string, unknown>).nodes,
        edges: (body as Record<string, unknown>).edges,
      }
    },
  })
  await page.goto('/workflow/auto_seed')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // Wait for the field-schema fetch to complete so the filter picker
  // has fields to offer.
  await page.waitForTimeout(300)
  await page.getByTestId('workflow-insert-1-button').first().click()
  await page.getByTestId('workflow-insert-1-add-filter').click()
  await page.getByTestId('filter-expr-add-condition').click()
  // The field select either pre-fills the first available option (when
  // schema is loaded) or remains empty (degrade-gracefully path). Either
  // way the Save button should enable, and the PATCH body should carry
  // 3 nodes.
  await page.getByTestId('filter-expr-row-0-value').fill('high')
  await expect(page.getByTestId('workflow-drawer-savebar')).toBeVisible()
  await page.getByTestId('workflow-drawer-save').click()
  await page.waitForTimeout(300)
  expect(lastPatch).not.toBeNull()
  const nodes = (lastPatch as { nodes?: unknown[] }).nodes
  expect(Array.isArray(nodes)).toBe(true)
  expect((nodes as unknown[]).length).toBe(3)
  const kinds = (nodes as Array<{ kind: string }>).map((n) => n.kind)
  expect(kinds).toEqual(['trigger', 'filter', 'action'])
  const edges = (lastPatch as { edges?: unknown[] }).edges
  expect(Array.isArray(edges)).toBe(true)
  expect((edges as unknown[]).length).toBe(2)
})

test('B2 filter dry-run posts to the server and renders the match strip', async ({ page }) => {
  await seedWorkflow(page, {
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads' } },
      { nodeId: 'filter_1', kind: 'filter', config: { nodeId: 'filter_1', type: 'filter', expression: 'trigger_1.priority == "high"', mode: 'all' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email', to: 'team@example.com' } },
    ],
    edges: [
      { from: 'trigger_1', to: 'filter_1' },
      { from: 'filter_1', to: 'action_1' },
    ],
  })
  await page.route('**/v1/workflows/auto_seed/filters/dry-run', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, matched: true }) }),
  )
  await page.goto('/workflow/auto_seed')
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="filter"]').click()
  await expect(page.getByTestId('filter-dryrun-button')).toBeVisible()
  await page.getByTestId('filter-dryrun-button').click()
  await expect(page.getByTestId('filter-dryrun-result')).toHaveAttribute('data-matched', 'true')
})

test('B2 dry-run no-match path renders a grey strip', async ({ page }) => {
  await seedWorkflow(page, {
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads' } },
      { nodeId: 'filter_1', kind: 'filter', config: { nodeId: 'filter_1', type: 'filter', expression: 'trigger_1.priority == "high"', mode: 'all' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email', to: 'team@example.com' } },
    ],
    edges: [
      { from: 'trigger_1', to: 'filter_1' },
      { from: 'filter_1', to: 'action_1' },
    ],
  })
  await page.route('**/v1/workflows/auto_seed/filters/dry-run', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, matched: false }) }),
  )
  await page.goto('/workflow/auto_seed')
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="filter"]').click()
  await page.getByTestId('filter-dryrun-button').click()
  await expect(page.getByTestId('filter-dryrun-result')).toHaveAttribute('data-matched', 'false')
})

test('A3 clicking Retry calls POST /runs/:runId/retry and refreshes the list', async ({ page }) => {
  let retryCalls = 0
  await seedWorkflow(page, {
    runs: [
      { id: 'r1', workflowId: 'auto_seed', triggerEvent: 'record.created', recordId: 'rec1', startedAt: '2026-06-14T10:00:00Z', finishedAt: '2026-06-14T10:00:01Z', status: 'error', to: 'a@b.com', subject: 'S', body: 'B', error: 'SMTP 530', failingNodeId: 'action_1' },
    ],
    retryResponder: (runId) => {
      retryCalls += 1
      return { id: `retry_${runId}`, workflowId: 'auto_seed', status: 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), to: 'a@b.com', subject: 'S', body: 'B', triggerEvent: 'record.created', recordId: 'rec1' }
    },
  })
  await page.goto('/workflow/auto_seed')
  await selectWorkflowMoreAction(page, 'workflow-home-history')
  await page.getByTestId('run-row-0-retry').click()
  await page.waitForTimeout(200)
  expect(retryCalls).toBe(1)
})

test('A2 Backspace on focused canvas with a filter selected deletes the filter after confirm', async ({ page }) => {
  await seedWorkflow(page, {
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads' } },
      { nodeId: 'filter_1', kind: 'filter', config: { nodeId: 'filter_1', type: 'filter', expression: 'trigger_1.priority == "high"', mode: 'all' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email', to: 'team@example.com' } },
    ],
    edges: [
      { from: 'trigger_1', to: 'filter_1' },
      { from: 'filter_1', to: 'action_1' },
    ],
  })
  await page.goto('/workflow/auto_seed')
  const filterNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="filter"]')
  await filterNode.click()
  // Focus the canvas viewport so Backspace is captured.
  const canvas = page.getByTestId('workflow-canvas')
  await canvas.click({ position: { x: 10, y: 10 } })
  await canvas.press('Backspace')
  await expect(page.getByTestId('workflow-home-confirm')).toBeVisible()
  await page.getByTestId('workflow-home-confirm-ok').click()
  await expect(filterNode).toHaveCount(0)
})
