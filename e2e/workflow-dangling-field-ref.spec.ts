import { expect, test, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'

/**
 * T4 — body dangling field-ref dialog (WF-R4).
 *
 * setTriggerTable inspects the action body's field_refs against the next
 * table's schema before committing. If any refs point at fields that don't
 * exist on the new table, the page raises a ConfirmDialog asking the user
 * to remove the dangling refs and continue. Confirm bundles the trigger
 * swap + body prune into a single PATCH; Cancel aborts the swap.
 *
 * The implementation also gates the dialog on `selected.action.type !==
 * 'add_record'` (per-field add_record templates are still TBD), so we
 * exercise a send_email workflow here.
 */

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
})

interface SeedDanglingOptions {
  /** Set to true to make the next table's schema include the referenced
   *  field — in that case the page commits straight away with no dialog. */
  nextTableHasReferencedField?: boolean
}

async function seedDanglingRefWorkflow(page: import('@playwright/test').Page, options: SeedDanglingOptions = {}) {
  // Start on tbl_leads; the body references fld_priority on tbl_leads.
  // The user will try to switch to tbl_followups; that table will have
  // different fields (no fld_priority) so the dialog fires.
  const workflow = {
    id: 'auto_dangling',
    name: 'Lead notifier',
    description: '',
    enabled: false,
    schemaVer: 2,
    trigger: {
      nodeId: 'trigger_1',
      type: 'record_created',
      tableId: 'tbl_leads',
      documentId: 'doc_1',
    },
    action: {
      nodeId: 'action_1',
      type: 'send_email',
      connectionId: 'conn_a',
      to: 'team@example.com',
      subject: 'New lead',
      body: { parts: [
        { kind: 'text', text: 'Priority: ' },
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'fld_priority' } },
      ] },
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
  await page.route('**/v1/workflows/auto_dangling', async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      lastPatchBody = route.request().postDataJSON() as Record<string, unknown>
      const triggerPatch = (lastPatchBody.trigger as Record<string, unknown>) ?? {}
      const actionPatch = (lastPatchBody.action as Record<string, unknown>) ?? {}
      current = {
        ...current,
        trigger: { ...(current.trigger as Record<string, unknown>), ...triggerPatch },
        action: { ...(current.action as Record<string, unknown>), ...actionPatch },
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, workflow: current }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) })
  })
  await page.route('**/v1/workflows/auto_dangling/runs**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) })
  )
  await page.route('**/v1/workflows/auto_dangling/validate', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ issues: [] }) })
  )

  // Per-table schemas. The pattern matcher captures the tableId out of the
  // URL so we can return shape-appropriate fields.
  await page.route('**/v1/data-documents/doc_1/tables/tbl_leads/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [
      { id: 'fld_priority', name: 'priority', title: 'Priority', type: 'single_select' },
      { id: 'fld_country', name: 'country', title: 'Country', type: 'text' },
    ], total: 2 } }) }),
  )
  await page.route('**/v1/data-documents/doc_1/tables/tbl_followups/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: options.nextTableHasReferencedField ? [
      // Echo fld_priority back when the test wants a clean swap path.
      { id: 'fld_priority', name: 'priority', title: 'Priority', type: 'single_select' },
      { id: 'fld_followup_date', name: 'followup_date', title: 'Followup date', type: 'date' },
    ] : [
      // Default: no fld_priority → swap is dangling and the dialog should fire.
      { id: 'fld_followup_date', name: 'followup_date', title: 'Followup date', type: 'date' },
      { id: 'fld_owner', name: 'owner', title: 'Owner', type: 'text' },
    ], total: 2 } }) }),
  )

  await page.route('**/v1/channels', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ channel: 'email_smtp', label: 'Email (SMTP)', icon: '✉', description: '', auth: 'password', fields: [] }]),
    }),
  )
  await page.route('**/v1/connections', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{
        id: 'conn_a', channel: 'email_smtp', name: 'Default SMTP',
        settings: { host: 'smtp.example.com', port: 587, username: 'u', tlsMode: 'starttls', from: 'noreply@example.com', fromName: '' },
        status: 'active', lastErrorMessage: '', usedByCount: 1,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }] }),
    }),
  )
  // Document list — drives the trigger-table picker's options.
  await page.route('**/v1/data-documents', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{
        id: 'doc_1', title: 'Leads workspace',
        tables: [
          { id: 'tbl_leads', title: 'Leads', name: 'leads' },
          { id: 'tbl_followups', title: 'Followups', name: 'followups' },
        ],
      }] }),
    }),
  )

  // Expose the captured PATCH body to test assertions via a getter.
  return { getLastPatchBody: () => lastPatchBody }
}

async function openTriggerTablePicker(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // Click the trigger node so the drawer renders the trigger panel.
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]').click()
  await page.getByTestId('workflow-home-trigger-table').click()
}

test('T4.1 switching to a table missing the referenced field opens the dangling-ref ConfirmDialog', async ({ page }) => {
  await seedDanglingRefWorkflow(page)
  await page.goto('/workflow/auto_dangling')
  await openTriggerTablePicker(page)
  await page.getByRole('option', { name: 'Followups' }).click()

  const dialog = page.getByTestId('workflow-home-confirm')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/Switch to Followups\?/)
  await expect(dialog).toContainText(/1 field reference in the action body/)
})

test('T4.2 "Remove & switch" confirms the dialog and PATCHes both trigger and pruned body', async ({ page }) => {
  const fixture = await seedDanglingRefWorkflow(page)
  await page.goto('/workflow/auto_dangling')
  await openTriggerTablePicker(page)
  await page.getByRole('option', { name: 'Followups' }).click()

  const ok = page.getByTestId('workflow-home-confirm-ok')
  await expect(ok).toHaveText(/Remove & switch/)
  await ok.click()

  // Dialog closes.
  await expect(page.getByTestId('workflow-home-confirm')).toHaveCount(0)

  // Verify the PATCH body carried both the trigger swap AND a pruned action body.
  // Wait for the request to land — the page commits asynchronously.
  await expect.poll(() => fixture.getLastPatchBody()).not.toBeNull()
  const body = fixture.getLastPatchBody()!
  expect((body.trigger as Record<string, unknown>).tableId).toBe('tbl_followups')
  // action.body.parts should no longer contain the dangling field_ref;
  // only the leading text part survives.
  const actionBody = ((body.action as Record<string, unknown>).body as { parts: Array<{ kind: string }> }).parts
  expect(actionBody.find((p) => p.kind === 'field_ref')).toBeUndefined()
  expect(actionBody.find((p) => p.kind === 'text')).toBeTruthy()
})

test('T4.3 Cancel keeps the original trigger table and skips the PATCH', async ({ page }) => {
  const fixture = await seedDanglingRefWorkflow(page)
  await page.goto('/workflow/auto_dangling')
  await openTriggerTablePicker(page)
  await page.getByRole('option', { name: 'Followups' }).click()

  await expect(page.getByTestId('workflow-home-confirm')).toBeVisible()
  await page.getByTestId('workflow-home-confirm-cancel').click()
  await expect(page.getByTestId('workflow-home-confirm')).toHaveCount(0)

  // No PATCH should have landed; the trigger table is still tbl_leads.
  // Give the network a beat — Cancel might trigger a re-render that
  // doesn't actually call the API, but the assertion shape verifies that.
  expect(fixture.getLastPatchBody()).toBeNull()
})

test('T4.4 switching to a table that has the referenced field commits without a dialog', async ({ page }) => {
  const fixture = await seedDanglingRefWorkflow(page, { nextTableHasReferencedField: true })
  await page.goto('/workflow/auto_dangling')
  await openTriggerTablePicker(page)
  await page.getByRole('option', { name: 'Followups' }).click()

  // No dialog this time.
  await expect(page.getByTestId('workflow-home-confirm')).toHaveCount(0)
  // The PATCH lands directly with the trigger swap; body stays intact.
  await expect.poll(() => fixture.getLastPatchBody()).not.toBeNull()
  const body = fixture.getLastPatchBody()!
  expect((body.trigger as Record<string, unknown>).tableId).toBe('tbl_followups')
  // The clean-path PATCH should NOT carry an action body — only the trigger
  // is being updated.
  expect(body.action).toBeUndefined()
})
