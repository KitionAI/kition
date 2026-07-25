import { expect, test, type Page, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'

/**
 * Trigger required-field auto-pruning on table swap.
 *
 * `trigger.requiredFields` stores field IDs that must be non-empty on the
 * trigger record for the workflow to fire. When the user rebinds the
 * trigger to a different table the previous field IDs no longer apply and
 * the panel would render them as "(removed)" warnings forever — even
 * though the panel's own constraint logic never fires on a missing
 * field. The fix wires `commitTriggerTableSwap` to drop any required-
 * field IDs that aren't on the new schema, so the PATCH body carries a
 * cleaned `requiredFields` array alongside the table change.
 *
 * Body field_ref dangling cleanup is covered by workflow-dangling-field-ref.spec
 * — this file only asserts the required-fields side.
 */

async function seedStaleRequiredFieldsWorkflow(page: Page) {
  // tbl_leads has fld_priority, fld_country. The workflow's trigger
  // requiredFields lists fld_priority + two STALE IDs that don't exist
  // anywhere. After switching to tbl_followups (which has different
  // fields), the PATCH should keep only IDs still present on the new
  // table — i.e. drop the two stale entries AND fld_priority (not on
  // followups).
  const workflow = {
    id: 'auto_stale',
    name: 'Stale required fields',
    description: '',
    enabled: false,
    schemaVer: 2,
    trigger: {
      nodeId: 'trigger_1',
      type: 'record_created',
      tableId: 'tbl_leads',
      documentId: 'doc_1',
      requiredFields: ['fld_priority', 'fld_legacy_ghost_a', 'fld_legacy_ghost_b'],
    },
    action: {
      nodeId: 'action_1',
      type: 'send_email',
      connectionId: 'conn_a',
      to: 'team@example.com',
      subject: 'New',
      // Plain text body — no field_refs — so the dangling-body dialog
      // does not fire and the table swap commits directly.
      body: { parts: [{ kind: 'text', text: 'Hi' }] },
    },
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email' } },
    ],
    edges: [{ from: 'trigger_1', to: 'action_1' }],
  }

  let current: Record<string, unknown> = workflow
  let lastPatchBody: Record<string, unknown> | null = null

  await page.route('**/v1/workflows', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [current] }) })
    }
    return route.continue()
  })
  await page.route('**/v1/workflows/auto_stale', async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      lastPatchBody = route.request().postDataJSON() as Record<string, unknown>
      const triggerPatch = (lastPatchBody.trigger as Record<string, unknown>) ?? {}
      current = {
        ...current,
        trigger: { ...(current.trigger as Record<string, unknown>), ...triggerPatch },
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, workflow: current }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) })
  })
  await page.route('**/v1/workflows/auto_stale/runs**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) }),
  )
  await page.route('**/v1/workflows/auto_stale/validate', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ issues: [] }) }),
  )

  await page.route('**/v1/data-documents/doc_1/tables/tbl_leads/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [
      { id: 'fld_priority', name: 'priority', title: 'Priority', type: 'single_select' },
      { id: 'fld_country', name: 'country', title: 'Country', type: 'text' },
    ], total: 2 } }) }),
  )
  await page.route('**/v1/data-documents/doc_1/tables/tbl_followups/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [
      { id: 'fld_followup_date', name: 'followup_date', title: 'Followup date', type: 'date' },
      { id: 'fld_owner', name: 'owner', title: 'Owner', type: 'text' },
    ], total: 2 } }) }),
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
  await page.route('**/v1/data-documents', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{
        id: 'doc_1', title: 'Leads workspace',
        tables: [
          { id: 'tbl_leads', title: 'Leads', name: 'leads' },
          { id: 'tbl_followups', title: 'Followups', name: 'followups' },
        ],
      }] }),
    }),
  )

  return { getLastPatchBody: () => lastPatchBody }
}

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
})

test('R1 switching trigger tables drops stale requiredFields IDs in the PATCH', async ({ page }) => {
  const fixture = await seedStaleRequiredFieldsWorkflow(page)
  await page.goto('/workflow/auto_stale')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]').click()
  await page.getByTestId('workflow-home-trigger-table').click()
  await page.getByRole('option', { name: 'Followups' }).click()

  // No body field_refs in this fixture, so the swap commits directly
  // without the dangling-body dialog.
  await expect(page.getByTestId('workflow-home-confirm')).toHaveCount(0)

  await expect.poll(() => fixture.getLastPatchBody()).not.toBeNull()
  const body = fixture.getLastPatchBody()!
  const trigger = body.trigger as Record<string, unknown>
  expect(trigger.tableId).toBe('tbl_followups')
  // tbl_followups has none of the previous IDs (neither fld_priority nor
  // the two ghost IDs), so the cleaned list is empty.
  expect(trigger.requiredFields).toEqual([])
})

test('R2 stale rows disappear from the panel after the table swap', async ({ page }) => {
  await seedStaleRequiredFieldsWorkflow(page)
  await page.goto('/workflow/auto_stale')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]').click()

  // Before the swap, the panel shows the two ghost rows under the
  // "fields no longer on the table" section.
  await expect(page.getByTestId('workflow-home-trigger-required-fields-stale')).toBeVisible()
  await expect(page.getByTestId('workflow-home-trigger-required-fields-stale-row-fld_legacy_ghost_a')).toBeVisible()
  await expect(page.getByTestId('workflow-home-trigger-required-fields-stale-row-fld_legacy_ghost_b')).toBeVisible()

  await page.getByTestId('workflow-home-trigger-table').click()
  await page.getByRole('option', { name: 'Followups' }).click()

  // After the swap, the stale section goes away because the cleaned
  // requiredFields array contains no IDs at all.
  await expect(page.getByTestId('workflow-home-trigger-required-fields-stale')).toHaveCount(0)
})

test('R3 a table swap that keeps a valid required ID preserves it in the PATCH', async ({ page }) => {
  const fixture = await seedStaleRequiredFieldsWorkflow(page)
  // Override the followups schema so fld_priority is still present on
  // the new table. Registered AFTER seed so this handler takes precedence
  // (Playwright matches routes in LIFO order).
  await page.route('**/v1/data-documents/doc_1/tables/tbl_followups/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [
      { id: 'fld_priority', name: 'priority', title: 'Priority', type: 'single_select' },
      { id: 'fld_followup_date', name: 'followup_date', title: 'Followup date', type: 'date' },
    ], total: 2 } }) }),
  )
  await page.goto('/workflow/auto_stale')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]').click()
  await page.getByTestId('workflow-home-trigger-table').click()
  await page.getByRole('option', { name: 'Followups' }).click()

  await expect.poll(() => fixture.getLastPatchBody()).not.toBeNull()
  const body = fixture.getLastPatchBody()!
  const trigger = body.trigger as Record<string, unknown>
  expect(trigger.tableId).toBe('tbl_followups')
  // Only fld_priority (carried over because it's still on followups)
  // survives the prune; the two ghost IDs are dropped.
  expect(trigger.requiredFields).toEqual(['fld_priority'])
})
