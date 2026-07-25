import { expect, test, type Page, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'

/**
 * Layout regression tests for the workflow detail page row that holds
 * WorkflowCanvas + PropertiesDrawer.
 *
 * The row used to be `flex min-h-[480px]` only, with no upper bound on its
 * height. Selecting an Action node opened the (tall) email config drawer
 * which expanded the row to fit the drawer; the canvas grew with it, and
 * the bottom-anchored zoom controls drifted below the visible main area.
 * The fix routes the row through a flex-column chain inside `<main>` so
 * the row's height is bounded by main's clientHeight rather than by the
 * drawer's intrinsic content. Two invariants matter:
 *
 *   1. Selecting Trigger vs Action gives the canvas the *same* height.
 *      The drawer's flex-1 body has overflow-y-auto, so tall drawer
 *      content no longer expands the row.
 *   2. All three zoom buttons (+, −, fit) sit within the viewport, not
 *      just the top one. Previously only the + button peeked above the
 *      page fold on shorter viewports.
 */

async function seedTwoNodeWorkflow(page: Page) {
  const workflow = {
    id: 'auto_layout',
    name: 'Layout Demo',
    description: '',
    enabled: false,
    schemaVer: 2,
    trigger: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads', documentId: 'doc_1' },
    action: {
      nodeId: 'action_1',
      type: 'send_email',
      connectionId: 'conn_a',
      to: 'team@example.com',
      subject: 'New lead',
      body: { parts: [{ kind: 'text', text: 'Hi team' }] },
    },
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email' } },
    ],
    edges: [{ from: 'trigger_1', to: 'action_1' }],
  }
  await page.route('**/v1/workflows', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [workflow] }) }),
  )
  await page.route('**/v1/workflows/auto_layout', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workflow) }),
  )
  await page.route('**/v1/workflows/auto_layout/runs**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) }),
  )
  await page.route('**/v1/workflows/auto_layout/validate', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ issues: [] }) }),
  )
  await page.route('**/v1/channels', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ channel: 'email_smtp', label: 'Email (SMTP)', icon: '✉', description: '', auth: 'password', fields: [] }]),
    }),
  )
  await page.route('**/v1/connections', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{
        id: 'conn_a', channel: 'email_smtp', name: 'Default SMTP',
        settings: { host: 'smtp.example.com', port: 587, username: 'u', tlsMode: 'starttls', from: 'noreply@example.com', fromName: '' },
        status: 'active', lastErrorMessage: '', usedByCount: 1,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }] }),
    }),
  )
  await page.route('**/v1/data-documents/*/tables/*/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [
      { id: 'fld_priority', name: 'priority', title: 'Priority', type: 'single_select' },
      { id: 'fld_country', name: 'country', title: 'Country', type: 'text' },
    ], total: 2 } }) }),
  )
  await page.route('**/v1/data-documents', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'doc_1', title: 'Leads workspace', tables: [{ id: 'tbl_leads', title: 'Leads', name: 'leads' }] }] }),
    }),
  )
}

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
  await seedTwoNodeWorkflow(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/workflow/auto_layout')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
})

test('L1 canvas height stays constant when switching between Trigger and Action selection', async ({ page }) => {
  const canvas = page.getByTestId('workflow-canvas')
  const triggerNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')
  const actionNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')

  await triggerNode.click()
  await expect(triggerNode).toHaveAttribute('data-selected', 'true')
  const triggerHeight = (await canvas.boundingBox())?.height ?? 0
  expect(triggerHeight).toBeGreaterThan(0)

  await actionNode.click()
  await expect(actionNode).toHaveAttribute('data-selected', 'true')
  const actionHeight = (await canvas.boundingBox())?.height ?? 0

  // The drawer body's overflow-y-auto absorbs tall Action content instead
  // of expanding the row. Allow 1px tolerance for sub-pixel rounding.
  expect(Math.abs(actionHeight - triggerHeight)).toBeLessThanOrEqual(1)
})

test('L2 all three zoom controls stay within the viewport when the Action drawer is open', async ({ page }) => {
  const actionNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')
  await actionNode.click()
  await expect(actionNode).toHaveAttribute('data-selected', 'true')

  const viewport = page.viewportSize()
  if (!viewport) throw new Error('viewport size not set')

  // Each of the three buttons must be fully visible — not just the topmost.
  // Previously, only Zoom in (the top of the stack) was on-screen on
  // shorter viewports because the row had grown to match the drawer.
  for (const testId of ['workflow-canvas-zoom-in', 'workflow-canvas-zoom-out', 'workflow-canvas-zoom-fit']) {
    const box = await page.getByTestId(testId).boundingBox()
    expect(box, `${testId} bounding box`).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
  }
})

test('L3 canvas grows with the viewport so the editor uses available vertical space', async ({ page }) => {
  const canvas = page.getByTestId('workflow-canvas')
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()

  await page.setViewportSize({ width: 1280, height: 900 })
  const shortHeight = (await canvas.boundingBox())?.height ?? 0

  await page.setViewportSize({ width: 1280, height: 1200 })
  // Wait for flex-1 to absorb the new viewport height before reading.
  await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(shortHeight)
  const tallHeight = (await canvas.boundingBox())?.height ?? 0
  expect(tallHeight).toBeGreaterThan(shortHeight)
})
